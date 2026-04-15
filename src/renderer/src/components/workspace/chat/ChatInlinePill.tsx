import type { CSSProperties, MouseEventHandler } from "react";

import { truncatePillLabel, type ChatPillMetrics } from "./chatPillMetrics";
import { CHAT_PILL_VARIANTS, type ChatPillVariant } from "./chatPillPalette";

interface ChatInlinePillProps {
    readonly label: string;
    readonly metrics: ChatPillMetrics;
    readonly title?: string;
    readonly interactive?: boolean;
    readonly variant?: ChatPillVariant;
    readonly onClick?: () => void;
    readonly onContextMenu?: MouseEventHandler<HTMLElement>;
}

export function ChatInlinePill({
    label,
    metrics,
    title,
    interactive = false,
    variant = "accent",
    onClick,
    onContextMenu,
}: ChatInlinePillProps) {
    const palette = CHAT_PILL_VARIANTS[variant];
    const clickable = interactive || typeof onClick === "function";
    const style: CSSProperties = {
        display: "inline-flex",
        alignItems: "center",
        margin: `0 ${metrics.gapX}px`,
        padding: `${metrics.paddingY}px ${metrics.paddingX}px`,
        maxInlineSize: metrics.maxWidth,
        borderRadius: metrics.radius,
        background: palette.background,
        color: palette.color,
        fontSize: metrics.fontSize,
        lineHeight: metrics.lineHeight,
        border: "none",
        cursor: clickable ? "pointer" : "default",
        fontFamily: "inherit",
        verticalAlign: "baseline",
        overflow: "hidden",
        transform: `translateY(${metrics.offsetY}px)`,
        filter: "brightness(1)",
        opacity: clickable ? 0.85 : 1,
        transition: clickable
            ? "opacity 80ms ease, filter 80ms ease"
            : undefined,
    };

    const content = (
        <span
            style={{
                display: "block",
                minWidth: 0,
                maxWidth: "100%",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
            }}
        >
            {truncatePillLabel(label)}
        </span>
    );

    if (clickable) {
        return (
            <button
                type="button"
                onClick={onClick}
                onContextMenu={onContextMenu}
                style={style}
                title={title ?? label}
                onMouseEnter={(e) => {
                    e.currentTarget.style.opacity = "1";
                    e.currentTarget.style.filter = "brightness(1.08)";
                }}
                onMouseLeave={(e) => {
                    e.currentTarget.style.opacity = "0.85";
                    e.currentTarget.style.filter = "brightness(1)";
                }}
            >
                {content}
            </button>
        );
    }

    return (
        <span
            style={style}
            title={title ?? label}
            onContextMenu={onContextMenu}
        >
            {content}
        </span>
    );
}
