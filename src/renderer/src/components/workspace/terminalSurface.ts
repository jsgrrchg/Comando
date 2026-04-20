export interface TerminalViewportSize {
    readonly cols: number;
    readonly rows: number;
}

export interface TerminalSurfaceTheme {
    readonly background: string;
    readonly cursor: string;
    readonly foreground: string;
    readonly selectionBackground: string;
}

export interface TerminalSurfaceOptions {
    readonly allowTransparency: boolean;
    readonly convertEol: boolean;
    readonly cursorBlink: boolean;
    readonly fontFamily: string;
    readonly fontSize: number;
    readonly lineHeight: number;
    readonly scrollback: number;
    readonly theme: TerminalSurfaceTheme;
}

interface TerminalViewportContainer {
    readonly clientHeight: number;
    readonly clientWidth: number;
}

interface TerminalViewportRuntime {
    readonly cols: number;
    readonly rows: number;
    refresh: (start: number, end: number) => void;
}

interface TerminalThemeRuntime {
    readonly options: {
        theme?: Partial<TerminalSurfaceTheme>;
    };
    readonly rows: number;
    refresh: (start: number, end: number) => void;
}

export function createTerminalSurfaceOptions(
    theme: TerminalSurfaceTheme,
): TerminalSurfaceOptions {
    return {
        allowTransparency: false,
        // Keep carriage returns intact so interactive shells can redraw prompts
        // without leaving visual artifacts after reconnects or resizes.
        convertEol: false,
        cursorBlink: true,
        fontFamily: '"SF Mono", "JetBrains Mono", "Cascadia Code", monospace',
        fontSize: 12.5,
        lineHeight: 1.35,
        scrollback: 5000,
        theme,
    };
}

export function areTerminalSurfaceThemesEqual(
    first: Partial<TerminalSurfaceTheme> | null | undefined,
    second: TerminalSurfaceTheme,
): boolean {
    return (
        first?.background === second.background &&
        first?.cursor === second.cursor &&
        first?.foreground === second.foreground &&
        first?.selectionBackground === second.selectionBackground
    );
}

export function applyTerminalSurfaceTheme({
    terminal,
    theme,
}: {
    readonly terminal: TerminalThemeRuntime | null | undefined;
    readonly theme: TerminalSurfaceTheme;
}): boolean {
    if (!terminal) {
        return false;
    }

    const currentTheme = terminal.options.theme;
    if (areTerminalSurfaceThemesEqual(currentTheme, theme)) {
        return false;
    }

    terminal.options.theme = theme;

    if (terminal.rows > 0) {
        terminal.refresh(0, terminal.rows - 1);
    }

    return true;
}

export function syncTerminalViewport({
    container,
    fit,
    previousSize,
    terminal,
}: {
    readonly container: TerminalViewportContainer | null | undefined;
    readonly fit: (() => void) | null | undefined;
    readonly previousSize: TerminalViewportSize | null;
    readonly terminal: TerminalViewportRuntime | null | undefined;
}): {
    readonly didSync: boolean;
    readonly nextSize: TerminalViewportSize | null;
    readonly sizeChanged: boolean;
} {
    if (
        !container ||
        !terminal ||
        !fit ||
        container.clientWidth <= 0 ||
        container.clientHeight <= 0
    ) {
        return {
            didSync: false,
            nextSize: previousSize,
            sizeChanged: false,
        };
    }

    fit();

    if (terminal.cols <= 0 || terminal.rows <= 0) {
        return {
            didSync: false,
            nextSize: previousSize,
            sizeChanged: false,
        };
    }

    const nextSize: TerminalViewportSize = {
        cols: terminal.cols,
        rows: terminal.rows,
    };

    terminal.refresh(0, nextSize.rows - 1);

    return {
        didSync: true,
        nextSize,
        sizeChanged:
            previousSize?.cols !== nextSize.cols ||
            previousSize?.rows !== nextSize.rows,
    };
}
