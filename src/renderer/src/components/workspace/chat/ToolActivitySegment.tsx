import {
    memo,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type RefObject,
} from "react";

import { useSettingsStore } from "@renderer/app/store/settings-store";
import { MeasuredVirtualList } from "@renderer/components/virtual/MeasuredVirtualList";

import type {
    ChatTimelineActivitySegmentRow,
} from "./chatTimelineModel";
import { formatDiffStat } from "../review/reviewDiff";
import { deriveActivitySegmentChangeStats } from "./activitySegmentChangeStats";
import { getToolActivityDescriptor } from "./toolActivityDescriptor";
import {
    ToolActivityItem,
    type ToolActivityItemProps,
} from "./ToolActivityItem";
import {
    ThinkingMessage,
    type ThinkingMessageProps,
} from "./ChatMessageRow";
import { usePersistentToolExpansion } from "./toolExpansionStore";
import { calculateChatTimelineVirtualScrollMarginTop } from "./chatTimelineVirtualization";

const ACTIVITY_SEGMENT_VIRTUALIZATION_THRESHOLD = 80;
const ACTIVITY_SEGMENT_VIRTUALIZATION_OVERSCAN = 6;
const ACTIVITY_SEGMENT_INITIAL_RENDER_LIMIT = 80;
const ACTIVITY_SEGMENT_FALLBACK_RENDER_INCREMENT = 80;
let nextActivitySegmentItemRevisionToken = 0;
const activitySegmentItemRevisionTokens = new WeakMap<object, number>();

type ToolActivitySegmentProps = Pick<
    ToolActivityItemProps,
    | "canRenderFileReference"
    | "onOpenFile"
    | "onOpenFileReference"
    | "onOpenSession"
    | "projectId"
    | "resolveFileReference"
    | "worktreeId"
> & {
    /** True only while this segment is the trailing activity of an active turn. */
    readonly isCurrentTurnTail?: boolean;
    readonly scrollContainerRef?: RefObject<HTMLElement | null>;
    readonly segment: ChatTimelineActivitySegmentRow;
} & Pick<
        ThinkingMessageProps,
        | "chatFontFamily"
        | "chatFontSize"
        | "highlightQuery"
        | "onAddFileReferenceToChat"
        | "onRevealFileReference"
    >;

function pluralize(count: number, singular: string, plural = `${singular}s`) {
    return `${count} ${count === 1 ? singular : plural}`;
}

function getSegmentHeadline(
    segment: ChatTimelineActivitySegmentRow,
    isCurrentTurnTail: boolean,
): string {
    const { summary } = segment;
    if (summary.actionCount === 0) {
        return isCurrentTurnTail ? "Thinking..." : "Thought";
    }
    const details = [
        pluralize(summary.actionCount, "action"),
        summary.changedFileCount > 0
            ? pluralize(
                  summary.changedFileCount,
                  "file changed",
                  "files changed",
              )
            : null,
        summary.failureCount > 0
            ? pluralize(summary.failureCount, "failure")
            : null,
    ].filter((detail): detail is string => detail !== null);

    if (isCurrentTurnTail) {
        return `Working · ${details.join(" · ")}`;
    }

    if (
        summary.changeCount === 0 &&
        summary.commandCount === 0 &&
        summary.failureCount === 0 &&
        (summary.fileCount > 0 || summary.searchCount > 0)
    ) {
        const explorationDetails = [
            summary.fileCount > 0
                ? pluralize(summary.fileCount, "file")
                : null,
            summary.searchCount > 0
                ? pluralize(summary.searchCount, "search", "searches")
                : null,
        ].filter((detail): detail is string => detail !== null);
        return `Explored ${explorationDetails.join(" · ")}`;
    }

    return `Worked · ${details.join(" · ")}`;
}

function getLatestActivityLabel(
    segment: ChatTimelineActivitySegmentRow,
): string {
    const latestItem = segment.items.at(-1);
    if (latestItem?.kind === "thinking") {
        return latestItem.message.status === "streaming"
            ? "Thinking..."
            : "Thinking";
    }
    const latestActivity = latestItem?.entry.reviewEntry.activity;
    if (!latestActivity) {
        return segment.summary.latestTitle;
    }

    const descriptor = getToolActivityDescriptor(latestActivity);
    return (
        descriptor.command ?? descriptor.target ?? segment.summary.latestTitle
    );
}

function Chevron({ expanded }: { readonly expanded: boolean }) {
    return (
        <svg
            aria-hidden="true"
            fill="none"
            height="11"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.8"
            style={{
                transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
                transition: "transform 150ms ease",
            }}
            viewBox="0 0 16 16"
            width="11"
        >
            <path d="m4 6 4 4 4-4" />
        </svg>
    );
}

type ActivitySegmentItemRendererProps = Pick<
    ToolActivitySegmentProps,
    | "canRenderFileReference"
    | "chatFontFamily"
    | "chatFontSize"
    | "highlightQuery"
    | "onAddFileReferenceToChat"
    | "onOpenFile"
    | "onOpenFileReference"
    | "onOpenSession"
    | "onRevealFileReference"
    | "projectId"
    | "resolveFileReference"
    | "worktreeId"
>;

function getActivitySegmentItemId(
    item: ChatTimelineActivitySegmentRow["items"][number],
): string {
    return item.kind === "thinking"
        ? `thinking:${item.message.id}`
        : `tool:${item.entry.reviewEntry.activity.sessionId}:${item.entry.reviewEntry.activity.id}`;
}

function getActivitySegmentItemMeasurementKey(
    item: ChatTimelineActivitySegmentRow["items"][number],
): string {
    const source =
        item.kind === "thinking"
            ? item.message
            : item.entry.reviewEntry.activity;
    const revisionToken = getActivitySegmentItemRevisionToken(source);
    if (item.kind === "thinking") {
        return `${getActivitySegmentItemId(item)}:${revisionToken}`;
    }

    const { trackedFiles } = item.entry.reviewEntry;
    return [
        getActivitySegmentItemId(item),
        revisionToken,
        ...trackedFiles.map(
            (trackedFile) =>
                `${trackedFile.identityKey}:${trackedFile.updatedAt}`,
        ),
    ].join(":");
}

function getActivitySegmentItemRevisionToken(source: object): number {
    const existing = activitySegmentItemRevisionTokens.get(source);
    if (existing !== undefined) {
        return existing;
    }

    const token = nextActivitySegmentItemRevisionToken;
    nextActivitySegmentItemRevisionToken += 1;
    activitySegmentItemRevisionTokens.set(source, token);
    return token;
}

function estimateActivitySegmentItemHeight(
    item: ChatTimelineActivitySegmentRow["items"][number],
): number {
    if (item.kind === "thinking") {
        return 52;
    }

    const activity = item.entry.reviewEntry.activity;
    if (item.entry.policy === "standalone-change") {
        return 88;
    }
    if (activity.status === "failed" || activity.terminalOutput) {
        return 64;
    }
    return 36;
}

function ActivitySegmentItemRow({
    item,
    ...props
}: ActivitySegmentItemRendererProps & {
    readonly item: ChatTimelineActivitySegmentRow["items"][number];
}) {
    const openThinkingFileReference = props.onOpenFileReference ?? (() => undefined);
    const resolveThinkingFileReference = props.resolveFileReference ?? (() => null);

    return (
        <div
            className="activity-tree-branch min-w-0 pl-10"
            data-activity-rail-decoration="branch"
            data-activity-rail-indent="child"
            data-thinking-message-id={
                item.kind === "thinking" ? item.message.id : undefined
            }
            data-tool-activity-id={
                item.kind === "tool"
                    ? item.entry.reviewEntry.activity.id
                    : undefined
            }
            data-tool-activity-visibility={
                item.kind === "tool" && item.entry.policy === "groupable"
                    ? "expanded-only"
                    : "always"
            }
            role="listitem"
        >
            <div className="min-w-0 py-0.5">
                {item.kind === "thinking" ? (
                    <ThinkingMessage
                        canRenderFileReference={props.canRenderFileReference}
                        chatFontFamily={props.chatFontFamily}
                        chatFontSize={props.chatFontSize}
                        content={item.message.content}
                        highlightQuery={props.highlightQuery}
                        inProgress={item.message.status === "streaming"}
                        onAddFileReferenceToChat={props.onAddFileReferenceToChat}
                        onOpenFile={openThinkingFileReference}
                        onRevealFileReference={props.onRevealFileReference}
                        resolveFileReference={resolveThinkingFileReference}
                    />
                ) : (
                    <ToolActivityItem
                        activity={item.entry.reviewEntry.activity}
                        canRenderFileReference={props.canRenderFileReference}
                        compactTerminal
                        onOpenFile={props.onOpenFile}
                        onOpenFileReference={props.onOpenFileReference}
                        onOpenSession={props.onOpenSession}
                        projectId={props.projectId}
                        resolveFileReference={props.resolveFileReference}
                        surface={
                            item.entry.policy === "standalone-change"
                                ? "card"
                                : "rail-row"
                        }
                        trackedFiles={item.entry.reviewEntry.trackedFiles}
                        worktreeId={props.worktreeId}
                    />
                )}
            </div>
        </div>
    );
}

function ExpandedActivitySegmentItems({
    contentId,
    items,
    scrollContainerRef,
    segmentId,
    ...itemRendererProps
}: ActivitySegmentItemRendererProps & {
    readonly contentId: string;
    readonly items: readonly ChatTimelineActivitySegmentRow["items"][number][];
    readonly scrollContainerRef?: RefObject<HTMLElement | null>;
    readonly segmentId: string;
}) {
    const contentRef = useRef<HTMLDivElement | null>(null);
    const [isVirtualListReady, setIsVirtualListReady] = useState(false);
    const [fallbackRenderLimit, setFallbackRenderLimit] = useState(
        ACTIVITY_SEGMENT_INITIAL_RENDER_LIMIT,
    );
    const [scrollMarginTop, setScrollMarginTop] = useState(0);
    const shouldVirtualize =
        items.length >= ACTIVITY_SEGMENT_VIRTUALIZATION_THRESHOLD;

    useLayoutEffect(() => {
        if (!shouldVirtualize || !scrollContainerRef?.current) {
            setIsVirtualListReady(false);
            return;
        }

        setIsVirtualListReady(true);
        const nextScrollMarginTop = calculateChatTimelineVirtualScrollMarginTop({
            historyElement: contentRef.current,
            scrollContainer: scrollContainerRef.current,
        });
        setScrollMarginTop((current) =>
            current === nextScrollMarginTop ? current : nextScrollMarginTop,
        );
    }, [scrollContainerRef, shouldVirtualize]);

    const visibleItems =
        shouldVirtualize && !isVirtualListReady
            ? items.slice(0, fallbackRenderLimit)
            : items;
    const hasMoreFallbackItems = visibleItems.length < items.length;

    return (
        <div
            aria-label="Full activity"
            className="pt-1"
            id={contentId}
            ref={contentRef}
            role="region"
        >
            <div className="activity-tree min-w-0" role="list">
                {shouldVirtualize && isVirtualListReady && scrollContainerRef ? (
                    <MeasuredVirtualList
                        defaultViewportHeight={720}
                        enabled
                        estimateSize={estimateActivitySegmentItemHeight}
                        getItemIdentityKey={getActivitySegmentItemMeasurementKey}
                        getItemKey={getActivitySegmentItemId}
                        getItemMeasurementKey={getActivitySegmentItemMeasurementKey}
                        items={items}
                        measurementCacheKey={`activity-segment:${segmentId}`}
                        overscan={ACTIVITY_SEGMENT_VIRTUALIZATION_OVERSCAN}
                        preserveScrollAnchorOnItemsChange={false}
                        preserveScrollAnchorOnMeasure={false}
                        renderItem={({ item }) => (
                            <ActivitySegmentItemRow
                                {...itemRendererProps}
                                item={item}
                            />
                        )}
                        scrollContainerRef={scrollContainerRef}
                        scrollMarginTop={scrollMarginTop}
                    />
                ) : (
                    <div className="flex min-w-0 flex-col gap-1.5">
                        {visibleItems.map((item) => (
                            <ActivitySegmentItemRow
                                {...itemRendererProps}
                                item={item}
                                key={getActivitySegmentItemId(item)}
                            />
                        ))}
                    </div>
                )}
            </div>
            {hasMoreFallbackItems ? (
                <button
                    aria-controls={contentId}
                    className="ml-10 mt-1 text-xs text-text-secondary underline-offset-2 hover:text-text-primary hover:underline focus-visible:outline-none focus-visible:underline"
                    onClick={() =>
                        setFallbackRenderLimit(
                            (current) =>
                                current +
                                ACTIVITY_SEGMENT_FALLBACK_RENDER_INCREMENT,
                        )
                    }
                    type="button"
                >
                    Show more activity
                </button>
            ) : null}
        </div>
    );
}

export const ToolActivitySegment = memo(function ToolActivitySegment({
    canRenderFileReference,
    chatFontFamily,
    chatFontSize,
    highlightQuery,
    onAddFileReferenceToChat,
    onOpenFile,
    onOpenFileReference,
    onOpenSession,
    onRevealFileReference,
    projectId,
    resolveFileReference,
    isCurrentTurnTail = false,
    scrollContainerRef,
    segment,
    worktreeId,
}: ToolActivitySegmentProps) {
    const defaultExpansion = useSettingsStore(
        (state) => state.aiChat.toolActivityDefaultExpansion,
    );
    const defaultExpanded = defaultExpansion === "expanded";
    const [expanded, setExpanded] = usePersistentToolExpansion(
        `${segment.id}:full-activity:${defaultExpansion}`,
        defaultExpanded,
    );
    const canExpand = segment.items.length > 0;
    const contentId = `${segment.id}:activity`;
    const headline = getSegmentHeadline(segment, isCurrentTurnTail);
    const isWorkedSegment = headline.startsWith("Worked ·");
    const latestActivityLabel = getLatestActivityLabel(segment);
    const changeStats = useMemo(
        () => deriveActivitySegmentChangeStats(segment.entries),
        [segment.entries],
    );
    const hasChanges = segment.summary.changeCount > 0;
    const activityState = isCurrentTurnTail
        ? "In progress"
        : "Completed";
    const accessibleChangeSummary = hasChanges
        ? ` ${pluralize(changeStats.additions, "addition")}, ${pluralize(changeStats.deletions, "deletion")}. Changed.`
        : "";
    const accessibleLabel = `${expanded ? "Hide" : "Show"} full activity: ${headline}.${accessibleChangeSummary} ${activityState}.`;
    const headerContent = (
        <>
            <span
                aria-hidden="true"
                className="shrink-0 self-start leading-4 text-text-secondary"
                data-activity-rail-prefix="true"
            >
                {">"}
            </span>
            <span className="min-w-0 flex-1">
                <span
                    className={`block truncate text-[11px] leading-4 ${
                        isWorkedSegment ? "font-bold" : "font-medium"
                    }`}
                    title={headline}
                >
                    {headline}
                </span>
                {segment.summary.actionCount > 1 ? (
                    <span
                        data-activity-rail-current="true"
                        className="block truncate text-[10px] leading-3.5 text-text-secondary"
                        title={segment.summary.latestTitle}
                    >
                        {isCurrentTurnTail ? "Current" : "Latest"}: {segment.summary.latestTitle}
                    </span>
                ) : (
                    <span
                        data-activity-rail-current="true"
                        className="block truncate text-[10px] leading-3.5 text-text-secondary"
                        title={latestActivityLabel}
                    >
                        {latestActivityLabel}
                    </span>
                )}
            </span>
            {hasChanges ? (
                <span
                    className="flex shrink-0 items-center gap-1.5 text-[10px] font-medium"
                    data-activity-change-summary="true"
                >
                    {changeStats.additions > 0 ? (
                        <span style={{ color: "var(--diff-add)" }}>
                            +
                            {formatDiffStat(
                                changeStats.additions,
                                changeStats.approximate,
                            )}
                        </span>
                    ) : null}
                    {changeStats.deletions > 0 ? (
                        <span style={{ color: "var(--diff-remove)" }}>
                            -
                            {formatDiffStat(
                                changeStats.deletions,
                                changeStats.approximate,
                            )}
                        </span>
                    ) : null}
                    <span className="text-text-secondary">Changed</span>
                </span>
            ) : null}
            {canExpand ? (
                <span className="shrink-0 text-text-secondary">
                    <Chevron expanded={expanded} />
                </span>
            ) : null}
        </>
    );

    return (
        <div
            aria-busy={isCurrentTurnTail}
            className="activity-rail min-w-0"
            data-activity-count={segment.summary.actionCount}
            data-activity-rail="true"
            data-tool-activity-segment={segment.id}
        >
            {canExpand ? (
                <button
                    aria-controls={contentId}
                    aria-expanded={expanded}
                    aria-label={accessibleLabel}
                    className="flex min-h-10 w-full items-center gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-bg-elevated focus-visible:bg-bg-elevated focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]"
                    onClick={() => setExpanded((current) => !current)}
                    style={{
                        background: "none",
                        border: "none",
                        color: "var(--color-text-primary)",
                    }}
                    type="button"
                >
                    {headerContent}
                </button>
            ) : (
                <div className="flex min-h-10 w-full items-center gap-2 px-1 py-1 text-left">
                    {headerContent}
                </div>
            )}

            {expanded ? (
                <ExpandedActivitySegmentItems
                    canRenderFileReference={canRenderFileReference}
                    chatFontFamily={chatFontFamily}
                    chatFontSize={chatFontSize}
                    contentId={contentId}
                    highlightQuery={highlightQuery}
                    items={segment.items}
                    onAddFileReferenceToChat={onAddFileReferenceToChat}
                    onOpenFile={onOpenFile}
                    onOpenFileReference={onOpenFileReference}
                    onOpenSession={onOpenSession}
                    onRevealFileReference={onRevealFileReference}
                    projectId={projectId}
                    resolveFileReference={resolveFileReference}
                    scrollContainerRef={scrollContainerRef}
                    segmentId={segment.id}
                    worktreeId={worktreeId}
                />
            ) : null}
        </div>
    );
});

ToolActivitySegment.displayName = "ToolActivitySegment";
