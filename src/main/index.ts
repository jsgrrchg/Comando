import { app, BrowserWindow } from "electron";

import { APP_ZOOM_FACTOR_DEFAULT, stepAppZoomFactor } from "@shared/app-zoom";
import { appIdentity } from "@shared/app-identity";
import {
    IPC_EVENTS,
    type AiRuntimeStatus,
    type AiSessionSnapshot,
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

import { AiPersistence } from "./ai/persistence";
import { SecretStoreService } from "./ai/secret-store";
import { AiService } from "./ai/service";
import { bootstrapDatabase, type DatabaseManager } from "./db";
import { GitService } from "./git";
import { installApplicationMenu } from "./menu";
import { PersistenceService } from "./persistence/service";
import { ProjectService } from "./projects/service";
import { registerIpcHandlers } from "./ipc";
import { SettingsService } from "./settings/service";
import {
    applyAppZoomToWindow,
    broadcastSettingsUpdated,
} from "./settings/window-zoom";
import { openSettingsWindow } from "./settings/window";
import { TerminalService } from "./terminals/service";
import { createMainWindow } from "./window";
import { windowRegistry } from "./windows/registry";
import { WorkspaceService } from "./workspace/service";

let database: DatabaseManager | null = null;
let bootstrapSnapshot: AppBootstrapSnapshot | null = null;
let aiService: AiService | null = null;
let persistenceService: PersistenceService | null = null;
let projectService: ProjectService | null = null;
let gitService: GitService | null = null;
let secretStore: SecretStoreService | null = null;
let settingsService: SettingsService | null = null;
let terminalService: TerminalService | null = null;
let workspaceService: WorkspaceService | null = null;
let isQuitting = false;

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

    void app.whenReady().then(() => {
        database = bootstrapDatabase({
            dataDir: app.getPath("userData"),
        });
        persistenceService = new PersistenceService(database.connection);
        secretStore = new SecretStoreService(database.connection);
        settingsService = new SettingsService(database.connection);
        gitService = new GitService();
        projectService = new ProjectService({
            connection: database.connection,
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
                              // Ignoramos problemas del sistema operativo.
                          }
                      }
                    : undefined,
        });
        aiService = new AiService({
            onRuntimeStatus: broadcastAiRuntimeStatus,
            onSessionSnapshot: broadcastAiSessionSnapshot,
            persistence: new AiPersistence(database.connection),
            projectService,
            secretStore,
            settingsService,
        });
        terminalService = new TerminalService({
            onData: broadcastTerminalData,
            onExit: broadcastTerminalExit,
            projectService,
        });
        workspaceService = new WorkspaceService(database.connection);

        bootstrapSnapshot = {
            app: appIdentity,
            database: database.status,
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
            openNewMainWindow: (projectId) =>
                openNewMainWindow(projectId ?? null),
            openSettingsWindow: (projectId) =>
                openSettingsWindow({ projectId }, loadCurrentAppZoomFactor()),
        });

        restoreMainWindows();

        app.on("activate", () => {
            if (windowRegistry.listMainWindowContexts().length === 0) {
                void openNewMainWindow(null);
            }
        });
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
    aiService?.close();
    aiService = null;
    gitService?.clear();
    gitService = null;
    projectService?.close();
    projectService = null;
    terminalService?.close();
    terminalService = null;
    persistenceService = null;
    secretStore = null;
    settingsService = null;
    workspaceService = null;
    database?.close();
    database = null;
});

function restoreMainWindows(): void {
    const snapshots =
        persistenceService?.listRestorableMainWindowSnapshots() ?? [];
    if (snapshots.length === 0) {
        openNewMainWindow(null);
        return;
    }

    for (const snapshot of snapshots) {
        createTrackedMainWindow(snapshot);
    }
}

function openNewMainWindow(projectId: string | null): void {
    openNewMainWindowWithOptions({
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
        openNewMainWindowWithOptions({
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

function openNewMainWindowWithOptions(input: {
    readonly projectId: string | null;
    readonly worktreeId?: string | null;
}): void {
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
    const snapshot = persistenceService.createMainWindowSession(
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

        if (!isQuitting) {
            persistenceService?.markWindowClosed(context.windowId);
        }

        terminalService?.closeOwnedByWindow(context.windowId);
        aiService?.closeOwnedByWindow(context.windowId);
    });
    window.on("unresponsive", () => {
        console.warn(
            `[window:${context.windowId}] Renderer became unresponsive.`,
        );
    });
    window.webContents.on("render-process-gone", (_event, details) => {
        console.error(
            `[window:${context.windowId}] Renderer process gone: ${details.reason}`,
        );
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
    payload: AiSessionSnapshot,
): void {
    if (!ownerWindowId) {
        for (const window of BrowserWindow.getAllWindows()) {
            window.webContents.send(IPC_EVENTS.aiSessionSnapshot, payload);
        }
        return;
    }

    const targetWindow = windowRegistry.getWindowByStableId(ownerWindowId);
    targetWindow?.webContents.send(IPC_EVENTS.aiSessionSnapshot, payload);
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
