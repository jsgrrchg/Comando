import type { ReactNode } from "react";

export function IdeBarHeader({
    children,
    className,
}: {
    readonly children: ReactNode;
    readonly className?: string;
}) {
    return (
        <div
            className={["shrink-0 px-4 py-1.5", className]
                .filter(Boolean)
                .join(" ")}
            style={{
                backgroundColor: "var(--color-bg-secondary)",
                borderBottom:
                    "1px solid color-mix(in srgb, var(--color-border) 60%, transparent)",
                fontFamily: "var(--font-mono)",
            }}
        >
            <div className="flex w-full items-center gap-3">{children}</div>
        </div>
    );
}

export function IdeBarLabel({ children }: { readonly children: ReactNode }) {
    return (
        <span
            className="shrink-0"
            style={{
                color: "var(--color-text-secondary)",
                fontSize: "10px",
                fontWeight: 600,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
            }}
        >
            {children}
        </span>
    );
}

export function IdeBarDotSeparator() {
    return (
        <span aria-hidden="true" className="shrink-0 text-text-secondary">
            ·
        </span>
    );
}

export function IdeIconButton({
    children,
    disabled,
    onClick,
    title,
    ...ariaProps
}: {
    readonly children: ReactNode;
    readonly disabled?: boolean;
    readonly onClick: () => void;
    readonly title?: string;
    readonly "aria-label"?: string;
}) {
    return (
        <button
            aria-label={ariaProps["aria-label"]}
            className="review-action-btn review-text-btn flex items-center justify-center"
            disabled={disabled}
            onClick={onClick}
            style={{
                background: "transparent",
                border: "1px solid color-mix(in srgb, var(--color-border) 60%, transparent)",
                borderRadius: 3,
                color: "var(--color-text-secondary)",
                cursor: disabled ? "not-allowed" : "pointer",
                height: 22,
                opacity: disabled ? 0.4 : 1,
                padding: "0 6px",
            }}
            title={title}
            type="button"
        >
            {children}
        </button>
    );
}

export function IdeActionButton({
    active,
    children,
    disabled,
    onClick,
    title,
}: {
    readonly active?: boolean;
    readonly children: ReactNode;
    readonly disabled?: boolean;
    readonly onClick: () => void;
    readonly title?: string;
}) {
    return (
        <button
            className="review-action-btn review-text-btn"
            disabled={disabled}
            onClick={onClick}
            style={{
                background: active
                    ? "color-mix(in srgb, var(--color-accent) 12%, transparent)"
                    : "transparent",
                border: "1px solid color-mix(in srgb, var(--color-border) 60%, transparent)",
                borderRadius: 3,
                color: active
                    ? "var(--color-text-primary)"
                    : "var(--color-text-secondary)",
                cursor: disabled ? "not-allowed" : "pointer",
                fontSize: "10px",
                fontWeight: 500,
                lineHeight: "20px",
                opacity: disabled ? 0.4 : 1,
                padding: "0 8px",
            }}
            title={title}
            type="button"
        >
            {children}
        </button>
    );
}

export function IdeBarSearchIcon() {
    return (
        <svg
            aria-hidden="true"
            fill="none"
            height="12"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            viewBox="0 0 24 24"
            width="12"
        >
            <circle cx="11" cy="11" r="7" />
            <line x1="21" x2="16.5" y1="21" y2="16.5" />
        </svg>
    );
}
