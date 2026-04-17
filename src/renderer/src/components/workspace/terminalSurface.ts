export interface TerminalViewportSize {
    readonly cols: number;
    readonly rows: number;
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
