import { memo, useMemo, useState } from "react";

import { FIXED_PENDING_REVIEW_CARD_TEXT_ZOOM } from "@renderer/app/ai/sessionReviewContracts";

import {
    COMPACT_REVIEW_ROW_HEIGHT_PX,
    DiffStatBar,
    ReviewFileRow,
    ReviewKeepIcon,
    ReviewRejectIcon,
} from "../review/ReviewFileRow";
import type {
    ReviewFileItem,
    ReviewSummary,
} from "../review/editedFilesPresentationModel";
import { isReviewConflictFile } from "../review/editedFilesPresentationModel";
import { formatDiffStat } from "../review/reviewDiff";

const COMPACT_MAX_VISIBLE_ROWS = 8;
const COMPACT_SCROLL_MAX_HEIGHT = `${COMPACT_MAX_VISIBLE_ROWS * COMPACT_REVIEW_ROW_HEIGHT_PX}px`;
const BASE_TEXT_SIZE_PX = 16;

function toEm(value: number): string {
    return `${value / BASE_TEXT_SIZE_PX}em`;
}

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

export const EditedFilesBufferPanel = memo(function EditedFilesBufferPanel({
    defaultCollapsed = false,
    diffZoom,
    items,
    lineWrapping,
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
    const keepableCount = useMemo(
        () => items.filter((item) => !isReviewConflictFile(item.file)).length,
        [items],
    );

    const shouldCapHeight = items.length > COMPACT_MAX_VISIBLE_ROWS;

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
                fontSize: `${FIXED_PENDING_REVIEW_CARD_TEXT_ZOOM}em`,
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
                        fontSize: toEm(10),
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
                        fontFamily: "var(--font-sans)",
                        fontSize: toEm(10),
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
                        fontSize: toEm(10),
                    }}
                >
                    ({summary.fileCount})
                </span>
                {(summary.additions > 0 || summary.deletions > 0) && (
                    <>
                        <span
                            style={{
                                color: "var(--color-text-secondary)",
                                fontSize: toEm(10),
                                opacity: 0.4,
                            }}
                        >
                            ·
                        </span>
                        {summary.additions > 0 ? (
                            <span
                                style={{
                                    color: "var(--diff-add)",
                                    fontSize: toEm(10),
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
                                    fontSize: toEm(10),
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

                <div className="ml-auto flex items-center gap-1">
                    <button
                        className="review-action-btn review-text-btn"
                        onClick={onOpenReview}
                        style={{
                            background: "transparent",
                            border: "1px solid color-mix(in srgb, var(--color-border) 60%, transparent)",
                            borderRadius: 4,
                            color: "var(--color-text-secondary)",
                            cursor: "pointer",
                            fontSize: toEm(10),
                            fontWeight: 500,
                            lineHeight: "22px",
                            marginRight: 2,
                            padding: "0 8px",
                        }}
                        title="Review"
                        type="button"
                    >
                        review
                    </button>
                    <button
                        aria-label="Reject All"
                        className="review-icon-btn review-icon-btn--reject"
                        disabled={rejectableCount === 0}
                        onClick={onRejectAll}
                        title="Reject All"
                        type="button"
                    >
                        <ReviewRejectIcon size={14} />
                    </button>
                    <button
                        aria-label="Keep All"
                        className="review-icon-btn review-icon-btn--keep"
                        disabled={keepableCount === 0}
                        onClick={keepableCount > 0 ? onKeepAll : undefined}
                        title="Keep All"
                        type="button"
                    >
                        <ReviewKeepIcon size={14} />
                    </button>
                </div>
            </div>

            {!collapsed ? (
                <div
                    className={[
                        "flex flex-col",
                        shouldCapHeight
                            ? "shell-scrollbar min-h-0 overflow-y-auto overflow-x-hidden"
                            : "",
                    ]
                        .filter(Boolean)
                        .join(" ")}
                    data-scrollbar-active="true"
                    data-testid="edited-files-buffer-list"
                    style={{
                        maxHeight: shouldCapHeight
                            ? COMPACT_SCROLL_MAX_HEIGHT
                            : undefined,
                        overflowY: shouldCapHeight ? "auto" : "visible",
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
});

EditedFilesBufferPanel.displayName = "EditedFilesBufferPanel";
