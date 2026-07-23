import {
    app,
    BrowserWindow,
    ipcMain,
    MessageChannelMain,
    type MessagePortMain,
    type WebContents,
} from "electron";
import path from "node:path";

import { APP_ZOOM_FACTOR_DEFAULT, stepAppZoomFactor } from "@shared/app-zoom";
import {
    IPC_EVENTS,
    type AiRuntimeStatus,
    type AiPromptQueueSnapshot,
    type AiSessionDomainEvent,
    type AiSessionStreamMessage,
    type AiSessionStreamPayload,
    type AiSessionUpdate,
    type AppBootstrapSnapshot,
    type GitRepositoryInvalidation,
    type GitRepositorySnapshot,
    type MoveWorkspaceContextInput,
    type OpenProjectWindowInput,
    type PersistenceSnapshot,
    type ProjectTreeInvalidation,
    type TerminalDataEvent,
    type TerminalExitEvent,
    type WindowContextSnapshot,
    type WorkspaceNavigationSnapshot,
} from "@shared/ipc";
import {
    normalizeWorkspaceWorktreeId,
} from "@shared/workspace-context";
import {
    nativeProjectTreeInvalidationToIpc,
    type NativeCapabilitySet,
    type NativeProjectTreeInvalidation,
} from "@shared/native-backend";

import { appChannel, appIdentity, configureMainProcessApp } from "./app-runtime";
import type { SecretStoreGateway } from "./ai/secret-store";
import { AiService } from "./ai/service";
import type { NormalizedSessionCatalogPayload } from "./ai/session-core";
import {
    buildAiSessionStreamRecoveryFallbackPayloads,
    buildAiSessionStreamRecoveryDiagnostic,
    isAiSessionStreamAckStale,
    isAiSessionUpdate,
    rememberAiSessionStreamPayloadForRecovery,
    type AiSessionStreamPreservationQueue,
    type AiSessionStreamRecoveryReason,
} from "./ai/session-stream";
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
import { NativeAiGateway } from "./native-backend/ai";
import {
    createNativeAppDataClient,
    type NativeAppDataClient,
} from "./native-backend/app-data";
import { NativeFsGateway } from "./native-backend/fs";
import { NativeGitGateway, type ClosableGitGateway } from "./native-backend/git";
import { nativeGitEventToIpcInvalidation } from "./native-backend/git-events";
import { NativeSearchGateway } from "./native-backend/index-search";
import {
    NativeTerminalGateway,
} from "./native-backend/terminal";
import {
    createNativeProjectRegistryStore,
} from "./native-backend/projects";
import type { NativeBackendEvent } from "./native-backend/protocol";
import { debugBenignError } from "./observability/logging";
import type { PersistenceGateway } from "./persistence/service";
import {
    createProjectInvalidationCoordinator,
    type ProjectInvalidationCoordinator,
} from "./projects/invalidation-coordinator";
import { ProjectService } from "./projects/service";
import { registerIpcHandlers } from "./ipc";
import type { SettingsGateway } from "./settings/service";
import {
    applyAppZoomToWindow,
    broadcastSettingsUpdated,
} from "./settings/window-zoom";
import { openSettingsWindow } from "./settings/window";
import type { TerminalGateway } from "./terminals/service";
import { initializeAutoUpdates } from "./updater";
import { isLinuxAppImageEnvironment } from "./updater-config";
import {
    applyWindowTransparencyToWindow,
    createMainWindow,
    forEachLiveWindow,
} from "./window";
import { windowRegistry } from "./windows/registry";
import { workspaceSurfaceManager } from "./workspace/surface-manager";
import { moveWorkspaceBetweenWindows } from "./workspace/move-coordinator";
import type { WorkspaceGateway } from "./workspace/service";

import { initReviewEngine } from "@shared/ai-review-engine/reviewEngine";

// Kick off loading the Rust/WASM review engine as early as possible (overlaps
// with native backend setup). The bootstrap awaits it before the AI service can
// run any review work.
void initReviewEngine();

let nativeAppDataClient: NativeAppDataClient | null = null;
let bootstrapSnapshot: AppBootstrapSnapshot | null = null;
let aiService: AiService | null = null;
let persistenceService: PersistenceGateway | null = null;
let projectService: ProjectService | null = null;
let projectInvalidationCoordinator: ProjectInvalidationCoordinator | null = null;
let gitService: ClosableGitGateway | null = null;
let githubService: GitHubService | null = null;
let secretStore: SecretStoreGateway | null = null;
let settingsService: SettingsGateway | null = null;
let terminalService: TerminalGateway | null = null;
let nativeBackendClient: NativeBackendClient | null = null;
let nativeBackendCapabilities: NativeCapabilitySet | null = null;
let workspaceService: WorkspaceGateway | null = null;
let isQuitting = false;
let isWorkspaceQuitReady = false;
let pendingWorkspaceQuit: Promise<void> | null = null;
let isFinalizingQuit = false;
let hasRequestedNativeBackendTestEvent = false;
let pendingShutdown: Promise<void> | null = null;
let nextWorkspaceFlushRequestId = 0;
const pendingWorkspaceFlushes = new Map<
    string,
    { readonly senderId: number; readonly resolve: () => void }
>();
const pendingWorkspaceSurfaceCaptures = new Map<
    string,
    {
        readonly resolve: (snapshot: WorkspaceNavigationSnapshot | null) => void;
        readonly senderId: number;
    }
>();

ipcMain.on(
    IPC_EVENTS.workspaceFlushAcknowledged,
    (event, requestId: unknown) => {
        if (typeof requestId !== "string") {
            return;
        }
        const pending = pendingWorkspaceFlushes.get(requestId);
        if (!pending || pending.senderId !== event.sender.id) {
            return;
        }
        pendingWorkspaceFlushes.delete(requestId);
        pending.resolve();
    },
);

ipcMain.on(
    IPC_EVENTS.workspaceSurfaceSnapshotCaptured,
    (event, requestId: unknown, snapshot: unknown) => {
        if (typeof requestId !== "string") {
            return;
        }
        const pending = pendingWorkspaceSurfaceCaptures.get(requestId);
        if (!pending || pending.senderId !== event.sender.id) {
            return;
        }
        pendingWorkspaceSurfaceCaptures.delete(requestId);
        pending.resolve(
            snapshot && typeof snapshot === "object"
                ? (snapshot as WorkspaceNavigationSnapshot)
                : null,
        );
    },
);

const AI_SESSION_STREAM_ACK_STALE_MS = 10_000;
const AI_SESSION_STREAM_HEARTBEAT_MS = 1_000;
const AI_SESSION_STREAM_MAX_PRESERVED_PAYLOADS = 100;

type AiSessionStreamPortState = {
    readonly port: MessagePortMain;
    heartbeatTimer: ReturnType<typeof setInterval> | null;
    lastAckAt: number;
    lastAckSeq: number;
    lastSentAt: number;
    lastSentSeq: number;
    nextSeq: number;
    readonly pendingAckSentAtBySeq: Map<number, number>;
    readonly pendingPreservedPayloads: AiSessionStreamPreservationQueue;
    staleTimer: ReturnType<typeof setTimeout> | null;
};

const aiSessionStreamPorts = new Map<string, AiSessionStreamPortState>();

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
            installFilePreviewProtocol();
            await startNativeBackendRequired();
            const databaseFile = path.join(
                app.getPath("userData"),
                "comando.sqlite3",
            );
            await openNativePersistenceRequired(databaseFile);
            if (!nativeBackendClient) {
                throw new Error(
                    "Native backend client was not available after startup.",
                );
            }
            const nativeClient = nativeBackendClient;
            nativeAppDataClient = await createNativeAppDataClient({
                client: nativeClient,
                databaseFile,
            });
            persistenceService = nativeAppDataClient.persistence;
            secretStore = nativeAppDataClient.secretStore;
            githubService = new GitHubService({ secretStore });
            settingsService = nativeAppDataClient.settings;
            gitService = new NativeGitGateway(nativeClient);
            const projectStore = await createNativeProjectRegistryStore({
                nativeClient,
                onDiagnostic: (message) => {
                    console.warn(message);
                },
            });
            projectInvalidationCoordinator = createProjectInvalidationCoordinator({
                apply: (payload) => {
                    projectService?.handleProjectTreeInvalidation(payload);
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
            // The review engine (Rust/WASM) must be ready before the AI service
            // can compute review diffs. The load was kicked off at module load;
            // this awaits it (idempotent) before any review work can run.
            try {
                await initReviewEngine();
            } catch (error) {
                debugBenignError("ai.reviewEngine.init", error);
            }
            aiService = new AiService({
                nativeAi: createNativeAiGateway({
                    capabilities: nativeBackendCapabilities,
                    nativeClient,
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
                onPromptQueueSnapshot: broadcastAiPromptQueueSnapshot,
                onSessionEvent: broadcastAiSessionEvent,
                onSessionSnapshot: broadcastAiSessionSnapshot,
                persistence: nativeAppDataClient.aiPersistence,
                projectService,
                secretStore,
                settingsService,
            });
            terminalService = createTerminalGateway({
                nativeClient,
                onData: broadcastTerminalData,
                onExit: broadcastTerminalExit,
                projectService,
                settingsService,
            });
            workspaceService = nativeAppDataClient.workspace;
            workspaceSurfaceManager.setLifecycleHandlers({
                onSurfaceCreated: (webContents, ownerId) => {
                    attachAiSessionStream(webContents, ownerId);
                },
                onSurfaceDestroyed: (ownerId) => {
                    detachAiSessionStream(ownerId);
                    terminalService?.closeOwnedByWindow(ownerId);
                    aiService?.closeOwnedByWindow(ownerId);
                },
            });

            bootstrapSnapshot = {
                app: appIdentity,
                database: nativeAppDataClient.status,
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
                captureWorkspaceSurfaceContext:
                    requestWorkspaceSurfaceContextCapture,
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
                openProjectWindow: openOrFocusProjectWindow,
                moveWorkspaceContext,
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
                        const targetContents =
                            workspaceSurfaceManager.getActiveWebContents(
                                context.windowId,
                            ) ?? focusedWindow.webContents;
                        targetContents.send(
                            IPC_EVENTS.workspaceCloseActiveTab,
                        );
                        return;
                    }

                    focusedWindow.close();
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
                openWorkspaceSwitcher: () => {
                    const focusedWindow = windowRegistry.getFocusedMainWindow();
                    focusedWindow?.webContents.send(
                        IPC_EVENTS.workspaceSwitcherRequested,
                    );
                },
                reopenLastClosedTab: () => {
                    const focusedWindow = windowRegistry.getFocusedMainWindow();
                    if (!focusedWindow) {
                        return;
                    }

                    const context =
                        windowRegistry.getContextByBrowserWindow(focusedWindow);
                    const targetContents =
                        context?.windowKind === "main"
                            ? (workspaceSurfaceManager.getActiveWebContents(
                                  context.windowId,
                              ) ?? focusedWindow.webContents)
                            : focusedWindow.webContents;
                    targetContents.send(
                        IPC_EVENTS.workspaceReopenLastClosedTab,
                    );
                },
                toggleSidebar: () => {
                    const focusedWindow = windowRegistry.getFocusedMainWindow();
                    if (!focusedWindow) {
                        return;
                    }

                    focusedWindow.webContents.send(
                        IPC_EVENTS.sidebarToggleRequested,
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
                isLinuxAppImage: isLinuxAppImageEnvironment(process.env),
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

app.on("before-quit", (event) => {
    isQuitting = true;
    if (isWorkspaceQuitReady) {
        return;
    }
    event.preventDefault();
    if (!pendingWorkspaceQuit) {
        pendingWorkspaceQuit = flushAllWorkspaceWindowsForQuit().finally(() => {
            pendingWorkspaceQuit = null;
            isWorkspaceQuitReady = true;
            app.quit();
        });
    }
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

    aiService?.close();

    const nativeAppDataClientToClose = nativeAppDataClient;
    const gitServiceToClose = gitService;
    const nativeBackendClientToClose = nativeBackendClient;
    const projectServiceToClose = projectService;
    const projectInvalidationCoordinatorToClose = projectInvalidationCoordinator;
    const terminalServiceToClose = terminalService;

    aiService = null;
    nativeAppDataClient = null;
    gitService = null;
    githubService = null;
    nativeBackendClient = null;
    nativeBackendCapabilities = null;
    persistenceService = null;
    projectService = null;
    projectInvalidationCoordinator = null;
    secretStore = null;
    settingsService = null;
    terminalService = null;
    workspaceService = null;

    const shutdownResults = await Promise.allSettled([
        gitServiceToClose?.close(),
        (async () => {
            await terminalServiceToClose?.close();
            await nativeBackendClientToClose?.dispose();
        })(),
        projectServiceToClose?.close(),
        nativeAppDataClientToClose?.close(),
    ]);
    projectInvalidationCoordinatorToClose?.dispose();

    for (const result of shutdownResults) {
        if (result.status === "rejected") {
            debugBenignError("app.shutdown", result.reason);
        }
    }
}

function createNativeAiGateway(input: {
    readonly capabilities: NativeCapabilitySet | null;
    readonly nativeClient: NativeBackendClient;
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
}): NativeAiGateway {
    console.info("[native-backend] Native AI backend enabled.");
    return new NativeAiGateway({
        capabilities: input.capabilities,
        client: input.nativeClient,
        onDiagnostic: (message) => {
            console.warn(`[native-ai] ${message}`);
        },
        onRuntimeStatus: input.onRuntimeStatus,
        onSessionCatalogPatch: input.onSessionCatalogPatch,
        onSessionEvent: input.onSessionEvent,
    });
}

function createTerminalGateway(input: {
    readonly nativeClient: NativeBackendClient;
    readonly onData: (ownerWindowId: string, event: TerminalDataEvent) => void;
    readonly onExit: (ownerWindowId: string, event: TerminalExitEvent) => void;
    readonly projectService: ProjectService;
    readonly settingsService: SettingsGateway;
}): TerminalGateway {
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
        aiResourceDir: path.join(process.resourcesPath, "ai"),
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
        nativeBackendCapabilities = capabilities.capabilities;
        console.info(
            `[native-backend] Started ${resolution.source} sidecar at ${resolution.binaryPath}. ${summarizeNativeBackendCapabilities(capabilities)}`,
        );
    } catch (error) {
        nativeBackendClient = null;
        nativeBackendCapabilities = null;
        await client.dispose();

        throw new Error(
            `[native-backend] Native backend startup failed: ${formatError(error)}`,
            { cause: error },
        );
    }
}

async function openNativePersistenceRequired(databaseFile: string): Promise<void> {
    if (!nativeBackendClient) {
        throw new Error(
            "Native persistence requires a running native backend sidecar.",
        );
    }

    const gateway = new NativePersistenceGateway(nativeBackendClient);

    try {
        const opened = await gateway.openStore({
            appDataDir: app.getPath("userData"),
            databasePath: databaseFile,
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
            { cause: error },
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
    // A projectless window is still a user-owned workspace and must survive restart.
    return snapshots;
}

async function openNewMainWindow(projectId: string | null): Promise<void> {
    await openNewMainWindowWithOptions({
        projectId,
    });
}

async function openOrFocusProjectWindow(
    input: OpenProjectWindowInput,
): Promise<void> {
    if (!persistenceService) {
        throw new Error("The persistence service is unavailable.");
    }

    const existingWindow = await activateExistingWorkspaceScope(
        input.projectId,
        input.worktreeId ?? null,
    );
    if (!existingWindow) {
        await openNewMainWindowWithOptions({
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
        throw new Error("The persistence service is unavailable.");
    }

    if (input.projectId) {
        const existingWindow = await activateExistingWorkspaceScope(
            input.projectId,
            input.worktreeId ?? null,
        );
        if (existingWindow) {
            return;
        }
    }

    const closedProjectSnapshot =
        input.projectId
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

async function activateExistingWorkspaceScope(
    projectId: string,
    worktreeId: string | null,
): Promise<BrowserWindow | null> {
    const location = workspaceSurfaceManager.findPreferredWorkspaceLocation({
        projectId,
        worktreeId,
    });
    if (location) {
        const window = windowRegistry.getWindowByStableId(
            location.hostWindowId,
        );
        const context = window
            ? windowRegistry.getContextByBrowserWindow(window)
            : null;
        if (!window || context?.windowKind !== "main") {
            return null;
        }
        workspaceSurfaceManager.activate(
            location.hostWindowId,
            location.contextKey,
        );
        const snapshot = workspaceSurfaceManager.getHostSnapshotForWindow(
            location.hostWindowId,
        );
        if (snapshot) {
            workspaceSurfaceManager
                .getHostWebContents(location.hostWindowId)
                ?.send(IPC_EVENTS.workspaceSurfaceSnapshotUpdated, snapshot);
            if (workspaceService && context.workspaceId) {
                await workspaceService.saveSnapshot(
                    context.workspaceId,
                    snapshot,
                );
            }
        }
        persistenceService?.saveActiveProjectId(
            location.hostWindowId,
            location.projectId,
            location.worktreeId,
        );
        windowRegistry.updateMainWindowProjectId(
            location.hostWindowId,
            location.projectId,
            location.worktreeId,
        );
        updateMainWindowTitle(window, location.projectId);
        focusExistingWindow(window);
        return window;
    }

    const pendingWindowContext = windowRegistry
        .listMainWindowContexts()
        .find(
            (context) =>
                context.projectId === projectId &&
                normalizeWorkspaceWorktreeId(projectId, context.worktreeId) ===
                    normalizeWorkspaceWorktreeId(projectId, worktreeId),
        );
    const pendingWindow = pendingWindowContext
        ? windowRegistry.getWindowByStableId(pendingWindowContext.windowId)
        : null;
    if (pendingWindow) {
        focusExistingWindow(pendingWindow);
    }
    return pendingWindow;
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

    const window = createMainWindow(
        snapshot.windowState,
        loadCurrentTransparencyEnabled(),
    );
    const context = snapshot.windowContext;

    window.webContents.once("did-finish-load", () => {
        void requestNativeBackendTestEventOnce();
    });
    window.webContents.on("did-finish-load", () => {
        attachAiSessionStream(window.webContents, context.windowId);
    });

    applyAppZoomToWindow(window, loadCurrentAppZoomFactor());
    windowRegistry.register(window, context);
    attachMainWindowLifecycle(window, context);
    persistenceService?.markWindowOpen(context.windowId);
    updateMainWindowTitle(window, context.projectId);

    return window;
}

async function moveWorkspaceContext(
    sourceWindowId: string,
    input: MoveWorkspaceContextInput,
): Promise<void> {
    if (!persistenceService || !workspaceService) {
        throw new Error("The workspace service is unavailable.");
    }
    await moveWorkspaceBetweenWindows(sourceWindowId, input, {
        captureContext: requestWorkspaceSurfaceContextCapture,
        createEmptyTarget: createEmptyWorkspaceTransferWindow,
        flushHost: async (windowId) => {
            const window = windowRegistry.getWindowByStableId(windowId);
            if (!window) {
                throw new Error("A workspace window is no longer available.");
            }
            await requestWorkspaceFlushesForHost(window, windowId);
        },
        getWindowContext: (windowId) =>
            windowRegistry
                .listMainWindowContexts()
                .find((context) => context.windowId === windowId) ?? null,
        isWindowAvailable: (windowId) =>
            Boolean(windowRegistry.getWindowByStableId(windowId)),
        manager: workspaceSurfaceManager,
        onTransferred: (sourceId, targetId, transfer) => {
            applyTransferredWorkspaceWindowState(
                sourceId,
                transfer.sourceSnapshot,
            );
            applyTransferredWorkspaceWindowState(
                targetId,
                transfer.targetSnapshot,
            );
            const targetWindow = windowRegistry.getWindowByStableId(targetId);
            if (targetWindow) {
                focusExistingWindow(targetWindow);
            }
        },
        workspaceService,
    });
}

async function createEmptyWorkspaceTransferWindow(): Promise<WindowContextSnapshot> {
    if (!persistenceService || !workspaceService) {
        throw new Error("The workspace service is unavailable.");
    }
    const focusedMainWindow = windowRegistry.getFocusedMainWindow();
    const focusedContext = focusedMainWindow
        ? windowRegistry.getContextByBrowserWindow(focusedMainWindow)
        : null;
    const shellState =
        focusedContext?.windowKind === "main"
            ? persistenceService.loadSnapshot(focusedContext.windowId).shellState
            : null;
    const persistenceSnapshot = await persistenceService.createMainWindowSession({
        projectId: null,
        shellState,
        worktreeId: null,
    });
    const context = persistenceSnapshot.windowContext;
    if (context?.windowKind !== "main" || !context.workspaceId) {
        throw new Error("Could not create the destination window.");
    }
    const emptySnapshot: WorkspaceNavigationSnapshot = {
        activeContextKey: null,
        contexts: [],
        openContextKeys: [],
        version: 3,
    };
    await workspaceService.saveSnapshot(context.workspaceId, emptySnapshot);
    createTrackedMainWindow(persistenceSnapshot);
    // The live surface can only be attached after the new host renderer has
    // hydrated its empty navigation and registered its content view owner.
    if (!(await workspaceSurfaceManager.waitForHost(context.windowId))) {
        throw new Error("The destination window did not finish starting.");
    }
    return context;
}

function applyTransferredWorkspaceWindowState(
    windowId: string,
    snapshot: WorkspaceNavigationSnapshot,
): void {
    const activeContext = snapshot.activeContextKey
        ? snapshot.contexts.find(
              (context) => context.key === snapshot.activeContextKey,
          ) ?? null
        : null;
    const projectId = activeContext?.projectId ?? null;
    const worktreeId = activeContext?.worktreeId ?? null;
    workspaceSurfaceManager
        .getHostWebContents(windowId)
        ?.send(IPC_EVENTS.workspaceSurfaceSnapshotUpdated, snapshot);
    persistenceService?.saveActiveProjectId(windowId, projectId, worktreeId);
    windowRegistry.updateMainWindowProjectId(windowId, projectId, worktreeId);
    const window = windowRegistry.getWindowByStableId(windowId);
    if (window) {
        updateMainWindowTitle(window, projectId);
    }
}

function loadCurrentAppZoomFactor(): number {
    return (
        settingsService?.loadAppAppearanceSettings().zoomFactor ??
        APP_ZOOM_FACTOR_DEFAULT
    );
}

function loadCurrentTransparencyEnabled(): boolean {
    return (
        settingsService?.loadAppAppearanceSettings().transparencyEnabled ?? true
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
            applyWindowTransparencyToWindow(
                window,
                appearance.transparencyEnabled,
            );
        });
        workspaceSurfaceManager.setZoomFactor(appearance.zoomFactor);
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
    let closeFlushComplete = false;
    let closeFlushInFlight = false;

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
    window.on("close", (event) => {
        persistWindowState();

        if (
            !isWorkspaceQuitReady &&
            !closeFlushComplete &&
            !window.webContents.isDestroyed()
        ) {
            event.preventDefault();
            if (!closeFlushInFlight) {
                closeFlushInFlight = true;
                void requestWorkspaceFlushesForHost(window, context.windowId).finally(() => {
                    closeFlushComplete = true;
                    closeFlushInFlight = false;
                    if (!window.isDestroyed()) {
                        window.close();
                    }
                });
            }
            return;
        }

        if (isClosingLastAppWindow()) {
            isQuitting = true;
        }
    });
    window.on("closed", () => {
        if (timeout) {
            clearTimeout(timeout);
        }

        detachAiSessionStream(context.windowId);
        workspaceSurfaceManager.disposeHost(context.windowId);

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

async function requestWorkspaceFlush(webContents: WebContents): Promise<void> {
    const requestId = `${webContents.id}:${++nextWorkspaceFlushRequestId}`;
    await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            pendingWorkspaceFlushes.delete(requestId);
            resolve();
        };
        const timer = setTimeout(finish, 1_500);
        pendingWorkspaceFlushes.set(requestId, {
            resolve: finish,
            senderId: webContents.id,
        });
        webContents.send(
            IPC_EVENTS.workspaceFlushRequested,
            requestId,
        );
    });
}

async function requestWorkspaceFlushesForHost(
    window: BrowserWindow,
    hostWindowId: string,
): Promise<void> {
    const surfaces = workspaceSurfaceManager.getWebContentsForHost(hostWindowId);
    await Promise.all([
        requestWorkspaceFlush(window.webContents),
        ...surfaces.map((webContents) => requestWorkspaceFlush(webContents)),
    ]);
}

async function requestWorkspaceSurfaceContextCapture(
    hostWindowId: string,
    contextKey: string,
): Promise<WorkspaceNavigationSnapshot | null> {
    const surface = workspaceSurfaceManager.getSurfaceWebContents(
        hostWindowId,
        contextKey,
    );
    if (!surface) {
        return workspaceSurfaceManager.getHostSnapshotForWindow(hostWindowId);
    }
    const snapshot = await requestWorkspaceSurfaceSnapshot(surface);
    if (!snapshot) {
        return null;
    }
    return workspaceSurfaceManager.mergeSurfaceSnapshot(surface, snapshot)?.snapshot ?? null;
}

async function requestWorkspaceSurfaceSnapshot(
    webContents: WebContents,
): Promise<WorkspaceNavigationSnapshot | null> {
    const requestId = `snapshot:${webContents.id}:${++nextWorkspaceFlushRequestId}`;
    return await new Promise<WorkspaceNavigationSnapshot | null>((resolve) => {
        const timer = setTimeout(() => {
            pendingWorkspaceSurfaceCaptures.delete(requestId);
            resolve(null);
        }, 500);
        pendingWorkspaceSurfaceCaptures.set(requestId, {
            resolve: (snapshot) => {
                clearTimeout(timer);
                resolve(snapshot);
            },
            senderId: webContents.id,
        });
        webContents.send(
            IPC_EVENTS.workspaceSurfaceSnapshotRequested,
            requestId,
        );
    });
}

async function flushAllWorkspaceWindowsForQuit(): Promise<void> {
    const windows = BrowserWindow.getAllWindows().filter((window) => {
        if (window.isDestroyed() || window.webContents.isDestroyed()) {
            return false;
        }
        return windowRegistry.getContextByBrowserWindow(window)?.windowKind === "main";
    });
    await Promise.all(
        windows.map((window) => {
            const context = windowRegistry.getContextByBrowserWindow(window);
            return requestWorkspaceFlushesForHost(
                window,
                context?.windowId ?? `${window.id}`,
            );
        }),
    );
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
    windowRegistry.forEachLiveWebContents((webContents) => {
        webContents.send(IPC_EVENTS.projectTreeInvalidated, payload);
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
        clearLegacyGitCacheIfAny(worktree.rootPath);
        broadcastGitRepositoryInvalidated({
            generation: payload.generation,
            occurredAt: payload.occurredAt,
            projectId: payload.projectId,
            reason: "filesystem",
            rootPath: worktree.rootPath,
            worktreeId: worktree.id ?? null,
        });
    }
}

function clearLegacyGitCacheIfAny(rootPath: string): void {
    // Legacy Git gateways may cache command results; native Git implements this as a no-op.
    gitService?.invalidate(rootPath);
}

function broadcastGitRepositoryInvalidated(
    payload: GitRepositoryInvalidation,
): void {
    windowRegistry.forEachLiveWebContents((webContents) => {
        webContents.send(IPC_EVENTS.gitRepositoryInvalidated, payload);
    });
}

export function broadcastGitRepositorySnapshotUpdated(
    payload: GitRepositorySnapshot,
): void {
    windowRegistry.forEachLiveWebContents((webContents) => {
        webContents.send(
            IPC_EVENTS.gitRepositorySnapshotUpdated,
            payload,
        );
    });
}

export function broadcastGitWorktreesUpdated(
    payload: GitRepositoryInvalidation,
): void {
    windowRegistry.forEachLiveWebContents((webContents) => {
        webContents.send(IPC_EVENTS.gitWorktreesUpdated, payload);
    });
}

function broadcastNativeBackendEvent(event: NativeBackendEvent): void {
    if (event.eventName === "project://tree-invalidated") {
        try {
            const invalidation = nativeProjectTreeInvalidationToIpc(
                event.payload as NativeProjectTreeInvalidation,
            );
            projectInvalidationCoordinator?.enqueue(invalidation);
        } catch (error) {
            debugBenignError("nativeBackend.projectTreeInvalidation", error);
        }
    }

    try {
        const gitInvalidation = nativeGitEventToIpcInvalidation(event);
        if (gitInvalidation) {
            broadcastGitRepositoryInvalidated(gitInvalidation);
        }
    } catch (error) {
        debugBenignError("nativeBackend.gitInvalidation", error);
    }

    windowRegistry.forEachLiveWebContents((webContents) => {
        webContents.send(IPC_EVENTS.nativeBackendEvent, event);
    });
}

function broadcastAiRuntimeStatus(payload: AiRuntimeStatus): void {
    windowRegistry.forEachLiveWebContents((webContents) => {
        webContents.send(IPC_EVENTS.aiRuntimeStatus, payload);
    });
}

function broadcastAiPromptQueueSnapshot(
    ownerWindowId: string,
    payload: AiPromptQueueSnapshot,
): void {
    const targetContents = windowRegistry.getWebContentsByOwnerId(ownerWindowId);
    if (targetContents) {
        targetContents.send(IPC_EVENTS.aiPromptQueue, payload);
    }
    const hostContents = workspaceSurfaceManager.getHostWebContentsForOwner(
        ownerWindowId,
    );
    if (hostContents && hostContents !== targetContents) {
        hostContents.send(IPC_EVENTS.aiPromptQueue, payload);
    }
}

function broadcastAiSessionSnapshot(
    ownerWindowId: string,
    payload: AiSessionUpdate,
): void {
    if (!ownerWindowId) {
        windowRegistry.forEachLiveWebContents((webContents) => {
            dispatchAiSessionSnapshot(webContents, payload);
        });
        return;
    }

    const targetContents = windowRegistry.getWebContentsByOwnerId(ownerWindowId);
    if (targetContents) {
        dispatchAiSessionSnapshot(targetContents, payload, ownerWindowId);
    }
    const hostContents = workspaceSurfaceManager.getHostWebContentsForOwner(
        ownerWindowId,
    );
    if (hostContents && hostContents !== targetContents) {
        dispatchAiSessionSnapshot(hostContents, payload, ownerWindowId, false);
    }
}

function broadcastAiSessionEvent(
    ownerWindowId: string,
    payload: AiSessionDomainEvent,
): void {
    if (!ownerWindowId) {
        windowRegistry.forEachLiveWebContents((webContents) => {
            dispatchAiSessionEvent(webContents, payload);
        });
        return;
    }

    const targetContents = windowRegistry.getWebContentsByOwnerId(ownerWindowId);
    if (targetContents) {
        dispatchAiSessionEvent(targetContents, payload, ownerWindowId);
    }
    const hostContents = workspaceSurfaceManager.getHostWebContentsForOwner(
        ownerWindowId,
    );
    if (hostContents && hostContents !== targetContents) {
        dispatchAiSessionEvent(hostContents, payload, ownerWindowId, false);
    }
}

function attachAiSessionStream(webContents: WebContents, windowId: string): void {
    if (webContents.isDestroyed()) {
        detachAiSessionStream(windowId);
        return;
    }

    detachAiSessionStream(windowId);

    const channel = new MessageChannelMain();

    try {
        // Re-check `isDestroyed` atomically next to the `postMessage` call so
        // a teardown that lands between the outer guard and this line cannot
        // leak the transferred port into a dead renderer.
        if (webContents.isDestroyed()) {
            channel.port1.close();
            channel.port2.close();
            return;
        }
        webContents.postMessage(IPC_EVENTS.aiSessionStreamPort, null, [
            channel.port2,
        ]);
        const now = Date.now();
        const state: AiSessionStreamPortState = {
            heartbeatTimer: null,
            lastAckAt: now,
            lastAckSeq: 0,
            lastSentAt: now,
            lastSentSeq: 0,
            nextSeq: 1,
            pendingAckSentAtBySeq: new Map(),
            pendingPreservedPayloads: new Map(),
            port: channel.port1,
            staleTimer: null,
        };
        channel.port1.on("message", (event: { data: unknown }) => {
            handleAiSessionStreamPortMessage(windowId, event.data);
        });
        channel.port1.start();
        state.heartbeatTimer = setInterval(() => {
            sendAiSessionStreamHeartbeat(windowId);
        }, AI_SESSION_STREAM_HEARTBEAT_MS);
        state.heartbeatTimer.unref?.();
        aiSessionStreamPorts.set(windowId, state);
        sendAiSessionStreamHeartbeat(windowId);
    } catch (error) {
        debugBenignError("attachAiSessionStream", error);
        channel.port1.close();
        channel.port2.close();
    }
}

function detachAiSessionStream(windowId: string): void {
    const state = aiSessionStreamPorts.get(windowId);
    if (!state) {
        return;
    }

    aiSessionStreamPorts.delete(windowId);
    if (state.heartbeatTimer) {
        clearInterval(state.heartbeatTimer);
    }
    if (state.staleTimer) {
        clearTimeout(state.staleTimer);
    }
    state.port.removeAllListeners("message");
    state.port.close();
}

function handleAiSessionStreamPortMessage(
    windowId: string,
    message: unknown,
): void {
    if (typeof message !== "object" || message === null) {
        return;
    }

    const candidate = message as {
        readonly seq?: unknown;
        readonly type?: unknown;
    };
    if (candidate.type !== "ack" || typeof candidate.seq !== "number") {
        return;
    }

    const state = aiSessionStreamPorts.get(windowId);
    if (!state) {
        return;
    }

    state.lastAckAt = Date.now();
    state.lastAckSeq = Math.max(state.lastAckSeq, candidate.seq);
    for (const seq of [...state.pendingAckSentAtBySeq.keys()]) {
        if (seq <= state.lastAckSeq) {
            state.pendingAckSentAtBySeq.delete(seq);
        }
    }
    for (const [key, pendingPayload] of state.pendingPreservedPayloads) {
        if (pendingPayload.seq <= state.lastAckSeq) {
            state.pendingPreservedPayloads.delete(key);
        }
    }
}

function nextAiSessionStreamMessage(
    state: AiSessionStreamPortState,
    payload: AiSessionStreamPayload,
): AiSessionStreamMessage {
    const seq = state.nextSeq;
    state.nextSeq += 1;
    state.lastSentAt = Date.now();
    state.lastSentSeq = seq;
    state.pendingAckSentAtBySeq.set(seq, state.lastSentAt);
    return {
        payload,
        seq,
        type: "payload",
    };
}

function nextAiSessionStreamPing(
    state: AiSessionStreamPortState,
): AiSessionStreamMessage {
    const seq = state.nextSeq;
    state.nextSeq += 1;
    state.lastSentAt = Date.now();
    state.lastSentSeq = seq;
    state.pendingAckSentAtBySeq.set(seq, state.lastSentAt);
    return {
        sentAt: state.lastSentAt,
        seq,
        type: "ping",
    };
}

function preserveAiSessionStreamPayload(
    windowId: string,
    state: AiSessionStreamPortState,
    payload: AiSessionStreamPayload,
    seq: number,
): void {
    const result = rememberAiSessionStreamPayloadForRecovery({
        maxPayloads: AI_SESSION_STREAM_MAX_PRESERVED_PAYLOADS,
        payload,
        queue: state.pendingPreservedPayloads,
        seq,
    });
    if (!result.droppedOldest) {
        return;
    }

    debugBenignError(
        "aiSessionStreamPort.preservedPayloads",
        new Error(
            JSON.stringify({
                limit: AI_SESSION_STREAM_MAX_PRESERVED_PAYLOADS,
                pendingPreservedPayloadCount: result.pendingCount,
                windowId,
            }),
        ),
    );
}

function sendAiSessionStreamHeartbeat(windowId: string): void {
    const state = aiSessionStreamPorts.get(windowId);
    if (!state) {
        return;
    }

    if (
        isAiSessionStreamAckStale(
            state,
            Date.now(),
            AI_SESSION_STREAM_ACK_STALE_MS,
        )
    ) {
        recoverAiSessionStreamPort(windowId, "heartbeat-stale");
        return;
    }

    try {
        state.port.postMessage(nextAiSessionStreamPing(state));
        scheduleAiSessionStreamStaleCheck(windowId);
    } catch (error) {
        debugBenignError("aiSessionStreamPort.heartbeat", error);
        recoverAiSessionStreamPort(windowId, "heartbeat-error");
    }
}

function scheduleAiSessionStreamStaleCheck(windowId: string): void {
    const state = aiSessionStreamPorts.get(windowId);
    if (!state) {
        return;
    }

    if (state.staleTimer) {
        clearTimeout(state.staleTimer);
    }
    state.staleTimer = setTimeout(() => {
        const latestState = aiSessionStreamPorts.get(windowId);
        if (
            !latestState ||
            !isAiSessionStreamAckStale(
                latestState,
                Date.now(),
                AI_SESSION_STREAM_ACK_STALE_MS,
            )
        ) {
            return;
        }
        recoverAiSessionStreamPort(windowId, "ack-timeout");
    }, AI_SESSION_STREAM_ACK_STALE_MS);
    state.staleTimer.unref?.();
}

function recoverAiSessionStreamPort(
    windowId: string,
    reason: AiSessionStreamRecoveryReason,
): void {
    const state = aiSessionStreamPorts.get(windowId);
    const targetContents = windowRegistry.getWebContentsByOwnerId(windowId);
    const pendingPreservedPayloadCount =
        state?.pendingPreservedPayloads.size ?? 0;
    const canSendFallback = Boolean(
        targetContents && !targetContents.isDestroyed(),
    );
    const resyncSnapshots = canSendFallback
        ? (aiService?.getLiveSessionSnapshotsForWindow(windowId) ?? [])
        : [];

    if (targetContents && canSendFallback) {
        const fallbackPayloads = buildAiSessionStreamRecoveryFallbackPayloads({
            pendingPreservedPayloads: state
                ? [...state.pendingPreservedPayloads.values()]
                : [],
            resyncSnapshots,
        });
        state?.pendingPreservedPayloads.clear();
        for (const payload of fallbackPayloads) {
            sendAiSessionStreamPayloadOverIpc(targetContents, payload);
        }
    }

    const message = state
        ? JSON.stringify(
              buildAiSessionStreamRecoveryDiagnostic({
                  nowMs: Date.now(),
                  pendingPreservedPayloadCount,
                  reason,
                  resyncSnapshotCount: resyncSnapshots.length,
                  state,
              }),
          )
        : reason;
    debugBenignError("aiSessionStreamPort.recover", new Error(message));
    detachAiSessionStream(windowId);
    if (targetContents && !targetContents.isDestroyed()) {
        attachAiSessionStream(targetContents, windowId);
    }
}

function sendAiSessionStreamPayloadOverIpc(
    webContents: WebContents,
    payload: AiSessionStreamPayload,
): void {
    if (isAiSessionUpdate(payload)) {
        webContents.send(IPC_EVENTS.aiSessionSnapshot, payload);
    } else {
        webContents.send(IPC_EVENTS.aiSessionEvent, payload);
    }
}

function postAiSessionStreamPayload(
    windowId: string,
    payload: AiSessionStreamPayload,
): boolean {
    const state = aiSessionStreamPorts.get(windowId);
    if (!state) {
        return false;
    }

    if (
        isAiSessionStreamAckStale(
            state,
            Date.now(),
            AI_SESSION_STREAM_ACK_STALE_MS,
        )
    ) {
        recoverAiSessionStreamPort(windowId, "pre-send-stale");
        return false;
    }

    const message = nextAiSessionStreamMessage(state, payload);
    preserveAiSessionStreamPayload(windowId, state, payload, message.seq);

    try {
        state.port.postMessage(message);
        scheduleAiSessionStreamStaleCheck(windowId);
        return true;
    } catch (error) {
        debugBenignError("aiSessionStreamPort.postMessage", error);
        recoverAiSessionStreamPort(windowId, "post-error");
        return false;
    }
}

function dispatchAiSessionSnapshot(
    webContents: WebContents,
    payload: AiSessionUpdate,
    windowId?: string,
    preferStream = true,
): void {
    const stableWindowId =
        windowId ??
        windowRegistry.getContextByWebContents(webContents)?.windowId ??
        null;

    if (stableWindowId && preferStream) {
        if (postAiSessionStreamPayload(stableWindowId, payload)) {
            return;
        }
    }

    webContents.send(IPC_EVENTS.aiSessionSnapshot, payload);
}

function dispatchAiSessionEvent(
    webContents: WebContents,
    payload: AiSessionDomainEvent,
    windowId?: string,
    preferStream = true,
): void {
    const stableWindowId =
        windowId ??
        windowRegistry.getContextByWebContents(webContents)?.windowId ??
        null;

    if (stableWindowId && preferStream) {
        if (postAiSessionStreamPayload(stableWindowId, payload)) {
            return;
        }
    }

    webContents.send(IPC_EVENTS.aiSessionEvent, payload);
}

function broadcastTerminalData(
    ownerWindowId: string,
    payload: TerminalDataEvent,
): void {
    windowRegistry
        .getWebContentsByOwnerId(ownerWindowId)
        ?.send(IPC_EVENTS.terminalData, payload);
}

function broadcastTerminalExit(
    ownerWindowId: string,
    payload: TerminalExitEvent,
): void {
    windowRegistry
        .getWebContentsByOwnerId(ownerWindowId)
        ?.send(IPC_EVENTS.terminalExit, payload);
}
