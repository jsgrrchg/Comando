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

function OpenFileIcon() {
    return (
        <svg
            fill="none"
            height="13"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.9"
            viewBox="0 0 24 24"
            width="13"
        >
            <path d="M14 5h5v5" />
            <path d="M10 14 19 5" />
            <path d="M19 14v4a1 1 0 0 1-1 1h-12a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h4" />
        </svg>
    );
}

function RejectIcon() {
    return (
        <svg
            fill="none"
            height="13"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.9"
            viewBox="0 0 24 24"
            width="13"
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
            height="13"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2.2"
            viewBox="0 0 24 24"
            width="13"
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

const ACTION_BUTTON_STYLE: CSSProperties = {
    borderRadius: 8,
    fontSize: "0.74em",
    fontWeight: 600,
    minHeight: 28,
    padding: "0 10px",
};

const COMPACT_ICON_BUTTON_STYLE: CSSProperties = {
    alignItems: "center",
    borderRadius: 8,
    display: "inline-flex",
    height: 26,
    justifyContent: "center",
    minWidth: 26,
    padding: 0,
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
    const compactPath = getCompactPath(item.file.path);
    const canShowOpen = item.canOpen && onOpen;

    if (variant === "compact") {
        return (
            <div
                data-review-file-key={item.file.identityKey}
                data-review-file-updated-at={item.file.updatedAt}
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
                        display: "grid",
                        gap: 10,
                        gridTemplateColumns:
                            "auto auto minmax(0, 1fr) auto auto",
                        padding: "10px 12px",
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
                            fontSize: "0.7em",
                            height: 20,
                            justifyContent: "center",
                            transform: expanded
                                ? "rotate(90deg)"
                                : "rotate(0deg)",
                            transition: "transform 140ms ease",
                            width: 20,
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
                            height: 8,
                            width: 8,
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
                                    fontSize: "0.82em",
                                    fontWeight: 600,
                                }}
                            >
                                {getFileNameFromPath(item.file.path)}
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
                                {badgeLabel}
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
                            {compactPath} · {item.summary}
                        </div>
                    </button>
                    <div
                        style={{
                            display: "flex",
                            flexShrink: 0,
                            gap: 8,
                            justifyContent: "flex-end",
                            minWidth: 52,
                        }}
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
                                aria-label="Open File"
                                onClick={onOpen}
                                style={{
                                    ...COMPACT_ICON_BUTTON_STYLE,
                                    ...getNeutralButtonStyle(),
                                }}
                                title="Open File"
                                type="button"
                            >
                                <OpenFileIcon />
                            </button>
                        ) : null}
                        <button
                            aria-label="Reject"
                            className="review-action-btn"
                            disabled={!item.canReject}
                            onClick={onReject}
                            style={{
                                ...COMPACT_ICON_BUTTON_STYLE,
                                ...getDangerButtonStyle(!item.canReject),
                            }}
                            title="Reject"
                            type="button"
                        >
                            <RejectIcon />
                        </button>
                        <button
                            aria-label="Keep"
                            className="review-action-btn"
                            onClick={onKeep}
                            style={{
                                ...COMPACT_ICON_BUTTON_STYLE,
                                ...getAccentButtonStyle(item.tone.accent),
                            }}
                            title="Keep"
                            type="button"
                        >
                            <KeepIcon />
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
                    onRejectHunk={
                        item.canResolveHunks ? onRejectHunk : undefined
                    }
                    testId={`review-file-diff:${item.file.identityKey}`}
                />
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
                        height: 8,
                        width: 8,
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
                                fontSize: "0.78em",
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
