import path from "node:path";
import fs from "node:fs";
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
    AiSessionEventOrigin,
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
    resolveTrackedFileHunks,
    upsertTrackedFile,
} from "@shared/ai-tracked-file";
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

import type { ProjectService } from "@main/projects/service";
import type { SettingsGateway } from "@main/settings/service";
import type {
    SecretRecordPatch,
    SecretStoreGateway,
} from "@main/ai/secret-store";
import { debugBenignError } from "@main/observability/logging";

import {
    createEmptyAiSessionSnapshot,
    type AiPersistenceGateway,
    type PersistedRuntimeCatalogSnapshot,
} from "./persistence";
import { createAiEnvironmentDiagnostics } from "./environment-diagnostics";
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
import { resolveCodexRuntime } from "./resolver/runtime-resolver";
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
    readonly #sessionsWithoutOwnSelections = new Set<string>();
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
    readonly #resolvedReviewVersions = new Map<string, Map<string, number>>();
    readonly #reviewMutationChains = new Map<string, Promise<void>>();
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
        this.#resolvedReviewVersions.clear();
        this.#reviewMutationChains.clear();
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

            const snapshot = this.#liveSnapshots.get(context.sessionId) ?? null;
            if (snapshot && isResyncEligibleAiSessionStatus(snapshot.status)) {
                snapshots.push(snapshot);
            }
        }

        return snapshots;
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

        return this.#liveSnapshots.get(sessionId) ?? null;
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
        const preservePreviousReviewSnapshot =
            isNativeTrackedFilesPatch(update) ? null : previousSnapshot;
        const nextSnapshot = this.#drainPendingNativeCatalogPatches(
            this.#preservePassiveNativeSnapshotTrackedFiles(
                this.#hydrateSnapshotRuntimeCatalog(snapshot),
                preservePreviousReviewSnapshot,
            ),
            ownerWindowId,
        );
        const cachedSnapshot = this.#cacheLiveSessionSnapshot(
            nextSnapshot,
            ownerWindowId,
        );
        this.#persistence.saveSessionSnapshot(cachedSnapshot);
        this.#onSessionSnapshot(
            ownerWindowId,
            buildAiSessionUpdate(previousSnapshot, cachedSnapshot),
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
            const cachedSnapshot = this.#cacheLiveSessionSnapshot(
                nextSnapshot,
                ownerWindowId,
            );
            this.#onSessionSnapshot(
                ownerWindowId,
                buildAiSessionUpdate(previousSnapshot, cachedSnapshot),
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
                this.#nativeChildParentSessionIds.set(
                    event.childSessionId,
                    event.parentSessionId,
                );
                this.#onSessionSnapshot(ownerWindowId, {
                    kind: "snapshot",
                    snapshot: cachedChildSnapshot,
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
            return liveSnapshot;
        }

        const persistedSnapshot =
            await this.#loadPersistedSessionSnapshot(sessionId);
        return persistedSnapshot
            ? this.#hydrateSnapshotRuntimeCatalog(persistedSnapshot)
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
        await this.#waitForReviewMutations(input.sessionId);
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
        if (!this.#liveSessionContexts.has(input.sessionId)) {
            await this.#updateSessionSnapshot(
                input.sessionId,
                (currentSnapshot) =>
                    setModeOnSnapshot(currentSnapshot, input.modeId),
            );
            return;
        }

        await this.#requireNativeAiGateway().setSessionMode(input);
        await this.#updateSessionSnapshot(
            input.sessionId,
            (currentSnapshot) =>
                setModeOnSnapshot(currentSnapshot, input.modeId),
        );
    }

    async setSessionModel(input: AiSessionModelMutationInput): Promise<void> {
        if (!this.#liveSessionContexts.has(input.sessionId)) {
            await this.#updateSessionSnapshot(
                input.sessionId,
                (currentSnapshot) =>
                    setModelOnSnapshot(currentSnapshot, input.modelId),
            );
            return;
        }

        await this.#requireNativeAiGateway().setSessionModel(input);
        await this.#updateSessionSnapshot(
            input.sessionId,
            (currentSnapshot) =>
                setModelOnSnapshot(currentSnapshot, input.modelId),
        );
    }

    async setSessionConfigOption(
        input: AiSessionConfigOptionMutationInput,
    ): Promise<void> {
        if (!this.#liveSessionContexts.has(input.sessionId)) {
            await this.#updateSessionSnapshot(
                input.sessionId,
                (currentSnapshot) =>
                    setConfigOptionOnSnapshot(
                        currentSnapshot,
                        input.optionId,
                        input.value,
                    ),
            );
            return;
        }

        await this.#requireNativeAiGateway().setSessionConfigOption(input);
        await this.#updateSessionSnapshot(
            input.sessionId,
            (currentSnapshot) =>
                setConfigOptionOnSnapshot(
                    currentSnapshot,
                    input.optionId,
                    input.value,
                ),
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
    ): AiSessionSnapshot {
        const cachedSnapshot = normalizeLiveSnapshotReviewState(snapshot);
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
        this.#resolvedReviewVersions.delete(sessionId);
        this.#reviewMutationChains.delete(sessionId);
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
        const cachedSnapshot = this.#cacheLiveSessionSnapshot(
            nextSnapshot,
            ownerWindowId,
        );
        if (!this.#isNativeAiSession(cachedSnapshot.sessionId)) {
            this.#persistence.saveSessionSnapshot(cachedSnapshot);
        }
        return cachedSnapshot;
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
        const allowRuntimeDefaults =
            this.#sessionsWithoutOwnSelections.has(sessionId);
        const modelConfig = getModelConfigOption(snapshot.configOptions);
        if (
            !modelConfig &&
            (allowRuntimeDefaults || !snapshot.modelId) &&
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
            (allowRuntimeDefaults || !snapshot.modeId) &&
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
            {
                applyRuntimeDefaults: allowRuntimeDefaults,
            },
        );
        for (const mutation of mutations) {
            await this.setSessionConfigOption({
                optionId: mutation.optionId,
                sessionId,
                value: mutation.value,
            });
            snapshot = this.#liveSnapshots.get(sessionId) ?? snapshot;
        }

        if (
            allowRuntimeDefaults &&
            snapshotHasEffectiveSelections(snapshot)
        ) {
            this.#sessionsWithoutOwnSelections.delete(sessionId);
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
        const cachedSnapshot = this.#cacheLiveSessionSnapshot(
            nextSnapshot,
            ownerWindowId,
        );
        this.#persistNativeCatalogPatch(cachedSnapshot, patch);

        if (options.emitUpdate) {
            this.#onSessionSnapshot(
                ownerWindowId,
                buildAiSessionUpdate(previousSnapshot, cachedSnapshot),
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
            const title = normalizeSessionStatusTitle(event.title);
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
                title: title
                    ? setRuntimeTitleOnSnapshot(snapshot, title, event.updatedAt)
                          .title
                    : snapshot.title,
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
                event.origin,
            );
        }

        if (event.kind === "review") {
            // Review state is owned by the TS action log. Native review events
            // are ignored so a stale sidecar cannot overwrite local decisions.
            return base;
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
            buildAiSessionUpdate(snapshot, nextSnapshot),
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
            workCycleId: baseline.workCycleId,
        });
    }

    #applyNativeToolActivityReviewDiffs(
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
            // Historical tool diffs are display-only; review state is owned by the action log.
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
        let reviewActionLog = snapshot.reviewActionLog ?? null;
        let trackedFiles = snapshot.trackedFiles;
        const rawOutput = parseToolActivityJson(activity.rawOutputJson);
        for (const diff of activity.diffs) {
            const normalizedDiff = normalizeAiFileDiffPaths(
                diff,
                normalizeDiffPath,
            );
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
                              {
                                  cwd: reviewContext.cwd,
                                  projectRoot,
                              },
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
                    {
                        updatedAt: snapshot.updatedAt,
                    },
                );
            // The action log is the single owner of review state: it preserves
            // each file's accumulated diff base and reconciles a re-emitted
            // runtime diff against it, so accepted/rejected work never resurfaces
            // — no rebase here and no separate native review mirror to feed.
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
            : {
                  ...snapshot,
                  reviewActionLog,
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

    #preservePassiveNativeSnapshotTrackedFiles(
        incomingSnapshot: AiSessionSnapshot,
        previousSnapshot: AiSessionSnapshot | null,
    ): AiSessionSnapshot {
        const snapshot =
            previousSnapshot?.manualTitle?.trim()
                ? {
                      ...incomingSnapshot,
                      manualTitle: previousSnapshot.manualTitle,
                      title: previousSnapshot.title,
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

        return normalizeLiveSnapshotReviewState(snapshot);
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
        const snapshot = this.#nativeAi?.shouldHandleHistory()
            ? await this.#nativeAi.loadSessionSnapshot(sessionId)
            : await this.#persistence.loadSessionSnapshot(sessionId);

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
        const resolvedRuntimeBase = this.#resolveRuntimeCommand(input.runtimeId);
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

        const sourceSnapshot =
            snapshotOverride ??
            this.#liveSnapshots.get(input.sessionId) ??
            (await this.#loadPersistedSessionSnapshot(input.sessionId)) ??
            createEmptyAiSessionSnapshot({
                projectId: input.projectId,
                runtimeId: input.runtimeId,
                sessionId: input.sessionId,
                title: input.title,
                worktreeId: input.worktreeId ?? null,
            });
        const persistedSnapshot =
            this.#hydrateSnapshotRuntimeCatalog(sourceSnapshot);
        if (hasAnySessionSelectionValue(sourceSnapshot)) {
            this.#sessionsWithoutOwnSelections.delete(input.sessionId);
        } else {
            this.#sessionsWithoutOwnSelections.add(input.sessionId);
        }
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
                sourceSnapshot,
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
            buildAiSessionUpdate(previousSnapshot, nextSnapshot),
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
            this.#assertFallbackTrackedFileCurrentMatches(
                reviewSession.context,
                trackedFile,
            );
            this.#rejectFallbackTrackedFile(reviewSession.context, trackedFile);
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
        runtimeId: AiRuntimeId,
        persistedSnapshot: Pick<
            AiSessionSnapshot,
            "configOptions" | "modeId" | "modelId"
        >,
        sourceSnapshot: Pick<
            AiSessionSnapshot,
            "configOptions" | "modeId" | "modelId" | "reasoningEffort"
        >,
    ): Pick<AiSessionSnapshot, "configOptions" | "modeId" | "modelId"> & {
        readonly preferredConfigOptions: Record<string, boolean | string>;
    } {
        const preferences =
            this.#persistence.loadRuntimeSelectionPreferences(runtimeId);
        const sessionSelections = getSessionSelectionValues(sourceSnapshot);
        const preferredModeId =
            sessionSelections.modeId ??
            preferences.modeId ??
            getPreferredConfigSelectionId(
                preferences.configOptions,
                persistedSnapshot.configOptions,
                isModeConfigOption,
            );
        const preferredModelId =
            sessionSelections.modelId ??
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
                sessionSelections,
            ),
            modeId: preferredModeId ?? persistedSnapshot.modeId,
            modelId: preferredModelId ?? persistedSnapshot.modelId,
            preferredConfigOptions: preferences.configOptions,
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
                buildAiSessionUpdate(liveSnapshot, nextSnapshot),
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

    async #resolveLaunchRuntimeStatus(
        runtimeId: AiRuntimeId,
        fallbackStatus: AiRuntimeStatus,
    ): Promise<AiRuntimeStatus> {
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

function normalizeSessionStatusTitle(
    title: string | null | undefined,
): string | null {
    if (typeof title !== "string") {
        return null;
    }
    const trimmed = title.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function normalizeAiFileDiffPaths(
    diff: AiFileDiff,
    normalizePath: (candidatePath: string) => string | null,
): AiFileDiff | null {
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

    return {
        ...diff,
        path: normalizedPath,
        previousPath:
            normalizedPreviousPath && normalizedPreviousPath !== normalizedPath
                ? normalizedPreviousPath
                : null,
    };
}

function isFallbackTrackedFile(trackedFile: AiTrackedFile): boolean {
    return (
        trackedFile.identityKey.startsWith("review:") ||
        trackedFile.identityKey.startsWith("tool:")
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
    sessionSelections: SessionSelectionValues = EMPTY_SESSION_SELECTION_VALUES,
): readonly AiSessionConfigOption[] {
    return configOptions.map((option) => {
        const sessionValue = getSessionSelectionValue(
            sessionSelections,
            option,
        );
        const savedValue =
            sessionValue ??
            getRuntimeSelectionPreferenceValue(preferences, option.id);
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

const EMPTY_SESSION_SELECTION_VALUES: SessionSelectionValues = {
    configOptions: {},
    modeId: null,
    modelId: null,
    reasoningEffort: null,
};

function getPreferredConfigOptionMutations(
    snapshot: Pick<
        AiSessionSnapshot,
        "configOptions" | "modeId" | "modelId" | "reasoningEffort"
    >,
    preferences: {
        readonly configOptions: Record<string, boolean | string>;
        readonly modeId: string | null;
        readonly modelId: string | null;
    },
    options: { readonly applyRuntimeDefaults?: boolean } = {},
): readonly PreferredConfigOptionMutation[] {
    const sessionSelections = options.applyRuntimeDefaults
        ? EMPTY_SESSION_SELECTION_VALUES
        : getSessionSelectionValues(snapshot);

    return snapshot.configOptions
        .map((option) => {
            if (getSessionSelectionValue(sessionSelections, option) !== undefined) {
                return null;
            }

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

function clearRestoredSnapshotReviewState(
    snapshot: AiSessionSnapshot,
): AiSessionSnapshot {
    if (
        snapshot.trackedFiles.length === 0 &&
        (snapshot.reviewActionLog ?? null) === null
    ) {
        return snapshot;
    }

    return {
        ...snapshot,
        // Persisted transcripts keep historical diffs; pending review state is
        // intentionally restored only from the live action log.
        reviewActionLog: null,
        trackedFiles: [],
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

function isNativeTrackedFilesPatch(update: AiSessionUpdate): boolean {
    return (
        update.kind === "patch" &&
        Object.prototype.hasOwnProperty.call(
            update.patch.changes,
            "trackedFiles",
        )
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
    computeDiffHunks,
    diffToAiFileDiff,
    normalizeTrackedDiffPath,
    parseCompleteNumberedFileOutput,
    resolveDiffToFullTexts,
    resolveTrackedFileHunks,
    shouldSuppressToolActivityUpdate,
    upsertTrackedFile,
};
