import { useCallback, useMemo, useState, type CSSProperties } from "react";

import type { AiToolActivity, AiTrackedFile } from "@shared/ipc";
import type { RuntimeWorkspaceFileReviewContext } from "@renderer/app/workspace/tree";

import { DEFAULT_AI_DIFF_ZOOM } from "@renderer/app/ai/sessionReviewContracts";
import { useAiStore } from "@renderer/app/store/ai-store";
import { EditedFileDiffPreview } from "../review/EditedFileDiffPreview";
import {
    getAccentButtonStyle,
    getDangerButtonStyle,
    getNeutralButtonStyle,
    getStatChipStyle,
    getToneBorderStyle,
} from "../review/reviewStyles";
import {
    DIFF_ZOOM_MAX,
    DIFF_ZOOM_MIN,
    DIFF_ZOOM_STEP,
    formatDiffStat,
    getCompactPath,
    getFileNameFromPath,
    stepDiffZoom,
} from "../review/reviewDiff";
import {
    deriveChangeReviewItems,
    deriveChangeReviewSummary,
    type ChangeReviewItem,
} from "./toolActivityReviewModel";
import { ResizableDiffContainer } from "./ResizableDiffContainer";

const TOOL_ACTION_BUTTON_STYLE: CSSProperties = {
    borderRadius: 8,
    fontSize: "0.74em",
    fontWeight: 600,
    minHeight: 28,
    padding: "0 10px",
};

function ToolIcon({ kind }: { readonly kind: string }) {
    const normalizedKind = kind.toLowerCase();
    if (normalizedKind === "delete" || normalizedKind === "remove") {
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
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="9" x2="15" y1="13" y2="13" />
            </svg>
        );
    }

    if (
        normalizedKind === "edit" ||
        normalizedKind === "write" ||
        normalizedKind === "create" ||
        normalizedKind === "move" ||
        normalizedKind === "update"
    ) {
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
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <path d="m9 15 2 2 4-4" />
            </svg>
        );
    }

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
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
    );
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
): boolean {
    if (!projectId) {
        return false;
    }

    if (item.diff.kind === "delete") {
        return false;
    }

    return !looksAbsolutePath(item.path);
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

function ChangeReviewFileRow({
    diffZoom,
    expanded,
    item,
    onKeep,
    onKeepHunk,
    onOpen,
    onReject,
    onRejectHunk,
    onToggle,
}: {
    readonly diffZoom: number;
    readonly expanded: boolean;
    readonly item: ChangeReviewItem;
    readonly onKeep: (() => void) | null;
    readonly onKeepHunk: ((hunkId: string) => void) | null;
    readonly onOpen: (() => void) | null;
    readonly onReject: (() => void) | null;
    readonly onRejectHunk: ((hunkId: string) => void) | null;
    readonly onToggle: () => void;
}) {
    return (
        <div
            style={{
                ...getToneBorderStyle(item.tone.accent),
                backgroundColor: "var(--color-bg-elevated)",
                border: "1px solid color-mix(in srgb, var(--color-border) 58%, transparent)",
                borderRadius: 12,
                overflow: "hidden",
            }}
        >
            <div
                style={{
                    alignItems: "center",
                    borderBottom: expanded
                        ? "1px solid color-mix(in srgb, var(--color-border) 42%, transparent)"
                        : "none",
                    display: "grid",
                    gap: 12,
                    gridTemplateColumns: "minmax(0, 1fr) auto",
                    padding: "10px 12px",
                }}
            >
                <button
                    aria-label={`${expanded ? "Collapse" : "Expand"} ${item.path}`}
                    onClick={onToggle}
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
                    <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-2">
                            <span
                                className="truncate"
                                style={{
                                    color: "var(--color-text-primary)",
                                    fontSize: "0.82em",
                                    fontWeight: 600,
                                }}
                            >
                                {getFileNameFromPath(item.path)}
                            </span>
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
                        </div>
                        <div
                            className="truncate"
                            style={{
                                color: "var(--color-text-secondary)",
                                fontSize: "0.72em",
                                marginTop: 2,
                            }}
                        >
                            {getCompactPath(item.path)} · {item.summary}
                        </div>
                    </div>
                </button>

                <div
                    className="flex flex-wrap items-center justify-end gap-2"
                    style={{ minWidth: 0 }}
                >
                    {item.stats.additions > 0 ? (
                        <span
                            style={{
                                color: "var(--diff-add)",
                                fontSize: "0.74em",
                                fontWeight: 700,
                            }}
                        >
                            +
                            {formatDiffStat(
                                item.stats.additions,
                                item.stats.approximate,
                            )}
                        </span>
                    ) : null}
                    {item.stats.deletions > 0 ? (
                        <span
                            style={{
                                color: "var(--diff-remove)",
                                fontSize: "0.74em",
                                fontWeight: 700,
                            }}
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
                    {onReject ? (
                        <button
                            onClick={onReject}
                            style={{
                                ...getDangerButtonStyle(false),
                                ...TOOL_ACTION_BUTTON_STYLE,
                            }}
                            type="button"
                        >
                            Reject
                        </button>
                    ) : null}
                    {onKeep ? (
                        <button
                            onClick={onKeep}
                            style={{
                                ...getAccentButtonStyle(item.tone.accent),
                                ...TOOL_ACTION_BUTTON_STYLE,
                            }}
                            type="button"
                        >
                            Accept
                        </button>
                    ) : null}
                </div>
            </div>

            {expanded ? (
                <ResizableDiffContainer accent={item.tone.accent}>
                    <EditedFileDiffPreview
                        compactLineNumbers
                        diff={item.diff}
                        diffZoom={diffZoom}
                        expanded={expanded}
                        file={item.file ?? undefined}
                        onKeepHunk={
                            item.canResolveHunks
                                ? (onKeepHunk ?? undefined)
                                : undefined
                        }
                        onRejectHunk={
                            item.canResolveHunks
                                ? (onRejectHunk ?? undefined)
                                : undefined
                        }
                        testId={`chat-review-diff:${item.key}`}
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
    readonly trackedFiles?: readonly AiTrackedFile[];
    readonly worktreeId?: string | null;
}

export function ChangeReviewPanel({
    activity,
    defaultExpanded = false,
    defaultExpandedFileKeys = [],
    onOpenFile,
    projectId,
    trackedFiles = [],
    worktreeId = null,
}: ChangeReviewPanelProps) {
    const keepTrackedFile = useAiStore((state) => state.keepTrackedFile);
    const keepTrackedFileHunks = useAiStore(
        (state) => state.keepTrackedFileHunks,
    );
    const rejectTrackedFile = useAiStore((state) => state.rejectTrackedFile);
    const rejectTrackedFileHunks = useAiStore(
        (state) => state.rejectTrackedFileHunks,
    );
    const setSessionDiffZoom = useAiStore((state) => state.setSessionDiffZoom);
    const diffZoom = useAiStore(
        (state) =>
            state.sessions[activity.sessionId]?.diffZoom ??
            DEFAULT_AI_DIFF_ZOOM,
    );

    const items = useMemo(
        () => deriveChangeReviewItems(activity, trackedFiles),
        [activity, trackedFiles],
    );
    const summary = useMemo(() => deriveChangeReviewSummary(items), [items]);
    const [expanded, setExpanded] = useState(defaultExpanded);
    const [expandedFileKeys, setExpandedFileKeys] = useState<
        ReadonlySet<string>
    >(() => new Set(defaultExpandedFileKeys));

    const singleItem = items.length === 1 ? (items[0] ?? null) : null;
    const accent = getPanelAccent(activity);
    const actionLabel = getActivityActionLabel(activity.kind);
    const canDecreaseZoom = diffZoom > DIFF_ZOOM_MIN;
    const canIncreaseZoom = diffZoom < DIFF_ZOOM_MAX;
    const canOpenSingleItem = singleItem
        ? canOpenItem(singleItem, projectId)
        : false;

    const openItem = useCallback(
        (item: ChangeReviewItem) => {
            if (!canOpenItem(item, projectId) || !projectId) {
                return;
            }

            void onOpenFile(
                projectId,
                item.path,
                worktreeId,
                item.file
                    ? {
                          path: item.file.path,
                          sessionId: item.file.sessionId,
                      }
                    : null,
            );
        },
        [onOpenFile, projectId, worktreeId],
    );

    const handleKeepFile = useCallback(
        (item: ChangeReviewItem) => {
            if (!item.file) {
                return;
            }

            void keepTrackedFile({
                path: item.file.path,
                sessionId: item.file.sessionId,
            });
        },
        [keepTrackedFile],
    );

    const handleRejectFile = useCallback(
        (item: ChangeReviewItem) => {
            if (!item.file) {
                return;
            }

            void rejectTrackedFile({
                path: item.file.path,
                sessionId: item.file.sessionId,
            });
        },
        [rejectTrackedFile],
    );

    const handleKeepHunk = useCallback(
        (item: ChangeReviewItem, hunkId: string) => {
            if (!item.file) {
                return;
            }

            void keepTrackedFileHunks({
                hunkIds: [hunkId],
                path: item.file.path,
                sessionId: item.file.sessionId,
            });
        },
        [keepTrackedFileHunks],
    );

    const handleRejectHunk = useCallback(
        (item: ChangeReviewItem, hunkId: string) => {
            if (!item.file) {
                return;
            }

            void rejectTrackedFileHunks({
                hunkIds: [hunkId],
                path: item.file.path,
                sessionId: item.file.sessionId,
            });
        },
        [rejectTrackedFileHunks],
    );

    const toggleExpandedFile = useCallback((key: string) => {
        setExpandedFileKeys((current) => {
            const next = new Set(current);
            if (next.has(key)) {
                next.delete(key);
            } else {
                next.add(key);
            }
            return next;
        });
    }, []);

    if (items.length === 0) {
        return null;
    }

    const summaryLabel = singleItem
        ? `${actionLabel} ${getFileNameFromPath(singleItem.path)}`
        : `${actionLabel} ${summary.fileCount} ${
              summary.fileCount === 1 ? "file" : "files"
          }`;

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
                    padding: "10px 12px",
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
                            <ToolIcon kind={activity.kind} />
                        )}
                    </span>
                    <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-2">
                            <span
                                className="truncate"
                                style={{
                                    color: "var(--color-text-primary)",
                                    fontSize: "0.84em",
                                    fontWeight: 600,
                                }}
                            >
                                {summaryLabel}
                            </span>
                            {singleItem?.tone.badge ? (
                                <span
                                    style={{
                                        backgroundColor: `color-mix(in srgb, ${singleItem.tone.accent} 10%, transparent)`,
                                        borderRadius: 999,
                                        color: singleItem.tone.accent,
                                        fontSize: "0.62em",
                                        fontWeight: 700,
                                        letterSpacing: "0.04em",
                                        padding: "2px 6px",
                                        textTransform: "uppercase",
                                    }}
                                >
                                    {getBadgeLabel(singleItem)}
                                </span>
                            ) : null}
                        </div>
                        {!singleItem ? (
                            <div
                                className="truncate"
                                style={{
                                    color: "var(--color-text-secondary)",
                                    fontSize: "0.74em",
                                    marginTop: 2,
                                }}
                            >
                                {`${summary.fileCount} files changed${
                                    summary.partialCount > 0
                                        ? ` · ${summary.partialCount} partial`
                                        : ""
                                }`}
                            </div>
                        ) : null}
                    </div>
                </button>

                <div className="flex flex-wrap items-center justify-end gap-2">
                    {summary.additions > 0 ? (
                        <span style={getStatChipStyle("var(--diff-add)")}>
                            +
                            {formatDiffStat(
                                summary.additions,
                                summary.approximate,
                            )}
                        </span>
                    ) : null}
                    {summary.deletions > 0 ? (
                        <span style={getStatChipStyle("var(--diff-remove)")}>
                            -
                            {formatDiffStat(
                                summary.deletions,
                                summary.approximate,
                            )}
                        </span>
                    ) : null}
                    <div
                        style={{
                            alignItems: "stretch",
                            backgroundColor:
                                "color-mix(in srgb, var(--color-bg-primary) 56%, transparent)",
                            border: `1px solid color-mix(in srgb, ${accent} 22%, var(--color-border))`,
                            borderRadius: 8,
                            display: "flex",
                            height: 28,
                            overflow: "hidden",
                        }}
                    >
                        <button
                            aria-label="Decrease diff zoom"
                            disabled={!canDecreaseZoom}
                            onClick={() =>
                                setSessionDiffZoom(
                                    activity.sessionId,
                                    stepDiffZoom(diffZoom, -DIFF_ZOOM_STEP),
                                )
                            }
                            style={{
                                alignItems: "center",
                                background: "none",
                                border: "none",
                                color: canDecreaseZoom
                                    ? accent
                                    : "var(--color-text-secondary)",
                                cursor: canDecreaseZoom
                                    ? "pointer"
                                    : "not-allowed",
                                display: "inline-flex",
                                fontSize: "0.76em",
                                justifyContent: "center",
                                opacity: canDecreaseZoom ? 1 : 0.45,
                                minWidth: 28,
                                padding: "0 8px",
                            }}
                            type="button"
                        >
                            -
                        </button>
                        <button
                            aria-label="Increase diff zoom"
                            disabled={!canIncreaseZoom}
                            onClick={() =>
                                setSessionDiffZoom(
                                    activity.sessionId,
                                    stepDiffZoom(diffZoom, DIFF_ZOOM_STEP),
                                )
                            }
                            style={{
                                alignItems: "center",
                                background: "none",
                                border: "none",
                                color: canIncreaseZoom
                                    ? accent
                                    : "var(--color-text-secondary)",
                                cursor: canIncreaseZoom
                                    ? "pointer"
                                    : "not-allowed",
                                display: "inline-flex",
                                fontSize: "0.76em",
                                justifyContent: "center",
                                opacity: canIncreaseZoom ? 1 : 0.45,
                                minWidth: 28,
                                padding: "0 8px",
                            }}
                            type="button"
                        >
                            +
                        </button>
                    </div>
                    {singleItem ? (
                        <button
                            disabled={!canOpenSingleItem}
                            onClick={() => {
                                if (!canOpenSingleItem) return;
                                openItem(singleItem);
                            }}
                            style={{
                                ...getNeutralButtonStyle(),
                                ...TOOL_ACTION_BUTTON_STYLE,
                                cursor: canOpenSingleItem
                                    ? "pointer"
                                    : "not-allowed",
                                opacity: canOpenSingleItem ? 1 : 0.45,
                            }}
                            type="button"
                        >
                            Open
                        </button>
                    ) : null}
                    {singleItem?.canReject ? (
                        <button
                            onClick={() => handleRejectFile(singleItem)}
                            style={{
                                ...getDangerButtonStyle(false),
                                ...TOOL_ACTION_BUTTON_STYLE,
                            }}
                            type="button"
                        >
                            Reject
                        </button>
                    ) : null}
                    {singleItem?.canKeep ? (
                        <button
                            onClick={() => handleKeepFile(singleItem)}
                            style={{
                                ...getAccentButtonStyle(singleItem.tone.accent),
                                ...TOOL_ACTION_BUTTON_STYLE,
                            }}
                            type="button"
                        >
                            Accept
                        </button>
                    ) : null}
                    {renderStatus(activity)}
                </div>
            </div>

            {expanded ? (
                singleItem ? (
                    <ResizableDiffContainer accent={singleItem.tone.accent}>
                        <EditedFileDiffPreview
                            compactLineNumbers
                            diff={singleItem.diff}
                            diffZoom={diffZoom}
                            expanded={expanded}
                            file={singleItem.file ?? undefined}
                            onKeepHunk={
                                singleItem.canResolveHunks
                                    ? (hunkId) =>
                                          handleKeepHunk(singleItem, hunkId)
                                    : undefined
                            }
                            onRejectHunk={
                                singleItem.canResolveHunks
                                    ? (hunkId) =>
                                          handleRejectHunk(singleItem, hunkId)
                                    : undefined
                            }
                            testId={`change-review-panel:${singleItem.key}`}
                        />
                    </ResizableDiffContainer>
                ) : (
                    <div className="space-y-2 px-2 py-2">
                        {items.map((item) => (
                            <ChangeReviewFileRow
                                diffZoom={diffZoom}
                                expanded={expandedFileKeys.has(item.key)}
                                item={item}
                                key={item.key}
                                onKeep={
                                    item.canKeep
                                        ? () => handleKeepFile(item)
                                        : null
                                }
                                onKeepHunk={
                                    item.canResolveHunks
                                        ? (hunkId) =>
                                              handleKeepHunk(item, hunkId)
                                        : null
                                }
                                onOpen={
                                    canOpenItem(item, projectId)
                                        ? () => openItem(item)
                                        : null
                                }
                                onReject={
                                    item.canReject
                                        ? () => handleRejectFile(item)
                                        : null
                                }
                                onRejectHunk={
                                    item.canResolveHunks
                                        ? (hunkId) =>
                                              handleRejectHunk(item, hunkId)
                                        : null
                                }
                                onToggle={() => toggleExpandedFile(item.key)}
                            />
                        ))}
                    </div>
                )
            ) : null}
        </div>
    );
}
