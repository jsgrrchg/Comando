import { memo } from "react";

import type { ReviewFileItem } from "./editedFilesPresentationModel";
import { EditedFileDiffPreview } from "./EditedFileDiffPreview";
import { FileTypeIcon } from "@renderer/components/icons/FileTypeIcon";
import {
    formatDiffStat,
    getCompactPath,
    getFileNameFromPath,
    shouldWrapDiffPreview,
} from "./reviewDiff";

export const COMPACT_REVIEW_ROW_HEIGHT_PX = 28;

export function ReviewOpenIcon({ size = 13 }: { readonly size?: number }) {
    return (
        <svg
            aria-hidden="true"
            fill="none"
            height={size}
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            viewBox="0 0 24 24"
            width={size}
        >
            <path d="M14 3h7v7" />
            <path d="M10 14 21 3" />
            <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
        </svg>
    );
}

export function ReviewRejectIcon({ size = 14 }: { readonly size?: number }) {
    return (
        <svg
            aria-hidden="true"
            fill="none"
            height={size}
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2.6"
            viewBox="0 0 24 24"
            width={size}
        >
            <line x1="18" x2="6" y1="6" y2="18" />
            <line x1="6" x2="18" y1="6" y2="18" />
        </svg>
    );
}

export function ReviewKeepIcon({ size = 14 }: { readonly size?: number }) {
    return (
        <svg
            aria-hidden="true"
            fill="none"
            height={size}
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2.6"
            viewBox="0 0 24 24"
            width={size}
        >
            <polyline points="20 6 9 17 4 12" />
        </svg>
    );
}

function getReviewBadgeLabel(item: ReviewFileItem): string {
    if (item.tone.badge) {
        return item.tone.badge;
    }

    if (item.file.kind === "create") {
        return "New";
    }

    if (item.file.kind === "delete") {
        return "Deleted";
    }

    if (item.file.kind === "move") {
        return "Moved";
    }

    return "Modified";
}

export function DiffStatBar({
    additions,
    deletions,
}: {
    readonly additions: number;
    readonly deletions: number;
}) {
    const total = additions + deletions;
    if (total === 0) {
        return null;
    }

    const BLOCKS = 5;
    let addCount = Math.round((additions / total) * BLOCKS);
    if (additions > 0 && addCount === 0) {
        addCount = 1;
    }
    if (deletions > 0 && addCount === BLOCKS) {
        addCount = BLOCKS - 1;
    }

    const blocks: string[] = [];
    for (let i = 0; i < addCount; i += 1) {
        blocks.push("var(--diff-add)");
    }
    for (let i = 0; i < BLOCKS - addCount; i += 1) {
        blocks.push(
            deletions > 0
                ? "var(--diff-remove)"
                : "color-mix(in srgb, var(--color-text-secondary) 20%, transparent)",
        );
    }

    return (
        <span style={{ alignItems: "center", display: "inline-flex", gap: 1 }}>
            {blocks.map((color, i) => (
                <span
                    key={i}
                    style={{
                        backgroundColor: color,
                        borderRadius: 1,
                        display: "inline-block",
                        height: 6,
                        width: 6,
                    }}
                />
            ))}
        </span>
    );
}

export interface ReviewFileRowProps {
    readonly diffZoom: number;
    readonly expanded: boolean;
    readonly item: ReviewFileItem;
    readonly lineWrapping?: boolean;
    readonly onKeep: () => void;
    readonly onKeepHunk?: (hunkId: string) => void;
    readonly onOpen?: () => void;
    readonly onReject: () => void;
    readonly onRejectHunk?: (hunkId: string) => void;
    readonly onToggle: () => void;
    readonly variant: "compact" | "full";
}

export const ReviewFileRow = memo(function ReviewFileRow({
    diffZoom,
    expanded,
    item,
    lineWrapping,
    onKeep,
    onKeepHunk,
    onOpen,
    onReject,
    onRejectHunk,
    onToggle,
    variant,
}: ReviewFileRowProps) {
    const badgeLabel = getReviewBadgeLabel(item);
    const canShowOpen = item.canOpen && onOpen;
    const compactPath = getCompactPath(item.file.path);
    const resolvedLineWrapping =
        lineWrapping ?? shouldWrapDiffPreview(item.file.path);

    if (variant === "compact") {
        return (
            <div
                className="select-none"
                data-review-file-key={item.file.identityKey}
                data-review-file-updated-at={item.file.updatedAt}
                style={{
                    borderTop:
                        "1px solid color-mix(in srgb, var(--color-border) 50%, transparent)",
                    boxSizing: "border-box",
                    fontFamily: "var(--font-mono)",
                    minHeight: COMPACT_REVIEW_ROW_HEIGHT_PX,
                    overflow: "hidden",
                }}
            >
                <div className="flex items-center gap-2 px-2.5 py-1">
                    <FileTypeIcon
                        fileName={item.file.path}
                        opacity={0.7}
                        size={12}
                    />
                    <span
                        className="min-w-0 flex-1 truncate"
                        style={{
                            color: "var(--color-text-primary)",
                            fontSize: "0.8em",
                            fontWeight: 400,
                        }}
                    >
                        {getFileNameFromPath(item.file.path)}
                        {item.tone.badge ? (
                            <span
                                style={{
                                    color: item.tone.accent,
                                    fontSize: "0.85em",
                                    fontWeight: 600,
                                    marginLeft: 6,
                                    opacity: 0.8,
                                }}
                            >
                                [{item.tone.badge.toLowerCase()}]
                            </span>
                        ) : null}
                    </span>
                    <div
                        className="flex shrink-0 items-center gap-1.5"
                        style={{ fontSize: "0.72em" }}
                    >
                        {item.stats.additions > 0 ? (
                            <span
                                style={{
                                    color: "var(--diff-add)",
                                    fontWeight: 600,
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
                                    fontWeight: 600,
                                }}
                            >
                                -
                                {formatDiffStat(
                                    item.stats.deletions,
                                    item.stats.approximate,
                                )}
                            </span>
                        ) : null}
                    </div>
                    <DiffStatBar
                        additions={item.stats.additions}
                        deletions={item.stats.deletions}
                    />
                    <div className="flex shrink-0 items-center gap-0.5">
                        <button
                            aria-label="Open File"
                            className="review-icon-btn shrink-0"
                            disabled={!canShowOpen}
                            onClick={canShowOpen ? onOpen : undefined}
                            title="Open File"
                            type="button"
                        >
                            <ReviewOpenIcon size={13} />
                        </button>
                        <button
                            aria-label="Reject"
                            className="review-icon-btn review-icon-btn--reject shrink-0"
                            disabled={!item.canReject}
                            onClick={onReject}
                            title="Reject"
                            type="button"
                        >
                            <ReviewRejectIcon size={14} />
                        </button>
                        <button
                            aria-label="Keep"
                            className="review-icon-btn review-icon-btn--keep shrink-0"
                            onClick={onKeep}
                            title="Keep"
                            type="button"
                        >
                            <ReviewKeepIcon size={14} />
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div
            className="select-none overflow-hidden rounded-md"
            data-review-file-key={item.file.identityKey}
            data-review-file-updated-at={item.file.updatedAt}
            style={{
                backgroundColor: "var(--color-bg-elevated)",
                border: "1px solid color-mix(in srgb, var(--color-border) 60%, transparent)",
                fontFamily: "var(--font-mono)",
            }}
        >
            <div
                className="flex w-full items-center gap-3 px-4 py-2.5"
                style={{
                    borderBottom: expanded
                        ? "1px solid color-mix(in srgb, var(--color-border) 40%, transparent)"
                        : "none",
                }}
            >
                <button
                    aria-label={`${expanded ? "Collapse" : "Expand"} ${item.file.path}`}
                    onClick={onToggle}
                    style={{
                        alignItems: "center",
                        backgroundColor:
                            "color-mix(in srgb, var(--color-bg-tertiary) 70%, transparent)",
                        border: "none",
                        borderRadius: 3,
                        color: "var(--color-text-secondary)",
                        cursor: "pointer",
                        display: "inline-flex",
                        flexShrink: 0,
                        fontSize: "0.68em",
                        height: 20,
                        justifyContent: "center",
                        transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
                        transition: "transform 140ms ease",
                        width: 20,
                    }}
                    type="button"
                >
                    ▸
                </button>
                <FileTypeIcon
                    fileName={item.file.path}
                    opacity={0.75}
                    size={14}
                />
                <button
                    className="min-w-0 flex-1 text-left"
                    onClick={onToggle}
                    onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor =
                            "color-mix(in srgb, var(--color-bg-tertiary) 50%, transparent)";
                    }}
                    onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = "transparent";
                    }}
                    style={{
                        background: "none",
                        border: "none",
                        borderRadius: 4,
                        cursor: "pointer",
                        transition: "background-color 100ms ease",
                    }}
                    type="button"
                >
                    <div className="flex items-center gap-2">
                        <span
                            className="truncate"
                            style={{
                                color: "var(--color-text-primary)",
                                fontSize: "0.86em",
                                fontWeight: 600,
                            }}
                        >
                            {getFileNameFromPath(item.file.path)}
                        </span>
                        {item.tone.badge ? (
                            <span
                                style={{
                                    color: item.tone.accent,
                                    fontSize: "0.7em",
                                    fontWeight: 600,
                                    opacity: 0.8,
                                }}
                            >
                                [{badgeLabel.toLowerCase()}]
                            </span>
                        ) : null}
                    </div>
                    <div
                        className="truncate"
                        style={{
                            color: "var(--color-text-secondary)",
                            fontSize: "0.74em",
                            marginTop: 1,
                        }}
                    >
                        {compactPath} · {item.summary}
                    </div>
                </button>
                <div
                    className="flex shrink-0 items-center gap-1.5"
                    style={{ fontSize: "0.76em" }}
                >
                    {item.stats.additions > 0 ? (
                        <span
                            style={{
                                color: "var(--diff-add)",
                                fontWeight: 600,
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
                                fontWeight: 600,
                            }}
                        >
                            -
                            {formatDiffStat(
                                item.stats.deletions,
                                item.stats.approximate,
                            )}
                        </span>
                    ) : null}
                </div>
                <DiffStatBar
                    additions={item.stats.additions}
                    deletions={item.stats.deletions}
                />
                <div className="flex shrink-0 items-center gap-1.5">
                    <button
                        className="review-action-btn review-text-btn shrink-0"
                        disabled={!canShowOpen}
                        onClick={canShowOpen ? onOpen : undefined}
                        onMouseEnter={(e) => {
                            if (canShowOpen) {
                                e.currentTarget.style.backgroundColor =
                                    "color-mix(in srgb, var(--color-bg-tertiary) 60%, transparent)";
                            }
                        }}
                        onMouseLeave={(e) => {
                            if (canShowOpen) {
                                e.currentTarget.style.backgroundColor =
                                    "transparent";
                            }
                        }}
                        style={{
                            background: "transparent",
                            border: "1px solid color-mix(in srgb, var(--color-border) 60%, transparent)",
                            borderRadius: 3,
                            color: "var(--color-text-secondary)",
                            cursor: canShowOpen ? "pointer" : "not-allowed",
                            fontSize: "0.68em",
                            fontWeight: 500,
                            lineHeight: "20px",
                            opacity: canShowOpen ? 1 : 0.35,
                            padding: "0 6px",
                            transition:
                                "background-color 100ms ease, filter 100ms ease",
                        }}
                        type="button"
                    >
                        open
                    </button>
                    {item.canReject ? (
                        <button
                            className="review-action-btn review-text-btn shrink-0"
                            onClick={onReject}
                            onMouseEnter={(e) => {
                                e.currentTarget.style.opacity = "1";
                            }}
                            onMouseLeave={(e) => {
                                e.currentTarget.style.opacity = "0.6";
                            }}
                            style={{
                                background: "transparent",
                                border: "none",
                                color: "var(--diff-remove)",
                                cursor: "pointer",
                                fontSize: "0.72em",
                                fontWeight: 600,
                                opacity: 0.6,
                                padding: "2px 4px",
                                transition:
                                    "opacity 100ms ease, filter 100ms ease",
                            }}
                            type="button"
                        >
                            reject
                        </button>
                    ) : null}
                    <button
                        className="review-action-btn review-text-btn shrink-0"
                        onClick={onKeep}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.opacity = "1";
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.opacity = "0.6";
                        }}
                        style={{
                            background: "transparent",
                            border: "none",
                            color: "var(--diff-add)",
                            cursor: "pointer",
                            fontSize: "0.72em",
                            fontWeight: 600,
                            opacity: 0.6,
                            padding: "2px 4px",
                            transition: "opacity 100ms ease, filter 100ms ease",
                        }}
                        type="button"
                    >
                        accept
                    </button>
                </div>
            </div>

            <EditedFileDiffPreview
                compactLineNumbers
                diff={item.diff}
                diffZoom={diffZoom}
                expanded={expanded}
                file={item.file}
                lineWrapping={resolvedLineWrapping}
                onKeepHunk={item.canResolveHunks ? onKeepHunk : undefined}
                onRejectHunk={item.canResolveHunks ? onRejectHunk : undefined}
                testId={`review-file-diff:${item.file.identityKey}`}
            />
        </div>
    );
});

ReviewFileRow.displayName = "ReviewFileRow";
