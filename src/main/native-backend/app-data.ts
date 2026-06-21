import { randomUUID } from "node:crypto";

import { APP_ZOOM_FACTOR_DEFAULT } from "@shared/app-zoom";
import { AGENTS_SIDEBAR_SCALE_DEFAULT } from "@shared/agents-sidebar-scale";
import { FILE_TREE_SCALE_DEFAULT } from "@shared/file-tree-scale";
import { DEFAULT_APP_TERMINAL_SETTINGS } from "@shared/terminal-settings";
import {
    DEFAULT_AI_CHAT_FONT_FAMILY,
    DEFAULT_AI_CHAT_FONT_SIZE,
    DEFAULT_AI_COMPOSER_FONT_FAMILY,
    DEFAULT_AI_COMPOSER_FONT_SIZE,
    DEFAULT_EDITOR_FONT_FAMILY,
    DEFAULT_EDITOR_FONT_SIZE,
} from "@shared/typography";
import type {
    AiHistorySessionSummary,
    AiRuntimeId,
    AiSessionSnapshot,
    AiSessionTranscriptPage,
    AppAiChatSettings,
    AppAppearanceSettings,
    AppEditorSettings,
    ClaudeRuntimeSettings,
    CodexRuntimeSettings,
    DatabaseStatus,
    GetAiSessionTranscriptPageInput,
    GrokRuntimeSettings,
    KiloRuntimeSettings,
    ListAiSessionHistoryInput,
    OpenCodeRuntimeSettings,
    PersistedChatSessionState,
    PersistedShellState,
    PersistedWindowState,
    PersistenceSnapshot,
    ProjectSettingsSnapshot,
    SettingsSnapshot,
    WorkspaceNode,
    WorkspaceSnapshot,
} from "@shared/ipc";

import type {
    AiPersistenceGateway,
    PersistedAiSessionRuntimeMapping,
    PersistedRuntimeCatalogSnapshot,
    PersistedRuntimeSelectionPreferences,
} from "@main/ai/persistence";
import type {
    SecretRecordPatch,
    SecretStoreGateway,
    SecretStorageStatus,
} from "@main/ai/secret-store";
import type {
    CreateMainWindowSessionInput,
    PersistenceGateway,
} from "@main/persistence/service";
import type { SettingsGateway } from "@main/settings/service";
import type { WorkspaceGateway } from "@main/workspace/service";

import type { NativeBackendRequester } from "./persistence";

const SETTINGS_KEY = "settings.snapshot";
const PROJECT_SETTINGS_KEY = "settings.projects";
const PERSISTENCE_KEY = "persistence.windows";
const AI_PREFERENCES_KEY = "ai.runtimePreferences";
const WORKSPACE_KEY_PREFIX = "workspace.";

const DEFAULT_MAIN_WINDOW_HEIGHT = 960;
const DEFAULT_MAIN_WINDOW_WIDTH = 1480;

const KNOWN_SECRET_KEYS = [
    "secret.ai.claude.anthropic_api_key",
    "secret.ai.claude.anthropic_auth_token",
    "secret.ai.claude.anthropic_custom_headers",
    "secret.ai.codex.codex_api_key",
    "secret.ai.codex.openai_api_key",
    "secret.ai.grok.xai_api_key",
    "secret.ai.kilo.kilo_api_key",
    "secret.github.token",
] as const;

interface NativeAppDataClientOptions {
    readonly client: NativeBackendRequester;
    readonly databaseFile: string;
}

export interface NativeAppDataClient {
    readonly aiPersistence: AiPersistenceGateway;
    readonly persistence: PersistenceGateway;
    readonly secretStore: SecretStoreGateway;
    readonly settings: SettingsGateway;
    readonly status: DatabaseStatus;
    readonly workspace: WorkspaceGateway;
    close(): Promise<void>;
}

interface AppDataEnvelope<T> {
    readonly value: T | null;
}

interface PersistedWindowRecord {
    readonly isOpen: boolean;
    readonly lastOpenedAt: string;
    readonly snapshot: PersistenceSnapshot;
}

class NativeJsonStore {
    readonly #client: NativeBackendRequester;

    constructor(client: NativeBackendRequester) {
        this.#client = client;
    }

    async load<T>(key: string, fallback: T): Promise<T> {
        const output = await this.#client.request<AppDataEnvelope<unknown>>(
            "app_data_get_json",
            { key },
        );
        if (!isRecord(output) || !("value" in output) || output.value === null) {
            return fallback;
        }
        return output.value as T;
    }

    save(key: string, value: unknown): void {
        void this.#client
            .request("app_data_set_json", { key, value })
            .catch(() => undefined);
    }

    async saveNow(key: string, value: unknown): Promise<void> {
        await this.#client.request("app_data_set_json", { key, value });
    }
}

class NativePersistenceClient implements PersistenceGateway {
    readonly #store: NativeJsonStore;
    readonly #recordsByWindowId = new Map<string, PersistedWindowRecord>();
    readonly #windowOrder: string[] = [];

    constructor(
        store: NativeJsonStore,
        records: readonly PersistedWindowRecord[],
    ) {
        this.#store = store;
        this.#rehydrate(records);
    }

    listRestorableMainWindowSnapshots(): readonly PersistenceSnapshot[] {
        return this.#windowOrder.flatMap((windowId) => {
            const record = this.#recordsByWindowId.get(windowId);
            return record?.isOpen ? [record.snapshot] : [];
        });
    }

    findClosedMainWindowSnapshotForProject(
        projectId: string,
        worktreeId?: string | null,
    ): PersistenceSnapshot | null {
        const match = [...this.#recordsByWindowId.values()]
            .filter((record) => !record.isOpen)
            .find((record) => {
                const snapshot = record.snapshot;
                return (
                    snapshot.activeProjectId === projectId &&
                    (worktreeId === undefined ||
                        (snapshot.activeWorktreeId ?? null) === worktreeId)
                );
            });
        return match?.snapshot ?? null;
    }

    loadSnapshot(windowId: string): PersistenceSnapshot {
        return (
            this.#recordsByWindowId.get(windowId)?.snapshot ?? emptySnapshot()
        );
    }

    loadWindowState(windowId: string): PersistedWindowState | null {
        return this.loadSnapshot(windowId).windowState;
    }

    async createMainWindowSession(
        input: CreateMainWindowSessionInput = {},
    ): Promise<PersistenceSnapshot> {
        const now = new Date().toISOString();
        const windowId = randomUUID();
        const workspaceId = randomUUID();
        const workspaceSessionId = randomUUID();
        const snapshot: PersistenceSnapshot = {
            activeProjectId: input.projectId ?? null,
            activeWorktreeId: input.worktreeId ?? null,
            shellState:
                input.shellState === undefined ? null : input.shellState,
            windowContext: {
                projectId: input.projectId ?? null,
                windowId,
                windowKind: "main",
                workspaceId,
                workspaceSessionId,
                worktreeId: input.worktreeId ?? null,
            },
            windowState: {
                height: DEFAULT_MAIN_WINDOW_HEIGHT,
                id: windowId,
                isFullScreen: false,
                isMaximized: false,
                width: DEFAULT_MAIN_WINDOW_WIDTH,
                x: null,
                y: null,
            },
        };
        this.#recordsByWindowId.set(windowId, {
            isOpen: true,
            lastOpenedAt: now,
            snapshot,
        });
        this.#trackWindow(windowId);
        await this.#persist();
        return snapshot;
    }

    saveActiveProjectId(
        windowId: string,
        projectId: string | null,
        worktreeId: string | null = null,
    ): void {
        this.#mutateSnapshot(windowId, (snapshot) => ({
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
    }

    saveShellState(
        windowId: string,
        shellState: PersistedShellState | null,
    ): void {
        this.#mutateSnapshot(windowId, (snapshot) => ({
            ...snapshot,
            shellState,
        }));
    }

    saveWindowState(state: PersistedWindowState): void {
        this.#mutateSnapshot(state.id, (snapshot) => ({
            ...snapshot,
            windowState: state,
        }));
    }

    markWindowClosed(windowId: string): void {
        this.#setOpen(windowId, false);
    }

    markWindowOpen(windowId: string): void {
        this.#setOpen(windowId, true);
    }

    #rehydrate(records: readonly PersistedWindowRecord[]): void {
        this.#recordsByWindowId.clear();
        this.#windowOrder.length = 0;
        for (const record of records) {
            const windowId = record.snapshot.windowContext?.windowId;
            if (!windowId) {
                continue;
            }
            this.#recordsByWindowId.set(windowId, record);
            this.#trackWindow(windowId);
        }
    }

    #mutateSnapshot(
        windowId: string,
        mutate: (snapshot: PersistenceSnapshot) => PersistenceSnapshot,
    ): void {
        const current = this.#recordsByWindowId.get(windowId) ?? {
            isOpen: true,
            lastOpenedAt: new Date().toISOString(),
            snapshot: emptySnapshot(),
        };
        this.#recordsByWindowId.set(windowId, {
            ...current,
            snapshot: mutate(current.snapshot),
        });
        this.#trackWindow(windowId);
        this.#persistSoon();
    }

    #setOpen(windowId: string, isOpen: boolean): void {
        const current = this.#recordsByWindowId.get(windowId);
        if (!current) {
            return;
        }
        this.#recordsByWindowId.set(windowId, {
            ...current,
            isOpen,
            lastOpenedAt: isOpen ? new Date().toISOString() : current.lastOpenedAt,
        });
        this.#trackWindow(windowId);
        this.#persistSoon();
    }

    #trackWindow(windowId: string): void {
        if (!this.#windowOrder.includes(windowId)) {
            this.#windowOrder.push(windowId);
        }
    }

    #persistSoon(): void {
        this.#store.save(PERSISTENCE_KEY, [...this.#recordsByWindowId.values()]);
    }

    async #persist(): Promise<void> {
        await this.#store.saveNow(
            PERSISTENCE_KEY,
            [...this.#recordsByWindowId.values()],
        );
    }
}

class NativeSettingsClient implements SettingsGateway {
    readonly #store: NativeJsonStore;
    readonly #secretStore: SecretStoreGateway;
    readonly #projectSettingsById = new Map<string, ProjectSettingsSnapshot>();
    #snapshot: SettingsSnapshot;

    constructor(
        store: NativeJsonStore,
        secretStore: SecretStoreGateway,
        snapshot: SettingsSnapshot,
        projectSettings: Readonly<Record<string, ProjectSettingsSnapshot>>,
    ) {
        this.#store = store;
        this.#secretStore = secretStore;
        this.#snapshot = normalizeSettingsSnapshot(snapshot);
        for (const [projectId, value] of Object.entries(projectSettings)) {
            if (value?.projectId === projectId) {
                this.#projectSettingsById.set(projectId, value);
            }
        }
    }

    loadSnapshot(): SettingsSnapshot {
        return structuredClone(this.#snapshot);
    }

    saveSnapshot(snapshot: SettingsSnapshot): void {
        this.#snapshot = normalizeSettingsSnapshot(snapshot);
        this.#persistSoon();
    }

    loadAppAppearanceSettings(): AppAppearanceSettings {
        return requireSetting(this.#snapshot.appearance, "appearance");
    }

    saveAppAppearanceSettings(settings: AppAppearanceSettings): void {
        this.#snapshot = { ...this.#snapshot, appearance: settings };
        this.#persistSoon();
    }

    loadAppEditorSettings(): AppEditorSettings {
        return requireSetting(this.#snapshot.editor, "editor");
    }

    saveAppEditorSettings(settings: AppEditorSettings): void {
        this.#snapshot = { ...this.#snapshot, editor: settings };
        this.#persistSoon();
    }

    loadAiChatSettings(): AppAiChatSettings {
        return requireSetting(this.#snapshot.aiChat, "aiChat");
    }

    saveAiChatSettings(settings: AppAiChatSettings): void {
        this.#snapshot = { ...this.#snapshot, aiChat: settings };
        this.#persistSoon();
    }

    loadAppTerminalSettings() {
        return requireSetting(this.#snapshot.terminal, "terminal");
    }

    saveAppTerminalSettings(settings: ReturnType<SettingsGateway["loadAppTerminalSettings"]>): void {
        this.#snapshot = { ...this.#snapshot, terminal: settings };
        this.#persistSoon();
    }

    loadProjectSettings(projectId: string): ProjectSettingsSnapshot | null {
        const settings = this.#projectSettingsById.get(projectId);
        return settings ? structuredClone(settings) : null;
    }

    saveProjectSettings(snapshot: ProjectSettingsSnapshot): void {
        this.#projectSettingsById.set(snapshot.projectId, structuredClone(snapshot));
        this.#store.save(
            PROJECT_SETTINGS_KEY,
            Object.fromEntries(this.#projectSettingsById),
        );
    }

    loadCodexRuntimeSettings(): CodexRuntimeSettings {
        return requireAiSettings(this.#snapshot.ai).codex;
    }

    saveCodexRuntimeSettings(settings: CodexRuntimeSettings): void {
        this.#setRuntime("codex", settings);
    }

    loadClaudeRuntimeSettings(): ClaudeRuntimeSettings {
        return requireAiSettings(this.#snapshot.ai).claude;
    }

    saveClaudeRuntimeSettings(settings: ClaudeRuntimeSettings): void {
        this.#setRuntime("claude", settings);
    }

    loadGrokRuntimeSettings(): GrokRuntimeSettings {
        return requireAiSettings(this.#snapshot.ai).grok;
    }

    saveGrokRuntimeSettings(settings: GrokRuntimeSettings): void {
        this.#setRuntime("grok", settings);
    }

    loadKiloRuntimeSettings(): KiloRuntimeSettings {
        return requireAiSettings(this.#snapshot.ai).kilo;
    }

    saveKiloRuntimeSettings(settings: KiloRuntimeSettings): void {
        this.#setRuntime("kilo", settings);
    }

    loadOpenCodeRuntimeSettings(): OpenCodeRuntimeSettings {
        return requireAiSettings(this.#snapshot.ai).opencode;
    }

    saveOpenCodeRuntimeSettings(settings: OpenCodeRuntimeSettings): void {
        this.#setRuntime("opencode", settings);
    }

    async saveCodexAuth(
        settings: CodexRuntimeSettings,
        secrets: readonly SecretRecordPatch[],
    ): Promise<void> {
        await this.#saveAuth("codex", settings, secrets);
    }

    async saveClaudeAuth(
        settings: ClaudeRuntimeSettings,
        secrets: readonly SecretRecordPatch[],
    ): Promise<void> {
        await this.#saveAuth("claude", settings, secrets);
    }

    async saveGrokAuth(
        settings: GrokRuntimeSettings,
        secrets: readonly SecretRecordPatch[],
    ): Promise<void> {
        await this.#saveAuth("grok", settings, secrets);
    }

    async saveKiloAuth(
        settings: KiloRuntimeSettings,
        secrets: readonly SecretRecordPatch[],
    ): Promise<void> {
        await this.#saveAuth("kilo", settings, secrets);
    }

    async saveOpenCodeAuth(
        settings: OpenCodeRuntimeSettings,
        secrets: readonly SecretRecordPatch[],
    ): Promise<void> {
        await this.#saveAuth("opencode", settings, secrets);
    }

    #setRuntime(runtimeId: AiRuntimeId, settings: unknown): void {
        const ai = requireAiSettings(this.#snapshot.ai);
        this.#snapshot = {
            ...this.#snapshot,
            ai: {
                ...ai,
                [runtimeId]: settings,
            },
        };
        this.#persistSoon();
    }

    async #saveAuth(
        runtimeId: AiRuntimeId,
        settings: unknown,
        secrets: readonly SecretRecordPatch[],
    ): Promise<void> {
        for (const secret of secrets) {
            const parsed = parseSecretStorageKey(secret.key);
            await this.#secretStore.saveSecret(
                parsed.namespace,
                parsed.secretId,
                secret.value,
            );
        }
        this.#setRuntime(runtimeId, settings);
        await this.#store.saveNow(SETTINGS_KEY, this.#snapshot);
    }

    #persistSoon(): void {
        this.#store.save(SETTINGS_KEY, this.#snapshot);
    }
}

class NativeSecretStore implements SecretStoreGateway {
    readonly #client: NativeBackendRequester;
    readonly #valuesByKey = new Map<string, string | null>();

    constructor(client: NativeBackendRequester) {
        this.#client = client;
    }

    async hydrate(keys: readonly string[]): Promise<void> {
        await Promise.all(
            keys.map(async (key) => {
                const parsed = parseSecretStorageKey(key);
                const value = await this.#loadNative(
                    parsed.namespace,
                    parsed.secretId,
                );
                this.#valuesByKey.set(key, value);
            }),
        );
    }

    loadSecret(namespace: string, secretId: string): string | null {
        return this.#valuesByKey.get(secretKey(namespace, secretId)) ?? null;
    }

    cacheSecretPatches(secrets: readonly SecretRecordPatch[]): void {
        for (const secret of secrets) {
            this.#valuesByKey.set(secret.key, secret.value?.trim() || null);
        }
    }

    getStorageStatus(): SecretStorageStatus {
        return {
            encryptionAvailable: true,
            isWeakBackend: false,
            message: null,
            platform: process.platform,
            selectedBackend: "native-keyring",
        };
    }

    async saveSecret(
        namespace: string,
        secretId: string,
        value: string | null,
    ): Promise<void> {
        const normalized = value?.trim() || null;
        if (normalized) {
            await this.#client.request("app_secret_set", {
                namespace,
                secretId,
                value: normalized,
            });
        } else {
            await this.#client.request("app_secret_delete", {
                namespace,
                secretId,
            });
        }
        this.#valuesByKey.set(secretKey(namespace, secretId), normalized);
    }

    async deleteSecrets(
        secrets: readonly {
            readonly namespace: string;
            readonly secretId: string;
        }[],
    ): Promise<void> {
        await Promise.all(
            secrets.map((secret) =>
                this.saveSecret(secret.namespace, secret.secretId, null),
            ),
        );
    }

    async #loadNative(
        namespace: string,
        secretId: string,
    ): Promise<string | null> {
        const output = await this.#client.request<{ readonly value?: unknown }>(
            "app_secret_get",
            { namespace, secretId },
        );
        return typeof output.value === "string" ? output.value : null;
    }
}

class NativeWorkspaceClient implements WorkspaceGateway {
    readonly #store: NativeJsonStore;

    constructor(store: NativeJsonStore) {
        this.#store = store;
    }

    async loadSnapshot(workspaceId: string): Promise<WorkspaceSnapshot> {
        return await this.#store.load(
            workspaceKey(workspaceId),
            createDefaultWorkspaceSnapshot(),
        );
    }

    async saveSnapshot(
        workspaceId: string,
        snapshot: WorkspaceSnapshot,
    ): Promise<void> {
        await this.#store.saveNow(workspaceKey(workspaceId), snapshot);
    }

    loadChatSessionState(
        sessionId: string,
    ): PersistedChatSessionState | null {
        void sessionId;
        return null;
    }
}

class NativeAiPersistenceClient implements AiPersistenceGateway {
    readonly #store: NativeJsonStore;
    readonly #preferences = new Map<
        AiRuntimeId,
        PersistedRuntimeSelectionPreferences
    >();
    readonly #catalogs = new Map<AiRuntimeId, PersistedRuntimeCatalogSnapshot>();

    constructor(
        store: NativeJsonStore,
        preferences: Readonly<Record<string, PersistedRuntimeSelectionPreferences>>,
    ) {
        this.#store = store;
        for (const [runtimeId, value] of Object.entries(preferences)) {
            this.#preferences.set(runtimeId as AiRuntimeId, value);
        }
    }

    deleteSession(sessionId: string): void {
        void sessionId;
    }

    listSessionHistory(
        input: ListAiSessionHistoryInput,
    ): readonly AiHistorySessionSummary[] {
        void input;
        return [];
    }

    loadSessionSnapshot(
        sessionId: string,
    ): AiSessionSnapshot | null {
        void sessionId;
        return null;
    }

    loadSessionTranscriptPage(
        input: GetAiSessionTranscriptPageInput,
    ): AiSessionTranscriptPage | null {
        void input;
        return null;
    }

    loadLatestRuntimeCatalog(
        runtimeId: AiRuntimeId,
    ): PersistedRuntimeCatalogSnapshot | null {
        return this.#catalogs.get(runtimeId) ?? null;
    }

    loadRuntimeSelectionPreferences(
        runtimeId: AiRuntimeId,
    ): PersistedRuntimeSelectionPreferences {
        return (
            this.#preferences.get(runtimeId) ?? {
                configOptions: {},
                modeId: null,
                modelId: null,
            }
        );
    }

    listSessionRuntimeMappingsForParent(
        parentSessionId: string,
    ): readonly PersistedAiSessionRuntimeMapping[] {
        void parentSessionId;
        return [];
    }

    resolveAppSessionIdByRuntimeSessionId(
        runtimeSessionId: string,
    ): string | null {
        void runtimeSessionId;
        return null;
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
        };
        this.#preferences.set(runtimeId, next);
        this.#store.save(AI_PREFERENCES_KEY, Object.fromEntries(this.#preferences));
    }

    saveRuntimeSelectionPreferenceOption(
        runtimeId: AiRuntimeId,
        optionId: string,
        value: boolean | string,
    ): void {
        this.saveRuntimeSelectionPreferences(runtimeId, {
            configOptions: { [optionId]: value },
        });
    }

    saveRuntimeModePreference(runtimeId: AiRuntimeId, modeId: string): void {
        this.saveRuntimeSelectionPreferences(runtimeId, { modeId });
    }

    saveRuntimeModelPreference(runtimeId: AiRuntimeId, modelId: string): void {
        this.saveRuntimeSelectionPreferences(runtimeId, { modelId });
    }

    setSessionPinned(sessionId: string, pinned: boolean): void {
        void sessionId;
        void pinned;
    }

    saveSessionSnapshot(snapshot: AiSessionSnapshot): void {
        const catalog = toRuntimeCatalog(snapshot);
        if (catalog) {
            this.#catalogs.set(snapshot.runtimeId, catalog);
        }
    }
}

export async function createNativeAppDataClient(
    options: NativeAppDataClientOptions,
): Promise<NativeAppDataClient> {
    const store = new NativeJsonStore(options.client);
    const secretStore = new NativeSecretStore(options.client);
    await secretStore.hydrate(KNOWN_SECRET_KEYS);

    const settings = new NativeSettingsClient(
        store,
        secretStore,
        await store.load(SETTINGS_KEY, createDefaultSettingsSnapshot()),
        await store.load(PROJECT_SETTINGS_KEY, {}),
    );
    const persistence = new NativePersistenceClient(
        store,
        await store.load(PERSISTENCE_KEY, []),
    );
    const aiPersistence = new NativeAiPersistenceClient(
        store,
        await store.load(AI_PREFERENCES_KEY, {}),
    );

    return {
        aiPersistence,
        persistence,
        secretStore,
        settings,
        status: {
            appliedMigrations: ["native-schema"],
            databaseFile: options.databaseFile,
        },
        workspace: new NativeWorkspaceClient(store),
        close: () => Promise.resolve(),
    };
}

function emptySnapshot(): PersistenceSnapshot {
    return {
        activeProjectId: null,
        activeWorktreeId: null,
        shellState: null,
        windowContext: null,
        windowState: null,
    };
}

function createDefaultWorkspaceSnapshot(): WorkspaceSnapshot {
    const rootNode: WorkspaceNode = {
        activeTabId: null,
        id: "pane-root",
        tabIds: [],
        type: "pane",
    };
    return {
        activePaneId: "pane-root",
        rootNode,
        tabs: [],
    };
}

function createDefaultSettingsSnapshot(): SettingsSnapshot {
    return {
        ai: {
            claude: {
                authInvalidatedAtMs: null,
                authMethod: null,
                bedrockGatewayBaseUrl: null,
                binaryPath: null,
                gatewayBaseUrl: null,
                hasAnthropicApiKey: false,
                hasGatewayAuthToken: false,
                hasGatewayCustomHeaders: false,
            },
            codex: {
                authMethod: null,
                binaryPath: null,
                hasCodexApiKey: false,
                hasOpenAiApiKey: false,
            },
            gemini: {
                authInvalidatedAtMs: null,
                authMethod: null,
                binaryPath: null,
                googleCloudLocation: null,
                googleCloudProject: null,
                hasGeminiApiKey: false,
                hasGoogleApiKey: false,
            },
            grok: {
                authInvalidatedAtMs: null,
                authMethod: null,
                binaryPath: null,
                hasXaiApiKey: false,
            },
            kilo: {
                authInvalidatedAtMs: null,
                authMethod: null,
                binaryPath: null,
                hasKiloApiKey: false,
            },
            opencode: {
                authInvalidatedAtMs: null,
                authMethod: null,
                binaryPath: null,
            },
        },
        aiChat: {
            chatFontFamily: DEFAULT_AI_CHAT_FONT_FAMILY,
            chatFontSize: DEFAULT_AI_CHAT_FONT_SIZE,
            composerFontFamily: DEFAULT_AI_COMPOSER_FONT_FAMILY,
            composerFontSize: DEFAULT_AI_COMPOSER_FONT_SIZE,
            contextUsageBarEnabled: true,
            historyRetentionDays: 0,
            requireCmdEnterToSend: false,
            reviewDiffZoom: 0.96,
            screenshotRetentionSeconds: 0,
            toolCardExpansionMode: "collapsed",
        },
        appearance: {
            agentsSidebarScale: AGENTS_SIDEBAR_SCALE_DEFAULT,
            boostCodeContrast: true,
            fileTreeScale: FILE_TREE_SCALE_DEFAULT,
            stickyFoldersEnabled: true,
            themeMode: "system",
            themePreset: "default",
            zoomFactor: APP_ZOOM_FACTOR_DEFAULT,
        },
        editor: {
            autoSaveDelayMs: 750,
            fontFamily: DEFAULT_EDITOR_FONT_FAMILY,
            fontSize: DEFAULT_EDITOR_FONT_SIZE,
            lineHeight: 1.55,
            minimapEnabled: true,
            relativeLineNumbersEnabled: false,
            suggestionsEnabled: true,
            vimModeEnabled: false,
        },
        shellState: null,
        terminal: DEFAULT_APP_TERMINAL_SETTINGS,
    };
}

function normalizeSettingsSnapshot(snapshot: SettingsSnapshot): SettingsSnapshot {
    const defaults = createDefaultSettingsSnapshot();
    return {
        ai: snapshot.ai ?? defaults.ai,
        aiChat: snapshot.aiChat ?? defaults.aiChat,
        appearance: snapshot.appearance ?? defaults.appearance,
        editor: snapshot.editor ?? defaults.editor,
        shellState: snapshot.shellState ?? null,
        terminal: snapshot.terminal ?? defaults.terminal,
    };
}

function requireSetting<T>(value: T | null | undefined, name: string): T {
    if (value === null || value === undefined) {
        throw new Error(`Settings snapshot is missing ${name}.`);
    }
    return value;
}

function requireAiSettings(value: SettingsSnapshot["ai"]) {
    return requireSetting(value, "ai");
}

function secretKey(namespace: string, secretId: string): string {
    return `secret.${namespace}.${secretId}`;
}

function parseSecretStorageKey(key: string): {
    readonly namespace: string;
    readonly secretId: string;
} {
    const body = key.startsWith("secret.") ? key.slice("secret.".length) : key;
    const separator = body.lastIndexOf(".");
    if (separator <= 0 || separator === body.length - 1) {
        throw new Error("Invalid secret storage key.");
    }
    return {
        namespace: body.slice(0, separator),
        secretId: body.slice(separator + 1),
    };
}

function workspaceKey(workspaceId: string): string {
    return `${WORKSPACE_KEY_PREFIX}${workspaceId}`;
}

function toRuntimeCatalog(
    snapshot: PersistedRuntimeCatalogSnapshot,
): PersistedRuntimeCatalogSnapshot | null {
    if (
        snapshot.configOptions.length === 0 &&
        snapshot.models.length === 0 &&
        snapshot.modes.length === 0
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
