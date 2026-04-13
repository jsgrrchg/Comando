export const designTokens = {
    colors: {
        bgPrimary: "#ffffff",
        bgSecondary: "#f5f5f5",
        bgTertiary: "#ebebeb",
        bgElevated: "#fcfcfc",
        textPrimary: "#1c1c1c",
        textSecondary: "#737373",
        border: "#e5e5e5",
        borderStrong: "#d4d4d4",
        borderSubtle: "#f0f0f0",
        accent: "#6366f1",
        accentSoft: "#eef2ff",
        accentStrong: "#4f46e5",
        success: "#16a34a",
        selection: "rgba(99, 102, 241, 0.12)",
    },
    radii: {
        window: 12,
        card: 8,
        cardTight: 6,
        pill: 999,
    },
    spacing: {
        section: 24,
        cluster: 16,
        chrome: 14,
    },
    shadows: {
        soft: "0 18px 48px rgba(15, 23, 42, 0.08)",
    },
} as const;

export type DesignTokens = typeof designTokens;
