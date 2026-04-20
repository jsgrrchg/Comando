import { describe, expect, it, vi } from "vitest";

import {
    applyTerminalSurfaceTheme,
    areTerminalSurfaceThemesEqual,
    createTerminalSurfaceOptions,
    syncTerminalViewport,
} from "./terminalSurface";

describe("createTerminalSurfaceOptions", () => {
    it("keeps carriage-return redraws intact for shell prompts", () => {
        const options = createTerminalSurfaceOptions({
            background: "#111111",
            cursor: "#ffffff",
            foreground: "#eeeeee",
            selectionBackground: "#333333",
        });

        expect(options).toMatchObject({
            allowTransparency: false,
            convertEol: false,
            cursorBlink: true,
            fontFamily:
                '"SF Mono", "JetBrains Mono", "Cascadia Code", monospace',
            fontSize: 12.5,
            lineHeight: 1.35,
            scrollback: 5000,
        });
        expect(options.theme).toEqual({
            background: "#111111",
            cursor: "#ffffff",
            foreground: "#eeeeee",
            selectionBackground: "#333333",
        });
    });
});

describe("syncTerminalViewport", () => {
    it("skips syncing while the container has no visible size", () => {
        const fit = vi.fn();
        const refresh = vi.fn();

        const result = syncTerminalViewport({
            container: {
                clientHeight: 0,
                clientWidth: 640,
            },
            fit,
            previousSize: {
                cols: 80,
                rows: 24,
            },
            terminal: {
                cols: 100,
                refresh,
                rows: 32,
            },
        });

        expect(result).toEqual({
            didSync: false,
            nextSize: {
                cols: 80,
                rows: 24,
            },
            sizeChanged: false,
        });
        expect(fit).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
    });

    it("fits and refreshes the terminal when the container is visible", () => {
        const fit = vi.fn();
        const refresh = vi.fn();

        const result = syncTerminalViewport({
            container: {
                clientHeight: 480,
                clientWidth: 960,
            },
            fit,
            previousSize: {
                cols: 80,
                rows: 24,
            },
            terminal: {
                cols: 120,
                refresh,
                rows: 34,
            },
        });

        expect(fit).toHaveBeenCalledTimes(1);
        expect(refresh).toHaveBeenCalledWith(0, 33);
        expect(result).toEqual({
            didSync: true,
            nextSize: {
                cols: 120,
                rows: 34,
            },
            sizeChanged: true,
        });
    });

    it("detects when the viewport dimensions stay the same", () => {
        const fit = vi.fn();
        const refresh = vi.fn();

        const result = syncTerminalViewport({
            container: {
                clientHeight: 480,
                clientWidth: 960,
            },
            fit,
            previousSize: {
                cols: 120,
                rows: 34,
            },
            terminal: {
                cols: 120,
                refresh,
                rows: 34,
            },
        });

        expect(result.sizeChanged).toBe(false);
        expect(refresh).toHaveBeenCalledWith(0, 33);
    });
});

describe("areTerminalSurfaceThemesEqual", () => {
    it("detects when the terminal theme did not change", () => {
        expect(
            areTerminalSurfaceThemesEqual(
                {
                    background: "#111111",
                    cursor: "#ffffff",
                    foreground: "#eeeeee",
                    selectionBackground: "#333333",
                },
                {
                    background: "#111111",
                    cursor: "#ffffff",
                    foreground: "#eeeeee",
                    selectionBackground: "#333333",
                },
            ),
        ).toBe(true);
    });

    it("detects when any terminal theme token changed", () => {
        expect(
            areTerminalSurfaceThemesEqual(
                {
                    background: "#111111",
                    cursor: "#ffffff",
                    foreground: "#eeeeee",
                    selectionBackground: "#333333",
                },
                {
                    background: "#111111",
                    cursor: "#ff00ff",
                    foreground: "#eeeeee",
                    selectionBackground: "#333333",
                },
            ),
        ).toBe(false);
    });
});

describe("applyTerminalSurfaceTheme", () => {
    it("skips refresh when the terminal already uses the same theme", () => {
        const refresh = vi.fn();
        const terminal = {
            options: {
                theme: {
                    background: "#111111",
                    cursor: "#ffffff",
                    foreground: "#eeeeee",
                    selectionBackground: "#333333",
                },
            },
            refresh,
            rows: 24,
        };

        const didApply = applyTerminalSurfaceTheme({
            terminal,
            theme: {
                background: "#111111",
                cursor: "#ffffff",
                foreground: "#eeeeee",
                selectionBackground: "#333333",
            },
        });

        expect(didApply).toBe(false);
        expect(refresh).not.toHaveBeenCalled();
    });

    it("updates xterm and refreshes visible rows when the theme changed", () => {
        const refresh = vi.fn();
        const terminal = {
            options: {
                theme: {
                    background: "#111111",
                    cursor: "#ffffff",
                    foreground: "#eeeeee",
                    selectionBackground: "#333333",
                },
            },
            refresh,
            rows: 24,
        };

        const nextTheme = {
            background: "#222222",
            cursor: "#ff00ff",
            foreground: "#f5f5f5",
            selectionBackground: "#444444",
        };

        const didApply = applyTerminalSurfaceTheme({
            terminal,
            theme: nextTheme,
        });

        expect(didApply).toBe(true);
        expect(terminal.options.theme).toEqual(nextTheme);
        expect(refresh).toHaveBeenCalledWith(0, 23);
    });
});
