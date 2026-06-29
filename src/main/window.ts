import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserWindow, nativeTheme, screen, shell } from "electron";

import type { PersistedWindowState } from "@shared/ipc";

import { appIdentity } from "./app-runtime";
import { debugBenignError } from "./observability/logging";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));
const MIN_VISIBLE_RESTORE_OVERLAP = 80;

export const DESKTOP_TITLE_BAR_HEIGHT = 40;

type WindowKind = "main" | "settings";

const nativeTitleBarOverlayWindows = new WeakSet<BrowserWindow>();

function supportsNativeTitleBarOverlay(): boolean {
    return process.platform === "win32" || process.platform === "linux";
}

function resolveDesktopTitleBarOverlay(): Electron.TitleBarOverlayOptions {
    const isDark = nativeTheme.shouldUseDarkColors;
    return {
        color: "#00000000",
        height: DESKTOP_TITLE_BAR_HEIGHT,
        symbolColor: isDark ? "#e8e8e8" : "#1c1c1c",
    };
}

function resolveWindowIconPath(): string | undefined {
    if (process.platform !== "win32" && process.platform !== "linux") {
        return undefined;
    }

    const iconFileName =
        process.platform === "win32" ? "windows.ico" : "app.png";
    const devIconPath =
        process.platform === "win32"
            ? path.join(rootDir, appIdentity.iconPaths.windows)
            : path.join(rootDir, appIdentity.iconPaths.png);
    const packagedIconPath = path.join(
        process.resourcesPath,
        "icons",
        iconFileName,
    );
    if (fs.existsSync(packagedIconPath)) {
        return packagedIconPath;
    }

    if (fs.existsSync(devIconPath)) {
        return devIconPath;
    }

    return undefined;
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
    readonly transparencyEnabled?: boolean;
    readonly width: number;
}): BrowserWindow {
    const isMac = process.platform === "darwin";
    const isWindows = process.platform === "win32";
    const hasNativeTitleBarOverlay = supportsNativeTitleBarOverlay();
    const restoredState = normalizeRestoredState(options.restoredState);
    const usesNativeTransparency = options.transparencyEnabled !== false;
    const isAcrylic = isWindows && usesNativeTransparency;
    const isMacVibrant = isMac && usesNativeTransparency;

    const titleBarOverlay = hasNativeTitleBarOverlay
        ? resolveDesktopTitleBarOverlay()
        : undefined;
    const icon = resolveWindowIconPath();

    const window = new BrowserWindow({
        title: options.title,
        icon,
        width: restoredState?.width ?? options.width,
        height: restoredState?.height ?? options.height,
        x: restoredState?.x ?? undefined,
        y: restoredState?.y ?? undefined,
        minWidth: options.minWidth,
        minHeight: options.minHeight,
        backgroundColor:
            isMacVibrant || isAcrylic ? "#00000000" : options.backgroundColor,
        backgroundMaterial: isAcrylic ? "acrylic" : undefined,
        titleBarOverlay,
        titleBarStyle: isMac
            ? "hiddenInset"
            : hasNativeTitleBarOverlay
              ? "hidden"
              : "default",
        trafficLightPosition: isMac
            ? (options.trafficLightPosition ?? { x: 18, y: 18 })
            : undefined,
        vibrancy: isMacVibrant ? "sidebar" : undefined,
        visualEffectState: isMacVibrant ? "active" : undefined,
        webPreferences: {
            preload: path.join(rootDir, "out/preload/index.cjs"),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    if (hasNativeTitleBarOverlay) {
        nativeTitleBarOverlayWindows.add(window);
    }

    window.webContents.setWindowOpenHandler(({ url }) => {
        if (openExternalHttpUrl(url)) {
            return { action: "deny" };
        }

        return { action: "deny" };
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

function openExternalHttpUrl(url: string): boolean {
    try {
        const parsedUrl = new URL(url);
        if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
            return false;
        }

        void shell.openExternal(parsedUrl.toString());
        return true;
    } catch {
        return false;
    }
}

export function createMainWindow(
    restoredState: PersistedWindowState | null = null,
    transparencyEnabled = true,
): BrowserWindow {
    return createBaseWindow({
        backgroundColor: "#ffffff",
        height: 960,
        kind: "main",
        minHeight: 760,
        minWidth: 700,
        restoredState,
        title: appIdentity.windowTitle,
        transparencyEnabled,
        width: 1480,
    });
}

export function createSettingsWindow(
    projectId: string | null = null,
    transparencyEnabled = true,
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
        transparencyEnabled,
        width: 980,
    });
}

export function applyWindowTransparencyToWindow(
    window: BrowserWindow,
    transparencyEnabled: boolean,
): void {
    if (process.platform === "win32") {
        window.setBackgroundMaterial(
            transparencyEnabled ? "acrylic" : "none",
        );
        return;
    }

    if (process.platform !== "darwin") {
        return;
    }

    window.setVibrancy(transparencyEnabled ? "sidebar" : null);
}

export function refreshWindowsTitleBarOverlays(): void {
    if (!supportsNativeTitleBarOverlay()) {
        return;
    }

    const overlay = resolveDesktopTitleBarOverlay();

    forEachLiveWindow((window) => {
        if (!nativeTitleBarOverlayWindows.has(window)) return;
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
