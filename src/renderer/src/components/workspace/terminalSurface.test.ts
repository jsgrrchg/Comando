import { describe, expect, it, vi } from "vitest";

import { syncTerminalViewport } from "./terminalSurface";

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
