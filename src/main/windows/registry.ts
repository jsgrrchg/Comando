import { BrowserWindow, type WebContents } from "electron";

import type { WindowContextSnapshot } from "@shared/ipc";

interface RegisteredWindowEntry {
    readonly context: WindowContextSnapshot;
    readonly window: BrowserWindow;
}

class WindowRegistry {
    readonly #entriesByBrowserWindowId = new Map<
        number,
        RegisteredWindowEntry
    >();
    #lastFocusedMainWindowId: string | null = null;

    register(window: BrowserWindow, context: WindowContextSnapshot): void {
        const entry: RegisteredWindowEntry = {
            context,
            window,
        };

        this.#entriesByBrowserWindowId.set(window.id, entry);
        if (context.windowKind === "main") {
            this.#lastFocusedMainWindowId = context.windowId;
        }

        window.on("focus", () => {
            if (context.windowKind === "main") {
                this.#lastFocusedMainWindowId = context.windowId;
            }
        });
        window.on("closed", () => {
            this.#entriesByBrowserWindowId.delete(window.id);
            if (this.#lastFocusedMainWindowId === context.windowId) {
                this.#lastFocusedMainWindowId =
                    this.#getMostRecentMainWindowEntry()?.context.windowId ??
                    null;
            }
        });
    }

    getContextByWebContents(
        webContents: WebContents,
    ): WindowContextSnapshot | null {
        const window = BrowserWindow.fromWebContents(webContents);
        return window ? this.getContextByBrowserWindow(window) : null;
    }

    getContextByBrowserWindow(
        window: BrowserWindow,
    ): WindowContextSnapshot | null {
        return this.#entriesByBrowserWindowId.get(window.id)?.context ?? null;
    }

    getWindowByStableId(windowId: string): BrowserWindow | null {
        for (const entry of this.#entriesByBrowserWindowId.values()) {
            if (entry.context.windowId === windowId) {
                return entry.window;
            }
        }

        return null;
    }

    getMainWindowByProjectId(projectId: string): BrowserWindow | null {
        for (const entry of this.#entriesByBrowserWindowId.values()) {
            if (
                entry.context.windowKind === "main" &&
                entry.context.projectId === projectId
            ) {
                return entry.window;
            }
        }

        return null;
    }

    getMostRecentMainWindow(): BrowserWindow | null {
        return this.#getMostRecentMainWindowEntry()?.window ?? null;
    }

    getFocusedMainWindow(): BrowserWindow | null {
        const focusedWindow = BrowserWindow.getFocusedWindow();
        if (!focusedWindow) {
            return null;
        }

        const context = this.getContextByBrowserWindow(focusedWindow);
        return context?.windowKind === "main" ? focusedWindow : null;
    }

    listMainWindowContexts(): readonly WindowContextSnapshot[] {
        return [...this.#entriesByBrowserWindowId.values()]
            .filter((entry) => entry.context.windowKind === "main")
            .map((entry) => entry.context);
    }

    updateMainWindowProjectId(
        windowId: string,
        projectId: string | null,
        worktreeId: string | null = null,
    ): WindowContextSnapshot | null {
        for (const [browserWindowId, entry] of this.#entriesByBrowserWindowId) {
            if (
                entry.context.windowId === windowId &&
                entry.context.windowKind === "main"
            ) {
                const nextContext: WindowContextSnapshot = {
                    ...entry.context,
                    projectId,
                    worktreeId,
                };
                this.#entriesByBrowserWindowId.set(browserWindowId, {
                    context: nextContext,
                    window: entry.window,
                });
                return nextContext;
            }
        }

        return null;
    }

    #getMostRecentMainWindowEntry(): RegisteredWindowEntry | null {
        if (!this.#lastFocusedMainWindowId) {
            return (
                [...this.#entriesByBrowserWindowId.values()].find(
                    (entry) => entry.context.windowKind === "main",
                ) ?? null
            );
        }

        return (
            [...this.#entriesByBrowserWindowId.values()].find(
                (entry) =>
                    entry.context.windowKind === "main" &&
                    entry.context.windowId === this.#lastFocusedMainWindowId,
            ) ?? null
        );
    }
}

export const windowRegistry = new WindowRegistry();
