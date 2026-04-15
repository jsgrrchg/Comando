import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserWindow } from "electron";

import { appIdentity } from "@shared/app-identity";
import type { PersistedWindowState } from "@shared/ipc";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));
const rendererDebugSnapshotPath = path.join(
    os.tmpdir(),
    "comando-renderer-snapshot.json",
);
const rendererDebugEventsPath = path.join(
    os.tmpdir(),
    "comando-renderer-events.log",
);

function appendRendererDebugEvent(message: string): void {
    fs.appendFileSync(rendererDebugEventsPath, `${message}\n`, "utf8");
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

    const window = new BrowserWindow({
        title: options.title,
        width: options.restoredState?.width ?? options.width,
        height: options.restoredState?.height ?? options.height,
        x: options.restoredState?.x ?? undefined,
        y: options.restoredState?.y ?? undefined,
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

    window.webContents.on(
        "console-message",
        (_event, level, message, line, sourceId) => {
            appendRendererDebugEvent(
                `[renderer:${options.title}] console(${level}) ${message} (${sourceId}:${line})`,
            );
            console.error(
                `[renderer:${options.title}] console(${level}) ${message} (${sourceId}:${line})`,
            );
        },
    );
    window.webContents.on(
        "did-fail-load",
        (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
            appendRendererDebugEvent(
                `[renderer:${options.title}] did-fail-load code=${errorCode} description=${errorDescription} url=${validatedURL} mainFrame=${String(isMainFrame)}`,
            );
            console.error(
                `[renderer:${options.title}] did-fail-load code=${errorCode} description=${errorDescription} url=${validatedURL} mainFrame=${String(isMainFrame)}`,
            );
        },
    );
    window.webContents.on("render-process-gone", (_event, details) => {
        appendRendererDebugEvent(
            `[renderer:${options.title}] render-process-gone reason=${details.reason} exitCode=${details.exitCode}`,
        );
        console.error(
            `[renderer:${options.title}] render-process-gone reason=${details.reason} exitCode=${details.exitCode}`,
        );
    });
    window.webContents.on("preload-error", (_event, preloadPath, error) => {
        appendRendererDebugEvent(
            `[renderer:${options.title}] preload-error path=${preloadPath} error=${error.message}`,
        );
        console.error(
            `[renderer:${options.title}] preload-error path=${preloadPath} error=${error.message}`,
        );
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
        setTimeout(() => {
            window.webContents
                .executeJavaScript(
                    `
                        (() => {
                            const root = document.getElementById("root");
                            return {
                                bodyChildren: document.body.children.length,
                                bodyTextLength: document.body.innerText.length,
                                preloadFlag: document.documentElement.dataset.comandoPreload ?? null,
                                readyState: document.readyState,
                                rendererBootFlag: document.documentElement.dataset.comandoRenderer ?? null,
                                rendererMountedFlag: document.documentElement.dataset.comandoRendered ?? null,
                                rootChildCount: root?.childElementCount ?? -1,
                                rootHtmlLength: root?.innerHTML.length ?? -1,
                                rootTextLength: root?.innerText.length ?? -1,
                                title: document.title,
                            };
                        })();
                    `,
                    true,
                )
                .then((snapshot) => {
                    fs.writeFileSync(
                        rendererDebugSnapshotPath,
                        `${JSON.stringify(snapshot, null, 2)}\n`,
                        "utf8",
                    );
                    appendRendererDebugEvent(
                        `[renderer:${options.title}] did-finish-load snapshot=${JSON.stringify(snapshot)}`,
                    );
                    console.error(
                        `[renderer:${options.title}] did-finish-load snapshot=${JSON.stringify(snapshot)}`,
                    );
                })
                .catch((error: unknown) => {
                    const message =
                        error instanceof Error
                            ? (error.stack ?? error.message)
                            : String(error);
                    fs.writeFileSync(
                        rendererDebugSnapshotPath,
                        `${JSON.stringify({ error: message }, null, 2)}\n`,
                        "utf8",
                    );
                    appendRendererDebugEvent(
                        `[renderer:${options.title}] did-finish-load inspect-error=${message}`,
                    );
                    console.error(
                        `[renderer:${options.title}] did-finish-load inspect-error=${message}`,
                    );
                });
        }, 1500);
    });

    if (options.restoredState?.isMaximized) {
        window.maximize();
    }

    if (options.restoredState?.isFullScreen) {
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
        minWidth: 1180,
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
