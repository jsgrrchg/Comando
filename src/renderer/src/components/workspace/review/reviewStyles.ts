import type { CSSProperties } from "react";

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
