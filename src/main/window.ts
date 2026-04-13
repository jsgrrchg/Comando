import path from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserWindow } from "electron";

import { appIdentity } from "@shared/app-identity";
import type { PersistedWindowState } from "@shared/ipc";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));

export function createMainWindow(
    restoredState: PersistedWindowState | null = null,
): BrowserWindow {
    const isMac = process.platform === "darwin";
    const isWindows = process.platform === "win32";

    const window = new BrowserWindow({
        title: appIdentity.windowTitle,
        width: restoredState?.width ?? 1480,
        height: restoredState?.height ?? 960,
        x: restoredState?.x ?? undefined,
        y: restoredState?.y ?? undefined,
        minWidth: 1180,
        minHeight: 760,
        backgroundColor: isMac ? "#00000000" : "#f3f4f7",
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
        void window.loadURL(process.env.ELECTRON_RENDERER_URL);
    } else {
        void window.loadFile(path.join(rootDir, "out/renderer/index.html"));
    }

    if (restoredState?.isMaximized) {
        window.maximize();
    }

    if (restoredState?.isFullScreen) {
        window.setFullScreen(true);
    }

    return window;
}
