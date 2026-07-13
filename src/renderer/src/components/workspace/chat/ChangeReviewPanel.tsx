import { memo, useCallback, useMemo, type CSSProperties } from "react";

import type { AiToolActivity, AiTrackedFile } from "@shared/ipc";
import { isAiTrackedFileUnresolved } from "@shared/ai-tracked-file";
import type {
    RuntimeWorkspaceFileOpenLocation,
    RuntimeWorkspaceFileReviewContext,
} from "@renderer/app/workspace/tree";

import { DEFAULT_AI_DIFF_ZOOM } from "@renderer/app/ai/sessionReviewContracts";
import { useRenderProbe } from "@renderer/app/debug/renderProbe";
import { FileTypeIcon } from "@renderer/components/icons/FileTypeIcon";
import type { ResolvedProjectFileReference } from "../projectFileReferences";
import { EditedFileDiffPreview } from "../review/EditedFileDiffPreview";
import { formatDiffStat, getFileNameFromPath } from "../review/reviewDiff";
import {
    deriveChangeReviewItems,
    type ChangeReviewItem,
} from "./toolActivityReviewModel";
import { getStructuredToolTarget } from "./toolActivityDescriptor";
import { ResizableDiffContainer } from "./ResizableDiffContainer";
import { usePersistentToolExpansion } from "./toolExpansionStore";

function getFlatDiffStatStyle(color: string): CSSProperties {
    return {
        color,
        fontSize: "0.9em",
        fontWeight: 700,
    };
}

function WarningIcon() {
    return (
        <svg
            fill="none"
            height="14"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.5"
            viewBox="0 0 24 24"
            width="14"
        >
            <path d="M12 3 2 21h20L12 3Z" />
            <path d="M12 9v4" />
            <circle cx="12" cy="17" fill="currentColor" r="0.75" />
        </svg>
    );
}

function Chevron({ expanded }: { readonly expanded: boolean }) {
    return (
        <svg
            fill="none"
            height="10"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            style={{
                transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
                transition: "transform 140ms ease",
            }}
            viewBox="0 0 24 24"
            width="10"
        >
            <polyline points="8 6 14 12 8 18" />
        </svg>
    );
}

function getPanelAccent(activity: AiToolActivity): string {
    if (activity.status === "failed") {
        return "var(--diff-warn)";
    }

    const normalizedKind = activity.kind.toLowerCase();
    if (normalizedKind === "delete" || normalizedKind === "remove") {
        return "var(--diff-remove)";
    }

    return "var(--color-accent)";
}

function getActivityActionLabel(kind: string): string {
    const normalizedKind = kind.toLowerCase();
    if (normalizedKind === "create" || normalizedKind === "write") {
        return "Created";
    }
    if (normalizedKind === "delete" || normalizedKind === "remove") {
        return "Deleted";
    }
    if (normalizedKind === "move" || normalizedKind === "rename") {
        return "Moved";
    }
    if (normalizedKind === "read" || normalizedKind === "search") {
        return "Reviewed";
    }
    return "Edited";
}

function getBadgeLabel(item: ChangeReviewItem): string {
    if (item.tone.badge) {
        return item.tone.badge;
    }

    if (item.diff.kind === "create") {
        return "New";
    }

    if (item.diff.kind === "delete") {
        return "Deleted";
    }

    if (item.diff.kind === "move") {
        return "Moved";
    }

    return "Modified";
}

function looksAbsolutePath(path: string): boolean {
    return (
        path.startsWith("/") ||
        /^[a-zA-Z]:[\\/]/.test(path) ||
        path.startsWith("\\\\")
    );
}

function canOpenItem(
    item: ChangeReviewItem,
    projectId: string | null,
    resolveFileReference?: (
        reference: string,
    ) => ResolvedProjectFileReference | null,
): boolean {
    if (!projectId) {
        return false;
    }

    return resolveOpenPath(item, resolveFileReference) !== null;
}

function resolveOpenPath(
    item: ChangeReviewItem,
    resolveFileReference?: (
        reference: string,
    ) => ResolvedProjectFileReference | null,
): string | null {
    if (item.diff.kind === "delete") {
        return null;
    }

    if (!looksAbsolutePath(item.path)) {
        return item.path;
    }

    return resolveFileReference?.(item.path)?.relativePath ?? null;
}

function renderStatus(activity: AiToolActivity) {
    if (activity.status === "in_progress" || activity.status === "pending") {
        return (
            <span
                className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full"
                style={{ backgroundColor: "var(--color-accent)" }}
            />
        );
    }

    if (activity.status === "failed") {
        return (
            <span
                style={{
                    color: "var(--diff-warn)",
                    fontSize: "0.72em",
                    fontWeight: 600,
                    textTransform: "uppercase",
                }}
            >
                failed
            </span>
        );
    }

    return null;
}

function ChangeReviewRailRow({
    activity,
    diffZoom,
    item,
    onOpen,
}: {
    readonly activity: AiToolActivity;
    readonly diffZoom: number;
    readonly item: ChangeReviewItem;
    readonly onOpen: (() => void) | null;
}) {
    // Persist expansion (and the diff height below) in the timeline scroller so
    // it survives this row unmounting when its virtualized entry scrolls out of
    // view. Diffs always start collapsed; only an explicit user action opens
    // their preview.
    const resetKey = `${activity.id}:${item.key}`;
    const [expanded, setExpanded] = usePersistentToolExpansion(
        resetKey,
        false,
    );
    const accent = getPanelAccent(activity);
    const actionLabel = getActivityActionLabel(activity.kind);
    const fileName = getFileNameFromPath(item.path);

    return (
        <div
            className="min-w-0 max-w-full select-none"
            data-change-review-surface="rail-row"
            style={{
                color: "var(--color-text-secondary)",
                fontFamily: "var(--font-mono), ui-monospace, monospace",
                fontSize: "0.82em",
            }}
        >
            <div className="flex min-h-7 w-full min-w-0 items-center gap-2">
                <span
                    aria-hidden="true"
                    className="shrink-0"
                    style={{
                        color: accent,
                        display: "inline-flex",
                    }}
                >
                    {activity.status === "failed" ? (
                        <WarningIcon />
                    ) : (
                        <FileTypeIcon
                            fileName={item.path}
                            opacity={0.85}
                            size={14}
                        />
                    )}
                </span>
                <span className="shrink-0 opacity-70">{actionLabel}</span>
                {onOpen ? (
                    <button
                        aria-label={`Open ${item.path}`}
                        className="app-no-drag min-w-0 truncate text-left text-text-primary underline decoration-text-secondary/40 underline-offset-2 hover:decoration-current focus-visible:rounded-sm focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--color-accent)]"
                        onClick={onOpen}
                        title={item.path}
                        type="button"
                    >
                        {fileName}
                    </button>
                ) : (
                    <span
                        className="min-w-0 truncate text-text-primary"
                        title={item.path}
                    >
                        {fileName}
                    </span>
                )}
                <span className="min-w-0 flex-1" />
                {item.tone.badge ? (
                    <span
                        className="shrink-0 text-[10px] font-medium"
                        style={{ color: item.tone.accent }}
                    >
                        {getBadgeLabel(item)}
                    </span>
                ) : null}
                {item.stats.additions > 0 ? (
                    <span style={getFlatDiffStatStyle("var(--diff-add)")}>
                        +
                        {formatDiffStat(
                            item.stats.additions,
                            item.stats.approximate,
                        )}
                    </span>
                ) : null}
                {item.stats.deletions > 0 ? (
                    <span style={getFlatDiffStatStyle("var(--diff-remove)")}>
                        -
                        {formatDiffStat(
                            item.stats.deletions,
                            item.stats.approximate,
                        )}
                    </span>
                ) : null}
                {renderStatus(activity)}
                <button
                    aria-label={
                        `${expanded ? "Collapse" : "Expand"} inline diff review`
                    }
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-secondary hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--color-accent)]"
                    onClick={() => setExpanded((previous) => !previous)}
                    type="button"
                >
                    <Chevron expanded={expanded} />
                </button>
            </div>

            {expanded ? (
                <div className="ml-5 mt-1 overflow-hidden border-l border-border pl-2">
                    <ResizableDiffContainer
                        accent={accent}
                        persistKey={`${activity.id}:${item.key}:diff-height`}
                    >
                        <EditedFileDiffPreview
                            compactLineNumbers
                            diff={item.diff}
                            diffZoom={diffZoom}
                            expanded={expanded}
                            file={item.file ?? undefined}
                            testId={`change-review-panel:${item.key}`}
                        />
                    </ResizableDiffContainer>
                </div>
            ) : null}
        </div>
    );
}

function PendingChangeReviewRailRow({
    activity,
}: {
    readonly activity: AiToolActivity;
}) {
    const target = getStructuredToolTarget(activity);
    const actionLabel = getActivityActionLabel(activity.kind);

    return (
        <div
            className="min-w-0 max-w-full select-none"
            data-change-review-pending="true"
            data-change-review-surface="rail-row"
            style={{
                color: "var(--color-text-secondary)",
                fontFamily: "var(--font-mono), ui-monospace, monospace",
                fontSize: "0.82em",
            }}
        >
            <div className="flex min-h-7 w-full min-w-0 items-center gap-2">
                <span
                    aria-hidden="true"
                    className="shrink-0"
                    style={{
                        color: getPanelAccent(activity),
                        display: "inline-flex",
                    }}
                >
                    <FileTypeIcon
                        fileName={target ?? activity.title}
                        opacity={0.85}
                        size={14}
                    />
                </span>
                <span className="shrink-0 opacity-70">{actionLabel}</span>
                <span
                    className="min-w-0 flex-1 truncate text-text-primary"
                    title={target ?? activity.title}
                >
                    {target ? getFileNameFromPath(target) : activity.title}
                </span>
                {renderStatus(activity)}
            </div>
        </div>
    );
}

export interface ChangeReviewPanelProps {
    readonly activity: AiToolActivity;
    readonly onOpenFile: (
        projectId: string,
        relativePath: string,
        worktreeId?: string | null,
        reviewContext?: RuntimeWorkspaceFileReviewContext | null,
        openLocation?: RuntimeWorkspaceFileOpenLocation | null,
    ) => Promise<void>;
    readonly projectId: string | null;
    readonly resolveFileReference?: (
        reference: string,
    ) => ResolvedProjectFileReference | null;
    readonly trackedFiles?: readonly AiTrackedFile[];
    readonly worktreeId?: string | null;
}

export const ChangeReviewPanel = memo(function ChangeReviewPanel({
    activity,
    onOpenFile,
    projectId,
    resolveFileReference,
    trackedFiles = [],
    worktreeId = null,
}: ChangeReviewPanelProps) {
    const diffZoom = DEFAULT_AI_DIFF_ZOOM;

    const items = useMemo(
        () => deriveChangeReviewItems(activity, trackedFiles),
        [activity, trackedFiles],
    );

    useRenderProbe("ChangeReviewPanel", {
        activityId: activity.id,
        itemCount: items.length,
        pendingTrackedFiles: trackedFiles.filter(
            isAiTrackedFileUnresolved,
        ).length,
    });

    const openItem = useCallback(
        (item: ChangeReviewItem) => {
            const openPath = resolveOpenPath(item, resolveFileReference);
            if (!projectId || !openPath) {
                return;
            }

            void onOpenFile(
                projectId,
                openPath,
                worktreeId,
                item.file
                    ? {
                          path: item.file.path,
                          sessionId: item.file.sessionId,
                      }
                    : null,
            );
        },
        [onOpenFile, projectId, resolveFileReference, worktreeId],
    );

    if (items.length === 0) {
        if (
            activity.status === "in_progress" ||
            activity.status === "pending"
        ) {
            return <PendingChangeReviewRailRow activity={activity} />;
        }

        return null;
    }

    if (items.length === 1) {
        const [singleItem] = items;
        if (!singleItem) {
            return null;
        }

        return (
            <ChangeReviewRailRow
                activity={activity}
                diffZoom={diffZoom}
                item={singleItem}
                onOpen={
                    canOpenItem(singleItem, projectId, resolveFileReference)
                        ? () => openItem(singleItem)
                        : null
                }
            />
        );
    }

    return (
        <div className="space-y-1">
            {items.map((item) => (
                <ChangeReviewRailRow
                    activity={activity}
                    diffZoom={diffZoom}
                    item={item}
                    key={item.key}
                    onOpen={
                        canOpenItem(item, projectId, resolveFileReference)
                            ? () => openItem(item)
                            : null
                    }
                />
            ))}
        </div>
    );
}, areChangeReviewPanelPropsEqual);

ChangeReviewPanel.displayName = "ChangeReviewPanel";

function areChangeReviewPanelPropsEqual(
    previous: Readonly<ChangeReviewPanelProps>,
    next: Readonly<ChangeReviewPanelProps>,
) {
    return (
        previous.activity === next.activity &&
        previous.projectId === next.projectId &&
        previous.trackedFiles === next.trackedFiles &&
        previous.worktreeId === next.worktreeId
    );
}
