import path from "node:path";
import fs from "node:fs";
import type {
    AiHistorySessionSummary,
    AiFileDiff,
    AiPermissionResponseInput,
    AiPromptResult,
    AiPromptQueueSnapshot,
    AiQueuedPromptMutationInput,
    PrepareAiSessionInput,
    AiRuntimeAuthLaunchInput,
    AiRuntimeAuthDisconnectInput,
    AiRuntimeAuthLogoutInput,
    AiRuntimeId,
    AiRuntimeStatus,
    AiSessionDomainEvent,
    AiSessionEventOrigin,
    AiSessionConfigOption,
    AiSessionConfigOptionMutationInput,
    AiSessionModeMutationInput,
    AiSessionModelMutationInput,
    AiSessionPinnedMutationInput,
    AiSessionUpdate,
    AiSessionRenameMutationInput,
    AiSessionSnapshot,
    AiReviewDeltaDetails,
    AiReviewDeltaSummary,
    AiSessionTranscriptPage,
    AiTranscriptBlock,
    AiTranscriptBlockMetadataOutput,
    AiTranscriptCapability,
    AiLoadTranscriptPayloadInput,
    AiLoadTranscriptPayloadsInput,
    AiLoadToolActivityDetailInput,
    AiToolActivityDetail,
    AiToolActivity,
    AiTranscriptPayload,
    AiTranscriptPayloadsOutput,
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
    EnqueueAiPromptInput,
    SendAiPromptInput,
    UpdateAiQueuedPromptInput,
} from "@shared/ipc";
import {
    nativeAiToolActivityDetailToIpc,
    nativeReviewTrackedFileToIpc,
} from "@shared/native-backend/adapters";
import {
    computeDiffHunks,
    getTrackedFileCurrentText,
    getTrackedFileDiffBase,
    isAiTrackedFileUnresolved,
    resolveTrackedFileHunks,
    upsertTrackedFile,
} from "@shared/ai-tracked-file";
import {
    attachNativeReviewDeltaToTrackedFile,
    toNativeReviewDeltaReference,
} from "@shared/ai-review-delta";
import { createCustomRuntimeChangeConfirmationErrorMessage } from "@shared/ai-session-errors";
import {
    beginReviewWorkCycle,
    consolidateReviewDiffs,
    createReviewActionLogFromTrackedFiles,
    deriveTrackedFilesFromActionLog,
    isReviewTargetVersionCurrent,
    keepReviewFile,
    keepReviewRanges,
    markReviewFileConflict,
    rejectReviewFile,
    rejectReviewRanges,
    resolveReviewTarget,
    settleAcceptedReviewFile,
    type AiReviewActionLogState,
    type AiReviewActionLogTarget,
} from "@shared/ai-review-action-log";
import { isReasoningEffortConfigOption } from "@shared/ai-config-options";
import { isCustomAcpRuntimeId } from "@shared/ai-runtimes";

import type { ProjectService } from "@main/projects/service";
import type { SettingsGateway } from "@main/settings/service";
import type {
    SecretRecordPatch,
    SecretStoreGateway,
} from "@main/ai/secret-store";
import { debugBenignError } from "@main/observability/logging";
import { NativeBackendError } from "@main/native-backend/client";

import {
    createEmptyAiSessionSnapshot,
    type AiPersistenceGateway,
    type PersistedRuntimeCatalogSnapshot,
    type PersistedRuntimeSelectionPreferences,
} from "./persistence";
import { createAiEnvironmentDiagnostics } from "./environment-diagnostics";
import { AiPromptQueue } from "./prompt-queue";
import { listOpenFileBuffers } from "./openFileBuffers";
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
    getRuntimeDisplayName,
    hasSelectConfigValue,
    isPathInsideRoot,
    isSamePath,
    normalizeAdditionalRoots,
    normalizeAiSessionHierarchy,
    normalizeRestoredAiSessionSnapshot,
    resolveSessionScopedPath,
    setConfigOptionOnSnapshot,
    setManualTitleOnSnapshot,
    setModeOnSnapshot,
    setModelOnSnapshot,
    setReasoningEffortOnSnapshot,
    setRuntimeTitleOnSnapshot,
    type NormalizedSessionCatalogPayload,
} from "./session-core";
import {
    diffToAiFileDiff,
    normalizeTrackedDiffPath,
    parseCompleteNumberedFileOutput,
    resolveDiffToFullTexts,
    shouldSuppressToolActivityUpdate,
} from "./review-core";
import { buildRuntimeSpawnEnv } from "./runtime-env";
import {
    createMissingCustomAcpRuntimeStatus,
    resolveCustomAcpRuntime,
} from "./custom-acp-launch";
import { resolveCodexRuntime } from "./resolver/runtime-resolver";
import {
    AiLiveTranscriptTailStore,
    type AiLiveTranscriptTailSnapshot,
} from "./live-transcript";
import {
    AiTranscriptPersistenceCoordinator,
    type AiTranscriptPersistenceStatus,
} from "./transcript-persistence";
import {
    applyCodexAuthEnv,
    buildCodexSecretPatches,
    getCodexRuntimeStatus,
    type CodexSecretBundle,
    loadCodexSecretBundle,
} from "./codex/setup";
import {
    applyClaudeAuthEnv,
    buildClaudeSecretPatches,
    getClaudeRuntimeStatus,
    launchClaudeLogin,
    loadClaudeSecretBundle,
    markClaudeAuthInvalidated,
    resolveClaudeRuntime,
} from "./claude/setup";
import {
    applyKiloAuthEnv,
    buildKiloSecretPatches,
    getKiloRuntimeStatus,
    launchKiloLogin,
    markKiloAuthInvalidated,
    resolveKiloRuntime,
} from "./kilo/setup";
import {
    applyGrokAuthEnv,
    buildGrokSecretPatches,
    getGrokRuntimeStatus,
    isGrokExternalCredentialReady,
    launchGrokLogin,
    loadGrokSecretBundle,
    markGrokAuthInvalidated,
    resolveGrokRuntime,
} from "./grok/setup";
import {
    applyOpenCodeAuthEnv,
    getOpenCodeRuntimeStatus,
    isOpenCodeEnvironmentCredentialReady,
    launchOpenCodeLogin,
    markOpenCodeAuthInvalidated,
    resolveOpenCodeRuntime,
} from "./opencode/setup";

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
    readonly inherited: boolean;
    readonly messageId: string;
    readonly promptAccepted: boolean;
    readonly terminalStatusSeen: boolean;
    readonly turnStarted: boolean;
    readonly workCycleId: string;
}

interface RecentNativeReviewContext {
    readonly additionalRoots: readonly string[];
    readonly cwd: string;
    readonly expiresAtMs: number;
    readonly workCycleId: string;
}

type NativeAiReviewGateway = NativeAiGateway &
    Required<
        Pick<
            NativeAiGateway,
            | "captureReviewBaseline"
            | "loadReviewDelta"
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
const RETENTION_CLOSE_EVENT_GRACE_MS = 60_000;
const TRANSCRIPT_BACKFILL_RETRY_DELAY_MS = 25;

function isResyncEligibleAiSessionStatus(
    status: AiSessionSnapshot["status"],
): boolean {
    return (
        status === "starting" ||
        status === "streaming" ||
        status === "waiting_permission" ||
        status === "waiting_user_input"
    );
}

type AiSchedulerPriority = 0 | 1 | 2 | 3;

interface AiSchedulerDiagnostics {
    readonly activeColdStarts: number;
    readonly activeColdStartsByRuntime: Readonly<Record<string, number>>;
    readonly maxColdStartsGlobal: number;
    readonly maxColdStartsPerRuntime: number;
    readonly queued: number;
}

interface AiSessionRetentionDiagnostics {
    readonly activeCustomRuntimeLaunchCount: number;
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

interface AiSessionRetentionCandidate {
    readonly reason: AiSessionFreezeReason;
    readonly sessionId: string;
    readonly touch: {
        readonly lastUsedAtMs: number;
        readonly order: number;
    };
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
    readonly #frozenSessionIds = new Set<string>();
    readonly #retentionCloseEventSessionIds = new Set<string>();
    readonly #retentionCloseRuntimeSessionIds = new Map<string, Set<string>>();
    readonly #retentionCloseRuntimeSessionTimers = new Map<
        string,
        ReturnType<typeof setTimeout>
    >();
    readonly #retentionFreezePromises = new Map<string, Promise<void>>();
    readonly #lastRetentionCloseRecords: AiSessionRetentionCloseRecord[] = [];
    readonly #lastRetentionSkippedRecords: AiSessionRetentionSkippedRecord[] = [];
    readonly #activeCustomRuntimeLaunches = new Map<
        string,
        ResolvedAcpRuntime
    >();
    readonly #liveSessionContexts = new Map<string, LiveSessionContext>();
    readonly #liveSnapshots = new Map<string, AiSessionSnapshot>();
    readonly #runtimeSubscribers = new Map<string, string>();
    readonly #terminalOutputBytesBySessionId = new Map<
        string,
        Map<string, number>
    >();
    readonly #liveTranscriptTails = new AiLiveTranscriptTailStore();
    readonly #loadedTranscriptBlockMetadataSessionIds = new Set<string>();
    readonly #legacyTranscriptSessionIds = new Set<string>();
    readonly #loadingTranscriptBlockMetadataSessionIds = new Set<string>();
    readonly #loadingTranscriptBlockMetadataRequestSessionIds = new Set<string>();
    readonly #pendingTranscriptBlockMetadataReloadSessionIds = new Set<string>();
    readonly #transcriptBlockMetadataGenerations = new Map<string, number>();
    readonly #recoveredTranscriptTailSessionIds = new Set<string>();
    readonly #transcriptRecoveryPromises = new Map<string, Promise<void>>();
    readonly #transcriptMigrationTimers = new Map<
        string,
        ReturnType<typeof setTimeout>
    >();
    readonly #liveSessionTouches = new Map<
        string,
        {
            readonly lastUsedAtMs: number;
            readonly order: number;
        }
    >();
    readonly #capturedRuntimeDefaultsBySessionId = new Map<
        string,
        CapturedRuntimeDefaults
    >();
    readonly #selectionMutationChains = new Map<string, Promise<void>>();
    #nativeAi: NativeAiGateway | null;
    #transcriptPersistence: AiTranscriptPersistenceCoordinator | null = null;
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
    readonly #resolvedReviewVersions = new Map<string, Map<string, number>>();
    readonly #nativeReviewDeltaDetails = new Map<
        string,
        AiReviewDeltaDetails
    >();
    readonly #reviewMutationChains = new Map<string, Promise<void>>();
    readonly #nativeSessionIds = new Set<string>();
    readonly #transcriptStorageModes = new Map<
        string,
        "block-native" | "legacy" | "migrating"
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
    readonly #promptQueue: AiPromptQueue;
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
        this.#transcriptPersistence = this.#createTranscriptPersistence(
            this.#nativeAi,
        );
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
        this.#promptQueue = new AiPromptQueue({
            cancelSession: (sessionId) => this.#cancelNativeSession(sessionId),
            dispatchPrompt: (input, ownerWindowId) =>
                this.sendPrompt(
                    input,
                    this.#liveSessionContexts.get(input.sessionId)
                        ?.ownerWindowId ?? ownerWindowId,
                ),
            getSessionSnapshot: (sessionId) =>
                this.#liveSnapshots.get(sessionId) ?? null,
            loadSnapshots: () =>
                this.#persistence.loadPromptQueueSnapshots?.() ?? [],
            onSnapshot: (ownerWindowId, snapshot) =>
                options.onPromptQueueSnapshot?.(ownerWindowId, snapshot),
            saveSnapshots: (snapshots) =>
                this.#persistence.savePromptQueueSnapshots?.(snapshots),
        });
    }

    setNativeAiGateway(nativeAi: NativeAiGateway | null): void {
        this.#nativeAi = nativeAi;
        this.#transcriptPersistence = this.#createTranscriptPersistence(nativeAi);
    }

    close(): void {
        this.#clearSessionRetentionTimer();
        const nativeAi = this.#nativeAi;
        void (this.#transcriptPersistence?.shutdown(750) ?? Promise.resolve(true))
            .then(() => nativeAi?.close())
            .catch((error: unknown) => {
                debugBenignError("ai.service.close.native", error);
            });
        this.#nativeReviewBaselines.clear();
        this.#recentNativeReviewContexts.clear();
        this.#resolvedReviewVersions.clear();
        this.#reviewMutationChains.clear();
        this.#nativeSessionIds.clear();
        this.#pendingNativeCatalogPatches.clear();
        this.#activeCustomRuntimeLaunches.clear();
        this.#liveSessionContexts.clear();
        this.#liveSnapshots.clear();
        this.#runtimeSubscribers.clear();
        this.#liveTranscriptTails.clear();
        this.#loadedTranscriptBlockMetadataSessionIds.clear();
        this.#loadingTranscriptBlockMetadataSessionIds.clear();
        this.#loadingTranscriptBlockMetadataRequestSessionIds.clear();
        this.#pendingTranscriptBlockMetadataReloadSessionIds.clear();
        this.#transcriptBlockMetadataGenerations.clear();
        this.#recoveredTranscriptTailSessionIds.clear();
        this.#transcriptRecoveryPromises.clear();
        for (const timer of this.#transcriptMigrationTimers.values()) {
            clearTimeout(timer);
        }
        this.#transcriptMigrationTimers.clear();
        this.#liveSessionTouches.clear();
        for (const sessionId of this.#retentionCloseRuntimeSessionIds.keys()) {
            this.#forgetRetentionCloseRuntimeSessions(sessionId);
        }
    }

    getSchedulerDiagnostics(): AiSchedulerDiagnostics {
        return this.#scheduler.getDiagnostics();
    }

    getSessionRetentionDiagnostics(): AiSessionRetentionDiagnostics {
        return {
            activeCustomRuntimeLaunchCount:
                this.#activeCustomRuntimeLaunches.size,
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

    getLiveSessionSnapshotsForWindow(
        ownerWindowId: string,
    ): readonly AiSessionSnapshot[] {
        const snapshots: AiSessionSnapshot[] = [];
        for (const context of this.#liveSessionContexts.values()) {
            if (
                context.ownerWindowId !== ownerWindowId ||
                this.#deletedSessionIds.has(context.sessionId)
            ) {
                continue;
            }

            const storedSnapshot =
                this.#liveSnapshots.get(context.sessionId) ?? null;
            const snapshot = storedSnapshot
                ? this.#liveTranscriptTails.projectLegacySnapshot(storedSnapshot)
                : null;
            if (snapshot && isResyncEligibleAiSessionStatus(snapshot.status)) {
                snapshots.push(this.#toRendererSessionSnapshot(snapshot));
            }
        }

        return snapshots;
    }

    attachRuntimeSubscriber(
        runtimeOwnerId: string,
        subscriberId: string,
    ): readonly AiSessionSnapshot[] {
        this.#runtimeSubscribers.set(runtimeOwnerId, subscriberId);
        return this.getLiveSessionSnapshotsForWindow(runtimeOwnerId);
    }

    detachRuntimeSubscriber(
        runtimeOwnerId: string,
        subscriberId: string,
    ): boolean {
        if (this.#runtimeSubscribers.get(runtimeOwnerId) !== subscriberId) {
            return false;
        }
        this.#runtimeSubscribers.delete(runtimeOwnerId);
        return true;
    }

    resyncRuntimeSubscriber(
        runtimeOwnerId: string,
        subscriberId: string,
    ): readonly AiSessionSnapshot[] {
        return this.#runtimeSubscribers.get(runtimeOwnerId) === subscriberId
            ? this.getLiveSessionSnapshotsForWindow(runtimeOwnerId)
            : [];
    }

    isRuntimeSubscriberCurrent(
        runtimeOwnerId: string,
        subscriberId: string,
    ): boolean {
        return this.#runtimeSubscribers.get(runtimeOwnerId) === subscriberId;
    }

    getLiveSessionSnapshotForWindow(
        ownerWindowId: string,
        sessionId: string,
    ): AiSessionSnapshot | null {
        const context = this.#liveSessionContexts.get(sessionId);
        if (
            !context ||
            context.ownerWindowId !== ownerWindowId ||
            this.#deletedSessionIds.has(sessionId)
        ) {
            return null;
        }

        const snapshot = this.#liveSnapshots.get(sessionId) ?? null;
        return snapshot ? this.#toRendererSessionSnapshot(snapshot) : null;
    }

    getLiveTranscriptTail(
        sessionId: string,
    ): AiLiveTranscriptTailSnapshot | null {
        return this.#liveTranscriptTails.getSnapshot(sessionId);
    }

    getTranscriptPersistenceStatus(
        sessionId: string,
    ): AiTranscriptPersistenceStatus | null {
        return this.#transcriptPersistence?.getStatus(sessionId) ?? null;
    }

    handleNativeRuntimeStatus(status: AiRuntimeStatus): void {
        this.#onRuntimeStatus(this.#withPersistedRuntimeCatalog(status));
    }

    handleNativeSessionClosed(payload: {
        readonly ownerWindowId: string;
        readonly sessionId: string;
    }): void {
        this.#transcriptPersistence?.requestSeal(
            payload.sessionId,
            "cancelled",
        );
        void this.#flushAndClearClosedSession(payload.sessionId);
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
        const preservePreviousReviewSnapshot =
            isNativeTrackedFilesPatch(update) ? null : previousSnapshot;
        const nextSnapshot = this.#drainPendingNativeCatalogPatches(
            this.#preservePassiveNativeSnapshotTrackedFiles(
                this.#hydrateSnapshotRuntimeCatalog(snapshot),
                preservePreviousReviewSnapshot,
            ),
            ownerWindowId,
        );
        this.#liveTranscriptTails.synchronizeSnapshot(nextSnapshot);
        // Snapshots can be the only delivery path during a reconnect, so their
        // active tail must enter the same durable queue as event-driven updates.
        // Recovery runs first so a restarted runtime cannot overwrite an older
        // persisted tail before it is restored or reconciled.
        this.#scheduleTranscriptCheckpointAfterRecovery(nextSnapshot.sessionId);
        this.#scheduleTranscriptBlockMetadataLoad(nextSnapshot.sessionId);
        const cachedSnapshot = this.#cacheLiveSessionSnapshot(
            preserveCanonicalTranscriptArrays(
                previousSnapshot,
                nextSnapshot,
            ),
            ownerWindowId,
        );
        this.#persistence.saveSessionSnapshot(cachedSnapshot);
        this.#promptQueue.handleSessionSnapshot(cachedSnapshot);
        this.#onSessionSnapshot(
            ownerWindowId,
            this.#buildRendererSessionUpdate(previousSnapshot, cachedSnapshot),
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

        // The runtime can deliver its close event after a retained session has
        // already been prepared again. Consume the close for the specific old
        // runtime session before it reaches snapshots, the renderer, or the
        // prompt queue.
        if (this.#consumeRetentionCloseEvent(event)) {
            return;
        }

        this.#liveTranscriptTails.applyEvent(event);
        this.#scheduleTranscriptCheckpointAfterRecovery(
            event.sessionId,
            this.#getTranscriptCheckpointChangedBytes(event),
        );
        if (event.kind === "turn-status") {
            this.#transcriptPersistence?.requestSeal(
                event.sessionId,
                event.status,
            );
        } else if (event.kind === "status" && event.status === "error") {
            this.#transcriptPersistence?.requestSeal(event.sessionId, "failed");
        } else if (event.kind === "session-closed") {
            this.#transcriptPersistence?.requestSeal(
                event.sessionId,
                "cancelled",
            );
        }

        const previousSnapshot = this.#liveSnapshots.get(event.sessionId);
        if (previousSnapshot) {
            const nextSnapshot = this.#applyNativeSessionEvent(
                previousSnapshot,
                event,
            );
            const cachedSnapshot = this.#cacheLiveSessionSnapshot(
                nextSnapshot,
                ownerWindowId,
            );
            if (event.kind === "review-delta") {
                // Native history owns the transcript, while review deltas are main-owned
                // session state. Checkpoint each revision without persisting token traffic.
                this.#persistence.saveSessionSnapshot(cachedSnapshot);
                this.#hydrateAndPersistNativeReviewDelta(
                    ownerWindowId,
                    event.sessionId,
                    event.delta,
                );
            }
            this.#onSessionSnapshot(
                ownerWindowId,
                this.#buildRendererSessionUpdate(previousSnapshot, cachedSnapshot),
            );
            if (this.#isNativeAiSession(event.sessionId)) {
                if (event.kind === "status" && event.status === "streaming") {
                    this.#markNativeReviewTurnStarted(event.sessionId);
                }
                if (
                    event.kind === "status" &&
                    (event.status === "idle" || event.status === "error")
                ) {
                    this.#markNativeReviewTerminalStatusSeen(event.sessionId);
                    if (this.#shouldFinishNativeReviewBaseline(event)) {
                        this.#finishNativeReviewBaseline(event.sessionId);
                    }
                }
            }
        }

        if (event.kind === "subagent-created") {
            this.#nativeChildParentSessionIds.set(
                event.childSessionId,
                event.parentSessionId,
            );
            this.#inheritNativeReviewContext(
                event.parentSessionId,
                event.childSessionId,
            );
        }

        if (!previousSnapshot && event.kind === "subagent-created") {
            const parentSnapshot = this.#liveSnapshots.get(event.parentSessionId);
            if (parentSnapshot) {
                const baseChildSnapshot: AiSessionSnapshot = {
                    ...parentSnapshot,
                    activeTurnStartedAt: null,
                    closedAt: null,
                    lastError: null,
                    messages: [],
                    parentSessionId: event.parentSessionId,
                    pendingPermission: null,
                    pendingUserInput: null,
                    plan: null,
                    reasoningEffort: null,
                    runtimeSessionId:
                        event.childRuntimeSessionId ?? event.runtimeSessionId,
                    sessionId: event.childSessionId,
                    status: "idle",
                    title: event.title,
                    tokenUsage: null,
                    toolActivity: [],
                    reviewActionLog: null,
                    trackedFiles: [],
                    updatedAt: event.updatedAt,
                };
                let childSnapshot = event.modelId
                    ? setModelOnSnapshot(
                          baseChildSnapshot,
                          event.modelId,
                          event.updatedAt,
                      )
                    : baseChildSnapshot;
                childSnapshot = event.reasoningEffort
                    ? setReasoningEffortOnSnapshot(
                          childSnapshot,
                          event.reasoningEffort,
                          event.updatedAt,
                      )
                    : childSnapshot;
                const cachedChildSnapshot = this.#cacheLiveSessionSnapshot(
                    childSnapshot,
                    ownerWindowId,
                );
                this.#nativeSessionIds.add(event.childSessionId);
                this.#onSessionSnapshot(ownerWindowId, {
                    kind: "snapshot",
                    snapshot: cachedChildSnapshot,
                });
            }
        }

        this.#promptQueue.handleSessionEvent(event);
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
        this.#scheduleCapturedRuntimeDefaultsApplication(
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
        const nativeAi = isCustomAcpRuntimeId(runtimeId)
            ? null
            : this.#nativeAuthGateway(runtimeId);
        if (nativeAi?.getRuntimeStatus) {
            await this.#migrateNativeRuntimeSettingsIfNeeded(runtimeId);
            const status = this.#withPersistedRuntimeCatalog(
                await nativeAi.getRuntimeStatus(runtimeId),
            );
            this.#onRuntimeStatus(status);
            return status;
        }

        const status = this.#withPersistedRuntimeCatalog(
            this.#resolveRuntimeStatus(runtimeId),
        );
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
            await this.#refreshTranscriptStorageMode(sessionId);
            return this.#toRendererSessionSnapshot(liveSnapshot);
        }

        const persistedSnapshot =
            await this.#loadPersistedSessionSnapshot(sessionId);
        if (!persistedSnapshot) return null;
        await this.#refreshTranscriptStorageMode(sessionId, {
            preserveLegacyFallback: true,
        });
        if (this.#usesBlockNativeTranscript(sessionId)) {
            // Historical sessions cannot receive the terminal event that
            // would normally seal an interrupted tail after a restart.
            await this.#recoverTranscriptTail(sessionId, {
                sealInterruptedTail: !isResyncEligibleAiSessionStatus(
                    persistedSnapshot.status,
                ),
            });
        }
        return this.#toRendererSessionSnapshot(
            this.#hydrateSnapshotRuntimeCatalog(persistedSnapshot),
        );
    }

    async listSessionHistory(
        input: ListAiSessionHistoryInput,
    ): Promise<readonly AiHistorySessionSummary[]> {
        if (this.#nativeAi?.shouldHandleHistory()) {
            return await this.#nativeAi.listSessionHistory(input);
        }
        return await this.#persistence.listSessionHistory(input);
    }

    async countSessionHistoryByRuntime(
        runtimeId: AiRuntimeId,
    ): Promise<number> {
        return (
            (await this.#nativeAi?.countSessionHistoryByRuntime?.(runtimeId)) ??
            0
        );
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

    getTranscriptCapability(): AiTranscriptCapability {
        return (
            this.#nativeAi?.getTranscriptCapability?.() ?? {
                blockNativeVersion: null,
                legacyFallbackAvailable: true,
            }
        );
    }

    async getTranscriptBlockMetadata(
        sessionId: string,
    ): Promise<AiTranscriptBlockMetadataOutput | null> {
        const nativeAi = this.#nativeAi;
        if (
            !nativeAi?.getTranscriptCapability?.().blockNativeVersion ||
            !nativeAi.loadTranscriptBlockMetadata
        ) {
            return null;
        }
        if (!(await this.#refreshTranscriptStorageMode(sessionId))) {
            return null;
        }
        const hasLiveSnapshot = this.#liveSnapshots.has(sessionId);
        if (!hasLiveSnapshot) {
            const persistedSnapshot =
                await this.#loadPersistedSessionSnapshot(sessionId);
            if (
                persistedSnapshot &&
                !isResyncEligibleAiSessionStatus(persistedSnapshot.status)
            ) {
                // Metadata can race ahead of session hydration after restart.
                // Resolve the historical tail before exposing sealed blocks.
                await this.#recoverTranscriptTail(sessionId, {
                    sealInterruptedTail: true,
                });
            } else {
                await this.#recoverTranscriptTail(sessionId);
            }
        } else {
            // A live snapshot can arrive before the persisted tail is loaded.
            // Do not expose block metadata until that predecessor is resolved.
            await this.#recoverTranscriptTail(sessionId);
        }
        // Recovery can seal blocks and advance the storage revision. Re-read
        // the mode before returning metadata from the post-recovery state.
        if (!(await this.#refreshTranscriptStorageMode(sessionId))) {
            return null;
        }
        return await nativeAi.loadTranscriptBlockMetadata(sessionId);
    }

    async getTranscriptBlock(
        sessionId: string,
        blockId: string,
    ): Promise<AiTranscriptBlock | null> {
        const nativeAi = this.#nativeAi;
        if (
            !nativeAi?.getTranscriptCapability?.().blockNativeVersion ||
            !nativeAi.loadTranscriptBlock
        ) {
            return null;
        }
        if (!(await this.#refreshTranscriptStorageMode(sessionId))) {
            return null;
        }
        return await nativeAi.loadTranscriptBlock(sessionId, blockId);
    }

    async getTranscriptPayload(
        input: AiLoadTranscriptPayloadInput,
    ): Promise<AiTranscriptPayload | null> {
        const nativeAi = this.#nativeAi;
        if (
            !nativeAi?.getTranscriptCapability?.().blockNativeVersion ||
            !nativeAi.loadTranscriptPayload
        ) {
            return null;
        }
        if (!(await this.#refreshTranscriptStorageMode(input.sessionId))) {
            return null;
        }
        return await nativeAi.loadTranscriptPayload(input);
    }

    async getTranscriptPayloads(
        input: AiLoadTranscriptPayloadsInput,
    ): Promise<AiTranscriptPayloadsOutput | null> {
        const nativeAi = this.#nativeAi;
        if (
            !nativeAi?.getTranscriptCapability?.().blockNativeVersion ||
            !nativeAi.loadTranscriptPayloads
        ) {
            return null;
        }
        if (!(await this.#refreshTranscriptStorageMode(input.sessionId))) {
            return null;
        }
        return await nativeAi.loadTranscriptPayloads(input);
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
                            await this.#recoverTranscriptTail(
                                parentSnapshot.sessionId,
                            );
                        }
                        this.#adoptNativeSubagentSnapshot(
                            launch.persistedSnapshot,
                            ownerWindowId,
                        );
                        return launch.persistedSnapshot;
                    }

                    return await nativeAi.prepareSession({
                        input: nativePrepareLaunch.input,
                        launch: nativePrepareLaunch.launch,
                    });
                },
            );
            this.#nativeSessionIds.add(snapshot.sessionId);
            if (nativePrepareLaunch.launch.resolvedRuntime.customAcpLaunch) {
                this.#activeCustomRuntimeLaunches.set(
                    snapshot.sessionId,
                    nativePrepareLaunch.launch.resolvedRuntime,
                );
            }
            const acceptedSnapshot = this.#acceptPreparedLiveSnapshot(
                snapshot,
                ownerWindowId,
            );
            const reconciledSnapshot =
                await this.#applyCapturedRuntimeDefaults(
                    acceptedSnapshot.sessionId,
                    ownerWindowId,
                );
            await this.#recoverTranscriptTail(acceptedSnapshot.sessionId);
            await this.#refreshTranscriptStorageMode(acceptedSnapshot.sessionId);
            void this.#enforceSessionRetention();
            return this.#toRendererSessionSnapshot(
                reconciledSnapshot ?? acceptedSnapshot,
            );
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

    getPromptQueue(
        sessionId: string,
        ownerWindowId: string,
    ): AiPromptQueueSnapshot {
        return this.#promptQueue.getSnapshot(sessionId, ownerWindowId);
    }

    enqueuePrompt(
        input: EnqueueAiPromptInput,
        ownerWindowId: string,
    ): AiPromptQueueSnapshot {
        // Count the user's action before the asynchronous queue dispatcher
        // starts. This prevents a stale retention candidate from closing the
        // session just as a new prompt is being queued.
        this.#touchLiveSession(input.sessionId);
        return this.#promptQueue.enqueue(input, ownerWindowId);
    }

    removeQueuedPrompt(
        input: AiQueuedPromptMutationInput,
        ownerWindowId: string,
    ): AiPromptQueueSnapshot {
        return this.#promptQueue.remove(
            input.sessionId,
            input.promptId,
            ownerWindowId,
        );
    }

    clearPromptQueue(
        sessionId: string,
        ownerWindowId: string,
    ): AiPromptQueueSnapshot {
        return this.#promptQueue.clear(sessionId, ownerWindowId);
    }

    beginEditQueuedPrompt(
        input: AiQueuedPromptMutationInput,
        ownerWindowId: string,
    ): AiPromptQueueSnapshot {
        return this.#promptQueue.beginEdit(
            input.sessionId,
            input.promptId,
            ownerWindowId,
        );
    }

    cancelEditQueuedPrompt(
        sessionId: string,
        ownerWindowId: string,
    ): AiPromptQueueSnapshot {
        return this.#promptQueue.cancelEdit(sessionId, ownerWindowId);
    }

    updateQueuedPrompt(
        input: UpdateAiQueuedPromptInput,
        ownerWindowId: string,
    ): AiPromptQueueSnapshot {
        return this.#promptQueue.update(input, ownerWindowId);
    }

    async steerQueuedPrompt(
        input: AiQueuedPromptMutationInput,
        ownerWindowId: string,
    ): Promise<AiPromptQueueSnapshot> {
        return await this.#promptQueue.steer(
            input.sessionId,
            input.promptId,
            ownerWindowId,
        );
    }

    async sendPrompt(
        input: SendAiPromptInput,
        ownerWindowId: string,
    ): Promise<AiPromptResult> {
        await this.#waitForReviewMutations(input.sessionId);
        await this.#waitForRetentionFreeze(input.sessionId);
        const launch = await this.#buildNativeSessionLaunchInput(
            input,
            ownerWindowId,
        );
        if (
            launch.persistedSnapshot.parentSessionId &&
            launch.persistedSnapshot.parentSessionId !==
                launch.persistedSnapshot.sessionId &&
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
                        if (
                            nativePrepareLaunch.launch.resolvedRuntime
                                .customAcpLaunch
                        ) {
                            this.#activeCustomRuntimeLaunches.set(
                                snapshot.sessionId,
                                nativePrepareLaunch.launch.resolvedRuntime,
                            );
                        }
                        nativeSendState.preparedSessionContext = {
                            ownerWindowId,
                            runtimeId: nativePrepareLaunch.input.runtimeId,
                            sessionId: snapshot.sessionId,
                        };
                        this.#acceptPreparedLiveSnapshot(
                            snapshot,
                            ownerWindowId,
                        );
                        await this.#applyCapturedRuntimeDefaults(
                            snapshot.sessionId,
                            ownerWindowId,
                        );
                        await this.#recoverTranscriptTail(snapshot.sessionId);
                    }
                    this.#adoptNativeSubagentSnapshot(
                        launch.persistedSnapshot,
                        ownerWindowId,
                    );
                    nativeSendState.capturedReviewBaseline =
                        await this.#prepareNativeReviewBaselineForPrompt(
                            input.sessionId,
                            ownerWindowId,
                            nativePrepareLaunch.launch,
                            input.messageId,
                        );
                    if (!this.#nativeReviewBaselines.has(input.sessionId)) {
                        nativeSendState.capturedReviewBaseline =
                            await this.#captureNativeReviewBaseline(
                                input.sessionId,
                                ownerWindowId,
                                nativePrepareLaunch.launch,
                                input.messageId,
                            );
                    }
                    let promptResult: AiPromptResult;
                    try {
                        promptResult = await nativeAi.sendPrompt({
                            input,
                            launch,
                        });
                    } catch (error) {
                        if (!isNativeAiSessionNotFoundError(error)) {
                            throw error;
                        }

                        // A runtime can evict an otherwise live session. The
                        // not-found response is definitive, so recreate once
                        // and retry this exact prompt without duplicating it.
                        debugBenignError("ai.service.recoverPrompt", error);
                        await this.#recoverMissingLiveSession(input.sessionId);
                        const recoveredLaunch =
                            await this.#buildNativeSessionLaunchInput(
                                input,
                                ownerWindowId,
                            );
                        promptResult = await nativeAi.sendPrompt({
                            input,
                            launch: recoveredLaunch,
                        });
                    }
                    if (promptResult.stopReason === "accepted") {
                        const terminalStatusAlreadySeen =
                            this.#markNativeReviewPromptAccepted(
                                input.sessionId,
                            );
                        if (terminalStatusAlreadySeen) {
                            this.#finishNativeReviewBaseline(input.sessionId);
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
        this.#cancelCapturedRuntimeDefaults(input.sessionId);
        await this.#enqueueSelectionMutation(input.sessionId, () =>
            this.#setSessionMode(input, { rememberRuntimePreference: true }),
        );
    }

    async #setSessionMode(
        input: AiSessionModeMutationInput,
        options: { readonly rememberRuntimePreference: boolean },
    ): Promise<void> {
        if (!this.#liveSessionContexts.has(input.sessionId)) {
            const snapshot = await this.#updateSessionSnapshot(
                input.sessionId,
                (currentSnapshot) =>
                    setModeOnSnapshot(currentSnapshot, input.modeId),
            );
            if (options.rememberRuntimePreference) {
                this.#rememberRuntimeModePreference(snapshot, input.modeId);
            }
            return;
        }

        await this.#runLiveSessionControlMutation(input.sessionId, () =>
            this.#requireNativeAiGateway().setSessionMode(input),
        );
        const snapshot = await this.#updateSessionSnapshot(
            input.sessionId,
            (currentSnapshot) =>
                setModeOnSnapshot(currentSnapshot, input.modeId),
        );
        if (options.rememberRuntimePreference) {
            this.#rememberRuntimeModePreference(snapshot, input.modeId);
        }
    }

    async setSessionModel(input: AiSessionModelMutationInput): Promise<void> {
        this.#cancelCapturedRuntimeDefaults(input.sessionId);
        await this.#enqueueSelectionMutation(input.sessionId, () =>
            this.#setSessionModel(input, { rememberRuntimePreference: true }),
        );
    }

    async #setSessionModel(
        input: AiSessionModelMutationInput,
        options: { readonly rememberRuntimePreference: boolean },
    ): Promise<void> {
        if (!this.#liveSessionContexts.has(input.sessionId)) {
            const snapshot = await this.#updateSessionSnapshot(
                input.sessionId,
                (currentSnapshot) =>
                    setModelOnSnapshot(currentSnapshot, input.modelId),
            );
            if (options.rememberRuntimePreference) {
                this.#rememberRuntimeModelPreference(snapshot, input.modelId);
            }
            return;
        }

        await this.#runLiveSessionControlMutation(input.sessionId, () =>
            this.#requireNativeAiGateway().setSessionModel(input),
        );
        const snapshot = await this.#updateSessionSnapshot(
            input.sessionId,
            (currentSnapshot) =>
                setModelOnSnapshot(currentSnapshot, input.modelId),
        );
        if (options.rememberRuntimePreference) {
            this.#rememberRuntimeModelPreference(snapshot, input.modelId);
        }
    }

    async setSessionConfigOption(
        input: AiSessionConfigOptionMutationInput,
    ): Promise<void> {
        this.#cancelCapturedRuntimeDefaults(input.sessionId);
        await this.#enqueueSelectionMutation(input.sessionId, () =>
            this.#setSessionConfigOption(input, {
                rememberRuntimePreference: true,
            }),
        );
    }

    #cancelCapturedRuntimeDefaults(sessionId: string): void {
        this.#capturedRuntimeDefaultsBySessionId.delete(sessionId);
    }

    async #enqueueSelectionMutation<T>(
        sessionId: string,
        mutation: () => Promise<T>,
    ): Promise<T> {
        const previous =
            this.#selectionMutationChains.get(sessionId) ?? Promise.resolve();
        const current = previous.catch(() => undefined).then(mutation);
        const tail = current.then(
            () => undefined,
            () => undefined,
        );
        this.#selectionMutationChains.set(sessionId, tail);

        try {
            return await current;
        } finally {
            if (this.#selectionMutationChains.get(sessionId) === tail) {
                this.#selectionMutationChains.delete(sessionId);
            }
        }
    }

    async #setSessionConfigOption(
        input: AiSessionConfigOptionMutationInput,
        options: { readonly rememberRuntimePreference: boolean },
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
            if (options.rememberRuntimePreference) {
                this.#rememberRuntimeConfigPreference(
                    snapshot,
                    input.optionId,
                    input.value,
                );
            }
            return;
        }

        await this.#runLiveSessionControlMutation(input.sessionId, () =>
            this.#requireNativeAiGateway().setSessionConfigOption(input),
        );
        const snapshot = await this.#updateSessionSnapshot(
            input.sessionId,
            (currentSnapshot) =>
                setConfigOptionOnSnapshot(
                    currentSnapshot,
                    input.optionId,
                    input.value,
                ),
        );
        if (options.rememberRuntimePreference) {
            this.#rememberRuntimeConfigPreference(
                snapshot,
                input.optionId,
                input.value,
            );
        }
    }

    async #runLiveSessionControlMutation(
        sessionId: string,
        mutation: () => Promise<void>,
    ): Promise<void> {
        try {
            await mutation();
            return;
        } catch (error) {
            if (!isNativeAiSessionNotFoundError(error)) {
                throw error;
            }

            // The runtime can evict a session after the main process cached it.
            // Recreate it once here so every renderer uses the same recovery path.
            debugBenignError("ai.service.recoverSessionControl", error);
            await this.#recoverMissingLiveSession(sessionId);
        }

        await mutation();
    }

    async #recoverMissingLiveSession(sessionId: string): Promise<void> {
        const context = this.#liveSessionContexts.get(sessionId);
        const snapshot = this.#liveSnapshots.get(sessionId);
        if (!context || !snapshot) {
            throw new Error("The AI session was not found.");
        }

        this.#cancelCapturedRuntimeDefaults(sessionId);
        const rootSnapshot = await this.#resolveNativeRootSessionSnapshot(
            snapshot,
        );
        this.#nativeSessionIds.delete(sessionId);
        this.#nativeSessionIds.delete(rootSnapshot.sessionId);
        await this.prepareSession(
            {
                projectId: snapshot.projectId,
                runtimeId: snapshot.runtimeId,
                sessionId,
                title: snapshot.title,
                worktreeId: snapshot.worktreeId ?? null,
            },
            context.ownerWindowId,
        );
    }

    #rememberRuntimeModePreference(
        snapshot: AiSessionSnapshot,
        modeId: string,
    ): void {
        if (
            snapshot.modeId !== modeId ||
            shouldSkipRuntimeSelectionPreference(snapshot)
        ) {
            return;
        }

        this.#persistence.saveRuntimeModePreference(snapshot.runtimeId, modeId);
    }

    #rememberRuntimeModelPreference(
        snapshot: AiSessionSnapshot,
        modelId: string,
    ): void {
        if (
            snapshot.modelId !== modelId ||
            shouldSkipRuntimeSelectionPreference(snapshot)
        ) {
            return;
        }

        this.#persistence.saveRuntimeModelPreference(snapshot.runtimeId, modelId);
    }

    #rememberRuntimeConfigPreference(
        snapshot: AiSessionSnapshot,
        optionId: string,
        value: boolean | string,
    ): void {
        if (shouldSkipRuntimeSelectionPreference(snapshot)) {
            return;
        }

        const option =
            snapshot.configOptions.find((candidate) => candidate.id === optionId) ??
            null;
        if (!option || option.value !== value) {
            return;
        }

        if (option.type === "select" && typeof value === "string") {
            if (isModelConfigOption(option)) {
                this.#persistence.saveRuntimeModelPreference(
                    snapshot.runtimeId,
                    value,
                );
            }
            if (isModeConfigOption(option)) {
                this.#persistence.saveRuntimeModePreference(
                    snapshot.runtimeId,
                    value,
                );
            }
        }

        this.#persistence.saveRuntimeSelectionPreferenceOption(
            snapshot.runtimeId,
            optionId,
            value,
        );
    }

    async renameSession(input: AiSessionRenameMutationInput): Promise<void> {
        if (this.#liveSessionContexts.has(input.sessionId)) {
            await this.#requireNativeAiGateway().renameSession(input);
            await this.#updateSessionSnapshot(input.sessionId, (snapshot) =>
                setManualTitleOnSnapshot(snapshot, input.title),
            );
            return;
        }

        if (this.#nativeAi?.shouldHandleHistory()) {
            await this.#nativeAi.renameSession(input);
            return;
        }

        await this.#updateSessionSnapshot(input.sessionId, (snapshot) =>
            setManualTitleOnSnapshot(snapshot, input.title),
        );
    }

    async cancelSession(sessionId: string): Promise<void> {
        this.#promptQueue.pause(sessionId);
        await this.#cancelNativeSession(sessionId);
        this.#transcriptPersistence?.requestSeal(sessionId, "cancelled");
        await this.#transcriptPersistence?.flushSession(sessionId, 750);
    }

    async #cancelNativeSession(sessionId: string): Promise<void> {
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
        this.#transcriptPersistence?.requestSeal(sessionId, "cancelled");
        if (this.#nativeChildParentSessionIds.has(sessionId)) {
            await this.#transcriptPersistence?.flushSession(sessionId, 750);
            this.#detachLiveSession(sessionId);
            return;
        }
        await this.#flushAndClearClosedSession(sessionId);
    }

    async deleteSession(sessionId: string): Promise<void> {
        this.#frozenSessionIds.delete(sessionId);
        this.#retentionCloseEventSessionIds.delete(sessionId);
        this.#forgetRetentionCloseRuntimeSessions(sessionId);
        const subtreeSessionIds = await this.#collectSessionSubtreeIds(sessionId);
        for (const subtreeSessionId of subtreeSessionIds) {
            this.#frozenSessionIds.delete(subtreeSessionId);
            this.#retentionCloseEventSessionIds.delete(subtreeSessionId);
            this.#forgetRetentionCloseRuntimeSessions(subtreeSessionId);
            this.#deletedSessionIds.add(subtreeSessionId);
        }
        try {
            for (const subtreeSessionId of [...subtreeSessionIds].reverse()) {
                if (!this.#liveSessionContexts.has(subtreeSessionId)) {
                    continue;
                }
                try {
                    await this.cancelSession(subtreeSessionId);
                } catch (error) {
                    // Deleting the persisted session tree is still safe after an interrupt failure.
                    debugBenignError("ai.service.deleteSession.cancel", error);
                }
            }

            if (
                this.#liveSessionContexts.has(sessionId) &&
                !this.#nativeChildParentSessionIds.has(sessionId)
            ) {
                await this.closeSession(sessionId);
            }

            this.#clearLiveSession(sessionId);
            for (const subtreeSessionId of subtreeSessionIds) {
                await this.#promptQueue.deleteSession(subtreeSessionId);
            }
            if (this.#nativeAi?.shouldHandleHistory()) {
                await this.#nativeAi.deleteSession(sessionId);
                return;
            }
            for (const subtreeSessionId of [...subtreeSessionIds].reverse()) {
                await this.#persistence.deleteSession(subtreeSessionId);
            }
        } catch (error) {
            for (const subtreeSessionId of subtreeSessionIds) {
                this.#deletedSessionIds.delete(subtreeSessionId);
            }
            throw error;
        }
    }

    closeOwnedByWindow(ownerWindowId: string): void {
        const sessionIds = [...this.#liveSessionContexts.entries()]
            .filter(
                ([, liveSession]) => liveSession.ownerWindowId === ownerWindowId,
            )
            .map(([sessionId]) => sessionId);

        for (const sessionId of sessionIds) {
            this.#recordRetentionClose(sessionId, "window_close");
            this.#detachLiveSession(sessionId);
        }
        void Promise.resolve(this.#nativeAi?.closeOwnedByWindow(ownerWindowId))
            .catch((error: unknown) => {
                debugBenignError("ai.service.closeOwnedByWindow.native", error);
            })
            .finally(() => {
                for (const sessionId of sessionIds) {
                    this.#transcriptPersistence?.requestSeal(
                        sessionId,
                        "cancelled",
                    );
                    void this.#flushAndClearClosedSession(sessionId);
                }
            });
    }

    async launchRuntimeAuth(input: AiRuntimeAuthLaunchInput): Promise<void> {
        const nativeAi = this.#nativeAuthGateway(input.runtimeId);
        if (nativeAi?.launchRuntimeAuth) {
            await this.#migrateNativeRuntimeSettingsIfNeeded(input.runtimeId);
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

        throw new Error(
            "Codex authentication requires the native AI runtime gateway.",
        );
    }

    async logoutRuntimeAuth(
        input: AiRuntimeAuthLogoutInput,
    ): Promise<AiRuntimeStatus> {
        const nativeAi = this.#nativeAuthGateway(input.runtimeId);
        if (nativeAi?.logoutRuntimeAuth) {
            await this.#migrateNativeRuntimeSettingsIfNeeded(input.runtimeId);
            const status = await nativeAi.logoutRuntimeAuth(input);
            this.#onRuntimeStatus(status);
            return status;
        }

        if (input.runtimeId !== "codex") {
            throw new Error(
                `${getRuntimeDisplayName(input.runtimeId)} does not support logout yet.`,
            );
        }

        throw new Error(
            "Codex logout requires the native AI runtime gateway.",
        );
    }

    async disconnectRuntimeAuth(
        input: AiRuntimeAuthDisconnectInput,
    ): Promise<AiRuntimeStatus> {
        const nativeAi = this.#nativeAuthGateway(input.runtimeId);
        if (nativeAi?.disconnectRuntimeAuth) {
            await this.#migrateNativeRuntimeSettingsIfNeeded(input.runtimeId);
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

        return this.#withPersistedRuntimeCatalog(
            await nativeAi.saveRuntimeSettings(input),
        );
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
                let settings = this.#settingsService.loadGrokRuntimeSettings();
                if (
                    settings.authInvalidatedAtMs !== null &&
                    settings.authMethod !== "xai-api-key" &&
                    isGrokExternalCredentialReady(settings)
                ) {
                    // Keep legacy and native stores aligned after the CLI renews its login.
                    settings = {
                        ...settings,
                        authInvalidatedAtMs: null,
                    };
                    this.#settingsService.saveGrokRuntimeSettings(settings);
                }
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
        return null;
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

    #scheduleTranscriptBlockMetadataLoad(sessionId: string): void {
        const nativeAi = this.#nativeAi;
        if (
            !nativeAi?.loadTranscriptBlockMetadata ||
            !nativeAi.getTranscriptCapability?.().blockNativeVersion ||
            (this.#loadedTranscriptBlockMetadataSessionIds.has(sessionId) &&
                !this.#pendingTranscriptBlockMetadataReloadSessionIds.has(
                    sessionId,
                ))
        ) {
            return;
        }
        if (this.#loadingTranscriptBlockMetadataSessionIds.has(sessionId)) {
            if (
                this.#loadingTranscriptBlockMetadataRequestSessionIds.has(
                    sessionId,
                )
            ) {
                this.#pendingTranscriptBlockMetadataReloadSessionIds.add(
                    sessionId,
                );
            }
            return;
        }
        const loadTranscriptBlockMetadata = (targetSessionId: string) =>
            nativeAi.loadTranscriptBlockMetadata!(targetSessionId);

        this.#loadingTranscriptBlockMetadataSessionIds.add(sessionId);
        void this.#recoverTranscriptTail(sessionId)
            .then(() => this.#refreshTranscriptStorageMode(sessionId))
            .then(async (isBlockNative) => {
                if (!isBlockNative) {
                    return null;
                }
                const generation =
                    this.#transcriptBlockMetadataGenerations.get(sessionId) ??
                    0;
                this.#loadingTranscriptBlockMetadataRequestSessionIds.add(
                    sessionId,
                );
                const output = await loadTranscriptBlockMetadata(sessionId)
                    .finally(() => {
                        this.#loadingTranscriptBlockMetadataRequestSessionIds.delete(
                            sessionId,
                        );
                    });
                return { generation, output };
            })
            .then((result) => {
                if (!result || this.#deletedSessionIds.has(sessionId)) {
                    return;
                }
                if (
                    result.generation !==
                    (this.#transcriptBlockMetadataGenerations.get(sessionId) ??
                        0)
                ) {
                    // A seal completed while this request was in flight. Drop
                    // the stale response and reload after the active request.
                    this.#pendingTranscriptBlockMetadataReloadSessionIds.add(
                        sessionId,
                    );
                    return;
                }
                this.#liveTranscriptTails.setStableBlocks(
                    sessionId,
                    result.output.blocks,
                );
                this.#loadedTranscriptBlockMetadataSessionIds.add(sessionId);
            })
            .catch((error: unknown) => {
                debugBenignError(
                    "ai.service.loadTranscriptBlockMetadata",
                    error,
                );
            })
            .finally(() => {
                this.#loadingTranscriptBlockMetadataSessionIds.delete(sessionId);
                if (
                    this.#pendingTranscriptBlockMetadataReloadSessionIds.delete(
                        sessionId,
                    )
                ) {
                    this.#loadedTranscriptBlockMetadataSessionIds.delete(sessionId);
                    this.#scheduleTranscriptBlockMetadataLoad(sessionId);
                }
            });
    }

    #invalidateTranscriptBlockMetadata(sessionId: string): void {
        this.#loadedTranscriptBlockMetadataSessionIds.delete(sessionId);
        this.#transcriptBlockMetadataGenerations.set(
            sessionId,
            (this.#transcriptBlockMetadataGenerations.get(sessionId) ?? 0) + 1,
        );
        if (
            this.#loadingTranscriptBlockMetadataRequestSessionIds.has(sessionId)
        ) {
            this.#pendingTranscriptBlockMetadataReloadSessionIds.add(sessionId);
        }
    }

    #createTranscriptPersistence(
        nativeAi: NativeAiGateway | null,
    ): AiTranscriptPersistenceCoordinator | null {
        if (
            !nativeAi?.checkpointOpenTranscriptTail ||
            !nativeAi.loadOpenTranscriptTail ||
            !nativeAi.reconcileTerminalOpenTranscriptTail ||
            !nativeAi.sealTranscriptTurn ||
            !nativeAi.getTranscriptCapability?.().blockNativeVersion
        ) {
            return null;
        }
        const checkpoint = nativeAi.checkpointOpenTranscriptTail.bind(nativeAi);
        const load = nativeAi.loadOpenTranscriptTail.bind(nativeAi);
        const reconcile = nativeAi.reconcileTerminalOpenTranscriptTail.bind(nativeAi);
        const seal = nativeAi.sealTranscriptTurn.bind(nativeAi);
        return new AiTranscriptPersistenceCoordinator(
            this.#liveTranscriptTails,
            { checkpoint, load, reconcile, seal },
            undefined,
            {
                onSealed: (sessionId) => {
                    if (this.#legacyTranscriptSessionIds.has(sessionId)) {
                        return;
                    }
                    this.#transcriptStorageModes.set(sessionId, "block-native");
                    this.#invalidateTranscriptBlockMetadata(sessionId);
                    this.#scheduleTranscriptBlockMetadataLoad(sessionId);
                    this.#emitSealedTranscriptSnapshot(sessionId);
                },
            },
        );
    }

    #scheduleTranscriptCheckpointAfterRecovery(
        sessionId: string,
        changedBytes = 0,
    ): void {
        void this.#recoverTranscriptTail(sessionId)
            .then(() => {
                this.#transcriptPersistence?.scheduleCheckpoint(
                    sessionId,
                    changedBytes,
                );
            })
            .catch((error: unknown) => {
                debugBenignError(
                    "ai.service.recoverTranscriptTailBeforeCheckpoint",
                    error,
                );
            });
    }

    #getTranscriptCheckpointChangedBytes(
        event: AiSessionDomainEvent,
    ): number {
        if (event.kind === "message-delta" || event.kind === "thinking-delta") {
            return Buffer.byteLength(event.delta, "utf8");
        }
        if (event.kind !== "tool-activity") {
            return 0;
        }

        const outputBytes = Buffer.byteLength(
            event.activity.terminalOutput ?? "",
            "utf8",
        );
        const outputs = this.#terminalOutputBytesBySessionId.get(
            event.sessionId,
        ) ?? new Map<string, number>();
        this.#terminalOutputBytesBySessionId.set(event.sessionId, outputs);
        const previousBytes = outputs.get(event.activity.id) ?? 0;
        outputs.set(event.activity.id, outputBytes);
        // A replacement may shrink after a retry; count its new payload too.
        return outputBytes >= previousBytes
            ? outputBytes - previousBytes
            : outputBytes;
    }

    async #recoverTranscriptTail(
        sessionId: string,
        options: { readonly sealInterruptedTail?: boolean } = {},
    ): Promise<void> {
        if (
            !this.#transcriptPersistence ||
            (!options.sealInterruptedTail &&
                this.#recoveredTranscriptTailSessionIds.has(sessionId))
        ) {
            return;
        }
        const existing = this.#transcriptRecoveryPromises.get(sessionId);
        if (existing) {
            await existing;
            if (!options.sealInterruptedTail) {
                return;
            }
        }
        const recovery = this.#transcriptPersistence
            .recover(sessionId, options)
            .then(() => {
                this.#recoveredTranscriptTailSessionIds.add(sessionId);
            })
            .finally(() => {
                this.#transcriptRecoveryPromises.delete(sessionId);
            });
        this.#transcriptRecoveryPromises.set(sessionId, recovery);
        await recovery;
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
    ): AiSessionSnapshot {
        const cachedSnapshot = normalizeLiveSnapshotReviewState(
            normalizeAiSessionHierarchy(snapshot),
        );
        this.#liveSnapshots.set(cachedSnapshot.sessionId, cachedSnapshot);
        this.#touchLiveSession(cachedSnapshot.sessionId);
        const context = this.#liveSessionContexts.get(cachedSnapshot.sessionId);
        if (context) {
            this.#liveSessionContexts.set(cachedSnapshot.sessionId, {
                ...context,
                ownerWindowId,
                parentSessionId:
                    normalizeSessionRef(cachedSnapshot.parentSessionId) ??
                    context.parentSessionId,
                projectId: cachedSnapshot.projectId,
                runtimeId: cachedSnapshot.runtimeId,
                worktreeId: cachedSnapshot.worktreeId ?? null,
            });
            return cachedSnapshot;
        }

        const parentSessionId = cachedSnapshot.parentSessionId ?? null;
        const parentContext = parentSessionId
            ? this.#liveSessionContexts.get(parentSessionId)
            : null;
        if (!parentContext) {
            return cachedSnapshot;
        }

        this.#liveSessionContexts.set(cachedSnapshot.sessionId, {
            additionalRoots: parentContext.additionalRoots,
            ownerWindowId,
            parentSessionId,
            projectId: cachedSnapshot.projectId,
            runtimeId: cachedSnapshot.runtimeId,
            sessionId: cachedSnapshot.sessionId,
            worktreeId: cachedSnapshot.worktreeId ?? null,
        });
        this.#touchLiveSession(cachedSnapshot.sessionId);
        return cachedSnapshot;
    }

    #clearLiveSession(sessionId: string): void {
        const pendingSessionIds = [sessionId];
        const sessionIdsToClear: string[] = [];
        const visitedSessionIds = new Set<string>();
        while (pendingSessionIds.length > 0) {
            const currentSessionId = pendingSessionIds.shift();
            if (!currentSessionId || visitedSessionIds.has(currentSessionId)) {
                continue;
            }
            visitedSessionIds.add(currentSessionId);
            sessionIdsToClear.push(currentSessionId);
            for (const [childSessionId, parentSessionId] of this
                .#nativeChildParentSessionIds) {
                if (parentSessionId === currentSessionId) {
                    pendingSessionIds.push(childSessionId);
                }
            }
        }
        for (const currentSessionId of sessionIdsToClear) {
            this.#activeCustomRuntimeLaunches.delete(currentSessionId);
            this.#nativeChildParentSessionIds.delete(currentSessionId);
            this.#liveSnapshots.delete(currentSessionId);
            this.#liveTranscriptTails.clearSession(currentSessionId);
            this.#transcriptPersistence?.clearSession(currentSessionId);
            this.#recoveredTranscriptTailSessionIds.delete(currentSessionId);
            this.#transcriptRecoveryPromises.delete(currentSessionId);
            const migrationTimer = this.#transcriptMigrationTimers.get(
                currentSessionId,
            );
            if (migrationTimer) {
                clearTimeout(migrationTimer);
                this.#transcriptMigrationTimers.delete(currentSessionId);
            }
            this.#loadedTranscriptBlockMetadataSessionIds.delete(
                currentSessionId,
            );
            this.#loadingTranscriptBlockMetadataSessionIds.delete(
                currentSessionId,
            );
            this.#loadingTranscriptBlockMetadataRequestSessionIds.delete(
                currentSessionId,
            );
            this.#pendingTranscriptBlockMetadataReloadSessionIds.delete(
                currentSessionId,
            );
            this.#transcriptBlockMetadataGenerations.delete(currentSessionId);
            this.#liveSessionContexts.delete(currentSessionId);
            this.#liveSessionTouches.delete(currentSessionId);
            this.#freezingSessionIds.delete(currentSessionId);
            this.#nativeReviewBaselines.delete(currentSessionId);
            this.#recentNativeReviewContexts.delete(currentSessionId);
            this.#resolvedReviewVersions.delete(currentSessionId);
            this.#reviewMutationChains.delete(currentSessionId);
            this.#nativeSessionIds.delete(currentSessionId);
        }
        this.#scheduleSessionRetentionTimer();
    }

    async #flushAndClearClosedSession(sessionId: string): Promise<void> {
        const persistence = this.#transcriptPersistence;
        const completed = await (persistence?.flushSession(sessionId, 750) ??
            Promise.resolve(true));
        if (completed) {
            this.#clearLiveSession(sessionId);
            return;
        }

        // Closing the runtime must stay responsive, but the durable queue owns
        // the tail until its retries finish successfully.
        this.#detachLiveSession(sessionId);
        if (!persistence) {
            return;
        }
        await persistence.waitForIdle(sessionId);
        // The session may have been reopened while its old tail was flushing.
        if (
            !this.#liveSessionContexts.has(sessionId) &&
            !this.#deletedSessionIds.has(sessionId)
        ) {
            this.#clearLiveSession(sessionId);
        }
    }

    #detachLiveSession(sessionId: string): void {
        this.#activeCustomRuntimeLaunches.delete(sessionId);
        this.#liveSnapshots.delete(sessionId);
        this.#terminalOutputBytesBySessionId.delete(sessionId);
        this.#liveSessionContexts.delete(sessionId);
        this.#liveSessionTouches.delete(sessionId);
        this.#freezingSessionIds.delete(sessionId);
        this.#nativeReviewBaselines.delete(sessionId);
        this.#recentNativeReviewContexts.delete(sessionId);
        this.#resolvedReviewVersions.delete(sessionId);
        this.#reviewMutationChains.delete(sessionId);
        // Keep the child-to-parent mapping so future runtime events retain their owner.
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
            await this.#freezeSessionForRetention(candidate);
        }
    }

    #selectRetentionCandidates(): readonly AiSessionRetentionCandidate[] {
        const candidates = new Map<string, AiSessionRetentionCandidate>();
        const now = Date.now();
        if (this.#retentionConfig.idleTtlMs >= 0) {
            for (const [sessionId, touch] of this.#liveSessionTouches) {
                if (now - touch.lastUsedAtMs >= this.#retentionConfig.idleTtlMs) {
                    candidates.set(sessionId, {
                        reason: "ttl",
                        sessionId,
                        touch,
                    });
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
                const session = ordered[index];
                const touch = this.#liveSessionTouches.get(session.sessionId);
                if (!candidates.has(session.sessionId) && touch) {
                    candidates.set(session.sessionId, {
                        reason: "budget",
                        sessionId: session.sessionId,
                        touch,
                    });
                }
            }
        }

        return [...candidates.values()];
    }

    async #freezeSessionForRetention(
        candidate: AiSessionRetentionCandidate,
    ): Promise<void> {
        const { reason, sessionId, touch: selectedTouch } = candidate;
        if (
            this.#freezingSessionIds.has(sessionId) ||
            !this.#liveSessionContexts.has(sessionId)
        ) {
            return;
        }

        const currentTouch = this.#liveSessionTouches.get(sessionId);
        if (
            !currentTouch ||
            currentTouch.lastUsedAtMs !== selectedTouch.lastUsedAtMs ||
            currentTouch.order !== selectedTouch.order
        ) {
            return;
        }

        const snapshot = this.#liveSnapshots.get(sessionId) ?? null;
        const retentionRuntimeSessionId = snapshot?.runtimeSessionId ?? null;
        const localSkippedReason = snapshot
            ? getRetentionSkippedReasonFromSnapshot(snapshot)
            : null;
        if (localSkippedReason) {
            this.#recordRetentionSkipped(sessionId, reason, localSkippedReason);
            return;
        }

        let resolveFreeze: () => void = () => undefined;
        const freezeComplete = new Promise<void>((resolve) => {
            resolveFreeze = resolve;
        });
        this.#freezingSessionIds.add(sessionId);
        this.#frozenSessionIds.add(sessionId);
        if (retentionRuntimeSessionId) {
            this.#rememberRetentionCloseRuntimeSession(
                sessionId,
                retentionRuntimeSessionId,
            );
        }
        this.#retentionFreezePromises.set(sessionId, freezeComplete);
        try {
            await this.closeSession(sessionId);
            this.#recordRetentionClose(sessionId, reason);
        } catch (error) {
            this.#frozenSessionIds.delete(sessionId);
            if (retentionRuntimeSessionId) {
                this.#forgetRetentionCloseRuntimeSession(
                    sessionId,
                    retentionRuntimeSessionId,
                );
            }
            this.#deferSessionRetentionRetry(sessionId);
            debugBenignError("ai.service.freezeNativeSession", error);
        } finally {
            this.#freezingSessionIds.delete(sessionId);
            if (this.#retentionCloseEventSessionIds.delete(sessionId)) {
                this.#frozenSessionIds.delete(sessionId);
            }
            if (this.#retentionFreezePromises.get(sessionId) === freezeComplete) {
                this.#retentionFreezePromises.delete(sessionId);
            }
            resolveFreeze();
        }
    }

    async #waitForRetentionFreeze(sessionId: string): Promise<void> {
        await this.#retentionFreezePromises.get(sessionId);
    }

    #consumeRetentionCloseEvent(event: AiSessionDomainEvent): boolean {
        if (event.kind !== "session-closed") {
            return false;
        }

        const expectedRuntimeSessionIds =
            this.#retentionCloseRuntimeSessionIds.get(event.sessionId) ?? null;
        const matchesRetainedRuntime =
            expectedRuntimeSessionIds !== null &&
            event.runtimeSessionId !== null &&
            expectedRuntimeSessionIds.has(event.runtimeSessionId);
        const closingWithoutRuntimeIdentity =
            event.runtimeSessionId === null &&
            (this.#freezingSessionIds.has(event.sessionId) ||
                this.#frozenSessionIds.has(event.sessionId));
        if (!matchesRetainedRuntime && !closingWithoutRuntimeIdentity) {
            return false;
        }

        if (matchesRetainedRuntime) {
            this.#forgetRetentionCloseRuntimeSession(
                event.sessionId,
                event.runtimeSessionId,
            );
        } else if (closingWithoutRuntimeIdentity) {
            this.#forgetRetentionCloseRuntimeSessions(event.sessionId);
        }
        if (this.#freezingSessionIds.has(event.sessionId)) {
            this.#retentionCloseEventSessionIds.add(event.sessionId);
        } else {
            this.#frozenSessionIds.delete(event.sessionId);
        }
        return true;
    }

    #rememberRetentionCloseRuntimeSession(
        sessionId: string,
        runtimeSessionId: string,
    ): void {
        const runtimeSessionIds =
            this.#retentionCloseRuntimeSessionIds.get(sessionId) ??
            new Set<string>();
        runtimeSessionIds.add(runtimeSessionId);
        this.#retentionCloseRuntimeSessionIds.set(sessionId, runtimeSessionIds);

        const previousTimer =
            this.#retentionCloseRuntimeSessionTimers.get(sessionId);
        if (previousTimer) {
            clearTimeout(previousTimer);
        }
        const timer = setTimeout(() => {
            this.#retentionCloseRuntimeSessionTimers.delete(sessionId);
            this.#retentionCloseRuntimeSessionIds.delete(sessionId);
        }, RETENTION_CLOSE_EVENT_GRACE_MS);
        unrefTimer(timer);
        this.#retentionCloseRuntimeSessionTimers.set(sessionId, timer);
    }

    #forgetRetentionCloseRuntimeSessions(sessionId: string): void {
        this.#retentionCloseRuntimeSessionIds.delete(sessionId);
        const timer = this.#retentionCloseRuntimeSessionTimers.get(sessionId);
        if (timer) {
            clearTimeout(timer);
            this.#retentionCloseRuntimeSessionTimers.delete(sessionId);
        }
    }

    #forgetRetentionCloseRuntimeSession(
        sessionId: string,
        runtimeSessionId: string,
    ): void {
        const runtimeSessionIds =
            this.#retentionCloseRuntimeSessionIds.get(sessionId);
        if (!runtimeSessionIds) {
            return;
        }

        runtimeSessionIds.delete(runtimeSessionId);
        if (runtimeSessionIds.size === 0) {
            this.#forgetRetentionCloseRuntimeSessions(sessionId);
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
        this.#liveTranscriptTails.synchronizeSnapshot(nextSnapshot);
        // A prepared session may already contain streamed output before events
        // resume, so do not wait for a later event to make it crash-safe.
        this.#scheduleTranscriptCheckpointAfterRecovery(nextSnapshot.sessionId);
        const cachedSnapshot = this.#cacheLiveSessionSnapshot(
            preserveCanonicalTranscriptArrays(
                previousSnapshot,
                nextSnapshot,
            ),
            ownerWindowId,
        );
        this.#scheduleTranscriptBlockMetadataLoad(cachedSnapshot.sessionId);
        if (!this.#isNativeAiSession(cachedSnapshot.sessionId)) {
            this.#persistence.saveSessionSnapshot(cachedSnapshot);
        }
        this.#promptQueue.handleSessionSnapshot(cachedSnapshot);
        this.#frozenSessionIds.delete(cachedSnapshot.sessionId);
        return cachedSnapshot;
    }

    async #applyCapturedRuntimeDefaults(
        sessionId: string,
        ownerWindowId: string,
    ): Promise<AiSessionSnapshot | null> {
        void ownerWindowId;
        let snapshot = this.#liveSnapshots.get(sessionId) ?? null;
        if (!snapshot || this.#deletedSessionIds.has(sessionId)) {
            return snapshot;
        }

        const capturedDefaults =
            this.#capturedRuntimeDefaultsBySessionId.get(sessionId) ??
            EMPTY_CAPTURED_RUNTIME_DEFAULTS;
        const canApplyCapturedDefaults =
            this.#capturedRuntimeDefaultsBySessionId.has(sessionId);
        const modelConfig = getModelConfigOption(snapshot.configOptions);
        const capturedModelId = capturedDefaults.modelId;
        if (
            !modelConfig &&
            this.#hasCapturedRuntimeDefaults(sessionId, capturedDefaults) &&
            capturedModelId &&
            capturedModelId !== snapshot.modelId &&
            snapshot.models.some((model) => model.id === capturedModelId)
        ) {
            await this.#enqueueSelectionMutation(sessionId, async () => {
                if (!this.#hasCapturedRuntimeDefaults(sessionId, capturedDefaults)) {
                    return;
                }
                await this.#setSessionModel(
                    {
                        modelId: capturedModelId,
                        sessionId,
                    },
                    { rememberRuntimePreference: false },
                );
            });
            snapshot = this.#liveSnapshots.get(sessionId) ?? snapshot;
        }

        const modeConfig = getModeConfigOption(snapshot.configOptions);
        const capturedModeId = capturedDefaults.modeId;
        if (
            !modeConfig &&
            this.#hasCapturedRuntimeDefaults(sessionId, capturedDefaults) &&
            capturedModeId &&
            capturedModeId !== snapshot.modeId &&
            snapshot.modes.some((mode) => mode.id === capturedModeId)
        ) {
            await this.#enqueueSelectionMutation(sessionId, async () => {
                if (!this.#hasCapturedRuntimeDefaults(sessionId, capturedDefaults)) {
                    return;
                }
                await this.#setSessionMode(
                    {
                        modeId: capturedModeId,
                        sessionId,
                    },
                    { rememberRuntimePreference: false },
                );
            });
            snapshot = this.#liveSnapshots.get(sessionId) ?? snapshot;
        }

        const mutations = getCapturedRuntimeDefaultMutations(
            snapshot,
            capturedDefaults,
            {
                applyCapturedDefaults: canApplyCapturedDefaults,
            },
        );
        for (const mutation of mutations) {
            if (!this.#hasCapturedRuntimeDefaults(sessionId, capturedDefaults)) {
                break;
            }
            await this.#enqueueSelectionMutation(sessionId, async () => {
                if (!this.#hasCapturedRuntimeDefaults(sessionId, capturedDefaults)) {
                    return;
                }
                await this.#setSessionConfigOption(
                    {
                        optionId: mutation.optionId,
                        sessionId,
                        value: mutation.value,
                    },
                    { rememberRuntimePreference: false },
                );
            });
            snapshot = this.#liveSnapshots.get(sessionId) ?? snapshot;
        }

        if (
            this.#hasCapturedRuntimeDefaults(sessionId, capturedDefaults) &&
            snapshotHasEffectiveSelections(snapshot)
        ) {
            this.#capturedRuntimeDefaultsBySessionId.delete(sessionId);
        }

        return snapshot;
    }

    #hasCapturedRuntimeDefaults(
        sessionId: string,
        capturedDefaults: CapturedRuntimeDefaults,
    ): boolean {
        return (
            this.#capturedRuntimeDefaultsBySessionId.get(sessionId) ===
            capturedDefaults
        );
    }

    #scheduleCapturedRuntimeDefaultsApplication(
        ownerWindowId: string,
        sessionId: string,
    ): void {
        void this.#applyCapturedRuntimeDefaults(
            sessionId,
            ownerWindowId,
        ).catch((error: unknown) => {
            debugBenignError("ai.service.capturedRuntimeDefaults", error);
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
        const cachedSnapshot = this.#cacheLiveSessionSnapshot(
            nextSnapshot,
            ownerWindowId,
        );
        this.#persistNativeCatalogPatch(cachedSnapshot, patch);

        if (options.emitUpdate) {
            this.#onSessionSnapshot(
                ownerWindowId,
                this.#buildRendererSessionUpdate(previousSnapshot, cachedSnapshot),
            );
        }

        return cachedSnapshot;
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
            const titledSnapshot = setRuntimeTitleOnSnapshot(
                snapshot,
                event.title,
                event.updatedAt,
            );
            return {
                ...base,
                projectId: event.projectId,
                manualTitle: titledSnapshot.manualTitle ?? null,
                title: titledSnapshot.title,
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

        if (event.kind === "session-closed") {
            return {
                ...base,
                activeTurnStartedAt: null,
                closedAt: event.closedAt,
                lastError: null,
                pendingPermission: null,
                pendingUserInput: null,
                status: "idle",
            };
        }

        if (
            event.kind === "message-started" ||
            event.kind === "message-delta" ||
            event.kind === "message-completed" ||
            event.kind === "thinking-started" ||
            event.kind === "thinking-delta" ||
            event.kind === "thinking-completed" ||
            event.kind === "image-generation"
        ) {
            return base;
        }

        if (event.kind === "subagent-created") {
            const baseChildSnapshot: AiSessionSnapshot = {
                ...base,
                parentSessionId: event.parentSessionId,
                runtimeSessionId:
                    event.childRuntimeSessionId ?? event.runtimeSessionId,
                title: event.title,
            };
            const withModel = event.modelId
                ? setModelOnSnapshot(
                      baseChildSnapshot,
                      event.modelId,
                      event.updatedAt,
                  )
                : baseChildSnapshot;
            return event.reasoningEffort
                ? setReasoningEffortOnSnapshot(
                      withModel,
                      event.reasoningEffort,
                      event.updatedAt,
                  )
                : withModel;
        }

        if (event.kind === "tool-activity") {
            // Keep a local review bridge only until the native delta arrives. This makes a
            // terminal edit visible even if the sidecar cannot materialize it.
            return this.#applyNativeToolActivityReviewFallback(
                base,
                event.activity,
                event.origin,
            );
        }

        if (event.kind === "review") {
            // Review state is owned by the TS action log. Native review events
            // are ignored so a stale sidecar cannot overwrite local decisions.
            return base;
        }

        if (event.kind === "review-delta") {
            return this.#applyNativeReviewDelta(base, event.delta);
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

        if (event.kind === "turn-status") {
            // Turn completion controls the main-owned prompt queue. It does
            // not independently mutate the transcript snapshot.
            return base;
        }

        // Transcript events are owned by the live tail and renderer transcript.
        return base;
    }

    async #captureNativeReviewBaseline(
        sessionId: string,
        ownerWindowId: string,
        launch: AiSessionLaunchInput,
        messageId: string,
    ): Promise<boolean> {
        const nativeAi = this.#requireNativeReviewGateway("captureReviewBaseline");
        await nativeAi.captureReviewBaseline(sessionId);
        const workCycleId = createReviewWorkCycleId(sessionId, messageId);
        const updatedAt = new Date().toISOString();
        this.#beginNativeReviewWorkCycle(
            sessionId,
            ownerWindowId,
            workCycleId,
            updatedAt,
        );
        this.#recentNativeReviewContexts.delete(sessionId);
        this.#nativeReviewBaselines.set(sessionId, {
            additionalRoots: launch.additionalRoots,
            cwd: launch.cwd,
            inherited: false,
            messageId,
            promptAccepted: false,
            terminalStatusSeen: false,
            turnStarted: false,
            workCycleId,
        });
        return true;
    }

    async #prepareNativeReviewBaselineForPrompt(
        sessionId: string,
        ownerWindowId: string,
        launch: AiSessionLaunchInput,
        messageId: string,
    ): Promise<boolean> {
        const baseline = this.#nativeReviewBaselines.get(sessionId);
        if (!baseline) {
            return false;
        }

        if (baseline.messageId === messageId && !baseline.inherited) {
            return false;
        }

        if (baseline.inherited) {
            return await this.#captureNativeReviewBaseline(
                sessionId,
                ownerWindowId,
                launch,
                messageId,
            );
        }

        if (baseline.promptAccepted || baseline.terminalStatusSeen) {
            this.#finishNativeReviewBaseline(sessionId);
            return false;
        }

        if (!baseline.turnStarted) {
            return await this.#captureNativeReviewBaseline(
                sessionId,
                ownerWindowId,
                launch,
                messageId,
            );
        }

        return false;
    }

    #finishNativeReviewBaseline(sessionId: string): void {
        const baseline = this.#nativeReviewBaselines.get(sessionId);
        if (!baseline) {
            return;
        }
        if (this.#liveSessionContexts.has(sessionId)) {
            this.#rememberRecentNativeReviewContext(sessionId, baseline);
        }
        this.#nativeReviewBaselines.delete(sessionId);
    }

    #beginNativeReviewWorkCycle(
        sessionId: string,
        ownerWindowId: string,
        workCycleId: string,
        updatedAt: string,
    ): void {
        const snapshot = this.#liveSnapshots.get(sessionId);
        if (!snapshot) {
            return;
        }

        if (this.#isNativeAiSession(sessionId)) {
            // The backend owns native review versions; never seed a TS action log.
            return;
        }

        const reviewActionLog =
            validReviewActionLogForSnapshot(snapshot) ??
            createReviewActionLogFromTrackedFiles(
                snapshot.sessionId,
                snapshot.trackedFiles,
                {
                    updatedAt: snapshot.updatedAt,
                },
            );
        const nextActionLog = beginReviewWorkCycle(reviewActionLog, workCycleId, {
            updatedAt,
        });
        if (nextActionLog === reviewActionLog) {
            return;
        }

        const nextSnapshot = this.#cacheLiveSessionSnapshot(
            snapshotWithReviewActionLog(snapshot, nextActionLog),
            ownerWindowId,
        );
        this.#onSessionSnapshot(
            ownerWindowId,
            this.#buildRendererSessionUpdate(snapshot, nextSnapshot),
        );
    }

    #inheritNativeReviewContext(
        parentSessionId: string,
        childSessionId: string,
    ): void {
        if (!this.#nativeReviewBaselines.has(childSessionId)) {
            const parentBaseline =
                this.#nativeReviewBaselines.get(parentSessionId);
            if (parentBaseline) {
                this.#nativeReviewBaselines.set(childSessionId, {
                    ...parentBaseline,
                    inherited: true,
                });
            }
        }

        if (!this.#recentNativeReviewContexts.has(childSessionId)) {
            const parentRecentContext =
                this.#recentNativeReviewContexts.get(parentSessionId);
            if (
                parentRecentContext &&
                parentRecentContext.expiresAtMs > Date.now()
            ) {
                this.#recentNativeReviewContexts.set(childSessionId, {
                    ...parentRecentContext,
                });
            }
        }
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

    #rememberRecentNativeReviewContext(
        sessionId: string,
        baseline: NativeReviewBaseline,
    ): void {
        this.#recentNativeReviewContexts.set(sessionId, {
            additionalRoots: baseline.additionalRoots,
            cwd: baseline.cwd,
            expiresAtMs: Date.now() + RECENT_NATIVE_REVIEW_CONTEXT_TTL_MS,
            workCycleId: baseline.workCycleId,
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

    #applyNativeToolActivityReviewFallback(
        snapshot: AiSessionSnapshot,
        activity: AiToolActivity,
        origin: AiSessionEventOrigin,
    ): AiSessionSnapshot {
        const reviewContext = this.#nativeReviewDiffContext(snapshot.sessionId);
        if (
            origin !== "live" ||
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
                { cwd: reviewContext.cwd, projectRoot },
                candidatePath,
            );
            const resolvedPath = resolveSessionScopedPath(
                scopeRoot,
                normalizedPath,
            );
            if (resolvedPath.insideRoot && resolvedPath.relativePath) {
                return normalizedPath;
            }
            return reviewContext.additionalRoots.some((rootPath) =>
                isPathInsideRoot(resolvedPath.absolutePath, rootPath),
            )
                ? resolvedPath.absolutePath
                : null;
        };
        let reviewActionLog = snapshot.reviewActionLog ?? null;
        let trackedFiles = snapshot.trackedFiles;
        const rawOutput = parseToolActivityJson(activity.rawOutputJson);
        for (const diff of activity.diffs) {
            const normalizedDiff = normalizeAiFileDiffPaths(diff, normalizeDiffPath);
            if (!normalizedDiff) {
                continue;
            }
            const existingTrackedFile = findTrackedFileForReviewPath(
                trackedFiles,
                normalizedDiff.path,
            );
            const fullTextDiff: AiFileDiff =
                normalizedDiff.newText === null
                    ? normalizedDiff
                    : {
                          ...normalizedDiff,
                          ...resolveDiffToFullTexts(
                              {
                                  hunks: normalizedDiff.hunks,
                                  newText: normalizedDiff.newText,
                                  oldText: normalizedDiff.oldText,
                                  path: normalizedDiff.path,
                              },
                              existingTrackedFile ?? undefined,
                              { cwd: reviewContext.cwd, projectRoot },
                              normalizedDiff.path,
                              {
                                  meta: null,
                                  rawOutput,
                                  sessionUpdate: "tool_call_update",
                                  toolCallId: activity.id,
                              },
                          ),
                      };
            const baseReviewActionLog =
                reviewActionLog ??
                createReviewActionLogFromTrackedFiles(
                    snapshot.sessionId,
                    trackedFiles,
                    { updatedAt: snapshot.updatedAt },
                );
            const nextReviewActionLog = consolidateReviewDiffs(
                baseReviewActionLog,
                [fullTextDiff],
                {
                    origin,
                    sessionId: snapshot.sessionId,
                    toolCallId: activity.id,
                    updatedAt: activity.updatedAt,
                    workCycleId: reviewContext.workCycleId,
                },
            );
            if (nextReviewActionLog === baseReviewActionLog) {
                continue;
            }
            reviewActionLog = nextReviewActionLog;
            trackedFiles = deriveTrackedFilesFromActionLog(reviewActionLog);
        }
        return reviewActionLog === snapshot.reviewActionLog
            ? snapshot
            : { ...snapshot, reviewActionLog, trackedFiles };
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

    async loadReviewDelta(
        sessionId: string,
        reviewDeltaId: string,
        expectedRevision: number,
    ): Promise<AiReviewDeltaDetails | null> {
        const snapshot =
            this.#liveSnapshots.get(sessionId) ??
            (await this.#persistence.loadSessionSnapshot(sessionId));
        const delta = snapshot?.reviewDeltas?.find(
            (candidate) => candidate.deltaId === reviewDeltaId,
        );
        if (!delta || delta.revision !== expectedRevision) {
            return null;
        }
        const cached = this.#nativeReviewDeltaDetails.get(reviewDeltaId);
        if (cached?.delta.revision === expectedRevision) {
            return {
                delta,
                trackedFiles: filterNativeReviewDeltaTrackedFiles(
                    cached.trackedFiles,
                    delta,
                ),
            };
        }
        const nativeAi = this.#requireNativeReviewGateway("loadReviewDelta");
        const output = await nativeAi.loadReviewDelta(
            toNativeReviewDeltaReference(delta),
        );
        if (
            output.delta.deltaId !== reviewDeltaId ||
            output.delta.revision !== expectedRevision
        ) {
            return null;
        }
        const details: AiReviewDeltaDetails = {
            delta,
            trackedFiles: filterNativeReviewDeltaTrackedFiles(
                output.trackedFiles.map(nativeReviewTrackedFileToIpc),
                delta,
            ),
        };
        this.#nativeReviewDeltaDetails.set(reviewDeltaId, details);
        return details;
    }

    releaseReviewDelta(reviewDeltaId: string): void {
        this.#nativeReviewDeltaDetails.delete(reviewDeltaId);
    }

    async loadToolActivityDetail(
        input: AiLoadToolActivityDetailInput,
    ): Promise<AiToolActivityDetail | null> {
        const nativeAi = this.#nativeAi;
        if (!nativeAi?.loadToolActivityDetail) {
            return null;
        }
        const detail = await nativeAi.loadToolActivityDetail(input);
        return detail === null || detail === undefined
            ? null
            : nativeAiToolActivityDetailToIpc(detail);
}
    #applyNativeReviewDelta(
        snapshot: AiSessionSnapshot,
        delta: AiReviewDeltaSummary,
    ): AiSessionSnapshot {
        return applyNativeReviewDeltaSnapshot(
            snapshot,
            delta,
            this.#resolvedReviewVersions.get(snapshot.sessionId),
        );
    }

    #preservePassiveNativeSnapshotTrackedFiles(
        incomingSnapshot: AiSessionSnapshot,
        previousSnapshot: AiSessionSnapshot | null,
    ): AiSessionSnapshot {
        const snapshot =
            previousSnapshot?.manualTitle?.trim()
                ? {
                      ...incomingSnapshot,
                      manualTitle: previousSnapshot.manualTitle,
                  }
                : incomingSnapshot;
        const previousReviewActionLog = previousSnapshot
            ? validReviewActionLogForSnapshot(previousSnapshot)
            : null;
        if (previousReviewActionLog) {
            // The TS action log is canonical; passive native snapshots cannot
            // overwrite pending, accepted, rejected, or conflict state.
            return {
                ...snapshot,
                reviewActionLog: previousReviewActionLog,
                trackedFiles: deriveTrackedFilesFromActionLog(
                    previousReviewActionLog,
                ),
            };
        }

        return normalizeLiveSnapshotReviewState(
            preservePassiveNativeReviewState(snapshot, previousSnapshot),
        );
    }

    #shouldFinishNativeReviewBaseline(event: AiSessionDomainEvent): boolean {
        const baseline = this.#nativeReviewBaselines.get(event.sessionId);
        if (!baseline || !this.#isNativeAiSession(event.sessionId)) {
            return false;
        }

        return (
            event.kind === "status" &&
            (baseline.turnStarted || baseline.promptAccepted) &&
            (event.status === "idle" || event.status === "error")
        );
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

        const patchChanges = update.patch.changes;
        const resolvedSnapshot = {
            ...previousSnapshot,
            ...patchChanges,
            runtimeId: update.patch.runtimeId,
            sessionId: update.patch.sessionId,
        };
        const hasLegacyTrackedFilePatch =
            isNativeTrackedFilesPatch(update) &&
            !Object.prototype.hasOwnProperty.call(
                patchChanges,
                "reviewActionLog",
            );

        return hasLegacyTrackedFilePatch
            ? {
                  ...resolvedSnapshot,
                  reviewActionLog: null,
              }
            : resolvedSnapshot;
    }

    async #loadPersistedSessionSnapshot(
        sessionId: string,
    ): Promise<AiSessionSnapshot | null> {
        if (this.#nativeAi?.shouldHandleHistory()) {
            const [nativeSnapshot, persistedSnapshot] = await Promise.all([
                this.#nativeAi.loadSessionSnapshot(sessionId),
                this.#persistence.loadSessionSnapshot(sessionId),
            ]);
            if (!nativeSnapshot) {
                return persistedSnapshot
                    ? clearRestoredSnapshotReviewState(
                          normalizeRestoredAiSessionSnapshot(persistedSnapshot),
                      )
                    : null;
            }

            return clearRestoredSnapshotReviewState(
                mergePersistedNativeReviewState(
                    normalizeRestoredAiSessionSnapshot(nativeSnapshot),
                    persistedSnapshot
                        ? normalizeRestoredAiSessionSnapshot(persistedSnapshot)
                        : null,
                ),
            );
        }

        const snapshot = await this.#persistence.loadSessionSnapshot(sessionId);

        return snapshot
            ? clearRestoredSnapshotReviewState(
                  normalizeRestoredAiSessionSnapshot(snapshot),
              )
            : null;
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

    async #collectSessionSubtreeIds(sessionId: string): Promise<readonly string[]> {
        const sessionIds = new Set<string>([sessionId]);
        const pendingSessionIds = [sessionId];
        while (pendingSessionIds.length > 0) {
            const currentSessionId = pendingSessionIds.shift();
            if (!currentSessionId) {
                continue;
            }
            for (const [childSessionId, parentSessionId] of this
                .#nativeChildParentSessionIds) {
                if (
                    parentSessionId === currentSessionId &&
                    !sessionIds.has(childSessionId)
                ) {
                    sessionIds.add(childSessionId);
                    pendingSessionIds.push(childSessionId);
                }
            }
        }

        for (const mapping of await this.#listPersistedRuntimeMappingsForParent(
            sessionId,
        )) {
            sessionIds.add(mapping.appSessionId);
        }

        return [...sessionIds];
    }

    async #buildNativePrepareLaunchForSession(
        input: SessionDescriptor,
        ownerWindowId: string,
        launch: AiSessionLaunchInput,
    ): Promise<{
        readonly input: SessionDescriptor;
        readonly launch: AiSessionLaunchInput;
    }> {
        const rootSnapshot = await this.#resolveNativeRootSessionSnapshot(
            launch.persistedSnapshot,
        );
        if (rootSnapshot.sessionId === launch.persistedSnapshot.sessionId) {
            return {
                input: {
                    ...input,
                    title: launch.persistedSnapshot.title,
                },
                launch,
            };
        }

        const rootInput: SessionDescriptor = {
            additionalRoots: input.additionalRoots,
            projectId: rootSnapshot.projectId,
            runtimeId: rootSnapshot.runtimeId,
            sessionId: rootSnapshot.sessionId,
            title: rootSnapshot.title,
            worktreeId: rootSnapshot.worktreeId ?? null,
        };

        return {
            input: rootInput,
            launch: await this.#buildNativeSessionLaunchInput(
                rootInput,
                ownerWindowId,
                rootSnapshot,
            ),
        };
    }

    async #resolveNativeRootSessionSnapshot(
        snapshot: AiSessionSnapshot,
    ): Promise<AiSessionSnapshot> {
        let rootSnapshot = snapshot;
        const visitedSessionIds = new Set([snapshot.sessionId]);
        while (rootSnapshot.parentSessionId) {
            const parentSessionId = rootSnapshot.parentSessionId;
            if (visitedSessionIds.has(parentSessionId)) {
                throw new Error(
                    "The subagent hierarchy contains a parent cycle.",
                );
            }
            visitedSessionIds.add(parentSessionId);
            const parentSnapshot =
                this.#liveSnapshots.get(parentSessionId) ??
                (await this.#loadPersistedSessionSnapshot(parentSessionId));
            if (!parentSnapshot) {
                throw new Error(
                    "An ancestor session could not be loaded for this subagent.",
                );
            }
            rootSnapshot = parentSnapshot;
        }
        return rootSnapshot;
    }

    #adoptNativeSubagentSnapshot(
        snapshot: AiSessionSnapshot,
        ownerWindowId: string,
    ): void {
        const parentSessionId = snapshot.parentSessionId ?? null;
        if (!parentSessionId) {
            return;
        }

        const cachedSnapshot = this.#cacheLiveSessionSnapshot(
            snapshot,
            ownerWindowId,
        );
        this.#nativeSessionIds.add(snapshot.sessionId);
        this.#nativeChildParentSessionIds.set(snapshot.sessionId, parentSessionId);
        this.#onSessionSnapshot(ownerWindowId, {
            kind: "snapshot",
            snapshot: cachedSnapshot,
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
        const liveSnapshot = this.#liveSnapshots.get(input.sessionId) ?? null;
        const storedSnapshot =
            !snapshotOverride && !liveSnapshot
                ? await this.#loadPersistedSessionSnapshot(input.sessionId)
                : null;
        const sourceSnapshot =
            snapshotOverride ??
            liveSnapshot ??
            storedSnapshot ??
            createEmptyAiSessionSnapshot({
                projectId: input.projectId,
                runtimeId: input.runtimeId,
                sessionId: input.sessionId,
                title: input.title,
                worktreeId: input.worktreeId ?? null,
            });
        const activeCustomRuntime =
            liveSnapshot && isCustomAcpRuntimeId(input.runtimeId)
                ? this.#activeCustomRuntimeLaunches.get(input.sessionId)
                : undefined;
        const resolvedRuntimeBase =
            activeCustomRuntime ??
            this.#resolveRuntimeCommand(input.runtimeId);
        const resolvedRuntime = {
            ...resolvedRuntimeBase,
            status: await this.#resolveLaunchRuntimeStatus(
                input.runtimeId,
                resolvedRuntimeBase.status,
            ),
        } satisfies ResolvedAcpRuntime;
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

        const customLaunch = resolvedRuntime.customAcpLaunch;
        if (
            customLaunch &&
            !liveSnapshot &&
            sourceSnapshot.runtimeLaunchFingerprint &&
            sourceSnapshot.runtimeLaunchFingerprint !==
                customLaunch.launchFingerprint &&
            !input.confirmCustomRuntimeChange
        ) {
            throw new Error(
                createCustomRuntimeChangeConfirmationErrorMessage(
                    `The ${sourceSnapshot.runtimeDisplayName ?? "custom ACP runtime"} definition changed since this session was created. Continue with the modified configuration?`,
                ),
            );
        }
        if (
            customLaunch &&
            !liveSnapshot &&
            sourceSnapshot.runtimeSessionId &&
            sourceSnapshot.customAcpContinuationStrategy ===
                "new-session-only"
        ) {
            throw new Error(
                `${sourceSnapshot.runtimeDisplayName ?? customLaunch.displayName} does not support continuing this runtime session. The transcript is still available; start a new session to keep working.`,
            );
        }
        const identitySnapshot =
            customLaunch && !snapshotOverride && !liveSnapshot && !storedSnapshot
                ? {
                      ...sourceSnapshot,
                      runtimeDisplayName: customLaunch.displayName,
                      runtimeLaunchFingerprint:
                          customLaunch.launchFingerprint,
                      runtimeRevision: customLaunch.revision,
                  }
                : sourceSnapshot;
        const persistedSnapshot =
            this.#hydrateSnapshotRuntimeCatalog(identitySnapshot);
        const shouldCaptureRuntimeDefaults =
            !snapshotOverride &&
            !liveSnapshot &&
            !storedSnapshot &&
            !sourceSnapshot.parentSessionId &&
            !hasAnySessionSelectionValue(sourceSnapshot);
        const capturedRuntimeDefaults = shouldCaptureRuntimeDefaults
            ? cloneCapturedRuntimeDefaults(
                  this.#persistence.loadRuntimeSelectionPreferences(
                      input.runtimeId,
                  ),
              )
            : EMPTY_CAPTURED_RUNTIME_DEFAULTS;
        if (shouldCaptureRuntimeDefaults) {
            this.#capturedRuntimeDefaultsBySessionId.set(
                input.sessionId,
                capturedRuntimeDefaults,
            );
        } else {
            this.#capturedRuntimeDefaultsBySessionId.delete(input.sessionId);
        }
        const persistedSubagentSessionMappings =
            await this.#listPersistedRuntimeMappingsForParent(
                persistedSnapshot.sessionId,
            );

        return {
            additionalRoots,
            cwd: projectRoot ?? process.cwd(),
            desiredSelections: this.#resolveDesiredSelections(
                persistedSnapshot,
                sourceSnapshot,
                { capturedDefaults: capturedRuntimeDefaults },
            ),
            input: {
                ...input,
                additionalRoots,
                // Tab titles are display caches and may contain a manual
                // override; the runtime must receive its own base title.
                title: persistedSnapshot.title,
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
        let snapshot =
            this.#liveSnapshots.get(sessionId) ??
            (await this.#persistence.loadSessionSnapshot(sessionId));
        if (!snapshot) {
            throw new Error("The AI session was not found.");
        }

        snapshot = await this.#hydrateNativeReviewSnapshot(snapshot);
        if (this.#liveSnapshots.has(sessionId)) {
            this.#liveSnapshots.set(sessionId, snapshot);
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

    async #hydrateNativeReviewSnapshot(
        snapshot: AiSessionSnapshot,
    ): Promise<AiSessionSnapshot> {
        const deltas = snapshot.reviewDeltas ?? [];
        if (deltas.length === 0) {
            return snapshot;
        }

        const hydratedByDeltaId = new Map<
            string,
            readonly AiTrackedFile[]
        >();
        for (const delta of deltas) {
            if (
                !snapshot.trackedFiles.some(
                    (file) => file.nativeReviewDeltaId === delta.deltaId,
                )
            ) {
                continue;
            }
            const details = await this.loadReviewDelta(
                snapshot.sessionId,
                delta.deltaId,
                delta.revision,
            );
            if (details) {
                const hydrated = details.trackedFiles.map((file) =>
                    attachNativeReviewDeltaToTrackedFile(file, delta),
                );
                const hydratedPaths = new Set(
                    hydrated.flatMap((file) => [
                        file.path,
                        ...(file.previousPath ? [file.previousPath] : []),
                    ]),
                );
                hydratedByDeltaId.set(
                    delta.deltaId,
                    [
                        ...hydrated,
                        ...snapshot.trackedFiles.filter(
                            (file) =>
                                file.nativeReviewDeltaId === delta.deltaId &&
                                !hydratedPaths.has(file.path),
                        ),
                    ],
                );
            }
        }
        if (hydratedByDeltaId.size === 0) {
            return snapshot;
        }

        const expandedDeltaIds = new Set<string>();
        const trackedFiles = snapshot.trackedFiles.flatMap((file) => {
            const deltaId = file.nativeReviewDeltaId;
            if (!deltaId || expandedDeltaIds.has(deltaId)) {
                return deltaId ? [] : [file];
            }
            const hydrated = hydratedByDeltaId.get(deltaId);
            if (!hydrated) {
                return [file];
            }
            expandedDeltaIds.add(deltaId);
            return hydrated;
        });
        let hydratedSnapshot = { ...snapshot, trackedFiles };
        for (const delta of deltas) {
            const hydrated = hydratedByDeltaId.get(delta.deltaId);
            if (!hydrated) {
                continue;
            }
            hydratedSnapshot = {
                ...hydratedSnapshot,
                reviewActionLog: consolidateNativeReviewDeltaIntoActionLog(
                    hydratedSnapshot,
                    hydrated,
                    delta,
                ),
            };
        }
        return hydratedSnapshot;
    }

    #hydrateAndPersistNativeReviewDelta(
        ownerWindowId: string,
        sessionId: string,
        delta: AiReviewDeltaSummary,
    ): void {
        if (delta.state === "unavailable" || delta.state === "superseded") {
            return;
        }

        void this.loadReviewDelta(sessionId, delta.deltaId, delta.revision)
            .then((details) => {
                if (!details) {
                    return;
                }
                const currentSnapshot = this.#liveSnapshots.get(sessionId);
                const currentDelta = currentSnapshot?.reviewDeltas?.find(
                    (candidate) => candidate.deltaId === details.delta.deltaId,
                );
                if (
                    !currentSnapshot ||
                    currentDelta?.revision !== details.delta.revision
                ) {
                    return;
                }

                const hydrated = details.trackedFiles.map((file) =>
                    attachNativeReviewDeltaToTrackedFile(file, details.delta),
                );
                const hydratedPaths = new Set(
                    hydrated.flatMap((file) => [
                        file.path,
                        ...(file.previousPath ? [file.previousPath] : []),
                    ]),
                );
                const nextSnapshot = {
                    ...currentSnapshot,
                    reviewActionLog: consolidateNativeReviewDeltaIntoActionLog(
                        currentSnapshot,
                        hydrated,
                        details.delta,
                    ),
                    trackedFiles: [
                        ...currentSnapshot.trackedFiles.filter(
                            (file) =>
                                file.nativeReviewDeltaId !==
                                    details.delta.deltaId ||
                                !hydratedPaths.has(file.path),
                        ),
                        ...hydrated,
                    ],
                };
                const cachedSnapshot = this.#cacheLiveSessionSnapshot(
                    nextSnapshot,
                    ownerWindowId,
                );
                this.#persistence.saveSessionSnapshot(cachedSnapshot);
                this.#onSessionSnapshot(
                    ownerWindowId,
                    this.#buildRendererSessionUpdate(
                        currentSnapshot,
                        cachedSnapshot,
                    ),
                );
            })
            .catch((error: unknown) => {
                debugBenignError("ai.service.persistNativeReviewDelta", error);
            });
    }

    #persistReviewMutation(
        previousSnapshot: AiSessionSnapshot,
        result: AiReviewMutationResult,
    ): void {
        const nextSnapshot = normalizeLiveReviewMutationSnapshot(
            previousSnapshot,
            result.snapshot,
        );
        if (!this.#isNativeAiSession(nextSnapshot.sessionId)) {
            this.#persistence.saveSessionSnapshot(nextSnapshot);
        }
        if (this.#liveSnapshots.has(nextSnapshot.sessionId)) {
            this.#liveSnapshots.set(nextSnapshot.sessionId, nextSnapshot);
            this.#touchLiveSession(nextSnapshot.sessionId);
        }
        this.#onSessionSnapshot(
            result.ownerWindowId,
            this.#buildRendererSessionUpdate(previousSnapshot, nextSnapshot),
        );
        void this.#enforceSessionRetention();
    }

    async #waitForReviewMutations(sessionId: string): Promise<void> {
        await this.#reviewMutationChains.get(sessionId);
    }

    async #runSerializedReviewMutation(
        sessionId: string,
        mutation: () => Promise<void>,
    ): Promise<void> {
        const previous =
            this.#reviewMutationChains.get(sessionId) ?? Promise.resolve();
        const run = previous.catch(() => undefined).then(mutation);
        const tracked = run.finally(() => {
            if (this.#reviewMutationChains.get(sessionId) === tracked) {
                this.#reviewMutationChains.delete(sessionId);
            }
        });

        this.#reviewMutationChains.set(sessionId, tracked);
        await tracked;
    }

    #rememberResolvedReviewVersion(trackedFile: AiTrackedFile): void {
        const resolvedVersions =
            this.#resolvedReviewVersions.get(trackedFile.sessionId) ??
            new Map<string, number>();
        this.#resolvedReviewVersions.set(
            trackedFile.sessionId,
            resolvedVersions,
        );

        resolvedVersions.set(
            trackedFile.identityKey,
            Math.max(
                resolvedVersions.get(trackedFile.identityKey) ?? 0,
                trackedFile.version ?? 1,
            ),
        );
    }

    /**
     * Settle accepted files into a snapshot's action log so later runtime diffs
     * for those files reconcile against the accepted text instead of the
     * session-start baseline. Native/fallback accept paths resolve changes
     * without an action log, so we create a minimal one here to carry the
     * settled baselines forward — the action log is the single owner of resolved
     * review state.
     */
    #settleAcceptedReviewFiles(
        snapshot: AiSessionSnapshot,
        acceptedTrackedFiles: readonly AiTrackedFile[],
    ): AiSessionSnapshot {
        if (acceptedTrackedFiles.length === 0) {
            return snapshot;
        }

        let reviewActionLog =
            validReviewActionLogForSnapshot(snapshot) ??
            createReviewActionLogFromTrackedFiles(
                snapshot.sessionId,
                snapshot.trackedFiles,
                { updatedAt: snapshot.updatedAt },
            );
        for (const trackedFile of acceptedTrackedFiles) {
            reviewActionLog = settleAcceptedReviewFile(
                reviewActionLog,
                trackedFile,
            );
        }
        return { ...snapshot, reviewActionLog };
    }

    async #tryApplyActionLogTrackedFileMutation(
        input: AiTrackedFileMutationInput,
        decision: "keep" | "reject",
    ): Promise<boolean> {
        const reviewSession = await this.#buildNativeReviewContext(
            input.sessionId,
        );
        const reviewActionLog = validReviewActionLogForSnapshot(
            reviewSession.snapshot,
        );
        if (!reviewActionLog) {
            return false;
        }

        const target = reviewActionLogTargetFromInput(input);
        const file = resolveReviewTarget(reviewActionLog, target);
        if (!file || !isReviewTargetVersionCurrent(file, target)) {
            return true;
        }

        const trackedFile = findTrackedFileForReviewPath(
            deriveTrackedFilesFromActionLog(reviewActionLog),
            file.identityKey,
        );
        if (!trackedFile) {
            return true;
        }

        if (decision === "reject") {
            try {
                const nativeAi =
                    this.#optionalNativeReviewDiskGateway("rejectTrackedFile");
                if (nativeAi?.rejectTrackedFile) {
                    await nativeAi.rejectTrackedFile({
                        context: reviewSession.context,
                        input,
                    });
                } else {
                    this.#assertFallbackTrackedFileCurrentMatches(
                        reviewSession.context,
                        trackedFile,
                    );
                    this.#rejectFallbackTrackedFile(
                        reviewSession.context,
                        trackedFile,
                    );
                }
            } catch (error) {
                this.#persistActionLogReviewMutation(
                    reviewSession,
                    markReviewFileConflict(reviewActionLog, target),
                );
                throw error;
            }
        }

        const nextActionLog =
            decision === "keep"
                ? keepReviewFile(reviewActionLog, target)
                : rejectReviewFile(reviewActionLog, target);
        if (nextActionLog === reviewActionLog) {
            return true;
        }

        this.#rememberResolvedReviewVersion(trackedFile);
        // keepReviewFile already recorded the accepted baseline on the action
        // log we just persisted, so later runtime diffs reconcile against it.
        this.#persistActionLogReviewMutation(reviewSession, nextActionLog);
        return true;
    }

    async #tryApplyActionLogTrackedFileHunkMutation(
        input: AiTrackedFileHunkMutationInput,
        decision: "keep" | "reject",
    ): Promise<boolean> {
        const reviewSession = await this.#buildNativeReviewContext(
            input.sessionId,
        );
        const reviewActionLog = validReviewActionLogForSnapshot(
            reviewSession.snapshot,
        );
        if (!reviewActionLog) {
            return false;
        }

        const target = reviewActionLogTargetFromInput(input);
        const file = resolveReviewTarget(reviewActionLog, target);
        if (!file || !isReviewTargetVersionCurrent(file, target)) {
            return true;
        }

        const trackedFile = findTrackedFileForReviewPath(
            deriveTrackedFilesFromActionLog(reviewActionLog),
            file.identityKey,
        );
        if (!trackedFile) {
            return true;
        }

        if (decision === "reject") {
            try {
                const nativeAi = this.#optionalNativeReviewDiskGateway(
                    "rejectTrackedFileHunks",
                );
                if (nativeAi?.rejectTrackedFileHunks) {
                    await nativeAi.rejectTrackedFileHunks({
                        context: reviewSession.context,
                        input,
                    });
                } else {
                    this.#assertFallbackTrackedFileCurrentMatches(
                        reviewSession.context,
                        trackedFile,
                    );
                    this.#writeFallbackTrackedFileCurrentText(
                        reviewSession.context,
                        trackedFile,
                        resolveTrackedFileHunks(
                            trackedFile,
                            input.hunkIds,
                            "reject",
                        ),
                    );
                }
            } catch (error) {
                this.#persistActionLogReviewMutation(
                    reviewSession,
                    markReviewFileConflict(reviewActionLog, target),
                );
                throw error;
            }
        }

        const nextActionLog =
            decision === "keep"
                ? keepReviewRanges(reviewActionLog, target, input.hunkIds)
                : rejectReviewRanges(reviewActionLog, target, input.hunkIds);
        if (nextActionLog === reviewActionLog) {
            return true;
        }

        this.#rememberResolvedReviewVersion(trackedFile);
        // keepReviewRanges advanced the action log's diff base (and recorded an
        // accepted baseline when the file fully resolved), so the persisted log
        // already protects later turns from re-proposing accepted hunks.
        this.#persistActionLogReviewMutation(reviewSession, nextActionLog);
        return true;
    }

    #persistActionLogReviewMutation(
        reviewSession: {
            readonly context: AiReviewSessionContext;
            readonly snapshot: AiSessionSnapshot;
        },
        reviewActionLog: AiReviewActionLogState,
    ): AiSessionSnapshot {
        const nextSnapshot = snapshotWithReviewActionLog(
            reviewSession.snapshot,
            reviewActionLog,
        );
        this.#persistReviewMutation(reviewSession.snapshot, {
            ownerWindowId: reviewSession.context.ownerWindowId,
            snapshot: nextSnapshot,
        });
        return nextSnapshot;
    }

    #optionalNativeReviewGateway(
        methodName: keyof NativeAiReviewGateway,
    ): NativeAiReviewGateway | null {
        if (!this.#nativeAi || this.#nativeAi.shouldHandleReview?.() !== true) {
            return null;
        }

        const method = this.#nativeAi[methodName];
        return typeof method === "function"
            ? (this.#nativeAi as NativeAiReviewGateway)
            : null;
    }

    #optionalNativeReviewDiskGateway(
        methodName: keyof NativeAiReviewGateway,
    ): NativeAiReviewGateway | null {
        if (this.#nativeAi?.shouldHandleReviewDiskMutations?.() !== true) {
            return null;
        }
        return this.#optionalNativeReviewGateway(methodName);
    }

    async #tryApplyFallbackTrackedFileMutation(
        input: AiTrackedFileMutationInput,
        decision: "keep" | "reject",
    ): Promise<boolean> {
        const reviewSession = await this.#buildNativeReviewContext(
            input.sessionId,
        );
        const trackedFile = findFallbackTrackedFileForInput(
            reviewSession.snapshot.trackedFiles,
            input,
        );
        if (!trackedFile) {
            return false;
        }
        if (!isTrackedFileMutationTargetCurrent(trackedFile, input)) {
            return true;
        }

        if (decision === "reject") {
            const nativeAi = isNativeReviewTrackedFile(trackedFile)
                ? this.#optionalNativeReviewDiskGateway("rejectTrackedFile")
                : null;
            if (nativeAi?.rejectTrackedFile) {
                await nativeAi.rejectTrackedFile({
                    context: reviewSession.context,
                    input,
                });
            } else {
                this.#assertFallbackTrackedFileCurrentMatches(
                    reviewSession.context,
                    trackedFile,
                );
                this.#rejectFallbackTrackedFile(
                    reviewSession.context,
                    trackedFile,
                );
            }
        }

        const baseSnapshot = {
            ...reviewSession.snapshot,
            trackedFiles: removeTrackedFileByIdentity(
                reviewSession.snapshot.trackedFiles,
                trackedFile.identityKey,
            ),
            updatedAt: new Date().toISOString(),
        };
        this.#rememberResolvedReviewVersion(trackedFile);
        const nextSnapshot =
            decision === "keep"
                ? this.#settleAcceptedReviewFiles(baseSnapshot, [
                      trackedFile,
                  ])
                : baseSnapshot;
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
        const trackedFile = findFallbackTrackedFileForInput(
            reviewSession.snapshot.trackedFiles,
            input,
        );
        if (!trackedFile) {
            return false;
        }
        if (!isTrackedFileMutationTargetCurrent(trackedFile, input)) {
            return true;
        }

        const nextTrackedFile = resolveTrackedFileHunks(
            trackedFile,
            input.hunkIds,
            decision,
        );
        if (decision === "reject") {
            const nativeAi = isNativeReviewTrackedFile(trackedFile)
                ? this.#optionalNativeReviewDiskGateway(
                      "rejectTrackedFileHunks",
                  )
                : null;
            if (nativeAi?.rejectTrackedFileHunks) {
                await nativeAi.rejectTrackedFileHunks({
                    context: reviewSession.context,
                    input,
                });
            } else {
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
        this.#rememberResolvedReviewVersion(trackedFile);
        // The kept-hunk result stays in trackedFiles with its diff base already
        // advanced, so the action log rebuilt on the next consolidation keeps it
        // as the active file and accepted hunks are not re-proposed.
        this.#persistReviewMutation(reviewSession.snapshot, {
            ownerWindowId: reviewSession.context.ownerWindowId,
            snapshot: nextSnapshot,
        });
        return true;
    }

    async #tryApplyAllActionLogTrackedFileMutations(
        sessionId: string,
        decision: "keep" | "reject",
    ): Promise<boolean> {
        const reviewSession = await this.#buildNativeReviewContext(sessionId);
        const reviewActionLog = validReviewActionLogForSnapshot(
            reviewSession.snapshot,
        );
        if (!reviewActionLog) {
            return false;
        }

        const pendingFiles =
            deriveTrackedFilesFromActionLog(reviewActionLog).filter(
                isAiTrackedFileUnresolved,
            );
        if (pendingFiles.length === 0) {
            return true;
        }

        if (decision === "reject") {
            const nativeAi =
                this.#optionalNativeReviewDiskGateway("rejectAllTrackedFiles");
            if (nativeAi?.rejectAllTrackedFiles) {
                await nativeAi.rejectAllTrackedFiles({
                    context: reviewSession.context,
                    input: sessionId,
                });
            } else {
                for (const trackedFile of pendingFiles) {
                    this.#assertFallbackTrackedFileCurrentMatches(
                        reviewSession.context,
                        trackedFile,
                    );
                }
                const backups = this.#createFallbackReviewBackups(
                    reviewSession.context,
                    pendingFiles,
                );
                try {
                    for (const trackedFile of pendingFiles) {
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
        }

        let nextActionLog = reviewActionLog;
        for (const trackedFile of pendingFiles) {
            this.#rememberResolvedReviewVersion(trackedFile);
            const target: AiReviewActionLogTarget = {
                expectedVersion: trackedFile.version,
                path: trackedFile.path,
                sessionId,
                trackedFileId: trackedFile.identityKey,
            };
            nextActionLog =
                decision === "keep"
                    ? keepReviewFile(nextActionLog, target)
                    : rejectReviewFile(nextActionLog, target);
        }

        if (nextActionLog !== reviewActionLog) {
            this.#persistActionLogReviewMutation(
                reviewSession,
                nextActionLog,
            );
        }
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
                isAiTrackedFileUnresolved(trackedFile) &&
                (decision === "keep" || trackedFile.reversible),
        );
        if (pendingFallbackFiles.length === 0) {
            return false;
        }

        const hasNonFallbackPendingFiles = reviewSession.snapshot.trackedFiles.some(
            (trackedFile) =>
                !isFallbackTrackedFile(trackedFile) &&
                isAiTrackedFileUnresolved(trackedFile),
        );

        if (decision === "reject") {
            const hasNativeReviewFiles = pendingFallbackFiles.some(
                isNativeReviewTrackedFile,
            );
            const nativeAi = hasNativeReviewFiles
                ? this.#optionalNativeReviewDiskGateway(
                      "rejectAllTrackedFiles",
                  )
                : null;
            if (nativeAi?.rejectAllTrackedFiles) {
                await nativeAi.rejectAllTrackedFiles({
                    context: reviewSession.context,
                    input: sessionId,
                });
            } else {
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
        }

        const fallbackIdentityKeys = new Set(
            pendingFallbackFiles.map((trackedFile) => trackedFile.identityKey),
        );
        const baseSnapshot = {
            ...reviewSession.snapshot,
            trackedFiles: reviewSession.snapshot.trackedFiles.filter(
                (trackedFile) =>
                    !fallbackIdentityKeys.has(trackedFile.identityKey),
            ),
            updatedAt: new Date().toISOString(),
        };
        const nextSnapshot =
            decision === "keep"
                ? this.#settleAcceptedReviewFiles(
                      baseSnapshot,
                      pendingFallbackFiles,
                  )
                : baseSnapshot;
        this.#persistReviewMutation(reviewSession.snapshot, {
            ownerWindowId: reviewSession.context.ownerWindowId,
            snapshot: nextSnapshot,
        });
        return !hasNonFallbackPendingFiles;
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
        await this.#runSerializedReviewMutation(input.sessionId, async () => {
            if (
                await this.#tryApplyActionLogTrackedFileMutation(input, "keep")
            ) {
                return;
            }

            if (await this.#tryApplyFallbackTrackedFileMutation(input, "keep")) {
                return;
            }
        });
    }

    async rejectTrackedFile(input: AiTrackedFileMutationInput): Promise<void> {
        await this.#runSerializedReviewMutation(input.sessionId, async () => {
            if (
                await this.#tryApplyActionLogTrackedFileMutation(
                    input,
                    "reject",
                )
            ) {
                return;
            }

            if (
                await this.#tryApplyFallbackTrackedFileMutation(input, "reject")
            ) {
                return;
            }
        });
    }

    async keepTrackedFileHunks(
        input: AiTrackedFileHunkMutationInput,
    ): Promise<void> {
        await this.#runSerializedReviewMutation(input.sessionId, async () => {
            if (
                await this.#tryApplyActionLogTrackedFileHunkMutation(
                    input,
                    "keep",
                )
            ) {
                return;
            }

            if (
                await this.#tryApplyFallbackTrackedFileHunkMutation(
                    input,
                    "keep",
                )
            ) {
                return;
            }
        });
    }

    async rejectTrackedFileHunks(
        input: AiTrackedFileHunkMutationInput,
    ): Promise<void> {
        await this.#runSerializedReviewMutation(input.sessionId, async () => {
            if (
                await this.#tryApplyActionLogTrackedFileHunkMutation(
                    input,
                    "reject",
                )
            ) {
                return;
            }

            if (
                await this.#tryApplyFallbackTrackedFileHunkMutation(
                    input,
                    "reject",
                )
            ) {
                return;
            }
        });
    }

    async keepAllTrackedFiles(sessionId: string): Promise<void> {
        await this.#runSerializedReviewMutation(sessionId, async () => {
            if (
                await this.#tryApplyAllActionLogTrackedFileMutations(
                    sessionId,
                    "keep",
                )
            ) {
                return;
            }

            if (
                await this.#tryApplyAllFallbackTrackedFileMutations(
                    sessionId,
                    "keep",
                )
            ) {
                return;
            }
        });
    }

    async rejectAllTrackedFiles(sessionId: string): Promise<void> {
        await this.#runSerializedReviewMutation(sessionId, async () => {
            if (
                await this.#tryApplyAllActionLogTrackedFileMutations(
                    sessionId,
                    "reject",
                )
            ) {
                return;
            }

            if (
                await this.#tryApplyAllFallbackTrackedFileMutations(
                    sessionId,
                    "reject",
                )
            ) {
                return;
            }
        });
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
        persistedSnapshot: Pick<
            AiSessionSnapshot,
            "configOptions" | "modeId" | "modelId"
        >,
        sourceSnapshot: Pick<
            AiSessionSnapshot,
            | "configOptions"
            | "modeId"
            | "modelId"
            | "parentSessionId"
            | "reasoningEffort"
        >,
        options: { readonly capturedDefaults: CapturedRuntimeDefaults },
    ): Pick<AiSessionSnapshot, "configOptions" | "modeId" | "modelId"> {
        const capturedDefaults = options.capturedDefaults;
        const sessionSelections = getSessionSelectionValues(sourceSnapshot);
        const preferredModeId =
            sessionSelections.modeId ??
            capturedDefaults.modeId ??
            getPreferredConfigSelectionId(
                capturedDefaults.configOptions,
                persistedSnapshot.configOptions,
                isModeConfigOption,
            );
        const preferredModelId =
            sessionSelections.modelId ??
            capturedDefaults.modelId ??
            getPreferredConfigSelectionId(
                capturedDefaults.configOptions,
                persistedSnapshot.configOptions,
                isModelConfigOption,
            );

        return {
            configOptions: applyCapturedRuntimeDefaultsToConfigOptions(
                persistedSnapshot.configOptions,
                capturedDefaults.configOptions,
                preferredModeId,
                preferredModelId,
                sessionSelections,
            ),
            modeId: preferredModeId ?? persistedSnapshot.modeId,
            modelId: preferredModelId ?? persistedSnapshot.modelId,
        };
    }

    async #updateSessionSnapshot(
        sessionId: string,
        mutate: (snapshot: AiSessionSnapshot) => AiSessionSnapshot,
    ): Promise<AiSessionSnapshot> {
        const liveSnapshot = this.#liveSnapshots.get(sessionId);
        if (liveSnapshot) {
            const nextSnapshot = normalizeLiveSnapshotReviewState(
                mutate(liveSnapshot),
            );
            this.#liveSnapshots.set(sessionId, nextSnapshot);
            if (!this.#isNativeAiSession(sessionId)) {
                this.#persistence.saveSessionSnapshot(nextSnapshot);
            }
            this.#onSessionSnapshot(
                this.#liveSessionContexts.get(sessionId)?.ownerWindowId ?? "",
                this.#buildRendererSessionUpdate(liveSnapshot, nextSnapshot),
            );
            return nextSnapshot;
        }

        const snapshot = await this.#persistence.loadSessionSnapshot(sessionId);
        if (!snapshot) {
            throw new Error("The AI session was not found.");
        }

        const nextSnapshot = clearRestoredSnapshotReviewState(mutate(snapshot));
        this.#persistence.saveSessionSnapshot(nextSnapshot);
        this.#onSessionSnapshot("", {
            kind: "snapshot",
            snapshot: nextSnapshot,
        });
        return nextSnapshot;
    }

    #resolveRuntimeStatus(runtimeId: AiRuntimeId): AiRuntimeStatus {
        if (isCustomAcpRuntimeId(runtimeId)) {
            const definition = this.#settingsService
                .listCustomAcpRuntimes()
                .find((candidate) => candidate.id === runtimeId);
            return definition
                ? resolveCustomAcpRuntime(definition).status
                : createMissingCustomAcpRuntimeStatus(runtimeId);
        }
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
        const catalogMergedStatus = catalog
            ? mergePersistedCatalogIntoRuntimeStatus(status, catalog)
            : status;
        const loadPreferences = (
            this.#persistence as Partial<AiPersistenceGateway>
        ).loadRuntimeSelectionPreferences;
        if (!loadPreferences) {
            return catalogMergedStatus;
        }
        return applyRuntimeSelectionPreferencesToStatus(
            catalogMergedStatus,
            loadPreferences.call(this.#persistence, status.runtimeId),
        );
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

    #buildRendererSessionUpdate(
        previousSnapshot: AiSessionSnapshot | null,
        nextSnapshot: AiSessionSnapshot,
    ): AiSessionUpdate {
        return buildAiSessionUpdate(
            previousSnapshot
                ? this.#toRendererSessionSnapshot(previousSnapshot)
                : null,
            this.#toRendererSessionSnapshot(nextSnapshot),
        );
    }

    #toRendererSessionSnapshot(
        snapshot: AiSessionSnapshot,
    ): AiSessionSnapshot {
        if (!this.#usesBlockNativeTranscript(snapshot.sessionId)) {
            return this.#liveTranscriptTails.projectLegacySnapshot(snapshot);
        }

        const tail = this.#liveTranscriptTails.getSnapshot(snapshot.sessionId);
        if (!tail) {
            return { ...snapshot, messages: [], toolActivity: [] };
        }
        let plan = snapshot.plan;
        const messages: AiSessionSnapshot["messages"][number][] = [];
        const toolActivity: AiSessionSnapshot["toolActivity"][number][] = [];
        for (const entry of tail.entries) {
            if (entry.payload.kind === "message") {
                messages.push(entry.payload.message);
            } else if (entry.payload.kind === "tool") {
                toolActivity.push(entry.payload.activity);
            } else if (entry.payload.kind === "plan") {
                plan = entry.payload.plan;
            }
        }
        return { ...snapshot, messages, plan, toolActivity };
    }

    #usesBlockNativeTranscript(sessionId: string): boolean {
        return this.#transcriptStorageModes.get(sessionId) === "block-native";
    }

    async #refreshTranscriptStorageMode(
        sessionId: string,
        options: { readonly preserveLegacyFallback?: boolean } = {},
    ): Promise<boolean> {
        const nativeAi = this.#nativeAi;
        if (!nativeAi?.getTranscriptStorageState) {
            this.#transcriptStorageModes.set(sessionId, "legacy");
            if (options.preserveLegacyFallback) {
                this.#legacyTranscriptSessionIds.add(sessionId);
            }
            return false;
        }
        try {
            const state = await nativeAi.getTranscriptStorageState(sessionId);
            this.#transcriptStorageModes.set(sessionId, state.mode);
            if (state.mode === "block-native") {
                this.#legacyTranscriptSessionIds.delete(sessionId);
                const migrationTimer = this.#transcriptMigrationTimers.get(sessionId);
                if (migrationTimer) {
                    clearTimeout(migrationTimer);
                    this.#transcriptMigrationTimers.delete(sessionId);
                }
            } else {
                if (options.preserveLegacyFallback) {
                    this.#legacyTranscriptSessionIds.add(sessionId);
                }
                if (state.mode === "migrating") {
                    this.#scheduleTranscriptBackfill(sessionId);
                }
            }
            return state.mode === "block-native";
        } catch (error) {
            // A failed mode lookup must preserve the readable legacy snapshot.
            debugBenignError("ai.service.transcriptStorageState", error);
            const shouldRetryBackfill =
                this.#transcriptStorageModes.get(sessionId) === "migrating";
            this.#transcriptStorageModes.set(sessionId, "legacy");
            if (options.preserveLegacyFallback) {
                this.#legacyTranscriptSessionIds.add(sessionId);
            }
            if (shouldRetryBackfill) {
                this.#scheduleTranscriptBackfill(sessionId);
            }
            return false;
        }
    }

    #scheduleTranscriptBackfill(sessionId: string): void {
        if (this.#transcriptMigrationTimers.has(sessionId)) {
            return;
        }
        const timer = setTimeout(() => {
            this.#transcriptMigrationTimers.delete(sessionId);
            void this.#refreshTranscriptStorageMode(sessionId)
                .then((isBlockNative) => {
                    if (isBlockNative) {
                        this.#invalidateTranscriptBlockMetadata(sessionId);
                        this.#scheduleTranscriptBlockMetadataLoad(sessionId);
                        // The renderer may have observed an empty block-native
                        // snapshot while this migration was still pending.
                        // Notify it once blocks are available so it can hydrate
                        // without requiring the tab to be reopened.
                        this.#emitSealedTranscriptSnapshot(sessionId);
                    }
                })
                .catch((error: unknown) => {
                    debugBenignError("ai.service.transcriptBackfill", error);
                });
        }, TRANSCRIPT_BACKFILL_RETRY_DELAY_MS);
        unrefTimer(timer);
        this.#transcriptMigrationTimers.set(sessionId, timer);
    }

    #emitSealedTranscriptSnapshot(sessionId: string): void {
        const snapshot = this.#liveSnapshots.get(sessionId);
        if (!snapshot) return;
        this.#onSessionSnapshot(
            this.#liveSessionContexts.get(sessionId)?.ownerWindowId ?? "",
            {
                kind: "snapshot",
                snapshot: this.#toRendererSessionSnapshot(snapshot),
            },
        );
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

    async #resolveLaunchRuntimeStatus(
        runtimeId: AiRuntimeId,
        fallbackStatus: AiRuntimeStatus,
    ): Promise<AiRuntimeStatus> {
        if (isCustomAcpRuntimeId(runtimeId)) {
            return fallbackStatus;
        }
        const nativeAi = this.#nativeAuthGateway(runtimeId);
        if (!nativeAi?.getRuntimeStatus) {
            return fallbackStatus;
        }

        await this.#migrateNativeRuntimeSettingsIfNeeded(runtimeId);
        return this.#withPersistedRuntimeCatalog(
            await nativeAi.getRuntimeStatus(runtimeId),
        );
    }

    #resolveRuntimeCommand(
        runtimeId: AiRuntimeId,
        codexSettingsOverride?: CodexRuntimeSettings,
    ): ResolvedAcpRuntime {
        if (isCustomAcpRuntimeId(runtimeId)) {
            const definition = this.#settingsService
                .listCustomAcpRuntimes()
                .find((candidate) => candidate.id === runtimeId);
            if (!definition) {
                return {
                    args: [],
                    command: runtimeId,
                    env: {},
                    executable: runtimeId,
                    status: createMissingCustomAcpRuntimeStatus(runtimeId),
                };
            }
            return resolveCustomAcpRuntime(definition);
        }
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
}

function isTerminalNativeReviewActivityStatus(
    status: AiToolActivity["status"],
): boolean {
    return status === "completed" || status === "failed";
}

function parseToolActivityJson(value: string | null): unknown {
    if (value === null) {
        return undefined;
    }
    try {
        return JSON.parse(value);
    } catch (error) {
        debugBenignError("ai.service.toolActivityJson", error);
        return undefined;
    }
}

function normalizeAiFileDiffPaths(
    diff: AiFileDiff,
    normalizePath: (candidatePath: string) => string | null,
): AiFileDiff | null {
    const path = normalizePath(diff.path);
    if (!path) {
        return null;
    }
    const previousPath = diff.previousPath
        ? normalizePath(diff.previousPath)
        : null;
    if (diff.previousPath && !previousPath) {
        return null;
    }
    return {
        ...diff,
        path,
        previousPath: previousPath && previousPath !== path ? previousPath : null,
    };
}

function isFallbackTrackedFile(trackedFile: AiTrackedFile): boolean {
    return (
        trackedFile.identityKey.startsWith("review:") ||
        trackedFile.identityKey.startsWith("tool:") ||
        trackedFile.identityKey.startsWith("native:") ||
        trackedFile.identityKey.startsWith("native-review:")
    );
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

function isNativeReviewTrackedFile(trackedFile: AiTrackedFile): boolean {
    return (
        trackedFile.nativeReviewDeltaId !== undefined ||
        trackedFile.identityKey.startsWith("native:") ||
        trackedFile.identityKey.startsWith("native-review:")
    );
}

function findFallbackTrackedFileForInput(
    trackedFiles: readonly AiTrackedFile[],
    input: AiTrackedFileHunkMutationInput | AiTrackedFileMutationInput,
): AiTrackedFile | null {
    if (input.trackedFileId) {
        const trackedFile =
            trackedFiles.find(
                (candidate) => candidate.identityKey === input.trackedFileId,
            ) ?? null;
        return trackedFile && isFallbackTrackedFile(trackedFile)
            ? trackedFile
            : null;
    }

    return findFallbackTrackedFile(trackedFiles, input.path);
}

function isTrackedFileMutationTargetCurrent(
    trackedFile: AiTrackedFile,
    input: AiTrackedFileHunkMutationInput | AiTrackedFileMutationInput,
): boolean {
    if (input.expectedVersion === undefined) {
        return true;
    }

    return (
        Number.isFinite(input.expectedVersion) &&
        Number.isInteger(input.expectedVersion) &&
        input.expectedVersion === (trackedFile.version ?? 1)
    );
}

function findTrackedFileForReviewPath(
    trackedFiles: readonly AiTrackedFile[],
    reviewPath: string,
): AiTrackedFile | null {
    return (
        trackedFiles.find(
            (trackedFile) =>
                trackedFile.path === reviewPath ||
                trackedFile.previousPath === reviewPath ||
                trackedFile.identityKey === reviewPath,
        ) ?? null
    );
}

function fallbackReviewMutationPaths(trackedFile: AiTrackedFile): readonly string[] {
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

function preserveCanonicalTranscriptArrays(
    previousSnapshot: AiSessionSnapshot | null,
    nextSnapshot: AiSessionSnapshot,
): AiSessionSnapshot {
    if (!previousSnapshot) {
        return nextSnapshot;
    }
    return {
        ...nextSnapshot,
        messages: previousSnapshot.messages,
        toolActivity: previousSnapshot.toolActivity,
    };
}

function mergePersistedCatalogIntoSessionSnapshot(
    snapshot: AiSessionSnapshot,
    catalog: PersistedRuntimeCatalogSnapshot,
): AiSessionSnapshot {
    const modelId = snapshot.modelId ?? catalog.modelId;
    const reasoningEffort = snapshot.reasoningEffort ?? null;
    const merged = {
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
        modelId,
        models: snapshot.models.length > 0 ? snapshot.models : catalog.models,
    };
    const modelMerged = modelId
        ? setModelOnSnapshot(merged, modelId, merged.updatedAt)
        : merged;
    return reasoningEffort
        ? setReasoningEffortOnSnapshot(
              modelMerged,
              reasoningEffort,
              modelMerged.updatedAt,
          )
        : modelMerged;
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

function applyRuntimeSelectionPreferencesToStatus(
    status: AiRuntimeStatus,
    preferences: PersistedRuntimeSelectionPreferences,
): AiRuntimeStatus {
    const configOptions = status.configOptions ?? [];
    const preferredModeId = resolveAvailableRuntimeSelectionPreference(
        preferences.modeId,
        preferences.configOptions,
        configOptions,
        (status.modes ?? []).map((mode) => mode.id),
        isModeConfigOption,
    );
    const preferredModelId = resolveAvailableRuntimeSelectionPreference(
        preferences.modelId,
        preferences.configOptions,
        configOptions,
        (status.models ?? []).map((model) => model.id),
        isModelConfigOption,
    );

    return {
        ...status,
        configOptions: applyCapturedRuntimeDefaultsToConfigOptions(
            configOptions,
            preferences.configOptions,
            preferredModeId,
            preferredModelId,
        ),
        modeId: preferredModeId ?? status.modeId,
        modelId: preferredModelId ?? status.modelId,
    };
}

function resolveAvailableRuntimeSelectionPreference(
    topLevelPreference: string | null,
    configPreferences: Record<string, boolean | string>,
    configOptions: readonly AiSessionConfigOption[],
    availableIds: readonly string[],
    matchesOption: (option: AiSessionConfigOption) => boolean,
): string | null {
    const configPreference = getPreferredConfigSelectionId(
        configPreferences,
        configOptions,
        matchesOption,
    );
    const matchingConfig = configOptions.find(matchesOption) ?? null;

    for (const candidate of [topLevelPreference, configPreference]) {
        if (!candidate) {
            continue;
        }
        if (
            availableIds.includes(candidate) ||
            (matchingConfig?.type === "select" &&
                hasSelectConfigValue(matchingConfig, candidate))
        ) {
            return candidate;
        }
    }

    return null;
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

function applyCapturedRuntimeDefaultsToConfigOptions(
    configOptions: readonly AiSessionConfigOption[],
    capturedDefaults: Record<string, boolean | string>,
    preferredModeId: string | null,
    preferredModelId: string | null,
    sessionSelections: SessionSelectionValues = EMPTY_SESSION_SELECTION_VALUES,
): readonly AiSessionConfigOption[] {
    return configOptions.map((option) => {
        const sessionValue = getSessionSelectionValue(
            sessionSelections,
            option,
        );
        const savedValue =
            sessionValue ??
            getRuntimeSelectionPreferenceValue(capturedDefaults, option.id);
        const preferredValue =
            savedValue ??
            getTopLevelSelectionPreference(
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

interface SessionSelectionValues {
    readonly configOptions: Readonly<Record<string, boolean | string>>;
    readonly modeId: string | null;
    readonly modelId: string | null;
    readonly reasoningEffort: string | null;
}

interface CapturedRuntimeDefaults {
    readonly configOptions: Record<string, boolean | string>;
    readonly modeId: string | null;
    readonly modelId: string | null;
}

const EMPTY_SESSION_SELECTION_VALUES: SessionSelectionValues = {
    configOptions: {},
    modeId: null,
    modelId: null,
    reasoningEffort: null,
};

const EMPTY_CAPTURED_RUNTIME_DEFAULTS: CapturedRuntimeDefaults = {
    configOptions: {},
    modeId: null,
    modelId: null,
};

function cloneCapturedRuntimeDefaults(
    preferences: CapturedRuntimeDefaults,
): CapturedRuntimeDefaults {
    return {
        configOptions: { ...preferences.configOptions },
        modeId: preferences.modeId,
        modelId: preferences.modelId,
    };
}

function getCapturedRuntimeDefaultMutations(
    snapshot: Pick<
        AiSessionSnapshot,
        "configOptions" | "modeId" | "modelId" | "reasoningEffort"
    >,
    capturedDefaults: CapturedRuntimeDefaults,
    options: { readonly applyCapturedDefaults?: boolean } = {},
): readonly PreferredConfigOptionMutation[] {
    const sessionSelections = options.applyCapturedDefaults
        ? EMPTY_SESSION_SELECTION_VALUES
        : getSessionSelectionValues(snapshot);

    return snapshot.configOptions
        .map((option) => {
            if (getSessionSelectionValue(sessionSelections, option) !== undefined) {
                return null;
            }

            const savedValue = getRuntimeSelectionPreferenceValue(
                capturedDefaults.configOptions,
                option.id,
            );
            const preferredValue = savedValue ?? getTopLevelSelectionPreference(
                option,
                capturedDefaults.modeId,
                capturedDefaults.modelId,
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

function getSessionSelectionValues(
    snapshot: Pick<
        AiSessionSnapshot,
        "configOptions" | "modeId" | "modelId" | "reasoningEffort"
    >,
): SessionSelectionValues {
    const configOptions: Record<string, boolean | string> = {};
    for (const option of snapshot.configOptions) {
        configOptions[option.id] = option.value;
    }

    return {
        configOptions,
        modeId:
            snapshot.modeId ??
            getSessionConfigSelectionId(snapshot.configOptions, isModeConfigOption),
        modelId:
            snapshot.modelId ??
            getSessionConfigSelectionId(snapshot.configOptions, isModelConfigOption),
        reasoningEffort: snapshot.reasoningEffort ?? null,
    };
}

function hasAnySessionSelectionValue(
    snapshot: Pick<
        AiSessionSnapshot,
        "configOptions" | "modeId" | "modelId" | "reasoningEffort"
    >,
): boolean {
    const selections = getSessionSelectionValues(snapshot);
    return (
        selections.modeId !== null ||
        selections.modelId !== null ||
        selections.reasoningEffort !== null ||
        Object.keys(selections.configOptions).length > 0
    );
}

function snapshotHasEffectiveSelections(
    snapshot: Pick<
        AiSessionSnapshot,
        "configOptions" | "modeId" | "modelId" | "reasoningEffort"
    >,
): boolean {
    return hasAnySessionSelectionValue(snapshot);
}

function getSessionSelectionValue(
    selections: SessionSelectionValues,
    option: AiSessionConfigOption,
): boolean | string | undefined {
    const optionValue = getRuntimeSelectionPreferenceValue(
        selections.configOptions,
        option.id,
    );
    if (optionValue !== undefined) {
        return optionValue;
    }

    if (isModeConfigOption(option)) {
        return selections.modeId ?? undefined;
    }

    if (isModelConfigOption(option)) {
        return selections.modelId ?? undefined;
    }

    if (isReasoningEffortConfigOption(option)) {
        return selections.reasoningEffort ?? undefined;
    }

    return undefined;
}

function getSessionConfigSelectionId(
    configOptions: readonly AiSessionConfigOption[],
    matchesOption: (option: AiSessionConfigOption) => boolean,
): string | null {
    const option = configOptions.find(matchesOption);
    return option?.type === "select" ? option.value : null;
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

function shouldSkipRuntimeSelectionPreference(
    snapshot: Pick<AiSessionSnapshot, "parentSessionId" | "runtimeId">,
): boolean {
    return snapshot.runtimeId === "codex" && Boolean(snapshot.parentSessionId);
}

function clearRestoredSnapshotReviewState(
    snapshot: AiSessionSnapshot,
): AiSessionSnapshot {
    const nativeReviewFiles = snapshot.trackedFiles.filter(
        (file) => file.nativeReviewDeltaId !== undefined,
    );
    if (
        nativeReviewFiles.length === snapshot.trackedFiles.length &&
        (snapshot.reviewActionLog ?? null) === null
    ) {
        return snapshot;
    }

    return {
        ...snapshot,
        // Native deltas have a versioned identity and can be resumed safely after restart.
        // Legacy review state remains transient because it has no equivalent reference.
        reviewActionLog: null,
        trackedFiles: nativeReviewFiles,
    };
}

function mergePersistedNativeReviewState(
    historySnapshot: AiSessionSnapshot,
    persistedSnapshot: AiSessionSnapshot | null,
): AiSessionSnapshot {
    if (
        !persistedSnapshot ||
        persistedSnapshot.sessionId !== historySnapshot.sessionId
    ) {
        return historySnapshot;
    }
    const reviewDeltas = persistedSnapshot.reviewDeltas ?? [];
    const persistedNativeFiles = persistedSnapshot.trackedFiles.filter(
        (file) => file.nativeReviewDeltaId !== undefined,
    );
    if (reviewDeltas.length === 0 && persistedNativeFiles.length === 0) {
        return historySnapshot;
    }

    return {
        ...historySnapshot,
        // The history backend reconstructs transcript state but does not own review
        // payloads. Merge only versioned native review data from its checkpoint.
        reviewDeltas,
        trackedFiles: [
            ...historySnapshot.trackedFiles.filter(
                (file) => file.nativeReviewDeltaId === undefined,
            ),
            ...persistedNativeFiles,
        ],
    };
}

function normalizeLiveSnapshotReviewState(
    snapshot: AiSessionSnapshot,
): AiSessionSnapshot {
    return normalizeSnapshotReviewState(snapshot);
}

function validReviewActionLogForSnapshot(
    snapshot: AiSessionSnapshot,
): AiReviewActionLogState | null {
    const reviewActionLog = snapshot.reviewActionLog ?? null;
    return reviewActionLog?.sessionId === snapshot.sessionId
        ? reviewActionLog
        : null;
}

function snapshotWithReviewActionLog(
    snapshot: AiSessionSnapshot,
    reviewActionLog: AiReviewActionLogState,
): AiSessionSnapshot {
    return {
        ...snapshot,
        reviewActionLog,
        trackedFiles: deriveTrackedFilesFromActionLog(reviewActionLog),
        updatedAt: reviewActionLog.updatedAt,
    };
}

function reviewActionLogTargetFromInput(
    input: AiTrackedFileHunkMutationInput | AiTrackedFileMutationInput,
): AiReviewActionLogTarget {
    return {
        expectedVersion: input.expectedVersion,
        path: input.path,
        sessionId: input.sessionId,
        trackedFileId: input.trackedFileId ?? null,
    };
}

function createReviewWorkCycleId(sessionId: string, messageId: string): string {
    return `review-cycle:${sessionId}:${messageId}`;
}

function nativeReviewFileIdentity(path: string): string {
    return `native-review:${path}`;
}

function applyNativeReviewDeltaSnapshot(
    snapshot: AiSessionSnapshot,
    delta: AiReviewDeltaSummary,
    resolvedVersions?: ReadonlyMap<string, number>,
): AiSessionSnapshot {
    if (delta.state === "superseded") {
        const supersededPaths = new Set(
            delta.files.flatMap((file) => [
                file.path,
                ...(file.previousPath ? [file.previousPath] : []),
            ]),
        );
        return {
            ...snapshot,
            reviewDeltas: (snapshot.reviewDeltas ?? []).flatMap((previous) => {
                if (previous.deltaId !== delta.deltaId) {
                    return [previous];
                }
                const files = previous.files.filter(
                    (file) => !supersededPaths.has(file.path),
                );
                return files.length > 0
                    ? [
                          {
                              ...previous,
                              files,
                              state: nativeReviewDeltaStateForFiles(files),
                          },
                      ]
                    : [];
            }),
            trackedFiles: snapshot.trackedFiles.filter(
                (file) =>
                    file.nativeReviewDeltaId !== delta.deltaId ||
                    !supersededPaths.has(file.path),
            ),
        };
    }
    const latestRevisionByPath = new Map<string, number>();
    for (const previous of snapshot.reviewDeltas ?? []) {
        for (const file of previous.files) {
            latestRevisionByPath.set(
                file.path,
                Math.max(
                    latestRevisionByPath.get(file.path) ?? 0,
                    previous.revision,
                ),
            );
        }
    }
    const activeFiles = delta.files.filter((file) => {
        const identityKey = nativeReviewFileIdentity(file.path);
        return (
            (resolvedVersions?.get(identityKey) ?? 0) < delta.revision &&
            (latestRevisionByPath.get(file.path) ?? 0) <= delta.revision
        );
    });
    if (activeFiles.length === 0) {
        return snapshot;
    }
    const replacedPaths = new Set(
        activeFiles.flatMap((file) => [
            file.path,
            ...(file.previousPath ? [file.previousPath] : []),
        ]),
    );
    const retainedDeltas = (snapshot.reviewDeltas ?? []).flatMap((previous) => {
        const files = previous.files.filter(
            (file) => !replacedPaths.has(file.path),
        );
        return files.length > 0
            ? [
                  {
                      ...previous,
                      files,
                      state: nativeReviewDeltaStateForFiles(files),
                  },
              ]
            : [];
    });
    const reviewDeltas = [
        ...retainedDeltas,
        {
            ...delta,
            files: activeFiles,
            state: nativeReviewDeltaStateForFiles(activeFiles),
        },
    ];
    const previousTrackedFiles = snapshot.trackedFiles;
    const trackedFiles = [
        ...snapshot.trackedFiles.filter(
            (file) =>
                !replacedPaths.has(file.path) ||
                (!file.nativeReviewDeltaId && !isFallbackTrackedFile(file)),
        ),
        ...activeFiles.map((file) => {
            const previous = previousTrackedFiles.find(
                (candidate) =>
                    candidate.nativeReviewDeltaId === delta.deltaId &&
                    (candidate.path === file.path ||
                        (file.previousPath !== undefined &&
                            (candidate.path === file.previousPath ||
                                candidate.previousPath === file.previousPath))),
            );
            const fallback = previousTrackedFiles.find(
                (candidate) =>
                    candidate.nativeReviewDeltaId === undefined &&
                    isFallbackTrackedFile(candidate) &&
                    candidate.toolCallId === delta.toolCallId &&
                    (candidate.path === file.path ||
                        candidate.previousPath === file.path ||
                        (file.previousPath !== undefined &&
                            (candidate.path === file.previousPath ||
                                candidate.previousPath === file.previousPath))),
            );
            if (file.state === "unavailable") {
                if (fallback) {
                    return fallback;
                }
                if (
                    previous &&
                    (previous.oldText !== null || previous.newText !== null)
                ) {
                    // Native materialization can fail after exposing provisional text.
                    // Detach that text from the unusable native reference so fallback
                    // review mutations continue to validate the working tree.
                    return {
                        ...previous,
                        identityKey: `review:${delta.sessionId}:${file.path}`,
                        nativeReviewDeltaId: undefined,
                        nativeReviewInputRevision: undefined,
                        nativeReviewState: undefined,
                        nativeReviewWorkCycleId: undefined,
                        reviewState: "pending" as const,
                        version: undefined,
                    };
                }
            }
            if (
                previous &&
                file.state !== "unavailable" &&
                (previous.oldText !== null || previous.newText !== null)
            ) {
                // Keep the provisional content on screen until the newer revision hydrates.
                return attachNativeReviewDeltaToTrackedFile(
                    {
                        ...previous,
                        nativeReviewState: file.state,
                        reviewState:
                            file.state === "partial"
                                ? "conflict"
                                : "pending",
                        updatedAt: delta.updatedAt,
                    },
                    delta,
                );
            }
            return nativeReviewSummaryToTrackedFile(delta, file);
        }),
    ];
    return { ...snapshot, reviewDeltas, trackedFiles };
}

function consolidateNativeReviewDeltaIntoActionLog(
    snapshot: AiSessionSnapshot,
    trackedFiles: readonly AiTrackedFile[],
    delta: AiReviewDeltaSummary,
): AiReviewActionLogState {
    const actionLog =
        validReviewActionLogForSnapshot(snapshot) ??
        createReviewActionLogFromTrackedFiles(
            snapshot.sessionId,
            // Native placeholders carry no full-text baseline and must not
            // become action-log entries before the worker hydrates them.
            snapshot.trackedFiles.filter(
                (file) => file.nativeReviewDeltaId === undefined,
            ),
            { updatedAt: snapshot.updatedAt },
        );
    return consolidateReviewDiffs(
        actionLog,
        trackedFiles.map(nativeTrackedFileToAiFileDiff),
        {
            origin: "live",
            sessionId: snapshot.sessionId,
            toolCallId: delta.toolCallId,
            updatedAt: delta.updatedAt,
            workCycleId: delta.workCycleId,
        },
    );
}

function nativeTrackedFileToAiFileDiff(file: AiTrackedFile): AiFileDiff {
    return {
        hunks: file.hunks,
        isText: file.isText,
        kind: file.kind,
        newText: file.newText,
        oldText: file.oldText,
        path: file.path,
        previousPath: file.previousPath,
        reversible: file.reversible,
    };
}

function nativeReviewDeltaStateForFiles(
    files: AiReviewDeltaSummary["files"],
): AiReviewDeltaSummary["state"] {
    if (files.every((file) => file.state === "preparing")) {
        return "preparing";
    }
    if (files.every((file) => file.state === "ready")) {
        return "ready";
    }
    if (files.every((file) => file.state === "unavailable")) {
        return "unavailable";
    }
    return "partial";
}

function filterNativeReviewDeltaTrackedFiles(
    trackedFiles: readonly AiTrackedFile[],
    delta: AiReviewDeltaSummary,
): readonly AiTrackedFile[] {
    const activePaths = new Set(
        delta.files.flatMap((file) => [
            file.path,
            ...(file.previousPath ? [file.previousPath] : []),
        ]),
    );
    return trackedFiles.filter(
        (file) =>
            activePaths.has(file.path) ||
            (file.previousPath !== null && activePaths.has(file.previousPath)),
    );
}

function nativeReviewSummaryToTrackedFile(
    delta: AiReviewDeltaSummary,
    file: AiReviewDeltaSummary["files"][number],
): AiTrackedFile {
    const isUnavailable = file.state === "unavailable";
    const requiresManualReview = file.state === "partial" || isUnavailable;
    return {
        ...(requiresManualReview
            ? {
                  conflict:
                      file.reason ??
                      (file.state === "partial"
                          ? "Review details are partial."
                          : "content_unavailable"),
              }
            : {}),
        hunks: [],
        identityKey: nativeReviewFileIdentity(file.path),
        isText: !isUnavailable,
        kind: file.previousPath ? "move" : "update",
        nativeReviewDeltaId: delta.deltaId,
        nativeReviewInputRevision: delta.inputRevision,
        nativeReviewState: file.state,
        nativeReviewWorkCycleId: delta.workCycleId,
        newText: null,
        oldText: null,
        path: file.path,
        previousPath: file.previousPath ?? null,
        reviewState: requiresManualReview ? "conflict" : "pending",
        reversible: !isUnavailable,
        sessionId: delta.sessionId,
        toolCallId: delta.toolCallId,
        updatedAt: delta.updatedAt,
        version: delta.revision,
    };
}

function isNativeTrackedFilesPatch(update: AiSessionUpdate): boolean {
    return (
        update.kind === "patch" &&
        Object.prototype.hasOwnProperty.call(
            update.patch.changes,
            "trackedFiles",
        )
    );
}

function isNativeAiSessionNotFoundError(error: unknown): boolean {
    return (
        error instanceof NativeBackendError &&
        error.code === "ai_session_not_found"
    );
}

function normalizeLiveReviewMutationSnapshot(
    previousSnapshot: AiSessionSnapshot,
    snapshot: AiSessionSnapshot,
): AiSessionSnapshot {
    if (
        (snapshot.reviewActionLog ?? null) !== null &&
        snapshot.reviewActionLog === (previousSnapshot.reviewActionLog ?? null) &&
        snapshot.trackedFiles !== previousSnapshot.trackedFiles
    ) {
        return normalizeLiveSnapshotReviewState({
            ...snapshot,
            reviewActionLog: null,
        });
    }

    return normalizeLiveSnapshotReviewState(snapshot);
}

function preservePassiveNativeReviewState(
    incomingSnapshot: AiSessionSnapshot,
    previousSnapshot: AiSessionSnapshot | null,
): AiSessionSnapshot {
    const previousDeltas = previousSnapshot?.reviewDeltas ?? [];
    if (previousDeltas.length === 0 || !previousSnapshot) {
        return incomingSnapshot;
    }

    // The native engine snapshots do not carry materialized review deltas. Keep
    // their local references and hydrated files until an explicit review mutation.
    return {
        ...incomingSnapshot,
        reviewDeltas: previousDeltas,
        trackedFiles: [
            ...incomingSnapshot.trackedFiles.filter(
                (file) => !file.nativeReviewDeltaId,
            ),
            ...previousSnapshot.trackedFiles.filter(
                (file) => file.nativeReviewDeltaId,
            ),
        ],
    };
}

function normalizeSnapshotReviewState(
    snapshot: AiSessionSnapshot,
): AiSessionSnapshot {
    const reviewActionLog = snapshot.reviewActionLog ?? null;
    if (reviewActionLog && reviewActionLog.sessionId === snapshot.sessionId) {
        const trackedFiles = deriveTrackedFilesFromActionLog(reviewActionLog);
        return snapshot.trackedFiles === trackedFiles
            ? snapshot
            : {
                  ...snapshot,
                  trackedFiles,
            };
    }

    if ((snapshot.reviewDeltas?.length ?? 0) > 0) {
        // Native summaries are canonical while their detail remains in Rust.
        return snapshot;
    }

    return reviewActionLog === null && snapshot.trackedFiles.length === 0
        ? snapshot
        : {
              ...snapshot,
              reviewActionLog: null,
              trackedFiles: [],
          };
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
    applyNativeReviewDeltaSnapshot,
    consolidateNativeReviewDeltaIntoActionLog,
    computeDiffHunks,
    diffToAiFileDiff,
    mergePersistedNativeReviewState,
    normalizeTrackedDiffPath,
    parseCompleteNumberedFileOutput,
    preservePassiveNativeReviewState,
    resolveDiffToFullTexts,
    resolveTrackedFileHunks,
    shouldSuppressToolActivityUpdate,
    upsertTrackedFile,
};
