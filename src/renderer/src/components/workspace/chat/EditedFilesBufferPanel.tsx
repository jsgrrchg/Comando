import { useMemo, useState } from "react";

import { ReviewFileRow } from "../review/ReviewFileRow";
import type {
    ReviewFileItem,
    ReviewSummary,
} from "../review/editedFilesPresentationModel";
import { formatDiffStat } from "../review/reviewDiff";
import {
    getAccentButtonStyle,
    getDangerButtonStyle,
    getNeutralButtonStyle,
} from "../review/reviewStyles";

const COMPACT_MAX_LIST_HEIGHT = "208px";

function CollapseToggle({
    expanded,
    onToggle,
}: {
    readonly expanded: boolean;
    readonly onToggle: () => void;
}) {
    return (
        <button
            aria-expanded={expanded}
            aria-label={expanded ? "Collapse edits" : "Expand edits"}
            className="shrink-0"
            onClick={onToggle}
            style={{
                alignItems: "center",
                background: "transparent",
                border: "none",
                color: "var(--color-text-secondary)",
                cursor: "pointer",
                display: "inline-flex",
                fontSize: 12,
                height: 16,
                justifyContent: "center",
                lineHeight: 1,
                padding: 0,
                transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
                transition: "transform 140ms ease, color 140ms ease",
                width: 16,
            }}
            title={expanded ? "Collapse edits" : "Expand edits"}
            type="button"
        >
            <span aria-hidden="true">&gt;</span>
        </button>
    );
}

function RejectIcon() {
    return (
        <svg
            fill="none"
            height="14"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            viewBox="0 0 24 24"
            width="14"
        >
            <line x1="18" x2="6" y1="6" y2="18" />
            <line x1="6" x2="18" y1="6" y2="18" />
        </svg>
    );
}

function KeepIcon() {
    return (
        <svg
            fill="none"
            height="14"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2.2"
            viewBox="0 0 24 24"
            width="14"
        >
            <polyline points="20 6 9 17 4 12" />
        </svg>
    );
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
            className="overflow-hidden rounded-xl"
            data-testid="edited-files-buffer-panel"
            style={{
                backgroundColor:
                    "color-mix(in srgb, var(--color-bg-tertiary) 84%, transparent)",
                border: "1px solid color-mix(in srgb, var(--color-border) 88%, transparent)",
            }}
        >
            <div
                className="flex items-center gap-1.5 px-2 py-1.5"
                style={{
                    borderBottom: !collapsed
                        ? "1px solid color-mix(in srgb, var(--color-border) 80%, transparent)"
                        : "none",
                }}
            >
                <CollapseToggle
                    expanded={!collapsed}
                    onToggle={() => setCollapsed((value) => !value)}
                />
                <span
                    className="text-xs font-medium"
                    style={{ color: "var(--color-text-secondary)" }}
                >
                    Edits
                </span>
                <span
                    style={{
                        color: "var(--color-text-secondary)",
                        fontSize: "0.72em",
                    }}
                >
                    ({summary.fileCount})
                </span>
                {(summary.additions > 0 || summary.deletions > 0) && (
                    <span
                        style={{
                            color: "var(--color-text-secondary)",
                            fontSize: "0.72em",
                        }}
                    >
                        ·
                        {summary.additions > 0 ? (
                            <span
                                style={{
                                    color: "var(--diff-add)",
                                    marginLeft: 3,
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
                                    marginLeft: 3,
                                }}
                            >
                                -
                                {formatDiffStat(
                                    summary.deletions,
                                    summary.approximate,
                                )}
                            </span>
                        ) : null}
                    </span>
                )}

                <div className="ml-auto flex items-center gap-1">
                    <button
                        className="rounded-md px-2 py-0.5"
                        onClick={onOpenReview}
                        style={{
                            ...getNeutralButtonStyle(),
                            fontSize: "11px",
                            fontWeight: 500,
                            lineHeight: "16px",
                        }}
                        title="Review"
                        type="button"
                    >
                        Review
                    </button>
                    <button
                        aria-label="Reject All"
                        className="rounded-md p-1"
                        disabled={rejectableCount === 0}
                        onClick={onRejectAll}
                        style={getDangerButtonStyle(rejectableCount === 0)}
                        title="Reject All"
                        type="button"
                    >
                        <RejectIcon />
                    </button>
                    <button
                        aria-label="Keep All"
                        className="rounded-md p-1"
                        onClick={onKeepAll}
                        style={getAccentButtonStyle()}
                        title="Keep All"
                        type="button"
                    >
                        <KeepIcon />
                    </button>
                </div>
            </div>

            {!collapsed ? (
                <div
                    className="flex flex-col"
                    data-testid="edited-files-buffer-list"
                    data-scrollbar-active="true"
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
