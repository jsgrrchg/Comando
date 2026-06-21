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
import {
    nativeProjectTreeInvalidationToIpc,
    type NativeProjectTreeInvalidation,
} from "@shared/native-backend";

import { appChannel, appIdentity, configureMainProcessApp } from "./app-runtime";
import {
    createAiWorkerClient,
    type AiWorkerClient,
} from "./ai/client";
import type { SecretStoreGateway } from "./ai/secret-store";
import { AiService } from "./ai/service";
import type { NormalizedSessionCatalogPayload } from "./ai/session-core";
import { createDbWorkerClient, type DbWorkerClient } from "./db/client";
import { createGitWorkerClient, type GitWorkerClient } from "./git";
import { GitHubService } from "./github/service";
import {
    installFilePreviewProtocol,
    registerFilePreviewSchemes,
} from "./file-preview-protocol";
import { installApplicationMenu } from "./menu";
import {
    NativeBackendClient,
    parseNativeBackendCapabilitiesOutput,
} from "./native-backend/client";
import {
    resolveNativeBackendPath,
} from "./native-backend/path";
import {
    NativePersistenceGateway,
} from "./native-backend/persistence";
import { NativeAiGateway, shouldUseNativeAi } from "./native-backend/ai";
import { NativeFsGateway } from "./native-backend/fs";
import { NativeGitGateway, NativeGitRoutingGateway } from "./native-backend/git";
import { NativeSearchGateway } from "./native-backend/index-search";
import {
    NativeTerminalGateway,
    shouldUseNativeTerminal,
} from "./native-backend/terminal";
import {
    createNativeProjectRegistryStore,
} from "./native-backend/projects";
import type { NativeBackendEvent } from "./native-backend/protocol";
import { debugBenignError } from "./observability/logging";
import { mainProcessPerformance } from "./observability/performance";
import type { PersistenceGateway } from "./persistence/service";
import { ProjectService } from "./projects/service";
import { registerIpcHandlers } from "./ipc";
import type { SettingsGateway } from "./settings/service";
import {
    applyAppZoomToWindow,
    broadcastSettingsUpdated,
} from "./settings/window-zoom";
import { openSettingsWindow } from "./settings/window";
import { TerminalService, type TerminalGateway } from "./terminals/service";
import { initializeAutoUpdates } from "./updater";
import {
    createMainWindow,
    forEachLiveWindow,
    supportsCurrentWindowsAcrylicMaterial,
} from "./window";
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
let terminalService: TerminalGateway | null = null;
let nativeBackendClient: NativeBackendClient | null = null;
let workspaceService: WorkspaceGateway | null = null;
let isQuitting = false;
let isFinalizingQuit = false;
let hasRequestedNativeBackendTestEvent = false;
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
            await startNativeBackendRequired();
            await openNativePersistenceRequired();
            if (!nativeBackendClient) {
                throw new Error(
                    "Native backend client was not available after startup.",
                );
            }
            const nativeClient = nativeBackendClient;
            persistenceService = dbWorkerClient.persistence;
            secretStore = dbWorkerClient.secretStore;
            githubService = new GitHubService({ secretStore });
            settingsService = dbWorkerClient.settings;
            const gitWorker = await createGitWorkerClient();
            gitService = nativeBackendClient
                ? new NativeGitRoutingGateway({
                      env: process.env,
                      legacy: gitWorker,
                      native: new NativeGitGateway(nativeBackendClient),
                      onDiagnostic: (message) => {
                          console.warn(message);
                      },
                  })
                : gitWorker;
            const projectStore = await createNativeProjectRegistryStore({
                nativeClient,
                onDiagnostic: (message) => {
                    console.warn(message);
                },
            });
            projectService = new ProjectService({
                nativeFs: new NativeFsGateway(nativeClient),
                nativeSearch: new NativeSearchGateway(nativeClient),
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
                store: projectStore,
            });
            aiService = new AiService({
                nativeAi: createNativeAiGateway({
                    nativeClient: nativeBackendClient,
                    onRuntimeStatus: broadcastAiRuntimeStatus,
                    onSessionCatalogPatch: (
                        ownerWindowId,
                        sessionId,
                        patch,
                        updatedAt,
                    ) => {
                        aiService?.handleNativeSessionCatalogPatch(
                            ownerWindowId,
                            sessionId,
                            patch,
                            updatedAt,
                        );
                    },
                    onSessionEvent: (ownerWindowId, event) => {
                        aiService?.handleNativeSessionEvent(
                            ownerWindowId,
                            event,
                        );
                    },
                }),
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
                    shardCount: parseAiWorkerShardCount(
                        process.env.COMANDO_AI_WORKER_SHARDS,
                    ),
                });
                aiService.setWorker(aiWorkerClient);
            } catch (error) {
                console.error(
                    "[main] Failed to initialize the AI worker",
                    error,
                );
            }
            terminalService = createTerminalGateway({
                nativeClient: nativeBackendClient,
                onData: broadcastTerminalData,
                onExit: broadcastTerminalExit,
                projectService,
                settingsService,
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
                windowEffects: {
                    windowsAcrylic: supportsCurrentWindowsAcrylicMaterial(),
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
        isQuitting = true;
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

    const aiWorkerClientToClose = aiWorkerClient;
    const dbWorkerClientToClose = dbWorkerClient;
    const gitServiceToClose = gitService;
    const nativeBackendClientToClose = nativeBackendClient;
    const projectServiceToClose = projectService;
    const terminalServiceToClose = terminalService;

    aiService = null;
    aiWorkerClient = null;
    dbWorkerClient = null;
    gitService = null;
    githubService = null;
    nativeBackendClient = null;
    persistenceService = null;
    projectService = null;
    secretStore = null;
    settingsService = null;
    terminalService = null;
    workspaceService = null;

    const shutdownResults = await Promise.allSettled([
        aiWorkerClientToClose?.close(),
        gitServiceToClose?.close(),
        (async () => {
            await terminalServiceToClose?.close();
            await nativeBackendClientToClose?.dispose();
        })(),
        projectServiceToClose?.close(),
        dbWorkerClientToClose?.close(),
    ]);

    for (const result of shutdownResults) {
        if (result.status === "rejected") {
            debugBenignError("app.shutdown", result.reason);
        }
    }
}

function parseAiWorkerShardCount(value: string | undefined): number {
    const parsed = Number.parseInt(value ?? "", 10);
    if (!Number.isFinite(parsed)) {
        return 1;
    }

    return Math.max(1, Math.min(8, parsed));
}

function createNativeAiGateway(input: {
    readonly nativeClient: NativeBackendClient | null;
    readonly onRuntimeStatus: (status: AiRuntimeStatus) => void;
    readonly onSessionCatalogPatch: (
        ownerWindowId: string,
        sessionId: string,
        patch: NormalizedSessionCatalogPayload,
        updatedAt: string,
    ) => void;
    readonly onSessionEvent: (
        ownerWindowId: string,
        event: AiSessionDomainEvent,
    ) => void;
}): NativeAiGateway | null {
    if (!shouldUseNativeAi()) {
        return null;
    }

    if (input.nativeClient) {
        console.info("[native-backend] Native AI backend enabled.");
        return new NativeAiGateway({
            client: input.nativeClient,
            onDiagnostic: (message) => {
                console.warn(`[native-ai] ${message}`);
            },
            onRuntimeStatus: input.onRuntimeStatus,
            onSessionCatalogPatch: input.onSessionCatalogPatch,
            onSessionEvent: input.onSessionEvent,
        });
    }

    console.warn(
        "[native-backend] Native AI backend is enabled but the native backend sidecar is not running; using the legacy AI worker.",
    );
    return null;
}

function createTerminalGateway(input: {
    readonly nativeClient: NativeBackendClient | null;
    readonly onData: (ownerWindowId: string, event: TerminalDataEvent) => void;
    readonly onExit: (ownerWindowId: string, event: TerminalExitEvent) => void;
    readonly projectService: ProjectService;
    readonly settingsService: SettingsGateway;
}): TerminalGateway {
    if (shouldUseNativeTerminal()) {
        if (input.nativeClient) {
            console.info("[native-backend] Native terminal backend enabled.");
            return new NativeTerminalGateway({
                client: input.nativeClient,
                onData: input.onData,
                onDiagnostic: (message) => {
                    console.warn(`[native-terminal] ${message}`);
                },
                onExit: input.onExit,
                projectService: input.projectService,
                settingsService: input.settingsService,
            });
        }

        console.warn(
            "[native-backend] Native terminal backend is enabled but the native backend sidecar is not running; using the legacy terminal backend.",
        );
    }

    return new TerminalService({
        onData: input.onData,
        onExit: input.onExit,
        projectService: input.projectService,
        settingsService: input.settingsService,
    });
}

async function startNativeBackendRequired(): Promise<void> {
    const resolution = resolveNativeBackendPath({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
    });
    if (!resolution.binaryPath) {
        const message = [
            "[native-backend] Native backend sidecar is required but no binary was found.",
            `Attempted: ${resolution.attemptedPaths.join(", ")}`,
        ].join(" ");

        throw new Error(message);
    }

    const client = new NativeBackendClient({
        binaryPath: resolution.binaryPath,
        onDiagnostic: (message) => {
            console.warn(`[native-backend] ${message}`);
        },
    });
    nativeBackendClient = client;
    client.onEvent(broadcastNativeBackendEvent);

    try {
        await client.handshake({ clientVersion: app.getVersion() });
        await client.request("backend_ping");
        const capabilities = parseNativeBackendCapabilitiesOutput(
            await client.request("backend_capabilities"),
        );
        console.info(
            `[native-backend] Started ${resolution.source} sidecar at ${resolution.binaryPath}. ${summarizeNativeBackendCapabilities(capabilities)}`,
        );
    } catch (error) {
        nativeBackendClient = null;
        await client.dispose();

        throw new Error(
            `[native-backend] Native backend startup failed: ${formatError(error)}`,
        );
    }
}

async function openNativePersistenceRequired(): Promise<void> {
    if (!nativeBackendClient) {
        throw new Error(
            "Native persistence requires a running native backend sidecar.",
        );
    }

    if (!dbWorkerClient) {
        throw new Error("The database worker must be ready before native persistence opens.");
    }

    const gateway = new NativePersistenceGateway(nativeBackendClient);

    try {
        const opened = await gateway.openStore({
            appDataDir: app.getPath("userData"),
            databasePath: dbWorkerClient.status.databaseFile,
            mode: "write",
        });
        const health = await gateway.getStorageHealth();

        console.info(
            `[native-backend] Native persistence opened mode=write schema=${opened.schemaVersion} projects=${health.projectCount} worktrees=${health.worktreeCount}.`,
        );
        if (!opened.opened || !health.opened || !health.schemaCompatible) {
            throw new Error(
                "Native persistence did not report a compatible open store.",
            );
        }
    } catch (error) {
        throw new Error(
            `[native-backend] Native persistence startup failed: ${formatError(error)}`,
        );
    }
}

function summarizeNativeBackendCapabilities(capabilities: unknown): string {
    if (!isRecord(capabilities)) {
        return "Capabilities unavailable.";
    }

    const protocolVersion =
        typeof capabilities.protocolVersion === "number"
            ? capabilities.protocolVersion
            : "unknown";
    const backendVersion =
        typeof capabilities.backendVersion === "string"
            ? capabilities.backendVersion
            : "unknown";
    const nestedCapabilities = isRecord(capabilities.capabilities)
        ? capabilities.capabilities
        : null;
    const commands = Array.isArray(nestedCapabilities?.commands)
        ? nestedCapabilities.commands.length
        : 0;
    const events = Array.isArray(nestedCapabilities?.events)
        ? nestedCapabilities.events.length
        : 0;

    return `protocol=${protocolVersion} version=${backendVersion} commands=${commands} events=${events}.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function requestNativeBackendTestEventOnce(): Promise<void> {
    if (hasRequestedNativeBackendTestEvent || !nativeBackendClient) {
        return;
    }

    hasRequestedNativeBackendTestEvent = true;
    try {
        await nativeBackendClient.request("backend_emit_test_event", {
            message: "hello",
        });
    } catch (error) {
        debugBenignError("nativeBackend.testEvent", error);
    }
}

function restoreMainWindows(): void {
    const snapshots = filterRestorableMainWindowSnapshots(
        persistenceService?.listRestorableMainWindowSnapshots() ?? [],
    );
    if (snapshots.length === 0) {
        void openNewMainWindow(null);
        return;
    }

    for (const snapshot of snapshots) {
        createTrackedMainWindow(snapshot);
    }
}

function filterRestorableMainWindowSnapshots(
    snapshots: readonly PersistenceSnapshot[],
): readonly PersistenceSnapshot[] {
    if (
        !snapshots.some((snapshot) => getSnapshotProjectId(snapshot) !== null)
    ) {
        return snapshots;
    }

    return snapshots.filter(
        (snapshot) => getSnapshotProjectId(snapshot) !== null,
    );
}

function getSnapshotProjectId(snapshot: PersistenceSnapshot): string | null {
    return snapshot.windowContext?.projectId ?? null;
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
        void requestNativeBackendTestEventOnce();
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

    broadcastSettingsUpdated(
        appearance ?? null,
        snapshot.editor ?? null,
        snapshot.aiChat ?? null,
        snapshot.terminal ?? null,
    );
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
    window.on("close", () => {
        persistWindowState();

        if (isClosingLastAppWindow()) {
            isQuitting = true;
        }
    });
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

function isClosingLastAppWindow(): boolean {
    if (process.platform === "darwin" || isQuitting) {
        return false;
    }

    const liveWindowCount = BrowserWindow.getAllWindows().filter(
        (candidate) => !candidate.isDestroyed(),
    ).length;

    return liveWindowCount <= 1;
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

function broadcastNativeBackendEvent(event: NativeBackendEvent): void {
    if (event.eventName === "project://tree-invalidated") {
        try {
            const invalidation = nativeProjectTreeInvalidationToIpc(
                event.payload as NativeProjectTreeInvalidation,
            );
            projectService?.handleProjectTreeInvalidation(invalidation);
        } catch (error) {
            debugBenignError("nativeBackend.projectTreeInvalidation", error);
        }
    }

    forEachLiveWindow((window) => {
        window.webContents.send(IPC_EVENTS.nativeBackendEvent, event);
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
