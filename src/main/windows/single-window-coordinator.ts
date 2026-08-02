import type { App, BrowserWindow } from "electron";

export class SingleWindowCoordinator {
    #instanceLockResult: boolean | null = null;
    #mainWindow: BrowserWindow | null = null;

    acquireInstanceLock(application: Pick<App, "requestSingleInstanceLock">): boolean {
        if (this.#instanceLockResult !== null) {
            return this.#instanceLockResult;
        }
        this.#instanceLockResult = application.requestSingleInstanceLock();
        return this.#instanceLockResult;
    }

    getMainWindow(): BrowserWindow | null {
        if (this.#mainWindow?.isDestroyed()) {
            this.#mainWindow = null;
        }
        return this.#mainWindow;
    }

    ensureMainWindow(create: () => BrowserWindow): BrowserWindow {
        const existing = this.getMainWindow();
        if (existing) {
            this.focusMainWindow();
            return existing;
        }
        const window = create();
        this.registerMainWindow(window);
        return window;
    }

    registerMainWindow(window: BrowserWindow): void {
        const existing = this.getMainWindow();
        if (existing && existing !== window) {
            throw new Error("A canonical main window is already registered.");
        }
        this.#mainWindow = window;
        window.once("closed", () => {
            if (this.#mainWindow === window) {
                this.#mainWindow = null;
            }
        });
    }

    focusMainWindow(): boolean {
        const window = this.getMainWindow();
        if (!window) {
            return false;
        }
        if (window.isMinimized()) {
            window.restore();
        }
        window.show();
        window.focus();
        return true;
    }
}

export const singleWindowCoordinator = new SingleWindowCoordinator();
