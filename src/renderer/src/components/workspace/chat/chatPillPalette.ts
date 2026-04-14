export type ChatPillVariant =
    | "accent"
    | "success"
    | "neutral"
    | "folder"
    | "file";

export const CHAT_PILL_VARIANTS: Record<
    ChatPillVariant,
    { background: string; color: string }
> = {
    accent: {
        background: "color-mix(in srgb, var(--color-accent) 15%, transparent)",
        color: "var(--color-accent)",
    },
    success: {
        background: "color-mix(in srgb, #10b981 15%, transparent)",
        color: "#10b981",
    },
    neutral: {
        background:
            "color-mix(in srgb, var(--color-bg-tertiary) 84%, transparent)",
        color: "var(--color-text-secondary)",
    },
    folder: {
        background:
            "color-mix(in srgb, var(--color-text-secondary) 12%, var(--color-bg-tertiary))",
        color: "color-mix(in srgb, var(--color-text-secondary) 84%, var(--color-text-primary))",
    },
    file: {
        background: "color-mix(in srgb, #d97706 12%, transparent)",
        color: "#d97706",
    },
};
