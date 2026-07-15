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
    readonly #embeddedContextsByWebContentsId = new Map<
        number,
        WindowContextSnapshot
    >();
    readonly #embeddedWebContentsById = new Map<number, WebContents>();
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
        const embeddedContext = this.#embeddedContextsByWebContentsId.get(
            webContents.id,
        );
        if (embeddedContext) {
            return embeddedContext;
        }
        const window = BrowserWindow.fromWebContents(webContents);
        return window ? this.getContextByBrowserWindow(window) : null;
    }

    registerEmbeddedRenderer(
        webContents: WebContents,
        context: WindowContextSnapshot,
    ): void {
        this.#embeddedContextsByWebContentsId.set(webContents.id, context);
        this.#embeddedWebContentsById.set(webContents.id, webContents);
    }

    unregisterEmbeddedRenderer(webContents: WebContents): void {
        this.#embeddedContextsByWebContentsId.delete(webContents.id);
        this.#embeddedWebContentsById.delete(webContents.id);
    }

    getWebContentsByOwnerId(ownerId: string): WebContents | null {
        for (const webContents of this.#embeddedWebContentsById.values()) {
            const context = this.#embeddedContextsByWebContentsId.get(
                webContents.id,
            );
            if (context?.windowId === ownerId && !webContents.isDestroyed()) {
                return webContents;
            }
        }

        const window = this.getWindowByStableId(ownerId);
        return window && !window.webContents.isDestroyed()
            ? window.webContents
            : null;
    }

    forEachLiveWebContents(
        callback: (webContents: WebContents) => void,
    ): void {
        const seen = new Set<number>();
        for (const entry of this.#entriesByBrowserWindowId.values()) {
            if (!entry.window.webContents.isDestroyed()) {
                seen.add(entry.window.webContents.id);
                callback(entry.window.webContents);
            }
        }
        for (const webContents of this.#embeddedWebContentsById.values()) {
            if (!webContents.isDestroyed() && !seen.has(webContents.id)) {
                callback(webContents);
            }
        }
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
