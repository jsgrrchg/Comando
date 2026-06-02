import { MessageChannel, Worker, type MessagePort } from "node:worker_threads";

import type {
    AiHistorySessionSummary,
    AiRuntimeId,
    AiSessionTranscriptPage,
    DatabaseStatus,
    GetAiSessionTranscriptPageInput,
    ListAiSessionHistoryInput,
    PersistenceSnapshot,
    PersistedWindowState,
    SettingsSnapshot,
    WorkspaceSnapshot,
    PersistedChatSessionState,
    AppAiChatSettings,
    AppAppearanceSettings,
    AppEditorSettings,
    AppTerminalSettings,
    ClaudeRuntimeSettings,
    CodexRuntimeSettings,
    GeminiRuntimeSettings,
    GrokRuntimeSettings,
    KiloRuntimeSettings,
    OpenCodeRuntimeSettings,
    PersistedShellState,
    ProjectAppDataSummary,
    ProjectSettingsSnapshot,
    ProjectSummary,
} from "@shared/ipc";

import {
    type AiPersistenceGateway,
    type PersistedRuntimeCatalogSnapshot,
    type PersistedRuntimeSelectionPreferences,
} from "../ai/persistence";
import {
    buildSecretStorageKey,
    deserializeStoredSecretValue,
    serializeStoredSecretValue,
    type SecretRecordPatch,
    type SecretStoreGateway,
} from "../ai/secret-store";
import { mainProcessPerformance } from "../observability/performance";
import {
    type CreateMainWindowSessionInput,
    type PersistenceGateway,
} from "../persistence/service";
import {
    type ProjectRecord,
    type ProjectStore,
    type ProjectStoreProjectRecord,
    type ProjectStoreStateSnapshot,
    type ProjectStoreWorktreeRecord,
} from "../projects/store";
import type { SettingsGateway } from "../settings/service";
import type { WorkspaceGateway } from "../workspace/service";
import {
    RpcWorkerSupervisor,
    WORKER_TIMEOUTS_MS,
} from "../workers/supervisor";
import type { DbWorkerBootstrapState } from "./worker";
import dbWorkerPath from "./worker?modulePath";

interface DbWorkerReadyMessage {
    readonly bootstrap: DbWorkerBootstrapState;
    readonly type: "ready";
}

interface DbWorkerFatalMessage {
    readonly error: {
        readonly message: string;
        readonly name: string;
        readonly stack?: string;
    };
    readonly type: "fatal";
}

export interface DbWorkerClient {
    readonly aiPersistence: AiPersistenceGateway;
    readonly persistence: PersistenceGateway;
    readonly projectStore: ProjectStore;
    readonly secretStore: SecretStoreGateway;
    readonly settings: SettingsGateway;
    readonly status: DatabaseStatus;
    readonly workspace: WorkspaceGateway;
    close(): Promise<void>;
}

export interface CreateDbWorkerClientOptions {
    readonly appWindowTitle?: string;
    readonly dataDir: string;
    readonly fileName?: string;
}

const runtimeIds = [
    "claude",
    "codex",
    "gemini",
    "kilo",
    "opencode",
] as const satisfies readonly AiRuntimeId[];

const DB_WORKER_METHOD_TIMEOUTS_MS: Readonly<Record<string, number>> = {
    // Project imports can synchronously touch the filesystem and invoke git
    // path discovery, so they need more headroom than pure SQLite calls.
    "projects.addProjectPaths": 30_000,
};

class DbRpcClient {
    readonly #supervisor: RpcWorkerSupervisor<DbWorkerBootstrapState>;

    constructor(supervisor: RpcWorkerSupervisor<DbWorkerBootstrapState>) {
        this.#supervisor = supervisor;
    }

    async ready(): Promise<DbWorkerBootstrapState> {
        return await this.#supervisor.ready();
    }

    async call<TResult>(method: string, params?: unknown): Promise<TResult> {
        return await this.#supervisor.call<TResult>(method, params);
    }

    async close(): Promise<void> {
        await this.#supervisor.close();
    }
}

class PersistenceClient implements PersistenceGateway {
    readonly #rpc: DbRpcClient;
    readonly #openWindowIds = new Set<string>();
    readonly #snapshotsByWindowId = new Map<string, PersistenceSnapshot>();
    readonly #windowOrder: string[] = [];

    constructor(
        rpc: DbRpcClient,
        persistenceSnapshots: readonly PersistenceSnapshot[],
    ) {
        this.#rpc = rpc;
        this.rehydrate(persistenceSnapshots);
    }

    rehydrate(persistenceSnapshots: readonly PersistenceSnapshot[]): void {
        this.#openWindowIds.clear();
        this.#snapshotsByWindowId.clear();
        this.#windowOrder.length = 0;

        for (const snapshot of persistenceSnapshots) {
            const windowId = snapshot.windowContext?.windowId;
            if (!windowId) {
                continue;
            }

            this.#snapshotsByWindowId.set(windowId, snapshot);
            this.#openWindowIds.add(windowId);
            this.#windowOrder.push(windowId);
        }
    }

    listRestorableMainWindowSnapshots(): readonly PersistenceSnapshot[] {
        return this.#windowOrder.flatMap((windowId) =>
            this.#openWindowIds.has(windowId)
                ? [this.loadSnapshot(windowId)]
                : [],
        );
    }

    async findClosedMainWindowSnapshotForProject(
        projectId: string,
        worktreeId?: string | null,
    ): Promise<PersistenceSnapshot | null> {
        const snapshot = await this.#rpc.call<PersistenceSnapshot | null>(
            "persistence.findClosedMainWindowSnapshotForProject",
            {
                projectId,
                worktreeId,
            },
        );

        if (snapshot) {
            this.#cacheSnapshot(snapshot);
        }

        return snapshot;
    }

    loadSnapshot(windowId: string): PersistenceSnapshot {
        return (
            this.#snapshotsByWindowId.get(windowId) ?? {
                activeProjectId: null,
                activeWorktreeId: null,
                shellState: null,
                windowContext: null,
                windowState: null,
            }
        );
    }

    loadWindowState(windowId: string): PersistedWindowState | null {
        return this.loadSnapshot(windowId).windowState;
    }

    async createMainWindowSession(
        input: CreateMainWindowSessionInput = {},
    ): Promise<PersistenceSnapshot> {
        const snapshot = await this.#rpc.call<PersistenceSnapshot>(
            "persistence.createMainWindowSession",
            input,
        );
        this.#trackSnapshot(snapshot);
        return snapshot;
    }

    saveActiveProjectId(
        windowId: string,
        projectId: string | null,
        worktreeId: string | null = null,
    ): void {
        this.#setSnapshot(windowId, (snapshot) => ({
            ...snapshot,
            activeProjectId: projectId,
            activeWorktreeId: worktreeId,
            windowContext: snapshot.windowContext
                ? {
                      ...snapshot.windowContext,
                      projectId,
                      worktreeId,
                  }
                : null,
        }));
        void this.#rpc
            .call("persistence.saveActiveProjectId", {
                projectId,
                windowId,
                worktreeId,
            })
            .catch(() => undefined);
    }

    saveShellState(
        windowId: string,
        shellState: PersistedShellState | null,
    ): void {
        this.#setSnapshot(windowId, (snapshot) => ({
            ...snapshot,
            shellState,
        }));
        void this.#rpc
            .call("persistence.saveShellState", {
                shellState,
                windowId,
            })
            .catch(() => undefined);
    }

    saveWindowState(state: PersistedWindowState): void {
        this.#setSnapshot(state.id, (snapshot) => ({
            ...snapshot,
            windowState: state,
        }));
        void this.#rpc
            .call("persistence.saveWindowState", state)
            .catch(() => undefined);
    }

    markWindowClosed(windowId: string): void {
        this.#openWindowIds.delete(windowId);
        void this.#rpc
            .call("persistence.markWindowClosed", windowId)
            .catch(() => undefined);
    }

    markWindowOpen(windowId: string): void {
        this.#openWindowIds.add(windowId);
        if (!this.#windowOrder.includes(windowId)) {
            this.#windowOrder.push(windowId);
        }

        void this.#rpc
            .call("persistence.markWindowOpen", windowId)
            .catch(() => undefined);
    }

    #trackSnapshot(snapshot: PersistenceSnapshot): void {
        const windowId = this.#cacheSnapshot(snapshot);
        if (!windowId) {
            return;
        }

        this.#openWindowIds.add(windowId);
    }

    #cacheSnapshot(snapshot: PersistenceSnapshot): string | null {
        const windowId = snapshot.windowContext?.windowId;
        if (!windowId) {
            return null;
        }

        this.#snapshotsByWindowId.set(windowId, snapshot);
        if (!this.#windowOrder.includes(windowId)) {
            this.#windowOrder.push(windowId);
        }

        return windowId;
    }

    #setSnapshot(
        windowId: string,
        mutate: (snapshot: PersistenceSnapshot) => PersistenceSnapshot,
    ): void {
        this.#snapshotsByWindowId.set(
            windowId,
            mutate(this.loadSnapshot(windowId)),
        );
    }
}

class SettingsClient implements SettingsGateway {
    readonly #rpc: DbRpcClient;
    #snapshot: SettingsSnapshot;

    constructor(rpc: DbRpcClient, snapshot: SettingsSnapshot) {
        this.#rpc = rpc;
        this.#snapshot = structuredClone(snapshot);
    }

    rehydrate(snapshot: SettingsSnapshot): void {
        this.#snapshot = structuredClone(snapshot);
    }

    loadSnapshot(): SettingsSnapshot {
        return structuredClone(this.#snapshot);
    }

    saveSnapshot(snapshot: SettingsSnapshot): void {
        this.#snapshot = snapshot;
        this.#dispatch("settings.saveSnapshot", snapshot);
    }

    loadAppAppearanceSettings(): AppAppearanceSettings {
        return requireSetting(this.#snapshot.appearance, "appearance");
    }

    saveAppAppearanceSettings(settings: AppAppearanceSettings): void {
        this.#snapshot = {
            ...this.#snapshot,
            appearance: settings,
        };
        this.#dispatch("settings.saveAppAppearanceSettings", settings);
    }

    loadAppEditorSettings(): AppEditorSettings {
        return requireSetting(this.#snapshot.editor, "editor");
    }

    saveAppEditorSettings(settings: AppEditorSettings): void {
        this.#snapshot = {
            ...this.#snapshot,
            editor: settings,
        };
        this.#dispatch("settings.saveAppEditorSettings", settings);
    }

    loadAiChatSettings(): AppAiChatSettings {
        return requireSetting(this.#snapshot.aiChat, "aiChat");
    }

    saveAiChatSettings(settings: AppAiChatSettings): void {
        this.#snapshot = {
            ...this.#snapshot,
            aiChat: settings,
        };
        this.#dispatch("settings.saveAiChatSettings", settings);
    }

    loadAppTerminalSettings(): AppTerminalSettings {
        return requireSetting(this.#snapshot.terminal, "terminal");
    }

    saveAppTerminalSettings(settings: AppTerminalSettings): void {
        this.#snapshot = {
            ...this.#snapshot,
            terminal: settings,
        };
        this.#dispatch("settings.saveAppTerminalSettings", settings);
    }

    loadProjectSettings(projectId: string): ProjectSettingsSnapshot | null {
        void projectId;
        return null;
    }

    saveProjectSettings(snapshot: ProjectSettingsSnapshot): void {
        this.#dispatch("settings.saveProjectSettings", snapshot);
    }

    loadCodexRuntimeSettings(): CodexRuntimeSettings {
        return requireAiSettings(this.#snapshot.ai).codex;
    }

    saveCodexRuntimeSettings(settings: CodexRuntimeSettings): void {
        this.#setCodexRuntimeSettings(settings);
        this.#dispatch("settings.saveCodexRuntimeSettings", settings);
    }

    loadClaudeRuntimeSettings(): ClaudeRuntimeSettings {
        return requireAiSettings(this.#snapshot.ai).claude;
    }

    saveClaudeRuntimeSettings(settings: ClaudeRuntimeSettings): void {
        this.#setClaudeRuntimeSettings(settings);
        this.#dispatch("settings.saveClaudeRuntimeSettings", settings);
    }

    loadGeminiRuntimeSettings(): GeminiRuntimeSettings {
        return requireAiSettings(this.#snapshot.ai).gemini;
    }

    saveGeminiRuntimeSettings(settings: GeminiRuntimeSettings): void {
        this.#setGeminiRuntimeSettings(settings);
        this.#dispatch("settings.saveGeminiRuntimeSettings", settings);
    }

    loadGrokRuntimeSettings(): GrokRuntimeSettings {
        return requireAiSettings(this.#snapshot.ai).grok;
    }

    saveGrokRuntimeSettings(settings: GrokRuntimeSettings): void {
        this.#setGrokRuntimeSettings(settings);
        this.#dispatch("settings.saveGrokRuntimeSettings", settings);
    }

    loadKiloRuntimeSettings(): KiloRuntimeSettings {
        return requireAiSettings(this.#snapshot.ai).kilo;
    }

    saveKiloRuntimeSettings(settings: KiloRuntimeSettings): void {
        this.#setKiloRuntimeSettings(settings);
        this.#dispatch("settings.saveKiloRuntimeSettings", settings);
    }

    loadOpenCodeRuntimeSettings(): OpenCodeRuntimeSettings {
        return requireAiSettings(this.#snapshot.ai).opencode;
    }

    saveOpenCodeRuntimeSettings(settings: OpenCodeRuntimeSettings): void {
        this.#setOpenCodeRuntimeSettings(settings);
        this.#dispatch("settings.saveOpenCodeRuntimeSettings", settings);
    }

    async saveCodexAuth(
        settings: CodexRuntimeSettings,
        secrets: readonly SecretRecordPatch[],
    ): Promise<void> {
        const records = serializeSecretRecordPatches(secrets);
        const previousSettings = this.loadCodexRuntimeSettings();
        this.#setCodexRuntimeSettings(settings);
        try {
            await this.#rpc.call("ai.saveCodexAuth", {
                secrets: records,
                settings,
            });
        } catch (error) {
            this.#setCodexRuntimeSettings(previousSettings);
            throw error;
        }
    }

    async saveClaudeAuth(
        settings: ClaudeRuntimeSettings,
        secrets: readonly SecretRecordPatch[],
    ): Promise<void> {
        const records = serializeSecretRecordPatches(secrets);
        const previousSettings = this.loadClaudeRuntimeSettings();
        this.#setClaudeRuntimeSettings(settings);
        try {
            await this.#rpc.call("ai.saveClaudeAuth", {
                secrets: records,
                settings,
            });
        } catch (error) {
            this.#setClaudeRuntimeSettings(previousSettings);
            throw error;
        }
    }

    async saveGeminiAuth(
        settings: GeminiRuntimeSettings,
        secrets: readonly SecretRecordPatch[],
    ): Promise<void> {
        const records = serializeSecretRecordPatches(secrets);
        const previousSettings = this.loadGeminiRuntimeSettings();
        this.#setGeminiRuntimeSettings(settings);
        try {
            await this.#rpc.call("ai.saveGeminiAuth", {
                secrets: records,
                settings,
            });
        } catch (error) {
            this.#setGeminiRuntimeSettings(previousSettings);
            throw error;
        }
    }

    async saveKiloAuth(
        settings: KiloRuntimeSettings,
        secrets: readonly SecretRecordPatch[],
    ): Promise<void> {
        const records = serializeSecretRecordPatches(secrets);
        const previousSettings = this.loadKiloRuntimeSettings();
        this.#setKiloRuntimeSettings(settings);
        try {
            await this.#rpc.call("ai.saveKiloAuth", {
                secrets: records,
                settings,
            });
        } catch (error) {
            this.#setKiloRuntimeSettings(previousSettings);
            throw error;
        }
    }

    async saveOpenCodeAuth(
        settings: OpenCodeRuntimeSettings,
        secrets: readonly SecretRecordPatch[],
    ): Promise<void> {
        const records = serializeSecretRecordPatches(secrets);
        const previousSettings = this.loadOpenCodeRuntimeSettings();
        this.#setOpenCodeRuntimeSettings(settings);
        try {
            await this.#rpc.call("ai.saveOpenCodeAuth", {
                secrets: records,
                settings,
            });
        } catch (error) {
            this.#setOpenCodeRuntimeSettings(previousSettings);
            throw error;
        }
    }

    #setCodexRuntimeSettings(settings: CodexRuntimeSettings): void {
        this.#snapshot = {
            ...this.#snapshot,
            ai: {
                ...requireAiSettings(this.#snapshot.ai),
                codex: settings,
            },
        };
    }

    #setClaudeRuntimeSettings(settings: ClaudeRuntimeSettings): void {
        this.#snapshot = {
            ...this.#snapshot,
            ai: {
                ...requireAiSettings(this.#snapshot.ai),
                claude: settings,
            },
        };
    }

    #setGeminiRuntimeSettings(settings: GeminiRuntimeSettings): void {
        this.#snapshot = {
            ...this.#snapshot,
            ai: {
                ...requireAiSettings(this.#snapshot.ai),
                gemini: settings,
            },
        };
    }

    #setGrokRuntimeSettings(settings: GrokRuntimeSettings): void {
        this.#snapshot = {
            ...this.#snapshot,
            ai: {
                ...requireAiSettings(this.#snapshot.ai),
                grok: settings,
            },
        };
    }

    #setKiloRuntimeSettings(settings: KiloRuntimeSettings): void {
        this.#snapshot = {
            ...this.#snapshot,
            ai: {
                ...requireAiSettings(this.#snapshot.ai),
                kilo: settings,
            },
        };
    }

    #setOpenCodeRuntimeSettings(settings: OpenCodeRuntimeSettings): void {
        this.#snapshot = {
            ...this.#snapshot,
            ai: {
                ...requireAiSettings(this.#snapshot.ai),
                opencode: settings,
            },
        };
    }

    #dispatch(method: string, params: unknown): void {
        void this.#rpc.call(method, params).catch(() => undefined);
    }
}

class SecretStoreClient implements SecretStoreGateway {
    readonly #rpc: DbRpcClient;
    readonly #valuesByKey = new Map<string, string | null>();

    constructor(
        rpc: DbRpcClient,
        secretRecords: Record<string, string | null>,
    ) {
        this.#rpc = rpc;
        this.rehydrate(secretRecords);
    }

    rehydrate(secretRecords: Record<string, string | null>): void {
        this.#valuesByKey.clear();
        for (const [key, record] of Object.entries(secretRecords)) {
            this.#valuesByKey.set(key, deserializeStoredSecretValue(record));
        }
    }

    loadSecret(namespace: string, secretId: string): string | null {
        return (
            this.#valuesByKey.get(buildSecretStorageKey(namespace, secretId)) ??
            null
        );
    }

    cacheSecretPatches(secrets: readonly SecretRecordPatch[]): void {
        for (const secret of secrets) {
            const normalizedValue = secret.value?.trim() ?? "";
            this.#valuesByKey.set(
                secret.key,
                normalizedValue.length > 0 ? normalizedValue : null,
            );
        }
    }

    async saveSecret(
        namespace: string,
        secretId: string,
        value: string | null,
    ): Promise<void> {
        const normalizedValue = value?.trim() ?? "";
        const key = buildSecretStorageKey(namespace, secretId);
        const nextValue = normalizedValue.length > 0 ? normalizedValue : null;
        const storedValue =
            nextValue === null ? null : serializeStoredSecretValue(nextValue);
        const previousValue = this.#valuesByKey.get(key) ?? null;

        this.#valuesByKey.set(key, nextValue);
        try {
            await this.#rpc.call("secrets.saveRecord", {
                key,
                value: storedValue,
            });
        } catch (error) {
            this.#valuesByKey.set(key, previousValue);
            throw error;
        }
    }
}

function serializeSecretRecordPatches(
    secrets: readonly SecretRecordPatch[],
): readonly SecretRecordPatch[] {
    return secrets.map((secret) => ({
        key: secret.key,
        value:
            secret.value === null
                ? null
                : serializeStoredSecretValue(secret.value),
    }));
}

class WorkspaceClient implements WorkspaceGateway {
    readonly #rpc: DbRpcClient;

    constructor(rpc: DbRpcClient) {
        this.#rpc = rpc;
    }

    async loadSnapshot(workspaceId: string): Promise<WorkspaceSnapshot> {
        return await mainProcessPerformance.measureAsync(
            "db.workspace.loadSnapshot",
            async () =>
                await this.#rpc.call<WorkspaceSnapshot>(
                    "workspace.loadSnapshot",
                    workspaceId,
                ),
        );
    }

    async saveSnapshot(
        workspaceId: string,
        snapshot: WorkspaceSnapshot,
    ): Promise<void> {
        await mainProcessPerformance.measureAsync(
            "db.workspace.saveSnapshot",
            async () => {
                await this.#rpc.call("workspace.saveSnapshot", {
                    snapshot,
                    workspaceId,
                });
            },
        );
    }

    async loadChatSessionState(
        sessionId: string,
    ): Promise<PersistedChatSessionState | null> {
        return await this.#rpc.call<PersistedChatSessionState | null>(
            "workspace.loadChatSessionState",
            sessionId,
        );
    }
}

class AiPersistenceClient implements AiPersistenceGateway {
    readonly #rpc: DbRpcClient;
    readonly #runtimeCatalogs = new Map<
        AiRuntimeId,
        PersistedRuntimeCatalogSnapshot | null
    >();
    readonly #runtimeSelectionPreferences = new Map<
        AiRuntimeId,
        PersistedRuntimeSelectionPreferences
    >();
    readonly #sessionSnapshots = new Map<
        string,
        Awaited<ReturnType<AiPersistenceGateway["loadSessionSnapshot"]>>
    >();

    constructor(rpc: DbRpcClient, bootstrap: DbWorkerBootstrapState["ai"]) {
        this.#rpc = rpc;
        this.rehydrate(bootstrap);
    }

    rehydrate(bootstrap: DbWorkerBootstrapState["ai"]): void {
        this.#runtimeCatalogs.clear();
        this.#runtimeSelectionPreferences.clear();
        this.#sessionSnapshots.clear();

        for (const runtimeId of runtimeIds) {
            this.#runtimeCatalogs.set(
                runtimeId,
                bootstrap.runtimeCatalogs[runtimeId] ?? null,
            );
            this.#runtimeSelectionPreferences.set(
                runtimeId,
                bootstrap.runtimeSelectionPreferences[runtimeId],
            );
        }
    }

    async loadSessionSnapshot(sessionId: string) {
        if (this.#sessionSnapshots.has(sessionId)) {
            return this.#sessionSnapshots.get(sessionId) ?? null;
        }

        const snapshot = await mainProcessPerformance.measureAsync(
            "db.ai.loadSessionSnapshot",
            async () =>
                await this.#rpc.call<
                    Awaited<
                        ReturnType<AiPersistenceGateway["loadSessionSnapshot"]>
                    >
                >("ai.loadSessionSnapshot", sessionId),
        );
        this.#sessionSnapshots.set(sessionId, snapshot);
        return snapshot;
    }

    async listSessionHistory(
        input: ListAiSessionHistoryInput,
    ): Promise<readonly AiHistorySessionSummary[]> {
        return await mainProcessPerformance.measureAsync(
            "db.ai.listSessionHistory",
            async () =>
                await this.#rpc.call<readonly AiHistorySessionSummary[]>(
                    "ai.listSessionHistory",
                    input,
                ),
        );
    }

    async loadSessionTranscriptPage(
        input: GetAiSessionTranscriptPageInput,
    ): Promise<AiSessionTranscriptPage | null> {
        return await mainProcessPerformance.measureAsync(
            "db.ai.loadSessionTranscriptPage",
            async () =>
                await this.#rpc.call<AiSessionTranscriptPage | null>(
                    "ai.loadSessionTranscriptPage",
                    input,
                ),
        );
    }

    async deleteSession(sessionId: string): Promise<void> {
        this.#sessionSnapshots.delete(sessionId);
        await mainProcessPerformance.measureAsync(
            "db.ai.deleteSession",
            async () => {
                await this.#rpc.call("ai.deleteSession", sessionId);
            },
        );
    }

    async setSessionPinned(sessionId: string, pinned: boolean): Promise<void> {
        await mainProcessPerformance.measureAsync(
            "db.ai.setSessionPinned",
            async () => {
                await this.#rpc.call("ai.setSessionPinned", {
                    pinned,
                    sessionId,
                });
            },
        );
    }

    loadLatestRuntimeCatalog(
        runtimeId: AiRuntimeId,
    ): PersistedRuntimeCatalogSnapshot | null {
        return this.#runtimeCatalogs.get(runtimeId) ?? null;
    }

    loadRuntimeSelectionPreferences(
        runtimeId: AiRuntimeId,
    ): PersistedRuntimeSelectionPreferences {
        return (
            this.#runtimeSelectionPreferences.get(runtimeId) ?? {
                configOptions: {},
                modeId: null,
                modelId: null,
            }
        );
    }

    saveRuntimeSelectionPreferences(
        runtimeId: AiRuntimeId,
        patch: Partial<PersistedRuntimeSelectionPreferences>,
    ): void {
        const current = this.loadRuntimeSelectionPreferences(runtimeId);
        const next = {
            configOptions: {
                ...current.configOptions,
                ...(patch.configOptions ?? {}),
            },
            modeId: patch.modeId === undefined ? current.modeId : patch.modeId,
            modelId:
                patch.modelId === undefined ? current.modelId : patch.modelId,
        } satisfies PersistedRuntimeSelectionPreferences;
        this.#runtimeSelectionPreferences.set(runtimeId, next);
        void this.#rpc
            .call("ai.saveRuntimeSelectionPreferences", {
                patch,
                runtimeId,
            })
            .catch(() => undefined);
    }

    saveRuntimeSelectionPreferenceOption(
        runtimeId: AiRuntimeId,
        optionId: string,
        value: boolean | string,
    ): void {
        this.saveRuntimeSelectionPreferences(runtimeId, {
            configOptions: {
                [optionId]: value,
            },
        });
    }

    saveRuntimeModePreference(runtimeId: AiRuntimeId, modeId: string): void {
        this.saveRuntimeSelectionPreferences(runtimeId, { modeId });
    }

    saveRuntimeModelPreference(runtimeId: AiRuntimeId, modelId: string): void {
        this.saveRuntimeSelectionPreferences(runtimeId, { modelId });
    }

    saveSessionSnapshot(
        snapshot: Parameters<AiPersistenceGateway["saveSessionSnapshot"]>[0],
        draft?: string,
    ): void {
        this.#sessionSnapshots.set(snapshot.sessionId, snapshot);
        const runtimeCatalog = toRuntimeCatalog(snapshot);
        if (runtimeCatalog) {
            this.#runtimeCatalogs.set(snapshot.runtimeId, runtimeCatalog);
        }

        void mainProcessPerformance
            .measureAsync("db.ai.saveSessionSnapshot", async () => {
                await this.#rpc.call("ai.saveSessionSnapshot", {
                    draft,
                    snapshot,
                });
            })
            .catch(() => undefined);
    }
}

class ProjectStoreClient implements ProjectStore {
    readonly #rpc: DbRpcClient;
    readonly #projectsById = new Map<string, ProjectStoreProjectRecord>();
    readonly #worktreesById = new Map<string, ProjectStoreWorktreeRecord>();
    readonly #worktreeIdsByProjectId = new Map<string, readonly string[]>();
    #projectOrder: readonly string[] = [];

    constructor(rpc: DbRpcClient, snapshot: ProjectStoreStateSnapshot) {
        this.#rpc = rpc;
        this.rehydrate(snapshot);
    }

    rehydrate(snapshot: ProjectStoreStateSnapshot): void {
        this.#hydrate(snapshot);
    }

    loadState(): ProjectStoreStateSnapshot {
        return {
            projects: this.#projectOrder.flatMap((projectId) => {
                const project = this.#projectsById.get(projectId);
                return project ? [project] : [];
            }),
            worktrees: [...this.#worktreesById.values()],
        };
    }

    listProjects(): readonly ProjectStoreProjectRecord[] {
        return this.#projectOrder.flatMap((projectId) => {
            const project = this.#projectsById.get(projectId);
            return project ? [project] : [];
        });
    }

    async addProjectPaths(projectPaths: readonly string[]) {
        const result = await this.#rpc.call<{
            readonly state: ProjectStoreStateSnapshot;
            readonly touchedProjectIds: readonly string[];
            readonly touchedRootPaths: readonly string[];
        }>("projects.addProjectPaths", [...projectPaths]);
        this.#hydrate(result.state);
        return {
            projects: this.listProjects(),
            touchedProjectIds: result.touchedProjectIds,
            touchedRootPaths: result.touchedRootPaths,
        };
    }

    async clearProjectAppData(
        projectId: string,
    ): Promise<ProjectAppDataSummary> {
        const result = await this.#rpc.call<{
            readonly state: ProjectStoreStateSnapshot;
            readonly summary: ProjectAppDataSummary;
        }>("projects.clearProjectAppData", projectId);
        this.#hydrate(result.state);
        return result.summary;
    }

    getProject(projectId: string): ProjectRecord | null {
        const project = this.#projectsById.get(projectId);
        if (!project) {
            return null;
        }

        return {
            canonicalRootPath: project.canonicalRootPath,
            id: project.id,
            rootPath: project.rootPath,
        };
    }

    async getProjectAppDataSummary(
        projectId: string,
    ): Promise<ProjectAppDataSummary> {
        return await this.#rpc.call<ProjectAppDataSummary>(
            "projects.getProjectAppDataSummary",
            projectId,
        );
    }

    getProjectWorktree(worktreeId: string): ProjectStoreWorktreeRecord | null {
        return this.#worktreesById.get(worktreeId) ?? null;
    }

    listProjectWorktrees(
        projectId: string,
    ): readonly ProjectStoreWorktreeRecord[] {
        return (this.#worktreeIdsByProjectId.get(projectId) ?? []).flatMap(
            (worktreeId) => {
                const worktree = this.#worktreesById.get(worktreeId);
                return worktree ? [worktree] : [];
            },
        );
    }

    removeProject(projectId: string): void {
        this.#projectsById.delete(projectId);
        this.#projectOrder = this.#projectOrder.filter(
            (candidate) => candidate !== projectId,
        );
        for (const worktreeId of this.#worktreeIdsByProjectId.get(projectId) ??
            []) {
            this.#worktreesById.delete(worktreeId);
        }
        this.#worktreeIdsByProjectId.delete(projectId);
        void this.#rpc
            .call("projects.removeProject", projectId)
            .catch(() => undefined);
    }

    async relocateProject(
        projectId: string,
        projectPath: string,
    ): Promise<ProjectSummary> {
        const result = await this.#rpc.call<{
            readonly project: ProjectSummary;
            readonly state: ProjectStoreStateSnapshot;
        }>("projects.relocateProject", {
            projectId,
            projectPath,
        });
        this.#hydrate(result.state);
        return result.project;
    }

    touchProject(projectId: string): void {
        const project = this.#projectsById.get(projectId);
        if (project) {
            const now = new Date().toISOString();
            this.#projectsById.set(projectId, {
                ...project,
                lastOpenedAt: now,
                updatedAt: now,
            });
            this.#projectOrder = this.#sortProjectOrder();
        }

        void this.#rpc
            .call("projects.touchProject", projectId)
            .catch(() => undefined);
    }

    async syncProjectWorktrees(
        projectId: string,
        worktrees: readonly {
            readonly branchName: string | null;
            readonly headSha: string | null;
            readonly rootPath: string;
        }[],
    ): Promise<readonly ProjectStoreWorktreeRecord[]> {
        const nextWorktrees = await this.#rpc.call<
            readonly ProjectStoreWorktreeRecord[]
        >("projects.syncProjectWorktrees", {
            projectId,
            worktrees,
        });
        this.#setProjectWorktrees(projectId, nextWorktrees);
        return nextWorktrees;
    }

    #hydrate(snapshot: ProjectStoreStateSnapshot): void {
        this.#projectsById.clear();
        this.#worktreesById.clear();
        this.#worktreeIdsByProjectId.clear();

        for (const project of snapshot.projects) {
            this.#projectsById.set(project.id, project);
        }

        this.#projectOrder = snapshot.projects.map((project) => project.id);

        for (const worktree of snapshot.worktrees) {
            this.#worktreesById.set(worktree.id, worktree);
            const worktreeIds =
                this.#worktreeIdsByProjectId.get(worktree.projectId) ?? [];
            this.#worktreeIdsByProjectId.set(worktree.projectId, [
                ...worktreeIds,
                worktree.id,
            ]);
        }
    }

    #setProjectWorktrees(
        projectId: string,
        worktrees: readonly ProjectStoreWorktreeRecord[],
    ): void {
        for (const existingWorktreeId of this.#worktreeIdsByProjectId.get(
            projectId,
        ) ?? []) {
            this.#worktreesById.delete(existingWorktreeId);
        }

        this.#worktreeIdsByProjectId.set(
            projectId,
            worktrees.map((worktree) => {
                this.#worktreesById.set(worktree.id, worktree);
                return worktree.id;
            }),
        );
    }

    #sortProjectOrder(): readonly string[] {
        return [...this.#projectsById.values()]
            .sort(
                (left, right) =>
                    Number(left.lastOpenedAt === null) -
                        Number(right.lastOpenedAt === null) ||
                    (right.lastOpenedAt ?? "").localeCompare(
                        left.lastOpenedAt ?? "",
                    ) ||
                    left.name.localeCompare(right.name, undefined, {
                        sensitivity: "base",
                    }),
            )
            .map((project) => project.id);
    }
}

export async function createDbWorkerClient(
    options: CreateDbWorkerClientOptions,
): Promise<DbWorkerClient> {
    let aiPersistenceClient: AiPersistenceClient | null = null;
    let persistenceClient: PersistenceClient | null = null;
    let projectStoreClient: ProjectStoreClient | null = null;
    let secretStoreClient: SecretStoreClient | null = null;
    let settingsClient: SettingsClient | null = null;

    const supervisor = new RpcWorkerSupervisor<DbWorkerBootstrapState>({
        connect: async () => {
            const worker = new Worker(dbWorkerPath, {
                name: "comando-db-worker",
            });
            const channel = new MessageChannel();
            worker.postMessage(
                {
                    appWindowTitle: options.appWindowTitle,
                    dataDir: options.dataDir,
                    fileName: options.fileName,
                    port: channel.port2,
                },
                [channel.port2],
            );
            const readyValue = await waitForWorkerReady(worker, channel.port1);

            return {
                port: channel.port1,
                readyValue,
                worker,
            };
        },
        domain: "db",
        methodTimeoutsMs: DB_WORKER_METHOD_TIMEOUTS_MS,
        onConnected: (bootstrap, context) => {
            if (context.reason !== "restart") {
                return;
            }

            aiPersistenceClient?.rehydrate(bootstrap.ai);
            persistenceClient?.rehydrate(bootstrap.persistenceSnapshots);
            projectStoreClient?.rehydrate(bootstrap.projectState);
            secretStoreClient?.rehydrate(bootstrap.secretRecords);
            settingsClient?.rehydrate(bootstrap.settings);
        },
        timeoutMs: WORKER_TIMEOUTS_MS.db,
    });
    const rpc = new DbRpcClient(supervisor);

    const bootstrap = await rpc.ready();

    aiPersistenceClient = new AiPersistenceClient(rpc, bootstrap.ai);
    persistenceClient = new PersistenceClient(
        rpc,
        bootstrap.persistenceSnapshots,
    );
    projectStoreClient = new ProjectStoreClient(rpc, bootstrap.projectState);
    secretStoreClient = new SecretStoreClient(rpc, bootstrap.secretRecords);
    settingsClient = new SettingsClient(rpc, bootstrap.settings);

    return {
        aiPersistence: aiPersistenceClient,
        persistence: persistenceClient,
        projectStore: projectStoreClient,
        secretStore: secretStoreClient,
        settings: settingsClient,
        status: bootstrap.database,
        workspace: new WorkspaceClient(rpc),
        close: async () => {
            await rpc.close();
        },
    };
}

function waitForWorkerReady(
    worker: Worker,
    port: MessagePort,
): Promise<DbWorkerBootstrapState> {
    return new Promise<DbWorkerBootstrapState>((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            port.close();
            void worker.terminate();
            reject(
                new Error(
                    "Timed out waiting for the db worker to become ready.",
                ),
            );
        }, WORKER_TIMEOUTS_MS.db);
        timeout.unref();
        const cleanup = () => {
            clearTimeout(timeout);
            port.off("message", handleMessage);
            worker.off("error", handleError);
        };
        const handleError = (error: Error) => {
            cleanup();
            port.close();
            void worker.terminate();
            reject(error);
        };
        const handleMessage = (message: unknown) => {
            const payload = message as
                | DbWorkerReadyMessage
                | DbWorkerFatalMessage;
            if (payload.type === "fatal") {
                cleanup();
                port.close();
                void worker.terminate();
                reject(deserializeWorkerError(payload.error));
                return;
            }

            cleanup();
            resolve(payload.bootstrap);
        };

        port.on("message", handleMessage);
        worker.on("error", handleError);
        port.start();
    });
}

function deserializeWorkerError(input: {
    readonly message: string;
    readonly name: string;
    readonly stack?: string;
}): Error {
    const error = new Error(input.message);
    error.name = input.name;
    error.stack = input.stack;
    return error;
}

function toRuntimeCatalog(
    snapshot: PersistedRuntimeCatalogSnapshot,
): PersistedRuntimeCatalogSnapshot | null {
    if (
        snapshot.availableCommands.length === 0 &&
        snapshot.configOptions.length === 0 &&
        snapshot.modes.length === 0 &&
        snapshot.models.length === 0
    ) {
        return null;
    }

    return {
        availableCommands: snapshot.availableCommands,
        configOptions: snapshot.configOptions,
        modeId: snapshot.modeId,
        modes: snapshot.modes,
        modelId: snapshot.modelId,
        models: snapshot.models,
    };
}

function requireSetting<T>(value: T | null | undefined, name: string): T {
    if (value !== null && value !== undefined) {
        return value;
    }

    throw new Error(`The cached \`${name}\` settings are unavailable.`);
}

function requireAiSettings(value: SettingsSnapshot["ai"]) {
    return requireSetting(value, "ai");
}
