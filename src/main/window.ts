import path from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserWindow, nativeTheme, screen } from "electron";

import type { PersistedWindowState } from "@shared/ipc";

import { appIdentity } from "./app-runtime";
import { debugBenignError } from "./observability/logging";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));
const MIN_VISIBLE_RESTORE_OVERLAP = 80;

export const WINDOWS_TITLE_BAR_HEIGHT = 40;

type WindowKind = "main" | "settings";

const acrylicWindows = new WeakSet<BrowserWindow>();

function resolveWindowsTitleBarOverlay(): Electron.TitleBarOverlayOptions {
    const isDark = nativeTheme.shouldUseDarkColors;
    return {
        color: "#00000000",
        height: WINDOWS_TITLE_BAR_HEIGHT,
        symbolColor: isDark ? "#e8e8e8" : "#1c1c1c",
    };
}

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
    readonly kind: WindowKind;
    readonly minHeight: number;
    readonly minWidth: number;
    readonly restoredState?: PersistedWindowState | null;
    readonly search?: string;
    readonly title: string;
    readonly trafficLightPosition?: { x: number; y: number };
    readonly width: number;
}): BrowserWindow {
    const isMac = process.platform === "darwin";
    const isWindows = process.platform === "win32";
    const restoredState = normalizeRestoredState(options.restoredState);
    const isAcrylicMain = isWindows && options.kind === "main";

    const titleBarOverlay = isWindows
        ? isAcrylicMain
            ? resolveWindowsTitleBarOverlay()
            : {
                  color: "#f5f5f5",
                  height: 44,
                  symbolColor: "#1c1c1c",
              }
        : undefined;

    const window = new BrowserWindow({
        title: options.title,
        width: restoredState?.width ?? options.width,
        height: restoredState?.height ?? options.height,
        x: restoredState?.x ?? undefined,
        y: restoredState?.y ?? undefined,
        minWidth: options.minWidth,
        minHeight: options.minHeight,
        backgroundColor: isMac
            ? "#00000000"
            : isAcrylicMain
              ? "#00000000"
              : options.backgroundColor,
        backgroundMaterial: isAcrylicMain ? "acrylic" : undefined,
        titleBarOverlay,
        titleBarStyle: isMac ? "hiddenInset" : isWindows ? "hidden" : "default",
        trafficLightPosition: isMac
            ? (options.trafficLightPosition ?? { x: 18, y: 18 })
            : undefined,
        vibrancy: isMac ? "sidebar" : undefined,
        visualEffectState: isMac ? "active" : undefined,
        webPreferences: {
            preload: path.join(rootDir, "out/preload/index.cjs"),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    if (isAcrylicMain) {
        acrylicWindows.add(window);
    }

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
        kind: "main",
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
        kind: "settings",
        minHeight: 560,
        minWidth: 780,
        search: `?${searchParams.toString()}`,
        title: `${appIdentity.name} Settings`,
        trafficLightPosition: { x: 14, y: 14 },
        width: 980,
    });
}

export function refreshWindowsTitleBarOverlays(): void {
    if (process.platform !== "win32") {
        return;
    }

    const overlay = resolveWindowsTitleBarOverlay();

    forEachLiveWindow((window) => {
        if (!acrylicWindows.has(window)) return;
        try {
            if (window.isDestroyed()) return;
            window.setTitleBarOverlay(overlay);
        } catch (error) {
            // Older Windows builds may reject overlay updates, and the window
            // may also be torn down between the re-check and the native call.
            debugBenignError("window.setTitleBarOverlay", error);
        }
    });
}

// Snapshot windows before iterating so that a window destroyed mid-iteration
// cannot leave us indexing into a mutated live array, and skip destroyed
// entries so callers never invoke `webContents` on a torn-down window.
export function forEachLiveWindow(
    callback: (window: BrowserWindow) => void,
): void {
    const windows = [...BrowserWindow.getAllWindows()];
    for (const window of windows) {
        if (window.isDestroyed()) continue;
        callback(window);
    }
}
