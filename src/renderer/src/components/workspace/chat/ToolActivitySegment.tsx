import { memo, useEffect } from "react";

import { useSettingsStore } from "@renderer/app/store/settings-store";

import type {
    ChatTimelineActivitySegmentRow,
} from "./chatTimelineModel";
import { formatDiffStat } from "../review/reviewDiff";
import {
    getToolActivityDescriptor,
    getToolActivityHeaderPresentation,
} from "./toolActivityDescriptor";
import {
    ToolActivityItem,
    type ToolActivityItemProps,
    type ToolPayloadVisibilityChangeHandler,
} from "./ToolActivityItem";
import {
    ThinkingMessage,
    type ThinkingMessageProps,
} from "./ChatMessageRow";
import { usePersistentToolExpansion } from "./toolExpansionStore";
import { incrementChatPerformanceCounter } from "@renderer/app/debug/chatPerformanceCounters";

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
    readonly expanded?: boolean;
    readonly isCurrentTurnTail?: boolean;
    readonly onExpandedChange?: (expanded: boolean) => void;
    readonly onToolPayloadVisibilityChange?: ToolPayloadVisibilityChangeHandler;
    readonly renderDetails?: boolean;
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
    const headerPresentation =
        getToolActivityHeaderPresentation(latestActivity);
    return (
        descriptor.command ??
        (headerPresentation
            ? `${headerPresentation.prefix}${headerPresentation.displayTarget}`
            : descriptor.target) ??
        segment.summary.latestTitle
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
    | "onToolPayloadVisibilityChange"
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

export function ActivitySegmentItemRow({
    flat = false,
    item,
    ...props
}: ActivitySegmentItemRendererProps & {
    /**
     * Virtualized entries do not share a stable DOM tree, so they retain the
     * rail indentation but omit connectors that could end at an unmounted row.
     */
    readonly flat?: boolean;
    readonly item: ChatTimelineActivitySegmentRow["items"][number];
}) {
    const openThinkingFileReference = props.onOpenFileReference ?? (() => undefined);
    const resolveThinkingFileReference = props.resolveFileReference ?? (() => null);

    return (
        <div
            className={
                flat
                    ? "min-w-0 pl-10"
                    : "activity-tree-branch min-w-0 pl-10"
            }
            data-activity-rail-decoration={flat ? undefined : "branch"}
            data-activity-rail-indent={flat ? undefined : "child"}
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
            role={flat ? undefined : "listitem"}
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
                    <div>
                        <ToolActivityItem
                            activity={item.entry.reviewEntry.activity}
                            canRenderFileReference={props.canRenderFileReference}
                            compactTerminal
                            onOpenFile={props.onOpenFile}
                            onOpenFileReference={props.onOpenFileReference}
                            onOpenSession={props.onOpenSession}
                            onPayloadVisibilityChange={
                                props.onToolPayloadVisibilityChange
                            }
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
                    </div>
                )}
            </div>
        </div>
    );
}

function ExpandedActivitySegmentItems({
    contentId,
    items,
    ...itemRendererProps
}: ActivitySegmentItemRendererProps & {
    readonly contentId: string;
    readonly items: readonly ChatTimelineActivitySegmentRow["items"][number][];
}) {
    useEffect(() => {
        incrementChatPerformanceCounter(
            "activity_items_mounted",
            items.length,
        );
    }, [items.length]);

    return (
        <div
            aria-label="Full activity"
            className="pt-1"
            id={contentId}
            role="region"
        >
            <div className="activity-tree min-w-0" role="list">
                <div className="flex min-w-0 flex-col gap-1.5">
                    {items.map((item) => (
                        <ActivitySegmentItemRow
                            {...itemRendererProps}
                            item={item}
                            key={getActivitySegmentItemId(item)}
                        />
                    ))}
                </div>
            </div>
        </div>
    );
}

export const ToolActivitySegment = memo(function ToolActivitySegment({
    canRenderFileReference,
    chatFontFamily,
    chatFontSize,
    highlightQuery,
    onAddFileReferenceToChat,
    onToolPayloadVisibilityChange,
    onOpenFile,
    onOpenFileReference,
    onOpenSession,
    onRevealFileReference,
    expanded: controlledExpanded,
    onExpandedChange,
    projectId,
    renderDetails = true,
    resolveFileReference,
    isCurrentTurnTail = false,
    segment,
    worktreeId,
}: ToolActivitySegmentProps) {
    const defaultExpansion = useSettingsStore(
        (state) => state.aiChat.toolActivityDefaultExpansion,
    );
    const defaultExpanded = defaultExpansion === "expanded";
    const [storedExpanded, setStoredExpanded] = usePersistentToolExpansion(
        `${segment.id}:full-activity:${defaultExpansion}`,
        defaultExpanded,
    );
    const expanded = controlledExpanded ?? storedExpanded;
    const setExpanded = (next: boolean) => {
        if (controlledExpanded === undefined) {
            setStoredExpanded(next);
        }
        onExpandedChange?.(next);
    };
    const canExpand = segment.items.length > 0;
    const contentId = `${segment.id}:activity`;
    const headline = getSegmentHeadline(segment, isCurrentTurnTail);
    const isWorkedSegment = headline.startsWith("Worked ·");
    const latestActivityLabel = getLatestActivityLabel(segment);
    const { changeStats } = segment;
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
                    aria-controls={renderDetails ? contentId : undefined}
                    aria-expanded={expanded}
                    aria-label={accessibleLabel}
                    className="flex min-h-10 w-full items-center gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-bg-elevated focus-visible:bg-bg-elevated focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]"
                    onClick={() => setExpanded(!expanded)}
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

            {expanded && renderDetails ? (
                <ExpandedActivitySegmentItems
                    canRenderFileReference={canRenderFileReference}
                    chatFontFamily={chatFontFamily}
                    chatFontSize={chatFontSize}
                    contentId={contentId}
                    highlightQuery={highlightQuery}
                    items={segment.items}
                    onAddFileReferenceToChat={onAddFileReferenceToChat}
                    onToolPayloadVisibilityChange={
                        onToolPayloadVisibilityChange
                    }
                    onOpenFile={onOpenFile}
                    onOpenFileReference={onOpenFileReference}
                    onOpenSession={onOpenSession}
                    onRevealFileReference={onRevealFileReference}
                    projectId={projectId}
                    resolveFileReference={resolveFileReference}
                    worktreeId={worktreeId}
                />
            ) : null}
        </div>
    );
});

ToolActivitySegment.displayName = "ToolActivitySegment";
