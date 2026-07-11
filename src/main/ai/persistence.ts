import type {
    AiHistorySessionSummary,
    AiPromptQueueSnapshot,
    AiSessionSnapshot,
    AiSessionTranscriptPage,
    GetAiSessionTranscriptPageInput,
    ListAiSessionHistoryInput,
} from "@shared/ipc";

type Awaitable<T> = T | Promise<T>;

export interface PersistedAiSessionRuntimeMapping {
    readonly appSessionId: string;
    readonly parentAppSessionId: string | null;
    readonly parentRuntimeSessionId: string | null;
    readonly runtimeSessionId: string;
}

export interface PersistedRuntimeSelectionPreferences {
    readonly configOptions: Record<string, boolean | string>;
    readonly modeId: string | null;
    readonly modelId: string | null;
}

export type PersistedRuntimeCatalogSnapshot = Pick<
    AiSessionSnapshot,
    | "availableCommands"
    | "configOptions"
    | "modeId"
    | "modes"
    | "modelId"
    | "models"
>;

export interface AiPersistenceGateway {
    deleteSession(sessionId: string): Awaitable<void>;
    listSessionHistory(
        input: ListAiSessionHistoryInput,
    ): Awaitable<readonly AiHistorySessionSummary[]>;
    loadSessionSnapshot(sessionId: string): Awaitable<AiSessionSnapshot | null>;
    loadSessionTranscriptPage(
        input: GetAiSessionTranscriptPageInput,
    ): Awaitable<AiSessionTranscriptPage | null>;
    loadLatestRuntimeCatalog(
        runtimeId: AiSessionSnapshot["runtimeId"],
    ): PersistedRuntimeCatalogSnapshot | null;
    loadPromptQueueSnapshots?(): readonly AiPromptQueueSnapshot[];
    loadRuntimeSelectionPreferences(
        runtimeId: AiSessionSnapshot["runtimeId"],
    ): PersistedRuntimeSelectionPreferences;
    listSessionRuntimeMappingsForParent?(
        parentSessionId: string,
    ): Awaitable<readonly PersistedAiSessionRuntimeMapping[]>;
    resolveAppSessionIdByRuntimeSessionId?(
        runtimeSessionId: string,
    ): Awaitable<string | null>;
    saveRuntimeSelectionPreferences(
        runtimeId: AiSessionSnapshot["runtimeId"],
        patch: Partial<PersistedRuntimeSelectionPreferences>,
    ): void;
    saveRuntimeSelectionPreferenceOption(
        runtimeId: AiSessionSnapshot["runtimeId"],
        optionId: string,
        value: boolean | string,
    ): void;
    saveRuntimeModePreference(
        runtimeId: AiSessionSnapshot["runtimeId"],
        modeId: string,
    ): void;
    saveRuntimeModelPreference(
        runtimeId: AiSessionSnapshot["runtimeId"],
        modelId: string,
    ): void;
    saveRuntimeCatalogPatch?(
        runtimeId: AiSessionSnapshot["runtimeId"],
        patch: Partial<PersistedRuntimeCatalogSnapshot>,
    ): void;
    savePromptQueueSnapshots?(
        snapshots: readonly AiPromptQueueSnapshot[],
    ): void;
    setSessionPinned(sessionId: string, pinned: boolean): Awaitable<void>;
    saveSessionSnapshot(snapshot: AiSessionSnapshot, draft?: string): void;
}

export function createEmptyAiSessionSnapshot(options: {
    readonly parentSessionId?: string | null;
    readonly projectId: string | null;
    readonly runtimeId: AiSessionSnapshot["runtimeId"];
    readonly runtimeSessionId?: string | null;
    readonly sessionId: string;
    readonly status?: AiSessionSnapshot["status"];
    readonly title: string;
    readonly updatedAt?: string;
    readonly worktreeId?: string | null;
}): AiSessionSnapshot {
    const now = options.updatedAt ?? new Date().toISOString();

    return {
        activeTurnStartedAt: null,
        availableCommands: [],
        closedAt: null,
        configOptions: [],
        lastError: null,
        manualTitle: null,
        messages: [],
        modeId: null,
        modes: [],
        modelId: null,
        models: [],
        pendingPermission: null,
        pendingUserInput: null,
        plan: null,
        parentSessionId: options.parentSessionId ?? null,
        projectId: options.projectId,
        runtimeId: options.runtimeId,
        runtimeSessionId: options.runtimeSessionId ?? null,
        reviewActionLog: null,
        sessionId: options.sessionId,
        status: options.status ?? "idle",
        title: options.title,
        tokenUsage: null,
        toolActivity: [],
        trackedFiles: [],
        updatedAt: now,
        worktreeId: options.worktreeId ?? null,
    };
}
