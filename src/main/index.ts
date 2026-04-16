import {
    app,
    BrowserWindow,
    MessageChannelMain,
    type MessagePortMain,
} from "electron";

import { APP_ZOOM_FACTOR_DEFAULT, stepAppZoomFactor } from "@shared/app-zoom";
import { appIdentity } from "@shared/app-identity";
import {
    IPC_EVENTS,
    type AiRuntimeStatus,
    type AiSessionUpdate,
    type AppBootstrapSnapshot,
    type GitRepositoryInvalidation,
    type GitRepositorySnapshot,
    type OpenProjectWindowInput,
    type PersistenceSnapshot,
    type ProjectTreeInvalidation,
    type TerminalDataEvent,
    type TerminalExitEvent,
    type WindowContextSnapshot,
} from "@shared/ipc";

import type { SecretStoreGateway } from "./ai/secret-store";
import { AiService } from "./ai/service";
import { createDbWorkerClient, type DbWorkerClient } from "./db/client";
import { createGitWorkerClient, type GitWorkerClient } from "./git";
import { installApplicationMenu } from "./menu";
import { mainProcessPerformance } from "./observability/performance";
import type { PersistenceGateway } from "./persistence/service";
import { createProjectWorkerClient } from "./projects/client";
import { ProjectService } from "./projects/service";
import { registerIpcHandlers } from "./ipc";
import type { SettingsGateway } from "./settings/service";
import {
    applyAppZoomToWindow,
    broadcastSettingsUpdated,
} from "./settings/window-zoom";
import { openSettingsWindow } from "./settings/window";
import { TerminalService } from "./terminals/service";
import { createMainWindow } from "./window";
import { windowRegistry } from "./windows/registry";
import type { WorkspaceGateway } from "./workspace/service";

let dbWorkerClient: DbWorkerClient | null = null;
let bootstrapSnapshot: AppBootstrapSnapshot | null = null;
let aiService: AiService | null = null;
let persistenceService: PersistenceGateway | null = null;
let projectService: ProjectService | null = null;
let gitService: GitWorkerClient | null = null;
let secretStore: SecretStoreGateway | null = null;
let settingsService: SettingsGateway | null = null;
let terminalService: TerminalService | null = null;
let workspaceService: WorkspaceGateway | null = null;
let isQuitting = false;
const aiSessionStreamPorts = new Map<string, MessagePortMain>();

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
    app.quit();
} else {
    app.on("second-instance", () => {
        const mainWindow =
            windowRegistry.getFocusedMainWindow() ??
            windowRegistry.getMostRecentMainWindow();

        if (mainWindow) {
            focusExistingWindow(mainWindow);
            return;
        }

        void openNewMainWindow(null);
    });

    void app
        .whenReady()
        .then(async () => {
            mainProcessPerformance.markAppWhenReady();
            dbWorkerClient = await createDbWorkerClient({
                dataDir: app.getPath("userData"),
            });
            persistenceService = dbWorkerClient.persistence;
            secretStore = dbWorkerClient.secretStore;
            settingsService = dbWorkerClient.settings;
            gitService = await createGitWorkerClient();
            const projectWorker = await createProjectWorkerClient({
                onProjectTreeInvalidated: (payload) => {
                    projectService?.handleProjectTreeInvalidation(payload);
                },
                onWorkerRestarted: () => {
                    projectService?.handleProjectWorkerRestarted();
                },
            });
            projectService = new ProjectService({
                onProjectTreeInvalidated: (payload) => {
                    broadcastProjectTreeInvalidation(payload);
                    broadcastProjectGitInvalidation(payload);
                },
                onProjectTouched:
                    process.platform === "darwin"
                        ? (projectPath) => {
                              try {
                                  app.addRecentDocument(projectPath);
                              } catch {
                                  // Ignore non-critical operating system errors.
                              }
                          }
                        : undefined,
                store: dbWorkerClient.projectStore,
                worker: projectWorker,
            });
            aiService = new AiService({
                onRuntimeStatus: broadcastAiRuntimeStatus,
                onSessionSnapshot: broadcastAiSessionSnapshot,
                persistence: dbWorkerClient.aiPersistence,
                projectService,
                secretStore,
                settingsService,
            });
            terminalService = new TerminalService({
                onData: broadcastTerminalData,
                onExit: broadcastTerminalExit,
                projectService,
            });
            workspaceService = dbWorkerClient.workspace;

            bootstrapSnapshot = {
                app: appIdentity,
                database: dbWorkerClient.status,
                platform: process.platform,
                startedAt: new Date().toISOString(),
                versions: {
                    chrome: process.versions.chrome,
                    electron: process.versions.electron,
                    node: process.versions.node,
                },
            };

            registerIpcHandlers({
                aiService,
                getSnapshot: () => {
                    if (!bootstrapSnapshot) {
                        throw new Error(
                            "The initial bootstrap snapshot is not available yet.",
                        );
                    }

                    return bootstrapSnapshot;
                },
                persistenceService,
                gitService,
                openProjectWindow: (input) => {
                    openOrFocusProjectWindow(input);
                },
                projectService,
                settingsService,
                terminalService,
                workspaceService,
            });

            installApplicationMenu({
                adjustAppZoom: (direction) => {
                    updateAppZoom(direction);
                },
                closeFocusedWindowSurface: () => {
                    const focusedWindow = BrowserWindow.getFocusedWindow();
                    if (!focusedWindow) {
                        return;
                    }

                    const context =
                        windowRegistry.getContextByBrowserWindow(focusedWindow);
                    if (context?.windowKind === "main") {
                        focusedWindow.webContents.send(
                            IPC_EVENTS.workspaceCloseActiveTab,
                        );
                        return;
                    }

                    focusedWindow.close();
                },
                focusProjectWindow: (projectId) => {
                    const existingWindow =
                        windowRegistry.getMainWindowByProjectId(projectId);
                    if (!existingWindow) {
                        return false;
                    }

                    focusExistingWindow(existingWindow);
                    return true;
                },
                getFocusedMainWindowContext: () => {
                    const mainWindow = windowRegistry.getFocusedMainWindow();
                    return mainWindow
                        ? windowRegistry.getContextByBrowserWindow(mainWindow)
                        : null;
                },
                openNewMainWindow: (projectId) => {
                    void openNewMainWindow(projectId ?? null);
                },
                openSettingsWindow: (projectId) =>
                    openSettingsWindow(
                        { projectId },
                        loadCurrentAppZoomFactor(),
                    ),
            });

            restoreMainWindows();

            app.on("activate", () => {
                if (windowRegistry.listMainWindowContexts().length === 0) {
                    void openNewMainWindow(null);
                }
            });
        })
        .catch((error) => {
            console.error("[main] Failed to initialize the application", error);
            app.quit();
        });
}

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        app.quit();
    }
});

app.on("before-quit", () => {
    isQuitting = true;
});

app.on("will-quit", () => {
    for (const windowId of [...aiSessionStreamPorts.keys()]) {
        detachAiSessionStream(windowId);
    }

    mainProcessPerformance.flush();
    mainProcessPerformance.stop();
    aiService?.close();
    aiService = null;
    void gitService?.close();
    gitService = null;
    projectService?.close();
    projectService = null;
    terminalService?.close();
    terminalService = null;
    persistenceService = null;
    secretStore = null;
    settingsService = null;
    workspaceService = null;
    void dbWorkerClient?.close();
    dbWorkerClient = null;
});

function restoreMainWindows(): void {
    const snapshots =
        persistenceService?.listRestorableMainWindowSnapshots() ?? [];
    if (snapshots.length === 0) {
        void openNewMainWindow(null);
        return;
    }

    for (const snapshot of snapshots) {
        createTrackedMainWindow(snapshot);
    }
}

async function openNewMainWindow(projectId: string | null): Promise<void> {
    await openNewMainWindowWithOptions({
        projectId,
    });
}

function openOrFocusProjectWindow(input: OpenProjectWindowInput): void {
    if (!persistenceService) {
        return;
    }

    const existingWindow = windowRegistry.getMainWindowByProjectId(
        input.projectId,
    );
    if (!existingWindow) {
        void openNewMainWindowWithOptions({
            projectId: input.projectId,
            worktreeId: input.worktreeId,
        });
        return;
    }

    const context = windowRegistry.getContextByBrowserWindow(existingWindow);
    if (!context || context.windowKind !== "main") {
        focusExistingWindow(existingWindow);
        return;
    }

    if (input.worktreeId !== undefined) {
        persistenceService.saveActiveProjectId(
            context.windowId,
            input.projectId,
            input.worktreeId ?? null,
        );
        windowRegistry.updateMainWindowProjectId(
            context.windowId,
            input.projectId,
            input.worktreeId ?? null,
        );
    }

    focusExistingWindow(existingWindow);

    if (input.worktreeId !== undefined || input.branchName !== undefined) {
        existingWindow.webContents.send(
            IPC_EVENTS.projectWindowRequested,
            input,
        );
    }
}

async function openNewMainWindowWithOptions(input: {
    readonly projectId: string | null;
    readonly worktreeId?: string | null;
}): Promise<void> {
    if (!persistenceService) {
        return;
    }

    if (input.projectId) {
        const existingWindow = windowRegistry.getMainWindowByProjectId(
            input.projectId,
        );
        if (existingWindow) {
            focusExistingWindow(existingWindow);
            return;
        }
    }

    const focusedMainWindow = windowRegistry.getFocusedMainWindow();
    const sourceContext = focusedMainWindow
        ? windowRegistry.getContextByBrowserWindow(focusedMainWindow)
        : null;
    const sourceShellState =
        sourceContext?.windowKind === "main"
            ? persistenceService.loadSnapshot(sourceContext.windowId).shellState
            : undefined;
    const snapshot = await persistenceService.createMainWindowSession(
        sourceShellState === undefined
            ? {
                  projectId: input.projectId,
                  worktreeId: input.worktreeId,
              }
            : {
                  projectId: input.projectId,
                  shellState: sourceShellState,
                  worktreeId: input.worktreeId,
              },
    );

    createTrackedMainWindow(snapshot);
}

function createTrackedMainWindow(snapshot: PersistenceSnapshot): BrowserWindow {
    if (
        !snapshot.windowContext ||
        snapshot.windowContext.windowKind !== "main"
    ) {
        throw new Error(
            "A main window snapshot requires a main window context.",
        );
    }

    const window = createMainWindow(snapshot.windowState);
    const context = snapshot.windowContext;

    window.webContents.once("did-finish-load", () => {
        mainProcessPerformance.markFirstMainWindowReady();
    });
    window.webContents.on("did-finish-load", () => {
        attachAiSessionStream(window, context.windowId);
    });

    applyAppZoomToWindow(window, loadCurrentAppZoomFactor());
    windowRegistry.register(window, context);
    attachMainWindowLifecycle(window, context);
    persistenceService?.markWindowOpen(context.windowId);
    updateMainWindowTitle(window, context.projectId);

    return window;
}

function loadCurrentAppZoomFactor(): number {
    return (
        settingsService?.loadAppAppearanceSettings().zoomFactor ??
        APP_ZOOM_FACTOR_DEFAULT
    );
}

function persistAppAppearanceSettings(): void {
    if (!settingsService) {
        return;
    }

    const snapshot = settingsService.loadSnapshot();
    const appearance = snapshot.appearance;
    if (appearance) {
        for (const window of BrowserWindow.getAllWindows()) {
            applyAppZoomToWindow(window, appearance.zoomFactor);
        }
    }

    broadcastSettingsUpdated(appearance ?? null, snapshot.editor ?? null);
}

function updateAppZoom(direction: "decrease" | "increase" | "reset"): void {
    if (!settingsService) {
        return;
    }

    const currentAppearance = settingsService.loadAppAppearanceSettings();
    settingsService.saveAppAppearanceSettings({
        ...currentAppearance,
        zoomFactor: stepAppZoomFactor(currentAppearance.zoomFactor, direction),
    });
    persistAppAppearanceSettings();
}

function attachMainWindowLifecycle(
    window: BrowserWindow,
    context: WindowContextSnapshot,
): void {
    let timeout: NodeJS.Timeout | null = null;

    const persistWindowState = () => {
        if (!persistenceService) {
            return;
        }

        const bounds = window.getBounds();
        persistenceService.saveWindowState({
            height: bounds.height,
            id: context.windowId,
            isFullScreen: window.isFullScreen(),
            isMaximized: window.isMaximized(),
            width: bounds.width,
            x: bounds.x,
            y: bounds.y,
        });
    };

    const schedulePersist = () => {
        if (timeout) {
            clearTimeout(timeout);
        }

        timeout = setTimeout(() => {
            persistWindowState();
            timeout = null;
        }, 140);
    };

    window.on("focus", () => {
        persistenceService?.markWindowOpen(context.windowId);
    });
    window.webContents.on("did-start-loading", () => {
        detachAiSessionStream(context.windowId);
    });
    window.on("resize", schedulePersist);
    window.on("move", schedulePersist);
    window.on("maximize", schedulePersist);
    window.on("unmaximize", schedulePersist);
    window.on("enter-full-screen", schedulePersist);
    window.on("leave-full-screen", schedulePersist);
    window.on("close", persistWindowState);
    window.on("closed", () => {
        if (timeout) {
            clearTimeout(timeout);
        }

        detachAiSessionStream(context.windowId);

        if (!isQuitting) {
            persistenceService?.markWindowClosed(context.windowId);
        }

        terminalService?.closeOwnedByWindow(context.windowId);
        aiService?.closeOwnedByWindow(context.windowId);
    });
    window.webContents.on("render-process-gone", () => {
        detachAiSessionStream(context.windowId);
        persistWindowState();

        if (window.isDestroyed()) {
            return;
        }

        setTimeout(() => {
            if (!window.isDestroyed()) {
                void window.reload();
            }
        }, 120);
    });

    persistWindowState();
}

function updateMainWindowTitle(
    window: BrowserWindow,
    projectId: string | null,
): void {
    if (!projectId || !projectService) {
        window.setTitle(appIdentity.windowTitle);
        return;
    }

    try {
        const rootPath = projectService.getProjectRootPath(projectId);
        const projectName =
            rootPath.split(/[\\/]/).filter(Boolean).at(-1) ?? projectId;
        window.setTitle(`${appIdentity.windowTitle} · ${projectName}`);
    } catch {
        window.setTitle(appIdentity.windowTitle);
    }
}

function focusExistingWindow(window: BrowserWindow): void {
    if (window.isMinimized()) {
        window.restore();
    }
    window.show();
    window.focus();
}

function broadcastProjectTreeInvalidation(
    payload: ProjectTreeInvalidation,
): void {
    for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(IPC_EVENTS.projectTreeInvalidated, payload);
    }
}

function broadcastProjectGitInvalidation(
    payload: ProjectTreeInvalidation,
): void {
    if (!projectService || !gitService) {
        return;
    }

    const worktrees =
        payload.worktreeId !== undefined
            ? [
                  {
                      id:
                          payload.worktreeId ??
                          projectService.getPrimaryWorktreeId(
                              payload.projectId,
                          ),
                      rootPath: projectService.getProjectRootPath(
                          payload.projectId,
                          payload.worktreeId ?? null,
                      ),
                  },
              ]
            : projectService
                  .listProjectWorktrees(payload.projectId)
                  .map((worktree) => ({
                      id: worktree.id,
                      rootPath: worktree.rootPath,
                  }));

    for (const worktree of worktrees) {
        gitService.invalidate(worktree.rootPath);
        broadcastGitRepositoryInvalidated({
            occurredAt: payload.occurredAt,
            projectId: payload.projectId,
            reason: "filesystem",
            rootPath: worktree.rootPath,
            worktreeId: worktree.id ?? null,
        });
    }
}

function broadcastGitRepositoryInvalidated(
    payload: GitRepositoryInvalidation,
): void {
    for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(IPC_EVENTS.gitRepositoryInvalidated, payload);
    }
}

export function broadcastGitRepositorySnapshotUpdated(
    payload: GitRepositorySnapshot,
): void {
    for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(
            IPC_EVENTS.gitRepositorySnapshotUpdated,
            payload,
        );
    }
}

export function broadcastGitWorktreesUpdated(
    payload: GitRepositoryInvalidation,
): void {
    for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(IPC_EVENTS.gitWorktreesUpdated, payload);
    }
}

function broadcastAiRuntimeStatus(payload: AiRuntimeStatus): void {
    for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(IPC_EVENTS.aiRuntimeStatus, payload);
    }
}

function broadcastAiSessionSnapshot(
    ownerWindowId: string,
    payload: AiSessionUpdate,
): void {
    mainProcessPerformance.recordAiSessionUpdate(payload);

    if (!ownerWindowId) {
        for (const window of BrowserWindow.getAllWindows()) {
            dispatchAiSessionSnapshot(window, payload);
        }
        return;
    }

    const targetWindow = windowRegistry.getWindowByStableId(ownerWindowId);
    if (targetWindow) {
        dispatchAiSessionSnapshot(targetWindow, payload, ownerWindowId);
    }
}

function attachAiSessionStream(window: BrowserWindow, windowId: string): void {
    if (window.isDestroyed()) {
        detachAiSessionStream(windowId);
        return;
    }

    detachAiSessionStream(windowId);

    const channel = new MessageChannelMain();

    try {
        window.webContents.postMessage(IPC_EVENTS.aiSessionStreamPort, null, [
            channel.port2,
        ]);
        aiSessionStreamPorts.set(windowId, channel.port1);
    } catch {
        channel.port1.close();
        channel.port2.close();
    }
}

function detachAiSessionStream(windowId: string): void {
    const port = aiSessionStreamPorts.get(windowId);
    if (!port) {
        return;
    }

    aiSessionStreamPorts.delete(windowId);
    port.close();
}

function dispatchAiSessionSnapshot(
    window: BrowserWindow,
    payload: AiSessionUpdate,
    windowId?: string,
): void {
    const stableWindowId =
        windowId ??
        windowRegistry.getContextByBrowserWindow(window)?.windowId ??
        null;

    if (stableWindowId) {
        const port = aiSessionStreamPorts.get(stableWindowId);
        if (port) {
            try {
                port.postMessage(payload);
                return;
            } catch {
                detachAiSessionStream(stableWindowId);
            }
        }
    }

    window.webContents.send(IPC_EVENTS.aiSessionSnapshot, payload);
}

function broadcastTerminalData(
    ownerWindowId: string,
    payload: TerminalDataEvent,
): void {
    const targetWindow = windowRegistry.getWindowByStableId(ownerWindowId);
    targetWindow?.webContents.send(IPC_EVENTS.terminalData, payload);
}

function broadcastTerminalExit(
    ownerWindowId: string,
    payload: TerminalExitEvent,
): void {
    const targetWindow = windowRegistry.getWindowByStableId(ownerWindowId);
    targetWindow?.webContents.send(IPC_EVENTS.terminalExit, payload);
}
