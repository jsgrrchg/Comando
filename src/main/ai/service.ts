import path from "node:path";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

import {
    ClientSideConnection,
    PROTOCOL_VERSION,
    ndJsonStream,
    type Client,
} from "@agentclientprotocol/sdk";
import type {
    AiHistorySessionSummary,
    AiPermissionResponseInput,
    AiPromptResult,
    PrepareAiSessionInput,
    AiRuntimeAuthLaunchInput,
    AiRuntimeAuthDisconnectInput,
    AiRuntimeAuthLogoutInput,
    AiRuntimeId,
    AiRuntimeStatus,
    AiSessionDomainEvent,
    AiSessionConfigOptionMutationInput,
    AiSessionModeMutationInput,
    AiSessionModelMutationInput,
    AiSessionPinnedMutationInput,
    AiSessionUpdate,
    AiSessionRenameMutationInput,
    AiSessionSnapshot,
    AiSessionTranscriptPage,
    AiTrackedFileHunkMutationInput,
    AiTrackedFileMutationInput,
    AiUserInputResponseInput,
    ClaudeRuntimeSettingsInput,
    CodexRuntimeSettingsInput,
    CodexRuntimeSettings,
    GrokRuntimeSettings,
    GrokRuntimeSettingsInput,
    GetAiSessionTranscriptPageInput,
    KiloRuntimeSettingsInput,
    ListAiSessionHistoryInput,
    OpenCodeRuntimeSettingsInput,
    SecretValuePatch,
    SendAiPromptInput,
} from "@shared/ipc";
import {
    computeDiffHunks,
    resolveTrackedFileHunks,
    upsertTrackedFile,
} from "@shared/ai-tracked-file";

import type { ProjectService } from "@main/projects/service";
import type { SettingsGateway } from "@main/settings/service";
import type {
    SecretRecordPatch,
    SecretStoreGateway,
} from "@main/ai/secret-store";
import { debugBenignError } from "@main/observability/logging";
import { prepareCommandForSpawn } from "@main/shell/command-launch";

import {
    createEmptyAiSessionSnapshot,
    type AiPersistenceGateway,
} from "./persistence";
import { createAiEnvironmentDiagnostics } from "./environment-diagnostics";
import { listOpenFileBuffers, readOpenFileBuffer } from "./openFileBuffers";
import {
    type AiWorkerGateway,
    type AiWorkerRefreshProjectScopesRpcInput,
    type AiWorkerReviewMutationResult,
    type AiWorkerReviewSessionContext,
    type AiWorkerSessionLaunchInput,
    type AiSchedulerConfig,
    type AiSessionFreezeReason,
    type AiSessionFreezeSkippedReason,
    type AiSessionRetentionConfig,
    type AiServiceOptions,
    type ResolvedAcpRuntime,
    type SessionDescriptor,
} from "./contracts";
import {
    buildAiSessionUpdate,
    getModeConfigOption,
    getModelConfigOption,
    getRecentStderrText,
    getRuntimeDisplayName,
    isPathInsideRoot,
    isSamePath,
    normalizeAdditionalRoots,
    resolveSessionScopedPath,
    setConfigOptionOnSnapshot,
    setModeOnSnapshot,
    setModelOnSnapshot,
    setTitleOnSnapshot,
} from "./session-core";
import {
    diffToAiFileDiff,
    mapToolCallUpdate,
    normalizeTrackedDiffPath,
    parseCompleteNumberedFileOutput,
    readTextIfExists,
    reconcilePendingTrackedFiles,
    resolveDiffToFullTexts,
    shouldSuppressToolActivityUpdate,
} from "./review-core";
import { buildRuntimeSpawnEnv } from "./runtime-env";
import { resolveCodexRuntime } from "./resolver/runtime-resolver";
import {
    applyCodexAuthEnv,
    buildCodexSecretPatches,
    getCodexAuthMethods,
    getCodexRuntimeStatus,
    isCodexAuthenticationError,
    type CodexSecretBundle,
    loadCodexSecretBundle,
} from "./codex/setup";
import {
    applyClaudeAuthEnv,
    buildClaudeSecretPatches,
    getClaudeRuntimeStatus,
    isClaudeAuthenticationError,
    launchClaudeLogin,
    loadClaudeSecretBundle,
    markClaudeAuthInvalidated,
    resolveClaudeRuntime,
} from "./claude/setup";
import {
    applyKiloAuthEnv,
    buildKiloSecretPatches,
    getKiloRuntimeStatus,
    isKiloAuthenticationError,
    launchKiloLogin,
    markKiloAuthInvalidated,
    resolveKiloRuntime,
} from "./kilo/setup";
import {
    applyGrokAuthEnv,
    buildGrokSecretPatches,
    getGrokRuntimeStatus,
    isGrokAuthenticationError,
    isGrokExternalCredentialReady,
    launchGrokLogin,
    loadGrokSecretBundle,
    markGrokAuthInvalidated,
    probeGrokCachedTokenAuth,
    resolveGrokRuntime,
} from "./grok/setup";
import {
    applyOpenCodeAuthEnv,
    getOpenCodeRuntimeStatus,
    isOpenCodeEnvironmentCredentialReady,
    isOpenCodeAuthenticationError,
    launchOpenCodeLogin,
    markOpenCodeAuthInvalidated,
    resolveOpenCodeRuntime,
} from "./opencode/setup";

const GEMINI_ACP_REMOVED_MESSAGE =
    "Gemini ACP support has been removed. Use Kilo or OpenCode with a Gemini API key instead.";

function createRemovedGeminiRuntimeSettings() {
    return {
        authInvalidatedAtMs: null,
        authMethod: null,
        binaryPath: null,
        googleCloudLocation: null,
        googleCloudProject: null,
        hasGeminiApiKey: false,
        hasGoogleApiKey: false,
    };
}

function createRemovedGeminiRuntimeStatus(): AiRuntimeStatus {
    return {
        authMethod: null,
        authMethods: [],
        authReady: false,
        checkedAt: new Date().toISOString(),
        command: null,
        hasCustomBinaryPath: false,
        hasGatewayConfig: false,
        hasGatewayUrl: false,
        message: GEMINI_ACP_REMOVED_MESSAGE,
        onboardingRequired: true,
        runtimeId: "gemini",
        source: null,
        state: "error",
    };
}

function toWebByteWritable(stream: Writable): WritableStream<Uint8Array> {
    return Writable.toWeb(stream) as WritableStream<Uint8Array>;
}

function toWebByteReadable(stream: Readable): ReadableStream<Uint8Array> {
    return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
}

type LiveSessionContext = {
    readonly additionalRoots: readonly string[];
    ownerWindowId: string;
    readonly parentSessionId: string | null;
    readonly projectId: string | null;
    readonly runtimeId: AiRuntimeId;
    readonly sessionId: string;
    readonly worktreeId: string | null;
};

const DEFAULT_AI_SCHEDULER_CONFIG: AiSchedulerConfig = {
    maxColdStartsGlobal: 3,
    maxColdStartsPerRuntime: 1,
};

const DEFAULT_AI_SESSION_RETENTION_CONFIG: AiSessionRetentionConfig = {
    idleTtlMs: 15 * 60 * 1000,
    maxHotSessionsPerWindow: 6,
};

type AiSchedulerPriority = 0 | 1 | 2 | 3;

interface AiSchedulerDiagnostics {
    readonly activeColdStarts: number;
    readonly activeColdStartsByRuntime: Readonly<Record<string, number>>;
    readonly maxColdStartsGlobal: number;
    readonly maxColdStartsPerRuntime: number;
    readonly queued: number;
}

interface AiSessionRetentionDiagnostics {
    readonly closed: readonly AiSessionRetentionCloseRecord[];
    readonly hotSessions: readonly AiSessionRetentionHotSession[];
    readonly idleTtlMs: number;
    readonly maxHotSessionsPerWindow: number;
    readonly skipped: readonly AiSessionRetentionSkippedRecord[];
}

interface AiSessionRetentionHotSession {
    readonly lastUsedAtMs: number;
    readonly ownerWindowId: string;
    readonly runtimeId: AiRuntimeId;
    readonly sessionId: string;
}

interface AiSessionRetentionCloseRecord {
    readonly closedAtMs: number;
    readonly reason: AiSessionFreezeReason;
    readonly sessionId: string;
}

interface AiSessionRetentionSkippedRecord {
    readonly reason: AiSessionFreezeReason;
    readonly sessionId: string;
    readonly skippedAtMs: number;
    readonly skippedReason: AiSessionFreezeSkippedReason;
}

interface AiSchedulerTask<T> {
    readonly coldStart: boolean;
    readonly createdOrder: number;
    readonly priority: AiSchedulerPriority;
    readonly reject: (reason: unknown) => void;
    readonly resolve: (value: T | PromiseLike<T>) => void;
    readonly run: () => Promise<T>;
    readonly runtimeId: AiRuntimeId | null;
}

class AiWorkScheduler {
    readonly #activeColdStartsByRuntime = new Map<AiRuntimeId, number>();
    #activeColdStarts = 0;
    readonly #config: AiSchedulerConfig;
    #nextOrder = 0;
    readonly #queue: AiSchedulerTask<unknown>[] = [];

    constructor(config?: Partial<AiSchedulerConfig>) {
        this.#config = {
            maxColdStartsGlobal:
                config?.maxColdStartsGlobal ??
                DEFAULT_AI_SCHEDULER_CONFIG.maxColdStartsGlobal,
            maxColdStartsPerRuntime:
                config?.maxColdStartsPerRuntime ??
                DEFAULT_AI_SCHEDULER_CONFIG.maxColdStartsPerRuntime,
        };
    }

    getDiagnostics(): AiSchedulerDiagnostics {
        return {
            activeColdStarts: this.#activeColdStarts,
            activeColdStartsByRuntime: Object.fromEntries(
                this.#activeColdStartsByRuntime,
            ),
            maxColdStartsGlobal: this.#config.maxColdStartsGlobal,
            maxColdStartsPerRuntime: this.#config.maxColdStartsPerRuntime,
            queued: this.#queue.length,
        };
    }

    schedule<T>(
        input: {
            readonly coldStart: boolean;
            readonly priority: AiSchedulerPriority;
            readonly runtimeId: AiRuntimeId | null;
        },
        run: () => Promise<T>,
    ): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            this.#queue.push({
                coldStart: input.coldStart,
                createdOrder: this.#nextOrder++,
                priority: input.priority,
                reject,
                resolve: (value) => {
                    resolve(value as T);
                },
                run: async () => await run(),
                runtimeId: input.runtimeId,
            });
            this.#pump();
        });
    }

    #pump(): void {
        for (;;) {
            const taskIndex = this.#findNextRunnableTaskIndex();
            if (taskIndex < 0) {
                return;
            }

            const [task] = this.#queue.splice(taskIndex, 1);
            this.#startTask(task);
        }
    }

    #findNextRunnableTaskIndex(): number {
        let bestIndex = -1;
        let bestTask: AiSchedulerTask<unknown> | null = null;

        for (const [index, task] of this.#queue.entries()) {
            if (!this.#canStart(task)) {
                continue;
            }

            if (
                !bestTask ||
                task.priority < bestTask.priority ||
                (task.priority === bestTask.priority &&
                    task.createdOrder < bestTask.createdOrder)
            ) {
                bestIndex = index;
                bestTask = task;
            }
        }

        return bestIndex;
    }

    #canStart(task: AiSchedulerTask<unknown>): boolean {
        if (!task.coldStart) {
            return true;
        }

        if (this.#activeColdStarts >= this.#config.maxColdStartsGlobal) {
            return false;
        }

        if (!task.runtimeId) {
            return true;
        }

        return (
            (this.#activeColdStartsByRuntime.get(task.runtimeId) ?? 0) <
            this.#config.maxColdStartsPerRuntime
        );
    }

    #startTask(task: AiSchedulerTask<unknown>): void {
        if (task.coldStart) {
            this.#activeColdStarts += 1;
            if (task.runtimeId) {
                this.#activeColdStartsByRuntime.set(
                    task.runtimeId,
                    (this.#activeColdStartsByRuntime.get(task.runtimeId) ?? 0) +
                        1,
                );
            }
        }

        void task.run().then(task.resolve, task.reject).finally(() => {
            if (task.coldStart) {
                this.#activeColdStarts -= 1;
                if (task.runtimeId) {
                    const nextCount =
                        (this.#activeColdStartsByRuntime.get(task.runtimeId) ??
                            1) - 1;
                    if (nextCount <= 0) {
                        this.#activeColdStartsByRuntime.delete(task.runtimeId);
                    } else {
                        this.#activeColdStartsByRuntime.set(
                            task.runtimeId,
                            nextCount,
                        );
                    }
                }
            }

            this.#pump();
        });
    }
}

export class AiService {
    #aiWorker: AiWorkerGateway | null;
    readonly #deletedSessionIds = new Set<string>();
    readonly #freezingSessionIds = new Set<string>();
    readonly #lastRetentionCloseRecords: AiSessionRetentionCloseRecord[] = [];
    readonly #lastRetentionSkippedRecords: AiSessionRetentionSkippedRecord[] = [];
    readonly #liveSessionContexts = new Map<string, LiveSessionContext>();
    readonly #liveSnapshots = new Map<string, AiSessionSnapshot>();
    readonly #liveSessionTouches = new Map<
        string,
        {
            readonly lastUsedAtMs: number;
            readonly order: number;
        }
    >();
    readonly #onRuntimeStatus: (status: AiRuntimeStatus) => void;
    readonly #onSessionEvent: (
        ownerWindowId: string,
        event: AiSessionDomainEvent,
    ) => void;
    readonly #onSessionSnapshot: (
        ownerWindowId: string,
        update: AiSessionUpdate,
    ) => void;
    readonly #persistence: AiPersistenceGateway;
    readonly #projectService: ProjectService;
    readonly #retentionConfig: AiSessionRetentionConfig;
    readonly #scheduler: AiWorkScheduler;
    readonly #secretStore: SecretStoreGateway;
    readonly #settingsService: SettingsGateway;
    #nextLiveSessionTouchOrder = 0;
    #retentionSweep: Promise<void> | null = null;
    #retentionTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(options: AiServiceOptions) {
        this.#aiWorker = options.aiWorker ?? null;
        this.#onRuntimeStatus = options.onRuntimeStatus;
        this.#onSessionEvent = options.onSessionEvent ?? (() => undefined);
        this.#onSessionSnapshot = options.onSessionSnapshot;
        this.#persistence = options.persistence;
        this.#projectService = options.projectService;
        this.#retentionConfig = {
            idleTtlMs:
                options.aiSessionRetention?.idleTtlMs ??
                DEFAULT_AI_SESSION_RETENTION_CONFIG.idleTtlMs,
            maxHotSessionsPerWindow:
                options.aiSessionRetention?.maxHotSessionsPerWindow ??
                DEFAULT_AI_SESSION_RETENTION_CONFIG.maxHotSessionsPerWindow,
        };
        this.#scheduler = new AiWorkScheduler(options.aiScheduler);
        this.#secretStore = options.secretStore;
        this.#settingsService = options.settingsService;
    }

    setWorker(worker: AiWorkerGateway | null): void {
        this.#aiWorker = worker;
    }

    close(): void {
        this.#clearSessionRetentionTimer();
        this.#liveSessionContexts.clear();
        this.#liveSnapshots.clear();
        this.#liveSessionTouches.clear();
    }

    getSchedulerDiagnostics(): AiSchedulerDiagnostics {
        return this.#scheduler.getDiagnostics();
    }

    getSessionRetentionDiagnostics(): AiSessionRetentionDiagnostics {
        return {
            closed: [...this.#lastRetentionCloseRecords],
            hotSessions: [...this.#liveSessionContexts.values()]
                .map((context) => {
                    const touch = this.#liveSessionTouches.get(
                        context.sessionId,
                    );
                    return touch
                        ? {
                              lastUsedAtMs: touch.lastUsedAtMs,
                              ownerWindowId: context.ownerWindowId,
                              runtimeId: context.runtimeId,
                              sessionId: context.sessionId,
                          }
                        : null;
                })
                .filter(
                    (
                        session,
                    ): session is AiSessionRetentionHotSession =>
                        session !== null,
                ),
            idleTtlMs: this.#retentionConfig.idleTtlMs,
            maxHotSessionsPerWindow:
                this.#retentionConfig.maxHotSessionsPerWindow,
            skipped: [...this.#lastRetentionSkippedRecords],
        };
    }

    handleWorkerRuntimeStatus(status: AiRuntimeStatus): void {
        this.#onRuntimeStatus(status);
    }

    handleWorkerSessionClosed(payload: {
        readonly ownerWindowId: string;
        readonly sessionId: string;
    }): void {
        this.#clearLiveSession(payload.sessionId);
    }

    handleWorkerSessionSnapshot(
        ownerWindowId: string,
        update: AiSessionUpdate,
    ): void {
        const sessionId =
            update.kind === "snapshot"
                ? update.snapshot.sessionId
                : update.patch.sessionId;
        if (this.#deletedSessionIds.has(sessionId)) {
            return;
        }

        const snapshot = this.#resolveSnapshotFromWorkerUpdate(update);
        if (!snapshot) {
            return;
        }

        this.#cacheLiveSessionSnapshot(snapshot, ownerWindowId);
        this.#persistence.saveSessionSnapshot(snapshot);
        if (snapshot.lastError) {
            this.#invalidateRuntimeAuthIfNeeded(snapshot.runtimeId, snapshot.lastError);
        }
        this.#onSessionSnapshot(ownerWindowId, update);
    }

    handleWorkerSessionEvent(
        ownerWindowId: string,
        event: AiSessionDomainEvent,
    ): void {
        this.#onSessionEvent(ownerWindowId, event);
    }

    async handleWorkerRestarted(): Promise<void> {
        const worker = this.#requireAiWorker();
        await Promise.all(
            listOpenFileBuffers().map(async (buffer) => {
                await worker.notifyFileBuffer(buffer);
            }),
        );
        const relaunches = this.#listRelaunchableLiveSessionContexts().map(
            async (context) => {
                const snapshot =
                    this.#liveSnapshots.get(context.sessionId) ??
                    (await this.#persistence.loadSessionSnapshot(
                        context.sessionId,
                    ));
                if (!snapshot) {
                    return;
                }

                const input = {
                    projectId: context.projectId,
                    runtimeId: context.runtimeId,
                    sessionId: context.sessionId,
                    title: snapshot.title,
                    worktreeId: context.worktreeId,
                } satisfies PrepareAiSessionInput;
                const launch = await this.#buildWorkerSessionLaunchInput(
                    {
                        additionalRoots: context.additionalRoots,
                        projectId: context.projectId,
                        runtimeId: context.runtimeId,
                        sessionId: context.sessionId,
                        title: snapshot.title,
                        worktreeId: context.worktreeId,
                    },
                    context.ownerWindowId,
                    snapshot,
                );
                const relaunchedSnapshot =
                    await this.#scheduleWorkerSessionStartup(
                        launch,
                        3,
                        () =>
                            worker.prepareSession({
                                input,
                                launch,
                            }),
                        { forceColdStart: true },
                    );
                this.#acceptPreparedLiveSnapshot(
                    relaunchedSnapshot,
                    context.ownerWindowId,
                );
                void this.#enforceSessionRetention();
            },
        );

        await Promise.allSettled(relaunches);
    }

    async getRuntimeStatus(runtimeId: AiRuntimeId): Promise<AiRuntimeStatus> {
        const resolvedStatus = this.#withPersistedRuntimeCatalog(
            this.#resolveRuntimeStatus(runtimeId),
        );
        const status =
            runtimeId === "grok"
                ? await this.#resolveGrokRuntimeStatusWithProbe(resolvedStatus)
                : resolvedStatus;
        this.#onRuntimeStatus(status);
        return status;
    }

    getEnvironmentDiagnostics() {
        return createAiEnvironmentDiagnostics({
            secretStore: this.#secretStore,
            settings: {
                claude: this.#settingsService.loadClaudeRuntimeSettings(),
                codex: this.#settingsService.loadCodexRuntimeSettings(),
                gemini: createRemovedGeminiRuntimeSettings(),
                grok: this.#settingsService.loadGrokRuntimeSettings(),
                kilo: this.#settingsService.loadKiloRuntimeSettings(),
                opencode: this.#settingsService.loadOpenCodeRuntimeSettings(),
            },
        });
    }

    async saveCodexRuntimeSettings(
        settings: CodexRuntimeSettingsInput,
    ): Promise<AiRuntimeStatus> {
        const currentSettings =
            this.#settingsService.loadCodexRuntimeSettings();
        const nextSecrets = resolveCodexSecretBundle(
            loadCodexSecretBundle(this.#secretStore),
            settings,
        );
        const secretPatch = buildCodexSecretPatches(this.#secretStore, {
            codexApiKey: nextSecrets.codexApiKey,
            openaiApiKey: nextSecrets.openaiApiKey,
        });
        const nextSettings = {
            ...currentSettings,
            authMethod: settings.authMethod,
            binaryPath: normalizeOptionalText(settings.binaryPath),
            hasCodexApiKey: secretPatch.flags.hasCodexApiKey,
            hasOpenAiApiKey: secretPatch.flags.hasOpenAiApiKey,
        } satisfies CodexRuntimeSettings;
        await this.#saveCodexAuthSettings(nextSettings, secretPatch.patches);
        const status = this.#withPersistedRuntimeCatalog(
            getCodexRuntimeStatus(nextSettings, nextSecrets),
        );
        this.#onRuntimeStatus(status);
        return status;
    }

    async saveClaudeRuntimeSettings(
        settings: ClaudeRuntimeSettingsInput,
    ): Promise<AiRuntimeStatus> {
        const currentSettings =
            this.#settingsService.loadClaudeRuntimeSettings();
        const currentSecrets = loadClaudeSecretBundle(this.#secretStore);
        const anthropicApiKey = applySecretValuePatch(
            currentSecrets.anthropicApiKey,
            settings.anthropicApiKey,
        );
        const gatewayAuthToken = applySecretValuePatch(
            currentSecrets.anthropicAuthToken,
            settings.gatewayAuthToken,
        );
        const gatewayCustomHeaders = applySecretValuePatch(
            currentSecrets.anthropicCustomHeaders,
            settings.gatewayCustomHeaders,
        );
        const secretPatch = buildClaudeSecretPatches(this.#secretStore, {
            anthropicApiKey,
            gatewayAuthToken,
            gatewayCustomHeaders,
        });
        const nextSettings = {
            authInvalidatedAtMs: currentSettings.authInvalidatedAtMs,
            authMethod: settings.authMethod,
            bedrockGatewayBaseUrl: normalizeOptionalText(
                settings.bedrockGatewayBaseUrl,
            ),
            binaryPath: normalizeOptionalText(settings.binaryPath),
            gatewayBaseUrl: normalizeOptionalText(settings.gatewayBaseUrl),
            hasAnthropicApiKey: secretPatch.flags.hasAnthropicApiKey,
            hasGatewayAuthToken: secretPatch.flags.hasGatewayAuthToken,
            hasGatewayCustomHeaders: secretPatch.flags.hasGatewayCustomHeaders,
        };

        await this.#saveClaudeAuthSettings(nextSettings, secretPatch.patches);
        const status = this.#withPersistedRuntimeCatalog(
            getClaudeRuntimeStatus(nextSettings, this.#secretStore),
        );
        this.#onRuntimeStatus(status);
        return status;
    }

    async saveGrokRuntimeSettings(
        settings: GrokRuntimeSettingsInput,
    ): Promise<AiRuntimeStatus> {
        const currentSettings = this.#settingsService.loadGrokRuntimeSettings();
        const xaiApiKey = applySecretValuePatch(
            loadGrokSecretBundle(this.#secretStore).xaiApiKey,
            settings.xaiApiKey,
        );
        const secretPatch = buildGrokSecretPatches(this.#secretStore, {
            xaiApiKey,
        });
        const nextSettings = {
            authInvalidatedAtMs: currentSettings.authInvalidatedAtMs,
            authMethod: settings.authMethod,
            binaryPath: normalizeOptionalText(settings.binaryPath),
            hasXaiApiKey: secretPatch.flags.hasXaiApiKey,
        } satisfies GrokRuntimeSettings;
        const selectedGrokLogin = settings.authMethod === "grok-login";
        const shouldTrustGrokLogin =
            selectedGrokLogin && isGrokExternalCredentialReady(nextSettings);
        const persistedSettings = {
            ...nextSettings,
            authInvalidatedAtMs:
                shouldTrustGrokLogin
                    ? null
                    : selectedGrokLogin
                      ? Date.now()
                    : nextSettings.authInvalidatedAtMs,
        } satisfies GrokRuntimeSettings;

        await this.#saveGrokAuthSettings(
            persistedSettings,
            secretPatch.patches,
        );
        const status = this.#withPersistedRuntimeCatalog(
            getGrokRuntimeStatus(persistedSettings, this.#secretStore),
        );
        this.#onRuntimeStatus(status);
        return status;
    }

    async saveKiloRuntimeSettings(
        settings: KiloRuntimeSettingsInput,
    ): Promise<AiRuntimeStatus> {
        const currentSettings = this.#settingsService.loadKiloRuntimeSettings();
        const kiloApiKey = applySecretValuePatch(
            this.#secretStore.loadSecret("ai.kilo", "kilo_api_key"),
            settings.kiloApiKey,
        );
        const secretPatch = buildKiloSecretPatches(this.#secretStore, {
            kiloApiKey,
        });
        const nextSettings = {
            authInvalidatedAtMs: currentSettings.authInvalidatedAtMs,
            authMethod: settings.authMethod,
            binaryPath: normalizeOptionalText(settings.binaryPath),
            hasKiloApiKey: secretPatch.flags.hasKiloApiKey,
        };

        await this.#saveKiloAuthSettings(nextSettings, secretPatch.patches);
        const status = this.#withPersistedRuntimeCatalog(
            getKiloRuntimeStatus(nextSettings, this.#secretStore),
        );
        this.#onRuntimeStatus(status);
        return status;
    }

    async saveOpenCodeRuntimeSettings(
        settings: OpenCodeRuntimeSettingsInput,
    ): Promise<AiRuntimeStatus> {
        const currentSettings =
            this.#settingsService.loadOpenCodeRuntimeSettings();
        const binaryPath = normalizeOptionalText(settings.binaryPath);
        const settingsChanged =
            currentSettings.authMethod !== settings.authMethod ||
            normalizeOptionalText(currentSettings.binaryPath) !== binaryPath;
        const shouldClearInvalidation =
            settings.authMethod === "opencode-login" &&
            (currentSettings.authInvalidatedAtMs === null ||
                settingsChanged ||
                isOpenCodeEnvironmentCredentialReady(process.env));
        const nextSettings = {
            authInvalidatedAtMs:
                shouldClearInvalidation
                    ? null
                    : currentSettings.authInvalidatedAtMs,
            authMethod: settings.authMethod,
            binaryPath,
        };

        await this.#saveOpenCodeAuthSettings(nextSettings);
        const status = this.#withPersistedRuntimeCatalog(
            getOpenCodeRuntimeStatus(nextSettings, this.#secretStore),
        );
        this.#onRuntimeStatus(status);
        return status;
    }

    verifyCodexRuntimeSettings(
        settings: CodexRuntimeSettingsInput,
    ): AiRuntimeStatus {
        const currentSettings =
            this.#settingsService.loadCodexRuntimeSettings();
        const nextSecrets = resolveCodexSecretBundle(
            loadCodexSecretBundle(this.#secretStore),
            settings,
        );
        const nextSettings = {
            ...currentSettings,
            authMethod: settings.authMethod,
            binaryPath: normalizeOptionalText(settings.binaryPath),
            hasCodexApiKey: Boolean(nextSecrets.codexApiKey),
            hasOpenAiApiKey: Boolean(nextSecrets.openaiApiKey),
        } satisfies CodexRuntimeSettings;
        const status = this.#withPersistedRuntimeCatalog(
            getCodexRuntimeStatus(nextSettings, nextSecrets),
        );
        this.#onRuntimeStatus(status);
        return status;
    }

    async getSessionSnapshot(
        sessionId: string,
    ): Promise<AiSessionSnapshot | null> {
        const liveSnapshot = this.#liveSnapshots.get(sessionId);
        if (liveSnapshot) {
            return liveSnapshot;
        }

        const persistedSnapshot =
            await this.#persistence.loadSessionSnapshot(sessionId);
        return persistedSnapshot
            ? await this.#reconcilePersistedTrackedFiles(persistedSnapshot)
            : null;
    }

    async listSessionHistory(
        input: ListAiSessionHistoryInput,
    ): Promise<readonly AiHistorySessionSummary[]> {
        return await this.#persistence.listSessionHistory(input);
    }

    async setSessionPinned(
        input: AiSessionPinnedMutationInput,
    ): Promise<void> {
        await this.#persistence.setSessionPinned(
            input.sessionId,
            input.pinned,
        );
    }

    async getSessionTranscriptPage(
        input: GetAiSessionTranscriptPageInput,
    ): Promise<AiSessionTranscriptPage> {
        const page = await this.#persistence.loadSessionTranscriptPage(input);
        if (!page) {
            throw new Error("The session could not be found.");
        }

        return page;
    }

    async prepareSession(
        input: PrepareAiSessionInput,
        ownerWindowId: string,
    ): Promise<AiSessionSnapshot> {
        const worker = this.#requireAiWorker();
        const launch = await this.#buildWorkerSessionLaunchInput(
            input,
            ownerWindowId,
        );
        this.#rememberLiveSessionContext(
            input,
            ownerWindowId,
            launch.additionalRoots,
            launch.persistedSnapshot.parentSessionId ?? null,
        );
        try {
            const snapshot = await this.#scheduleWorkerSessionStartup(
                launch,
                1,
                async () => {
                    this.#assertScheduledSessionContextActive(
                        input.sessionId,
                        ownerWindowId,
                        input.runtimeId,
                    );
                    return await worker.prepareSession({
                        input,
                        launch,
                    });
                },
            );
            this.#acceptPreparedLiveSnapshot(snapshot, ownerWindowId);
            void this.#enforceSessionRetention();
            return snapshot;
        } catch (error) {
            this.#discardPreparedSessionContextOnFailure(
                input.sessionId,
                ownerWindowId,
                input.runtimeId,
            );
            throw error;
        }
    }

    async refreshProjectScopes(projectId: string): Promise<void> {
        const worker = this.#requireAiWorker();
        const sessions = await this.#buildWorkerScopeRefreshInputs(projectId);
        if (sessions.length === 0) {
            return;
        }

        await this.#scheduler.schedule(
            {
                coldStart: true,
                priority: 3,
                runtimeId: null,
            },
            async () => {
                await worker.refreshProjectScopes({
                    projectId,
                    sessions,
                } satisfies AiWorkerRefreshProjectScopesRpcInput);
            },
        );
    }

    async sendPrompt(
        input: SendAiPromptInput,
        ownerWindowId: string,
    ): Promise<AiPromptResult> {
        const worker = this.#requireAiWorker();
        const launch = await this.#buildWorkerSessionLaunchInput(
            input,
            ownerWindowId,
        );
        if (
            launch.persistedSnapshot.parentSessionId &&
            launch.persistedSnapshot.closedAt
        ) {
            throw new Error(
                "This subagent was closed by its parent thread and can’t receive new messages.",
            );
        }
        this.#rememberLiveSessionContext(
            input,
            ownerWindowId,
            launch.additionalRoots,
            launch.persistedSnapshot.parentSessionId ?? null,
        );
        try {
            const result = await this.#scheduleWorkerSessionStartup(
                launch,
                0,
                async () => {
                    this.#assertScheduledSessionContextActive(
                        input.sessionId,
                        ownerWindowId,
                        input.runtimeId,
                    );
                    return await worker.sendPrompt({
                        input,
                        launch,
                    });
                },
            );
            void this.#enforceSessionRetention();
            return result;
        } catch (error) {
            this.#discardPreparedSessionContextOnFailure(
                input.sessionId,
                ownerWindowId,
                input.runtimeId,
            );
            throw error;
        }
    }

    #assertScheduledSessionContextActive(
        sessionId: string,
        ownerWindowId: string,
        runtimeId: AiRuntimeId,
    ): void {
        const context = this.#liveSessionContexts.get(sessionId);
        if (
            !context ||
            context.ownerWindowId !== ownerWindowId ||
            context.runtimeId !== runtimeId
        ) {
            throw new Error("The AI session is no longer open.");
        }
    }

    async setSessionMode(input: AiSessionModeMutationInput): Promise<void> {
        if (!this.#liveSessionContexts.has(input.sessionId)) {
            const snapshot = await this.#updateSessionSnapshot(
                input.sessionId,
                (currentSnapshot) =>
                    setModeOnSnapshot(currentSnapshot, input.modeId),
            );
            this.#persistence.saveRuntimeModePreference(
                snapshot.runtimeId,
                input.modeId,
            );
            return;
        }

        await this.#requireAiWorker().setSessionMode(input);
        this.#persistence.saveRuntimeModePreference(
            this.#getLiveSessionRuntimeId(input.sessionId),
            input.modeId,
        );
    }

    async setSessionModel(input: AiSessionModelMutationInput): Promise<void> {
        if (!this.#liveSessionContexts.has(input.sessionId)) {
            const snapshot = await this.#updateSessionSnapshot(
                input.sessionId,
                (currentSnapshot) =>
                    setModelOnSnapshot(currentSnapshot, input.modelId),
            );
            this.#persistence.saveRuntimeModelPreference(
                snapshot.runtimeId,
                input.modelId,
            );
            return;
        }

        await this.#requireAiWorker().setSessionModel(input);
        this.#persistence.saveRuntimeModelPreference(
            this.#getLiveSessionRuntimeId(input.sessionId),
            input.modelId,
        );
    }

    async setSessionConfigOption(
        input: AiSessionConfigOptionMutationInput,
    ): Promise<void> {
        if (!this.#liveSessionContexts.has(input.sessionId)) {
            const snapshot = await this.#updateSessionSnapshot(
                input.sessionId,
                (currentSnapshot) =>
                    setConfigOptionOnSnapshot(
                        currentSnapshot,
                        input.optionId,
                        input.value,
                    ),
            );
            this.#persistRuntimeConfigOptionSelection(
                snapshot.runtimeId,
                snapshot,
                input.optionId,
                input.value,
            );
            return;
        }

        const runtimeId = this.#getLiveSessionRuntimeId(input.sessionId);
        const snapshot = this.#liveSnapshots.get(input.sessionId) ?? null;
        await this.#requireAiWorker().setSessionConfigOption(input);
        this.#persistRuntimeConfigOptionSelection(
            runtimeId,
            snapshot,
            input.optionId,
            input.value,
        );
    }

    async renameSession(input: AiSessionRenameMutationInput): Promise<void> {
        if (this.#liveSessionContexts.has(input.sessionId)) {
            await this.#requireAiWorker().renameSession(input);
            return;
        }

        await this.#updateSessionSnapshot(input.sessionId, (snapshot) =>
            setTitleOnSnapshot(snapshot, input.title),
        );
    }

    async cancelSession(sessionId: string): Promise<void> {
        if (!this.#liveSessionContexts.has(sessionId)) {
            return;
        }

        await this.#requireAiWorker().cancelSession(sessionId);
    }

    async closeSession(sessionId: string): Promise<void> {
        if (!this.#liveSessionContexts.has(sessionId)) {
            return;
        }

        await this.#requireAiWorker().closeSession(sessionId);
        this.#clearLiveSession(sessionId);
    }

    async deleteSession(sessionId: string): Promise<void> {
        this.#deletedSessionIds.add(sessionId);
        try {
            if (this.#liveSessionContexts.has(sessionId)) {
                try {
                    await this.cancelSession(sessionId);
                } catch (error) {
                    // Closing and deleting the local session state is still safe.
                    debugBenignError("ai.service.deleteSession.cancel", error);
                }

                await this.closeSession(sessionId);
            }

            this.#clearLiveSession(sessionId);
            await this.#persistence.deleteSession(sessionId);
        } catch (error) {
            this.#deletedSessionIds.delete(sessionId);
            throw error;
        }
    }

    closeOwnedByWindow(ownerWindowId: string): void {
        const sessionIds = [...this.#liveSessionContexts.entries()]
            .filter(
                ([, liveSession]) => liveSession.ownerWindowId === ownerWindowId,
            )
            .map(([sessionId]) => sessionId);

        void this.#aiWorker
            ?.closeOwnedByWindow(ownerWindowId)
            .catch((error: unknown) => {
                debugBenignError("ai.service.closeOwnedByWindow", error);
            });
        for (const sessionId of sessionIds) {
            this.#recordRetentionClose(sessionId, "window_close");
            this.#clearLiveSession(sessionId);
        }
    }

    async launchRuntimeAuth(input: AiRuntimeAuthLaunchInput): Promise<void> {
        const cwd = input.projectId
            ? this.#projectService.getProjectRootPath(
                  input.projectId,
                  input.worktreeId ?? null,
              )
            : process.cwd();

        if (input.runtimeId === "claude") {
            const currentSettings =
                this.#settingsService.loadClaudeRuntimeSettings();
            const authMethod =
                input.methodId === "gateway"
                    ? "gateway"
                    : input.methodId === "claude-login" ||
                        input.methodId === "claude-ai-login" ||
                        input.methodId === "console-login"
                      ? input.methodId
                      : null;

            if (authMethod === null || authMethod === "gateway") {
                throw new Error(
                    "Select a Claude login method before opening authentication.",
                );
            }

            const nextSettings = markClaudeAuthInvalidated({
                ...currentSettings,
                authMethod,
            });
            await this.#saveClaudeAuthSettings(nextSettings, []);

            const resolvedRuntime = resolveClaudeRuntime(
                nextSettings,
                this.#secretStore,
            );

            await launchClaudeLogin(resolvedRuntime, authMethod, cwd);
            this.#onRuntimeStatus(
                getClaudeRuntimeStatus(nextSettings, this.#secretStore),
            );
            return;
        }

        this.#rejectGeminiRuntime(input.runtimeId);

        if (input.runtimeId === "kilo") {
            if (input.methodId === "kilo-api-key") {
                throw new Error(
                    "The Kilo API key does not need a login terminal. Save the API key from settings.",
                );
            }

            if (input.methodId !== "kilo-login") {
                throw new Error(
                    "Select Kilo login before opening authentication.",
                );
            }

            const nextSettings = markKiloAuthInvalidated(
                {
                    ...this.#settingsService.loadKiloRuntimeSettings(),
                    authMethod: "kilo-login",
                },
            );
            await this.#saveKiloAuthSettings(nextSettings);

            await launchKiloLogin(nextSettings, cwd);
            this.#onRuntimeStatus(
                getKiloRuntimeStatus(nextSettings, this.#secretStore),
            );
            return;
        }

        if (input.runtimeId === "grok") {
            if (input.methodId === "xai-api-key") {
                throw new Error(
                    "The xAI API key does not need a login terminal. Save the API key from settings.",
                );
            }

            if (input.methodId !== "grok-login") {
                throw new Error(
                    "Select Grok login before opening authentication.",
                );
            }

            const nextSettings = markGrokAuthInvalidated({
                ...this.#settingsService.loadGrokRuntimeSettings(),
                authMethod: "grok-login",
            });
            await this.#saveGrokAuthSettings(nextSettings);

            await launchGrokLogin(nextSettings, cwd);
            this.#onRuntimeStatus(
                this.#withPersistedRuntimeCatalog(
                    getGrokRuntimeStatus(nextSettings, this.#secretStore),
                ),
            );
            return;
        }

        if (input.runtimeId === "opencode") {
            if (input.methodId !== "opencode-login") {
                throw new Error(
                    "Select OpenCode auth before opening authentication.",
                );
            }

            const nextSettings = markOpenCodeAuthInvalidated({
                ...this.#settingsService.loadOpenCodeRuntimeSettings(),
                authMethod: "opencode-login",
            });
            await this.#saveOpenCodeAuthSettings(nextSettings);

            await launchOpenCodeLogin(nextSettings, cwd);
            this.#onRuntimeStatus(
                getOpenCodeRuntimeStatus(nextSettings, this.#secretStore),
            );
            return;
        }

        const currentSettings = this.#settingsService.loadCodexRuntimeSettings();
        const authMethod = getCodexAuthMethods().some(
            (method) => method.id === input.methodId,
        )
            ? (input.methodId as CodexRuntimeSettings["authMethod"])
            : null;

        if (authMethod === null) {
            throw new Error(
                "Choose a valid Codex login method before opening authentication.",
            );
        }

        const nextSettings = {
            ...currentSettings,
            authMethod,
        } satisfies CodexRuntimeSettings;
        await this.#runRuntimeAuthConnection(
            "codex",
            cwd,
            async (connection) => {
                const initializeResponse = await connection.initialize({
                    clientCapabilities: {
                        fs: {
                            readTextFile: true,
                            writeTextFile: true,
                        },
                    },
                    clientInfo: {
                        name: "comando",
                        title: "Comando",
                        version: process.versions.electron,
                    },
                    protocolVersion: PROTOCOL_VERSION,
                });

                const advertisedMethods =
                    initializeResponse.authMethods?.map((method) => method.id) ??
                    [];
                if (!advertisedMethods.includes(authMethod)) {
                    throw new Error(
                        `Codex does not support the authentication method \`${authMethod}\` on this machine.`,
                    );
                }

                await connection.authenticate({
                    methodId: authMethod,
                });
            },
            nextSettings,
        );

        await this.#saveCodexAuthSettings(nextSettings, []);
        this.#onRuntimeStatus(
            this.#withPersistedRuntimeCatalog(
                getCodexRuntimeStatus(
                    nextSettings,
                    loadCodexSecretBundle(this.#secretStore),
                ),
            ),
        );
    }

    async logoutRuntimeAuth(
        input: AiRuntimeAuthLogoutInput,
    ): Promise<AiRuntimeStatus> {
        if (input.runtimeId !== "codex") {
            throw new Error(
                `${getRuntimeDisplayName(input.runtimeId)} does not support logout yet.`,
            );
        }

        const currentSettings =
            this.#settingsService.loadCodexRuntimeSettings();
        if (currentSettings.authMethod !== "chatgpt") {
            throw new Error(
                "Codex provider logout is only available for ChatGPT login. Use Disconnect from Comando to clear local API keys.",
            );
        }

        await this.#runRuntimeAuthConnection(
            "codex",
            process.cwd(),
            async (connection) => {
                const initializeResponse = await connection.initialize({
                    clientCapabilities: {
                        fs: {
                            readTextFile: true,
                            writeTextFile: true,
                        },
                    },
                    clientInfo: {
                        name: "comando",
                        title: "Comando",
                        version: process.versions.electron,
                    },
                    protocolVersion: PROTOCOL_VERSION,
                });

                if (!initializeResponse.agentCapabilities?.auth?.logout) {
                    throw new Error(
                        "Codex does not advertise logout support on this machine.",
                    );
                }

                await connection.unstable_logout({});
            },
        );

        const secretPatch = buildCodexSecretPatches(this.#secretStore, {
            codexApiKey: null,
            openaiApiKey: null,
        });
        const nextSettings = {
            ...currentSettings,
            authMethod: null,
            hasCodexApiKey: secretPatch.flags.hasCodexApiKey,
            hasOpenAiApiKey: secretPatch.flags.hasOpenAiApiKey,
        } satisfies CodexRuntimeSettings;
        await this.#saveCodexAuthSettings(nextSettings, secretPatch.patches);

        const status = this.#withPersistedRuntimeCatalog(
            getCodexRuntimeStatus(
                nextSettings,
                loadCodexSecretBundle(this.#secretStore),
            ),
        );
        this.#onRuntimeStatus(status);
        return status;
    }

    async disconnectRuntimeAuth(
        input: AiRuntimeAuthDisconnectInput,
    ): Promise<AiRuntimeStatus> {
        if (input.runtimeId === "codex") {
            const currentSettings =
                this.#settingsService.loadCodexRuntimeSettings();
            const secretPatch = buildCodexSecretPatches(this.#secretStore, {
                codexApiKey: null,
                openaiApiKey: null,
            });
            const nextSettings = {
                ...currentSettings,
                authMethod: null,
                hasCodexApiKey: secretPatch.flags.hasCodexApiKey,
                hasOpenAiApiKey: secretPatch.flags.hasOpenAiApiKey,
            } satisfies CodexRuntimeSettings;
            await this.#saveCodexAuthSettings(nextSettings, secretPatch.patches);
            const status = this.#withPersistedRuntimeCatalog(
                getCodexRuntimeStatus(
                    nextSettings,
                    loadCodexSecretBundle(this.#secretStore),
                ),
            );
            this.#onRuntimeStatus(status);
            return status;
        }

        if (input.runtimeId === "claude") {
            const currentSettings =
                this.#settingsService.loadClaudeRuntimeSettings();
            const secretPatch = buildClaudeSecretPatches(this.#secretStore, {
                anthropicApiKey: null,
                gatewayAuthToken: null,
                gatewayCustomHeaders: null,
            });
            const shouldInvalidateExternalLogin = ![
                "anthropic-api-key",
                "gateway",
                "gateway-bedrock",
            ].includes(currentSettings.authMethod ?? "");
            const nextSettings = {
                ...currentSettings,
                authInvalidatedAtMs:
                    shouldInvalidateExternalLogin
                        ? Date.now()
                        : currentSettings.authInvalidatedAtMs,
                authMethod: null,
                hasAnthropicApiKey: secretPatch.flags.hasAnthropicApiKey,
                hasGatewayAuthToken: secretPatch.flags.hasGatewayAuthToken,
                hasGatewayCustomHeaders:
                    secretPatch.flags.hasGatewayCustomHeaders,
            };
            await this.#saveClaudeAuthSettings(nextSettings, secretPatch.patches);
            const status = this.#withPersistedRuntimeCatalog(
                getClaudeRuntimeStatus(nextSettings, this.#secretStore),
            );
            this.#onRuntimeStatus(status);
            return status;
        }

        this.#rejectGeminiRuntime(input.runtimeId);

        if (input.runtimeId === "opencode") {
            const nextSettings = {
                ...markOpenCodeAuthInvalidated(
                    this.#settingsService.loadOpenCodeRuntimeSettings(),
                ),
                authMethod: null,
            };
            await this.#saveOpenCodeAuthSettings(nextSettings);
            const status = this.#withPersistedRuntimeCatalog(
                getOpenCodeRuntimeStatus(nextSettings, this.#secretStore),
            );
            this.#onRuntimeStatus(status);
            return status;
        }

        if (input.runtimeId === "grok") {
            const currentSettings =
                this.#settingsService.loadGrokRuntimeSettings();
            const secretPatch = buildGrokSecretPatches(this.#secretStore, {
                xaiApiKey: null,
            });
            const nextSettings = {
                ...markGrokAuthInvalidated(currentSettings),
                authMethod: null,
                hasXaiApiKey: secretPatch.flags.hasXaiApiKey,
            } satisfies GrokRuntimeSettings;
            await this.#saveGrokAuthSettings(nextSettings, secretPatch.patches);
            const status = this.#withPersistedRuntimeCatalog(
                getGrokRuntimeStatus(nextSettings, this.#secretStore),
            );
            this.#onRuntimeStatus(status);
            return status;
        }

        const currentSettings = this.#settingsService.loadKiloRuntimeSettings();
        const secretPatch = buildKiloSecretPatches(this.#secretStore, {
            kiloApiKey: null,
        });
        const nextSettings = {
            ...markKiloAuthInvalidated(currentSettings),
            authMethod: null,
            hasKiloApiKey: secretPatch.flags.hasKiloApiKey,
        };
        await this.#saveKiloAuthSettings(nextSettings, secretPatch.patches);
        const status = this.#withPersistedRuntimeCatalog(
            getKiloRuntimeStatus(nextSettings, this.#secretStore),
        );
        this.#onRuntimeStatus(status);
        return status;
    }

    respondPermission(input: AiPermissionResponseInput): Promise<void> {
        return this.#requireAiWorker().respondPermission(input);
    }

    async respondUserInput(input: AiUserInputResponseInput): Promise<void> {
        await this.#requireAiWorker().respondUserInput(input);
    }

    #requireAiWorker(): AiWorkerGateway {
        if (!this.#aiWorker) {
            throw new Error("The AI worker is not available.");
        }

        return this.#aiWorker;
    }

    #rememberLiveSessionContext(
        input: SessionDescriptor,
        ownerWindowId: string,
        additionalRoots: readonly string[],
        persistedParentSessionId: string | null = null,
    ): void {
        const existingContext = this.#liveSessionContexts.get(input.sessionId);
        const snapshotParentSessionId =
            this.#liveSnapshots.get(input.sessionId)?.parentSessionId ?? null;
        const parentSessionId =
            existingContext?.parentSessionId ??
            normalizeSessionRef(persistedParentSessionId) ??
            snapshotParentSessionId ??
            null;
        this.#liveSessionContexts.set(input.sessionId, {
            additionalRoots,
            ownerWindowId,
            parentSessionId,
            projectId: input.projectId,
            runtimeId: input.runtimeId,
            sessionId: input.sessionId,
            worktreeId: input.worktreeId ?? null,
        });
        this.#touchLiveSession(input.sessionId);
    }

    #cacheLiveSessionSnapshot(
        snapshot: AiSessionSnapshot,
        ownerWindowId: string,
    ): void {
        this.#liveSnapshots.set(snapshot.sessionId, snapshot);
        this.#touchLiveSession(snapshot.sessionId);
        const context = this.#liveSessionContexts.get(snapshot.sessionId);
        if (context) {
            this.#liveSessionContexts.set(snapshot.sessionId, {
                ...context,
                ownerWindowId,
                parentSessionId:
                    normalizeSessionRef(snapshot.parentSessionId) ??
                    context.parentSessionId,
                projectId: snapshot.projectId,
                runtimeId: snapshot.runtimeId,
                worktreeId: snapshot.worktreeId ?? null,
            });
            return;
        }

        const parentSessionId = snapshot.parentSessionId ?? null;
        const parentContext = parentSessionId
            ? this.#liveSessionContexts.get(parentSessionId)
            : null;
        if (!parentContext) {
            return;
        }

        this.#liveSessionContexts.set(snapshot.sessionId, {
            additionalRoots: parentContext.additionalRoots,
            ownerWindowId,
            parentSessionId,
            projectId: snapshot.projectId,
            runtimeId: snapshot.runtimeId,
            sessionId: snapshot.sessionId,
            worktreeId: snapshot.worktreeId ?? null,
        });
        this.#touchLiveSession(snapshot.sessionId);
    }

    #clearLiveSession(sessionId: string): void {
        this.#liveSnapshots.delete(sessionId);
        this.#liveSessionContexts.delete(sessionId);
        this.#liveSessionTouches.delete(sessionId);
        this.#freezingSessionIds.delete(sessionId);
        this.#scheduleSessionRetentionTimer();
    }

    #touchLiveSession(sessionId: string): void {
        if (!this.#liveSessionContexts.has(sessionId)) {
            return;
        }

        this.#liveSessionTouches.set(sessionId, {
            lastUsedAtMs: Date.now(),
            order: this.#nextLiveSessionTouchOrder++,
        });
        this.#scheduleSessionRetentionTimer();
    }

    async #enforceSessionRetention(): Promise<void> {
        if (this.#retentionSweep) {
            await this.#retentionSweep;
            return;
        }

        const sweep = this.#runSessionRetentionSweep();
        this.#retentionSweep = sweep;
        try {
            await sweep;
        } finally {
            if (this.#retentionSweep === sweep) {
                this.#retentionSweep = null;
            }
            this.#scheduleSessionRetentionTimer();
        }
    }

    async #runSessionRetentionSweep(): Promise<void> {
        const candidates = this.#selectRetentionCandidates();
        for (const candidate of candidates) {
            await this.#freezeSessionForRetention(
                candidate.sessionId,
                candidate.reason,
            );
        }
    }

    #selectRetentionCandidates(): readonly {
        readonly reason: AiSessionFreezeReason;
        readonly sessionId: string;
    }[] {
        const candidates = new Map<string, AiSessionFreezeReason>();
        const now = Date.now();
        if (this.#retentionConfig.idleTtlMs >= 0) {
            for (const [sessionId, touch] of this.#liveSessionTouches) {
                if (now - touch.lastUsedAtMs >= this.#retentionConfig.idleTtlMs) {
                    candidates.set(sessionId, "ttl");
                }
            }
        }

        const sessionsByWindow = new Map<string, LiveSessionContext[]>();
        for (const context of this.#liveSessionContexts.values()) {
            const sessions = sessionsByWindow.get(context.ownerWindowId) ?? [];
            sessions.push(context);
            sessionsByWindow.set(context.ownerWindowId, sessions);
        }

        for (const sessions of sessionsByWindow.values()) {
            const ordered = [...sessions].sort((left, right) => {
                const leftTouch = this.#liveSessionTouches.get(left.sessionId);
                const rightTouch = this.#liveSessionTouches.get(right.sessionId);
                const leftOrder = leftTouch?.order ?? -1;
                const rightOrder = rightTouch?.order ?? -1;
                return rightOrder - leftOrder;
            });
            for (
                let index = this.#retentionConfig.maxHotSessionsPerWindow;
                index < ordered.length;
                index += 1
            ) {
                if (!candidates.has(ordered[index].sessionId)) {
                    candidates.set(ordered[index].sessionId, "budget");
                }
            }
        }

        return [...candidates.entries()].map(([sessionId, reason]) => ({
            reason,
            sessionId,
        }));
    }

    async #freezeSessionForRetention(
        sessionId: string,
        reason: AiSessionFreezeReason,
    ): Promise<void> {
        if (
            this.#freezingSessionIds.has(sessionId) ||
            !this.#liveSessionContexts.has(sessionId)
        ) {
            return;
        }

        const snapshot = this.#liveSnapshots.get(sessionId) ?? null;
        const localSkippedReason = snapshot
            ? getRetentionSkippedReasonFromSnapshot(snapshot)
            : null;
        if (localSkippedReason) {
            this.#recordRetentionSkipped(sessionId, reason, localSkippedReason);
            return;
        }

        this.#freezingSessionIds.add(sessionId);
        try {
            const result = await this.#requireAiWorker().freezeSession({
                reason,
                sessionId,
            });
            if (result.frozen) {
                this.#recordRetentionClose(sessionId, reason);
                this.#clearLiveSession(sessionId);
                return;
            }

            if (result.skippedReason) {
                this.#recordRetentionSkipped(
                    sessionId,
                    reason,
                    result.skippedReason,
                );
                this.#deferSessionRetentionRetry(sessionId);
                return;
            }

            this.#deferSessionRetentionRetry(sessionId);
        } catch (error) {
            this.#deferSessionRetentionRetry(sessionId);
            debugBenignError("ai.service.freezeSession", error);
        } finally {
            this.#freezingSessionIds.delete(sessionId);
        }
    }

    #recordRetentionClose(
        sessionId: string,
        reason: AiSessionFreezeReason,
    ): void {
        this.#lastRetentionCloseRecords.push({
            closedAtMs: Date.now(),
            reason,
            sessionId,
        });
        trimRetentionRecords(this.#lastRetentionCloseRecords);
    }

    #recordRetentionSkipped(
        sessionId: string,
        reason: AiSessionFreezeReason,
        skippedReason: AiSessionFreezeSkippedReason,
    ): void {
        this.#lastRetentionSkippedRecords.push({
            reason,
            sessionId,
            skippedAtMs: Date.now(),
            skippedReason,
        });
        trimRetentionRecords(this.#lastRetentionSkippedRecords);
    }

    #deferSessionRetentionRetry(sessionId: string): void {
        const touch = this.#liveSessionTouches.get(sessionId);
        if (!touch) {
            return;
        }

        this.#liveSessionTouches.set(sessionId, {
            lastUsedAtMs: Date.now(),
            order: touch.order,
        });
    }

    #scheduleSessionRetentionTimer(): void {
        this.#clearSessionRetentionTimer();

        const delayMs = this.#getNextSessionRetentionDelayMs();
        if (delayMs === null) {
            return;
        }

        const timer = setTimeout(() => {
            this.#retentionTimer = null;
            void this.#enforceSessionRetention();
        }, delayMs);
        unrefTimer(timer);
        this.#retentionTimer = timer;
    }

    #clearSessionRetentionTimer(): void {
        if (!this.#retentionTimer) {
            return;
        }

        clearTimeout(this.#retentionTimer);
        this.#retentionTimer = null;
    }

    #getNextSessionRetentionDelayMs(): number | null {
        if (
            this.#retentionConfig.idleTtlMs < 0 ||
            this.#liveSessionTouches.size === 0
        ) {
            return null;
        }

        const now = Date.now();
        let nextDueAtMs: number | null = null;
        for (const [sessionId, touch] of this.#liveSessionTouches) {
            if (
                this.#freezingSessionIds.has(sessionId) ||
                !this.#liveSessionContexts.has(sessionId)
            ) {
                continue;
            }

            const snapshot = this.#liveSnapshots.get(sessionId) ?? null;
            if (snapshot && getRetentionSkippedReasonFromSnapshot(snapshot)) {
                continue;
            }

            const dueAtMs = touch.lastUsedAtMs + this.#retentionConfig.idleTtlMs;
            nextDueAtMs =
                nextDueAtMs === null ? dueAtMs : Math.min(nextDueAtMs, dueAtMs);
        }

        return nextDueAtMs === null ? null : Math.max(0, nextDueAtMs - now);
    }

    #isColdSessionLaunch(launch: AiWorkerSessionLaunchInput): boolean {
        return !this.#liveSnapshots.has(launch.input.sessionId);
    }

    async #scheduleWorkerSessionStartup<T>(
        launch: AiWorkerSessionLaunchInput,
        priority: AiSchedulerPriority,
        run: () => Promise<T>,
        options: { readonly forceColdStart?: boolean } = {},
    ): Promise<T> {
        return await this.#scheduler.schedule(
            {
                coldStart:
                    options.forceColdStart ?? this.#isColdSessionLaunch(launch),
                priority,
                runtimeId: launch.input.runtimeId,
            },
            run,
        );
    }

    #discardPreparedSessionContextOnFailure(
        sessionId: string,
        ownerWindowId: string,
        runtimeId: AiRuntimeId,
    ): void {
        const liveSnapshot = this.#liveSnapshots.get(sessionId);
        if (liveSnapshot) {
            return;
        }

        const context = this.#liveSessionContexts.get(sessionId);
        if (
            !context ||
            context.ownerWindowId !== ownerWindowId ||
            context.runtimeId !== runtimeId
        ) {
            return;
        }

        this.#liveSessionContexts.delete(sessionId);
    }

    #acceptPreparedLiveSnapshot(
        snapshot: AiSessionSnapshot,
        ownerWindowId: string,
    ): void {
        this.#cacheLiveSessionSnapshot(snapshot, ownerWindowId);
        this.#persistence.saveSessionSnapshot(snapshot);
    }

    async #reconcilePersistedTrackedFiles(
        snapshot: AiSessionSnapshot,
    ): Promise<AiSessionSnapshot> {
        if (snapshot.trackedFiles.length === 0) {
            return snapshot;
        }

        const scope = this.#resolvePersistedSnapshotReviewScope(snapshot);
        if (!scope) {
            return snapshot;
        }

        const result = await reconcilePendingTrackedFiles({
            onError: (error) => {
                debugBenignError("ai.service.reconcileTrackedFile", error);
            },
            readTrackedFileText: async (trackedPath) =>
                await this.#readPersistedTrackedFileText(scope, trackedPath),
            trackedFiles: snapshot.trackedFiles,
        });
        if (!result.changed) {
            return snapshot;
        }

        const nextSnapshot = {
            ...snapshot,
            trackedFiles: result.trackedFiles,
            updatedAt: new Date().toISOString(),
        };
        this.#persistence.saveSessionSnapshot(nextSnapshot);
        return nextSnapshot;
    }

    #resolvePersistedSnapshotReviewScope(
        snapshot: Pick<AiSessionSnapshot, "projectId" | "worktreeId">,
    ): {
        readonly additionalRoots: readonly string[];
        readonly scopeRoot: string;
    } | null {
        try {
            const projectRoot = snapshot.projectId
                ? this.#projectService.getProjectRootPath(
                      snapshot.projectId,
                      snapshot.worktreeId ?? null,
                  )
                : null;
            const scopeRoot = path.resolve(projectRoot ?? process.cwd());
            return {
                additionalRoots: this.#resolveEffectiveAdditionalRoots(
                    {
                        additionalRoots: [],
                        projectId: snapshot.projectId,
                        worktreeId: snapshot.worktreeId ?? null,
                    },
                    projectRoot,
                ),
                scopeRoot,
            };
        } catch (error) {
            debugBenignError("ai.service.resolveReviewScope", error);
            return null;
        }
    }

    async #readPersistedTrackedFileText(
        scope: {
            readonly additionalRoots: readonly string[];
            readonly scopeRoot: string;
        },
        trackedPath: string,
    ): Promise<string | null> {
        const absolutePath = this.#resolvePersistedTrackedFileAbsolutePath(
            scope,
            trackedPath,
        );
        const bufferText = readOpenFileBuffer(absolutePath);
        return bufferText ?? (await readTextIfExists(absolutePath));
    }

    #resolvePersistedTrackedFileAbsolutePath(
        scope: {
            readonly additionalRoots: readonly string[];
            readonly scopeRoot: string;
        },
        candidatePath: string,
    ): string {
        const resolvedPath = resolveSessionScopedPath(
            scope.scopeRoot,
            candidatePath,
        );
        const insideAdditionalRoot = scope.additionalRoots.some((rootPath) =>
            isPathInsideRoot(resolvedPath.absolutePath, rootPath),
        );

        if (!resolvedPath.insideRoot && !insideAdditionalRoot) {
            throw new Error("Tracked file path is outside the session scope.");
        }

        return resolvedPath.absolutePath;
    }

    #getLiveSessionRuntimeId(sessionId: string): AiRuntimeId {
        const runtimeId = this.#liveSnapshots.get(sessionId)?.runtimeId;
        if (!runtimeId) {
            throw new Error("The live AI session snapshot is not available.");
        }

        return runtimeId;
    }

    #resolveSnapshotFromWorkerUpdate(
        update: AiSessionUpdate,
    ): AiSessionSnapshot | null {
        if (update.kind === "snapshot") {
            return update.snapshot;
        }

        const previousSnapshot = this.#liveSnapshots.get(update.patch.sessionId);
        if (!previousSnapshot) {
            return null;
        }

        return {
            ...previousSnapshot,
            ...update.patch.changes,
            runtimeId: update.patch.runtimeId,
            sessionId: update.patch.sessionId,
        };
    }

    async #buildWorkerSessionLaunchInput(
        input: SessionDescriptor,
        ownerWindowId: string,
        snapshotOverride?: AiSessionSnapshot | null,
    ): Promise<AiWorkerSessionLaunchInput> {
        const projectRoot = input.projectId
            ? this.#projectService.getProjectRootPath(
                  input.projectId,
                  input.worktreeId ?? null,
              )
            : null;
        const additionalRoots = this.#resolveEffectiveAdditionalRoots(
            input,
            projectRoot,
        );
        await this.#hydrateGrokRuntimeAuthBeforeLaunch(input.runtimeId);
        const resolvedRuntime = this.#resolveRuntimeCommand(input.runtimeId);
        this.#onRuntimeStatus(resolvedRuntime.status);
        if (
            resolvedRuntime.status.state !== "ready" ||
            resolvedRuntime.status.onboardingRequired
        ) {
            throw new Error(
                resolvedRuntime.status.message ??
                    `${getRuntimeDisplayName(input.runtimeId)} ACP is not available on this machine.`,
            );
        }

        const persistedSnapshot =
            snapshotOverride ??
            this.#liveSnapshots.get(input.sessionId) ??
            (await this.#persistence.loadSessionSnapshot(input.sessionId)) ??
            createEmptyAiSessionSnapshot({
                projectId: input.projectId,
                runtimeId: input.runtimeId,
                sessionId: input.sessionId,
                title: input.title,
                worktreeId: input.worktreeId ?? null,
            });
        const persistedSubagentSessionMappings =
            (await this.#persistence.listSessionRuntimeMappingsForParent?.(
                persistedSnapshot.sessionId,
            )) ?? [];

        return {
            additionalRoots,
            cwd: projectRoot ?? process.cwd(),
            desiredSelections: this.#resolveDesiredSelections(
                input.runtimeId,
                persistedSnapshot,
            ),
            input: {
                ...input,
                additionalRoots,
                worktreeId: input.worktreeId ?? null,
            },
            ownerWindowId,
            persistedSnapshot,
            persistedSubagentSessionMappings,
            projectRoot,
            resolvedRuntime,
        };
    }

    async #buildWorkerScopeRefreshInputs(
        projectId: string,
    ): Promise<readonly AiWorkerSessionLaunchInput[]> {
        const launches = await Promise.all(
            this.#listRelaunchableLiveSessionContexts()
                .filter((context) => context.projectId === projectId)
                .map(async (context) => {
                    const snapshot =
                        this.#liveSnapshots.get(context.sessionId) ??
                        (await this.#persistence.loadSessionSnapshot(
                            context.sessionId,
                        ));
                    if (!snapshot) {
                        return null;
                    }

                    return await this.#buildWorkerSessionLaunchInput(
                        {
                            additionalRoots: context.additionalRoots,
                            projectId: context.projectId,
                            runtimeId: context.runtimeId,
                            sessionId: context.sessionId,
                            title: snapshot.title,
                            worktreeId: context.worktreeId,
                        },
                        context.ownerWindowId,
                        snapshot,
                    );
                }),
        );

        return launches.filter(
            (
                launch,
            ): launch is AiWorkerSessionLaunchInput => launch !== null,
        );
    }

    #listRelaunchableLiveSessionContexts(): readonly LiveSessionContext[] {
        return [...this.#liveSessionContexts.values()].filter(
            (context) =>
                !context.parentSessionId ||
                !this.#liveSessionContexts.has(context.parentSessionId),
        );
    }

    async #buildWorkerReviewContext(
        sessionId: string,
    ): Promise<{
        readonly context: AiWorkerReviewSessionContext;
        readonly snapshot: AiSessionSnapshot;
    }> {
        const liveContext = this.#liveSessionContexts.get(sessionId);
        const snapshot =
            this.#liveSnapshots.get(sessionId) ??
            (await this.#persistence.loadSessionSnapshot(sessionId));
        if (!snapshot) {
            throw new Error("The AI session was not found.");
        }

        const projectRoot =
            snapshot.projectId !== null
                ? this.#projectService.getProjectRootPath(
                      snapshot.projectId,
                      snapshot.worktreeId ?? null,
                  )
                : null;
        const additionalRoots = liveContext
            ? liveContext.additionalRoots
            : this.#resolveEffectiveAdditionalRoots(
                  {
                      additionalRoots: [],
                      projectId: snapshot.projectId,
                      worktreeId: snapshot.worktreeId ?? null,
                  },
                  projectRoot,
              );

        return {
            context: {
                additionalRoots,
                cwd: projectRoot ?? process.cwd(),
                ownerWindowId: liveContext?.ownerWindowId ?? "",
                projectRoot,
                snapshot,
            },
            snapshot,
        };
    }

    #persistReviewMutation(
        previousSnapshot: AiSessionSnapshot,
        result: AiWorkerReviewMutationResult,
    ): void {
        this.#persistence.saveSessionSnapshot(result.snapshot);
        if (this.#liveSnapshots.has(result.snapshot.sessionId)) {
            this.#liveSnapshots.set(result.snapshot.sessionId, result.snapshot);
            this.#touchLiveSession(result.snapshot.sessionId);
        }
        this.#onSessionSnapshot(
            result.ownerWindowId,
            buildAiSessionUpdate(previousSnapshot, result.snapshot),
        );
        void this.#enforceSessionRetention();
    }

    async keepTrackedFile(input: AiTrackedFileMutationInput): Promise<void> {
        const reviewSession = await this.#buildWorkerReviewContext(
            input.sessionId,
        );
        const result = await this.#requireAiWorker().keepTrackedFile({
            context: reviewSession.context,
            input,
        });
        this.#persistReviewMutation(reviewSession.snapshot, result);
    }

    async rejectTrackedFile(input: AiTrackedFileMutationInput): Promise<void> {
        const reviewSession = await this.#buildWorkerReviewContext(
            input.sessionId,
        );
        const result = await this.#requireAiWorker().rejectTrackedFile({
            context: reviewSession.context,
            input,
        });
        this.#persistReviewMutation(reviewSession.snapshot, result);
    }

    async keepTrackedFileHunks(
        input: AiTrackedFileHunkMutationInput,
    ): Promise<void> {
        const reviewSession = await this.#buildWorkerReviewContext(
            input.sessionId,
        );
        const result = await this.#requireAiWorker().keepTrackedFileHunks({
            context: reviewSession.context,
            input,
        });
        this.#persistReviewMutation(reviewSession.snapshot, result);
    }

    async rejectTrackedFileHunks(
        input: AiTrackedFileHunkMutationInput,
    ): Promise<void> {
        const reviewSession = await this.#buildWorkerReviewContext(
            input.sessionId,
        );
        const result = await this.#requireAiWorker().rejectTrackedFileHunks({
            context: reviewSession.context,
            input,
        });
        this.#persistReviewMutation(reviewSession.snapshot, result);
    }

    async keepAllTrackedFiles(sessionId: string): Promise<void> {
        const reviewSession = await this.#buildWorkerReviewContext(sessionId);
        const result = await this.#requireAiWorker().keepAllTrackedFiles({
            context: reviewSession.context,
            input: sessionId,
        });
        this.#persistReviewMutation(reviewSession.snapshot, result);
    }

    async rejectAllTrackedFiles(sessionId: string): Promise<void> {
        const reviewSession = await this.#buildWorkerReviewContext(sessionId);
        const result = await this.#requireAiWorker().rejectAllTrackedFiles({
            context: reviewSession.context,
            input: sessionId,
        });
        this.#persistReviewMutation(reviewSession.snapshot, result);
    }

    #resolveEffectiveAdditionalRoots(
        input: Pick<
            SessionDescriptor,
            "additionalRoots" | "projectId" | "worktreeId"
        >,
        projectRoot: string | null,
    ): readonly string[] {
        const mergedRoots = [
            ...(input.additionalRoots ?? []),
            ...this.#listProjectScopeRoots(input.projectId),
        ];

        if (!projectRoot) {
            return normalizeAdditionalRoots(mergedRoots);
        }

        return normalizeAdditionalRoots(
            mergedRoots.filter(
                (rootPath) =>
                    rootPath.trim().length > 0 &&
                    !isSamePath(rootPath, projectRoot),
            ),
        );
    }

    #listProjectScopeRoots(projectId: string | null): readonly string[] {
        if (!projectId) {
            return [];
        }

        return this.#projectService
            .listProjectWorktrees(projectId)
            .map((worktree) => worktree.rootPath);
    }

    #resolveDesiredSelections(
        runtimeId: AiRuntimeId,
        persistedSnapshot: Pick<
            AiSessionSnapshot,
            "configOptions" | "modeId" | "modelId"
        >,
    ): Pick<AiSessionSnapshot, "configOptions" | "modeId" | "modelId"> & {
        readonly preferredConfigOptions: Record<string, boolean | string>;
    } {
        const preferences =
            this.#persistence.loadRuntimeSelectionPreferences(runtimeId);

        return {
            configOptions: persistedSnapshot.configOptions,
            modeId: persistedSnapshot.modeId ?? preferences.modeId,
            modelId: persistedSnapshot.modelId ?? preferences.modelId,
            preferredConfigOptions: preferences.configOptions,
        };
    }

    #persistRuntimeConfigOptionSelection(
        runtimeId: AiRuntimeId,
        snapshot: Pick<AiSessionSnapshot, "configOptions"> | null,
        optionId: string,
        value: boolean | string,
    ): void {
        this.#persistence.saveRuntimeSelectionPreferenceOption(
            runtimeId,
            optionId,
            value,
        );

        if (typeof value !== "string") {
            return;
        }

        const configOptions = snapshot?.configOptions ?? [];
        const modeConfig = getModeConfigOption(configOptions);
        const modelConfig = getModelConfigOption(configOptions);
        const normalizedOptionId = optionId.toLowerCase();

        if (modelConfig?.id === optionId || normalizedOptionId === "model") {
            this.#persistence.saveRuntimeModelPreference(runtimeId, value);
        }

        if (modeConfig?.id === optionId || normalizedOptionId === "mode") {
            this.#persistence.saveRuntimeModePreference(runtimeId, value);
        }
    }

    async #updateSessionSnapshot(
        sessionId: string,
        mutate: (snapshot: AiSessionSnapshot) => AiSessionSnapshot,
    ): Promise<AiSessionSnapshot> {
        const liveSnapshot = this.#liveSnapshots.get(sessionId);
        if (liveSnapshot) {
            const nextSnapshot = mutate(liveSnapshot);
            this.#liveSnapshots.set(sessionId, nextSnapshot);
            this.#persistence.saveSessionSnapshot(nextSnapshot);
            this.#onSessionSnapshot(
                this.#liveSessionContexts.get(sessionId)?.ownerWindowId ?? "",
                buildAiSessionUpdate(liveSnapshot, nextSnapshot),
            );
            return nextSnapshot;
        }

        const snapshot = await this.#persistence.loadSessionSnapshot(sessionId);
        if (!snapshot) {
            throw new Error("The AI session was not found.");
        }

        const nextSnapshot = mutate(snapshot);
        this.#persistence.saveSessionSnapshot(nextSnapshot);
        this.#onSessionSnapshot("", {
            kind: "snapshot",
            snapshot: nextSnapshot,
        });
        return nextSnapshot;
    }

    #resolveRuntimeStatus(runtimeId: AiRuntimeId): AiRuntimeStatus {
        if (runtimeId === "claude") {
            return getClaudeRuntimeStatus(
                this.#settingsService.loadClaudeRuntimeSettings(),
                this.#secretStore,
            );
        }

        if (runtimeId === "gemini") {
            return createRemovedGeminiRuntimeStatus();
        }

        if (runtimeId === "grok") {
            return getGrokRuntimeStatus(
                this.#settingsService.loadGrokRuntimeSettings(),
                this.#secretStore,
            );
        }

        if (runtimeId === "kilo") {
            return getKiloRuntimeStatus(
                this.#settingsService.loadKiloRuntimeSettings(),
                this.#secretStore,
            );
        }

        if (runtimeId === "opencode") {
            return getOpenCodeRuntimeStatus(
                this.#settingsService.loadOpenCodeRuntimeSettings(),
                this.#secretStore,
            );
        }

        return getCodexRuntimeStatus(
            this.#settingsService.loadCodexRuntimeSettings(),
            loadCodexSecretBundle(this.#secretStore),
        );
    }

    #rejectGeminiRuntime(runtimeId: AiRuntimeId): void {
        if (runtimeId !== "gemini") {
            return;
        }

        this.#onRuntimeStatus(createRemovedGeminiRuntimeStatus());
        throw new Error(GEMINI_ACP_REMOVED_MESSAGE);
    }

    async #saveCodexAuthSettings(
        settings: CodexRuntimeSettings,
        secrets: readonly SecretRecordPatch[],
    ): Promise<void> {
        if (this.#settingsService.saveCodexAuth) {
            await this.#settingsService.saveCodexAuth(settings, secrets);
            this.#secretStore.cacheSecretPatches?.(secrets);
            return;
        }

        await this.#saveSecretPatches(secrets);
        this.#settingsService.saveCodexRuntimeSettings(settings);
    }

    async #saveClaudeAuthSettings(
        settings: ReturnType<SettingsGateway["loadClaudeRuntimeSettings"]>,
        secrets: readonly SecretRecordPatch[],
    ): Promise<void> {
        if (this.#settingsService.saveClaudeAuth) {
            await this.#settingsService.saveClaudeAuth(settings, secrets);
            this.#secretStore.cacheSecretPatches?.(secrets);
            return;
        }

        await this.#saveSecretPatches(secrets);
        this.#settingsService.saveClaudeRuntimeSettings(settings);
    }

    async #saveGrokAuthSettings(
        settings: GrokRuntimeSettings,
        secrets: readonly SecretRecordPatch[] = [],
    ): Promise<void> {
        if (this.#settingsService.saveGrokAuth) {
            await this.#settingsService.saveGrokAuth(settings, secrets);
            this.#secretStore.cacheSecretPatches?.(secrets);
            return;
        }

        await this.#saveSecretPatches(secrets);
        this.#settingsService.saveGrokRuntimeSettings(settings);
    }

    async #saveKiloAuthSettings(
        settings: ReturnType<SettingsGateway["loadKiloRuntimeSettings"]>,
        secrets: readonly SecretRecordPatch[] = [],
    ): Promise<void> {
        if (this.#settingsService.saveKiloAuth) {
            await this.#settingsService.saveKiloAuth(settings, secrets);
            this.#secretStore.cacheSecretPatches?.(secrets);
            return;
        }

        await this.#saveSecretPatches(secrets);
        this.#settingsService.saveKiloRuntimeSettings(settings);
    }

    async #saveOpenCodeAuthSettings(
        settings: ReturnType<SettingsGateway["loadOpenCodeRuntimeSettings"]>,
        secrets: readonly SecretRecordPatch[] = [],
    ): Promise<void> {
        if (this.#settingsService.saveOpenCodeAuth) {
            await this.#settingsService.saveOpenCodeAuth(settings, secrets);
            this.#secretStore.cacheSecretPatches?.(secrets);
            return;
        }

        await this.#saveSecretPatches(secrets);
        this.#settingsService.saveOpenCodeRuntimeSettings(settings);
    }

    async #saveSecretPatches(
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
    }

    #withPersistedRuntimeCatalog(status: AiRuntimeStatus): AiRuntimeStatus {
        const catalog = this.#persistence.loadLatestRuntimeCatalog(
            status.runtimeId,
        );

        if (!catalog) {
            return status;
        }

        return {
            ...status,
            availableCommands: catalog.availableCommands,
            configOptions: catalog.configOptions,
            modeId: catalog.modeId,
            modes: catalog.modes,
            modelId: catalog.modelId,
            models: catalog.models,
        };
    }

    async #resolveGrokRuntimeStatusWithProbe(
        status: AiRuntimeStatus,
    ): Promise<AiRuntimeStatus> {
        if (
            status.state !== "ready" ||
            status.authReady ||
            status.authCredentialSource === "environment" ||
            status.authCredentialSource === "comando-secret"
        ) {
            return status;
        }

        const settings = this.#settingsService.loadGrokRuntimeSettings();
        const hasCachedToken = await probeGrokCachedTokenAuth(
            settings,
            this.#secretStore,
        );
        if (!hasCachedToken) {
            return status;
        }

        const nextSettings = {
            ...settings,
            authInvalidatedAtMs: null,
            authMethod: "grok-login",
        } satisfies GrokRuntimeSettings;
        await this.#saveGrokAuthSettings(nextSettings);

        return this.#withPersistedRuntimeCatalog(
            getGrokRuntimeStatus(nextSettings, this.#secretStore),
        );
    }

    async #hydrateGrokRuntimeAuthBeforeLaunch(
        runtimeId: AiRuntimeId,
    ): Promise<void> {
        if (runtimeId !== "grok") {
            return;
        }

        await this.#resolveGrokRuntimeStatusWithProbe(
            this.#resolveRuntimeStatus(runtimeId),
        );
    }

    #resolveRuntimeCommand(
        runtimeId: AiRuntimeId,
        codexSettingsOverride?: CodexRuntimeSettings,
    ): ResolvedAcpRuntime {
        if (runtimeId === "claude") {
            const settings = this.#settingsService.loadClaudeRuntimeSettings();
            const resolved = resolveClaudeRuntime(settings, this.#secretStore);

            return {
                args: resolved.args,
                command: resolved.command,
                env: applyClaudeAuthEnv(
                    process.env,
                    settings,
                    this.#secretStore,
                ),
                executable: resolved.program,
                status: resolved.status,
            };
        }

        this.#rejectGeminiRuntime(runtimeId);

        if (runtimeId === "grok") {
            const settings = this.#settingsService.loadGrokRuntimeSettings();
            const resolved = resolveGrokRuntime(settings, this.#secretStore);

            return {
                args: resolved.args,
                authHandshake: {
                    envMethodId: "xai.api_key",
                    externalMethodId: "cached_token",
                    meta: {
                        headless: true,
                    },
                },
                command: resolved.command,
                env: buildRuntimeSpawnEnv(
                    applyGrokAuthEnv(process.env, settings, this.#secretStore),
                    resolved.program,
                ),
                executable: resolved.program,
                status: resolved.status,
            };
        }

        if (runtimeId === "kilo") {
            const settings = this.#settingsService.loadKiloRuntimeSettings();
            const resolved = resolveKiloRuntime(settings, this.#secretStore);

            return {
                args: resolved.args,
                command: resolved.command,
                env: buildRuntimeSpawnEnv(
                    applyKiloAuthEnv(process.env, settings, this.#secretStore),
                    resolved.program,
                ),
                executable: resolved.program,
                status: resolved.status,
            };
        }

        if (runtimeId === "opencode") {
            const settings =
                this.#settingsService.loadOpenCodeRuntimeSettings();
            const resolved = resolveOpenCodeRuntime(
                settings,
                this.#secretStore,
            );

            return {
                args: resolved.args,
                command: resolved.command,
                env: buildRuntimeSpawnEnv(
                    applyOpenCodeAuthEnv(
                        process.env,
                        settings,
                        this.#secretStore,
                    ),
                    resolved.program,
                ),
                executable: resolved.program,
                status: resolved.status,
            };
        }

        const settings =
            codexSettingsOverride ??
            this.#settingsService.loadCodexRuntimeSettings();
        const secrets = loadCodexSecretBundle(this.#secretStore);
        const resolved = resolveCodexRuntime(settings);

        return {
            args: resolved.args,
            command: resolved.command,
            env: applyCodexAuthEnv(process.env, settings, secrets),
            executable: resolved.executable,
            status: getCodexRuntimeStatus(settings, secrets),
        };
    }

    async #runRuntimeAuthConnection(
        runtimeId: AiRuntimeId,
        cwd: string,
        action: (connection: ClientSideConnection) => Promise<void>,
        codexSettingsOverride?: CodexRuntimeSettings,
    ): Promise<void> {
        const resolvedRuntime = this.#resolveRuntimeCommand(
            runtimeId,
            codexSettingsOverride,
        );
        if (resolvedRuntime.status.state !== "ready") {
            throw new Error(
                resolvedRuntime.status.message ??
                    `${getRuntimeDisplayName(runtimeId)} is not available on this machine.`,
            );
        }

        const runtimeSpawn = prepareCommandForSpawn(
            resolvedRuntime.executable,
            resolvedRuntime.args,
            {
                cwd,
                env: resolvedRuntime.env,
                stdio: ["pipe", "pipe", "pipe"] as [
                    "pipe",
                    "pipe",
                    "pipe",
                ],
            },
        );
        const child = spawn(
            runtimeSpawn.command,
            runtimeSpawn.args,
            runtimeSpawn.options,
        );
        const stderrChunks: string[] = [];
        const stderrHandler = (chunk: Buffer | string) => {
            const text =
                typeof chunk === "string" ? chunk : chunk.toString("utf8");
            stderrChunks.push(text);
            if (stderrChunks.length > 20) {
                stderrChunks.shift();
            }
        };
        child.stderr.on("data", stderrHandler);
        let removeSpawnErrorHandler = () => {};
        const spawnErrorPromise = new Promise<never>((_, reject) => {
            const spawnErrorHandler = (error: Error) => {
                debugBenignError("ai.service.runtimeAuth.process", error);
                reject(error);
            };
            child.once("error", spawnErrorHandler);
            removeSpawnErrorHandler = () => {
                child.off("error", spawnErrorHandler);
            };
        });

        const client: Client = {
            readTextFile: () => {
                throw new Error("Runtime auth does not support file reads.");
            },
            requestPermission: () => {
                throw new Error(
                    "Runtime auth does not support permission requests.",
                );
            },
            sessionUpdate: () => Promise.resolve(undefined),
            writeTextFile: () => {
                throw new Error("Runtime auth does not support file writes.");
            },
        };
        const stream = ndJsonStream(
            toWebByteWritable(child.stdin),
            toWebByteReadable(child.stdout),
        );
        const connection = new ClientSideConnection(() => client, stream);

        try {
            await Promise.race([action(connection), spawnErrorPromise]);
        } catch (error) {
            const stderrText = getRecentStderrText(stderrChunks);

            if (error instanceof Error && error.message.trim()) {
                throw error;
            }

            throw new Error(
                stderrText ||
                    `Failed to complete ${getRuntimeDisplayName(runtimeId)} authentication.`,
                {
                    cause: error,
                },
            );
        } finally {
            removeSpawnErrorHandler();
            child.stderr.off("data", stderrHandler);
            child.kill();
            child.stdin.destroy();
            child.stdout.destroy();
            child.stderr.destroy();
        }
    }

    #invalidateRuntimeAuthIfNeeded(
        runtimeId: AiRuntimeId,
        message: string,
    ): void {
        if (runtimeId === "codex" && isCodexAuthenticationError(message)) {
            const currentSettings =
                this.#settingsService.loadCodexRuntimeSettings();
            const nextSettings = {
                ...currentSettings,
                authMethod: null,
            } satisfies CodexRuntimeSettings;
            this.#settingsService.saveCodexRuntimeSettings(nextSettings);
            this.#onRuntimeStatus(
                getCodexRuntimeStatus(
                    nextSettings,
                    loadCodexSecretBundle(this.#secretStore),
                ),
            );
            return;
        }

        if (runtimeId === "claude" && isClaudeAuthenticationError(message)) {
            const nextSettings = markClaudeAuthInvalidated(
                this.#settingsService.loadClaudeRuntimeSettings(),
            );
            this.#settingsService.saveClaudeRuntimeSettings(nextSettings);
            this.#onRuntimeStatus(
                getClaudeRuntimeStatus(nextSettings, this.#secretStore),
            );
            return;
        }

        if (runtimeId === "grok" && isGrokAuthenticationError(message)) {
            const currentSettings =
                this.#settingsService.loadGrokRuntimeSettings();
            const currentStatus = getGrokRuntimeStatus(
                currentSettings,
                this.#secretStore,
            );

            if (currentStatus.authCredentialSource === "external-runtime") {
                const nextSettings = markGrokAuthInvalidated({
                    ...currentSettings,
                    authMethod: "grok-login",
                });
                this.#settingsService.saveGrokRuntimeSettings(nextSettings);
                this.#onRuntimeStatus(
                    this.#withPersistedRuntimeCatalog(
                        getGrokRuntimeStatus(nextSettings, this.#secretStore),
                    ),
                );
                return;
            }

            if (currentStatus.authCredentialSource !== "comando-secret") {
                return;
            }

            const secretPatch = buildGrokSecretPatches(this.#secretStore, {
                xaiApiKey: null,
            });
            const nextSettings = {
                ...currentSettings,
                authMethod: null,
                hasXaiApiKey: secretPatch.flags.hasXaiApiKey,
            } satisfies GrokRuntimeSettings;
            this.#secretStore.cacheSecretPatches?.(secretPatch.patches);
            void this.#saveSecretPatches(secretPatch.patches).catch(
                (error: unknown) => {
                    debugBenignError("ai.grok.invalidateStoredApiKey", error);
                },
            );
            this.#settingsService.saveGrokRuntimeSettings(nextSettings);
            this.#onRuntimeStatus(
                this.#withPersistedRuntimeCatalog(
                    getGrokRuntimeStatus(nextSettings, this.#secretStore),
                ),
            );
            return;
        }

        if (runtimeId === "kilo" && isKiloAuthenticationError(message)) {
            const nextSettings = markKiloAuthInvalidated({
                ...this.#settingsService.loadKiloRuntimeSettings(),
                authMethod: "kilo-login",
            });
            this.#settingsService.saveKiloRuntimeSettings(nextSettings);
            this.#onRuntimeStatus(
                getKiloRuntimeStatus(nextSettings, this.#secretStore),
            );
            return;
        }

        if (
            runtimeId === "opencode" &&
            isOpenCodeAuthenticationError(message)
        ) {
            const nextSettings = markOpenCodeAuthInvalidated({
                ...this.#settingsService.loadOpenCodeRuntimeSettings(),
                authMethod: "opencode-login",
            });
            this.#settingsService.saveOpenCodeRuntimeSettings(nextSettings);
            this.#onRuntimeStatus(
                getOpenCodeRuntimeStatus(nextSettings, this.#secretStore),
            );
        }
    }
}

function normalizeOptionalText(value: string | null): string | null {
    const trimmed = value?.trim() ?? "";
    return trimmed.length > 0 ? trimmed : null;
}

function normalizeSessionRef(value: string | null | undefined): string | null {
    const trimmed = value?.trim() ?? "";
    return trimmed.length > 0 ? trimmed : null;
}

function applySecretValuePatch(
    currentValue: string | null,
    patch: SecretValuePatch,
): string | null {
    if (patch.kind === "clear") {
        return null;
    }

    if (patch.kind === "set") {
        return normalizeOptionalText(patch.value);
    }

    return currentValue;
}

function resolveCodexSecretBundle(
    currentSecrets: CodexSecretBundle,
    settings: CodexRuntimeSettingsInput,
): CodexSecretBundle {
    let codexApiKey = applySecretValuePatch(
        currentSecrets.codexApiKey,
        settings.codexApiKey,
    );
    let openaiApiKey = applySecretValuePatch(
        currentSecrets.openaiApiKey,
        settings.openaiApiKey,
    );

    if (settings.authMethod === "codex-api-key") {
        openaiApiKey = null;
    } else if (settings.authMethod === "openai-api-key") {
        codexApiKey = null;
    } else if (settings.authMethod === "chatgpt") {
        codexApiKey = null;
        openaiApiKey = null;
    }

    return {
        codexApiKey,
        openaiApiKey,
    };
}

function parseSecretStorageKey(key: string): {
    readonly namespace: string;
    readonly secretId: string;
} {
    const prefix = "secret.";
    if (!key.startsWith(prefix)) {
        throw new Error(`Invalid secret storage key: ${key}`);
    }

    const keyBody = key.slice(prefix.length);
    const separatorIndex = keyBody.lastIndexOf(".");
    if (separatorIndex <= 0 || separatorIndex === keyBody.length - 1) {
        throw new Error(`Invalid secret storage key: ${key}`);
    }

    return {
        namespace: keyBody.slice(0, separatorIndex),
        secretId: keyBody.slice(separatorIndex + 1),
    };
}

function getRetentionSkippedReasonFromSnapshot(
    snapshot: AiSessionSnapshot,
): AiSessionFreezeSkippedReason | null {
    if (snapshot.status === "starting" || snapshot.status === "streaming") {
        return "active_turn";
    }

    if (snapshot.pendingPermission || snapshot.status === "waiting_permission") {
        return "pending_permission";
    }

    if (snapshot.pendingUserInput || snapshot.status === "waiting_user_input") {
        return "pending_user_input";
    }

    if (
        snapshot.trackedFiles.some(
            (trackedFile) => trackedFile.reviewState === "pending",
        )
    ) {
        return "pending_review";
    }

    return null;
}

function trimRetentionRecords<T>(records: T[]): void {
    const maxRecords = 50;
    if (records.length > maxRecords) {
        records.splice(0, records.length - maxRecords);
    }
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
    if (typeof timer.unref === "function") {
        timer.unref();
    }
}

export const __testing = {
    computeDiffHunks,
    diffToAiFileDiff,
    mapToolCallUpdate,
    normalizeTrackedDiffPath,
    parseCompleteNumberedFileOutput,
    resolveDiffToFullTexts,
    resolveTrackedFileHunks,
    shouldSuppressToolActivityUpdate,
    upsertTrackedFile,
};
