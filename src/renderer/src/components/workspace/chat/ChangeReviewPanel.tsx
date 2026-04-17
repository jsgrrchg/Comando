import {
    memo,
    useCallback,
    useMemo,
    useState,
    type CSSProperties,
} from "react";

import type { AiToolActivity, AiTrackedFile } from "@shared/ipc";
import type { RuntimeWorkspaceFileReviewContext } from "@renderer/app/workspace/tree";

import { DEFAULT_AI_DIFF_ZOOM } from "@renderer/app/ai/sessionReviewContracts";
import { useRenderProbe } from "@renderer/app/debug/renderProbe";
import type { ResolvedProjectFileReference } from "../projectFileReferences";
import { EditedFileDiffPreview } from "../review/EditedFileDiffPreview";
import { getNeutralButtonStyle } from "../review/reviewStyles";
import { formatDiffStat, getFileNameFromPath } from "../review/reviewDiff";
import {
    deriveChangeReviewItems,
    type ChangeReviewItem,
} from "./toolActivityReviewModel";
import { ResizableDiffContainer } from "./ResizableDiffContainer";
import { FileTypeIcon } from "@renderer/components/icons/FileTypeIcon";

const TOOL_ACTION_BUTTON_STYLE: CSSProperties = {
    borderRadius: 8,
    fontSize: "0.74em",
    fontWeight: 600,
    minHeight: 24,
    padding: "0 10px",
};

function getFlatDiffStatStyle(color: string): CSSProperties {
    return {
        color,
        fontSize: "0.74em",
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
    return path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path);
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

function ChangeReviewFileCard({
    activity,
    defaultExpanded = false,
    diffZoom,
    item,
    onOpen,
}: {
    readonly activity: AiToolActivity;
    readonly defaultExpanded?: boolean;
    readonly diffZoom: number;
    readonly item: ChangeReviewItem;
    readonly onOpen: (() => void) | null;
}) {
    const [expanded, setExpanded] = useState(defaultExpanded);
    const accent = getPanelAccent(activity);
    const actionLabel = getActivityActionLabel(activity.kind);
    const summaryLabel = `${actionLabel} ${getFileNameFromPath(item.path)}`;

    return (
        <div
            className="min-w-0 max-w-full overflow-hidden rounded-lg"
            style={{
                backgroundColor: `color-mix(in srgb, ${accent} 4%, var(--color-bg-secondary))`,
                border: `1px solid color-mix(in srgb, ${accent} 24%, var(--color-border))`,
            }}
        >
            <div
                style={{
                    alignItems: "center",
                    borderBottom: expanded
                        ? `1px solid color-mix(in srgb, ${accent} 14%, var(--color-border))`
                        : "1px solid transparent",
                    display: "grid",
                    gap: 12,
                    gridTemplateColumns: "minmax(0, 1fr) auto",
                    padding: "7px 12px",
                }}
            >
                <button
                    aria-label={`${expanded ? "Collapse" : "Expand"} inline diff review`}
                    onClick={() => setExpanded((current) => !current)}
                    style={{
                        alignItems: "center",
                        background: "none",
                        border: "none",
                        color: "inherit",
                        cursor: "pointer",
                        display: "flex",
                        gap: 10,
                        minWidth: 0,
                        padding: 0,
                        textAlign: "left",
                    }}
                    type="button"
                >
                    <span
                        style={{
                            color: "var(--color-text-secondary)",
                            flexShrink: 0,
                        }}
                    >
                        <Chevron expanded={expanded} />
                    </span>
                    <span className="shrink-0" style={{ color: accent }}>
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
                    <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-2">
                            <span
                                className="truncate"
                                style={{
                                    color: "var(--color-text-primary)",
                                    fontSize: "0.84em",
                                    fontWeight: 400,
                                }}
                            >
                                {summaryLabel}
                            </span>
                            {item.tone.badge ? (
                                <span
                                    style={{
                                        backgroundColor: `color-mix(in srgb, ${item.tone.accent} 10%, transparent)`,
                                        borderRadius: 999,
                                        color: item.tone.accent,
                                        fontSize: "0.62em",
                                        fontWeight: 700,
                                        letterSpacing: "0.04em",
                                        padding: "2px 6px",
                                        textTransform: "uppercase",
                                    }}
                                >
                                    {getBadgeLabel(item)}
                                </span>
                            ) : null}
                        </div>
                    </div>
                </button>

                <div className="flex flex-wrap items-center justify-end gap-2">
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
                        <span
                            style={getFlatDiffStatStyle("var(--diff-remove)")}
                        >
                            -
                            {formatDiffStat(
                                item.stats.deletions,
                                item.stats.approximate,
                            )}
                        </span>
                    ) : null}
                    {onOpen ? (
                        <button
                            onClick={onOpen}
                            style={{
                                ...getNeutralButtonStyle(),
                                ...TOOL_ACTION_BUTTON_STYLE,
                            }}
                            type="button"
                        >
                            Open
                        </button>
                    ) : null}
                    {renderStatus(activity)}
                </div>
            </div>

            {expanded ? (
                <ResizableDiffContainer accent={accent}>
                    <EditedFileDiffPreview
                        compactLineNumbers
                        diff={item.diff}
                        diffZoom={diffZoom}
                        expanded={expanded}
                        file={item.file ?? undefined}
                        testId={`change-review-panel:${item.key}`}
                    />
                </ResizableDiffContainer>
            ) : null}
        </div>
    );
}

export interface ChangeReviewPanelProps {
    readonly activity: AiToolActivity;
    readonly defaultExpanded?: boolean;
    readonly defaultExpandedFileKeys?: readonly string[];
    readonly onOpenFile: (
        projectId: string,
        relativePath: string,
        worktreeId?: string | null,
        reviewContext?: RuntimeWorkspaceFileReviewContext | null,
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
    defaultExpanded = false,
    defaultExpandedFileKeys = [],
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
            (trackedFile) => trackedFile.reviewState === "pending",
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
        return null;
    }

    if (items.length === 1) {
        const [singleItem] = items;
        if (!singleItem) {
            return null;
        }

        return (
            <ChangeReviewFileCard
                activity={activity}
                defaultExpanded={defaultExpanded}
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

    const defaultExpandedKeys = new Set(defaultExpandedFileKeys);

    return (
        <div className="space-y-2">
            {items.map((item) => (
                <ChangeReviewFileCard
                    activity={activity}
                    defaultExpanded={
                        defaultExpandedKeys.size > 0
                            ? defaultExpandedKeys.has(item.key)
                            : defaultExpanded
                    }
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
        previous.defaultExpanded === next.defaultExpanded &&
        previous.defaultExpandedFileKeys === next.defaultExpandedFileKeys &&
        previous.projectId === next.projectId &&
        previous.trackedFiles === next.trackedFiles &&
        previous.worktreeId === next.worktreeId
    );
}
