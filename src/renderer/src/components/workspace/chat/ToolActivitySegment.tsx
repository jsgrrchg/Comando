import { memo, useMemo } from "react";

import { useSettingsStore } from "@renderer/app/store/settings-store";

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
import { usePersistentToolExpansion } from "./toolExpansionStore";

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
    readonly segment: ChatTimelineActivitySegmentRow;
};

function pluralize(count: number, singular: string, plural = `${singular}s`) {
    return `${count} ${count === 1 ? singular : plural}`;
}

function getSegmentHeadline(
    segment: ChatTimelineActivitySegmentRow,
    isCurrentTurnTail: boolean,
): string {
    const { summary } = segment;
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
    const latestActivity = segment.entries.at(-1)?.reviewEntry.activity;
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

export const ToolActivitySegment = memo(function ToolActivitySegment({
    canRenderFileReference,
    onOpenFile,
    onOpenFileReference,
    onOpenSession,
    projectId,
    resolveFileReference,
    isCurrentTurnTail = false,
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
    const canExpand = segment.entries.length > 0;
    const contentId = `${segment.id}:activity`;
    const headline = getSegmentHeadline(segment, isCurrentTurnTail);
    const isWorkedSegment = headline.startsWith("Worked ·");
    const latestActivityLabel = getLatestActivityLabel(segment);
    const changeStats = useMemo(
        () => deriveActivitySegmentChangeStats(segment.entries),
        [segment.entries],
    );
    const hasChanges = segment.summary.changeCount > 0;
    const visibleEntries = expanded ? segment.entries : [];
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

            {visibleEntries.length > 0 ? (
                <div
                    aria-label="Full tool activity"
                    className="pt-1"
                    id={contentId}
                    role="region"
                >
                    <div
                        className="activity-tree flex min-w-0 flex-col gap-1.5"
                        role="list"
                    >
                        {visibleEntries.map(({ policy, reviewEntry }) => {
                            const atomicRowId = `tool:${reviewEntry.activity.sessionId}:${reviewEntry.activity.id}`;
                            return (
                                <div
                                    className="activity-tree-branch min-w-0 pl-10"
                                    data-activity-rail-decoration="branch"
                                    data-activity-rail-indent="child"
                                    data-tool-activity-id={reviewEntry.activity.id}
                                    data-tool-activity-visibility={
                                        policy === "groupable"
                                            ? "expanded-only"
                                            : "always"
                                    }
                                    key={atomicRowId}
                                    role="listitem"
                                >
                                    <div className="min-w-0 py-0.5">
                                        <ToolActivityItem
                                            activity={reviewEntry.activity}
                                            canRenderFileReference={canRenderFileReference}
                                            compactTerminal
                                            onOpenFile={onOpenFile}
                                            onOpenFileReference={onOpenFileReference}
                                            onOpenSession={onOpenSession}
                                            projectId={projectId}
                                            resolveFileReference={resolveFileReference}
                                            surface={
                                                policy === "standalone-change"
                                                    ? "card"
                                                    : "rail-row"
                                            }
                                            trackedFiles={reviewEntry.trackedFiles}
                                            worktreeId={worktreeId}
                                        />
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            ) : null}
        </div>
    );
});

ToolActivitySegment.displayName = "ToolActivitySegment";
