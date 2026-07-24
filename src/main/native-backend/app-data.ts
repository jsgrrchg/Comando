import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { safeStorage } from "electron";

import { APP_ZOOM_FACTOR_DEFAULT } from "@shared/app-zoom";
import { AGENTS_SIDEBAR_SCALE_DEFAULT } from "@shared/agents-sidebar-scale";
import { FILE_TREE_SCALE_DEFAULT } from "@shared/file-tree-scale";
import {
    DEFAULT_APP_TERMINAL_SETTINGS,
    normalizeWindowsTerminalShell,
} from "@shared/terminal-settings";
import {
    DEFAULT_AI_CHAT_FONT_FAMILY,
    DEFAULT_AI_CHAT_FONT_SIZE,
    DEFAULT_AI_COMPOSER_FONT_FAMILY,
    DEFAULT_AI_COMPOSER_FONT_SIZE,
    DEFAULT_EDITOR_FONT_FAMILY,
    DEFAULT_EDITOR_FONT_SIZE,
    EDITOR_FONT_FAMILY_IDS,
} from "@shared/typography";
import type {
    AiPromptQueueSnapshot,
    AiHistorySessionSummary,
    AiRuntimeId,
    AiSessionSnapshot,
    AiSessionTranscriptPage,
    AppAiChatSettings,
    AppAppearanceSettings,
    AppEditorSettings,
    ClaudeRuntimeSettings,
    CodexRuntimeSettings,
    CustomAcpRuntimeDefinition,
    CustomAcpRuntimeDefinitionInput,
    CustomAcpRuntimeId,
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
    PersistedWorkspaceSnapshot,
    ProjectSettingsSnapshot,
    SettingsSnapshot,
    ThemeMode,
    ThemePreset,
    WorkspaceNode,
    WorkspaceNavigationSnapshot,
    WindowWorkspaceRestoreRecord,
    WorkspaceSnapshot,
} from "@shared/ipc";
import {
    createCustomAcpRuntimeDefinition,
    normalizeCustomAcpRuntimesSettings,
    updateCustomAcpRuntimeDefinition,
} from "@main/ai/custom-acp-runtimes";
import {
    createWindowWorkspaceRestoreRecord,
    normalizeWindowWorkspaceRestoreRecord,
} from "@shared/workspace-restore";
import {
    areWorkspaceScopesEquivalent,
    hasOpenWorkspaceScope,
} from "@shared/workspace-context";

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
import type {
    WorkspaceContextTransferInput,
    WorkspaceContextTransferResult,
    WorkspaceGateway,
} from "@main/workspace/service";

import { debugBenignError } from "@main/observability/logging";

import type { NativeBackendRequester } from "./persistence";

const SETTINGS_KEY = "settings.snapshot";
const PROJECT_SETTINGS_KEY = "settings.projects";
const PERSISTENCE_KEY = "persistence.windows";
const AI_CATALOGS_KEY = "ai.runtimeCatalogs";
const AI_PREFERENCES_KEY = "ai.runtimePreferences";
const AI_PROMPT_QUEUES_KEY = "ai.promptQueues";
const WORKSPACE_KEY_PREFIX = "workspace.";
const AI_RUNTIME_IDS = [
    "claude",
    "codex",
    "grok",
    "kilo",
    "opencode",
] as const satisfies readonly AiRuntimeId[];
const THEME_PRESETS = [
    "default",
    "ocean",
    "forest",
    "amber",
    "rose",
    "lavender",
    "nord",
    "sunset",
    "catppuccin",
    "solarized",
    "tokyoNight",
    "gruvbox",
    "ayu",
    "nightOwl",
    "vesper",
    "rosePine",
    "kanagawa",
    "everforest",
    "synthwave84",
    "claude",
    "codex",
] as const satisfies readonly ThemePreset[];

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

type CompleteSettingsSnapshot = SettingsSnapshot & {
    readonly ai: NonNullable<SettingsSnapshot["ai"]>;
    readonly aiChat: NonNullable<SettingsSnapshot["aiChat"]>;
    readonly appearance: NonNullable<SettingsSnapshot["appearance"]>;
    readonly editor: NonNullable<SettingsSnapshot["editor"]>;
    readonly terminal: NonNullable<SettingsSnapshot["terminal"]>;
};

interface PersistedWindowRecord {
    readonly isOpen: boolean;
    readonly lastOpenedAt: string;
    readonly snapshot: PersistenceSnapshot;
    readonly workspaceRestore?: WindowWorkspaceRestoreRecord;
}

interface LegacySettingRow {
    readonly key: string;
    readonly value: string;
}

interface LegacyWindowSessionRow {
    readonly active_project_id: string | null;
    readonly active_worktree_id: string | null;
    readonly height: number;
    readonly is_full_screen: number;
    readonly is_maximized: number;
    readonly is_open: number | null;
    readonly last_opened_at: string | null;
    readonly shell_state_json: string | null;
    readonly window_id: string;
    readonly window_kind: string;
    readonly workspace_id: string;
    readonly workspace_session_id: string;
    readonly width: number;
    readonly x: number | null;
    readonly y: number | null;
}

interface LegacyWorkspaceLayoutRow {
    readonly active_pane_id: string;
    readonly id: string;
    readonly root_node_json: string;
}

interface LegacyWorkspaceTabRow {
    readonly created_at: string;
    readonly id: string;
    readonly kind: string;
    readonly payload_json: string;
    readonly title: string;
    readonly worktree_id: string | null;
}

interface LegacyProjectSettingRow {
    readonly key: string;
    readonly project_id: string;
    readonly value: string;
}

class NativeJsonStore {
    readonly #client: NativeBackendRequester;
    readonly #pendingWrites = new Set<Promise<void>>();
    readonly #writeChains = new Map<string, Promise<void>>();

    constructor(client: NativeBackendRequester) {
        this.#client = client;
    }

    async load<T>(key: string, fallback: T): Promise<T> {
        const value = await this.loadNullable<T>(key);
        return value === null ? fallback : value;
    }

    async loadNullable<T>(key: string): Promise<T | null> {
        const output = await this.#client.request<AppDataEnvelope<unknown>>(
            "app_data_get_json",
            { key },
        );
        if (!isRecord(output) || !("value" in output) || output.value === null) {
            return null;
        }
        return output.value as T;
    }

    save(key: string, value: unknown): void {
        const write = this.saveNow(key, value)
            .catch((error: unknown) => {
                debugBenignError(`nativeAppData.save.${key}`, error);
            })
            .finally(() => {
                this.#pendingWrites.delete(write);
            });
        this.#pendingWrites.add(write);
    }

    async saveNow(key: string, value: unknown): Promise<void> {
        const previous = this.#writeChains.get(key) ?? Promise.resolve();
        const write = previous
            .catch(() => undefined)
            .then(async () => {
                await this.#client.request("app_data_set_json", { key, value });
            });
        this.#writeChains.set(key, write);
        try {
            await write;
        } finally {
            if (this.#writeChains.get(key) === write) {
                this.#writeChains.delete(key);
            }
        }
    }

    async flush(): Promise<void> {
        const pendingWrites = [...this.#pendingWrites];
        await Promise.all(pendingWrites);
    }
}

class NativePersistenceClient implements PersistenceGateway {
    readonly #store: NativeJsonStore;
    readonly #recordsByWindowId = new Map<string, PersistedWindowRecord>();
    readonly #windowOrder: string[] = [];
    #workspaceCommitChain: Promise<void> = Promise.resolve();

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

    findWorkspaceRestore(
        workspaceId: string,
    ): WindowWorkspaceRestoreRecord | null {
        for (const record of this.#recordsByWindowId.values()) {
            if (record.snapshot.windowContext?.workspaceId === workspaceId) {
                return record.workspaceRestore ?? null;
            }
        }
        return null;
    }

    findWorkspaceScope(workspaceId: string): {
        readonly projectId: string | null;
        readonly worktreeId: string | null;
    } {
        for (const record of this.#recordsByWindowId.values()) {
            if (record.snapshot.windowContext?.workspaceId === workspaceId) {
                return {
                    projectId: record.snapshot.activeProjectId,
                    worktreeId: record.snapshot.activeWorktreeId ?? null,
                };
            }
        }
        return { projectId: null, worktreeId: null };
    }

    async commitWorkspaceRestore(
        workspaceId: string,
        snapshot: WorkspaceNavigationSnapshot,
    ): Promise<void> {
        const commit = this.#workspaceCommitChain.then(() =>
            this.#commitWorkspaceRestoreNow(workspaceId, snapshot),
        );
        this.#workspaceCommitChain = commit.catch(() => undefined);
        await commit;
    }

    async transferWorkspaceContext(
        input: WorkspaceContextTransferInput,
    ): Promise<WorkspaceContextTransferResult> {
        const commit = this.#workspaceCommitChain.then(() =>
            this.#transferWorkspaceContextNow(input),
        );
        this.#workspaceCommitChain = commit.then(
            () => undefined,
            () => undefined,
        );
        return await commit;
    }

    async #transferWorkspaceContextNow(
        input: WorkspaceContextTransferInput,
    ): Promise<WorkspaceContextTransferResult> {
        if (input.sourceWorkspaceId === input.targetWorkspaceId) {
            throw new Error("Workspace transfers require two different windows.");
        }
        const sourceEntry = this.#findWindowEntryByWorkspaceId(
            input.sourceWorkspaceId,
        );
        const targetEntry = this.#findWindowEntryByWorkspaceId(
            input.targetWorkspaceId,
        );
        if (!sourceEntry || !targetEntry) {
            throw new Error("A workspace transfer window was not found.");
        }
        const [sourceWindowId, sourceRecord] = sourceEntry;
        const [targetWindowId, targetRecord] = targetEntry;
        const sourceRestore = sourceRecord.workspaceRestore ??
            createWindowWorkspaceRestoreRecord(emptyWorkspaceNavigation());
        const targetRestore = targetRecord.workspaceRestore ??
            createWindowWorkspaceRestoreRecord(emptyWorkspaceNavigation());
        if (
            sourceRestore.revision !== input.sourceRevision ||
            targetRestore.revision !== input.targetRevision
        ) {
            throw new Error("A workspace changed before it could be moved.");
        }
        const context = sourceRestore.snapshot.contexts.find(
            (candidate) => candidate.key === input.contextKey,
        );
        if (
            !context ||
            !sourceRestore.snapshot.openContextKeys.includes(input.contextKey)
        ) {
            throw new Error("The workspace to move is no longer open.");
        }
        if (hasOpenWorkspaceScope(targetRestore.snapshot, context)) {
            throw new Error("The destination already contains this workspace.");
        }

        const sourceOpenContextKeys =
            sourceRestore.snapshot.openContextKeys.filter(
                (key) => key !== input.contextKey,
            );
        const sourceIndex = sourceRestore.snapshot.openContextKeys.indexOf(
            input.contextKey,
        );
        const sourceActiveContextKey =
            sourceRestore.snapshot.activeContextKey === input.contextKey
                ? (sourceOpenContextKeys[
                      Math.min(sourceIndex, sourceOpenContextKeys.length - 1)
                  ] ?? null)
                : sourceRestore.snapshot.activeContextKey;
        const targetIndex = Math.max(
            0,
            Math.min(
                input.targetIndex ?? targetRestore.snapshot.openContextKeys.length,
                targetRestore.snapshot.openContextKeys.length,
            ),
        );
        const targetOpenContextKeys = [
            ...targetRestore.snapshot.openContextKeys.slice(0, targetIndex),
            context.key,
            ...targetRestore.snapshot.openContextKeys.slice(targetIndex),
        ];
        const updatedContext = {
            ...context,
            lastActivatedAt: new Date().toISOString(),
        };
        const source = createWindowWorkspaceRestoreRecord(
            {
                ...sourceRestore.snapshot,
                activeContextKey: sourceActiveContextKey,
                contexts: sourceRestore.snapshot.contexts.filter(
                    (candidate) => candidate.key !== input.contextKey,
                ),
                openContextKeys: sourceOpenContextKeys,
            },
            sourceRestore.revision + 1,
        );
        const target = createWindowWorkspaceRestoreRecord(
            {
                ...targetRestore.snapshot,
                activeContextKey: context.key,
                // A closed retained context is a cache, not a live duplicate.
                // Replace it with the incoming live context and its latest state.
                contexts: [
                    ...targetRestore.snapshot.contexts.filter(
                        (candidate) =>
                            !areWorkspaceScopesEquivalent(candidate, context),
                    ),
                    updatedContext,
                ],
                openContextKeys: targetOpenContextKeys,
            },
            targetRestore.revision + 1,
        );

        this.#recordsByWindowId.set(
            sourceWindowId,
            withWorkspaceRestore(sourceRecord, source),
        );
        this.#recordsByWindowId.set(
            targetWindowId,
            withWorkspaceRestore(targetRecord, target),
        );
        try {
            await this.#persist();
        } catch (error) {
            // Restore both records together so a failed durable write cannot
            // leak a half-applied move into later in-memory reads.
            this.#recordsByWindowId.set(sourceWindowId, sourceRecord);
            this.#recordsByWindowId.set(targetWindowId, targetRecord);
            throw error;
        }
        return { source, target };
    }

    async #commitWorkspaceRestoreNow(
        workspaceId: string,
        snapshot: WorkspaceNavigationSnapshot,
    ): Promise<void> {
        const entry = [...this.#recordsByWindowId.entries()].find(
            ([, record]) =>
                record.snapshot.windowContext?.workspaceId === workspaceId,
        );
        if (!entry) {
            throw new Error("The workspace window was not found.");
        }
        const [windowId, current] = entry;
        const currentRevision = current.workspaceRestore?.revision ?? 0;
        const activeContext = snapshot.contexts.find(
            (context) => context.key === snapshot.activeContextKey,
        );
        const restore = createWindowWorkspaceRestoreRecord(
            snapshot,
            currentRevision + 1,
        );
        this.#recordsByWindowId.set(windowId, {
            ...current,
            snapshot: {
                ...current.snapshot,
                activeProjectId: activeContext?.projectId ?? null,
                activeWorktreeId: activeContext?.worktreeId ?? null,
                windowContext: current.snapshot.windowContext
                    ? {
                          ...current.snapshot.windowContext,
                          projectId: activeContext?.projectId ?? null,
                          worktreeId: activeContext?.worktreeId ?? null,
                      }
                    : null,
            },
            workspaceRestore: restore,
        });
        await this.#persist();
    }

    #findWindowEntryByWorkspaceId(
        workspaceId: string,
    ): [string, PersistedWindowRecord] | null {
        return (
            [...this.#recordsByWindowId.entries()].find(
                ([, record]) =>
                    record.snapshot.windowContext?.workspaceId === workspaceId,
            ) ?? null
        );
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

function emptyWorkspaceNavigation(): WorkspaceNavigationSnapshot {
    return {
        activeContextKey: null,
        contexts: [],
        openContextKeys: [],
        version: 3,
    };
}

function withWorkspaceRestore(
    record: PersistedWindowRecord,
    workspaceRestore: WindowWorkspaceRestoreRecord,
): PersistedWindowRecord {
    const activeContext = workspaceRestore.snapshot.contexts.find(
        (context) => context.key === workspaceRestore.snapshot.activeContextKey,
    );
    return {
        ...record,
        snapshot: {
            ...record.snapshot,
            activeProjectId: activeContext?.projectId ?? null,
            activeWorktreeId: activeContext?.worktreeId ?? null,
            windowContext: record.snapshot.windowContext
                ? {
                      ...record.snapshot.windowContext,
                      projectId: activeContext?.projectId ?? null,
                      worktreeId: activeContext?.worktreeId ?? null,
                  }
                : null,
        },
        workspaceRestore,
    };
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
        // Dedicated CRUD keeps renderer snapshots from choosing IDs, revisions,
        // fingerprints, or silently replacing the custom runtime collection.
        this.#snapshot = normalizeSettingsSnapshot({
            ...snapshot,
            customAcpRuntimes: this.#snapshot.customAcpRuntimes,
        });
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

    listCustomAcpRuntimes(): readonly CustomAcpRuntimeDefinition[] {
        return structuredClone(
            normalizeCustomAcpRuntimesSettings(
                this.#snapshot.customAcpRuntimes,
            ).runtimes,
        );
    }

    createCustomAcpRuntime(
        input: CustomAcpRuntimeDefinitionInput,
    ): CustomAcpRuntimeDefinition {
        const definitions = this.listCustomAcpRuntimes();
        const definition = createCustomAcpRuntimeDefinition(
            input,
            definitions,
        );
        this.#setCustomAcpRuntimes([...definitions, definition]);
        return structuredClone(definition);
    }

    updateCustomAcpRuntime(
        id: CustomAcpRuntimeId,
        input: CustomAcpRuntimeDefinitionInput,
    ): CustomAcpRuntimeDefinition {
        const definitions = this.listCustomAcpRuntimes();
        const current = definitions.find((definition) => definition.id === id);
        if (!current) {
            throw new Error("Custom ACP runtime was not found.");
        }
        const updated = updateCustomAcpRuntimeDefinition(
            current,
            input,
            definitions,
        );
        this.#setCustomAcpRuntimes(
            definitions.map((definition) =>
                definition.id === id ? updated : definition,
            ),
        );
        return structuredClone(updated);
    }

    deleteCustomAcpRuntime(id: CustomAcpRuntimeId) {
        const definitions = this.listCustomAcpRuntimes();
        const nextDefinitions = definitions.filter(
            (definition) => definition.id !== id,
        );
        if (nextDefinitions.length === definitions.length) {
            return { deleted: false, historyReferenceCount: 0 };
        }
        this.#setCustomAcpRuntimes(nextDefinitions);
        return { deleted: true, historyReferenceCount: 0 };
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

    #setCustomAcpRuntimes(
        definitions: readonly CustomAcpRuntimeDefinition[],
    ): void {
        this.#snapshot = {
            ...this.#snapshot,
            customAcpRuntimes: {
                runtimes: structuredClone(definitions),
                version: 1,
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
    readonly #persistence: NativePersistenceClient;
    readonly #store: NativeJsonStore;

    constructor(
        store: NativeJsonStore,
        persistence: NativePersistenceClient,
    ) {
        this.#store = store;
        this.#persistence = persistence;
    }

    async loadSnapshot(
        workspaceId: string,
    ): Promise<WindowWorkspaceRestoreRecord> {
        const embedded = this.#persistence.findWorkspaceRestore(workspaceId);
        if (embedded) {
            const normalized = normalizeWindowWorkspaceRestoreRecord(
                embedded,
                this.#persistence.findWorkspaceScope(workspaceId),
            );
            if (JSON.stringify(normalized) !== JSON.stringify(embedded)) {
                await this.#persistence.commitWorkspaceRestore(
                    workspaceId,
                    normalized.snapshot,
                );
                return this.#persistence.findWorkspaceRestore(workspaceId) ?? normalized;
            }
            return normalized;
        }
        const legacy = await this.#store.load<PersistedWorkspaceSnapshot>(
            workspaceKey(workspaceId),
            createDefaultWorkspaceSnapshot(),
        );
        const normalized = normalizeWindowWorkspaceRestoreRecord(
            legacy,
            this.#persistence.findWorkspaceScope(workspaceId),
        );
        await this.#persistence.commitWorkspaceRestore(
            workspaceId,
            normalized.snapshot,
        );
        return this.#persistence.findWorkspaceRestore(workspaceId) ?? normalized;
    }

    async saveSnapshot(
        workspaceId: string,
        snapshot: WorkspaceNavigationSnapshot,
    ): Promise<void> {
        const normalizedSnapshot = normalizeWindowWorkspaceRestoreRecord(
            snapshot,
            this.#persistence.findWorkspaceScope(workspaceId),
        ).snapshot;
        return await this.#persistence.commitWorkspaceRestore(
            workspaceId,
            normalizedSnapshot,
        );
    }

    transferContext(
        input: WorkspaceContextTransferInput,
    ): Promise<WorkspaceContextTransferResult> {
        return this.#persistence.transferWorkspaceContext(input);
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
    readonly #promptQueueSnapshots: readonly AiPromptQueueSnapshot[];

    constructor(
        store: NativeJsonStore,
        preferences: Readonly<Record<string, PersistedRuntimeSelectionPreferences>>,
        catalogs: Readonly<Record<string, PersistedRuntimeCatalogSnapshot>>,
        promptQueueSnapshots: readonly AiPromptQueueSnapshot[],
    ) {
        this.#store = store;
        this.#promptQueueSnapshots = promptQueueSnapshots;
        for (const [runtimeId, value] of Object.entries(preferences)) {
            this.#preferences.set(runtimeId as AiRuntimeId, value);
        }
        for (const [runtimeId, value] of Object.entries(catalogs)) {
            const catalog = toRuntimeCatalog(value);
            if (catalog) {
                const typedRuntimeId = runtimeId as AiRuntimeId;
                this.#catalogs.set(
                    typedRuntimeId,
                    mergeRuntimeCatalog(
                        this.#catalogs.get(typedRuntimeId) ?? null,
                        catalog,
                    ),
                );
            }
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

    loadPromptQueueSnapshots(): readonly AiPromptQueueSnapshot[] {
        return this.#promptQueueSnapshots;
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
            this.#catalogs.set(
                snapshot.runtimeId,
                mergeRuntimeCatalog(
                    this.#catalogs.get(snapshot.runtimeId) ?? null,
                    catalog,
                ),
            );
            this.#store.save(AI_CATALOGS_KEY, Object.fromEntries(this.#catalogs));
        }
    }

    saveRuntimeCatalogPatch(
        runtimeId: AiRuntimeId,
        patch: Partial<PersistedRuntimeCatalogSnapshot>,
    ): void {
        const nextCatalog = applyRuntimeCatalogPatch(
            this.#catalogs.get(runtimeId) ?? createEmptyRuntimeCatalog(),
            patch,
        );
        const catalog = toRuntimeCatalog(nextCatalog);
        if (catalog) {
            this.#catalogs.set(runtimeId, catalog);
        } else {
            this.#catalogs.delete(runtimeId);
        }
        this.#store.save(AI_CATALOGS_KEY, Object.fromEntries(this.#catalogs));
    }

    savePromptQueueSnapshots(
        snapshots: readonly AiPromptQueueSnapshot[],
    ): void {
        this.#store.save(AI_PROMPT_QUEUES_KEY, snapshots);
    }
}

async function migrateLegacyAppData(input: {
    readonly databaseFile: string;
    readonly secretStore: SecretStoreGateway;
    readonly store: NativeJsonStore;
}): Promise<void> {
    if (!fs.existsSync(input.databaseFile)) {
        return;
    }

    let database: DatabaseSync | null = null;
    try {
        database = new DatabaseSync(input.databaseFile, { readOnly: true });
        const settings = readLegacySettings(database);
        if (settings.size === 0) {
            return;
        }

        if ((await input.store.loadNullable<SettingsSnapshot>(SETTINGS_KEY)) === null) {
            await input.store.saveNow(
                SETTINGS_KEY,
                createLegacySettingsSnapshot(settings),
            );
        }
        if (
            (await input.store.loadNullable<readonly PersistedWindowRecord[]>(
                PERSISTENCE_KEY,
            )) === null
        ) {
            const windows = readLegacyWindowRecords(database);
            if (windows.length > 0) {
                await input.store.saveNow(PERSISTENCE_KEY, windows);
            }
        }
        await migrateLegacyWorkspaces(database, input.store);
        await migrateLegacyProjectSettings(database, input.store);
        await migrateLegacyRuntimePreferences(settings, input.store);
        await migrateLegacyRuntimeCatalogs(settings, input.store);
        await migrateLegacySecrets(settings, input.store, input.secretStore);
    } catch (error) {
        debugBenignError("nativeAppData.legacyMigration", error);
    } finally {
        database?.close();
    }
}

function readLegacySettings(database: DatabaseSync): Map<string, string> {
    if (!tableExists(database, "app_settings")) {
        return new Map();
    }
    const rows = database
        .prepare("SELECT key, value FROM app_settings")
        .all() as unknown as LegacySettingRow[];
    return new Map(rows.map((row) => [row.key, row.value]));
}

function createLegacySettingsSnapshot(
    settings: ReadonlyMap<string, string>,
): SettingsSnapshot {
    const defaults = createDefaultSettingsSnapshot();
    return normalizeSettingsSnapshot({
        ...defaults,
        ai: {
            ...defaults.ai,
            claude: {
                ...defaults.ai.claude,
                authInvalidatedAtMs: readLegacyNumberSetting(
                    settings,
                    "ai.claude.auth_invalidated_at_ms",
                ),
                authMethod: readLegacyStringSetting(
                    settings,
                    "ai.claude.auth_method",
                ) as ClaudeRuntimeSettings["authMethod"],
                bedrockGatewayBaseUrl: readLegacyStringSetting(
                    settings,
                    "ai.claude.bedrock_gateway_base_url",
                ),
                binaryPath: readLegacyStringSetting(
                    settings,
                    "ai.claude.binary_path",
                ),
                gatewayBaseUrl: readLegacyStringSetting(
                    settings,
                    "ai.claude.gateway_base_url",
                ),
                hasAnthropicApiKey:
                    readLegacyBooleanSetting(
                        settings,
                        "ai.claude.has_anthropic_api_key",
                    ) ?? false,
                hasGatewayAuthToken:
                    readLegacyBooleanSetting(
                        settings,
                        "ai.claude.has_gateway_auth_token",
                    ) ?? false,
                hasGatewayCustomHeaders:
                    readLegacyBooleanSetting(
                        settings,
                        "ai.claude.has_gateway_custom_headers",
                    ) ?? false,
            },
            codex: {
                ...defaults.ai.codex,
                authMethod: readLegacyStringSetting(
                    settings,
                    "ai.codex.auth_method",
                ) as CodexRuntimeSettings["authMethod"],
                binaryPath: readLegacyStringSetting(
                    settings,
                    "ai.codex.binary_path",
                ),
                hasCodexApiKey:
                    readLegacyBooleanSetting(
                        settings,
                        "ai.codex.has_codex_api_key",
                    ) ?? false,
                hasOpenAiApiKey:
                    readLegacyBooleanSetting(
                        settings,
                        "ai.codex.has_openai_api_key",
                    ) ?? false,
            },
            grok: {
                ...defaults.ai.grok,
                authInvalidatedAtMs: readLegacyNumberSetting(
                    settings,
                    "ai.grok.auth_invalidated_at_ms",
                ),
                authMethod: readLegacyStringSetting(
                    settings,
                    "ai.grok.auth_method",
                ) as GrokRuntimeSettings["authMethod"],
                binaryPath: readLegacyStringSetting(
                    settings,
                    "ai.grok.binary_path",
                ),
                hasXaiApiKey:
                    readLegacyBooleanSetting(
                        settings,
                        "ai.grok.has_xai_api_key",
                    ) ?? false,
            },
            kilo: {
                ...defaults.ai.kilo,
                authInvalidatedAtMs: readLegacyNumberSetting(
                    settings,
                    "ai.kilo.auth_invalidated_at_ms",
                ),
                authMethod: readLegacyStringSetting(
                    settings,
                    "ai.kilo.auth_method",
                ) as KiloRuntimeSettings["authMethod"],
                binaryPath: readLegacyStringSetting(
                    settings,
                    "ai.kilo.binary_path",
                ),
                hasKiloApiKey:
                    readLegacyBooleanSetting(
                        settings,
                        "ai.kilo.has_kilo_api_key",
                    ) ?? false,
            },
            opencode: {
                ...defaults.ai.opencode,
                authInvalidatedAtMs: readLegacyNumberSetting(
                    settings,
                    "ai.opencode.auth_invalidated_at_ms",
                ),
                authMethod: readLegacyStringSetting(
                    settings,
                    "ai.opencode.auth_method",
                ) as OpenCodeRuntimeSettings["authMethod"],
                binaryPath: readLegacyStringSetting(
                    settings,
                    "ai.opencode.binary_path",
                ),
            },
        },
        aiChat: {
            ...defaults.aiChat,
            chatFontFamily:
                normalizeLegacyFontFamily(
                    readLegacyStringSetting(settings, "ai.chat.font_family"),
                ) ??
                defaults.aiChat.chatFontFamily,
            chatFontSize:
                readLegacyNumberSetting(settings, "ai.chat.font_size") ??
                defaults.aiChat.chatFontSize,
            composerFontFamily:
                normalizeLegacyFontFamily(
                    readLegacyStringSetting(settings, "ai.composer.font_family"),
                ) ??
                defaults.aiChat.composerFontFamily,
            composerFontSize:
                readLegacyNumberSetting(settings, "ai.composer.font_size") ??
                defaults.aiChat.composerFontSize,
            contextUsageBarEnabled:
                readLegacyBooleanSetting(
                    settings,
                    "ai.composer.context_usage_bar_enabled",
                ) ?? defaults.aiChat.contextUsageBarEnabled,
            historyRetentionDays:
                readLegacyNumberSetting(
                    settings,
                    "ai.chat.history_retention_days",
                ) ?? defaults.aiChat.historyRetentionDays,
            requireCmdEnterToSend:
                readLegacyBooleanSetting(
                    settings,
                    "ai.composer.require_cmd_enter",
                ) ?? defaults.aiChat.requireCmdEnterToSend,
            reviewDiffZoom:
                readLegacyNumberSetting(settings, "ai.review.diff_zoom") ??
                defaults.aiChat.reviewDiffZoom,
            screenshotRetentionSeconds:
                readLegacyNumberSetting(
                    settings,
                    "ai.composer.screenshot_retention_seconds",
                ) ?? defaults.aiChat.screenshotRetentionSeconds,
        },
        appearance: {
            ...defaults.appearance,
            agentsSidebarScale:
                readLegacyNumberSetting(
                    settings,
                    "appearance.agents_sidebar_scale",
                ) ?? defaults.appearance.agentsSidebarScale,
            boostCodeContrast:
                readLegacyBooleanSetting(
                    settings,
                    "appearance.boost_code_contrast",
                ) ?? defaults.appearance.boostCodeContrast,
            fileTreeScale:
                readLegacyNumberSetting(settings, "appearance.file_tree_scale") ??
                defaults.appearance.fileTreeScale,
            stickyFoldersEnabled:
                readLegacyBooleanSetting(
                    settings,
                    "appearance.sticky_folders_enabled",
                ) ?? defaults.appearance.stickyFoldersEnabled,
            themeMode:
                parseLegacyThemeMode(
                    readLegacyStringSetting(settings, "appearance.theme_mode"),
                ) ??
                defaults.appearance.themeMode,
            themePreset:
                parseLegacyThemePreset(
                    readLegacyStringSetting(settings, "appearance.theme_preset"),
                ) ??
                defaults.appearance.themePreset,
            transparencyEnabled:
                readLegacyBooleanSetting(
                    settings,
                    "appearance.transparency_enabled",
                ) ?? defaults.appearance.transparencyEnabled,
            zoomFactor:
                readLegacyNumberSetting(settings, "appearance.zoom_factor") ??
                defaults.appearance.zoomFactor,
        },
        editor: {
            ...defaults.editor,
            autoSaveDelayMs:
                readLegacyNumberSetting(
                    settings,
                    "editor.autosave_delay_ms",
                ) ?? defaults.editor.autoSaveDelayMs,
            fontFamily:
                normalizeLegacyFontFamily(
                    readLegacyStringSetting(settings, "editor.font_family"),
                ) ?? defaults.editor.fontFamily,
            fontSize:
                readLegacyNumberSetting(settings, "editor.font_size") ??
                defaults.editor.fontSize,
            lineHeight:
                readLegacyNumberSetting(settings, "editor.line_height") ??
                defaults.editor.lineHeight,
            minimapEnabled:
                readLegacyBooleanSetting(settings, "editor.minimap_enabled") ??
                defaults.editor.minimapEnabled,
            relativeLineNumbersEnabled:
                readLegacyBooleanSetting(
                    settings,
                    "editor.relative_line_numbers_enabled",
                ) ?? defaults.editor.relativeLineNumbersEnabled,
            suggestionsEnabled:
                readLegacyBooleanSetting(
                    settings,
                    "editor.suggestions_enabled",
                ) ?? defaults.editor.suggestionsEnabled,
            vimModeEnabled:
                readLegacyBooleanSetting(settings, "editor.vim_mode_enabled") ??
                defaults.editor.vimModeEnabled,
        },
        shellState:
            readLegacyJsonSetting<PersistedShellState>(settings, "shell.state") ??
            defaults.shellState,
        terminal: {
            ...defaults.terminal,
            claudeCodeContinueSession:
                readLegacyBooleanSetting(
                    settings,
                    "terminal.claude_code_continue_session",
                ) ?? defaults.terminal.claudeCodeContinueSession,
            claudeCodeMaxTurns:
                readLegacyNumberSetting(
                    settings,
                    "terminal.claude_code_max_turns",
                ) ?? defaults.terminal.claudeCodeMaxTurns,
            claudeCodeModel:
                readLegacyStringSetting(
                    settings,
                    "terminal.claude_code_model",
                ) ?? defaults.terminal.claudeCodeModel,
            claudeCodeOptimized:
                readLegacyBooleanSetting(
                    settings,
                    "terminal.claude_code_optimized",
                ) ?? defaults.terminal.claudeCodeOptimized,
            claudeCodeSkipPermissions:
                readLegacyBooleanSetting(
                    settings,
                    "terminal.claude_code_skip_permissions",
                ) ?? defaults.terminal.claudeCodeSkipPermissions,
            terminalFontFamily:
                readLegacyStringSetting(settings, "terminal.font_family") ??
                defaults.terminal.terminalFontFamily,
            terminalFontSize:
                readLegacyNumberSetting(settings, "terminal.font_size") ??
                defaults.terminal.terminalFontSize,
            windowsShell:
                normalizeWindowsTerminalShell(
                    readLegacyStringSetting(settings, "terminal.windows_shell"),
                ),
        },
    });
}

function readLegacyWindowRecords(
    database: DatabaseSync,
): readonly PersistedWindowRecord[] {
    if (
        !tableExists(database, "workspace_sessions") ||
        !tableExists(database, "app_windows")
    ) {
        return [];
    }
    const rows = database
        .prepare(
            `
            SELECT
                app_windows.id AS window_id,
                app_windows.kind AS window_kind,
                app_windows.x,
                app_windows.y,
                app_windows.width,
                app_windows.height,
                app_windows.is_maximized,
                app_windows.is_full_screen,
                workspace_sessions.id AS workspace_session_id,
                workspace_sessions.workspace_id,
                workspace_sessions.active_project_id,
                workspace_sessions.active_worktree_id,
                workspace_sessions.shell_state_json,
                workspace_sessions.is_open,
                workspace_sessions.last_opened_at
            FROM workspace_sessions
            INNER JOIN app_windows
                ON app_windows.id = workspace_sessions.window_id
            WHERE app_windows.kind = 'main'
            ORDER BY workspace_sessions.last_opened_at ASC
            `,
        )
        .all() as unknown as LegacyWindowSessionRow[];

    return rows.map((row) => ({
        isOpen: row.is_open !== 0,
        lastOpenedAt: row.last_opened_at ?? new Date().toISOString(),
        snapshot: {
            activeProjectId: row.active_project_id,
            activeWorktreeId: row.active_worktree_id,
            shellState: parseLegacyJson<PersistedShellState | null>(
                row.shell_state_json,
                null,
            ),
            windowContext: {
                projectId: row.active_project_id,
                windowId: row.window_id,
                windowKind: "main",
                workspaceId: row.workspace_id,
                workspaceSessionId: row.workspace_session_id,
                worktreeId: row.active_worktree_id,
            },
            windowState: {
                height: row.height,
                id: row.window_id,
                isFullScreen: row.is_full_screen === 1,
                isMaximized: row.is_maximized === 1,
                width: row.width,
                x: row.x,
                y: row.y,
            },
        },
    }));
}

async function migrateLegacyWorkspaces(
    database: DatabaseSync,
    store: NativeJsonStore,
): Promise<void> {
    if (
        !tableExists(database, "workspace_layouts") ||
        !tableExists(database, "workspace_tabs")
    ) {
        return;
    }
    const layouts = database
        .prepare(
            `
            SELECT id, active_pane_id, root_node_json
            FROM workspace_layouts
            `,
        )
        .all() as unknown as LegacyWorkspaceLayoutRow[];
    for (const layout of layouts) {
        const key = workspaceKey(layout.id);
        if ((await store.loadNullable<WorkspaceSnapshot>(key)) !== null) {
            continue;
        }
        const tabs = database
            .prepare(
                `
                SELECT id, kind, title, payload_json, created_at, worktree_id
                FROM workspace_tabs
                WHERE workspace_id = ?
                ORDER BY position ASC
                `,
            )
            .all(layout.id) as unknown as LegacyWorkspaceTabRow[];
        await store.saveNow(key, {
            activePaneId: layout.active_pane_id,
            rootNode: parseLegacyJson<WorkspaceNode>(
                layout.root_node_json,
                createDefaultWorkspaceSnapshot().rootNode,
            ),
            tabs: tabs
                .map(legacyWorkspaceTabToSnapshotTab)
                .filter(
                    (tab): tab is WorkspaceSnapshot["tabs"][number] =>
                        tab !== null,
                ),
        } satisfies WorkspaceSnapshot);
    }
}

function legacyWorkspaceTabToSnapshotTab(
    row: LegacyWorkspaceTabRow,
): WorkspaceSnapshot["tabs"][number] | null {
    const payload = parseLegacyJson<Record<string, unknown>>(
        row.payload_json,
        {},
    );
    if (!isRecord(payload)) {
        return null;
    }
    return {
        ...payload,
        createdAt: row.created_at,
        id: row.id,
        kind: row.kind,
        title: row.title,
        worktreeId:
            row.worktree_id ??
            (typeof payload.worktreeId === "string" ? payload.worktreeId : null),
    } as WorkspaceSnapshot["tabs"][number];
}

async function migrateLegacyProjectSettings(
    database: DatabaseSync,
    store: NativeJsonStore,
): Promise<void> {
    if (!tableExists(database, "project_settings")) {
        return;
    }
    if (
        (await store.loadNullable<Record<string, ProjectSettingsSnapshot>>(
            PROJECT_SETTINGS_KEY,
        )) !== null
    ) {
        return;
    }
    const rows = database
        .prepare("SELECT project_id, key, value FROM project_settings")
        .all() as unknown as LegacyProjectSettingRow[];
    const byProjectId = new Map<string, Record<string, string>>();
    for (const row of rows) {
        const settings = byProjectId.get(row.project_id) ?? {};
        settings[row.key] = row.value;
        byProjectId.set(row.project_id, settings);
    }
    const migrated: Record<string, ProjectSettingsSnapshot> = {};
    for (const [projectId, values] of byProjectId) {
        migrated[projectId] = {
            editor: {
                fontFamily: normalizeLegacyFontFamily(
                    values["editor.font_family"],
                ),
                fontSize: parseFiniteNumber(values["editor.font_size"]),
                lineHeight: parseFiniteNumber(values["editor.line_height"]),
                minimapEnabled: parseLegacyBoolean(values["editor.minimap_enabled"]),
                suggestionsEnabled: parseLegacyBoolean(
                    values["editor.suggestions_enabled"],
                ),
            },
            appearance: {
                themeMode: parseLegacyThemeMode(values["appearance.theme_mode"]),
                themePreset: parseLegacyThemePreset(
                    values["appearance.theme_preset"],
                ),
            },
            projectId,
        };
    }
    if (Object.keys(migrated).length > 0) {
        await store.saveNow(PROJECT_SETTINGS_KEY, migrated);
    }
}

async function migrateLegacyRuntimePreferences(
    settings: ReadonlyMap<string, string>,
    store: NativeJsonStore,
): Promise<void> {
    if (
        (await store.loadNullable<Record<string, PersistedRuntimeSelectionPreferences>>(
            AI_PREFERENCES_KEY,
        )) !== null
    ) {
        return;
    }
    const preferences: Record<string, PersistedRuntimeSelectionPreferences> = {};
    for (const runtimeId of ["claude", "codex", "grok", "kilo", "opencode"]) {
        const value = readLegacyJsonSetting<PersistedRuntimeSelectionPreferences>(
            settings,
            `ai.runtime_preferences.${runtimeId}`,
        );
        if (value) {
            preferences[runtimeId] = value;
        }
    }
    if (Object.keys(preferences).length > 0) {
        await store.saveNow(AI_PREFERENCES_KEY, preferences);
    }
}

async function migrateLegacyRuntimeCatalogs(
    settings: ReadonlyMap<string, string>,
    store: NativeJsonStore,
): Promise<void> {
    const catalogs = {
        ...(await store.load<Record<string, PersistedRuntimeCatalogSnapshot>>(
            AI_CATALOGS_KEY,
            {},
        )),
    };
    let changed = false;

    for (const runtimeId of AI_RUNTIME_IDS) {
        const legacyCatalog =
            readLegacyJsonSetting<PersistedRuntimeCatalogSnapshot>(
                settings,
                `ai.runtime_catalog.${runtimeId}`,
            );
        const normalizedLegacyCatalog = legacyCatalog
            ? toRuntimeCatalog(legacyCatalog)
            : null;
        if (!normalizedLegacyCatalog) {
            continue;
        }

        const existingCatalog = toRuntimeCatalog(catalogs[runtimeId]);
        catalogs[runtimeId] = existingCatalog
            ? mergeRuntimeCatalog(normalizedLegacyCatalog, existingCatalog)
            : normalizedLegacyCatalog;
        changed = true;
    }

    if (changed) {
        await store.saveNow(AI_CATALOGS_KEY, catalogs);
    }
}

async function migrateLegacySecrets(
    settings: ReadonlyMap<string, string>,
    store: NativeJsonStore,
    secretStore: SecretStoreGateway,
): Promise<void> {
    if ((await store.loadNullable<boolean>("legacy.secretsMigrated.v1")) === true) {
        return;
    }
    let ok = true;
    for (const key of KNOWN_SECRET_KEYS) {
        const value = deserializeLegacySecret(settings.get(key) ?? null);
        if (!value) {
            continue;
        }
        const parsed = parseSecretStorageKey(key);
        try {
            await secretStore.saveSecret(parsed.namespace, parsed.secretId, value);
        } catch (error) {
            ok = false;
            debugBenignError(`nativeAppData.migrateSecret.${key}`, error);
        }
    }
    if (ok) {
        await store.saveNow("legacy.secretsMigrated.v1", true);
    }
}

function deserializeLegacySecret(storedValue: string | null): string | null {
    if (!storedValue) {
        return null;
    }
    try {
        const stored = JSON.parse(storedValue) as {
            readonly scheme?: string;
            readonly value?: string;
        };
        switch (stored.scheme) {
            case "electron-safe-storage-v1":
                if (typeof stored.value !== "string") {
                    return null;
                }
                return safeStorage
                    .decryptString(Buffer.from(stored.value, "base64"))
                    .trim() || null;
            case "plain-text-v1":
                return stored.value?.trim() || null;
            default:
                return null;
        }
    } catch (error) {
        debugBenignError("nativeAppData.deserializeLegacySecret", error);
        return null;
    }
}

function tableExists(database: DatabaseSync, tableName: string): boolean {
    const row = database
        .prepare(
            `
            SELECT name
            FROM sqlite_master
            WHERE type = 'table' AND name = ?
            LIMIT 1
            `,
        )
        .get(tableName) as { readonly name?: string } | undefined;
    return row?.name === tableName;
}

function readLegacyStringSetting(
    settings: ReadonlyMap<string, string>,
    key: string,
): string | null {
    return settings.get(key)?.trim() || null;
}

function readLegacyBooleanSetting(
    settings: ReadonlyMap<string, string>,
    key: string,
): boolean | null {
    return parseLegacyBoolean(settings.get(key));
}

function readLegacyNumberSetting(
    settings: ReadonlyMap<string, string>,
    key: string,
): number | null {
    return parseFiniteNumber(settings.get(key));
}

function readLegacyJsonSetting<T>(
    settings: ReadonlyMap<string, string>,
    key: string,
): T | null {
    return parseLegacyJson<T | null>(settings.get(key) ?? null, null);
}

function parseLegacyBoolean(value: string | null | undefined): boolean | null {
    if (value === "1" || value === "true") {
        return true;
    }
    if (value === "0" || value === "false") {
        return false;
    }
    return null;
}

function parseFiniteNumber(value: string | null | undefined): number | null {
    if (value === null || value === undefined || value.trim() === "") {
        return null;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function parseLegacyJson<T>(value: string | null, fallback: T): T {
    if (!value) {
        return fallback;
    }
    try {
        return JSON.parse(value) as T;
    } catch (error) {
        debugBenignError("nativeAppData.parseLegacyJson", error);
        return fallback;
    }
}

function parseLegacyThemeMode(value: string | null | undefined): ThemeMode | null {
    if (value === "system" || value === "light" || value === "dark") {
        return value;
    }
    return null;
}

function parseLegacyThemePreset(
    value: string | null | undefined,
): ThemePreset | null {
    return THEME_PRESETS.includes(value as ThemePreset)
        ? (value as ThemePreset)
        : null;
}

function normalizeLegacyFontFamily(
    value: string | null | undefined,
): (typeof EDITOR_FONT_FAMILY_IDS)[number] | null {
    const normalized = value === "jetbrains-mono" ? "jetbrains" : value?.trim();
    return EDITOR_FONT_FAMILY_IDS.includes(
        normalized as (typeof EDITOR_FONT_FAMILY_IDS)[number],
    )
        ? (normalized as (typeof EDITOR_FONT_FAMILY_IDS)[number])
        : null;
}

export async function createNativeAppDataClient(
    options: NativeAppDataClientOptions,
): Promise<NativeAppDataClient> {
    const store = new NativeJsonStore(options.client);
    const secretStore = new NativeSecretStore(options.client);
    await migrateLegacyAppData({
        databaseFile: options.databaseFile,
        secretStore,
        store,
    });
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
        await store.load(AI_CATALOGS_KEY, {}),
        await store.load(AI_PROMPT_QUEUES_KEY, []),
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
        workspace: new NativeWorkspaceClient(store, persistence),
        close: () => store.flush(),
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

function createDefaultSettingsSnapshot(): CompleteSettingsSnapshot {
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
            toolActivityDefaultExpansion: "collapsed",
        },
        appearance: {
            agentsSidebarScale: AGENTS_SIDEBAR_SCALE_DEFAULT,
            boostCodeContrast: true,
            chromeTransparency: 45,
            fileTreeScale: FILE_TREE_SCALE_DEFAULT,
            stickyFoldersEnabled: true,
            themeMode: "system",
            themePreset: "default",
            transparencyEnabled: true,
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
        customAcpRuntimes: {
            runtimes: [],
            version: 1,
        },
        shellState: null,
        terminal: DEFAULT_APP_TERMINAL_SETTINGS,
    };
}

function normalizeSettingsSnapshot(snapshot: SettingsSnapshot): SettingsSnapshot {
    const defaults = createDefaultSettingsSnapshot();
    const persistedAiChat = snapshot.aiChat as
        | (Partial<AppAiChatSettings> & {
              readonly toolCardExpansionMode?: unknown;
          })
        | undefined;
    const aiChat = { ...(persistedAiChat ?? {}) };
    delete aiChat.toolCardExpansionMode;
    return {
        ai: snapshot.ai ?? defaults.ai,
        aiChat: {
            ...defaults.aiChat,
            ...aiChat,
            toolActivityDefaultExpansion:
                persistedAiChat?.toolActivityDefaultExpansion === "expanded"
                    ? "expanded"
                    : "collapsed",
        },
        appearance: {
            ...defaults.appearance,
            ...(snapshot.appearance ?? {}),
        },
        customAcpRuntimes: normalizeCustomAcpRuntimesSettings(
            snapshot.customAcpRuntimes,
            (message) =>
                debugBenignError(
                    "nativeAppData.customAcpRuntimeSettings",
                    new Error(message),
                ),
        ),
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
    snapshot: PersistedRuntimeCatalogSnapshot | null | undefined,
): PersistedRuntimeCatalogSnapshot | null {
    if (!snapshot) {
        return null;
    }
    if (
        snapshot.availableCommands.length === 0 &&
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

function mergeRuntimeCatalog(
    current: PersistedRuntimeCatalogSnapshot | null,
    incoming: PersistedRuntimeCatalogSnapshot,
): PersistedRuntimeCatalogSnapshot {
    return {
        availableCommands:
            incoming.availableCommands.length > 0
                ? incoming.availableCommands
                : (current?.availableCommands ?? []),
        configOptions:
            incoming.configOptions.length > 0
                ? incoming.configOptions
                : (current?.configOptions ?? []),
        modeId: incoming.modeId ?? current?.modeId ?? null,
        modes:
            incoming.modes.length > 0 ? incoming.modes : (current?.modes ?? []),
        modelId: incoming.modelId ?? current?.modelId ?? null,
        models:
            incoming.models.length > 0
                ? incoming.models
                : (current?.models ?? []),
    };
}

function applyRuntimeCatalogPatch(
    current: PersistedRuntimeCatalogSnapshot,
    patch: Partial<PersistedRuntimeCatalogSnapshot>,
): PersistedRuntimeCatalogSnapshot {
    return {
        availableCommands:
            patch.availableCommands ?? current.availableCommands,
        configOptions: patch.configOptions ?? current.configOptions,
        modeId: "modeId" in patch ? (patch.modeId ?? null) : current.modeId,
        modes: patch.modes ?? current.modes,
        modelId:
            "modelId" in patch ? (patch.modelId ?? null) : current.modelId,
        models: patch.models ?? current.models,
    };
}

function createEmptyRuntimeCatalog(): PersistedRuntimeCatalogSnapshot {
    return {
        availableCommands: [],
        configOptions: [],
        modeId: null,
        modes: [],
        modelId: null,
        models: [],
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
