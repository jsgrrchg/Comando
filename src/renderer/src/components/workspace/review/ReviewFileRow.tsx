import type { ReviewFileItem } from "./editedFilesPresentationModel";
import { EditedFileDiffPreview } from "./EditedFileDiffPreview";
import {
    formatDiffStat,
    getCompactPath,
    getFileNameFromPath,
} from "./reviewDiff";

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

function getFileKindPrefix(kind: string): string {
    switch (kind) {
        case "create":
            return "A";
        case "delete":
            return "D";
        case "move":
            return "R";
        default:
            return "M";
    }
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
                    borderTop:
                        "1px solid color-mix(in srgb, var(--color-border) 50%, transparent)",
                    fontFamily: "var(--font-mono)",
                    overflow: "hidden",
                }}
            >
                <div className="flex items-center gap-2 px-2.5 py-1">
                    <span
                        aria-hidden="true"
                        style={{
                            color: item.tone.accent,
                            flexShrink: 0,
                            fontSize: "0.78em",
                            fontWeight: 700,
                            textAlign: "center",
                            width: 12,
                        }}
                    >
                        {getFileKindPrefix(item.file.kind)}
                    </span>
                    <span
                        className="min-w-0 flex-1 truncate"
                        style={{
                            color: "var(--color-text-primary)",
                            fontSize: "0.8em",
                            fontWeight: 500,
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
                            className="review-action-btn shrink-0"
                            disabled={!canShowOpen}
                            onClick={canShowOpen ? onOpen : undefined}
                            onMouseEnter={(e) => {
                                if (canShowOpen) {
                                    e.currentTarget.style.opacity = "1";
                                }
                            }}
                            onMouseLeave={(e) => {
                                if (canShowOpen) {
                                    e.currentTarget.style.opacity = "0.65";
                                }
                            }}
                            style={{
                                background: "transparent",
                                border: "none",
                                color: "var(--color-text-secondary)",
                                cursor: canShowOpen ? "pointer" : "not-allowed",
                                fontSize: "11px",
                                fontWeight: 500,
                                opacity: canShowOpen ? 0.65 : 0.25,
                                padding: "2px 3px",
                                transition:
                                    "opacity 100ms ease, filter 100ms ease",
                            }}
                            title="Open File"
                            type="button"
                        >
                            open
                        </button>
                        <button
                            aria-label="Reject"
                            className="review-action-btn shrink-0"
                            disabled={!item.canReject}
                            onClick={onReject}
                            onMouseEnter={(e) => {
                                if (item.canReject) {
                                    e.currentTarget.style.opacity = "1";
                                }
                            }}
                            onMouseLeave={(e) => {
                                if (item.canReject) {
                                    e.currentTarget.style.opacity = "0.6";
                                }
                            }}
                            style={{
                                background: "transparent",
                                border: "none",
                                color: "var(--diff-remove)",
                                cursor: item.canReject
                                    ? "pointer"
                                    : "not-allowed",
                                fontSize: "13px",
                                opacity: item.canReject ? 0.6 : 0.2,
                                padding: "2px 3px",
                                transition:
                                    "opacity 100ms ease, filter 100ms ease",
                            }}
                            title="Reject"
                            type="button"
                        >
                            ✕
                        </button>
                        <button
                            aria-label="Keep"
                            className="review-action-btn shrink-0"
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
                                fontSize: "13px",
                                opacity: 0.6,
                                padding: "2px 3px",
                                transition:
                                    "opacity 100ms ease, filter 100ms ease",
                            }}
                            title="Keep"
                            type="button"
                        >
                            ✓
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div
            className="overflow-hidden rounded-md"
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
                <span
                    aria-hidden="true"
                    style={{
                        color: item.tone.accent,
                        flexShrink: 0,
                        fontSize: "0.78em",
                        fontWeight: 700,
                        textAlign: "center",
                        width: 14,
                    }}
                >
                    {getFileKindPrefix(item.file.kind)}
                </span>
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
                        className="review-action-btn shrink-0"
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
                            className="review-action-btn shrink-0"
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
                        className="review-action-btn shrink-0"
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
                lineWrapping={lineWrapping}
                onKeepHunk={item.canResolveHunks ? onKeepHunk : undefined}
                onRejectHunk={item.canResolveHunks ? onRejectHunk : undefined}
                testId={`review-file-diff:${item.file.identityKey}`}
            />
        </div>
    );
}
