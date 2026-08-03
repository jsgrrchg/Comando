import { describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";

import { SingleWindowCoordinator } from "./single-window-coordinator";

describe("SingleWindowCoordinator", () => {
    it("acquires the process lock once", () => {
        const coordinator = new SingleWindowCoordinator();
        const requestSingleInstanceLock = vi.fn(() => true);

        expect(
            coordinator.acquireInstanceLock({ requestSingleInstanceLock }),
        ).toBe(true);
        expect(
            coordinator.acquireInstanceLock({ requestSingleInstanceLock }),
        ).toBe(true);
        expect(requestSingleInstanceLock).toHaveBeenCalledTimes(1);
    });

    it("keeps a rejected process lock rejected", () => {
        const coordinator = new SingleWindowCoordinator();
        const requestSingleInstanceLock = vi.fn(() => false);

        expect(
            coordinator.acquireInstanceLock({ requestSingleInstanceLock }),
        ).toBe(false);
        expect(
            coordinator.acquireInstanceLock({ requestSingleInstanceLock }),
        ).toBe(false);
        expect(requestSingleInstanceLock).toHaveBeenCalledTimes(1);
    });

    it("reuses and focuses the canonical main window", () => {
        const coordinator = new SingleWindowCoordinator();
        const first = createWindow();
        const create = vi.fn(() => first.window);

        expect(coordinator.ensureMainWindow(create)).toBe(first.window);
        expect(coordinator.ensureMainWindow(create)).toBe(first.window);
        expect(create).toHaveBeenCalledTimes(1);
        expect(first.show).toHaveBeenCalledTimes(1);
        expect(first.focus).toHaveBeenCalledTimes(1);
    });

    it("allows one replacement only after the canonical window closes", () => {
        const coordinator = new SingleWindowCoordinator();
        const first = createWindow();
        const second = createWindow();
        coordinator.registerMainWindow(first.window);

        expect(() => coordinator.registerMainWindow(second.window)).toThrow(
            "A canonical main window is already registered.",
        );

        first.close();
        coordinator.registerMainWindow(second.window);
        expect(coordinator.getMainWindow()).toBe(second.window);
    });
});

function createWindow() {
    let closedListener: (() => void) | null = null;
    let destroyed = false;
    const focus = vi.fn();
    const restore = vi.fn();
    const show = vi.fn();
    const window = {
        focus,
        isDestroyed: () => destroyed,
        isMinimized: () => false,
        once: vi.fn((event: string, listener: () => void) => {
            if (event === "closed") {
                closedListener = listener;
            }
        }),
        restore,
        show,
    } as unknown as BrowserWindow;
    return {
        close: () => {
            destroyed = true;
            closedListener?.();
        },
        focus,
        restore,
        show,
        window,
    };
}
