import path from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserWindow, screen } from "electron";

import type { PersistedWindowState } from "@shared/ipc";

import { appIdentity } from "./app-runtime";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));
const MIN_VISIBLE_RESTORE_OVERLAP = 80;

function normalizeRestoredState(
    restoredState: PersistedWindowState | null | undefined,
): PersistedWindowState | null | undefined {
    if (
        !restoredState ||
        restoredState.x === null ||
        restoredState.y === null
    ) {
        return restoredState;
    }

    const right = restoredState.x + restoredState.width;
    const bottom = restoredState.y + restoredState.height;

    const hasVisibleOverlap = screen.getAllDisplays().some((display) => {
        const area = display.workArea;
        const overlapWidth =
            Math.min(right, area.x + area.width) -
            Math.max(restoredState.x ?? area.x, area.x);
        const overlapHeight =
            Math.min(bottom, area.y + area.height) -
            Math.max(restoredState.y ?? area.y, area.y);

        return (
            overlapWidth >= MIN_VISIBLE_RESTORE_OVERLAP &&
            overlapHeight >= MIN_VISIBLE_RESTORE_OVERLAP
        );
    });

    if (hasVisibleOverlap) {
        return restoredState;
    }

    return {
        ...restoredState,
        x: null,
        y: null,
    };
}

function createBaseWindow(options: {
    readonly backgroundColor: string;
    readonly height: number;
    readonly minHeight: number;
    readonly minWidth: number;
    readonly restoredState?: PersistedWindowState | null;
    readonly search?: string;
    readonly title: string;
    readonly width: number;
}): BrowserWindow {
    const isMac = process.platform === "darwin";
    const isWindows = process.platform === "win32";
    const restoredState = normalizeRestoredState(options.restoredState);

    const window = new BrowserWindow({
        title: options.title,
        width: restoredState?.width ?? options.width,
        height: restoredState?.height ?? options.height,
        x: restoredState?.x ?? undefined,
        y: restoredState?.y ?? undefined,
        minWidth: options.minWidth,
        minHeight: options.minHeight,
        backgroundColor: isMac ? "#00000000" : options.backgroundColor,
        titleBarOverlay: isWindows
            ? {
                  color: "#f5f5f5",
                  height: 44,
                  symbolColor: "#1c1c1c",
              }
            : undefined,
        titleBarStyle: isMac ? "hiddenInset" : isWindows ? "hidden" : "default",
        trafficLightPosition: isMac ? { x: 18, y: 18 } : undefined,
        vibrancy: isMac ? "sidebar" : undefined,
        visualEffectState: isMac ? "active" : undefined,
        webPreferences: {
            preload: path.join(rootDir, "out/preload/index.cjs"),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    if (process.env.ELECTRON_RENDERER_URL) {
        const url = new URL(process.env.ELECTRON_RENDERER_URL);
        url.search = options.search ?? "";
        void window.loadURL(url.toString());
    } else {
        void window.loadFile(path.join(rootDir, "out/renderer/index.html"), {
            search: options.search,
        });
    }

    window.webContents.on("did-finish-load", () => {
        window.setTitle(options.title);
    });

    if (restoredState?.isMaximized) {
        window.maximize();
    }

    if (restoredState?.isFullScreen) {
        window.setFullScreen(true);
    }

    return window;
}

export function createMainWindow(
    restoredState: PersistedWindowState | null = null,
): BrowserWindow {
    return createBaseWindow({
        backgroundColor: "#ffffff",
        height: 960,
        minHeight: 760,
        minWidth: 700,
        restoredState,
        title: appIdentity.windowTitle,
        width: 1480,
    });
}

export function createSettingsWindow(
    projectId: string | null = null,
): BrowserWindow {
    const searchParams = new URLSearchParams({
        window: "settings",
    });

    if (projectId) {
        searchParams.set("projectId", projectId);
    }

    return createBaseWindow({
        backgroundColor: "#eef0f3",
        height: 720,
        minHeight: 560,
        minWidth: 780,
        search: `?${searchParams.toString()}`,
        title: `${appIdentity.name} Settings`,
        width: 980,
    });
}
