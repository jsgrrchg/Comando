import path from "node:path";
import fs from "node:fs";
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
    AiFileDiff,
    AiMessage,
    AiPermissionResponseInput,
    AiPromptResult,
    PrepareAiSessionInput,
    AiRuntimeAuthLaunchInput,
    AiRuntimeAuthDisconnectInput,
    AiRuntimeAuthLogoutInput,
    AiRuntimeId,
    AiRuntimeStatus,
    AiSessionDomainEvent,
    AiSessionConfigOption,
    AiSessionConfigOptionMutationInput,
    AiSessionModeMutationInput,
    AiSessionModelMutationInput,
    AiSessionPinnedMutationInput,
    AiSessionUpdate,
    AiSessionRenameMutationInput,
    AiSessionSnapshot,
    AiToolActivity,
    AiSessionTranscriptPage,
    AiTrackedFileHunkMutationInput,
    AiTrackedFileMutationInput,
    AiTrackedFile,
    AiUserInputResponseInput,
    ClaudeRuntimeSettingsInput,
    CodexRuntimeSettingsInput,
    CodexRuntimeSettings,
    GrokRuntimeSettings,
    GrokRuntimeSettingsInput,
    GetAiSessionTranscriptPageInput,
    FileBufferNotificationInput,
    KiloRuntimeSettingsInput,
    ListAiSessionHistoryInput,
    OpenCodeRuntimeSettingsInput,
    SecretValuePatch,
    SendAiPromptInput,
} from "@shared/ipc";
import {
    computeDiffHunks,
    getTrackedFileCurrentText,
    getTrackedFileDiffBase,
    isAiTrackedFileUnresolved,
    normalizeReviewText,
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
    type PersistedRuntimeCatalogSnapshot,
} from "./persistence";
import { createAiEnvironmentDiagnostics } from "./environment-diagnostics";
import { listOpenFileBuffers, readOpenFileBuffer } from "./openFileBuffers";
import {
    type AiReviewMutationResult,
    type AiReviewSessionContext,
    type AiRuntimeSessionMapping,
    type AiSessionLaunchInput,
    type AiSchedulerConfig,
    type AiSessionFreezeReason,
    type AiSessionFreezeSkippedReason,
    type AiSessionRetentionConfig,
    type AiServiceOptions,
    type NativeAiGateway,
    type NativeAiSecretPatchRpcInput,
    type NativeAiRuntimeSettingsRpcInput,
    type ResolvedAcpRuntime,
    type SessionDescriptor,
} from "./contracts";
import {
    applyNormalizedSessionCatalogToSnapshot,
    buildAiSessionUpdate,
    getModeConfigOption,
    getModelConfigOption,
    getRecentStderrText,
    getRuntimeDisplayName,
    hasSelectConfigValue,
    isPathInsideRoot,
    isSamePath,
    normalizeAdditionalRoots,
    normalizeRestoredAiSessionSnapshot,
    resolveSessionScopedPath,
    setConfigOptionOnSnapshot,
    setModeOnSnapshot,
    setModelOnSnapshot,
    setTitleOnSnapshot,
    type NormalizedSessionCatalogPayload,
} from "./session-core";
import {
    diffToAiFileDiff,
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

interface NativeReviewBaseline {
    readonly additionalRoots: readonly string[];
    readonly cwd: string;
    readonly messageId: string;
    readonly nativeCaptured: boolean;
    readonly promptAccepted: boolean;
    readonly terminalStatusSeen: boolean;
    readonly turnStarted: boolean;
}

interface RecentNativeReviewContext {
    readonly additionalRoots: readonly string[];
    readonly cwd: string;
    readonly expiresAtMs: number;
}

type NativeAiReviewGateway = NativeAiGateway &
    Required<
        Pick<
            NativeAiGateway,
            | "captureReviewBaseline"
            | "keepAllTrackedFiles"
            | "keepTrackedFile"
            | "keepTrackedFileHunks"
            | "reconcileTrackedFiles"
            | "rejectAllTrackedFiles"
            | "rejectTrackedFile"
            | "rejectTrackedFileHunks"
        >
    >;

const DEFAULT_AI_SCHEDULER_CONFIG: AiSchedulerConfig = {
    maxColdStartsGlobal: 3,
    maxColdStartsPerRuntime: 1,
};

const DEFAULT_AI_SESSION_RETENTION_CONFIG: AiSessionRetentionConfig = {
    idleTtlMs: 15 * 60 * 1000,
    maxHotSessionsPerWindow: 6,
};
const RECENT_NATIVE_REVIEW_CONTEXT_TTL_MS = 60_000;

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

interface PendingNativeCatalogPatch {
    readonly ownerWindowId: string;
    readonly patch: NormalizedSessionCatalogPayload;
    readonly updatedAt: string;
}

export class AiService {
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
    #nativeAi: NativeAiGateway | null;
    readonly #nativeAuthMigratedRuntimeIds = new Set<AiRuntimeId>();
    readonly #nativeChildParentSessionIds = new Map<string, string>();
    readonly #pendingNativeCatalogPatches = new Map<
        string,
        PendingNativeCatalogPatch[]
    >();
    readonly #nativeReviewBaselines = new Map<string, NativeReviewBaseline>();
    readonly #recentNativeReviewContexts = new Map<
        string,
        RecentNativeReviewContext
    >();
    readonly #nativeReviewReconciliations = new Set<string>();
    readonly #nativeSessionIds = new Set<string>();
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
        this.#nativeAi = options.nativeAi ?? null;
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

    setNativeAiGateway(nativeAi: NativeAiGateway | null): void {
        this.#nativeAi = nativeAi;
    }

    close(): void {
        this.#clearSessionRetentionTimer();
        void Promise.resolve(this.#nativeAi?.close()).catch((error: unknown) => {
            debugBenignError("ai.service.close.native", error);
        });
        this.#nativeReviewBaselines.clear();
        this.#recentNativeReviewContexts.clear();
        this.#nativeReviewReconciliations.clear();
        this.#nativeSessionIds.clear();
        this.#pendingNativeCatalogPatches.clear();
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

    handleNativeRuntimeStatus(status: AiRuntimeStatus): void {
        this.#onRuntimeStatus(status);
    }

    handleNativeSessionClosed(payload: {
        readonly ownerWindowId: string;
        readonly sessionId: string;
    }): void {
        this.#clearLiveSession(payload.sessionId);
    }

    handleNativeSessionSnapshot(
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

        const snapshot = this.#resolveSnapshotFromNativeUpdate(update);
        if (!snapshot) {
            return;
        }

        const previousSnapshot = this.#liveSnapshots.get(sessionId) ?? null;
        const nextSnapshot = this.#drainPendingNativeCatalogPatches(
            this.#preservePassiveNativeSnapshotTrackedFiles(
                this.#hydrateSnapshotRuntimeCatalog(snapshot),
                previousSnapshot,
            ),
            ownerWindowId,
        );
        this.#cacheLiveSessionSnapshot(nextSnapshot, ownerWindowId);
        this.#persistence.saveSessionSnapshot(nextSnapshot);
        if (nextSnapshot.lastError) {
            this.#invalidateRuntimeAuthIfNeeded(
                nextSnapshot.runtimeId,
                nextSnapshot.lastError,
            );
        }
        this.#onSessionSnapshot(
            ownerWindowId,
            buildAiSessionUpdate(previousSnapshot, nextSnapshot),
        );
    }

    notifyFileBuffer(input: FileBufferNotificationInput): void {
        void this.#nativeAi?.notifyFileBuffer?.(input).catch((error: unknown) => {
            debugBenignError("ai.service.nativeNotifyFileBuffer", error);
        });
    }

    handleNativeSessionEvent(
        ownerWindowId: string,
        event: AiSessionDomainEvent,
    ): void {
        if (this.#deletedSessionIds.has(event.sessionId)) {
            return;
        }

        const previousSnapshot = this.#liveSnapshots.get(event.sessionId);
        if (previousSnapshot) {
            const nextSnapshot = this.#applyNativeSessionEvent(
                previousSnapshot,
                event,
            );
            this.#cacheLiveSessionSnapshot(nextSnapshot, ownerWindowId);
            this.#onSessionSnapshot(
                ownerWindowId,
                buildAiSessionUpdate(previousSnapshot, nextSnapshot),
            );
            if (nextSnapshot.lastError) {
                this.#invalidateRuntimeAuthIfNeeded(
                    nextSnapshot.runtimeId,
                    nextSnapshot.lastError,
                );
            }
            if (this.#isNativeAiSession(event.sessionId)) {
                if (event.kind === "status" && event.status === "streaming") {
                    this.#markNativeReviewTurnStarted(event.sessionId);
                }
                if (
                    event.kind === "status" &&
                    (event.status === "idle" || event.status === "error")
                ) {
                    this.#markNativeReviewTerminalStatusSeen(event.sessionId);
                }
            }
            if (this.#shouldReconcileNativeReviewFiles(event)) {
                void this.#reconcileNativeReviewFiles(
                    event.sessionId,
                    ownerWindowId,
                ).catch((error: unknown) => {
                    debugBenignError("ai.service.nativeReviewReconcile", error);
                });
            }
        }

        if (!previousSnapshot && event.kind === "subagent-created") {
            const parentSnapshot = this.#liveSnapshots.get(event.parentSessionId);
            if (parentSnapshot) {
                const childSnapshot: AiSessionSnapshot = {
                    ...parentSnapshot,
                    activeTurnStartedAt: null,
                    closedAt: null,
                    lastError: null,
                    messages: [],
                    parentSessionId: event.parentSessionId,
                    pendingPermission: null,
                    pendingUserInput: null,
                    plan: null,
                    runtimeSessionId:
                        event.childRuntimeSessionId ?? event.runtimeSessionId,
                    sessionId: event.childSessionId,
                    status: "idle",
                    title: event.title,
                    tokenUsage: null,
                    toolActivity: [],
                    trackedFiles: [],
                    updatedAt: event.updatedAt,
                };
                this.#cacheLiveSessionSnapshot(childSnapshot, ownerWindowId);
                this.#nativeSessionIds.add(event.childSessionId);
                this.#nativeChildParentSessionIds.set(
                    event.childSessionId,
                    event.parentSessionId,
                );
                this.#onSessionSnapshot(ownerWindowId, {
                    kind: "snapshot",
                    snapshot: childSnapshot,
                });
            }
        }

        this.#onSessionEvent(ownerWindowId, event);
    }

    handleNativeSessionCatalogPatch(
        ownerWindowId: string,
        sessionId: string,
        patch: NormalizedSessionCatalogPayload,
        updatedAt: string,
    ): void {
        if (this.#deletedSessionIds.has(sessionId)) {
            return;
        }

        const previousSnapshot = this.#liveSnapshots.get(sessionId);
        if (!previousSnapshot) {
            const pending =
                this.#pendingNativeCatalogPatches.get(sessionId) ?? [];
            this.#pendingNativeCatalogPatches.set(sessionId, [
                ...pending,
                {
                    ownerWindowId,
                    patch,
                    updatedAt,
                },
            ]);
            return;
        }

        this.#applyNativeCatalogPatchToLiveSnapshot(
            ownerWindowId,
            previousSnapshot,
            patch,
            updatedAt,
            { emitUpdate: true },
        );
        this.#scheduleLiveSelectionPreferenceReconciliation(
            ownerWindowId,
            sessionId,
        );
    }

    async handleNativeRestarted(): Promise<void> {
        const nativeAi = this.#requireNativeAiGateway();
        if (!nativeAi.notifyFileBuffer) {
            return;
        }

        await Promise.all(
            listOpenFileBuffers().map(async (buffer) => {
                await nativeAi.notifyFileBuffer?.(buffer);
            }),
        );
    }

    async getRuntimeStatus(runtimeId: AiRuntimeId): Promise<AiRuntimeStatus> {
        const nativeAi = this.#nativeAuthGateway(runtimeId);
        if (nativeAi?.getRuntimeStatus) {
            await this.#migrateNativeRuntimeSettingsIfNeeded(runtimeId);
            const status = this.#withPersistedRuntimeCatalog(
                await nativeAi.getRuntimeStatus(runtimeId),
            );
            this.#onRuntimeStatus(status);
            return status;
        }

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
        const nativeStatus = await this.#saveNativeRuntimeSettingsIfEnabled({
            runtimeId: "codex",
            settings: {
                authMethod: nextSettings.authMethod,
                binaryPath: nextSettings.binaryPath,
            },
            secretPatches: [
                ...nativeSecretPatchesFromValuePatch(
                    "CODEX_API_KEY",
                    settings.codexApiKey,
                    nextSecrets.codexApiKey,
                ),
                ...nativeSecretPatchesFromValuePatch(
                    "OPENAI_API_KEY",
                    settings.openaiApiKey,
                    nextSecrets.openaiApiKey,
                ),
            ],
        });
        if (nativeStatus) {
            this.#onRuntimeStatus(nativeStatus);
            return nativeStatus;
        }
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
        const nativeStatus = await this.#saveNativeRuntimeSettingsIfEnabled({
            runtimeId: "claude",
            settings: {
                authInvalidatedAtMs: nextSettings.authInvalidatedAtMs,
                authMethod: nextSettings.authMethod,
                bedrockGatewayBaseUrl: nextSettings.bedrockGatewayBaseUrl,
                binaryPath: nextSettings.binaryPath,
                gatewayBaseUrl: nextSettings.gatewayBaseUrl,
            },
            secretPatches: [
                ...nativeSecretPatchesFromValuePatch(
                    "ANTHROPIC_API_KEY",
                    settings.anthropicApiKey,
                    anthropicApiKey,
                ),
                ...nativeSecretPatchesFromValuePatch(
                    "ANTHROPIC_AUTH_TOKEN",
                    settings.gatewayAuthToken,
                    gatewayAuthToken,
                ),
                ...nativeSecretPatchesFromValuePatch(
                    "ANTHROPIC_CUSTOM_HEADERS",
                    settings.gatewayCustomHeaders,
                    gatewayCustomHeaders,
                ),
            ],
        });
        if (nativeStatus) {
            this.#onRuntimeStatus(nativeStatus);
            return nativeStatus;
        }
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
        const nativeStatus = await this.#saveNativeRuntimeSettingsIfEnabled({
            runtimeId: "grok",
            settings: {
                authInvalidatedAtMs: persistedSettings.authInvalidatedAtMs,
                authMethod: persistedSettings.authMethod,
                binaryPath: persistedSettings.binaryPath,
            },
            secretPatches: nativeSecretPatchesFromValuePatch(
                "XAI_API_KEY",
                settings.xaiApiKey,
                xaiApiKey,
            ),
        });
        if (nativeStatus) {
            this.#onRuntimeStatus(nativeStatus);
            return nativeStatus;
        }
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
        const nativeStatus = await this.#saveNativeRuntimeSettingsIfEnabled({
            runtimeId: "kilo",
            settings: {
                authInvalidatedAtMs: nextSettings.authInvalidatedAtMs,
                authMethod: nextSettings.authMethod,
                binaryPath: nextSettings.binaryPath,
            },
            secretPatches: nativeSecretPatchesFromValuePatch(
                "KILO_API_KEY",
                settings.kiloApiKey,
                kiloApiKey,
            ),
        });
        if (nativeStatus) {
            this.#onRuntimeStatus(nativeStatus);
            return nativeStatus;
        }
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
        const nativeStatus = await this.#saveNativeRuntimeSettingsIfEnabled({
            runtimeId: "opencode",
            settings: {
                authInvalidatedAtMs: nextSettings.authInvalidatedAtMs,
                authMethod: nextSettings.authMethod,
                binaryPath: nextSettings.binaryPath,
            },
        });
        if (nativeStatus) {
            this.#onRuntimeStatus(nativeStatus);
            return nativeStatus;
        }
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
            await this.#loadPersistedSessionSnapshot(sessionId);
        return persistedSnapshot
            ? this.#hydrateSnapshotRuntimeCatalog(
                  await this.#reconcilePersistedTrackedFiles(persistedSnapshot),
              )
            : null;
    }

    async listSessionHistory(
        input: ListAiSessionHistoryInput,
    ): Promise<readonly AiHistorySessionSummary[]> {
        if (this.#nativeAi?.shouldHandleHistory()) {
            return await this.#nativeAi.listSessionHistory(input);
        }
        return await this.#persistence.listSessionHistory(input);
    }

    async setSessionPinned(
        input: AiSessionPinnedMutationInput,
    ): Promise<void> {
        if (this.#nativeAi?.shouldHandleHistory()) {
            await this.#nativeAi.setSessionPinned(input);
            return;
        }
        await this.#persistence.setSessionPinned(
            input.sessionId,
            input.pinned,
        );
    }

    async getSessionTranscriptPage(
        input: GetAiSessionTranscriptPageInput,
    ): Promise<AiSessionTranscriptPage> {
        if (this.#nativeAi?.shouldHandleHistory()) {
            const nativePage =
                await this.#nativeAi.loadSessionTranscriptPage(input);
            if (nativePage) {
                return nativePage;
            }
            throw new Error("The session could not be found.");
        }
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
        const launch = await this.#buildNativeSessionLaunchInput(
            input,
            ownerWindowId,
        );
        const nativeAi = this.#requireNativeAiGatewayForRuntime(
            input.runtimeId,
        );
        this.#rememberLiveSessionContext(
            input,
            ownerWindowId,
            launch.additionalRoots,
            launch.persistedSnapshot.parentSessionId ?? null,
        );

        const nativePrepareLaunch =
            await this.#buildNativePrepareLaunchForSession(
                input,
                ownerWindowId,
                launch,
            );
        const isSubagentPrepare =
            nativePrepareLaunch.input.sessionId !== input.sessionId;
        try {
            const snapshot = await this.#scheduleNativeSessionStartup(
                launch,
                1,
                async () => {
                    this.#assertScheduledSessionContextActive(
                        input.sessionId,
                        ownerWindowId,
                        input.runtimeId,
                    );
                    if (isSubagentPrepare) {
                        if (
                            !this.#nativeSessionIds.has(
                                nativePrepareLaunch.input.sessionId,
                            )
                        ) {
                            this.#rememberLiveSessionContext(
                                nativePrepareLaunch.input,
                                ownerWindowId,
                                nativePrepareLaunch.launch.additionalRoots,
                                nativePrepareLaunch.launch.persistedSnapshot
                                    .parentSessionId ?? null,
                            );
                            const parentSnapshot =
                                await nativeAi.prepareSession({
                                    input: nativePrepareLaunch.input,
                                    launch: nativePrepareLaunch.launch,
                                });
                            this.#nativeSessionIds.add(
                                parentSnapshot.sessionId,
                            );
                            this.#acceptPreparedLiveSnapshot(
                                parentSnapshot,
                                ownerWindowId,
                            );
                        }
                        this.#adoptNativeSubagentSnapshot(
                            launch.persistedSnapshot,
                            ownerWindowId,
                        );
                        return launch.persistedSnapshot;
                    }

                    return await nativeAi.prepareSession({ input, launch });
                },
            );
            this.#nativeSessionIds.add(snapshot.sessionId);
            const acceptedSnapshot = this.#acceptPreparedLiveSnapshot(
                snapshot,
                ownerWindowId,
            );
            const reconciledSnapshot =
                await this.#reconcileLiveSelectionPreferences(
                    acceptedSnapshot.sessionId,
                    ownerWindowId,
                );
            void this.#enforceSessionRetention();
            return reconciledSnapshot ?? acceptedSnapshot;
        } catch (error) {
            this.#nativeSessionIds.delete(input.sessionId);
            this.#discardPreparedSessionContextOnFailure(
                input.sessionId,
                ownerWindowId,
                input.runtimeId,
            );
            throw error;
        }
    }

    refreshProjectScopes(projectId: string): void {
        void projectId;
    }

    async sendPrompt(
        input: SendAiPromptInput,
        ownerWindowId: string,
    ): Promise<AiPromptResult> {
        const launch = await this.#buildNativeSessionLaunchInput(
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
        const nativeAi = this.#requireNativeAiGatewayForRuntime(
            input.runtimeId,
        );
        this.#rememberLiveSessionContext(
            input,
            ownerWindowId,
            launch.additionalRoots,
            launch.persistedSnapshot.parentSessionId ?? null,
        );

        const nativeSendState = {
            capturedReviewBaseline: false,
            preparedSessionContext: null as {
                readonly ownerWindowId: string;
                readonly runtimeId: AiRuntimeId;
                readonly sessionId: string;
            } | null,
        };
        const nativePrepareLaunch =
            await this.#buildNativePrepareLaunchForSession(
                input,
                ownerWindowId,
                launch,
            );
        try {
            const result = await this.#scheduleNativeSessionStartup(
                launch,
                0,
                async () => {
                    this.#assertScheduledSessionContextActive(
                        input.sessionId,
                        ownerWindowId,
                        input.runtimeId,
                    );
                    if (
                        !this.#nativeSessionIds.has(
                            nativePrepareLaunch.input.sessionId,
                        )
                    ) {
                        this.#rememberLiveSessionContext(
                            nativePrepareLaunch.input,
                            ownerWindowId,
                            nativePrepareLaunch.launch.additionalRoots,
                            nativePrepareLaunch.launch.persistedSnapshot
                                .parentSessionId ?? null,
                        );
                        const snapshot = await nativeAi.prepareSession({
                            input: nativePrepareLaunch.input,
                            launch: nativePrepareLaunch.launch,
                        });
                        this.#nativeSessionIds.add(snapshot.sessionId);
                        nativeSendState.preparedSessionContext = {
                            ownerWindowId,
                            runtimeId: nativePrepareLaunch.input.runtimeId,
                            sessionId: snapshot.sessionId,
                        };
                        this.#acceptPreparedLiveSnapshot(
                            snapshot,
                            ownerWindowId,
                        );
                        await this.#reconcileLiveSelectionPreferences(
                            snapshot.sessionId,
                            ownerWindowId,
                        );
                    }
                    this.#adoptNativeSubagentSnapshot(
                        launch.persistedSnapshot,
                        ownerWindowId,
                    );
                    if (!this.#nativeReviewBaselines.has(input.sessionId)) {
                        nativeSendState.capturedReviewBaseline =
                            await this.#captureNativeReviewBaseline(
                                input.sessionId,
                                launch,
                                input.messageId,
                            );
                    }
                    const promptResult = await nativeAi.sendPrompt({
                        input,
                        launch,
                    });
                    if (promptResult.stopReason === "accepted") {
                        const terminalStatusAlreadySeen =
                            this.#markNativeReviewPromptAccepted(
                                input.sessionId,
                            );
                        if (terminalStatusAlreadySeen) {
                            void this.#reconcileNativeReviewFiles(
                                input.sessionId,
                                ownerWindowId,
                            ).catch((error: unknown) => {
                                debugBenignError(
                                    "ai.service.nativeReviewReconcile",
                                    error,
                                );
                            });
                        }
                    }
                    return promptResult;
                },
            );
            void this.#enforceSessionRetention();
            return result;
        } catch (error) {
            if (nativeSendState.capturedReviewBaseline) {
                this.#nativeReviewBaselines.delete(input.sessionId);
                this.#recentNativeReviewContexts.delete(input.sessionId);
            }
            if (nativeSendState.preparedSessionContext) {
                this.#nativeSessionIds.delete(
                    nativeSendState.preparedSessionContext.sessionId,
                );
                this.#discardPreparedSessionContextOnFailure(
                    nativeSendState.preparedSessionContext.sessionId,
                    nativeSendState.preparedSessionContext.ownerWindowId,
                    nativeSendState.preparedSessionContext.runtimeId,
                );
            }
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

        await this.#requireNativeAiGateway().setSessionMode(input);
        const snapshot = await this.#updateSessionSnapshot(
            input.sessionId,
            (currentSnapshot) =>
                setModeOnSnapshot(currentSnapshot, input.modeId),
        );
        this.#persistence.saveRuntimeModePreference(
            snapshot.runtimeId,
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

        await this.#requireNativeAiGateway().setSessionModel(input);
        const snapshot = await this.#updateSessionSnapshot(
            input.sessionId,
            (currentSnapshot) =>
                setModelOnSnapshot(currentSnapshot, input.modelId),
        );
        this.#persistence.saveRuntimeModelPreference(
            snapshot.runtimeId,
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

        await this.#requireNativeAiGateway().setSessionConfigOption(input);
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
    }

    async renameSession(input: AiSessionRenameMutationInput): Promise<void> {
        if (this.#liveSessionContexts.has(input.sessionId)) {
            await this.#requireNativeAiGateway().renameSession(input);
            await this.#updateSessionSnapshot(input.sessionId, (snapshot) =>
                setTitleOnSnapshot(snapshot, input.title),
            );
            return;
        }

        if (this.#nativeAi?.shouldHandleHistory()) {
            await this.#nativeAi.renameSession(input);
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

        await this.#requireNativeAiGateway().cancelSession(sessionId);
    }

    async closeSession(sessionId: string): Promise<void> {
        if (!this.#liveSessionContexts.has(sessionId)) {
            return;
        }

        await this.#requireNativeAiGateway().closeSession(sessionId);
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
            if (this.#nativeAi?.shouldHandleHistory()) {
                await this.#nativeAi.deleteSession(sessionId);
                return;
            }
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

        Promise.resolve(this.#nativeAi?.closeOwnedByWindow(ownerWindowId)).catch(
            (error: unknown) => {
                debugBenignError("ai.service.closeOwnedByWindow.native", error);
            },
        );
        for (const sessionId of sessionIds) {
            this.#recordRetentionClose(sessionId, "window_close");
            this.#clearLiveSession(sessionId);
        }
    }

    async launchRuntimeAuth(input: AiRuntimeAuthLaunchInput): Promise<void> {
        const nativeAi = this.#nativeAuthGateway(input.runtimeId);
        if (nativeAi?.launchRuntimeAuth) {
            await nativeAi.launchRuntimeAuth(input);
            return;
        }

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
        const nativeAi = this.#nativeAuthGateway(input.runtimeId);
        if (nativeAi?.logoutRuntimeAuth) {
            const status = await nativeAi.logoutRuntimeAuth(input);
            this.#onRuntimeStatus(status);
            return status;
        }

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
        const nativeAi = this.#nativeAuthGateway(input.runtimeId);
        if (nativeAi?.disconnectRuntimeAuth) {
            const status = await nativeAi.disconnectRuntimeAuth(input);
            this.#onRuntimeStatus(status);
            return status;
        }

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
        return this.#requireNativeAiGateway().respondPermission(input);
    }

    async respondUserInput(input: AiUserInputResponseInput): Promise<void> {
        await this.#requireNativeAiGateway().respondUserInput(input);
    }

    #selectNativeAiGateway(runtimeId: AiRuntimeId): NativeAiGateway | null {
        if (!this.#nativeAi?.shouldHandleRuntime(runtimeId)) {
            return null;
        }

        return this.#nativeAi;
    }

    #nativeAuthGateway(runtimeId: AiRuntimeId): NativeAiGateway | null {
        return this.#selectNativeAiGateway(runtimeId);
    }

    async #saveNativeRuntimeSettingsIfEnabled(
        input: NativeAiRuntimeSettingsRpcInput,
    ): Promise<AiRuntimeStatus | null> {
        const nativeAi = this.#nativeAuthGateway(input.runtimeId);
        if (!nativeAi?.saveRuntimeSettings) {
            return null;
        }

        return await nativeAi.saveRuntimeSettings(input);
    }

    async #migrateNativeRuntimeSettingsIfNeeded(
        runtimeId: AiRuntimeId,
    ): Promise<void> {
        if (this.#nativeAuthMigratedRuntimeIds.has(runtimeId)) {
            return;
        }
        const nativeAi = this.#nativeAuthGateway(runtimeId);
        if (!nativeAi?.saveRuntimeSettings) {
            return;
        }
        const input = this.#legacyRuntimeSettingsForNative(runtimeId);
        if (!input) {
            this.#nativeAuthMigratedRuntimeIds.add(runtimeId);
            return;
        }
        await nativeAi.saveRuntimeSettings(input);
        this.#nativeAuthMigratedRuntimeIds.add(runtimeId);
    }

    #legacyRuntimeSettingsForNative(
        runtimeId: AiRuntimeId,
    ): NativeAiRuntimeSettingsRpcInput | null {
        switch (runtimeId) {
            case "codex": {
                const settings = this.#settingsService.loadCodexRuntimeSettings();
                return {
                    runtimeId,
                    settings: {
                        authMethod: settings.authMethod,
                        binaryPath: settings.binaryPath,
                    },
                    secretPatches: [
                        ...nativeSetSecretPatch(
                            "CODEX_API_KEY",
                            this.#secretStore.loadSecret(
                                "ai.codex",
                                "codex_api_key",
                            ),
                        ),
                        ...nativeSetSecretPatch(
                            "OPENAI_API_KEY",
                            this.#secretStore.loadSecret(
                                "ai.codex",
                                "openai_api_key",
                            ),
                        ),
                    ],
                };
            }
            case "claude": {
                const settings =
                    this.#settingsService.loadClaudeRuntimeSettings();
                return {
                    runtimeId,
                    settings: {
                        authInvalidatedAtMs: settings.authInvalidatedAtMs,
                        authMethod: settings.authMethod,
                        bedrockGatewayBaseUrl: settings.bedrockGatewayBaseUrl,
                        binaryPath: settings.binaryPath,
                        gatewayBaseUrl: settings.gatewayBaseUrl,
                    },
                    secretPatches: [
                        ...nativeSetSecretPatch(
                            "ANTHROPIC_API_KEY",
                            this.#secretStore.loadSecret(
                                "ai.claude",
                                "anthropic_api_key",
                            ),
                        ),
                        ...nativeSetSecretPatch(
                            "ANTHROPIC_AUTH_TOKEN",
                            this.#secretStore.loadSecret(
                                "ai.claude",
                                "anthropic_auth_token",
                            ),
                        ),
                        ...nativeSetSecretPatch(
                            "ANTHROPIC_CUSTOM_HEADERS",
                            this.#secretStore.loadSecret(
                                "ai.claude",
                                "anthropic_custom_headers",
                            ),
                        ),
                    ],
                };
            }
            case "grok": {
                const settings = this.#settingsService.loadGrokRuntimeSettings();
                return {
                    runtimeId,
                    settings: {
                        authInvalidatedAtMs: settings.authInvalidatedAtMs,
                        authMethod: settings.authMethod,
                        binaryPath: settings.binaryPath,
                    },
                    secretPatches: nativeSetSecretPatch(
                        "XAI_API_KEY",
                        this.#secretStore.loadSecret("ai.grok", "xai_api_key"),
                    ),
                };
            }
            case "kilo": {
                const settings = this.#settingsService.loadKiloRuntimeSettings();
                return {
                    runtimeId,
                    settings: {
                        authInvalidatedAtMs: settings.authInvalidatedAtMs,
                        authMethod: settings.authMethod,
                        binaryPath: settings.binaryPath,
                    },
                    secretPatches: nativeSetSecretPatch(
                        "KILO_API_KEY",
                        this.#secretStore.loadSecret("ai.kilo", "kilo_api_key"),
                    ),
                };
            }
            case "opencode": {
                const settings =
                    this.#settingsService.loadOpenCodeRuntimeSettings();
                return {
                    runtimeId,
                    settings: {
                        authInvalidatedAtMs: settings.authInvalidatedAtMs,
                        authMethod: settings.authMethod,
                        binaryPath: settings.binaryPath,
                    },
                };
            }
        }
    }

    #isNativeAiSession(sessionId: string): boolean {
        return this.#nativeSessionIds.has(sessionId);
    }

    #requireNativeAiGateway(): NativeAiGateway {
        if (!this.#nativeAi) {
            throw new Error("The native AI backend is not available.");
        }

        return this.#nativeAi;
    }

    #requireNativeAiGatewayForRuntime(runtimeId: AiRuntimeId): NativeAiGateway {
        const nativeAi = this.#selectNativeAiGateway(runtimeId);
        if (!nativeAi) {
            throw new Error(
                `${getRuntimeDisplayName(runtimeId)} is not supported by the native AI backend.`,
            );
        }

        return nativeAi;
    }

    #requireNativeReviewGateway(
        methodName: keyof NativeAiReviewGateway,
    ): NativeAiReviewGateway {
        const nativeAi = this.#requireNativeAiGateway();
        const method = nativeAi[methodName];
        if (
            nativeAi.shouldHandleReview?.() !== true ||
            typeof method !== "function"
        ) {
            throw new Error("The native AI review backend is not available.");
        }

        return nativeAi as NativeAiReviewGateway;
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
        const childSessionIds = [...this.#nativeChildParentSessionIds.entries()]
            .filter(([, parentSessionId]) => parentSessionId === sessionId)
            .map(([childSessionId]) => childSessionId);
        for (const childSessionId of childSessionIds) {
            this.#clearLiveSession(childSessionId);
        }
        this.#nativeChildParentSessionIds.delete(sessionId);
        this.#liveSnapshots.delete(sessionId);
        this.#liveSessionContexts.delete(sessionId);
        this.#liveSessionTouches.delete(sessionId);
        this.#freezingSessionIds.delete(sessionId);
        this.#nativeReviewBaselines.delete(sessionId);
        this.#recentNativeReviewContexts.delete(sessionId);
        this.#nativeReviewReconciliations.delete(sessionId);
        this.#nativeSessionIds.delete(sessionId);
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
            await this.#requireNativeAiGateway().closeSession(sessionId);
            this.#recordRetentionClose(sessionId, reason);
            this.#clearLiveSession(sessionId);
        } catch (error) {
            this.#deferSessionRetentionRetry(sessionId);
            debugBenignError("ai.service.freezeNativeSession", error);
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

    #isColdNativeSessionLaunch(launch: AiSessionLaunchInput): boolean {
        return !this.#liveSnapshots.has(launch.input.sessionId);
    }

    async #scheduleNativeSessionStartup<T>(
        launch: AiSessionLaunchInput,
        priority: AiSchedulerPriority,
        run: () => Promise<T>,
        options: { readonly forceColdStart?: boolean } = {},
    ): Promise<T> {
        return await this.#scheduler.schedule(
            {
                coldStart:
                    options.forceColdStart ?? this.#isColdNativeSessionLaunch(launch),
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
    ): AiSessionSnapshot {
        const previousSnapshot =
            this.#liveSnapshots.get(snapshot.sessionId) ?? null;
        const nextSnapshot = this.#drainPendingNativeCatalogPatches(
            this.#preservePassiveNativeSnapshotTrackedFiles(
                this.#hydrateSnapshotRuntimeCatalog(snapshot),
                previousSnapshot,
            ),
            ownerWindowId,
        );
        this.#cacheLiveSessionSnapshot(nextSnapshot, ownerWindowId);
        if (!this.#isNativeAiSession(nextSnapshot.sessionId)) {
            this.#persistence.saveSessionSnapshot(nextSnapshot);
        }
        return nextSnapshot;
    }

    async #reconcileLiveSelectionPreferences(
        sessionId: string,
        ownerWindowId: string,
    ): Promise<AiSessionSnapshot | null> {
        void ownerWindowId;
        let snapshot = this.#liveSnapshots.get(sessionId) ?? null;
        if (!snapshot || this.#deletedSessionIds.has(sessionId)) {
            return snapshot;
        }

        const preferences = this.#persistence.loadRuntimeSelectionPreferences(
            snapshot.runtimeId,
        );
        const modelConfig = getModelConfigOption(snapshot.configOptions);
        if (
            !modelConfig &&
            preferences.modelId &&
            preferences.modelId !== snapshot.modelId &&
            snapshot.models.some((model) => model.id === preferences.modelId)
        ) {
            await this.setSessionModel({
                modelId: preferences.modelId,
                sessionId,
            });
            snapshot = this.#liveSnapshots.get(sessionId) ?? snapshot;
        }

        const modeConfig = getModeConfigOption(snapshot.configOptions);
        if (
            !modeConfig &&
            preferences.modeId &&
            preferences.modeId !== snapshot.modeId &&
            snapshot.modes.some((mode) => mode.id === preferences.modeId)
        ) {
            await this.setSessionMode({
                modeId: preferences.modeId,
                sessionId,
            });
            snapshot = this.#liveSnapshots.get(sessionId) ?? snapshot;
        }

        const mutations = getPreferredConfigOptionMutations(
            snapshot,
            preferences,
        );
        for (const mutation of mutations) {
            await this.setSessionConfigOption({
                optionId: mutation.optionId,
                sessionId,
                value: mutation.value,
            });
            snapshot = this.#liveSnapshots.get(sessionId) ?? snapshot;
        }

        return snapshot;
    }

    #scheduleLiveSelectionPreferenceReconciliation(
        ownerWindowId: string,
        sessionId: string,
    ): void {
        void this.#reconcileLiveSelectionPreferences(
            sessionId,
            ownerWindowId,
        ).catch((error: unknown) => {
            debugBenignError("ai.service.selectionPreferenceReconcile", error);
        });
    }

    #applyNativeCatalogPatchToLiveSnapshot(
        ownerWindowId: string,
        previousSnapshot: AiSessionSnapshot,
        patch: NormalizedSessionCatalogPayload,
        updatedAt: string,
        options: { readonly emitUpdate: boolean },
    ): AiSessionSnapshot {
        const baseSnapshot = this.#hydrateSnapshotRuntimeCatalog(previousSnapshot);
        const nextSnapshot = applyNormalizedSessionCatalogToSnapshot(
            {
                ...baseSnapshot,
                updatedAt,
            },
            patch,
        );
        this.#cacheLiveSessionSnapshot(nextSnapshot, ownerWindowId);
        this.#persistNativeCatalogPatch(nextSnapshot, patch);

        if (options.emitUpdate) {
            this.#onSessionSnapshot(
                ownerWindowId,
                buildAiSessionUpdate(previousSnapshot, nextSnapshot),
            );
        }

        return nextSnapshot;
    }

    #drainPendingNativeCatalogPatches(
        snapshot: AiSessionSnapshot,
        fallbackOwnerWindowId: string,
    ): AiSessionSnapshot {
        const pending = this.#pendingNativeCatalogPatches.get(
            snapshot.sessionId,
        );
        if (!pending || pending.length === 0) {
            return snapshot;
        }

        this.#pendingNativeCatalogPatches.delete(snapshot.sessionId);

        // ACP runtimes can emit catalog updates before prepareSession returns.
        return pending.reduce((currentSnapshot, pendingPatch) => {
            return this.#applyNativeCatalogPatchToLiveSnapshot(
                pendingPatch.ownerWindowId || fallbackOwnerWindowId,
                currentSnapshot,
                pendingPatch.patch,
                pendingPatch.updatedAt,
                { emitUpdate: false },
            );
        }, snapshot);
    }

    #applyNativeSessionEvent(
        snapshot: AiSessionSnapshot,
        event: AiSessionDomainEvent,
    ): AiSessionSnapshot {
        const base = {
            ...snapshot,
            runtimeSessionId:
                event.runtimeSessionId ?? snapshot.runtimeSessionId,
            updatedAt: event.updatedAt,
        };

        if (event.kind === "session-info") {
            return {
                ...base,
                projectId: event.projectId,
                title: event.title,
                worktreeId: event.worktreeId,
            };
        }

        if (event.kind === "status") {
            return {
                ...base,
                activeTurnStartedAt: event.activeTurnStartedAt,
                lastError: event.lastError,
                pendingPermission:
                    event.status === "waiting_permission"
                        ? snapshot.pendingPermission
                        : null,
                pendingUserInput:
                    event.status === "waiting_user_input"
                        ? snapshot.pendingUserInput
                        : null,
                status: event.status,
            };
        }

        if (event.kind === "message-started") {
            return {
                ...base,
                messages: upsertNativeMessage(
                    snapshot.messages,
                    event.message,
                ),
            };
        }

        if (event.kind === "message-delta") {
            return {
                ...base,
                messages: updateNativeMessageContent(
                    snapshot.messages,
                    event.messageId,
                    event.content,
                ),
            };
        }

        if (event.kind === "message-completed") {
            return {
                ...base,
                messages: completeNativeMessage(
                    snapshot.messages,
                    event.messageId,
                ),
            };
        }

        if (event.kind === "thinking-started") {
            return {
                ...base,
                messages: upsertNativeMessage(
                    snapshot.messages,
                    event.message,
                ),
            };
        }

        if (event.kind === "thinking-delta") {
            return {
                ...base,
                messages: updateNativeMessageContent(
                    snapshot.messages,
                    event.messageId,
                    event.content,
                ),
            };
        }

        if (event.kind === "thinking-completed") {
            return {
                ...base,
                messages: completeNativeMessage(
                    snapshot.messages,
                    event.messageId,
                ),
            };
        }

        if (event.kind === "image-generation") {
            return {
                ...base,
                messages: upsertNativeMessage(
                    snapshot.messages,
                    event.message,
                ),
            };
        }

        if (event.kind === "tool-activity") {
            const nextSnapshot = {
                ...base,
                toolActivity: upsertNativeToolActivity(
                    snapshot.toolActivity,
                    event.activity,
                ),
            };
            return this.#applyNativeToolActivityReviewDiffs(
                nextSnapshot,
                event.activity,
            );
        }

        if (event.kind === "review") {
            return {
                ...base,
                trackedFiles: this.#preserveNativeReviewFallbackTrackedFiles(
                    event.trackedFiles,
                    snapshot,
                ),
            };
        }

        if (event.kind === "plan") {
            return {
                ...base,
                plan: event.plan,
            };
        }

        if (event.kind === "permission-request") {
            return {
                ...base,
                pendingPermission: event.request,
                status: event.request ? "waiting_permission" : snapshot.status,
            };
        }

        if (event.kind === "user-input-request") {
            return {
                ...base,
                pendingUserInput: event.request,
                status: event.request ? "waiting_user_input" : snapshot.status,
            };
        }

        if (event.kind === "token-usage") {
            return {
                ...base,
                tokenUsage: event.tokenUsage,
            };
        }

        if (event.kind === "subagent-breadcrumb") {
            return {
                ...base,
                toolActivity: snapshot.toolActivity.map((activity) =>
                    activity.id === event.toolCallId
                        ? {
                              ...activity,
                              action: {
                                  kind: "open_session",
                                  sessionId: event.childSessionId,
                              },
                          }
                        : activity,
                ),
            };
        }

        return base;
    }

    async #captureNativeReviewBaseline(
        sessionId: string,
        launch: AiSessionLaunchInput,
        messageId: string,
    ): Promise<boolean> {
        const nativeAi = this.#requireNativeReviewGateway("captureReviewBaseline");
        const nativeCaptured = await nativeAi.captureReviewBaseline(sessionId);
        this.#recentNativeReviewContexts.delete(sessionId);
        this.#nativeReviewBaselines.set(sessionId, {
            additionalRoots: launch.additionalRoots,
            cwd: launch.cwd,
            messageId,
            nativeCaptured,
            promptAccepted: false,
            terminalStatusSeen: false,
            turnStarted: false,
        });
        return true;
    }

    #markNativeReviewTurnStarted(sessionId: string): void {
        const baseline = this.#nativeReviewBaselines.get(sessionId);
        if (!baseline || baseline.turnStarted) {
            return;
        }

        this.#nativeReviewBaselines.set(sessionId, {
            ...baseline,
            turnStarted: true,
        });
    }

    #markNativeReviewPromptAccepted(sessionId: string): boolean {
        const baseline = this.#nativeReviewBaselines.get(sessionId);
        if (!baseline) {
            return false;
        }

        this.#nativeReviewBaselines.set(sessionId, {
            ...baseline,
            promptAccepted: true,
        });
        return baseline.terminalStatusSeen;
    }

    #markNativeReviewTerminalStatusSeen(sessionId: string): void {
        const baseline = this.#nativeReviewBaselines.get(sessionId);
        if (!baseline || baseline.terminalStatusSeen) {
            return;
        }

        this.#nativeReviewBaselines.set(sessionId, {
            ...baseline,
            terminalStatusSeen: true,
        });
    }

    #nativeReviewDiffContext(
        sessionId: string,
    ): NativeReviewBaseline | RecentNativeReviewContext | null {
        const baseline = this.#nativeReviewBaselines.get(sessionId);
        if (baseline) {
            return baseline;
        }

        const recentContext = this.#recentNativeReviewContexts.get(sessionId);
        if (!recentContext) {
            return null;
        }

        if (recentContext.expiresAtMs <= Date.now()) {
            this.#recentNativeReviewContexts.delete(sessionId);
            return null;
        }

        return recentContext;
    }

    #rememberRecentNativeReviewContext(
        sessionId: string,
        baseline: NativeReviewBaseline,
    ): void {
        this.#recentNativeReviewContexts.set(sessionId, {
            additionalRoots: baseline.additionalRoots,
            cwd: baseline.cwd,
            expiresAtMs: Date.now() + RECENT_NATIVE_REVIEW_CONTEXT_TTL_MS,
        });
    }

    #applyNativeToolActivityReviewDiffs(
        snapshot: AiSessionSnapshot,
        activity: AiToolActivity,
    ): AiSessionSnapshot {
        const reviewContext = this.#nativeReviewDiffContext(snapshot.sessionId);
        if (
            !reviewContext ||
            !isTerminalNativeReviewActivityStatus(activity.status) ||
            activity.diffs.length === 0
        ) {
            return snapshot;
        }

        const projectRoot = this.#resolveNativeReviewProjectRoot(snapshot);
        const scopeRoot = projectRoot ?? reviewContext.cwd;
        const normalizeDiffPath = (candidatePath: string): string | null => {
            const normalizedPath = normalizeTrackedDiffPath(
                {
                    cwd: reviewContext.cwd,
                    projectRoot,
                },
                candidatePath,
            );
            const resolvedPath = resolveSessionScopedPath(
                scopeRoot,
                normalizedPath,
            );
            const insideAdditionalRoot = reviewContext.additionalRoots.some(
                (rootPath) => isPathInsideRoot(resolvedPath.absolutePath, rootPath),
            );
            if (resolvedPath.insideRoot && resolvedPath.relativePath) {
                return normalizedPath;
            }
            if (insideAdditionalRoot) {
                return resolvedPath.absolutePath;
            }
            return null;
        };
        let trackedFiles = snapshot.trackedFiles;
        for (const diff of activity.diffs) {
            const trackedFile = trackedFileFromToolActivityDiff(
                diff,
                snapshot.sessionId,
                activity.id,
                activity.updatedAt,
                normalizeDiffPath,
            );
            if (!trackedFile) {
                continue;
            }
            trackedFiles = upsertTrackedFile(trackedFiles, trackedFile);
        }

        return trackedFiles === snapshot.trackedFiles
            ? snapshot
            : {
                  ...snapshot,
                  trackedFiles,
              };
    }

    #resolveNativeReviewProjectRoot(
        snapshot: Pick<AiSessionSnapshot, "projectId" | "worktreeId">,
    ): string | null {
        try {
            return snapshot.projectId
                ? this.#projectService.getProjectRootPath(
                      snapshot.projectId,
                      snapshot.worktreeId ?? null,
                  )
                : null;
        } catch (error) {
            debugBenignError("ai.service.resolveNativeReviewProjectRoot", error);
            return null;
        }
    }

    #preserveNativeReviewFallbackTrackedFiles(
        nativeTrackedFiles: readonly AiTrackedFile[],
        previousSnapshot: AiSessionSnapshot,
    ): readonly AiTrackedFile[] {
        return preserveFallbackTrackedFiles(
            nativeTrackedFiles,
            previousSnapshot.trackedFiles,
            this.#createNativeReviewPathMatcher(previousSnapshot),
        );
    }

    #preservePassiveNativeSnapshotTrackedFiles(
        incomingSnapshot: AiSessionSnapshot,
        previousSnapshot: AiSessionSnapshot | null,
    ): AiSessionSnapshot {
        return preservePassiveSnapshotTrackedFiles(
            incomingSnapshot,
            previousSnapshot,
            this.#createNativeReviewPathMatcher(
                previousSnapshot ?? incomingSnapshot,
            ),
        );
    }

    #createNativeReviewPathMatcher(
        snapshot: Pick<
            AiSessionSnapshot,
            "projectId" | "sessionId" | "worktreeId"
        >,
    ): TrackedFilePathMatcher | undefined {
        const projectRoot = this.#resolveNativeReviewProjectRoot(snapshot);
        const reviewContext = this.#nativeReviewDiffContext(snapshot.sessionId);
        const scopeRoot = projectRoot ?? reviewContext?.cwd ?? null;
        if (!scopeRoot) {
            return undefined;
        }

        return (leftPath, rightPath) =>
            isSamePath(
                resolveSessionScopedPath(scopeRoot, leftPath).absolutePath,
                resolveSessionScopedPath(scopeRoot, rightPath).absolutePath,
            );
    }

    #shouldReconcileNativeReviewFiles(event: AiSessionDomainEvent): boolean {
        const baseline = this.#nativeReviewBaselines.get(event.sessionId);
        if (!baseline || !this.#isNativeAiSession(event.sessionId)) {
            return false;
        }

        return (
            baseline.nativeCaptured &&
            event.kind === "status" &&
            (baseline.turnStarted || baseline.promptAccepted) &&
            (event.status === "idle" || event.status === "error")
        );
    }

    async #reconcileNativeReviewFiles(
        sessionId: string,
        ownerWindowId: string,
    ): Promise<void> {
        const baseline = this.#nativeReviewBaselines.get(sessionId);
        if (!baseline || this.#nativeReviewReconciliations.has(sessionId)) {
            return;
        }

        this.#nativeReviewReconciliations.add(sessionId);
        try {
            const initialSnapshot = this.#liveSnapshots.get(sessionId);
            if (!initialSnapshot) {
                return;
            }

            const trackedFiles =
                await this.#requireNativeReviewGateway(
                    "reconcileTrackedFiles",
                ).reconcileTrackedFiles(sessionId);
            const snapshot =
                this.#liveSnapshots.get(sessionId) ?? initialSnapshot;
            if (trackedFiles.length === 0 && snapshot.trackedFiles.length === 0) {
                return;
            }

            const nextTrackedFiles = this.#preserveNativeReviewFallbackTrackedFiles(
                trackedFiles,
                snapshot,
            );
            if (nextTrackedFiles === snapshot.trackedFiles) {
                return;
            }

            const nextSnapshot = {
                ...snapshot,
                trackedFiles: nextTrackedFiles,
                updatedAt: new Date().toISOString(),
            };
            this.#cacheLiveSessionSnapshot(nextSnapshot, ownerWindowId);
            this.#onSessionSnapshot(
                ownerWindowId,
                buildAiSessionUpdate(snapshot, nextSnapshot),
            );
            void this.#enforceSessionRetention();
        } finally {
            if (this.#liveSessionContexts.has(sessionId)) {
                this.#rememberRecentNativeReviewContext(sessionId, baseline);
            }
            this.#nativeReviewBaselines.delete(sessionId);
            this.#nativeReviewReconciliations.delete(sessionId);
        }
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

    #resolveSnapshotFromNativeUpdate(
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

    async #loadPersistedSessionSnapshot(
        sessionId: string,
    ): Promise<AiSessionSnapshot | null> {
        const snapshot = this.#nativeAi?.shouldHandleHistory()
            ? await this.#nativeAi.loadSessionSnapshot(sessionId)
            : await this.#persistence.loadSessionSnapshot(sessionId);

        return snapshot ? normalizeRestoredAiSessionSnapshot(snapshot) : null;
    }

    async #listPersistedRuntimeMappingsForParent(
        parentSessionId: string,
    ): Promise<readonly AiRuntimeSessionMapping[]> {
        const mappings: AiRuntimeSessionMapping[] = [];
        const seen = new Set<string>();
        const append = (
            entries: readonly AiRuntimeSessionMapping[],
        ): void => {
            for (const entry of entries) {
                const key = `${entry.appSessionId}\0${entry.runtimeSessionId}`;
                if (seen.has(key)) {
                    continue;
                }
                seen.add(key);
                mappings.push(entry);
            }
        };

        if (
            this.#nativeAi?.shouldHandleHistory() &&
            this.#nativeAi.listSessionRuntimeMappingsForParent
        ) {
            append(
                await this.#nativeAi.listSessionRuntimeMappingsForParent(
                    parentSessionId,
                ),
            );
            return mappings;
        }
        append(
            (await this.#persistence.listSessionRuntimeMappingsForParent?.(
                parentSessionId,
            )) ?? [],
        );

        return mappings;
    }

    async #buildNativePrepareLaunchForSession(
        input: SessionDescriptor,
        ownerWindowId: string,
        launch: AiSessionLaunchInput,
    ): Promise<{
        readonly input: SessionDescriptor;
        readonly launch: AiSessionLaunchInput;
    }> {
        const parentSessionId = launch.persistedSnapshot.parentSessionId ?? null;
        if (!parentSessionId) {
            return { input, launch };
        }

        const parentSnapshot =
            this.#liveSnapshots.get(parentSessionId) ??
            (await this.#loadPersistedSessionSnapshot(parentSessionId));
        if (!parentSnapshot) {
            throw new Error(
                "The parent session could not be loaded for this subagent.",
            );
        }

        const parentInput: SessionDescriptor = {
            additionalRoots: input.additionalRoots,
            projectId: parentSnapshot.projectId,
            runtimeId: parentSnapshot.runtimeId,
            sessionId: parentSessionId,
            title: parentSnapshot.title,
            worktreeId: parentSnapshot.worktreeId ?? null,
        };

        return {
            input: parentInput,
            launch: await this.#buildNativeSessionLaunchInput(
                parentInput,
                ownerWindowId,
                parentSnapshot,
            ),
        };
    }

    #adoptNativeSubagentSnapshot(
        snapshot: AiSessionSnapshot,
        ownerWindowId: string,
    ): void {
        const parentSessionId = snapshot.parentSessionId ?? null;
        if (!parentSessionId) {
            return;
        }

        this.#cacheLiveSessionSnapshot(snapshot, ownerWindowId);
        this.#nativeSessionIds.add(snapshot.sessionId);
        this.#nativeChildParentSessionIds.set(snapshot.sessionId, parentSessionId);
        this.#onSessionSnapshot(ownerWindowId, {
            kind: "snapshot",
            snapshot,
        });
    }

    async #buildNativeSessionLaunchInput(
        input: SessionDescriptor,
        ownerWindowId: string,
        snapshotOverride?: AiSessionSnapshot | null,
    ): Promise<AiSessionLaunchInput> {
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

        const persistedSnapshot = this.#hydrateSnapshotRuntimeCatalog(
            snapshotOverride ??
                this.#liveSnapshots.get(input.sessionId) ??
                (await this.#loadPersistedSessionSnapshot(input.sessionId)) ??
                createEmptyAiSessionSnapshot({
                    projectId: input.projectId,
                    runtimeId: input.runtimeId,
                    sessionId: input.sessionId,
                    title: input.title,
                    worktreeId: input.worktreeId ?? null,
                }),
        );
        const persistedSubagentSessionMappings =
            await this.#listPersistedRuntimeMappingsForParent(
                persistedSnapshot.sessionId,
            );

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

    async #buildNativeReviewContext(
        sessionId: string,
    ): Promise<{
        readonly context: AiReviewSessionContext;
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
        result: AiReviewMutationResult,
    ): void {
        if (!this.#isNativeAiSession(result.snapshot.sessionId)) {
            this.#persistence.saveSessionSnapshot(result.snapshot);
        }
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

    async #tryApplyFallbackTrackedFileMutation(
        input: AiTrackedFileMutationInput,
        decision: "keep" | "reject",
    ): Promise<boolean> {
        const reviewSession = await this.#buildNativeReviewContext(
            input.sessionId,
        );
        const trackedFile = findFallbackTrackedFile(
            reviewSession.snapshot.trackedFiles,
            input.path,
        );
        if (!trackedFile) {
            return false;
        }

        if (decision === "reject") {
            this.#assertFallbackTrackedFileCurrentMatches(
                reviewSession.context,
                trackedFile,
            );
            this.#rejectFallbackTrackedFile(reviewSession.context, trackedFile);
        }

        const nextSnapshot = {
            ...reviewSession.snapshot,
            trackedFiles: removeTrackedFileByIdentity(
                reviewSession.snapshot.trackedFiles,
                trackedFile.identityKey,
            ),
            updatedAt: new Date().toISOString(),
        };
        this.#persistReviewMutation(reviewSession.snapshot, {
            ownerWindowId: reviewSession.context.ownerWindowId,
            snapshot: nextSnapshot,
        });
        return true;
    }

    async #tryApplyFallbackTrackedFileHunkMutation(
        input: AiTrackedFileHunkMutationInput,
        decision: "keep" | "reject",
    ): Promise<boolean> {
        const reviewSession = await this.#buildNativeReviewContext(
            input.sessionId,
        );
        const trackedFile = findFallbackTrackedFile(
            reviewSession.snapshot.trackedFiles,
            input.path,
        );
        if (!trackedFile) {
            return false;
        }

        const nextTrackedFile = resolveTrackedFileHunks(
            trackedFile,
            input.hunkIds,
            decision,
        );
        if (decision === "reject") {
            this.#assertFallbackTrackedFileCurrentMatches(
                reviewSession.context,
                trackedFile,
            );
            this.#writeFallbackTrackedFileCurrentText(
                reviewSession.context,
                trackedFile,
                nextTrackedFile,
            );
        }

        const nextSnapshot = {
            ...reviewSession.snapshot,
            trackedFiles: replaceTrackedFileByIdentity(
                reviewSession.snapshot.trackedFiles,
                trackedFile.identityKey,
                nextTrackedFile,
            ),
            updatedAt: new Date().toISOString(),
        };
        this.#persistReviewMutation(reviewSession.snapshot, {
            ownerWindowId: reviewSession.context.ownerWindowId,
            snapshot: nextSnapshot,
        });
        return true;
    }

    async #tryApplyAllFallbackTrackedFileMutations(
        sessionId: string,
        decision: "keep" | "reject",
    ): Promise<boolean> {
        const reviewSession = await this.#buildNativeReviewContext(sessionId);
        const pendingFallbackFiles = reviewSession.snapshot.trackedFiles.filter(
            (trackedFile) =>
                isFallbackTrackedFile(trackedFile) &&
                isAiTrackedFileUnresolved(trackedFile),
        );
        if (pendingFallbackFiles.length === 0) {
            return false;
        }

        const hasNativePendingFiles = reviewSession.snapshot.trackedFiles.some(
            (trackedFile) =>
                !isFallbackTrackedFile(trackedFile) &&
                isAiTrackedFileUnresolved(trackedFile),
        );

        if (decision === "reject") {
            for (const trackedFile of pendingFallbackFiles) {
                this.#assertFallbackTrackedFileCurrentMatches(
                    reviewSession.context,
                    trackedFile,
                );
            }
            const backups = this.#createFallbackReviewBackups(
                reviewSession.context,
                pendingFallbackFiles,
            );
            try {
                for (const trackedFile of pendingFallbackFiles) {
                    this.#rejectFallbackTrackedFile(
                        reviewSession.context,
                        trackedFile,
                    );
                }
            } catch (error) {
                this.#restoreFallbackReviewBackups(backups);
                throw error;
            }
        }

        const fallbackIdentityKeys = new Set(
            pendingFallbackFiles.map((trackedFile) => trackedFile.identityKey),
        );
        const nextSnapshot = {
            ...reviewSession.snapshot,
            trackedFiles: reviewSession.snapshot.trackedFiles.filter(
                (trackedFile) =>
                    !fallbackIdentityKeys.has(trackedFile.identityKey),
            ),
            updatedAt: new Date().toISOString(),
        };
        this.#persistReviewMutation(reviewSession.snapshot, {
            ownerWindowId: reviewSession.context.ownerWindowId,
            snapshot: nextSnapshot,
        });
        return !hasNativePendingFiles;
    }

    #createFallbackReviewBackups(
        context: AiReviewSessionContext,
        trackedFiles: readonly AiTrackedFile[],
    ): Map<string, Buffer | null> {
        const backups = new Map<string, Buffer | null>();
        for (const trackedFile of trackedFiles) {
            for (const trackedPath of fallbackReviewMutationPaths(
                trackedFile,
            )) {
                const absolutePath = this.#resolveFallbackReviewPath(
                    context,
                    trackedPath,
                );
                if (backups.has(absolutePath)) {
                    continue;
                }
                backups.set(
                    absolutePath,
                    fs.existsSync(absolutePath)
                        ? fs.readFileSync(absolutePath)
                        : null,
                );
            }
        }
        return backups;
    }

    #restoreFallbackReviewBackups(backups: Map<string, Buffer | null>): void {
        for (const [absolutePath, content] of backups) {
            if (content === null) {
                fs.rmSync(absolutePath, { force: true });
                continue;
            }
            fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
            fs.writeFileSync(absolutePath, content);
        }
    }

    #assertFallbackTrackedFileCurrentMatches(
        context: AiReviewSessionContext,
        trackedFile: AiTrackedFile,
    ): void {
        const expected =
            trackedFile.kind === "delete"
                ? null
                : getTrackedFileCurrentText(trackedFile);
        const current = this.#readFallbackReviewTextIfExists(
            context,
            trackedFile.path,
        );
        if (current !== expected) {
            throw new Error(
                "Cannot safely reject this review change because the file no longer matches the reviewed content.",
            );
        }

        if (!trackedFile.previousPath) {
            return;
        }

        const previous = this.#readFallbackReviewTextIfExists(
            context,
            trackedFile.previousPath,
        );
        if (previous !== null) {
            throw new Error(
                "Cannot safely reject this review change because the previous path is no longer available.",
            );
        }
    }

    #rejectFallbackTrackedFile(
        context: AiReviewSessionContext,
        trackedFile: AiTrackedFile,
    ): void {
        if (trackedFile.kind === "create" && !trackedFile.previousPath) {
            this.#removeFallbackReviewPath(context, trackedFile.path);
            return;
        }

        if (trackedFile.previousPath) {
            this.#removeFallbackReviewPath(context, trackedFile.path);
            this.#writeFallbackReviewText(
                context,
                trackedFile.previousPath,
                getTrackedFileDiffBase(trackedFile),
            );
            return;
        }

        this.#writeFallbackReviewText(
            context,
            trackedFile.path,
            getTrackedFileDiffBase(trackedFile),
        );
    }

    #writeFallbackTrackedFileCurrentText(
        context: AiReviewSessionContext,
        originalTrackedFile: AiTrackedFile,
        nextTrackedFile: AiTrackedFile | null,
    ): void {
        if (!nextTrackedFile) {
            this.#rejectFallbackTrackedFile(context, originalTrackedFile);
            return;
        }

        this.#writeFallbackReviewText(
            context,
            nextTrackedFile.path,
            getTrackedFileCurrentText(nextTrackedFile),
        );
    }

    #writeFallbackReviewText(
        context: AiReviewSessionContext,
        trackedPath: string,
        text: string,
    ): void {
        const absolutePath = this.#resolveFallbackReviewPath(
            context,
            trackedPath,
        );
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, text, "utf8");
    }

    #readFallbackReviewTextIfExists(
        context: AiReviewSessionContext,
        trackedPath: string,
    ): string | null {
        const absolutePath = this.#resolveFallbackReviewPath(
            context,
            trackedPath,
        );
        if (!fs.existsSync(absolutePath)) {
            return null;
        }
        return fs.readFileSync(absolutePath, "utf8");
    }

    #removeFallbackReviewPath(
        context: AiReviewSessionContext,
        trackedPath: string,
    ): void {
        fs.rmSync(this.#resolveFallbackReviewPath(context, trackedPath), {
            force: true,
        });
    }

    #resolveFallbackReviewPath(
        context: AiReviewSessionContext,
        trackedPath: string,
    ): string {
        const baseline = this.#nativeReviewBaselines.get(
            context.snapshot.sessionId,
        );
        const scopeRoot = baseline?.cwd ?? context.projectRoot ?? context.cwd;
        const absolutePath = path.isAbsolute(trackedPath)
            ? path.resolve(trackedPath)
            : path.resolve(scopeRoot, trackedPath);
        const insideScope = isPathInsideRoot(absolutePath, scopeRoot);
        const insideAdditionalRoot = context.additionalRoots.some((rootPath) =>
            isPathInsideRoot(absolutePath, rootPath),
        );
        if (!insideScope && !insideAdditionalRoot) {
            throw new Error("The review path is outside the session scope.");
        }
        return absolutePath;
    }

    async keepTrackedFile(input: AiTrackedFileMutationInput): Promise<void> {
        if (await this.#tryApplyFallbackTrackedFileMutation(input, "keep")) {
            return;
        }

        const reviewSession = await this.#buildNativeReviewContext(
            input.sessionId,
        );
        const result = await this.#requireNativeReviewGateway(
            "keepTrackedFile",
        ).keepTrackedFile({
            context: reviewSession.context,
            input,
        });
        this.#persistReviewMutation(reviewSession.snapshot, result);
    }

    async rejectTrackedFile(input: AiTrackedFileMutationInput): Promise<void> {
        if (await this.#tryApplyFallbackTrackedFileMutation(input, "reject")) {
            return;
        }

        const reviewSession = await this.#buildNativeReviewContext(
            input.sessionId,
        );
        const result = await this.#requireNativeReviewGateway(
            "rejectTrackedFile",
        ).rejectTrackedFile({
            context: reviewSession.context,
            input,
        });
        this.#persistReviewMutation(reviewSession.snapshot, result);
    }

    async keepTrackedFileHunks(
        input: AiTrackedFileHunkMutationInput,
    ): Promise<void> {
        if (
            await this.#tryApplyFallbackTrackedFileHunkMutation(input, "keep")
        ) {
            return;
        }

        const reviewSession = await this.#buildNativeReviewContext(
            input.sessionId,
        );
        const result = await this.#requireNativeReviewGateway(
            "keepTrackedFileHunks",
        ).keepTrackedFileHunks({
            context: reviewSession.context,
            input,
        });
        this.#persistReviewMutation(reviewSession.snapshot, result);
    }

    async rejectTrackedFileHunks(
        input: AiTrackedFileHunkMutationInput,
    ): Promise<void> {
        if (
            await this.#tryApplyFallbackTrackedFileHunkMutation(input, "reject")
        ) {
            return;
        }

        const reviewSession = await this.#buildNativeReviewContext(
            input.sessionId,
        );
        const result = await this.#requireNativeReviewGateway(
            "rejectTrackedFileHunks",
        ).rejectTrackedFileHunks({
            context: reviewSession.context,
            input,
        });
        this.#persistReviewMutation(reviewSession.snapshot, result);
    }

    async keepAllTrackedFiles(sessionId: string): Promise<void> {
        if (
            await this.#tryApplyAllFallbackTrackedFileMutations(
                sessionId,
                "keep",
            )
        ) {
            return;
        }

        const reviewSession = await this.#buildNativeReviewContext(sessionId);
        const result = await this.#requireNativeReviewGateway(
            "keepAllTrackedFiles",
        ).keepAllTrackedFiles({
            context: reviewSession.context,
            input: sessionId,
        });
        this.#persistReviewMutation(reviewSession.snapshot, result);
    }

    async rejectAllTrackedFiles(sessionId: string): Promise<void> {
        if (
            await this.#tryApplyAllFallbackTrackedFileMutations(
                sessionId,
                "reject",
            )
        ) {
            return;
        }

        const reviewSession = await this.#buildNativeReviewContext(sessionId);
        const result = await this.#requireNativeReviewGateway(
            "rejectAllTrackedFiles",
        ).rejectAllTrackedFiles({
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
        const preferredModeId =
            preferences.modeId ??
            getPreferredConfigSelectionId(
                preferences.configOptions,
                persistedSnapshot.configOptions,
                isModeConfigOption,
            );
        const preferredModelId =
            preferences.modelId ??
            getPreferredConfigSelectionId(
                preferences.configOptions,
                persistedSnapshot.configOptions,
                isModelConfigOption,
            );

        return {
            configOptions: applyRuntimeSelectionPreferencesToConfigOptions(
                persistedSnapshot.configOptions,
                preferences.configOptions,
                preferredModeId,
                preferredModelId,
            ),
            modeId: preferredModeId ?? persistedSnapshot.modeId,
            modelId: preferredModelId ?? persistedSnapshot.modelId,
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
            if (!this.#isNativeAiSession(sessionId)) {
                this.#persistence.saveSessionSnapshot(nextSnapshot);
            }
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

        return mergePersistedCatalogIntoRuntimeStatus(status, catalog);
    }

    #hydrateSnapshotRuntimeCatalog(snapshot: AiSessionSnapshot): AiSessionSnapshot {
        const catalog = this.#persistence.loadLatestRuntimeCatalog(
            snapshot.runtimeId,
        );

        if (!catalog) {
            return snapshot;
        }

        return mergePersistedCatalogIntoSessionSnapshot(snapshot, catalog);
    }

    #persistNativeCatalogPatch(
        snapshot: AiSessionSnapshot,
        patch: NormalizedSessionCatalogPayload,
    ): void {
        const catalogPatch = buildPersistedRuntimeCatalogPatch(snapshot, patch);
        if (this.#persistence.saveRuntimeCatalogPatch) {
            this.#persistence.saveRuntimeCatalogPatch(
                snapshot.runtimeId,
                catalogPatch,
            );
            return;
        }

        this.#persistence.saveSessionSnapshot(snapshot);
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

function isTerminalNativeReviewActivityStatus(
    status: AiToolActivity["status"],
): boolean {
    return status === "completed" || status === "failed";
}

function trackedFileFromToolActivityDiff(
    diff: AiFileDiff,
    sessionId: string,
    toolCallId: string,
    updatedAt: string,
    normalizePath: (candidatePath: string) => string | null = (candidatePath) =>
        candidatePath,
): AiTrackedFile | null {
    if (!diff.isText) {
        return null;
    }

    const normalizedPath = normalizePath(diff.path);
    if (!normalizedPath) {
        return null;
    }
    const normalizedPreviousPath = diff.previousPath
        ? normalizePath(diff.previousPath)
        : null;
    if (diff.previousPath && !normalizedPreviousPath) {
        return null;
    }
    const diffBase = diff.oldText ?? "";
    const currentText = diff.newText ?? "";
    if (
        normalizedPreviousPath === null &&
        normalizeReviewText(diffBase) === normalizeReviewText(currentText)
    ) {
        return null;
    }

    return {
        currentText,
        diffBase,
        hunks:
            diff.hunks.length > 0 && normalizedPath === diff.path
                ? diff.hunks
                : computeDiffHunks(diffBase, currentText, normalizedPath),
        identityKey: `tool:${sessionId}:${toolCallId}:${normalizedPreviousPath ?? ""}:${normalizedPath}`,
        isText: true,
        kind: diff.kind,
        newText: diff.newText,
        oldText: diff.oldText,
        path: normalizedPath,
        previousPath:
            normalizedPreviousPath && normalizedPreviousPath !== normalizedPath
                ? normalizedPreviousPath
                : null,
        reviewState: "pending",
        reversible: diff.reversible,
        sessionId,
        toolCallId,
        updatedAt,
        version: 1,
    };
}

function isFallbackTrackedFile(trackedFile: AiTrackedFile): boolean {
    return trackedFile.identityKey.startsWith("tool:");
}

function findFallbackTrackedFile(
    trackedFiles: readonly AiTrackedFile[],
    reviewPath: string,
): AiTrackedFile | null {
    return (
        trackedFiles.find(
            (trackedFile) =>
                isFallbackTrackedFile(trackedFile) &&
                (trackedFile.path === reviewPath ||
                    trackedFile.previousPath === reviewPath ||
                    trackedFile.identityKey === reviewPath),
        ) ?? null
    );
}

function fallbackReviewMutationPaths(trackedFile: AiTrackedFile): readonly string[] {
    return trackedFile.previousPath
        ? [trackedFile.path, trackedFile.previousPath]
        : [trackedFile.path];
}

type TrackedFilePathMatcher = (leftPath: string, rightPath: string) => boolean;

function preserveFallbackTrackedFiles(
    nativeTrackedFiles: readonly AiTrackedFile[],
    previousTrackedFiles: readonly AiTrackedFile[],
    pathMatcher?: TrackedFilePathMatcher,
): readonly AiTrackedFile[] {
    const fallbackTrackedFiles = previousTrackedFiles.filter(
        (trackedFile) =>
            isFallbackTrackedFile(trackedFile) &&
            !isTrackedFileRepresented(
                nativeTrackedFiles,
                trackedFile,
                pathMatcher,
            ),
    );
    if (fallbackTrackedFiles.length === 0) {
        return nativeTrackedFiles;
    }
    if (
        nativeTrackedFiles.length === 0 &&
        fallbackTrackedFiles.length === previousTrackedFiles.length
    ) {
        return previousTrackedFiles;
    }
    return [...nativeTrackedFiles, ...fallbackTrackedFiles];
}

function preservePassiveSnapshotTrackedFiles(
    incomingSnapshot: AiSessionSnapshot,
    previousSnapshot: AiSessionSnapshot | null,
    pathMatcher?: TrackedFilePathMatcher,
): AiSessionSnapshot {
    if (
        !previousSnapshot ||
        previousSnapshot.sessionId !== incomingSnapshot.sessionId ||
        previousSnapshot.trackedFiles.length === 0
    ) {
        return incomingSnapshot;
    }

    if (incomingSnapshot.trackedFiles.length > 0) {
        const trackedFiles = preserveFallbackTrackedFiles(
            incomingSnapshot.trackedFiles,
            previousSnapshot.trackedFiles,
            pathMatcher,
        );
        return trackedFiles === incomingSnapshot.trackedFiles
            ? incomingSnapshot
            : {
                  ...incomingSnapshot,
                  trackedFiles,
              };
    }

    const pendingTrackedFiles = previousSnapshot.trackedFiles.filter(
        isAiTrackedFileUnresolved,
    );
    if (pendingTrackedFiles.length === 0) {
        return incomingSnapshot;
    }

    return {
        ...incomingSnapshot,
        trackedFiles: pendingTrackedFiles,
    };
}

function isTrackedFileRepresented(
    trackedFiles: readonly AiTrackedFile[],
    candidate: AiTrackedFile,
    pathMatcher?: TrackedFilePathMatcher,
): boolean {
    return trackedFiles.some(
        (trackedFile) =>
            trackedFile.identityKey === candidate.identityKey ||
            trackedFilesSharePath(trackedFile, candidate, pathMatcher),
    );
}

function trackedFilesSharePath(
    left: AiTrackedFile,
    right: AiTrackedFile,
    pathMatcher?: TrackedFilePathMatcher,
): boolean {
    const leftPaths = getTrackedFileIdentityPaths(left);
    const rightPaths = getTrackedFileIdentityPaths(right);
    return leftPaths.some((leftPath) =>
        rightPaths.some((rightPath) =>
            leftPath === rightPath || pathMatcher?.(leftPath, rightPath),
        ),
    );
}

function getTrackedFileIdentityPaths(
    trackedFile: AiTrackedFile,
): readonly string[] {
    return trackedFile.previousPath
        ? [trackedFile.path, trackedFile.previousPath]
        : [trackedFile.path];
}

function removeTrackedFileByIdentity(
    trackedFiles: readonly AiTrackedFile[],
    identityKey: string,
): readonly AiTrackedFile[] {
    return trackedFiles.filter(
        (trackedFile) => trackedFile.identityKey !== identityKey,
    );
}

function replaceTrackedFileByIdentity(
    trackedFiles: readonly AiTrackedFile[],
    identityKey: string,
    nextTrackedFile: AiTrackedFile | null,
): readonly AiTrackedFile[] {
    const nextTrackedFiles = removeTrackedFileByIdentity(
        trackedFiles,
        identityKey,
    );
    return nextTrackedFile
        ? [...nextTrackedFiles, nextTrackedFile]
        : nextTrackedFiles;
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

function upsertNativeMessage(
    messages: readonly AiMessage[],
    message: AiMessage,
): readonly AiMessage[] {
    const existingIndex = messages.findIndex(
        (candidate) => candidate.id === message.id,
    );
    if (existingIndex < 0) {
        return [...messages, message];
    }

    return messages.map((candidate, index) =>
        index === existingIndex ? { ...candidate, ...message } : candidate,
    );
}

function updateNativeMessageContent(
    messages: readonly AiMessage[],
    messageId: string,
    content: string,
): readonly AiMessage[] {
    return messages.map((message) =>
        message.id === messageId
            ? {
                  ...message,
                  content,
                  status: "streaming" as const,
              }
            : message,
    );
}

function completeNativeMessage(
    messages: readonly AiMessage[],
    messageId: string,
): readonly AiMessage[] {
    return messages.map((message) =>
        message.id === messageId
            ? {
                  ...message,
                  status: "completed" as const,
              }
            : message,
    );
}

function upsertNativeToolActivity(
    activities: readonly AiToolActivity[],
    activity: AiToolActivity,
): readonly AiToolActivity[] {
    const existingIndex = activities.findIndex(
        (candidate) => candidate.id === activity.id,
    );
    if (existingIndex < 0) {
        return [...activities, activity];
    }

    return activities.map((candidate, index) =>
        index === existingIndex
            ? {
                  ...candidate,
                  ...activity,
                  diffs:
                      activity.diffs.length > 0
                          ? activity.diffs
                          : candidate.diffs,
              }
            : candidate,
    );
}

function mergePersistedCatalogIntoSessionSnapshot(
    snapshot: AiSessionSnapshot,
    catalog: PersistedRuntimeCatalogSnapshot,
): AiSessionSnapshot {
    return {
        ...snapshot,
        availableCommands:
            snapshot.availableCommands.length > 0
                ? snapshot.availableCommands
                : catalog.availableCommands,
        configOptions:
            snapshot.configOptions.length > 0
                ? snapshot.configOptions
                : catalog.configOptions,
        modeId: snapshot.modeId ?? catalog.modeId,
        modes: snapshot.modes.length > 0 ? snapshot.modes : catalog.modes,
        modelId: snapshot.modelId ?? catalog.modelId,
        models: snapshot.models.length > 0 ? snapshot.models : catalog.models,
    };
}

function mergePersistedCatalogIntoRuntimeStatus(
    status: AiRuntimeStatus,
    catalog: PersistedRuntimeCatalogSnapshot,
): AiRuntimeStatus {
    return {
        ...status,
        availableCommands:
            status.availableCommands && status.availableCommands.length > 0
                ? status.availableCommands
                : catalog.availableCommands,
        configOptions:
            status.configOptions && status.configOptions.length > 0
                ? status.configOptions
                : catalog.configOptions,
        modeId: status.modeId ?? catalog.modeId,
        modes:
            status.modes && status.modes.length > 0
                ? status.modes
                : catalog.modes,
        modelId: status.modelId ?? catalog.modelId,
        models:
            status.models && status.models.length > 0
                ? status.models
                : catalog.models,
    };
}

function buildPersistedRuntimeCatalogPatch(
    snapshot: AiSessionSnapshot,
    patch: NormalizedSessionCatalogPayload,
): Partial<PersistedRuntimeCatalogSnapshot> {
    return {
        ...(patch.availableCommands !== undefined
            ? { availableCommands: snapshot.availableCommands }
            : {}),
        ...(patch.configOptions !== undefined
            ? {
                  configOptions: snapshot.configOptions,
                  modeId: snapshot.modeId,
                  modes: snapshot.modes,
                  modelId: snapshot.modelId,
                  models: snapshot.models,
              }
            : {}),
        ...(patch.modeId !== undefined ? { modeId: snapshot.modeId } : {}),
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
        snapshot.trackedFiles.some(isAiTrackedFileUnresolved)
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

function applyRuntimeSelectionPreferencesToConfigOptions(
    configOptions: readonly AiSessionConfigOption[],
    preferences: Record<string, boolean | string>,
    preferredModeId: string | null,
    preferredModelId: string | null,
): readonly AiSessionConfigOption[] {
    return configOptions.map((option) => {
        const savedValue = getRuntimeSelectionPreferenceValue(
            preferences,
            option.id,
        );
        const preferredValue = savedValue ?? getTopLevelSelectionPreference(
            option,
            preferredModeId,
            preferredModelId,
        );
        if (preferredValue === undefined || option.value === preferredValue) {
            return option;
        }

        if (option.type === "boolean" && typeof preferredValue === "boolean") {
            return {
                ...option,
                value: preferredValue,
            };
        }

        if (
            option.type === "select" &&
            typeof preferredValue === "string" &&
            hasSelectConfigValue(option, preferredValue)
        ) {
            return {
                ...option,
                value: preferredValue,
            };
        }

        return option;
    });
}

function getPreferredConfigSelectionId(
    preferences: Record<string, boolean | string>,
    configOptions: readonly AiSessionConfigOption[],
    matchesOption: (option: AiSessionConfigOption) => boolean,
): string | null {
    const option = configOptions.find(matchesOption);
    if (!option) {
        return null;
    }

    const preferredValue = getRuntimeSelectionPreferenceValue(
        preferences,
        option.id,
    );
    return option.type === "select" &&
        typeof preferredValue === "string" &&
        hasSelectConfigValue(option, preferredValue)
        ? preferredValue
        : null;
}

interface PreferredConfigOptionMutation {
    readonly optionId: string;
    readonly priority: number;
    readonly value: boolean | string;
}

function getPreferredConfigOptionMutations(
    snapshot: Pick<
        AiSessionSnapshot,
        "configOptions" | "modeId" | "modelId"
    >,
    preferences: {
        readonly configOptions: Record<string, boolean | string>;
        readonly modeId: string | null;
        readonly modelId: string | null;
    },
): readonly PreferredConfigOptionMutation[] {
    return snapshot.configOptions
        .map((option) => {
            const savedValue = getRuntimeSelectionPreferenceValue(
                preferences.configOptions,
                option.id,
            );
            const preferredValue = savedValue ?? getTopLevelSelectionPreference(
                option,
                preferences.modeId,
                preferences.modelId,
            );
            if (
                preferredValue === undefined ||
                option.value === preferredValue
            ) {
                return null;
            }

            if (
                option.type === "boolean" &&
                typeof preferredValue === "boolean"
            ) {
                return {
                    optionId: option.id,
                    priority: getConfigOptionPreferencePriority(option),
                    value: preferredValue,
                };
            }

            if (
                option.type === "select" &&
                typeof preferredValue === "string" &&
                hasSelectConfigValue(option, preferredValue)
            ) {
                return {
                    optionId: option.id,
                    priority: getConfigOptionPreferencePriority(option),
                    value: preferredValue,
                };
            }

            return null;
        })
        .filter(
            (mutation): mutation is PreferredConfigOptionMutation =>
                mutation !== null,
        )
        .sort((left, right) => left.priority - right.priority);
}

function getConfigOptionPreferencePriority(
    option: AiSessionConfigOption,
): number {
    if (isModelConfigOption(option)) {
        return 0;
    }

    if (isModeConfigOption(option)) {
        return 1;
    }

    return 2;
}

function getRuntimeSelectionPreferenceValue(
    preferences: Record<string, boolean | string>,
    optionId: string,
): boolean | string | undefined {
    return Object.prototype.hasOwnProperty.call(preferences, optionId)
        ? preferences[optionId]
        : undefined;
}

function getTopLevelSelectionPreference(
    option: AiSessionConfigOption,
    preferredModeId: string | null,
    preferredModelId: string | null,
): string | undefined {
    if (isModeConfigOption(option)) {
        return preferredModeId ?? undefined;
    }

    if (isModelConfigOption(option)) {
        return preferredModelId ?? undefined;
    }

    return undefined;
}

function isModeConfigOption(option: AiSessionConfigOption): boolean {
    return option.category === "mode" || option.id.toLowerCase() === "mode";
}

function isModelConfigOption(option: AiSessionConfigOption): boolean {
    return option.category === "model" || option.id.toLowerCase() === "model";
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
    if (typeof timer.unref === "function") {
        timer.unref();
    }
}

function nativeSecretPatchesFromValuePatch(
    envKey: string,
    patch: SecretValuePatch,
    resolvedValue: string | null,
): readonly NativeAiSecretPatchRpcInput[] {
    switch (patch.kind) {
        case "clear":
            return [{ action: "delete", envKey }];
        case "set":
            return [
                {
                    action: resolvedValue?.trim() ? "set" : "delete",
                    envKey,
                    value: resolvedValue,
                },
            ];
        case "unchanged":
            return [];
    }
}

function nativeSetSecretPatch(
    envKey: string,
    value: string | null,
): readonly NativeAiSecretPatchRpcInput[] {
    const normalized = normalizeOptionalText(value);
    return normalized
        ? [
              {
                  action: "set",
                  envKey,
                  value: normalized,
              },
          ]
        : [];
}

export const __testing = {
    computeDiffHunks,
    diffToAiFileDiff,
    normalizeTrackedDiffPath,
    parseCompleteNumberedFileOutput,
    resolveDiffToFullTexts,
    resolveTrackedFileHunks,
    shouldSuppressToolActivityUpdate,
    upsertTrackedFile,
};
