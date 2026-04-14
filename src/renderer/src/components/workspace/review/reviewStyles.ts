import type { CSSProperties } from "react";

export function getDangerButtonStyle(disabled = false): CSSProperties {
    return {
        color: disabled
            ? "var(--color-text-secondary)"
            : "color-mix(in srgb, var(--color-text-primary) 72%, var(--diff-remove))",
        backgroundColor:
            "color-mix(in srgb, var(--diff-remove) 8%, var(--color-bg-secondary))",
        border:
            "1px solid color-mix(in srgb, var(--diff-remove) 28%, var(--color-border))",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.45 : 1,
        transition: "background-color 100ms ease, opacity 100ms ease",
    };
}

export function getAccentButtonStyle(
    accent = "var(--color-accent)",
): CSSProperties {
    return {
        color: accent,
        backgroundColor:
            "color-mix(in srgb, var(--color-bg-secondary) 92%, transparent)",
        border: `1px solid color-mix(in srgb, ${accent} 55%, var(--color-border))`,
        transition: "background-color 100ms ease, opacity 100ms ease",
    };
}

export function getNeutralButtonStyle(): CSSProperties {
    return {
        color: "var(--color-text-secondary)",
        backgroundColor:
            "color-mix(in srgb, var(--color-bg-secondary) 74%, transparent)",
        border:
            "1px solid color-mix(in srgb, var(--color-border) 82%, transparent)",
        transition: "background-color 100ms ease, opacity 100ms ease",
    };
}

export function getStatChipStyle(
    color = "var(--color-text-secondary)",
): CSSProperties {
    return {
        alignItems: "center",
        backgroundColor: `color-mix(in srgb, ${color} 8%, var(--color-bg-secondary))`,
        border: `1px solid color-mix(in srgb, ${color} 15%, var(--color-border))`,
        borderRadius: 999,
        color,
        display: "inline-flex",
        fontSize: "0.75em",
        fontWeight: 600,
        gap: 4,
        padding: "2px 8px",
    };
}

export function getToneBorderStyle(accent: string): CSSProperties {
    return {
        borderLeft: `3px solid color-mix(in srgb, ${accent} 55%, transparent)`,
    };
}
