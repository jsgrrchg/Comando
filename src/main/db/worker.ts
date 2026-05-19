import { parentPort, type MessagePort } from "node:worker_threads";

import type {
    AiRuntimeId,
    ClaudeRuntimeSettings,
    CodexRuntimeSettings,
    DatabaseStatus,
    GeminiRuntimeSettings,
    GetAiSessionTranscriptPageInput,
    KiloRuntimeSettings,
    ListAiSessionHistoryInput,
    PersistenceSnapshot,
} from "@shared/ipc";

import { AiPersistence } from "../ai/persistence";
import { bootstrapDatabase } from "./index";
import { PersistenceService } from "../persistence/service";
import { SqliteProjectStore } from "../projects/store";
import { SettingsService } from "../settings/service";
import { WorkspaceService } from "../workspace/service";

interface DbWorkerInitMessage {
    readonly appWindowTitle?: string;
    readonly fileName?: string;
    readonly port: MessagePort;
    readonly dataDir: string;
}

interface DbWorkerRequest {
    readonly id: number;
    readonly method: string;
    readonly params?: unknown;
}

interface DbWorkerResponse {
    readonly id: number;
    readonly result?: unknown;
    readonly error?: SerializedError;
}

interface SerializedError {
    readonly message: string;
    readonly name: string;
    readonly stack?: string;
}

interface DbWorkerReadyMessage {
    readonly bootstrap: DbWorkerBootstrapState;
    readonly type: "ready";
}

interface DbWorkerFatalMessage {
    readonly error: SerializedError;
    readonly type: "fatal";
}

export interface DbWorkerBootstrapState {
    readonly ai: {
        readonly runtimeCatalogs: Record<
            AiRuntimeId,
            ReturnType<AiPersistence["loadLatestRuntimeCatalog"]>
        >;
        readonly runtimeSelectionPreferences: Record<
            AiRuntimeId,
            ReturnType<AiPersistence["loadRuntimeSelectionPreferences"]>
        >;
    };
    readonly database: DatabaseStatus;
    readonly persistenceSnapshots: readonly PersistenceSnapshot[];
    readonly projectState: ReturnType<SqliteProjectStore["loadState"]>;
    readonly secretRecords: Record<string, string | null>;
    readonly settings: ReturnType<SettingsService["loadSnapshot"]>;
}

const runtimeIds = [
    "claude",
    "codex",
    "gemini",
    "kilo",
] as const satisfies readonly AiRuntimeId[];

const bootstrapSecretKeys = [
    "secret.ai.claude.anthropic_auth_token",
    "secret.ai.claude.anthropic_custom_headers",
    "secret.ai.codex.codex_api_key",
    "secret.ai.codex.openai_api_key",
    "secret.ai.gemini.gemini_api_key",
    "secret.ai.gemini.google_api_key",
    "secret.github.token",
] as const;

let rpcPort: MessagePort | null = null;
let database = null as ReturnType<typeof bootstrapDatabase> | null;
let persistenceService = null as PersistenceService | null;
let settingsService = null as SettingsService | null;
let workspaceService = null as WorkspaceService | null;
let aiPersistence = null as AiPersistence | null;
let projectStore = null as SqliteProjectStore | null;

parentPort?.once("message", (message: unknown) => {
    initializeWorker(message as DbWorkerInitMessage);
});

function initializeWorker(message: DbWorkerInitMessage): void {
    try {
        rpcPort = message.port;
        database = bootstrapDatabase({
            dataDir: message.dataDir,
            fileName: message.fileName,
        });
        persistenceService = new PersistenceService(database.connection, {
            windowTitle: message.appWindowTitle,
        });
        settingsService = new SettingsService(database.connection);
        workspaceService = new WorkspaceService(database.connection);
        aiPersistence = new AiPersistence(database.connection);
        projectStore = new SqliteProjectStore(database.connection);

        rpcPort.on("message", (request: unknown) => {
            void handleRequest(request as DbWorkerRequest);
        });
        rpcPort.start?.();
        rpcPort.postMessage({
            bootstrap: buildBootstrapState(),
            type: "ready",
        } satisfies DbWorkerReadyMessage);
    } catch (error) {
        const payload = {
            error: serializeError(error),
            type: "fatal",
        } satisfies DbWorkerFatalMessage;

        if (message.port) {
            message.port.postMessage(payload);
        } else {
            parentPort?.postMessage(payload);
        }
    }
}

function handleRequest(request: DbWorkerRequest): void {
    if (!rpcPort) {
        return;
    }

    if (request.method === "system.shutdown") {
        performShutdown(request.id);
        return;
    }

    try {
        const result = dispatchMethod(request.method, request.params);
        rpcPort.postMessage({
            id: request.id,
            result,
        } satisfies DbWorkerResponse);
    } catch (error) {
        rpcPort.postMessage({
            error: serializeError(error),
            id: request.id,
        } satisfies DbWorkerResponse);
    }
}

function performShutdown(requestId: number): void {
    const port = rpcPort;
    if (!port) {
        return;
    }

    // Drop rpcPort immediately so any queued request after the shutdown
    // is ignored by handleRequest instead of touching resources we are
    // about to release.
    rpcPort = null;

    // Stop dispatching queued incoming messages. Without this, messages
    // that arrived before the main side tore down could still fire
    // during Isolate teardown via queued microtasks.
    port.removeAllListeners("message");

    // Acknowledge the shutdown before releasing resources so the main
    // thread can stop waiting and close its side of the port.
    try {
        port.postMessage({
            id: requestId,
            result: true,
        } satisfies DbWorkerResponse);
    } catch {
        // Port may already be closed by the main side during app exit.
    }

    // Defer the native teardown to the next tick. This lets the
    // acknowledgement flush and any pending better-sqlite3 finalizers
    // run to completion before the V8 Isolate starts being disposed,
    // which has been observed to crash the worker otherwise.
    setImmediate(() => {
        try {
            database?.close();
        } catch {
            // Close failures during shutdown are not actionable.
        } finally {
            database = null;
            persistenceService = null;
            settingsService = null;
            workspaceService = null;
            aiPersistence = null;
            projectStore = null;
        }

        try {
            port.close();
        } catch {
            // Already closed by the main side.
        }
    });
}

function dispatchMethod(method: string, params: unknown): unknown {
    if (
        !database ||
        !persistenceService ||
        !settingsService ||
        !workspaceService ||
        !aiPersistence ||
        !projectStore
    ) {
        throw new Error("The DB worker is not initialized yet.");
    }

    switch (method) {
        case "ai.loadBootstrapState":
            return buildAiBootstrapState();
        case "ai.loadSessionSnapshot":
            return aiPersistence.loadSessionSnapshot(params as string);
        case "ai.listSessionHistory":
            return aiPersistence.listSessionHistory(
                params as ListAiSessionHistoryInput,
            );
        case "ai.loadSessionTranscriptPage":
            return aiPersistence.loadSessionTranscriptPage(
                params as GetAiSessionTranscriptPageInput,
            );
        case "ai.deleteSession":
            aiPersistence.deleteSession(params as string);
            return null;
        case "ai.setSessionPinned": {
            const input = params as {
                readonly pinned: Parameters<
                    AiPersistence["setSessionPinned"]
                >[1];
                readonly sessionId: Parameters<
                    AiPersistence["setSessionPinned"]
                >[0];
            };
            aiPersistence.setSessionPinned(input.sessionId, input.pinned);
            return null;
        }
        case "ai.saveRuntimeSelectionPreferences": {
            const input = params as {
                readonly patch: Parameters<
                    AiPersistence["saveRuntimeSelectionPreferences"]
                >[1];
                readonly runtimeId: Parameters<
                    AiPersistence["saveRuntimeSelectionPreferences"]
                >[0];
            };
            aiPersistence.saveRuntimeSelectionPreferences(
                input.runtimeId,
                input.patch,
            );
            return null;
        }
        case "ai.saveRuntimeSelectionPreferenceOption": {
            const input = params as {
                readonly optionId: string;
                readonly runtimeId: AiRuntimeId;
                readonly value: boolean | string;
            };
            aiPersistence.saveRuntimeSelectionPreferenceOption(
                input.runtimeId,
                input.optionId,
                input.value,
            );
            return null;
        }
        case "ai.saveRuntimeModePreference": {
            const input = params as {
                readonly modeId: string;
                readonly runtimeId: AiRuntimeId;
            };
            aiPersistence.saveRuntimeModePreference(
                input.runtimeId,
                input.modeId,
            );
            return null;
        }
        case "ai.saveRuntimeModelPreference": {
            const input = params as {
                readonly modelId: string;
                readonly runtimeId: AiRuntimeId;
            };
            aiPersistence.saveRuntimeModelPreference(
                input.runtimeId,
                input.modelId,
            );
            return null;
        }
        case "ai.saveSessionSnapshot": {
            const input = params as {
                readonly draft?: string;
                readonly snapshot: Parameters<
                    AiPersistence["saveSessionSnapshot"]
                >[0];
            };
            aiPersistence.saveSessionSnapshot(input.snapshot, input.draft);
            return null;
        }
        case "persistence.createMainWindowSession":
            return persistenceService.createMainWindowSession(
                params as Parameters<
                    PersistenceService["createMainWindowSession"]
                >[0],
            );
        case "persistence.findClosedMainWindowSnapshotForProject": {
            const input = params as {
                readonly projectId: string;
                readonly worktreeId?: string | null;
            };
            return persistenceService.findClosedMainWindowSnapshotForProject(
                input.projectId,
                input.worktreeId,
            );
        }
        case "persistence.saveActiveProjectId": {
            const input = params as {
                readonly projectId: string | null;
                readonly windowId: string;
                readonly worktreeId?: string | null;
            };
            persistenceService.saveActiveProjectId(
                input.windowId,
                input.projectId,
                input.worktreeId,
            );
            return null;
        }
        case "persistence.saveShellState": {
            const input = params as {
                readonly shellState: Parameters<
                    PersistenceService["saveShellState"]
                >[1];
                readonly windowId: string;
            };
            persistenceService.saveShellState(input.windowId, input.shellState);
            return null;
        }
        case "persistence.saveWindowState":
            persistenceService.saveWindowState(
                params as Parameters<PersistenceService["saveWindowState"]>[0],
            );
            return null;
        case "persistence.markWindowClosed":
            persistenceService.markWindowClosed(params as string);
            return null;
        case "persistence.markWindowOpen":
            persistenceService.markWindowOpen(params as string);
            return null;
        case "projects.loadState":
            return projectStore.loadState();
        case "projects.addProjectPaths": {
            const result = projectStore.addProjectPaths(params as string[]);
            return {
                state: projectStore.loadState(),
                touchedProjectIds: result.touchedProjectIds,
                touchedRootPaths: result.touchedRootPaths,
            };
        }
        case "projects.clearProjectAppData": {
            const summary = projectStore.clearProjectAppData(params as string);
            return {
                state: projectStore.loadState(),
                summary,
            };
        }
        case "projects.getProjectAppDataSummary":
            return projectStore.getProjectAppDataSummary(params as string);
        case "projects.relocateProject": {
            const input = params as {
                readonly projectId: string;
                readonly projectPath: string;
            };
            const project = projectStore.relocateProject(
                input.projectId,
                input.projectPath,
            );
            return {
                project,
                state: projectStore.loadState(),
            };
        }
        case "projects.removeProject":
            projectStore.removeProject(params as string);
            return null;
        case "projects.touchProject":
            projectStore.touchProject(params as string);
            return null;
        case "projects.syncProjectWorktrees": {
            const input = params as {
                readonly projectId: string;
                readonly worktrees: Parameters<
                    SqliteProjectStore["syncProjectWorktrees"]
                >[1];
            };
            return projectStore.syncProjectWorktrees(
                input.projectId,
                input.worktrees,
            );
        }
        case "secrets.loadRecords":
            return loadSecretRecords(params as readonly string[]);
        case "secrets.saveRecord": {
            const input = params as {
                readonly key: string;
                readonly value: string | null;
            };
            saveSecretRecord(input.key, input.value);
            return null;
        }
        case "ai.saveCodexAuth": {
            const settings = requireSettingsService();
            const input = params as {
                readonly secrets: readonly SecretRecordMutation[];
                readonly settings: CodexRuntimeSettings;
            };
            runAuthSettingsTransaction(input.secrets, () => {
                settings.saveCodexRuntimeSettings(input.settings);
            });
            return null;
        }
        case "ai.saveClaudeAuth": {
            const settings = requireSettingsService();
            const input = params as {
                readonly secrets: readonly SecretRecordMutation[];
                readonly settings: ClaudeRuntimeSettings;
            };
            runAuthSettingsTransaction(input.secrets, () => {
                settings.saveClaudeRuntimeSettings(input.settings);
            });
            return null;
        }
        case "ai.saveGeminiAuth": {
            const settings = requireSettingsService();
            const input = params as {
                readonly secrets: readonly SecretRecordMutation[];
                readonly settings: GeminiRuntimeSettings;
            };
            runAuthSettingsTransaction(input.secrets, () => {
                settings.saveGeminiRuntimeSettings(input.settings);
            });
            return null;
        }
        case "ai.saveKiloAuth": {
            const settings = requireSettingsService();
            const input = params as {
                readonly secrets: readonly SecretRecordMutation[];
                readonly settings: KiloRuntimeSettings;
            };
            runAuthSettingsTransaction(input.secrets, () => {
                settings.saveKiloRuntimeSettings(input.settings);
            });
            return null;
        }
        case "settings.loadSnapshot":
            return settingsService.loadSnapshot();
        case "settings.saveSnapshot":
            settingsService.saveSnapshot(
                params as Parameters<SettingsService["saveSnapshot"]>[0],
            );
            return null;
        case "settings.saveProjectSettings":
            settingsService.saveProjectSettings(
                params as Parameters<SettingsService["saveProjectSettings"]>[0],
            );
            return null;
        case "settings.saveAppAppearanceSettings":
            settingsService.saveAppAppearanceSettings(
                params as Parameters<
                    SettingsService["saveAppAppearanceSettings"]
                >[0],
            );
            return null;
        case "settings.saveAppEditorSettings":
            settingsService.saveAppEditorSettings(
                params as Parameters<
                    SettingsService["saveAppEditorSettings"]
                >[0],
            );
            return null;
        case "settings.saveAiChatSettings":
            settingsService.saveAiChatSettings(
                params as Parameters<SettingsService["saveAiChatSettings"]>[0],
            );
            return null;
        case "settings.saveCodexRuntimeSettings":
            settingsService.saveCodexRuntimeSettings(
                params as Parameters<
                    SettingsService["saveCodexRuntimeSettings"]
                >[0],
            );
            return null;
        case "settings.saveClaudeRuntimeSettings":
            settingsService.saveClaudeRuntimeSettings(
                params as Parameters<
                    SettingsService["saveClaudeRuntimeSettings"]
                >[0],
            );
            return null;
        case "settings.saveGeminiRuntimeSettings":
            settingsService.saveGeminiRuntimeSettings(
                params as Parameters<
                    SettingsService["saveGeminiRuntimeSettings"]
                >[0],
            );
            return null;
        case "settings.saveKiloRuntimeSettings":
            settingsService.saveKiloRuntimeSettings(
                params as Parameters<
                    SettingsService["saveKiloRuntimeSettings"]
                >[0],
            );
            return null;
        case "workspace.loadSnapshot":
            return workspaceService.loadSnapshot(params as string);
        case "workspace.saveSnapshot": {
            const input = params as {
                readonly snapshot: Parameters<
                    WorkspaceService["saveSnapshot"]
                >[1];
                readonly workspaceId: string;
            };
            workspaceService.saveSnapshot(input.workspaceId, input.snapshot);
            return null;
        }
        case "workspace.loadChatSessionState":
            return workspaceService.loadChatSessionState(params as string);
        default:
            throw new Error(`Unknown DB worker method: ${method}`);
    }
}

interface SecretRecordMutation {
    readonly key: string;
    readonly value: string | null;
}

function buildBootstrapState(): DbWorkerBootstrapState {
    if (!database || !persistenceService || !settingsService || !projectStore) {
        throw new Error("The DB worker is not initialized yet.");
    }

    return {
        ai: buildAiBootstrapState(),
        database: database.status,
        persistenceSnapshots:
            persistenceService.listRestorableMainWindowSnapshots(),
        projectState: projectStore.loadState(),
        secretRecords: loadSecretRecords(bootstrapSecretKeys),
        settings: settingsService.loadSnapshot(),
    };
}

function buildAiBootstrapState(): DbWorkerBootstrapState["ai"] {
    if (!aiPersistence) {
        throw new Error("The AI persistence service is not initialized yet.");
    }

    const runtimeCatalogs =
        {} as DbWorkerBootstrapState["ai"]["runtimeCatalogs"];
    const runtimeSelectionPreferences =
        {} as DbWorkerBootstrapState["ai"]["runtimeSelectionPreferences"];

    for (const runtimeId of runtimeIds) {
        runtimeCatalogs[runtimeId] =
            aiPersistence.loadLatestRuntimeCatalog(runtimeId);
        runtimeSelectionPreferences[runtimeId] =
            aiPersistence.loadRuntimeSelectionPreferences(runtimeId);
    }

    return {
        runtimeCatalogs,
        runtimeSelectionPreferences,
    };
}

function loadSecretRecords(
    keys: readonly string[],
): Record<string, string | null> {
    if (!database) {
        throw new Error("The database is not initialized yet.");
    }

    const selectSetting = database.connection.prepare<
        [string],
        { value: string } | undefined
    >("SELECT value FROM app_settings WHERE key = ?");
    const records: Record<string, string | null> = {};

    for (const key of keys) {
        records[key] = selectSetting.get(key)?.value ?? null;
    }

    return records;
}

function saveSecretRecord(key: string, value: string | null): void {
    if (!database) {
        throw new Error("The database is not initialized yet.");
    }

    if (value === null) {
        database.connection
            .prepare<[string], void>("DELETE FROM app_settings WHERE key = ?")
            .run(key);
        return;
    }

    database.connection
        .prepare<[string, string, string], void>(
            `
            INSERT INTO app_settings (key, value, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = excluded.updated_at
            `,
        )
        .run(key, value, new Date().toISOString());
}

function runAuthSettingsTransaction(
    secrets: readonly SecretRecordMutation[],
    saveSettings: () => void,
): void {
    if (!database) {
        throw new Error("The database is not initialized yet.");
    }

    database.connection.transaction(() => {
        for (const secret of secrets) {
            saveSecretRecord(secret.key, secret.value);
        }
        saveSettings();
    })();
}

function requireSettingsService(): SettingsService {
    if (!settingsService) {
        throw new Error("The settings service is not initialized yet.");
    }

    return settingsService;
}

function serializeError(error: unknown): SerializedError {
    if (error instanceof Error) {
        return {
            message: error.message,
            name: error.name,
            stack: error.stack,
        };
    }

    return {
        message: String(error),
        name: "Error",
    };
}
