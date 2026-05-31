export interface TerminalTheme {
    readonly background: string;
    readonly panelBackground: string;
    readonly border: string;
    readonly text: string;
    readonly mutedText: string;
    readonly accent: string;
    readonly cursor: string;
    readonly fontFamily: string;
    readonly fontSize: number;
    readonly lineHeight: number;
    readonly black: string;
    readonly red: string;
    readonly green: string;
    readonly yellow: string;
    readonly blue: string;
    readonly magenta: string;
    readonly cyan: string;
    readonly white: string;
    readonly brightBlack: string;
    readonly brightRed: string;
    readonly brightGreen: string;
    readonly brightYellow: string;
    readonly brightBlue: string;
    readonly brightMagenta: string;
    readonly brightCyan: string;
    readonly brightWhite: string;
    readonly selectionBackground: string;
    readonly scrollbarSliderBackground: string;
    readonly scrollbarSliderHoverBackground: string;
    readonly scrollbarSliderActiveBackground: string;
}

const FALLBACK_FONT_STACK =
    '"SF Mono", "SFMono-Regular", "JetBrains Mono", "Cascadia Code", Menlo, Monaco, Consolas, monospace';

export function getTerminalTheme(
    element: HTMLElement | null,
    opts?: { readonly fontFamily?: string; readonly fontSize?: number },
): TerminalTheme {
    const computed = window.getComputedStyle(
        element ?? document.documentElement,
    );
    const v = (name: string) => computed.getPropertyValue(name).trim();
    const token = (name: string, fallback: string) => v(name) || fallback;

    const background = token(
        "--color-editor",
        token("--color-bg-primary", "#0f172a"),
    );
    const text = token(
        "--color-editor-text",
        token("--color-text-primary", "#e5e7eb"),
    );
    const mutedText = token("--color-text-secondary", "#94a3b8");
    const accent = token("--color-accent", "#3b82f6");
    const border = token("--color-border", "rgba(148, 163, 184, 0.28)");
    const panelBackground = token("--color-bg-secondary", background);

    return {
        accent,
        background,
        black: token("--terminal-ansi-black", panelBackground),
        blue: token("--terminal-ansi-blue", "#60a5fa"),
        border,
        brightBlack: token("--terminal-ansi-bright-black", mutedText),
        brightBlue: token("--terminal-ansi-bright-blue", "#93c5fd"),
        brightCyan: token("--terminal-ansi-bright-cyan", "#67e8f9"),
        brightGreen: token("--terminal-ansi-bright-green", "#86efac"),
        brightMagenta: token("--terminal-ansi-bright-magenta", "#f0abfc"),
        brightRed: token("--terminal-ansi-bright-red", "#fca5a5"),
        brightWhite: token("--terminal-ansi-bright-white", "#f8fafc"),
        brightYellow: token("--terminal-ansi-bright-yellow", "#fde68a"),
        cyan: token("--terminal-ansi-cyan", "#22d3ee"),
        cursor: accent,
        fontFamily: opts?.fontFamily?.trim() || FALLBACK_FONT_STACK,
        fontSize: opts?.fontSize ?? 13,
        green: token("--terminal-ansi-green", "#22c55e"),
        lineHeight: 1.05,
        magenta: token("--terminal-ansi-magenta", "#d946ef"),
        mutedText,
        panelBackground,
        red: token("--terminal-ansi-red", "#ef4444"),
        scrollbarSliderActiveBackground: token(
            "--color-scrollbar-thumb-active",
            mutedText,
        ),
        scrollbarSliderBackground: token(
            "--color-scrollbar-thumb",
            "rgba(148, 163, 184, 0.34)",
        ),
        scrollbarSliderHoverBackground: token(
            "--color-scrollbar-thumb-hover",
            "rgba(148, 163, 184, 0.54)",
        ),
        selectionBackground: token(
            "--color-selection",
            "rgba(96, 165, 250, 0.28)",
        ),
        text,
        white: token("--terminal-ansi-white", text),
        yellow: token("--terminal-ansi-yellow", "#eab308"),
    };
}
