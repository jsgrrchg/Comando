import type { CSSProperties } from "react";

import { getNeutralButtonStyle } from "./reviewStyles";

type HunkDecision = "accepted" | "rejected";

const BASE_BUTTON_STYLE: CSSProperties = {
    alignItems: "center",
    borderRadius: 6,
    cursor: "pointer",
    display: "inline-flex",
    fontSize: "0.68em",
    fontWeight: 600,
    height: 24,
    justifyContent: "center",
    letterSpacing: "0.01em",
    padding: "0 9px",
};

const BAR_STYLE: CSSProperties = {
    alignItems: "center",
    backdropFilter: "blur(8px)",
    backgroundColor:
        "color-mix(in srgb, var(--color-bg-primary) 78%, var(--color-bg-secondary))",
    border: "1px solid color-mix(in srgb, var(--color-border) 82%, transparent)",
    borderRadius: 8,
    boxShadow: "0 6px 16px rgb(0 0 0 / 0.12)",
    display: "flex",
    gap: 4,
    padding: 3,
    position: "absolute",
    right: 8,
    top: 8,
    zIndex: 2,
};

export interface HunkActionBarProps {
    readonly decision?: HunkDecision;
    readonly hunkIndex: number;
    readonly onAccept?: () => void;
    readonly onReject?: () => void;
    readonly onUndo?: () => void;
}

export function HunkActionBar({
    decision,
    hunkIndex,
    onAccept,
    onReject,
    onUndo,
}: HunkActionBarProps) {
    const hiddenUntilHoverClass = decision
        ? "opacity-100 translate-y-0 pointer-events-auto"
        : "pointer-events-none opacity-0 -translate-y-1 group-hover:pointer-events-auto group-hover:opacity-100 group-hover:translate-y-0 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-focus-within:translate-y-0";

    if (decision) {
        const accepted = decision === "accepted";
        const color = accepted ? "var(--diff-add)" : "var(--diff-remove)";

        return (
            <div
                className={`transition-all duration-150 ease-out ${hiddenUntilHoverClass}`}
                style={BAR_STYLE}
            >
                <span
                    style={{
                        ...BASE_BUTTON_STYLE,
                        backgroundColor: `color-mix(in srgb, ${color} 10%, var(--color-bg-primary))`,
                        border: `1px solid color-mix(in srgb, ${color} 30%, var(--color-border))`,
                        color,
                        cursor: "default",
                        padding: "0 8px",
                    }}
                >
                    {accepted ? "Accepted" : "Rejected"}
                </span>
                {onUndo ? (
                    <button
                        aria-label={`Undo hunk ${hunkIndex + 1}`}
                        className="review-action-btn"
                        onClick={onUndo}
                        style={{
                            ...BASE_BUTTON_STYLE,
                            ...getNeutralButtonStyle(),
                        }}
                        type="button"
                    >
                        Undo
                    </button>
                ) : null}
            </div>
        );
    }

    return (
        <div
            className={`transition-all duration-150 ease-out ${hiddenUntilHoverClass}`}
            style={BAR_STYLE}
        >
            <button
                aria-label={`Accept hunk ${hunkIndex + 1}`}
                className="review-action-btn"
                onClick={onAccept}
                style={{
                    ...BASE_BUTTON_STYLE,
                    backgroundColor:
                        "color-mix(in srgb, var(--diff-add) 10%, var(--color-bg-primary))",
                    border: "1px solid color-mix(in srgb, var(--diff-add) 32%, var(--color-border))",
                    color: "var(--diff-add)",
                }}
                type="button"
            >
                Accept
            </button>
            <button
                aria-label={`Reject hunk ${hunkIndex + 1}`}
                className="review-action-btn"
                onClick={onReject}
                style={{
                    ...BASE_BUTTON_STYLE,
                    backgroundColor:
                        "color-mix(in srgb, var(--diff-remove) 10%, var(--color-bg-primary))",
                    border: "1px solid color-mix(in srgb, var(--diff-remove) 32%, var(--color-border))",
                    color: "var(--diff-remove)",
                }}
                type="button"
            >
                Reject
            </button>
        </div>
    );
}
