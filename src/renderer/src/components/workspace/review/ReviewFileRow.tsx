import type { CSSProperties } from "react";

import type { ReviewFileItem } from "./editedFilesPresentationModel";
import { EditedFileDiffPreview } from "./EditedFileDiffPreview";
import {
    formatDiffStat,
    getCompactPath,
    getFileNameFromPath,
} from "./reviewDiff";
import {
    getAccentButtonStyle,
    getDangerButtonStyle,
    getNeutralButtonStyle,
    getToneBorderStyle,
} from "./reviewStyles";

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

const ACTION_BUTTON_STYLE: CSSProperties = {
    borderRadius: 8,
    fontSize: "0.74em",
    fontWeight: 600,
    minHeight: 28,
    padding: "0 10px",
};

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

export function ReviewFileRow({
    diffZoom,
    expanded,
    item,
    lineWrapping = true,
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

    if (variant === "compact") {
        return (
            <div
                data-review-file-key={item.file.identityKey}
                data-review-file-updated-at={item.file.updatedAt}
                style={{
                    overflow: "hidden",
                    borderTop:
                        "1px solid color-mix(in srgb, var(--color-border) 72%, transparent)",
                }}
            >
                <div className="flex items-center gap-2.5 px-2.5 py-1.5">
                    <div
                        aria-hidden="true"
                        className="h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: item.tone.accent }}
                    />
                    <span
                        className="min-w-0 flex-1 truncate"
                        style={{
                            color: "var(--color-text-primary)",
                            fontSize: "0.84em",
                            fontWeight: 600,
                        }}
                    >
                        {getFileNameFromPath(item.file.path)}
                        {item.tone.badge ? (
                            <span
                                className="ml-1.5 rounded-full px-1.5 py-0.5"
                                style={{
                                    backgroundColor: `color-mix(in srgb, ${item.tone.accent} 12%, transparent)`,
                                    color: item.tone.accent,
                                    fontSize: "0.8em",
                                    fontWeight: 700,
                                    letterSpacing: "0.04em",
                                    textTransform: "uppercase",
                                }}
                            >
                                {badgeLabel}
                            </span>
                        ) : null}
                    </span>
                    <div
                        className="flex shrink-0 items-center gap-1 text-right"
                        style={{
                            fontSize: "0.76em",
                        }}
                    >
                        {item.stats.additions > 0 ? (
                            <div
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
                            </div>
                        ) : null}
                        {item.stats.deletions > 0 ? (
                            <div
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
                            </div>
                        ) : null}
                    </div>
                    {canShowOpen ? (
                        <button
                            aria-label="Open File"
                            onClick={onOpen}
                            className="review-action-btn shrink-0 rounded-md p-1"
                            style={getAccentButtonStyle(item.tone.accent)}
                            title="Open File"
                            type="button"
                        >
                            <svg
                                fill="none"
                                height="12"
                                stroke="currentColor"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth="2"
                                viewBox="0 0 24 24"
                                width="12"
                            >
                                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                                <polyline points="15 3 21 3 21 9" />
                                <line x1="10" x2="21" y1="14" y2="3" />
                            </svg>
                        </button>
                    ) : null}
                    <div className="flex shrink-0 items-center gap-1">
                        <button
                            aria-label="Reject"
                            className="review-action-btn shrink-0 rounded-md p-1"
                            disabled={!item.canReject}
                            onClick={onReject}
                            style={{
                                ...getDangerButtonStyle(!item.canReject),
                            }}
                            title="Reject"
                            type="button"
                        >
                            <svg
                                fill="none"
                                height="12"
                                stroke="currentColor"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth="2.2"
                                viewBox="0 0 24 24"
                                width="12"
                            >
                                <line x1="18" x2="6" y1="6" y2="18" />
                                <line x1="6" x2="18" y1="6" y2="18" />
                            </svg>
                        </button>
                        <button
                            aria-label="Keep"
                            className="review-action-btn shrink-0 rounded-md p-1"
                            onClick={onKeep}
                            style={{
                                ...getAccentButtonStyle(),
                            }}
                            title="Keep"
                            type="button"
                        >
                            <svg
                                fill="none"
                                height="12"
                                stroke="currentColor"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth="2.2"
                                viewBox="0 0 24 24"
                                width="12"
                            >
                                <polyline points="20 6 9 17 4 12" />
                            </svg>
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div
            data-review-file-key={item.file.identityKey}
            data-review-file-updated-at={item.file.updatedAt}
            style={{
                ...getToneBorderStyle(item.tone.accent),
                backgroundColor: "var(--color-bg-elevated)",
                border: "1px solid color-mix(in srgb, var(--color-border) 60%, transparent)",
                borderRadius: 16,
                overflow: "hidden",
            }}
        >
            <div
                style={{
                    alignItems: "center",
                    borderBottom: expanded
                        ? "1px solid color-mix(in srgb, var(--color-border) 40%, transparent)"
                        : "none",
                    display: "grid",
                    gap: 12,
                    gridTemplateColumns: "auto auto minmax(0, 1fr) auto auto",
                    padding: "14px 16px",
                }}
            >
                <button
                    aria-label={`${expanded ? "Collapse" : "Expand"} ${item.file.path}`}
                    onClick={onToggle}
                    style={{
                        alignItems: "center",
                        backgroundColor:
                            "color-mix(in srgb, var(--color-bg-secondary) 68%, transparent)",
                        border: "none",
                        borderRadius: 7,
                        color: "var(--color-text-secondary)",
                        cursor: "pointer",
                        display: "inline-flex",
                        fontSize: "0.72em",
                        height: 22,
                        justifyContent: "center",
                        transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
                        transition: "transform 140ms ease",
                        width: 22,
                    }}
                    type="button"
                >
                    ▸
                </button>
                <span
                    aria-hidden="true"
                    style={{
                        backgroundColor: item.tone.accent,
                        borderRadius: 999,
                        height: 6,
                        width: 6,
                    }}
                />
                <button
                    className="min-w-0 text-left"
                    onClick={onToggle}
                    style={{
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        minWidth: 0,
                        padding: 0,
                    }}
                    type="button"
                >
                    <div className="flex items-center gap-2">
                        <span
                            className="truncate"
                            style={{
                                color: "var(--color-text-primary)",
                                fontSize: "0.9em",
                                fontWeight: 650,
                            }}
                        >
                            {getFileNameFromPath(item.file.path)}
                        </span>
                        <span
                            style={{
                                backgroundColor: `color-mix(in srgb, ${item.tone.accent} 10%, transparent)`,
                                borderRadius: 999,
                                color: item.tone.accent,
                                fontSize: "0.64em",
                                fontWeight: 700,
                                letterSpacing: "0.04em",
                                padding: "2px 7px",
                                textTransform: "uppercase",
                            }}
                        >
                            {badgeLabel}
                        </span>
                    </div>
                    <div
                        className="truncate"
                        style={{
                            color: "var(--color-text-secondary)",
                            fontSize: "0.76em",
                            marginTop: 2,
                        }}
                    >
                        {compactPath} · {item.summary}
                    </div>
                </button>
                <div
                    style={{
                        display: "flex",
                        flexShrink: 0,
                        gap: 10,
                        justifyContent: "flex-end",
                        minWidth: 76,
                    }}
                >
                    {item.stats.additions > 0 ? (
                        <span
                            style={{
                                color: "var(--diff-add)",
                                fontSize: "0.78em",
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
                                fontSize: "0.78em",
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
                <div
                    style={{
                        display: "flex",
                        flexShrink: 0,
                        gap: 6,
                        justifyContent: "flex-end",
                    }}
                >
                    {canShowOpen ? (
                        <button
                            className="review-action-btn"
                            onClick={onOpen}
                            style={{
                                ...ACTION_BUTTON_STYLE,
                                ...getNeutralButtonStyle(),
                            }}
                            type="button"
                        >
                            Open
                        </button>
                    ) : null}
                    <button
                        className="review-action-btn"
                        disabled={!item.canReject}
                        onClick={onReject}
                        style={{
                            ...ACTION_BUTTON_STYLE,
                            ...getDangerButtonStyle(!item.canReject),
                        }}
                        type="button"
                    >
                        Reject
                    </button>
                    <button
                        className="review-action-btn"
                        onClick={onKeep}
                        style={{
                            ...ACTION_BUTTON_STYLE,
                            ...getAccentButtonStyle(item.tone.accent),
                        }}
                        type="button"
                    >
                        Accept
                    </button>
                </div>
            </div>

            <EditedFileDiffPreview
                compactLineNumbers
                diff={item.diff}
                diffZoom={diffZoom}
                expanded={expanded}
                file={item.file}
                lineWrapping={lineWrapping}
                onKeepHunk={item.canResolveHunks ? onKeepHunk : undefined}
                onRejectHunk={item.canResolveHunks ? onRejectHunk : undefined}
                testId={`review-file-diff:${item.file.identityKey}`}
            />
        </div>
    );
}
