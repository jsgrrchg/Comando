import {
    app,
    BrowserWindow,
    MessageChannelMain,
    type MessagePortMain,
} from "electron";

import { APP_ZOOM_FACTOR_DEFAULT, stepAppZoomFactor } from "@shared/app-zoom";
import {
    IPC_EVENTS,
    type AiRuntimeStatus,
    type AiSessionDomainEvent,
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

import { appChannel, appIdentity, configureMainProcessApp } from "./app-runtime";
import {
    createAiWorkerClient,
    type AiWorkerClient,
} from "./ai/client";
import type { SecretStoreGateway } from "./ai/secret-store";
import { AiService } from "./ai/service";
import { createDbWorkerClient, type DbWorkerClient } from "./db/client";
import { createGitWorkerClient, type GitWorkerClient } from "./git";
import { GitHubService } from "./github/service";
import {
    installFilePreviewProtocol,
    registerFilePreviewSchemes,
} from "./file-preview-protocol";
import { installApplicationMenu } from "./menu";
import { debugBenignError } from "./observability/logging";
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
import { initializeAutoUpdates } from "./updater";
import { createMainWindow, forEachLiveWindow } from "./window";
import { windowRegistry } from "./windows/registry";
import type { WorkspaceGateway } from "./workspace/service";

let dbWorkerClient: DbWorkerClient | null = null;
let bootstrapSnapshot: AppBootstrapSnapshot | null = null;
let aiService: AiService | null = null;
let aiWorkerClient: AiWorkerClient | null = null;
let persistenceService: PersistenceGateway | null = null;
let projectService: ProjectService | null = null;
let gitService: GitWorkerClient | null = null;
let githubService: GitHubService | null = null;
let secretStore: SecretStoreGateway | null = null;
let settingsService: SettingsGateway | null = null;
let terminalService: TerminalService | null = null;
let workspaceService: WorkspaceGateway | null = null;
let isQuitting = false;
let isFinalizingQuit = false;
let pendingShutdown: Promise<void> | null = null;
const aiSessionStreamPorts = new Map<string, MessagePortMain>();

configureMainProcessApp();
registerFilePreviewSchemes();

const shouldUseSingleInstanceLock = appChannel === "release";
const hasSingleInstanceLock = shouldUseSingleInstanceLock
    ? app.requestSingleInstanceLock()
    : true;

if (!hasSingleInstanceLock) {
    app.quit();
} else {
    if (shouldUseSingleInstanceLock) {
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
    }

    void app
        .whenReady()
        .then(async () => {
            mainProcessPerformance.markAppWhenReady();
            installFilePreviewProtocol();
            dbWorkerClient = await createDbWorkerClient({
                appWindowTitle: appIdentity.windowTitle,
                dataDir: app.getPath("userData"),
            });
            persistenceService = dbWorkerClient.persistence;
            secretStore = dbWorkerClient.secretStore;
            githubService = new GitHubService({ secretStore });
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
                              } catch (error) {
                                  // Non-critical OS call; log at debug level.
                                  debugBenignError(
                                      "app.addRecentDocument",
                                      error,
                                  );
                              }
                          }
                        : undefined,
                store: dbWorkerClient.projectStore,
                worker: projectWorker,
            });
            aiService = new AiService({
                onRuntimeStatus: broadcastAiRuntimeStatus,
                onSessionEvent: broadcastAiSessionEvent,
                onSessionSnapshot: broadcastAiSessionSnapshot,
                persistence: dbWorkerClient.aiPersistence,
                projectService,
                secretStore,
                settingsService,
            });
            try {
                aiWorkerClient = await createAiWorkerClient({
                    onLog:
                        process.env.COMANDO_DEBUG_AI_WORKER === "1"
                            ? (payload) => {
                                  const log =
                                      payload.level === "error"
                                          ? console.error
                                          : payload.level === "warn"
                                            ? console.warn
                                            : console.debug;
                                  log("[ai-worker]", payload.message, payload.context ?? {});
                              }
                            : undefined,
                    onRuntimeStatus: (status) => {
                        aiService?.handleWorkerRuntimeStatus(status);
                    },
                    onSessionClosed: (payload) => {
                        aiService?.handleWorkerSessionClosed(payload);
                    },
                    onSessionEvent: (ownerWindowId, event) => {
                        aiService?.handleWorkerSessionEvent(
                            ownerWindowId,
                            event,
                        );
                    },
                    onSessionSnapshot: (ownerWindowId, update) => {
                        aiService?.handleWorkerSessionSnapshot(
                            ownerWindowId,
                            update,
                        );
                    },
                    onWorkerRestarted: async () => {
                        await aiService?.handleWorkerRestarted();
                    },
                });
                aiService.setWorker(aiWorkerClient);
            } catch (error) {
                console.error(
                    "[main] Failed to initialize the AI worker",
                    error,
                );
            }
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
                aiWorker: aiWorkerClient,
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
                githubService,
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
                reopenLastClosedTab: () => {
                    const focusedWindow = windowRegistry.getFocusedMainWindow();
                    focusedWindow?.webContents.send(
                        IPC_EVENTS.workspaceReopenLastClosedTab,
                    );
                },
                openSettingsWindow: (projectId) =>
                    openSettingsWindow(
                        { projectId },
                        loadCurrentAppZoomFactor(),
                    ),
            });

            restoreMainWindows();
            initializeAutoUpdates({
                appChannel,
                isPackaged: app.isPackaged,
                platform: process.platform,
                resourcesPath: process.resourcesPath,
            });

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

app.on("will-quit", (event) => {
    if (isFinalizingQuit) {
        return;
    }

    event.preventDefault();

    if (!pendingShutdown) {
        pendingShutdown = shutdownApplication().finally(() => {
            pendingShutdown = null;
            isFinalizingQuit = true;
            app.quit();
        });
    }
});

async function shutdownApplication(): Promise<void> {
    for (const windowId of [...aiSessionStreamPorts.keys()]) {
        detachAiSessionStream(windowId);
    }

    mainProcessPerformance.flush();
    mainProcessPerformance.stop();

    aiService?.close();
    terminalService?.close();

    const aiWorkerClientToClose = aiWorkerClient;
    const dbWorkerClientToClose = dbWorkerClient;
    const gitServiceToClose = gitService;
    const projectServiceToClose = projectService;

    aiService = null;
    aiWorkerClient = null;
    dbWorkerClient = null;
    gitService = null;
    githubService = null;
    persistenceService = null;
    projectService = null;
    secretStore = null;
    settingsService = null;
    terminalService = null;
    workspaceService = null;

    const shutdownResults = await Promise.allSettled([
        aiWorkerClientToClose?.close(),
        gitServiceToClose?.close(),
        projectServiceToClose?.close(),
        dbWorkerClientToClose?.close(),
    ]);

    for (const result of shutdownResults) {
        if (result.status === "rejected") {
            debugBenignError("app.shutdown", result.reason);
        }
    }
}

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

    const existingWindow = input.forceNewWindow
        ? null
        : windowRegistry.getMainWindowByProjectId(input.projectId);
    if (!existingWindow) {
        void openNewMainWindowWithOptions({
            forceNewWindow: input.forceNewWindow,
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
    readonly forceNewWindow?: boolean;
    readonly projectId: string | null;
    readonly worktreeId?: string | null;
}): Promise<void> {
    if (!persistenceService) {
        return;
    }

    if (input.projectId && !input.forceNewWindow) {
        const existingWindow = windowRegistry.getMainWindowByProjectId(
            input.projectId,
        );
        if (existingWindow) {
            focusExistingWindow(existingWindow);
            return;
        }
    }

    const closedProjectSnapshot =
        input.projectId && !input.forceNewWindow
            ? await persistenceService.findClosedMainWindowSnapshotForProject(
                  input.projectId,
                  input.worktreeId,
              )
            : null;
    if (closedProjectSnapshot) {
        createTrackedMainWindow(closedProjectSnapshot);
        return;
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
        forEachLiveWindow((window) => {
            applyAppZoomToWindow(window, appearance.zoomFactor);
        });
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
    } catch (error) {
        debugBenignError("applyProjectWindowTitle", error);
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
    forEachLiveWindow((window) => {
        window.webContents.send(IPC_EVENTS.projectTreeInvalidated, payload);
    });
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
    forEachLiveWindow((window) => {
        window.webContents.send(IPC_EVENTS.gitRepositoryInvalidated, payload);
    });
}

export function broadcastGitRepositorySnapshotUpdated(
    payload: GitRepositorySnapshot,
): void {
    forEachLiveWindow((window) => {
        window.webContents.send(
            IPC_EVENTS.gitRepositorySnapshotUpdated,
            payload,
        );
    });
}

export function broadcastGitWorktreesUpdated(
    payload: GitRepositoryInvalidation,
): void {
    forEachLiveWindow((window) => {
        window.webContents.send(IPC_EVENTS.gitWorktreesUpdated, payload);
    });
}

function broadcastAiRuntimeStatus(payload: AiRuntimeStatus): void {
    forEachLiveWindow((window) => {
        window.webContents.send(IPC_EVENTS.aiRuntimeStatus, payload);
    });
}

function broadcastAiSessionSnapshot(
    ownerWindowId: string,
    payload: AiSessionUpdate,
): void {
    mainProcessPerformance.recordAiSessionUpdate(payload);

    if (!ownerWindowId) {
        forEachLiveWindow((window) => {
            dispatchAiSessionSnapshot(window, payload);
        });
        return;
    }

    const targetWindow = windowRegistry.getWindowByStableId(ownerWindowId);
    if (targetWindow) {
        dispatchAiSessionSnapshot(targetWindow, payload, ownerWindowId);
    }
}

function broadcastAiSessionEvent(
    ownerWindowId: string,
    payload: AiSessionDomainEvent,
): void {
    if (!ownerWindowId) {
        forEachLiveWindow((window) => {
            dispatchAiSessionEvent(window, payload);
        });
        return;
    }

    const targetWindow = windowRegistry.getWindowByStableId(ownerWindowId);
    if (targetWindow) {
        dispatchAiSessionEvent(targetWindow, payload, ownerWindowId);
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
        // Re-check `isDestroyed` atomically next to the `postMessage` call so
        // a teardown that lands between the outer guard and this line cannot
        // leak the transferred port into a dead renderer.
        if (window.isDestroyed()) {
            channel.port1.close();
            channel.port2.close();
            return;
        }
        window.webContents.postMessage(IPC_EVENTS.aiSessionStreamPort, null, [
            channel.port2,
        ]);
        aiSessionStreamPorts.set(windowId, channel.port1);
    } catch (error) {
        debugBenignError("attachAiSessionStream", error);
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
            } catch (error) {
                debugBenignError(
                    "aiSessionStreamPort.postMessage",
                    error,
                );
                detachAiSessionStream(stableWindowId);
            }
        }
    }

    window.webContents.send(IPC_EVENTS.aiSessionSnapshot, payload);
}

function dispatchAiSessionEvent(
    window: BrowserWindow,
    payload: AiSessionDomainEvent,
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
            } catch (error) {
                debugBenignError(
                    "aiSessionStreamPort.postMessage",
                    error,
                );
                detachAiSessionStream(stableWindowId);
            }
        }
    }

    window.webContents.send(IPC_EVENTS.aiSessionEvent, payload);
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
