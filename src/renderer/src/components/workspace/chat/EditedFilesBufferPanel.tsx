import { useMemo, useState } from "react";

import { DiffStatBar, ReviewFileRow } from "../review/ReviewFileRow";
import type {
    ReviewFileItem,
    ReviewSummary,
} from "../review/editedFilesPresentationModel";
import { formatDiffStat } from "../review/reviewDiff";

const COMPACT_MAX_LIST_HEIGHT = "208px";

function toggleKey(
    current: ReadonlySet<string>,
    key: string,
): ReadonlySet<string> {
    const next = new Set(current);
    if (next.has(key)) {
        next.delete(key);
    } else {
        next.add(key);
    }

    return next;
}

export interface EditedFilesBufferPanelProps {
    readonly defaultCollapsed?: boolean;
    readonly diffZoom: number;
    readonly items: readonly ReviewFileItem[];
    readonly lineWrapping?: boolean;
    readonly onKeepAll: () => void;
    readonly onKeepHunk?: (item: ReviewFileItem, hunkId: string) => void;
    readonly onKeepItem: (item: ReviewFileItem) => void;
    readonly onOpenItem?: (item: ReviewFileItem) => void;
    readonly onOpenReview: () => void;
    readonly onRejectAll: () => void;
    readonly onRejectHunk?: (item: ReviewFileItem, hunkId: string) => void;
    readonly onRejectItem: (item: ReviewFileItem) => void;
    readonly summary: ReviewSummary;
}

export function EditedFilesBufferPanel({
    defaultCollapsed = false,
    diffZoom,
    items,
    lineWrapping = true,
    onKeepAll,
    onKeepHunk,
    onKeepItem,
    onOpenItem,
    onOpenReview,
    onRejectAll,
    onRejectHunk,
    onRejectItem,
    summary,
}: EditedFilesBufferPanelProps) {
    const [collapsed, setCollapsed] = useState(defaultCollapsed);
    const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(
        () => new Set<string>(),
    );

    const rejectableCount = useMemo(
        () => items.filter((item) => item.canReject).length,
        [items],
    );

    if (items.length === 0) {
        return null;
    }

    return (
        <section
            className="overflow-hidden rounded-md"
            data-testid="edited-files-buffer-panel"
            style={{
                border: "1px solid color-mix(in srgb, var(--color-border) 60%, transparent)",
                fontFamily: "var(--font-mono)",
            }}
        >
            <div
                className="flex items-center gap-1.5 px-2.5 py-1.5"
                style={{
                    borderBottom: !collapsed
                        ? "1px solid color-mix(in srgb, var(--color-border) 50%, transparent)"
                        : "none",
                }}
            >
                <button
                    aria-expanded={!collapsed}
                    aria-label={collapsed ? "Expand edits" : "Collapse edits"}
                    className="shrink-0"
                    onClick={() => setCollapsed((v) => !v)}
                    style={{
                        alignItems: "center",
                        background: "transparent",
                        border: "none",
                        color: "var(--color-text-secondary)",
                        cursor: "pointer",
                        display: "inline-flex",
                        fontSize: "10px",
                        height: 16,
                        justifyContent: "center",
                        lineHeight: 1,
                        padding: 0,
                        transform: collapsed ? "rotate(0deg)" : "rotate(90deg)",
                        transition: "transform 140ms ease",
                        width: 16,
                    }}
                    title={collapsed ? "Expand edits" : "Collapse edits"}
                    type="button"
                >
                    ▸
                </button>
                <span
                    style={{
                        color: "var(--color-text-secondary)",
                        fontSize: "10px",
                        fontWeight: 800,
                        letterSpacing: "0.06em",
                        textTransform: "uppercase",
                    }}
                >
                    staged
                </span>
                <span
                    style={{
                        color: "var(--color-text-secondary)",
                        fontSize: "10px",
                    }}
                >
                    ({summary.fileCount})
                </span>
                {(summary.additions > 0 || summary.deletions > 0) && (
                    <>
                        <span
                            style={{
                                color: "var(--color-text-secondary)",
                                fontSize: "10px",
                                opacity: 0.4,
                            }}
                        >
                            ·
                        </span>
                        {summary.additions > 0 ? (
                            <span
                                style={{
                                    color: "var(--diff-add)",
                                    fontSize: "10px",
                                    fontWeight: 600,
                                }}
                            >
                                +
                                {formatDiffStat(
                                    summary.additions,
                                    summary.approximate,
                                )}
                            </span>
                        ) : null}
                        {summary.deletions > 0 ? (
                            <span
                                style={{
                                    color: "var(--diff-remove)",
                                    fontSize: "10px",
                                    fontWeight: 600,
                                }}
                            >
                                −
                                {formatDiffStat(
                                    summary.deletions,
                                    summary.approximate,
                                )}
                            </span>
                        ) : null}
                        <DiffStatBar
                            additions={summary.additions}
                            deletions={summary.deletions}
                        />
                    </>
                )}

                <div className="ml-auto flex items-center gap-1.5">
                    <button
                        className="review-action-btn"
                        onClick={onOpenReview}
                        style={{
                            background: "transparent",
                            border: "1px solid color-mix(in srgb, var(--color-border) 60%, transparent)",
                            borderRadius: 3,
                            color: "var(--color-text-secondary)",
                            cursor: "pointer",
                            fontSize: "10px",
                            fontWeight: 500,
                            lineHeight: "18px",
                            padding: "0 6px",
                        }}
                        title="Review"
                        type="button"
                    >
                        review
                    </button>
                    <button
                        aria-label="Reject All"
                        className="review-action-btn"
                        disabled={rejectableCount === 0}
                        onClick={onRejectAll}
                        style={{
                            background: "transparent",
                            border: "none",
                            color: "var(--diff-remove)",
                            cursor:
                                rejectableCount === 0
                                    ? "not-allowed"
                                    : "pointer",
                            fontSize: "13px",
                            fontWeight: 600,
                            opacity: rejectableCount === 0 ? 0.25 : 0.6,
                            padding: "2px 3px",
                        }}
                        title="Reject All"
                        type="button"
                    >
                        ✕
                    </button>
                    <button
                        aria-label="Keep All"
                        className="review-action-btn"
                        onClick={onKeepAll}
                        style={{
                            background: "transparent",
                            border: "none",
                            color: "var(--diff-add)",
                            cursor: "pointer",
                            fontSize: "13px",
                            fontWeight: 600,
                            opacity: 0.6,
                            padding: "2px 3px",
                        }}
                        title="Keep All"
                        type="button"
                    >
                        ✓
                    </button>
                </div>
            </div>

            {!collapsed ? (
                <div
                    className="flex flex-col"
                    data-scrollbar-active="true"
                    data-testid="edited-files-buffer-list"
                    style={{
                        maxHeight: COMPACT_MAX_LIST_HEIGHT,
                        overflowY: "auto",
                    }}
                >
                    {items.map((item) => (
                        <ReviewFileRow
                            diffZoom={diffZoom}
                            expanded={expandedKeys.has(item.file.identityKey)}
                            item={item}
                            key={item.file.identityKey}
                            lineWrapping={lineWrapping}
                            onKeep={() => onKeepItem(item)}
                            onKeepHunk={
                                item.canResolveHunks && onKeepHunk
                                    ? (hunkId) => onKeepHunk(item, hunkId)
                                    : undefined
                            }
                            onOpen={
                                item.canOpen && onOpenItem
                                    ? () => onOpenItem(item)
                                    : undefined
                            }
                            onReject={() => onRejectItem(item)}
                            onRejectHunk={
                                item.canResolveHunks && onRejectHunk
                                    ? (hunkId) => onRejectHunk(item, hunkId)
                                    : undefined
                            }
                            onToggle={() =>
                                setExpandedKeys((current) =>
                                    toggleKey(current, item.file.identityKey),
                                )
                            }
                            variant="compact"
                        />
                    ))}
                </div>
            ) : null}
        </section>
    );
}
