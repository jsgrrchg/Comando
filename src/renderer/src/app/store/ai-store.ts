import { create } from "zustand";

import type {
    AiFileContextAttachment,
    AiImageAttachment,
    AiMessage,
    AiRuntimeAuthDisconnectInput,
    AiRuntimeAuthLaunchInput,
    AiRuntimeAuthLogoutInput,
    AiPermissionResponseInput,
    AiPromptQueueSnapshot,
    AiQueuedPrompt,
    AiRuntimeId,
    AiRuntimeStatus,
    AiSessionConfigOption,
    AiSessionConfigOptionMutationInput,
    AiSessionDomainEvent,
    AiSessionModeMutationInput,
    AiSessionModelMutationInput,
    AiSessionPatch,
    AiSessionRenameMutationInput,
    AiSessionSnapshot,
    AiSessionUpdate,
    AiSettingsSnapshot,
    AiToolActivity,
    AiToolActivityDetail,
    AiTranscriptBlock,
    AiTranscriptBlockMetadata,
    AiTranscriptPayload,
    AiTrackedFile,
    AiTrackedFileHunkMutationInput,
    AiTrackedFileMutationInput,
    AiUserInputResponseInput,
    ClaudeRuntimeSettings,
    CodexRuntimeSettings,
    ClaudeRuntimeSettingsInput,
    GrokRuntimeSettings,
    GrokRuntimeSettingsInput,
    KiloRuntimeSettings,
    KiloRuntimeSettingsInput,
    OpenCodeRuntimeSettings,
    OpenCodeRuntimeSettingsInput,
    SecretValuePatch,
} from "@shared/ipc";
import { serializeComposerMessagePartsForDisplay } from "@shared/composer-display-markers";
import {
    deriveTrackedFilesFromActionLog,
    isReviewTargetVersionCurrent,
    keepReviewFile,
    keepReviewRanges,
    rejectReviewFile,
    rejectReviewRanges,
    resolveReviewTarget,
    type AiReviewActionLogState,
    type AiReviewActionLogTarget,
} from "@shared/ai-review-action-log";
import { resolveTrackedFileHunks } from "@shared/ai-tracked-file";
import {
    applyModelIdToConfigOptions,
    applyReasoningEffortToConfigOptions,
    isReasoningEffortConfigOption,
} from "@shared/ai-config-options";

import {
    appendSelectionMentionDraftPart,
    cloneComposerDraftParts,
    cloneDraftAttachments,
    cloneDraftFileContexts,
    createEmptyComposerDraftParts,
    normalizeAiDiffZoom,
    type AiComposerDraftPart,
    type QueuedPrompt,
} from "@renderer/app/ai/sessionReviewContracts";
import {
    persistSessionReviewPreferences,
    readSessionReviewPreferencesForTab,
    type SessionReviewPreferences,
} from "@renderer/app/ai/sessionReviewPreferences";
import {
    applyAiSessionDomainEventToTranscript,
    buildAiSessionTranscriptModel,
    buildAiSessionTranscriptModelFromSnapshot,
    createEmptyAiSessionTranscriptModel,
    getSnapshotTranscriptMergeOptions,
    mergeAiSessionTranscriptSources,
    removeAiSessionTranscriptEntries,
    shouldPreserveCurrentAiSessionTranscript,
    writeAiSessionTranscriptToSnapshot,
    type AiSessionTranscriptModel,
} from "@renderer/app/ai/transcriptModel";
import {
    TranscriptWindowStore,
    type TranscriptWindowSnapshot,
} from "@renderer/app/ai/transcriptWindowStore";
import { TranscriptPayloadCache } from "@renderer/app/ai/transcriptPayloadCache";
import { resolveTranscriptPrefetchBlockId } from "@renderer/app/ai/transcriptWindowNavigation";
import { matchesTrackedFilePath } from "@renderer/app/ai/trackedFilePath";
import {
    getChatPerformanceTimestamp,
    measureChatPerformance,
    measureChatPerformanceAsync,
    recordChatPerformanceMetric,
} from "@renderer/app/debug/chatPerformanceProbe";
import { incrementChatPerformanceCounter } from "@renderer/app/debug/chatPerformanceCounters";
import type {
    RuntimeWorkspaceChatTab,
    RuntimeWorkspaceReviewTab,
} from "../workspace/tree";
import { useWorkspaceStore } from "./workspace-store";

type RuntimeAiSessionTab = RuntimeWorkspaceChatTab | RuntimeWorkspaceReviewTab;
type AiSessionRuntimeState = "history" | "live";

const ensureSessionInFlight = new Map<string, Promise<void>>();
const transcriptWindowHydrations = new Map<string, Promise<void>>();
const transcriptWindowRefreshRequests = new Set<string>();
const reviewDeltaHydrations = new Map<string, Promise<void>>();
const toolActivityDetailHydrations = new Map<string, Promise<void>>();
const TRANSCRIPT_PAYLOAD_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const TRANSCRIPT_PAYLOAD_BATCH_MAX_REFS = 8;
// Sharing this cache keeps the payload budget fixed as users open more sessions.
let transcriptPayloadCache = createTranscriptPayloadCache();
const transcriptWindowStore = new TranscriptWindowStore(
    {
        loadBlock: (sessionId, blockId) =>
            getComandoApi().getAiTranscriptBlock(sessionId, blockId).then(
                (block) => {
                    if (!block) {
                        throw new Error("The transcript block could not be found.");
                    }
                    return block;
                },
            ),
    },
);
type OptimisticSnapshotMutator = (
    snapshot: AiSessionSnapshot,
) => AiSessionSnapshot;

const optimisticSnapshotMutationStates = new Map<
    string,
    {
        latestVersion: number;
        latestVersionByConflictKey: Map<string, number>;
        nextVersion: number;
        pendingVersionsByConflictKey: Map<string, Set<number>>;
        preservedMutations: Map<number, OptimisticSnapshotMutator>;
        rollbackBaseSnapshotsByConflictKey: Map<string, AiSessionSnapshot>;
        pendingVersions: Set<number>;
    }
>();

interface AiSessionControlMutationOptions {
    readonly ensureLiveSession?: (force: boolean) => Promise<void>;
}

interface RegisteredSessionMeta {
    readonly projectId: string | null;
    readonly runtimeId: AiRuntimeId;
    readonly title: string;
    readonly worktreeId: string | null;
}

interface ResolveIncomingSnapshotOptions {
    readonly changedKeys?: ReadonlySet<keyof AiSessionPatch["changes"]> | null;
    readonly preserveCurrentReviewState?: boolean;
}

interface ResolvedIncomingSessionSnapshot {
    readonly snapshot: AiSessionSnapshot;
    readonly transcript: AiSessionTranscriptModel;
}

interface QueuedPromptEditState {
    readonly nextPromptId: string | null;
    readonly previousComposerParts: readonly AiComposerDraftPart[];
    readonly previousDraftAttachments: readonly AiImageAttachment[];
    readonly previousDraftFileContexts: readonly AiFileContextAttachment[];
    readonly previousPromptId: string | null;
    readonly queueIndex: number;
}

interface QueuedPromptPositionState {
    readonly nextPromptId: string | null;
    readonly previousPromptId: string | null;
    readonly queueIndex: number;
}

interface ActiveQueuedPromptState {
    readonly activatedAfterIncomingSnapshotVersion: number;
    readonly position: QueuedPromptPositionState;
    readonly queuedPrompt: QueuedPrompt;
}

type AiHistoryHydrationState =
    | "not_loaded"
    | "loading"
    | "loaded"
    | "missing"
    | "failed";

interface AiTranscriptWindowClientState {
    readonly anchorBlockId: string | null;
    readonly blocksById: ReadonlyMap<string, AiTranscriptBlock>;
    readonly capabilityVersion: number | null;
    readonly error: string | null;
    readonly followTail: boolean;
    readonly generation: number;
    readonly isLoading: boolean;
    readonly metadata: readonly AiTranscriptBlockMetadata[];
    readonly payloadsByRef: ReadonlyMap<string, AiTranscriptPayload>;
    readonly protectedBlockIds: ReadonlySet<string>;
    readonly residentEntries: number;
    readonly transcriptRevision: number | null;
}

interface AiSessionClientState {
    readonly activeDispatchToken: string | null;
    readonly activePromptMessageAliases: Readonly<Record<string, string>>;
    readonly activeQueuedPrompt: ActiveQueuedPromptState | null;
    readonly draftAttachments: readonly AiImageAttachment[];
    readonly draftComposerParts: readonly AiComposerDraftPart[];
    readonly draftFileContexts: readonly AiFileContextAttachment[];
    readonly dismissedPlanUpdatedAt: string | null;
    readonly diffZoom: number | null;
    readonly editingQueuedPromptState: QueuedPromptEditState | null;
    readonly editingQueuedPrompt: QueuedPrompt | null;
    readonly incomingSnapshotVersion: number;
    readonly historyHydrationState: AiHistoryHydrationState;
    readonly isDispatching: boolean;
    readonly lastIncomingSnapshotUpdatedAt: string | null;
    readonly localError: string | null;
    readonly meta: RegisteredSessionMeta | null;
    readonly queue: readonly QueuedPrompt[];
    readonly queueRevision: number;
    // Projected from the main-owned queue. A paused queue will not dispatch
    // again until the user explicitly resumes or steers it.
    readonly queuePaused: boolean;
    readonly runtimeState: AiSessionRuntimeState;
    readonly snapshot: AiSessionSnapshot | null;
    readonly transcript: AiSessionTranscriptModel;
    readonly transcriptWindow: AiTranscriptWindowClientState;
}

type AiRuntimeCatalog = Pick<
    AiSessionSnapshot,
    | "availableCommands"
    | "configOptions"
    | "modeId"
    | "modes"
    | "modelId"
    | "models"
>;

const EMPTY_RUNTIME_CATALOG: AiRuntimeCatalog = {
    availableCommands: [],
    configOptions: [],
    modeId: null,
    modes: [],
    modelId: null,
    models: [],
};

type CodexAuthMethodId = "chatgpt" | "codex-api-key" | "openai-api-key";

interface CodexRuntimeSettingsInput {
    readonly authMethod: CodexAuthMethodId | null;
    readonly binaryPath: string | null;
    readonly codexApiKey: SecretValuePatch;
    readonly openaiApiKey: SecretValuePatch;
}

interface AiStore {
    readonly claudeSettings: ClaudeRuntimeSettings;
    readonly codexBinaryPath: string;
    readonly codexSettings: CodexRuntimeSettings;
    readonly grokSettings: GrokRuntimeSettings;
    readonly kiloSettings: KiloRuntimeSettings;
    readonly opencodeSettings: OpenCodeRuntimeSettings;
    readonly runtimeCatalogById: Partial<Record<AiRuntimeId, AiRuntimeCatalog>>;
    readonly runtimeStatusById: Partial<Record<AiRuntimeId, AiRuntimeStatus>>;
    readonly sessions: Record<string, AiSessionClientState>;
    applyRuntimeStatus: (status: AiRuntimeStatus) => void;
    applySessionEvent: (event: AiSessionDomainEvent) => void;
    applySessionUpdate: (update: AiSessionUpdate) => void;
    applySessionSnapshot: (snapshot: AiSessionSnapshot) => void;
    applyPromptQueueSnapshot: (snapshot: AiPromptQueueSnapshot) => void;
    cancelSession: (sessionId: string) => Promise<void>;
    cancelQueuedPromptEdit: (
        sessionId: string,
    ) => readonly AiComposerDraftPart[] | null;
    clearDraftAttachments: (sessionId: string) => void;
    dismissSessionPlan: (sessionId: string, planUpdatedAt: string) => void;
    attachSelectionMention: (
        sessionId: string,
        selection: {
            readonly path: string;
            readonly selectedText: string;
            readonly startLine: number;
            readonly endLine: number;
        },
    ) => void;
    clearQueuedPrompts: (sessionId: string) => void;
    addDraftFileContext: (
        sessionId: string,
        context: AiFileContextAttachment,
    ) => void;
    removeDraftFileContext: (sessionId: string, contextId: string) => void;
    clearDraftFileContexts: (sessionId: string) => void;
    editQueuedPrompt: (
        sessionId: string,
        promptId: string,
        currentComposerParts?: readonly AiComposerDraftPart[],
    ) => readonly AiComposerDraftPart[] | null;
    ensureSession: (
        tab: RuntimeAiSessionTab,
        options?: {
            readonly force?: boolean;
        },
    ) => Promise<void>;
    hydrateSettings: (settings: AiSettingsSnapshot | null | undefined) => void;
    hydrateTranscriptWindow: (sessionId: string) => Promise<void>;
    hydrateReviewDeltas: (sessionId: string) => Promise<void>;
    hydrateToolActivityDetail: (
        sessionId: string,
        activityId: string,
    ) => Promise<void>;
    keepAllTrackedFiles: (sessionId: string) => Promise<void>;
    keepTrackedFile: (input: AiTrackedFileMutationInput) => Promise<void>;
    keepTrackedFileHunks: (
        input: AiTrackedFileHunkMutationInput,
    ) => Promise<void>;
    refreshRuntimeStatus: (runtimeId: AiRuntimeId) => Promise<void>;
    registerSessionTab: (tab: RuntimeAiSessionTab) => void;
    rejectAllTrackedFiles: (sessionId: string) => Promise<void>;
    rejectTrackedFile: (input: AiTrackedFileMutationInput) => Promise<void>;
    rejectTrackedFileHunks: (
        input: AiTrackedFileHunkMutationInput,
    ) => Promise<void>;
    removeQueuedPrompt: (sessionId: string, promptId: string) => void;
    respondPermission: (input: AiPermissionResponseInput) => Promise<void>;
    respondUserInput: (input: AiUserInputResponseInput) => Promise<void>;
    launchRuntimeAuth: (input: AiRuntimeAuthLaunchInput) => Promise<void>;
    logoutRuntimeAuth: (
        input: AiRuntimeAuthLogoutInput,
    ) => Promise<AiRuntimeStatus>;
    disconnectRuntimeAuth: (
        input: AiRuntimeAuthDisconnectInput,
    ) => Promise<AiRuntimeStatus>;
    saveClaudeRuntimeSettings: (
        settings: ClaudeRuntimeSettingsInput,
    ) => Promise<AiRuntimeStatus>;
    saveGrokRuntimeSettings: (
        settings: GrokRuntimeSettingsInput,
    ) => Promise<AiRuntimeStatus>;
    saveKiloRuntimeSettings: (
        settings: KiloRuntimeSettingsInput,
    ) => Promise<AiRuntimeStatus>;
    saveOpenCodeRuntimeSettings: (
        settings: OpenCodeRuntimeSettingsInput,
    ) => Promise<AiRuntimeStatus>;
    saveCodexRuntimeSettings: (
        settings: CodexRuntimeSettingsInput,
    ) => Promise<AiRuntimeStatus>;
    verifyCodexRuntimeSettings: (
        settings: CodexRuntimeSettingsInput,
    ) => Promise<AiRuntimeStatus>;
    saveCodexBinaryPath: (binaryPath: string) => Promise<AiRuntimeStatus>;
    setDraftComposerParts: (
        sessionId: string,
        parts: readonly AiComposerDraftPart[],
    ) => void;
    setDraftAttachments: (
        sessionId: string,
        attachments: readonly AiImageAttachment[],
    ) => void;
    setQueuedPromptStatus: (
        sessionId: string,
        promptId: string,
        status: QueuedPrompt["status"],
    ) => void;
    setSessionDiffZoom: (sessionId: string, diffZoom: number) => void;
    setTranscriptWindowAnchor: (
        sessionId: string,
        anchorBlockId: string | null,
        followTail: boolean,
    ) => void;
    loadTranscriptWindowBlock: (
        sessionId: string,
        blockId: string,
    ) => Promise<AiTranscriptBlock | null>;
    prefetchTranscriptWindow: (
        sessionId: string,
        direction: "backward" | "forward",
    ) => Promise<void>;
    loadTranscriptPayload: (
        sessionId: string,
        payloadRef: string,
        options?: { readonly protect?: boolean; readonly publish?: boolean },
    ) => Promise<AiTranscriptPayload | null>;
    loadTranscriptPayloads: (
        sessionId: string,
        payloadRefs: readonly string[],
        options?: { readonly protect?: boolean; readonly publish?: boolean },
    ) => Promise<ReadonlyMap<string, AiTranscriptPayload>>;
    releaseTranscriptPayload: (sessionId: string, payloadRef: string) => void;
    setSessionMode: (
        input: AiSessionModeMutationInput,
        options?: AiSessionControlMutationOptions,
    ) => Promise<void>;
    setSessionModel: (
        input: AiSessionModelMutationInput,
        options?: AiSessionControlMutationOptions,
    ) => Promise<void>;
    setSessionConfigOption: (
        input: AiSessionConfigOptionMutationInput,
        options?: AiSessionControlMutationOptions,
    ) => Promise<void>;
    renameSession: (input: AiSessionRenameMutationInput) => Promise<void>;
    sendQueuedPromptNow: (sessionId: string, promptId: string) => Promise<void>;
    verifyCodexBinaryPath: (binaryPath: string) => Promise<AiRuntimeStatus>;
    sendPrompt: (
        tab: RuntimeWorkspaceChatTab,
        prompt: string,
        options?: {
            readonly additionalRoots?: readonly string[];
            readonly attachments?: readonly AiImageAttachment[];
            readonly composerPartsSnapshot?: readonly AiComposerDraftPart[];
            readonly fileContextsSnapshot?: readonly AiFileContextAttachment[];
        },
    ) => Promise<void>;
}

type SetAiState = typeof useAiStore.setState;
type GetAiState = () => AiStore;

type BufferedSessionDeltaEvent = Extract<
    AiSessionDomainEvent,
    { kind: "message-delta" | "thinking-delta" }
>;

interface BufferedSessionDeltaBuffer {
    readonly events: Map<string, BufferedSessionDeltaEvent>;
    cancelScheduledFlush: (() => void) | null;
    firstQueuedAt: number | null;
}

const bufferedSessionDeltasBySessionId = new Map<
    string,
    BufferedSessionDeltaBuffer
>();
let isFlushingBufferedSessionDeltas = false;
const AI_SESSION_RESYNC_SILENCE_MS = 20_000;
const AI_SESSION_RESYNC_RETRY_DELAYS_MS = [20_000, 30_000, 45_000, 60_000];

interface AiSessionResyncWatchdog {
    inFlight: boolean;
    progressKey: string;
    requestedProgressKey: string | null;
    retryAttempt: number;
    timer: ReturnType<typeof setTimeout> | null;
}

const aiSessionResyncWatchdogs = new Map<string, AiSessionResyncWatchdog>();

function isSessionDeltaEvent(
    event: AiSessionDomainEvent,
): event is BufferedSessionDeltaEvent {
    return event.kind === "message-delta" || event.kind === "thinking-delta";
}

function sessionDeltaBufferKey(event: BufferedSessionDeltaEvent): string {
    return event.kind === "message-delta"
        ? `${event.sessionId}\u{1f}${event.kind}\u{1f}${event.messageKind}\u{1f}${event.messageId}`
        : `${event.sessionId}\u{1f}${event.kind}\u{1f}${event.messageId}`;
}

function mergeBufferedSessionDelta(
    existing: BufferedSessionDeltaEvent,
    incoming: BufferedSessionDeltaEvent,
): BufferedSessionDeltaEvent {
    const nextContent =
        incoming.content.length >= existing.content.length
            ? incoming.content
            : `${existing.content}${incoming.delta}`;
    return {
        ...incoming,
        content: nextContent,
        delta: `${existing.delta}${incoming.delta}`,
    };
}

function getBufferedSessionDeltaBuffer(
    sessionId: string,
): BufferedSessionDeltaBuffer {
    const existing = bufferedSessionDeltasBySessionId.get(sessionId);
    if (existing) {
        return existing;
    }

    const buffer: BufferedSessionDeltaBuffer = {
        cancelScheduledFlush: null,
        events: new Map(),
        firstQueuedAt: null,
    };
    bufferedSessionDeltasBySessionId.set(sessionId, buffer);
    return buffer;
}

function scheduleBufferedSessionDeltaFlush(
    sessionId: string,
    buffer: BufferedSessionDeltaBuffer,
    get: GetAiState,
): void {
    if (buffer.cancelScheduledFlush !== null) {
        return;
    }

    const flush = () => {
        const currentBuffer = bufferedSessionDeltasBySessionId.get(sessionId);
        if (currentBuffer === buffer) {
            currentBuffer.cancelScheduledFlush = null;
        }
        flushBufferedSessionDeltas(get, sessionId);
    };
    if (typeof globalThis.requestAnimationFrame === "function") {
        const frameId = globalThis.requestAnimationFrame(flush);
        buffer.cancelScheduledFlush = () => {
            globalThis.cancelAnimationFrame(frameId);
        };
        return;
    }

    const timer = setTimeout(flush, 16);
    buffer.cancelScheduledFlush = () => {
        clearTimeout(timer);
    };
}

function bufferSessionDeltaEvent(
    event: BufferedSessionDeltaEvent,
    get: GetAiState,
): void {
    const buffer = getBufferedSessionDeltaBuffer(event.sessionId);
    const key = sessionDeltaBufferKey(event);
    const existing = buffer.events.get(key);
    if (buffer.firstQueuedAt === null) {
        buffer.firstQueuedAt = getChatPerformanceTimestamp();
    }
    buffer.events.set(
        key,
        existing ? mergeBufferedSessionDelta(existing, event) : event,
    );
    scheduleBufferedSessionDeltaFlush(event.sessionId, buffer, get);
}

function flushBufferedSessionDeltas(get: GetAiState, sessionId: string): void {
    const buffer = bufferedSessionDeltasBySessionId.get(sessionId);
    if (!buffer || buffer.events.size === 0) {
        return;
    }

    buffer.cancelScheduledFlush?.();
    buffer.cancelScheduledFlush = null;
    const events = Array.from(buffer.events.values());
    const queuedAt = buffer.firstQueuedAt;
    bufferedSessionDeltasBySessionId.delete(sessionId);
    if (queuedAt !== null) {
        recordChatPerformanceMetric("delta_buffer_wait_ms", {
            durationMs: performance.now() - queuedAt,
            sessionId,
            values: { payloadDepth: events.length },
        });
    }
    isFlushingBufferedSessionDeltas = true;
    try {
        for (const event of events) {
            get().applySessionEvent(event);
        }
    } finally {
        isFlushingBufferedSessionDeltas = false;
    }
}

function resetBufferedSessionDeltas(): void {
    for (const buffer of bufferedSessionDeltasBySessionId.values()) {
        buffer.cancelScheduledFlush?.();
    }
    bufferedSessionDeltasBySessionId.clear();
    isFlushingBufferedSessionDeltas = false;
}

function isAiSessionResyncWatchdogActive(snapshot: AiSessionSnapshot): boolean {
    return (
        snapshot.status === "starting" ||
        snapshot.status === "streaming" ||
        snapshot.status === "waiting_permission" ||
        snapshot.status === "waiting_user_input"
    );
}

function getAiSessionVisibleProgressKey(snapshot: AiSessionSnapshot): string {
    const lastMessage = snapshot.messages[snapshot.messages.length - 1] ?? null;
    const lastToolActivity =
        snapshot.toolActivity[snapshot.toolActivity.length - 1] ?? null;

    return JSON.stringify({
        messageContentLength: lastMessage?.content.length ?? 0,
        messageCount: snapshot.messages.length,
        messageId: lastMessage?.id ?? null,
        messageStatus: lastMessage?.status ?? null,
        status: snapshot.status,
        toolActivityCount: snapshot.toolActivity.length,
        toolActivityId: lastToolActivity?.id ?? null,
        toolActivityStatus: lastToolActivity?.status ?? null,
        toolActivityUpdatedAt: lastToolActivity?.updatedAt ?? null,
        updatedAt: snapshot.updatedAt,
    });
}

function clearAiSessionResyncWatchdog(sessionId: string): void {
    const existing = aiSessionResyncWatchdogs.get(sessionId);
    if (!existing) {
        return;
    }
    if (existing.timer) {
        clearTimeout(existing.timer);
    }
    aiSessionResyncWatchdogs.delete(sessionId);
}

function resetAiSessionResyncWatchdogs(): void {
    for (const sessionId of aiSessionResyncWatchdogs.keys()) {
        clearAiSessionResyncWatchdog(sessionId);
    }
}

function getAiSessionResyncRetryDelayMs(retryAttempt: number): number {
    return AI_SESSION_RESYNC_RETRY_DELAYS_MS[
        Math.min(retryAttempt, AI_SESSION_RESYNC_RETRY_DELAYS_MS.length - 1)
    ];
}

function scheduleAiSessionResyncWatchdogTimer(
    sessionId: string,
    watchdog: AiSessionResyncWatchdog,
    get: GetAiState,
    delayMs: number,
): void {
    watchdog.timer = setTimeout(() => {
        void requestAiSessionResyncAfterSilence(
            sessionId,
            watchdog.progressKey,
            get,
        );
    }, delayMs);
}

function scheduleAiSessionResyncWatchdog(
    sessionId: string,
    get: GetAiState,
): void {
    const snapshot = get().sessions[sessionId]?.snapshot ?? null;
    if (!snapshot || !isAiSessionResyncWatchdogActive(snapshot)) {
        clearAiSessionResyncWatchdog(sessionId);
        return;
    }

    const progressKey = getAiSessionVisibleProgressKey(snapshot);
    const existing = aiSessionResyncWatchdogs.get(sessionId);
    if (
        existing?.progressKey === progressKey &&
        (existing.timer ||
            existing.inFlight ||
            existing.requestedProgressKey === progressKey)
    ) {
        return;
    }

    if (existing?.timer) {
        clearTimeout(existing.timer);
    }

    const watchdog: AiSessionResyncWatchdog = {
        inFlight: false,
        progressKey,
        requestedProgressKey:
            existing?.progressKey === progressKey
                ? existing.requestedProgressKey
                : null,
        retryAttempt:
            existing?.progressKey === progressKey ? existing.retryAttempt : 0,
        timer: null,
    };
    scheduleAiSessionResyncWatchdogTimer(
        sessionId,
        watchdog,
        get,
        AI_SESSION_RESYNC_SILENCE_MS,
    );
    aiSessionResyncWatchdogs.set(sessionId, watchdog);
}

async function requestAiSessionResyncAfterSilence(
    sessionId: string,
    progressKey: string,
    get: GetAiState,
): Promise<void> {
    const watchdog = aiSessionResyncWatchdogs.get(sessionId);
    if (!watchdog || watchdog.progressKey !== progressKey) {
        return;
    }
    watchdog.timer = null;

    const snapshot = get().sessions[sessionId]?.snapshot ?? null;
    if (
        !snapshot ||
        !isAiSessionResyncWatchdogActive(snapshot) ||
        getAiSessionVisibleProgressKey(snapshot) !== progressKey ||
        watchdog.inFlight ||
        watchdog.requestedProgressKey === progressKey
    ) {
        return;
    }

    watchdog.inFlight = true;
    watchdog.requestedProgressKey = progressKey;
    let appliedSnapshot = false;
    try {
        const resyncSnapshot = await getComandoApi().resyncAiSession(sessionId);
        if (resyncSnapshot) {
            appliedSnapshot = true;
            get().applySessionSnapshot(resyncSnapshot);
        }
    } catch (error) {
        console.warn("[comando] Failed to resync quiet AI session.", error);
    } finally {
        const latest = aiSessionResyncWatchdogs.get(sessionId);
        if (latest?.progressKey === progressKey) {
            latest.inFlight = false;
            if (!appliedSnapshot) {
                latest.requestedProgressKey = null;
                latest.retryAttempt += 1;
                const latestSnapshot =
                    get().sessions[sessionId]?.snapshot ?? null;
                if (
                    latestSnapshot &&
                    isAiSessionResyncWatchdogActive(latestSnapshot) &&
                    getAiSessionVisibleProgressKey(latestSnapshot) ===
                        progressKey &&
                    latest.timer === null
                ) {
                    scheduleAiSessionResyncWatchdogTimer(
                        sessionId,
                        latest,
                        get,
                        getAiSessionResyncRetryDelayMs(latest.retryAttempt),
                    );
                }
            }
        }
    }
}

export function resetAiStoreRuntimeBuffersForTests(): void {
    resetBufferedSessionDeltas();
    resetAiSessionResyncWatchdogs();
    optimisticSnapshotMutationStates.clear();
    reviewDeltaHydrations.clear();
    toolActivityDetailHydrations.clear();
    transcriptWindowHydrations.clear();
    transcriptWindowRefreshRequests.clear();
    transcriptWindowStore.reset();
    transcriptPayloadCache = createTranscriptPayloadCache();
}

export function applyAiTranscriptMemoryPressure(factor = 0.5): void {
    transcriptPayloadCache.applyMemoryPressure(factor);
    const evictedPayloadRefsBySession = takeEvictedTranscriptPayloadRefs();
    if (evictedPayloadRefsBySession.size === 0) {
        return;
    }
    useAiStore.setState((state) => ({
        sessions: removeEvictedTranscriptPayloads(
            state.sessions,
            evictedPayloadRefsBySession,
        ),
    }));
}

function createTranscriptPayloadCache(): TranscriptPayloadCache<AiTranscriptPayload> {
    return new TranscriptPayloadCache(
        {
            load: async (key) => {
                const identity = parseTranscriptPayloadCacheKey(key);
                if (!identity) {
                    throw new Error("The transcript payload cache key is invalid.");
                }
                const startedAt = getChatPerformanceTimestamp();
                incrementChatPerformanceCounter(
                    "transcript_payload_ipc_count",
                );
                const payload = await getComandoApi().getAiTranscriptPayload(
                    {
                        payloadRef: identity.payloadRef,
                        sessionId: identity.sessionId,
                    },
                );
                if (!payload) {
                    throw new Error("The transcript payload could not be found.");
                }
                incrementChatPerformanceCounter(
                    "transcript_payload_bytes",
                    payload.byteLength,
                );
                if (startedAt !== null) {
                    recordChatPerformanceMetric(
                        "transcript_payload_load_ms",
                        {
                            durationMs: performance.now() - startedAt,
                            sessionId: identity.sessionId,
                            values: { byteLength: payload.byteLength },
                        },
                    );
                }
                return payload;
            },
            loadMany: async (keys) => {
                const identities = keys.map(parseTranscriptPayloadCacheKey);
                if (identities.some((identity) => !identity)) {
                    throw new Error("The transcript payload cache key is invalid.");
                }
                const validIdentities = identities as {
                    readonly payloadRef: string;
                    readonly sessionId: string;
                }[];
                const sessionId = validIdentities[0]?.sessionId;
                const loadIndividually = async () => {
                    return new Map(
                        await Promise.all(keys.map(async (key) => {
                            const identity = parseTranscriptPayloadCacheKey(key)!;
                            const payload = await getComandoApi().getAiTranscriptPayload(identity);
                            if (!payload) throw new Error("The transcript payload could not be found.");
                            return [key, payload] as const;
                        })),
                    );
                };
                const loadBatch = getComandoApi().getAiTranscriptPayloads;
                if (
                    !sessionId ||
                    validIdentities.some((identity) => identity.sessionId !== sessionId) ||
                    typeof loadBatch !== "function"
                ) {
                    return loadIndividually();
                }
                incrementChatPerformanceCounter("transcript_payload_ipc_count");
                const output = await loadBatch({
                    payloadRefs: validIdentities.map((identity) => identity.payloadRef),
                    sessionId,
                });
                if (!output) {
                    throw new Error("The transcript payload batch could not be found.");
                }
                const payloads = new Map<string, AiTranscriptPayload>();
                for (const payload of output.payloads) {
                    incrementChatPerformanceCounter("transcript_payload_bytes", payload.byteLength);
                    payloads.set(transcriptPayloadCacheKey(sessionId, payload.payloadRef), payload);
                }
                return payloads;
            },
        },
        TRANSCRIPT_PAYLOAD_CACHE_MAX_BYTES,
        (payload) => payload.byteLength,
    );
}

function transcriptPayloadCacheKey(sessionId: string, payloadRef: string): string {
    return JSON.stringify([sessionId, payloadRef]);
}

function parseTranscriptPayloadCacheKey(
    key: string,
): { readonly payloadRef: string; readonly sessionId: string } | null {
    try {
        const value: unknown = JSON.parse(key);
        return Array.isArray(value) &&
                value.length === 2 &&
                typeof value[0] === "string" &&
                typeof value[1] === "string"
            ? { payloadRef: value[1], sessionId: value[0] }
            : null;
    } catch {
        return null;
    }
}

function takeEvictedTranscriptPayloadRefs(): ReadonlyMap<
    string,
    readonly string[]
> {
    const refsBySession = new Map<string, string[]>();
    for (const key of transcriptPayloadCache.takeEvictedPayloadRefs()) {
        const identity = parseTranscriptPayloadCacheKey(key);
        if (!identity) continue;
        const refs = refsBySession.get(identity.sessionId) ?? [];
        refs.push(identity.payloadRef);
        refsBySession.set(identity.sessionId, refs);
    }
    return refsBySession;
}

function retainResidentTranscriptPayloads(
    sessionId: string,
    blocksById: ReadonlyMap<string, AiTranscriptBlock>,
    payloadsByRef: ReadonlyMap<string, AiTranscriptPayload>,
): ReadonlyMap<string, AiTranscriptPayload> {
    const residentPayloadRefs = new Set(
        [...blocksById.values()].flatMap((block) =>
            block.entries.flatMap((entry) =>
                entry.payloadRef ? [entry.payloadRef] : [],
            ),
        ),
    );
    const retained = new Map<string, AiTranscriptPayload>();
    for (const [payloadRef, payload] of payloadsByRef) {
        if (residentPayloadRefs.has(payloadRef)) {
            retained.set(payloadRef, payload);
        } else {
            transcriptPayloadCache.release(
                transcriptPayloadCacheKey(sessionId, payloadRef),
            );
        }
    }
    return retained;
}

export const useAiStore = create<AiStore>((set, get) => ({
    claudeSettings: createEmptyClaudeSettings(),
    codexBinaryPath: "",
    codexSettings: createEmptyCodexSettings(),
    grokSettings: createEmptyGrokSettings(),
    kiloSettings: createEmptyKiloSettings(),
    opencodeSettings: createEmptyOpenCodeSettings(),
    runtimeCatalogById: {},
    runtimeStatusById: {},
    sessions: {},

    hydrateReviewDeltas: async (sessionId) => {
        const snapshot = get().sessions[sessionId]?.snapshot;
        // A provisional delta has no materialized detail yet. Waiting for its
        // terminal update avoids reporting a predictable load failure.
        const deltas = (snapshot?.reviewDeltas ?? []).filter(
            (delta) => delta.state !== "preparing",
        );
        await Promise.all(
            deltas.map(async (delta) => {
                const key = `${sessionId}\0${delta.deltaId}\0${delta.revision}`;
                const existing = reviewDeltaHydrations.get(key);
                if (existing) {
                    await existing;
                    return;
                }
                const hydration = getComandoApi()
                    .loadAiReviewDelta({
                        expectedRevision: delta.revision,
                        reviewDeltaId: delta.deltaId,
                        sessionId,
                    })
                    .then((details) => {
                        if (!details) {
                            return;
                        }
                        set((state) =>
                            applyHydratedReviewDelta(
                                state,
                                sessionId,
                                details.delta,
                                details.trackedFiles,
                            ),
                        );
                    })
                    .catch((error) => {
                        console.warn(
                            "[comando] Failed to hydrate an AI review delta.",
                            error,
                        );
                    })
                    .finally(() => {
                        reviewDeltaHydrations.delete(key);
                        void getComandoApi()
                            .releaseAiReviewDelta(delta.deltaId)
                            .catch((error) => {
                                console.warn(
                                    "[comando] Failed to release an AI review delta.",
                                    error,
                                );
                            });
                    });
                reviewDeltaHydrations.set(key, hydration);
                await hydration;
            }),
        );
    },

    hydrateToolActivityDetail: async (sessionId, activityId) => {
        const snapshot = get().sessions[sessionId]?.snapshot;
        const activity = snapshot?.toolActivity.find(
            (candidate) => candidate.id === activityId,
        );
        if (
            !snapshot ||
            !activity?.toolActivityDetailId ||
            (activity.status !== "completed" && activity.status !== "failed") ||
            hasToolActivityDetail(activity)
        ) {
            return;
        }
        const key = `${sessionId}\0${activity.toolActivityDetailId}`;
        const existing = toolActivityDetailHydrations.get(key);
        if (existing) {
            await existing;
            return;
        }
        const hydration = getComandoApi()
            .loadAiToolActivityDetail({
                sessionId,
                toolActivityDetailId: activity.toolActivityDetailId,
            })
            .then((detail) => {
                if (!detail) {
                    return;
                }
                set((state) =>
                    applyHydratedToolActivityDetail(
                        state,
                        sessionId,
                        activityId,
                        detail,
                    ),
                );
            })
            .catch((error) => {
                console.warn(
                    "[comando] Failed to hydrate AI tool activity detail.",
                    error,
                );
            })
            .finally(() => {
                toolActivityDetailHydrations.delete(key);
            });
        toolActivityDetailHydrations.set(key, hydration);
        await hydration;
    },

    clearDraftAttachments: (sessionId) => {
        set((state) => ({
            sessions: {
                ...state.sessions,
                [sessionId]: {
                    ...(state.sessions[sessionId] ?? createSessionState()),
                    draftAttachments: [],
                },
            },
        }));
    },

    attachSelectionMention: (sessionId, selection) => {
        set((state) => {
            const session = state.sessions[sessionId] ?? createSessionState();
            const exists = session.draftComposerParts.some(
                (part) =>
                    part.type === "selection_mention" &&
                    part.path === selection.path &&
                    part.startLine === selection.startLine &&
                    part.endLine === selection.endLine,
            );
            if (exists) {
                return state;
            }

            return {
                sessions: {
                    ...state.sessions,
                    [sessionId]: {
                        ...session,
                        draftComposerParts: appendSelectionMentionDraftPart(
                            session.draftComposerParts,
                            selection,
                        ),
                    },
                },
            };
        });
    },

    cancelQueuedPromptEdit: (sessionId) => {
        let restoredComposerParts: readonly AiComposerDraftPart[] | null = null;

        set((state) => {
            const session = state.sessions[sessionId];
            if (
                !session?.editingQueuedPrompt ||
                !session.editingQueuedPromptState
            ) {
                return state;
            }

            restoredComposerParts = cloneComposerDraftParts(
                session.editingQueuedPromptState.previousComposerParts,
            );

            return {
                sessions: {
                    ...state.sessions,
                    [sessionId]: {
                        ...session,
                        draftAttachments: cloneDraftAttachments(
                            session.editingQueuedPromptState
                                .previousDraftAttachments,
                        ),
                        draftComposerParts: restoredComposerParts,
                        draftFileContexts: cloneDraftFileContexts(
                            session.editingQueuedPromptState
                                .previousDraftFileContexts,
                        ),
                        editingQueuedPromptState: null,
                        editingQueuedPrompt: null,
                        queue: insertQueuedPromptAtEditPosition(
                            session.queue,
                            session.editingQueuedPrompt,
                            session.editingQueuedPromptState,
                        ),
                    },
                },
            };
        });

        void getComandoApi()
            .cancelEditAiQueuedPrompt(sessionId)
            .then((snapshot) => get().applyPromptQueueSnapshot(snapshot));

        return restoredComposerParts;
    },

    addDraftFileContext: (sessionId, context) => {
        set((state) => {
            const session = state.sessions[sessionId] ?? createSessionState();
            const exists = session.draftFileContexts.some(
                (fc) =>
                    fc.projectId === context.projectId &&
                    fc.relativePath === context.relativePath &&
                    (fc.startLine ?? null) === (context.startLine ?? null) &&
                    (fc.endLine ?? null) === (context.endLine ?? null),
            );
            if (exists) return state;
            return {
                sessions: {
                    ...state.sessions,
                    [sessionId]: {
                        ...session,
                        draftFileContexts: [
                            ...session.draftFileContexts,
                            context,
                        ],
                    },
                },
            };
        });
    },

    removeDraftFileContext: (sessionId, contextId) => {
        set((state) => {
            const session = state.sessions[sessionId] ?? createSessionState();
            return {
                sessions: {
                    ...state.sessions,
                    [sessionId]: {
                        ...session,
                        draftFileContexts: session.draftFileContexts.filter(
                            (fc) => fc.id !== contextId,
                        ),
                    },
                },
            };
        });
    },

    clearDraftFileContexts: (sessionId) => {
        set((state) => ({
            sessions: {
                ...state.sessions,
                [sessionId]: {
                    ...(state.sessions[sessionId] ?? createSessionState()),
                    draftFileContexts: [],
                },
            },
        }));
    },

    clearQueuedPrompts: (sessionId) => {
        set((state) => {
            const session = state.sessions[sessionId];
            if (!session) {
                return state;
            }

            return {
                sessions: {
                    ...state.sessions,
                    [sessionId]: {
                        ...session,
                        editingQueuedPromptState: null,
                        editingQueuedPrompt: null,
                        queue: [],
                        queuePaused: false,
                    },
                },
            };
        });
        void getComandoApi()
            .clearAiPromptQueue(sessionId)
            .then((snapshot) => get().applyPromptQueueSnapshot(snapshot));
    },

    applyRuntimeStatus: (status) => {
        const runtimeCatalog = extractRuntimeCatalogFromStatus(status);
        set((state) => ({
            runtimeCatalogById:
                runtimeCatalog && hasRuntimeCatalog(runtimeCatalog)
                    ? {
                          ...state.runtimeCatalogById,
                          [status.runtimeId]: runtimeCatalog,
                      }
                    : state.runtimeCatalogById,
            runtimeStatusById: {
                ...state.runtimeStatusById,
                [status.runtimeId]: status,
            },
        }));
    },

    applyPromptQueueSnapshot: (queueSnapshot) => {
        set((state) => {
            const session =
                state.sessions[queueSnapshot.sessionId] ?? createSessionState();
            if (queueSnapshot.revision < session.queueRevision) {
                return state;
            }

            const activeQueuedPrompt = queueSnapshot.activeItem
                ? toRendererQueuedPrompt(queueSnapshot.activeItem)
                : null;
            const currentActiveId =
                session.activeQueuedPrompt?.queuedPrompt.id ?? null;
            const nextActiveState = activeQueuedPrompt
                ? {
                      activatedAfterIncomingSnapshotVersion:
                          session.incomingSnapshotVersion,
                      position: {
                          nextPromptId: null,
                          previousPromptId: null,
                          queueIndex: 0,
                      },
                      queuedPrompt: activeQueuedPrompt,
                  }
                : null;
            const nextSession = {
                ...session,
                activeDispatchToken: null,
                activeQueuedPrompt: nextActiveState,
                editingQueuedPrompt: queueSnapshot.editingItem
                    ? toRendererQueuedPrompt(queueSnapshot.editingItem)
                    : null,
                editingQueuedPromptState: queueSnapshot.editingItem
                    ? session.editingQueuedPromptState
                    : null,
                isDispatching: queueSnapshot.activeItem?.status === "sending",
                queue: queueSnapshot.items.map(toRendererQueuedPrompt),
                queuePaused: queueSnapshot.paused,
                queueRevision: queueSnapshot.revision,
            };
            const acceptedSession =
                activeQueuedPrompt && currentActiveId !== activeQueuedPrompt.id
                    ? applyLocalPromptAcceptanceToSession(
                          nextSession,
                          activeQueuedPrompt,
                      )
                    : nextSession;

            return {
                sessions: {
                    ...state.sessions,
                    [queueSnapshot.sessionId]: acceptedSession,
                },
            };
        });
    },

    applySessionEvent: (event) => {
        const sessionBeforeEvent = get().sessions[event.sessionId] ?? null;
        const activePromptMessageAlias = getActivePromptMessageAlias(
            event,
            sessionBeforeEvent,
        );
        const normalizedEvent = normalizeIncomingActivePromptEvent(
            event,
            sessionBeforeEvent,
            activePromptMessageAlias,
        );
        if (
            !isFlushingBufferedSessionDeltas &&
            isSessionDeltaEvent(normalizedEvent)
        ) {
            bufferSessionDeltaEvent(normalizedEvent, get);
            return;
        }
        if (!isSessionDeltaEvent(normalizedEvent)) {
            flushBufferedSessionDeltas(get, normalizedEvent.sessionId);
        }

        let syncedTitle: string | null = null;
        measureChatPerformance(
            "apply_event_ms",
            {
                sessionId: normalizedEvent.sessionId,
                values: {
                    payloadDepth:
                        bufferedSessionDeltasBySessionId.get(
                            normalizedEvent.sessionId,
                        )?.events.size ?? 0,
                },
            },
            () =>
                set((state) => {
            const session =
                state.sessions[normalizedEvent.sessionId] ?? createSessionState();
            const existingCatalog =
                state.runtimeCatalogById[normalizedEvent.runtimeId] ?? null;
            const baseSnapshot =
                session.snapshot ??
                createSessionSnapshotFromEvent(normalizedEvent, existingCatalog);
            const nextTranscript = measureChatPerformance(
                "transcript_patch_ms",
                { sessionId: normalizedEvent.sessionId },
                () =>
                    applyAiSessionDomainEventToTranscript(
                        getSessionTranscript(session, baseSnapshot),
                        normalizedEvent,
                    ),
            );
            const nextSnapshot = writeAiSessionTranscriptToSnapshot(
                applySessionDomainEventToSnapshot(baseSnapshot, normalizedEvent),
                nextTranscript,
            );
            const nextMeta = session.meta
                ? session.meta.title === nextSnapshot.title
                    ? session.meta
                    : { ...session.meta, title: nextSnapshot.title }
                : createSessionMetaFromSnapshot(nextSnapshot);
            if (nextMeta !== session.meta) {
                syncedTitle = nextSnapshot.title;
            }

            return {
                sessions: {
                    ...state.sessions,
                    [normalizedEvent.sessionId]: {
                        ...session,
                        activePromptMessageAliases:
                            getNextActivePromptMessageAliases(
                                session,
                                event,
                                activePromptMessageAlias,
                            ),
                        ...resolveIncomingSnapshotProgress(
                            session,
                            nextSnapshot.updatedAt,
                        ),
                        localError: nextSnapshot.lastError,
                        meta: nextMeta,
                        runtimeState: "live",
                        snapshot: nextSnapshot,
                        transcript: nextTranscript,
                    },
                },
            };
                }),
        );

        const eventUpdatedAt = Date.parse(normalizedEvent.updatedAt);
        if (Number.isFinite(eventUpdatedAt)) {
            recordChatPerformanceMetric("ack_lag_ms", {
                durationMs: Math.max(0, Date.now() - eventUpdatedAt),
                sessionId: normalizedEvent.sessionId,
            });
        }

        if (syncedTitle !== null) {
            void useWorkspaceStore
                .getState()
                .updateSessionTabTitles(normalizedEvent.sessionId, syncedTitle);
        }

        scheduleAiSessionResyncWatchdog(normalizedEvent.sessionId, get);
    },

    applySessionUpdate: (update) => {
        const sessionId =
            update.kind === "snapshot"
                ? update.snapshot.sessionId
                : update.patch.sessionId;
        flushBufferedSessionDeltas(get, sessionId);
        if (update.kind === "snapshot") {
            get().applySessionSnapshot(update.snapshot);
            return;
        }

        let syncedTitle: string | null = null;
        set((state) => {
            const patchChangedKeys = new Set(
                Object.keys(update.patch.changes) as Array<
                    keyof AiSessionPatch["changes"]
                >,
            );
            const session =
                state.sessions[update.patch.sessionId] ?? createSessionState();
            const baseSnapshot =
                session.snapshot ??
                (session.meta
                    ? createEmptySessionSnapshot(
                          {
                              createdAt: new Date().toISOString(),
                              draft: "",
                              id: update.patch.sessionId,
                              kind: "chat",
                              projectId: session.meta.projectId,
                              runtimeId: session.meta.runtimeId,
                              sessionId: update.patch.sessionId,
                              title: session.meta.title,
                              worktreeId: session.meta.worktreeId,
                          },
                          state.runtimeCatalogById[update.patch.runtimeId] ??
                              null,
                      )
                    : null);
            const existingCatalog =
                state.runtimeCatalogById[update.patch.runtimeId] ?? null;
            const nextCatalog = hasCatalogChanges(update.patch.changes)
                ? applyCatalogPatchToCatalog(
                      existingCatalog ?? EMPTY_RUNTIME_CATALOG,
                      update.patch.changes,
                  )
                : null;

            if (!baseSnapshot) {
                const orphanBaseSnapshot = createSessionSnapshotFromPatch(
                    update.patch,
                    nextCatalog ?? existingCatalog,
                );
                if (orphanBaseSnapshot) {
                    const incomingSnapshot = applySessionPatch(
                        orphanBaseSnapshot,
                        update.patch,
                    );
                    const resolved = resolveIncomingSessionSnapshot(
                        incomingSnapshot,
                        session,
                        {
                            changedKeys: patchChangedKeys,
                        },
                    );
                    const nextSnapshot = resolved.snapshot;
                    const nextTranscript = resolved.transcript;
                    const nextMeta = createSessionMetaFromSnapshot(nextSnapshot);
                    syncedTitle = nextSnapshot.title;

                    return {
                        runtimeCatalogById:
                            nextCatalog && hasRuntimeCatalog(nextCatalog)
                                ? {
                                      ...state.runtimeCatalogById,
                                      [update.patch.runtimeId]: nextCatalog,
                                  }
                                : state.runtimeCatalogById,
                        sessions: {
                            ...state.sessions,
                            [update.patch.sessionId]: {
                                ...session,
                                ...resolveIncomingSnapshotProgress(
                                    session,
                                    incomingSnapshot.updatedAt,
                                ),
                                localError: nextSnapshot.lastError,
                                meta: nextMeta,
                                runtimeState: "live",
                                snapshot: nextSnapshot,
                                transcript: nextTranscript,
                            },
                        },
                    };
                }

                if (!nextCatalog || !hasRuntimeCatalog(nextCatalog)) {
                    return state;
                }

                return {
                    runtimeCatalogById: {
                        ...state.runtimeCatalogById,
                        [update.patch.runtimeId]: nextCatalog,
                    },
                };
            }

            const snapshotForPatch =
                existingCatalog && hasRuntimeCatalog(existingCatalog)
                    ? mergeRuntimeCatalogIntoSnapshot(
                          baseSnapshot,
                          existingCatalog,
                      )
                    : baseSnapshot;
            const incomingSnapshot = applySessionPatch(
                snapshotForPatch,
                update.patch,
            );
            const resolved = resolveIncomingSessionSnapshot(
                incomingSnapshot,
                session,
                {
                    changedKeys: patchChangedKeys,
                },
            );
            const nextSnapshot = resolved.snapshot;
            const nextTranscript = resolved.transcript;
            const resolvedCatalog = nextCatalog;
            const nextMeta = session.meta
                ? session.meta.title === nextSnapshot.title
                    ? session.meta
                    : { ...session.meta, title: nextSnapshot.title }
                : session.meta;
            if (nextMeta !== session.meta) {
                syncedTitle = nextSnapshot.title;
            }

            return {
                runtimeCatalogById:
                    resolvedCatalog && hasRuntimeCatalog(resolvedCatalog)
                        ? {
                              ...state.runtimeCatalogById,
                              [update.patch.runtimeId]: resolvedCatalog,
                          }
                        : state.runtimeCatalogById,
                sessions: {
                    ...state.sessions,
                    [update.patch.sessionId]: {
                        ...session,
                        ...resolveIncomingSnapshotProgress(
                            session,
                            incomingSnapshot.updatedAt,
                        ),
                        localError: nextSnapshot.lastError,
                        meta: nextMeta,
                        runtimeState: "live",
                        snapshot: nextSnapshot,
                        transcript: nextTranscript,
                    },
                },
            };
        });

        if (syncedTitle !== null) {
            void useWorkspaceStore
                .getState()
                .updateSessionTabTitles(update.patch.sessionId, syncedTitle);
        }

        scheduleAiSessionResyncWatchdog(update.patch.sessionId, get);
    },

    applySessionSnapshot: (snapshot) => {
        flushBufferedSessionDeltas(get, snapshot.sessionId);
        let syncedTitle: string | null = null;
        let shouldRefreshSealedTranscript = false;
        set((state) => {
            const session =
                state.sessions[snapshot.sessionId] ?? createSessionState();
            const existingCatalog =
                state.runtimeCatalogById[snapshot.runtimeId] ?? null;
            const incomingSnapshot =
                existingCatalog && hasRuntimeCatalog(existingCatalog)
                    ? mergeRuntimeCatalogIntoSnapshot(
                          snapshot,
                          existingCatalog,
                      )
                    : snapshot;
            shouldRefreshSealedTranscript =
                shouldRefreshSealedTranscript ||
                hasPendingTranscriptBlockHandoff(incomingSnapshot, session);
            const resolved = resolveIncomingSessionSnapshot(
                incomingSnapshot,
                session,
                {
                    preserveCurrentReviewState: true,
                },
            );
            const resolvedSnapshot = resolved.snapshot;
            const resolvedTranscript = resolved.transcript;
            const nextMeta = session.meta
                ? session.meta.title === resolvedSnapshot.title
                    ? session.meta
                    : { ...session.meta, title: resolvedSnapshot.title }
                : session.meta;
            if (nextMeta !== session.meta) {
                syncedTitle = resolvedSnapshot.title;
            }
            shouldRefreshSealedTranscript =
                shouldRefreshSealedTranscript ||
                (snapshot.status === "idle" &&
                    snapshot.messages.length === 0 &&
                    session.transcriptWindow.capabilityVersion !== null);
            // Runtime defaults must come from provider state, never from the
            // optimistic session overlay applied by the resolver.
            const nextCatalog = extractRuntimeCatalog(incomingSnapshot);

            return {
                runtimeCatalogById: hasRuntimeCatalog(nextCatalog)
                    ? {
                          ...state.runtimeCatalogById,
                          [snapshot.runtimeId]: nextCatalog,
                      }
                    : state.runtimeCatalogById,
                sessions: {
                    ...state.sessions,
                    [snapshot.sessionId]: {
                        ...session,
                        ...resolveIncomingSnapshotProgress(
                            session,
                            incomingSnapshot.updatedAt,
                        ),
                        localError: resolvedSnapshot.lastError,
                        meta: nextMeta,
                        runtimeState: "live",
                        snapshot: resolvedSnapshot,
                        transcript: resolvedTranscript,
                    },
                },
            };
        });

        if (syncedTitle !== null) {
            void useWorkspaceStore
                .getState()
                .updateSessionTabTitles(snapshot.sessionId, syncedTitle);
        }
        if (shouldRefreshSealedTranscript) {
            void get().hydrateTranscriptWindow(snapshot.sessionId);
        }

        scheduleAiSessionResyncWatchdog(snapshot.sessionId, get);
    },

    cancelSession: async (sessionId) => {
        // Pause the queue synchronously before hitting IPC so the idle
        // snapshot that follows the cancel cannot race a drain and ship the
        // next queued prompt. Pausing with an empty queue is fine — pause
        // only matters while there is something to hold back.
        pauseQueue(sessionId, set);
        await getComandoApi().cancelAiSession(sessionId);
    },

    dismissSessionPlan: (sessionId, planUpdatedAt) => {
        set((state) => {
            const session = state.sessions[sessionId];
            if (!session) {
                return state;
            }

            return {
                sessions: {
                    ...state.sessions,
                    [sessionId]: {
                        ...session,
                        dismissedPlanUpdatedAt: planUpdatedAt,
                    },
                },
            };
        });
    },

    ensureSession: async (tab, options) => {
        const currentSession = get().sessions[tab.sessionId] ?? null;
        const shouldHydratePassively =
            !options?.force &&
            getSessionRuntimeStateForTab(tab) === "history";

        if (shouldHydratePassively) {
            // A registered tab receives an empty snapshot placeholder. Only a
            // completed history read may suppress a later hydration.
            if (
                currentSession?.runtimeState === "live" ||
                currentSession?.historyHydrationState === "loaded"
            ) {
                return;
            }
        } else if (
            !options?.force &&
            currentSession?.runtimeState === "live" &&
            currentSession.snapshot?.runtimeSessionId
        ) {
            return;
        }

        const requestKey = `${tab.sessionId}:${shouldHydratePassively ? "history" : "live"}`;
        const existingRequest = ensureSessionInFlight.get(requestKey);
        if (existingRequest) {
            await existingRequest;
            return;
        }

        const request = shouldHydratePassively
            ? executePassiveSessionHydration(tab, get, set)
            : executeSessionPrepare(tab, get, set);
        ensureSessionInFlight.set(requestKey, request);

        try {
            await request;
            void get().hydrateTranscriptWindow(tab.sessionId);
        } finally {
            if (ensureSessionInFlight.get(requestKey) === request) {
                ensureSessionInFlight.delete(requestKey);
            }
        }
    },

    hydrateSettings: (settings) => {
        set({
            claudeSettings: settings?.claude ?? createEmptyClaudeSettings(),
            codexBinaryPath: settings?.codex.binaryPath ?? "",
            codexSettings: settings?.codex ?? createEmptyCodexSettings(),
            grokSettings: settings?.grok ?? createEmptyGrokSettings(),
            kiloSettings: settings?.kilo ?? createEmptyKiloSettings(),
            opencodeSettings:
                settings?.opencode ?? createEmptyOpenCodeSettings(),
        });
    },

    hydrateTranscriptWindow: async (sessionId) => {
        const existing = transcriptWindowHydrations.get(sessionId);
        if (existing) {
            // A seal can finish while an older metadata read is in flight.
            // Queue one trailing read so the renderer observes that revision.
            transcriptWindowRefreshRequests.add(sessionId);
            return await existing;
        }

        const request = (async () => {
            const api = getComandoApi();
            const capability = await api.getAiTranscriptCapability();
            if (!capability.blockNativeVersion) {
                return;
            }

            // Keep the capability after a transient unavailable metadata read.
            // A later sealed snapshot will then retry hydration once native
            // storage finishes its migration.
            set((state) => updateTranscriptWindowState(state, sessionId, {
                ...state.sessions[sessionId]?.transcriptWindow,
                capabilityVersion: capability.blockNativeVersion,
                error: null,
                isLoading: true,
            }));

            const metadata = await api.getAiTranscriptBlockMetadata(sessionId);
            if (!metadata) {
                set((state) => updateTranscriptWindowState(state, sessionId, {
                    ...state.sessions[sessionId]?.transcriptWindow,
                    isLoading: false,
                }));
                return;
            }

            let hydrationView = resolveTranscriptHydrationView(
                get().sessions[sessionId]?.transcriptWindow,
                metadata.blocks,
            );
            transcriptWindowStore.setMetadata(sessionId, metadata.blocks);
            transcriptWindowStore.protect(
                sessionId,
                hydrationView.protectedBlockIds,
            );
            const evictedSessionIds = transcriptWindowStore.takeEvictedSessionIds();
            if (evictedSessionIds.length > 0) {
                set((state) => ({
                    sessions: synchronizeEvictedTranscriptWindowSessions(
                        state.sessions,
                        evictedSessionIds,
                    ),
                }));
            }
            await Promise.all(
                hydrationView.loadBlockIds.map((blockId) =>
                    get().loadTranscriptWindowBlock(sessionId, blockId),
                ),
            );
            // Scrolling can change the anchor while blocks are loading. Apply
            // the freshest view state before eviction and projection.
            hydrationView = resolveTranscriptHydrationView(
                get().sessions[sessionId]?.transcriptWindow,
                metadata.blocks,
            );
            transcriptWindowStore.protect(
                sessionId,
                hydrationView.protectedBlockIds,
            );
            const finalEvictedSessionIds =
                transcriptWindowStore.takeEvictedSessionIds();
            if (finalEvictedSessionIds.length > 0) {
                set((state) => ({
                    sessions: synchronizeEvictedTranscriptWindowSessions(
                        state.sessions,
                        finalEvictedSessionIds,
                    ),
                }));
            }
            const windowSnapshot = transcriptWindowStore.snapshot(sessionId);
            set((state) => {
                const currentSession = state.sessions[sessionId];
                if (!currentSession) return state;
                const current = currentSession.transcriptWindow;
                const next = transcriptWindowStateFromSnapshot(
                    windowSnapshot,
                    metadata.capabilityVersion,
                    metadata.transcriptRevision,
                    hydrationView.protectedBlockIds,
                    hydrationView.anchorBlockId,
                    hydrationView.followTail,
                );
                const transcriptWindow = {
                    ...next,
                    payloadsByRef: retainResidentTranscriptPayloads(
                        sessionId,
                        windowSnapshot.blocksById,
                        current.payloadsByRef,
                    ),
                };
                const transcript = removeAiSessionTranscriptEntries(
                    currentSession.transcript,
                    collectSealedTranscriptEntryIds(
                        windowSnapshot.blocksById,
                    ),
                );
                const sessions = {
                    ...state.sessions,
                    [sessionId]: {
                        ...currentSession,
                        snapshot: currentSession.snapshot
                            ? writeAiSessionTranscriptToSnapshot(
                                  currentSession.snapshot,
                                  transcript,
                              )
                            : null,
                        transcript,
                        transcriptWindow,
                    },
                };
                return {
                    sessions: removeEvictedTranscriptPayloads(
                        sessions,
                        takeEvictedTranscriptPayloadRefs(),
                    ),
                };
            });
        })().catch((error: unknown) => {
            set((state) => updateTranscriptWindowState(state, sessionId, {
                ...state.sessions[sessionId]?.transcriptWindow,
                error: error instanceof Error ? error.message : "Could not load transcript blocks.",
                isLoading: false,
            }));
        }).finally(() => {
            transcriptWindowHydrations.delete(sessionId);
            if (transcriptWindowRefreshRequests.delete(sessionId)) {
                void get().hydrateTranscriptWindow(sessionId);
            }
        });
        transcriptWindowHydrations.set(sessionId, request);
        await request;
    },

    loadTranscriptWindowBlock: async (sessionId, blockId) => {
        const block = await transcriptWindowStore.load(sessionId, blockId);
        let hydratedPayloads: ReadonlyMap<string, AiTranscriptPayload> = new Map();
        if (block) {
            // A sealed turn replaces the live tail with this visible block.
            // Hydrate its tool payloads too so review diffs remain inspectable
            // across that handoff and after reopening the chat.
            const visiblePayloadRefs = new Set(
                block.entries.flatMap((entry) =>
                    entry.payloadRef &&
                    (entry.kind === "message" ||
                        entry.kind === "thinking" ||
                        entry.kind === "tool")
                        ? [entry.payloadRef]
                        : [],
                ),
            );
            hydratedPayloads = await measureChatPerformanceAsync(
                "transcript_payload_batch_ms",
                {
                    sessionId,
                    values: { payloadRefs: visiblePayloadRefs.size },
                },
                () =>
                    get().loadTranscriptPayloads(
                        sessionId,
                        [...visiblePayloadRefs],
                        { protect: false, publish: false },
                    ),
            );
        }
        const current = get().sessions[sessionId]?.transcriptWindow;
        if (!current) return block;
        const windowSnapshot = transcriptWindowStore.snapshot(sessionId);
        const evictedSessionIds = transcriptWindowStore.takeEvictedSessionIds();
        set((state) => {
            const sessions = synchronizeEvictedTranscriptWindowSessions(
                state.sessions,
                evictedSessionIds,
            );
            const latest = sessions[sessionId]?.transcriptWindow;
            if (!latest || !sessions[sessionId]) {
                return sessions === state.sessions ? state : { sessions };
            }
            const next = transcriptWindowStateFromSnapshot(
                windowSnapshot,
                latest.capabilityVersion,
                latest.transcriptRevision,
                latest.protectedBlockIds,
                latest.anchorBlockId,
                latest.followTail,
            );
            const nextSessions = {
                ...sessions,
                [sessionId]: {
                    ...sessions[sessionId],
                    transcriptWindow: {
                        ...next,
                        payloadsByRef: retainResidentTranscriptPayloads(
                            sessionId,
                            windowSnapshot.blocksById,
                            new Map([
                                ...latest.payloadsByRef,
                                ...hydratedPayloads,
                            ]),
                        ),
                    },
                },
            };
            return {
                sessions: removeEvictedTranscriptPayloads(
                    nextSessions,
                    takeEvictedTranscriptPayloadRefs(),
                ),
            };
        });
        return block;
    },

    loadTranscriptPayloads: async (sessionId, payloadRefs, options = {}) => {
        const refs = [...new Set(payloadRefs)];
        if (refs.length === 0) return new Map();
        try {
            const result = new Map<string, AiTranscriptPayload>();
            for (
                let start = 0;
                start < refs.length;
                start += TRANSCRIPT_PAYLOAD_BATCH_MAX_REFS
            ) {
                const batchRefs = refs.slice(
                    start,
                    start + TRANSCRIPT_PAYLOAD_BATCH_MAX_REFS,
                );
                const payloads = await transcriptPayloadCache.loadMany(
                    batchRefs.map((payloadRef) =>
                        transcriptPayloadCacheKey(sessionId, payloadRef),
                    ),
                    { protect: options.protect ?? true },
                );
                for (const payloadRef of batchRefs) {
                    const cacheKey = transcriptPayloadCacheKey(
                        sessionId,
                        payloadRef,
                    );
                    const payload = payloads.get(cacheKey);
                    if (payload && transcriptPayloadCache.has(cacheKey)) {
                        result.set(payloadRef, payload);
                    }
                }
            }
            const evictedPayloadRefsBySession =
                takeEvictedTranscriptPayloadRefs();
            if (options.publish !== false) set((state) => {
                const sessions = removeEvictedTranscriptPayloads(state.sessions, evictedPayloadRefsBySession);
                const current = sessions[sessionId]?.transcriptWindow;
                if (!current) return sessions === state.sessions ? state : { sessions };
                const payloadsByRef = new Map(current.payloadsByRef);
                for (const payloadRef of refs) {
                    const payload = result.get(payloadRef);
                    if (payload) payloadsByRef.set(payloadRef, payload);
                    else payloadsByRef.delete(payloadRef);
                }
                return {
                    sessions: {
                        ...sessions,
                        [sessionId]: {
                            ...sessions[sessionId],
                            transcriptWindow: { ...current, payloadsByRef },
                        },
                    },
                };
            });
            return result;
        } catch {
            return new Map();
        }
    },

    loadTranscriptPayload: async (sessionId, payloadRef, options) => {
        const payloads = await get().loadTranscriptPayloads(
            sessionId,
            [payloadRef],
            options,
        );
        return payloads.get(payloadRef) ?? null;
    },

    releaseTranscriptPayload: (sessionId, payloadRef) => {
        transcriptPayloadCache.release(
            transcriptPayloadCacheKey(sessionId, payloadRef),
        );
        const evictedPayloadRefsBySession =
            takeEvictedTranscriptPayloadRefs();
        set((state) => {
            const sessions = removeEvictedTranscriptPayloads(
                state.sessions,
                evictedPayloadRefsBySession,
            );
            const current = sessions[sessionId]?.transcriptWindow;
            if (!current) {
                return sessions === state.sessions ? state : { sessions };
            }

            // Releasing makes the payload evictable; it must remain projected
            // until the cache actually evicts it, otherwise collapsing a rail
            // erases its diff before the user can expand it again.
            return {
                sessions: {
                    ...sessions,
                    [sessionId]: {
                        ...sessions[sessionId],
                        transcriptWindow: {
                            ...current,
                        },
                    },
                },
            };
        });
    },

    prefetchTranscriptWindow: async (sessionId, direction) => {
        const windowState = get().sessions[sessionId]?.transcriptWindow;
        if (!windowState?.capabilityVersion) return;
        const targetBlockId = resolveTranscriptPrefetchBlockId(
            windowState.metadata.map((block) => block.blockId),
            new Set(windowState.blocksById.keys()),
            direction,
        );
        if (!targetBlockId) return;
        await get().loadTranscriptWindowBlock(sessionId, targetBlockId);
    },

    setTranscriptWindowAnchor: (sessionId, anchorBlockId, followTail) => {
        const session = get().sessions[sessionId];
        if (!session) return;
        const protectedBlockIds = new Set<string>();
        if (followTail) {
            for (const block of session.transcriptWindow.metadata.slice(-2)) {
                protectedBlockIds.add(block.blockId);
            }
        }
        if (anchorBlockId) protectedBlockIds.add(anchorBlockId);
        if (
            session.transcriptWindow.anchorBlockId === anchorBlockId &&
            session.transcriptWindow.followTail === followTail &&
            session.transcriptWindow.protectedBlockIds.size ===
                protectedBlockIds.size &&
            [...protectedBlockIds].every((blockId) =>
                session.transcriptWindow.protectedBlockIds.has(blockId),
            )
        ) {
            return;
        }
        transcriptWindowStore.protect(sessionId, protectedBlockIds);
        const windowSnapshot = transcriptWindowStore.snapshot(sessionId);
        const evictedSessionIds = transcriptWindowStore.takeEvictedSessionIds();
        set((state) => {
            const sessions = synchronizeEvictedTranscriptWindowSessions(
                state.sessions,
                evictedSessionIds,
            );
            const current = sessions[sessionId]?.transcriptWindow;
            if (!current || !sessions[sessionId]) {
                return sessions === state.sessions ? state : { sessions };
            }
            const next = transcriptWindowStateFromSnapshot(
                windowSnapshot,
                session.transcriptWindow.capabilityVersion,
                session.transcriptWindow.transcriptRevision,
                protectedBlockIds,
                anchorBlockId,
                followTail,
            );
            const nextSessions = {
                ...sessions,
                [sessionId]: {
                    ...sessions[sessionId],
                    transcriptWindow: {
                        ...next,
                        payloadsByRef: retainResidentTranscriptPayloads(
                            sessionId,
                            windowSnapshot.blocksById,
                            current.payloadsByRef,
                        ),
                    },
                },
            };
            return {
                sessions: removeEvictedTranscriptPayloads(
                    nextSessions,
                    takeEvictedTranscriptPayloadRefs(),
                ),
            };
        });
    },

    keepAllTrackedFiles: async (sessionId) => {
        await runOptimisticSnapshotMutation(
            sessionId,
            (snapshot) => ({
                ...snapshot,
                reviewActionLog: null,
                trackedFiles: [],
                updatedAt: new Date().toISOString(),
            }),
            () => getComandoApi().keepAllAiTrackedFiles(sessionId),
            set,
            get,
        );
    },

    keepTrackedFile: async (input) => {
        await runOptimisticSnapshotMutation(
            input.sessionId,
            (snapshot) =>
                removeTrackedFileFromSnapshot(snapshot, input, "keep"),
            () => getComandoApi().keepAiTrackedFile(input),
            set,
            get,
        );
    },

    keepTrackedFileHunks: async (input) => {
        await runOptimisticSnapshotMutation(
            input.sessionId,
            (snapshot) =>
                resolveTrackedFileHunksInSnapshot(snapshot, input, "keep"),
            () => getComandoApi().keepAiTrackedFileHunks(input),
            set,
            get,
        );
    },
    refreshRuntimeStatus: async (runtimeId) => {
        const status = await getComandoApi().getAiRuntimeStatus(runtimeId);
        get().applyRuntimeStatus(status);
    },

    registerSessionTab: (tab) => {
        const persistedPreferences = readSessionReviewPreferencesForTab(tab);

        set((state) => ({
            sessions: {
                ...state.sessions,
                [tab.sessionId]: {
                    ...(state.sessions[tab.sessionId] ??
                        createSessionState(
                            persistedPreferences,
                            getSessionRuntimeStateForTab(tab),
                        )),
                    draftComposerParts:
                        state.sessions[tab.sessionId]?.draftComposerParts ??
                        (tab.kind === "chat" && tab.draft.trim().length > 0
                            ? [{ type: "text", text: tab.draft }]
                            : createEmptyComposerDraftParts()),
                    meta: buildSessionMeta(tab),
                    snapshot:
                        state.sessions[tab.sessionId]?.snapshot ??
                        createEmptySessionSnapshot(
                            tab,
                            state.runtimeCatalogById[tab.runtimeId] ?? null,
                        ),
                    runtimeState: resolveRegisteredRuntimeState(
                        state.sessions[tab.sessionId]?.runtimeState,
                        getSessionRuntimeStateForTab(tab),
                    ),
                },
            },
        }));
    },

    rejectAllTrackedFiles: async (sessionId) => {
        await runOptimisticSnapshotMutation(
            sessionId,
            (snapshot) => ({
                ...snapshot,
                reviewActionLog: null,
                trackedFiles: [],
                updatedAt: new Date().toISOString(),
            }),
            () => getComandoApi().rejectAllAiTrackedFiles(sessionId),
            set,
            get,
        );
    },

    rejectTrackedFile: async (input) => {
        await runOptimisticSnapshotMutation(
            input.sessionId,
            (snapshot) =>
                removeTrackedFileFromSnapshot(snapshot, input, "reject"),
            () => getComandoApi().rejectAiTrackedFile(input),
            set,
            get,
        );
    },

    rejectTrackedFileHunks: async (input) => {
        await runOptimisticSnapshotMutation(
            input.sessionId,
            (snapshot) =>
                resolveTrackedFileHunksInSnapshot(snapshot, input, "reject"),
            () => getComandoApi().rejectAiTrackedFileHunks(input),
            set,
            get,
        );
    },
    removeQueuedPrompt: (sessionId, promptId) => {
        set((state) => {
            const session = state.sessions[sessionId];
            if (!session) {
                return state;
            }

            return {
                sessions: {
                    ...state.sessions,
                    [sessionId]: {
                        ...session,
                        queue: session.queue.filter(
                            (queuedPrompt) => queuedPrompt.id !== promptId,
                        ),
                    },
                },
            };
        });
        void getComandoApi()
            .removeAiQueuedPrompt({ promptId, sessionId })
            .then((snapshot) => get().applyPromptQueueSnapshot(snapshot));
    },

    editQueuedPrompt: (sessionId, promptId, currentComposerParts = []) => {
        let restoredComposerParts: readonly AiComposerDraftPart[] | null = null;

        set((state) => {
            const session = state.sessions[sessionId];
            if (!session) {
                return state;
            }

            const queueWithExistingEditRestored =
                session.editingQueuedPrompt && session.editingQueuedPromptState
                    ? insertQueuedPromptAtEditPosition(
                          session.queue,
                          session.editingQueuedPrompt,
                          session.editingQueuedPromptState,
                      )
                    : session.queue;

            const queuedPrompt = queueWithExistingEditRestored.find(
                (candidate) => candidate.id === promptId,
            );
            if (!queuedPrompt || queuedPrompt.status === "sending") {
                return state;
            }

            restoredComposerParts = cloneComposerDraftParts(
                queuedPrompt.composerPartsSnapshot,
            );

            const nextQueue = queueWithExistingEditRestored.filter(
                (candidate) => candidate.id !== promptId,
            );
            const queueIndex = queueWithExistingEditRestored.findIndex(
                (candidate) => candidate.id === promptId,
            );
            const nextEditState = createQueuedPromptEditState({
                currentComposerParts,
                queue: queueWithExistingEditRestored,
                queueIndex,
                session,
            });

            return {
                sessions: {
                    ...state.sessions,
                    [sessionId]: {
                        ...session,
                        draftAttachments: cloneDraftAttachments(
                            queuedPrompt.attachments,
                        ),
                        draftComposerParts: restoredComposerParts,
                        draftFileContexts: cloneDraftFileContexts(
                            queuedPrompt.fileContextsSnapshot,
                        ),
                        editingQueuedPromptState: nextEditState,
                        editingQueuedPrompt: queuedPrompt,
                        localError: null,
                        queue: nextQueue,
                    },
                },
            };
        });

        void getComandoApi()
            .beginEditAiQueuedPrompt({ promptId, sessionId })
            .then((snapshot) => get().applyPromptQueueSnapshot(snapshot));

        return restoredComposerParts;
    },

    setDraftAttachments: (sessionId, attachments) => {
        set((state) => ({
            sessions: {
                ...state.sessions,
                [sessionId]: {
                    ...(state.sessions[sessionId] ?? createSessionState()),
                    draftAttachments: [...attachments],
                },
            },
        }));
    },

    setDraftComposerParts: (sessionId, parts) => {
        set((state) => ({
            sessions: {
                ...state.sessions,
                [sessionId]: {
                    ...(state.sessions[sessionId] ?? createSessionState()),
                    draftComposerParts: cloneComposerDraftParts(parts),
                },
            },
        }));
    },

    setQueuedPromptStatus: (sessionId, promptId, status) => {
        setQueuedPromptStatusInState(sessionId, promptId, status, set);
    },

    setSessionDiffZoom: (sessionId, diffZoom) => {
        const normalizedDiffZoom = normalizeAiDiffZoom(diffZoom);

        set((state) => {
            const nextSession = {
                ...(state.sessions[sessionId] ?? createSessionState()),
                diffZoom: normalizedDiffZoom,
            };

            persistSessionReviewPreferencesForSession(nextSession, sessionId);

            return {
                sessions: {
                    ...state.sessions,
                    [sessionId]: nextSession,
                },
            };
        });
    },

    respondPermission: async (input) => {
        await getComandoApi().respondAiPermission(input);
    },

    respondUserInput: async (input) => {
        await runOptimisticSnapshotMutation(
            input.sessionId,
            (snapshot) => ({
                ...snapshot,
                lastError: null,
                pendingUserInput: null,
                status: "starting",
                updatedAt: new Date().toISOString(),
            }),
            () => getComandoApi().respondAiUserInput(input),
            set,
            get,
        );
    },

    launchRuntimeAuth: async (input) => {
        await getComandoApi().launchAiRuntimeAuth(input);
        const runtimeStatus = await getComandoApi().getAiRuntimeStatus(
            input.runtimeId,
        );
        get().applyRuntimeStatus(runtimeStatus);
    },

    logoutRuntimeAuth: async (input) => {
        const status = await getComandoApi().logoutAiRuntimeAuth(input);
        const snapshot = await getComandoApi().getSettingsSnapshot();

        set((state) => ({
            claudeSettings: snapshot.ai?.claude ?? state.claudeSettings,
            codexSettings: snapshot.ai?.codex ?? state.codexSettings,
            grokSettings: snapshot.ai?.grok ?? state.grokSettings,
            kiloSettings: snapshot.ai?.kilo ?? state.kiloSettings,
            opencodeSettings:
                snapshot.ai?.opencode ?? state.opencodeSettings,
            runtimeStatusById: {
                ...state.runtimeStatusById,
                [input.runtimeId]: status,
            },
        }));

        return status;
    },

    disconnectRuntimeAuth: async (input) => {
        const status = await getComandoApi().disconnectAiRuntimeAuth(input);
        const snapshot = await getComandoApi().getSettingsSnapshot();

        set((state) => ({
            claudeSettings: snapshot.ai?.claude ?? state.claudeSettings,
            codexSettings: snapshot.ai?.codex ?? state.codexSettings,
            grokSettings: snapshot.ai?.grok ?? state.grokSettings,
            kiloSettings: snapshot.ai?.kilo ?? state.kiloSettings,
            opencodeSettings:
                snapshot.ai?.opencode ?? state.opencodeSettings,
            runtimeStatusById: {
                ...state.runtimeStatusById,
                [input.runtimeId]: status,
            },
        }));

        return status;
    },

    saveClaudeRuntimeSettings: async (settings) => {
        const status =
            await getComandoApi().saveClaudeRuntimeSettings(settings);
        const snapshot = await getComandoApi().getSettingsSnapshot();

        set((state) => ({
            claudeSettings: snapshot.ai?.claude ?? state.claudeSettings,
            runtimeStatusById: {
                ...state.runtimeStatusById,
                claude: status,
            },
        }));

        return status;
    },

    saveGrokRuntimeSettings: async (settings) => {
        const status = await getComandoApi().saveGrokRuntimeSettings(settings);
        const snapshot = await getComandoApi().getSettingsSnapshot();

        set((state) => ({
            grokSettings: snapshot.ai?.grok ?? state.grokSettings,
            runtimeStatusById: {
                ...state.runtimeStatusById,
                grok: status,
            },
        }));

        return status;
    },

    saveCodexRuntimeSettings: async (settings) => {
        const normalizedPath = settings.binaryPath?.trim() ?? "";
        const comandoApi = getComandoApi() as ReturnType<
            typeof getComandoApi
        > & {
            saveCodexRuntimeSettings: (
                input: CodexRuntimeSettingsInput,
            ) => Promise<AiRuntimeStatus>;
        };
        const status = await comandoApi.saveCodexRuntimeSettings({
            authMethod: settings.authMethod,
            binaryPath: normalizedPath || null,
            codexApiKey: settings.codexApiKey,
            openaiApiKey: settings.openaiApiKey,
        });
        const snapshot = await getComandoApi().getSettingsSnapshot();

        set((state) => ({
            codexBinaryPath: normalizedPath,
            codexSettings: snapshot.ai?.codex ?? state.codexSettings,
            runtimeStatusById: {
                ...state.runtimeStatusById,
                codex: status,
            },
        }));

        return status;
    },

    verifyCodexRuntimeSettings: async (settings) => {
        const normalizedPath = settings.binaryPath?.trim() ?? "";
        const comandoApi = getComandoApi() as ReturnType<
            typeof getComandoApi
        > & {
            verifyCodexRuntimeSettings: (
                input: CodexRuntimeSettingsInput,
            ) => Promise<AiRuntimeStatus>;
        };
        const status = await comandoApi.verifyCodexRuntimeSettings({
            authMethod: settings.authMethod,
            binaryPath: normalizedPath || null,
            codexApiKey: settings.codexApiKey,
            openaiApiKey: settings.openaiApiKey,
        });

        get().applyRuntimeStatus(status);

        return status;
    },

    saveKiloRuntimeSettings: async (settings) => {
        const status = await getComandoApi().saveKiloRuntimeSettings(settings);
        const snapshot = await getComandoApi().getSettingsSnapshot();

        set((state) => ({
            kiloSettings: snapshot.ai?.kilo ?? state.kiloSettings,
            runtimeStatusById: {
                ...state.runtimeStatusById,
                kilo: status,
            },
        }));

        return status;
    },

    saveOpenCodeRuntimeSettings: async (settings) => {
        const status =
            await getComandoApi().saveOpenCodeRuntimeSettings(settings);
        const snapshot = await getComandoApi().getSettingsSnapshot();

        set((state) => ({
            opencodeSettings:
                snapshot.ai?.opencode ?? state.opencodeSettings,
            runtimeStatusById: {
                ...state.runtimeStatusById,
                opencode: status,
            },
        }));

        return status;
    },

    saveCodexBinaryPath: async (binaryPath) => {
        const normalizedPath = binaryPath.trim();
        const currentAuthMethod = get().runtimeStatusById.codex?.authMethod;
        const status = await get().saveCodexRuntimeSettings({
            authMethod: isCodexAuthMethodId(currentAuthMethod)
                ? currentAuthMethod
                : null,
            binaryPath: normalizedPath || null,
            codexApiKey: unchangedSecretPatch,
            openaiApiKey: unchangedSecretPatch,
        });

        set((state) => ({
            codexBinaryPath: normalizedPath,
            runtimeStatusById: {
                ...state.runtimeStatusById,
                codex: status,
            },
        }));

        return status;
    },

    setSessionMode: async (input, options) => {
        const snapshot = getSelectionMutationSnapshot(input.sessionId, get);
        const modeConfig = snapshot ? getModeConfigOption(snapshot) : null;

        await runOptimisticSnapshotMutation(
            input.sessionId,
            (currentSnapshot) =>
                setModeOnSnapshot(
                    hydrateOptimisticSelectionSnapshot(currentSnapshot, get),
                    input.modeId,
                ),
            () =>
                runAiSessionControlRemoteMutation(
                    () =>
                        modeConfig?.type === "select" &&
                        hasSelectConfigValue(modeConfig, input.modeId)
                            ? getComandoApi().setAiSessionConfigOption({
                                  optionId: modeConfig.id,
                                  sessionId: input.sessionId,
                                  value: input.modeId,
                              })
                            : getComandoApi().setAiSessionMode(input),
                    options?.ensureLiveSession,
                ),
            set,
            get,
            {
                conflictKey: "mode",
                preserveDuringIncomingSnapshots: true,
                rollbackSnapshot: (currentSnapshot, rollbackBaseSnapshot) =>
                    rollbackBaseSnapshot.modeId
                        ? setModeOnSnapshot(
                              hydrateOptimisticSelectionSnapshot(
                                  currentSnapshot,
                                  get,
                              ),
                              rollbackBaseSnapshot.modeId,
                          )
                        : {
                              ...currentSnapshot,
                              modeId: null,
                              updatedAt: new Date().toISOString(),
                          },
            },
        );
    },

    setSessionModel: async (input, options) => {
        const snapshot = getSelectionMutationSnapshot(input.sessionId, get);
        const modelConfig = snapshot ? getModelConfigOption(snapshot) : null;

        await runOptimisticSnapshotMutation(
            input.sessionId,
            (currentSnapshot) =>
                setModelOnSnapshot(
                    hydrateOptimisticSelectionSnapshot(currentSnapshot, get),
                    input.modelId,
                ),
            () =>
                runAiSessionControlRemoteMutation(
                    () =>
                        modelConfig?.type === "select" &&
                        hasSelectConfigValue(modelConfig, input.modelId)
                            ? getComandoApi().setAiSessionConfigOption({
                                  optionId: modelConfig.id,
                                  sessionId: input.sessionId,
                                  value: input.modelId,
                              })
                            : getComandoApi().setAiSessionModel(input),
                    options?.ensureLiveSession,
                ),
            set,
            get,
            {
                conflictKey: "model",
                preserveDuringIncomingSnapshots: true,
                rollbackSnapshot: (currentSnapshot, rollbackBaseSnapshot) =>
                    rollbackBaseSnapshot.modelId
                        ? setModelOnSnapshot(
                              hydrateOptimisticSelectionSnapshot(
                                  currentSnapshot,
                                  get,
                              ),
                              rollbackBaseSnapshot.modelId,
                          )
                        : {
                              ...currentSnapshot,
                              modelId: null,
                              updatedAt: new Date().toISOString(),
                          },
            },
        );
    },

    setSessionConfigOption: async (input, options) => {
        const snapshot = getSelectionMutationSnapshot(input.sessionId, get);
        const conflictKey = getConfigOptionConflictKey(
            snapshot,
            input.optionId,
        );

        await runOptimisticSnapshotMutation(
            input.sessionId,
            (currentSnapshot) =>
                setConfigOptionOnSnapshot(
                    hydrateOptimisticSelectionSnapshot(currentSnapshot, get),
                    input.optionId,
                    input.value,
                ),
            () =>
                runAiSessionControlRemoteMutation(
                    () => getComandoApi().setAiSessionConfigOption(input),
                    options?.ensureLiveSession,
                ),
            set,
            get,
            {
                conflictKey,
                preserveDuringIncomingSnapshots: true,
                rollbackSnapshot: (currentSnapshot, rollbackBaseSnapshot) => {
                    const rollbackValue = rollbackBaseSnapshot.configOptions.find(
                        (option) => option.id === input.optionId,
                    )?.value;
                    return rollbackValue !== undefined
                        ? setConfigOptionOnSnapshot(
                              hydrateOptimisticSelectionSnapshot(
                                  currentSnapshot,
                                  get,
                              ),
                              input.optionId,
                              rollbackValue,
                          )
                        : currentSnapshot;
                },
            },
        );
    },

    renameSession: async (input) => {
        set((state) => {
            const session = state.sessions[input.sessionId];
            if (!session?.meta || session.meta.title === input.title) {
                return state;
            }
            return {
                sessions: {
                    ...state.sessions,
                    [input.sessionId]: {
                        ...session,
                        meta: { ...session.meta, title: input.title },
                    },
                },
            };
        });
        void useWorkspaceStore
            .getState()
            .updateSessionTabTitles(input.sessionId, input.title);
        await runOptimisticSnapshotMutation(
            input.sessionId,
            (snapshot) => {
                const manualTitle = input.title.trim() || null;
                return {
                    ...snapshot,
                    manualTitle,
                    title: manualTitle || snapshot.title,
                    updatedAt: new Date().toISOString(),
                };
            },
            () => getComandoApi().renameAiSession(input),
            set,
            get,
        );
    },

    sendQueuedPromptNow: async (sessionId, promptId) => {
        const snapshot = await getComandoApi().steerAiQueuedPrompt({
            promptId,
            sessionId,
        });
        get().applyPromptQueueSnapshot(snapshot);
    },

    verifyCodexBinaryPath: async (binaryPath) => {
        const normalizedPath = binaryPath.trim();
        const currentAuthMethod = get().runtimeStatusById.codex?.authMethod;
        return get().verifyCodexRuntimeSettings({
            authMethod: isCodexAuthMethodId(currentAuthMethod)
                ? currentAuthMethod
                : null,
            binaryPath: normalizedPath || null,
            codexApiKey: unchangedSecretPatch,
            openaiApiKey: unchangedSecretPatch,
        });
    },

    sendPrompt: async (tab, prompt, options = {}) => {
        const attachments = options.attachments ?? [];
        const trimmedPrompt = prompt.trim();
        if (!trimmedPrompt && attachments.length === 0) {
            return;
        }

        get().registerSessionTab(tab);
        const session = get().sessions[tab.sessionId] ?? createSessionState();
        const editingQueuedPrompt = session.editingQueuedPrompt;
        const messageId =
            editingQueuedPrompt?.optimisticMessageId ??
            editingQueuedPrompt?.id ??
            crypto.randomUUID();
        const input = {
            additionalRoots: options.additionalRoots,
            attachments,
            composerParts:
                options.composerPartsSnapshot ?? [
                    { text: trimmedPrompt, type: "text" as const },
                ],
            fileContextsSnapshot: options.fileContextsSnapshot ?? [],
            messageId,
            projectId: tab.projectId,
            prompt: trimmedPrompt,
            runtimeId: tab.runtimeId,
            sessionId: tab.sessionId,
            title: tab.title,
            worktreeId: tab.worktreeId ?? null,
        };
        const queueSnapshot = editingQueuedPrompt
            ? await getComandoApi().updateAiQueuedPrompt({
                  ...input,
                  promptId: editingQueuedPrompt.id,
              })
            : await getComandoApi().enqueueAiPrompt(input);
        get().applyPromptQueueSnapshot(queueSnapshot);
        clearEditingQueuedPromptState(tab.sessionId, set);
    },
}));

export function selectAiTranscriptWindow(
    state: AiStore,
    sessionId: string,
): AiTranscriptWindowClientState | null {
    return state.sessions[sessionId]?.transcriptWindow ?? null;
}

export function selectAiTranscriptBlock(
    state: AiStore,
    sessionId: string,
    blockId: string,
): AiTranscriptBlock | null {
    return state.sessions[sessionId]?.transcriptWindow.blocksById.get(blockId) ?? null;
}

function createSessionState(
    preferences?: SessionReviewPreferences | null,
    runtimeState: AiSessionRuntimeState = "live",
): AiSessionClientState {
    return {
        activeDispatchToken: null,
        activePromptMessageAliases: {},
        activeQueuedPrompt: null,
        draftAttachments: [],
        draftComposerParts: createEmptyComposerDraftParts(),
        draftFileContexts: [],
        dismissedPlanUpdatedAt: null,
        diffZoom: preferences?.diffZoom ?? null,
        editingQueuedPromptState: null,
        editingQueuedPrompt: null,
        incomingSnapshotVersion: 0,
        historyHydrationState:
            runtimeState === "history" ? "not_loaded" : "loaded",
        isDispatching: false,
        lastIncomingSnapshotUpdatedAt: null,
        localError: null,
        meta: null,
        queue: [],
        queueRevision: 0,
        queuePaused: false,
        runtimeState,
        snapshot: null,
        transcript: createEmptyAiSessionTranscriptModel(),
        transcriptWindow: createEmptyTranscriptWindowState(),
    };
}

function createEmptyTranscriptWindowState(): AiTranscriptWindowClientState {
    return {
        anchorBlockId: null,
        blocksById: new Map(),
        capabilityVersion: null,
        error: null,
        followTail: true,
        generation: 0,
        isLoading: false,
        metadata: [],
        payloadsByRef: new Map(),
        protectedBlockIds: new Set(),
        residentEntries: 0,
        transcriptRevision: null,
    };
}

function transcriptWindowStateFromSnapshot(
    snapshot: TranscriptWindowSnapshot,
    capabilityVersion: number | null,
    transcriptRevision: number | null,
    protectedBlockIds: ReadonlySet<string>,
    anchorBlockId: string | null = null,
    followTail = true,
): AiTranscriptWindowClientState {
    return {
        anchorBlockId,
        blocksById: snapshot.blocksById,
        capabilityVersion,
        error: null,
        followTail,
        generation: snapshot.generation,
        isLoading: false,
        metadata: snapshot.metadata,
        payloadsByRef: new Map(),
        protectedBlockIds: new Set(protectedBlockIds),
        residentEntries: snapshot.residentEntries,
        transcriptRevision,
    };
}

function resolveTranscriptHydrationView(
    current: AiTranscriptWindowClientState | undefined,
    metadata: readonly AiTranscriptBlockMetadata[],
): {
    readonly anchorBlockId: string | null;
    readonly followTail: boolean;
    readonly loadBlockIds: readonly string[];
    readonly protectedBlockIds: ReadonlySet<string>;
} {
    const metadataBlockIds = new Set(metadata.map((block) => block.blockId));
    const followTail = current?.followTail ?? true;
    const anchorBlockId = resolveTranscriptHydrationAnchor(current, metadata);
    const protectedBlockIds = new Set<string>();
    if (followTail) {
        for (const block of metadata.slice(-2)) {
            protectedBlockIds.add(block.blockId);
        }
    } else {
        for (const blockId of current?.protectedBlockIds ?? []) {
            if (metadataBlockIds.has(blockId)) {
                protectedBlockIds.add(blockId);
            }
        }
        if (anchorBlockId) {
            protectedBlockIds.add(anchorBlockId);
        }
    }
    const loadBlockIds =
        protectedBlockIds.size > 0
            ? [...protectedBlockIds]
            : metadata.slice(-2).map((block) => block.blockId);
    return {
        anchorBlockId,
        followTail,
        loadBlockIds,
        protectedBlockIds,
    };
}

function resolveTranscriptHydrationAnchor(
    current: AiTranscriptWindowClientState | undefined,
    metadata: readonly AiTranscriptBlockMetadata[],
): string | null {
    const anchorBlockId = current?.anchorBlockId ?? null;
    return anchorBlockId &&
        metadata.some((block) => block.blockId === anchorBlockId)
        ? anchorBlockId
        : null;
}

function synchronizeEvictedTranscriptWindowSessions(
    sessions: AiStore["sessions"],
    sessionIds: readonly string[],
): AiStore["sessions"] {
    if (sessionIds.length === 0) return sessions;
    let nextSessions = sessions;
    for (const sessionId of new Set(sessionIds)) {
        const session = nextSessions[sessionId];
        if (!session) continue;
        const current = session.transcriptWindow;
        const snapshot = transcriptWindowStore.snapshot(sessionId);
        const transcriptWindow = {
            ...transcriptWindowStateFromSnapshot(
                snapshot,
                current.capabilityVersion,
                current.transcriptRevision,
                current.protectedBlockIds,
                current.anchorBlockId,
                current.followTail,
            ),
            payloadsByRef: retainResidentTranscriptPayloads(
                sessionId,
                snapshot.blocksById,
                current.payloadsByRef,
            ),
        };
        nextSessions = {
            ...nextSessions,
            [sessionId]: {
                ...session,
                transcriptWindow,
            },
        };
    }
    return removeEvictedTranscriptPayloads(
        nextSessions,
        takeEvictedTranscriptPayloadRefs(),
    );
}

function removeEvictedTranscriptPayloads(
    sessions: AiStore["sessions"],
    evictedPayloadRefsBySession: ReadonlyMap<string, readonly string[]>,
): AiStore["sessions"] {
    let nextSessions = sessions;
    for (const [sessionId, payloadRefs] of evictedPayloadRefsBySession) {
        const session = nextSessions[sessionId];
        if (!session) continue;
        const payloadsByRef = new Map(session.transcriptWindow.payloadsByRef);
        for (const payloadRef of payloadRefs) {
            payloadsByRef.delete(payloadRef);
        }
        nextSessions = {
            ...nextSessions,
            [sessionId]: {
                ...session,
                transcriptWindow: {
                    ...session.transcriptWindow,
                    payloadsByRef,
                },
            },
        };
    }
    return nextSessions;
}

function collectSealedTranscriptEntryIds(
    blocksById: ReadonlyMap<string, AiTranscriptBlock>,
): ReadonlySet<string> {
    const entryIds = new Set<string>();
    for (const block of blocksById.values()) {
        for (const entry of block.entries) {
            if (
                entry.kind === "message" ||
                entry.kind === "thinking" ||
                entry.kind === "tool"
            ) {
                entryIds.add(entry.id);
            }
        }
    }
    return entryIds;
}

function updateTranscriptWindowState(
    state: AiStore,
    sessionId: string,
    transcriptWindow: AiTranscriptWindowClientState,
): Pick<AiStore, "sessions"> | AiStore {
    const session = state.sessions[sessionId];
    if (!session) return state;
    return {
        sessions: {
            ...state.sessions,
            [sessionId]: {
                ...session,
                transcriptWindow,
            },
        },
    };
}

async function executeSessionPrepare(
    tab: RuntimeAiSessionTab,
    get: GetAiState,
    set: SetAiState,
): Promise<void> {
    get().registerSessionTab(tab);

    set((state) => ({
        sessions: {
            ...state.sessions,
            [tab.sessionId]: {
                ...(state.sessions[tab.sessionId] ?? createSessionState()),
                meta: buildSessionMeta(tab),
                runtimeState: "live",
            },
        },
    }));

    try {
        const runtimeStatusPromise = getComandoApi().getAiRuntimeStatus(
            tab.runtimeId,
        );
        const snapshotPromise = getComandoApi()
            .prepareAiSession({
                projectId: tab.projectId,
                runtimeId: tab.runtimeId,
                sessionId: tab.sessionId,
                title: tab.title,
                worktreeId: tab.worktreeId ?? null,
            })
            .catch(async (error) => {
                const fallbackSnapshot =
                    await getComandoApi().getAiSessionSnapshot(tab.sessionId);
                if (fallbackSnapshot) {
                    return fallbackSnapshot;
                }
                throw error;
            });
        const [runtimeStatus, snapshot] = await Promise.all([
            runtimeStatusPromise,
            snapshotPromise,
        ]);

        const resolvedSnapshot =
            snapshot ??
            createEmptySessionSnapshot(
                tab,
                get().runtimeCatalogById[tab.runtimeId] ?? null,
            );

        set((state) => {
            const runtimeCatalog = extractRuntimeCatalogFromStatus(runtimeStatus);
            const nextCatalog =
                runtimeCatalog && hasRuntimeCatalog(runtimeCatalog)
                    ? runtimeCatalog
                    : (state.runtimeCatalogById[tab.runtimeId] ??
                      extractRuntimeCatalog(resolvedSnapshot));
            const incomingSnapshot = hasRuntimeCatalog(nextCatalog)
                ? mergeRuntimeCatalogIntoSnapshot(resolvedSnapshot, nextCatalog)
                : resolvedSnapshot;
            const currentSession = state.sessions[tab.sessionId];
            const resolved = resolveIncomingSessionSnapshot(
                incomingSnapshot,
                currentSession,
                {
                    preserveCurrentReviewState: true,
                },
            );
            const nextSnapshot = resolved.snapshot;
            const nextTranscript = resolved.transcript;

            return {
                runtimeCatalogById: hasRuntimeCatalog(nextCatalog)
                    ? {
                          ...state.runtimeCatalogById,
                          [tab.runtimeId]: nextCatalog,
                      }
                    : state.runtimeCatalogById,
                runtimeStatusById: {
                    ...state.runtimeStatusById,
                    [runtimeStatus.runtimeId]: runtimeStatus,
                },
                sessions: {
                    ...state.sessions,
                    [tab.sessionId]: {
                        ...(state.sessions[tab.sessionId] ??
                            createSessionState()),
                        ...(snapshot
                            ? resolveIncomingSnapshotProgress(
                                  currentSession,
                                  incomingSnapshot.updatedAt,
                              )
                            : {
                                  incomingSnapshotVersion:
                                      currentSession?.incomingSnapshotVersion ??
                                      0,
                                  lastIncomingSnapshotUpdatedAt:
                                      currentSession?.lastIncomingSnapshotUpdatedAt ??
                                      null,
                              }),
                        meta: buildSessionMeta(tab),
                        runtimeState: "live",
                        snapshot: nextSnapshot,
                        transcript: nextTranscript,
                    },
                },
            };
        });
        const api = getComandoApi();
        if (api.getAiPromptQueue) {
            get().applyPromptQueueSnapshot(
                await api.getAiPromptQueue(tab.sessionId),
            );
        }
    } catch (error) {
        set((state) => ({
            runtimeCatalogById: {
                ...state.runtimeCatalogById,
                [tab.runtimeId]: extractRuntimeCatalog(
                    createEmptySessionSnapshot(
                        tab,
                        state.runtimeCatalogById[tab.runtimeId] ?? null,
                    ),
                ),
            },
            sessions: {
                ...state.sessions,
                [tab.sessionId]: {
                    ...(state.sessions[tab.sessionId] ?? createSessionState()),
                    localError:
                        error instanceof Error
                            ? error.message
                            : `Could not hydrate the ${getRuntimeDisplayName(tab.runtimeId)} session.`,
                    meta: buildSessionMeta(tab),
                    runtimeState: "history",
                    // Keep the readable history on screen when reconnecting the
                    // runtime fails. The user can retry without losing context.
                    snapshot:
                        state.sessions[tab.sessionId]?.snapshot ??
                        createEmptySessionSnapshot(
                            tab,
                            state.runtimeCatalogById[tab.runtimeId] ?? null,
                        ),
                    transcript:
                        state.sessions[tab.sessionId]?.transcript ??
                        createEmptyAiSessionTranscriptModel(),
                },
            },
        }));
    }
}

async function executePassiveSessionHydration(
    tab: RuntimeAiSessionTab,
    get: GetAiState,
    set: SetAiState,
): Promise<void> {
    get().registerSessionTab(tab);

    set((state) => {
        const session = state.sessions[tab.sessionId];
        if (!session || session.runtimeState === "live") {
            return state;
        }

        return {
            sessions: {
                ...state.sessions,
                [tab.sessionId]: {
                    ...session,
                    historyHydrationState: "loading",
                    localError: null,
                },
            },
        };
    });

    try {
        const runtimeStatusPromise = getComandoApi()
            .getAiRuntimeStatus(tab.runtimeId)
            .catch(() => null);
        const snapshotPromise = getComandoApi().getAiSessionSnapshot(
            tab.sessionId,
        );
        const snapshot = await snapshotPromise;
        if (!snapshot) {
            set((state) => {
                const currentSession = state.sessions[tab.sessionId] ?? null;
                if (currentSession?.runtimeState === "live") {
                    return state;
                }

                return {
                    sessions: {
                        ...state.sessions,
                        [tab.sessionId]: {
                            ...(currentSession ??
                                createSessionState(null, "history")),
                            historyHydrationState: "missing",
                            localError: "This saved chat is no longer available.",
                            meta: buildSessionMeta(tab),
                            runtimeState: "history",
                        },
                    },
                };
            });
            return;
        }
        const runtimeStatus = await runtimeStatusPromise;
        const resolvedSnapshot = snapshot;

        set((state) => {
            const runtimeCatalog = runtimeStatus
                ? extractRuntimeCatalogFromStatus(runtimeStatus)
                : null;
            const nextCatalog =
                runtimeCatalog && hasRuntimeCatalog(runtimeCatalog)
                    ? runtimeCatalog
                    : (state.runtimeCatalogById[tab.runtimeId] ??
                      extractRuntimeCatalog(resolvedSnapshot));
            const incomingSnapshot = sanitizeSnapshotForHistoryMode(
                hasRuntimeCatalog(nextCatalog)
                    ? mergeRuntimeCatalogIntoSnapshot(resolvedSnapshot, nextCatalog)
                    : resolvedSnapshot,
            );
            const currentSession = state.sessions[tab.sessionId];
            const resolved = resolveIncomingSessionSnapshot(
                incomingSnapshot,
                currentSession,
            );
            const nextRuntimeCatalogById = hasRuntimeCatalog(nextCatalog)
                ? {
                      ...state.runtimeCatalogById,
                      [tab.runtimeId]: nextCatalog,
                  }
                : state.runtimeCatalogById;
            const nextRuntimeStatusById = runtimeStatus
                ? {
                      ...state.runtimeStatusById,
                      [runtimeStatus.runtimeId]: runtimeStatus,
                  }
                : state.runtimeStatusById;

            if (currentSession?.runtimeState === "live") {
                return {
                    runtimeCatalogById: nextRuntimeCatalogById,
                    runtimeStatusById: nextRuntimeStatusById,
                };
            }

            return {
                runtimeCatalogById: nextRuntimeCatalogById,
                runtimeStatusById: nextRuntimeStatusById,
                sessions: {
                    ...state.sessions,
                    [tab.sessionId]: {
                        ...(currentSession ?? createSessionState(null, "history")),
                        ...resolveIncomingSnapshotProgress(
                            currentSession,
                            incomingSnapshot.updatedAt,
                        ),
                        localError: null,
                        historyHydrationState: "loaded",
                        meta: buildSessionMeta(tab),
                        runtimeState: "history",
                        snapshot: resolved.snapshot,
                        transcript: resolved.transcript,
                    },
                },
            };
        });
        const api = getComandoApi();
        if (api.getAiPromptQueue) {
            // The queue augments a readable history; it must not invalidate it.
            try {
                get().applyPromptQueueSnapshot(
                    await api.getAiPromptQueue(tab.sessionId),
                );
            } catch (error) {
                console.warn(
                    "[comando] Could not restore the AI prompt queue.",
                    error,
                );
            }
        }
    } catch (error) {
        set((state) => {
            const currentSession = state.sessions[tab.sessionId] ?? null;
            if (currentSession?.runtimeState === "live") {
                return state;
            }

            return {
                sessions: {
                    ...state.sessions,
                    [tab.sessionId]: {
                        ...(currentSession ?? createSessionState(null, "history")),
                        localError:
                            error instanceof Error
                                ? error.message
                                : "Could not load this saved chat.",
                        historyHydrationState: "failed",
                        meta: buildSessionMeta(tab),
                        runtimeState: "history",
                        snapshot: createEmptySessionSnapshot(
                            tab,
                            state.runtimeCatalogById[tab.runtimeId] ?? null,
                        ),
                    },
                },
            };
        });
    }
}

function getSessionTranscript(
    session: AiSessionClientState,
    snapshot: AiSessionSnapshot,
): AiSessionTranscriptModel {
    return session.transcript.messageOrder.length > 0
        ? session.transcript
        : buildAiSessionTranscriptModelFromSnapshot(snapshot);
}

function persistSessionReviewPreferencesForSession(
    session: Pick<AiSessionClientState, "diffZoom" | "meta">,
    sessionId: string,
) {
    if (!session.meta) {
        return;
    }

    persistSessionReviewPreferences(
        session.meta.projectId,
        session.meta.worktreeId,
        sessionId,
        {
            diffZoom: session.diffZoom,
        },
    );
}

function createEmptyClaudeSettings(): ClaudeRuntimeSettings {
    return {
        authInvalidatedAtMs: null,
        authMethod: null,
        bedrockGatewayBaseUrl: null,
        binaryPath: null,
        gatewayBaseUrl: null,
        hasAnthropicApiKey: false,
        hasGatewayAuthToken: false,
        hasGatewayCustomHeaders: false,
    };
}

function createEmptyCodexSettings(): CodexRuntimeSettings {
    return {
        authMethod: null,
        binaryPath: null,
        hasCodexApiKey: false,
        hasOpenAiApiKey: false,
    };
}

function createEmptyGrokSettings(): GrokRuntimeSettings {
    return {
        authInvalidatedAtMs: null,
        authMethod: null,
        binaryPath: null,
        hasXaiApiKey: false,
    };
}

function createEmptyKiloSettings(): KiloRuntimeSettings {
    return {
        authInvalidatedAtMs: null,
        authMethod: null,
        binaryPath: null,
        hasKiloApiKey: false,
    };
}

function createEmptyOpenCodeSettings(): OpenCodeRuntimeSettings {
    return {
        authInvalidatedAtMs: null,
        authMethod: null,
        binaryPath: null,
    };
}

const unchangedSecretPatch: SecretValuePatch = { kind: "unchanged" };

function isCodexAuthMethodId(
    value: string | null | undefined,
): value is CodexAuthMethodId {
    return (
        value === "chatgpt" ||
        value === "codex-api-key" ||
        value === "openai-api-key"
    );
}

function createEmptySessionSnapshot(
    tab: RuntimeAiSessionTab,
    catalog: AiRuntimeCatalog | null = null,
): AiSessionSnapshot {
    const now = new Date().toISOString();

    return {
        activeTurnStartedAt: null,
        availableCommands: catalog?.availableCommands ?? [],
        closedAt: null,
        configOptions: catalog?.configOptions ?? [],
        lastError: null,
        messages: [],
        modeId: catalog?.modeId ?? null,
        modes: catalog?.modes ?? [],
        modelId: catalog?.modelId ?? null,
        models: catalog?.models ?? [],
        pendingPermission: null,
        pendingUserInput: null,
        plan: null,
        projectId: tab.projectId,
        runtimeId: tab.runtimeId,
        runtimeSessionId: null,
        sessionId: tab.sessionId,
        status: "idle",
        title: tab.title,
        tokenUsage: null,
        toolActivity: [],
        trackedFiles: [],
        updatedAt: now,
        worktreeId: tab.worktreeId ?? null,
    };
}

function createSessionSnapshotFromPatch(
    patch: AiSessionPatch,
    catalog: AiRuntimeCatalog | null = null,
): AiSessionSnapshot | null {
    if (!hasSessionIdentityPatch(patch.changes)) {
        return null;
    }

    const now = new Date().toISOString();
    return {
        activeTurnStartedAt: null,
        availableCommands: catalog?.availableCommands ?? [],
        closedAt: patch.changes.closedAt ?? null,
        configOptions: catalog?.configOptions ?? [],
        lastError: null,
        messages: [],
        modeId: catalog?.modeId ?? null,
        modes: catalog?.modes ?? [],
        modelId: catalog?.modelId ?? null,
        models: catalog?.models ?? [],
        pendingPermission: null,
        pendingUserInput: null,
        plan: null,
        parentSessionId: patch.changes.parentSessionId ?? null,
        projectId: patch.changes.projectId ?? null,
        runtimeId: patch.runtimeId,
        runtimeSessionId: patch.changes.runtimeSessionId ?? null,
        sessionId: patch.sessionId,
        status: "idle",
        title:
            typeof patch.changes.title === "string" &&
            patch.changes.title.trim().length > 0
                ? patch.changes.title.trim()
                : "AI Session",
        tokenUsage: null,
        toolActivity: [],
        trackedFiles: [],
        updatedAt: patch.changes.updatedAt ?? now,
        worktreeId: patch.changes.worktreeId ?? null,
    };
}

function createSessionSnapshotFromEvent(
    event: AiSessionDomainEvent,
    catalog: AiRuntimeCatalog | null = null,
): AiSessionSnapshot {
    const title =
        event.kind === "session-info" || event.kind === "subagent-created"
            ? event.title
            : event.kind === "status"
              ? (normalizeSessionStatusTitle(event.title) ?? "AI Session")
            : "AI Session";
    const modelId =
        event.kind === "subagent-created"
            ? (event.modelId ?? catalog?.modelId ?? null)
            : (catalog?.modelId ?? null);
    const reasoningEffort =
        event.kind === "subagent-created" ? event.reasoningEffort : null;

    return {
        activeTurnStartedAt:
            event.kind === "status" ? event.activeTurnStartedAt : null,
        availableCommands: catalog?.availableCommands ?? [],
        closedAt: event.kind === "session-closed" ? event.closedAt : null,
        configOptions: applyReasoningEffortToConfigOptions(
            applyModelIdToConfigOptions(catalog?.configOptions ?? [], modelId),
            reasoningEffort,
        ),
        lastError: event.kind === "status" ? event.lastError : null,
        messages: [],
        modeId: catalog?.modeId ?? null,
        modes: catalog?.modes ?? [],
        modelId,
        models: catalog?.models ?? [],
        pendingPermission:
            event.kind === "permission-request" ? event.request : null,
        pendingUserInput:
            event.kind === "user-input-request" ? event.request : null,
        plan: event.kind === "plan" ? event.plan : null,
        parentSessionId: event.parentSessionId,
        projectId: event.kind === "session-info" ? event.projectId : null,
        reasoningEffort,
        runtimeId: event.runtimeId,
        runtimeSessionId: event.runtimeSessionId,
        sessionId: event.sessionId,
        status: event.kind === "status" ? event.status : "idle",
        title,
        tokenUsage: event.kind === "token-usage" ? event.tokenUsage : null,
        toolActivity: [],
        trackedFiles: [],
        updatedAt: event.updatedAt,
        worktreeId: event.kind === "session-info" ? event.worktreeId : null,
    };
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

function applySessionDomainEventToSnapshot(
    snapshot: AiSessionSnapshot,
    event: AiSessionDomainEvent,
): AiSessionSnapshot {
    switch (event.kind) {
        case "message-started":
        case "thinking-started":
            return {
                ...snapshot,
                messages: upsertAiMessage(snapshot.messages, event.message),
                runtimeSessionId:
                    event.runtimeSessionId ?? snapshot.runtimeSessionId,
                updatedAt: event.updatedAt,
            };
        case "message-delta":
            return {
                ...snapshot,
                messages: applyMessageDeltaToMessages(snapshot.messages, {
                    content: event.content,
                    delta: event.delta,
                    kind: event.messageKind,
                    messageId: event.messageId,
                    updatedAt: event.updatedAt,
                }),
                runtimeSessionId:
                    event.runtimeSessionId ?? snapshot.runtimeSessionId,
                status: snapshot.status === "idle" ? "streaming" : snapshot.status,
                updatedAt: event.updatedAt,
            };
        case "thinking-delta":
            return {
                ...snapshot,
                messages: applyMessageDeltaToMessages(snapshot.messages, {
                    content: event.content,
                    delta: event.delta,
                    kind: "thinking",
                    messageId: event.messageId,
                    updatedAt: event.updatedAt,
                }),
                runtimeSessionId:
                    event.runtimeSessionId ?? snapshot.runtimeSessionId,
                status: snapshot.status === "idle" ? "streaming" : snapshot.status,
                updatedAt: event.updatedAt,
            };
        case "message-completed":
        case "thinking-completed":
            return {
                ...snapshot,
                messages: completeMessageById(
                    snapshot.messages,
                    event.messageId,
                ),
                runtimeSessionId:
                    event.runtimeSessionId ?? snapshot.runtimeSessionId,
                updatedAt: event.updatedAt,
            };
        case "image-generation":
            return {
                ...snapshot,
                messages: upsertAiMessage(snapshot.messages, event.message),
                runtimeSessionId:
                    event.runtimeSessionId ?? snapshot.runtimeSessionId,
                updatedAt: event.updatedAt,
            };
        case "tool-activity":
            return {
                ...snapshot,
                runtimeSessionId:
                    event.runtimeSessionId ?? snapshot.runtimeSessionId,
                toolActivity: upsertToolActivity(
                    snapshot.toolActivity,
                    event.activity,
                ),
                updatedAt: event.updatedAt,
            };
        case "status": {
            const title = normalizeSessionStatusTitle(event.title);
            return {
                ...snapshot,
                activeTurnStartedAt: event.activeTurnStartedAt,
                lastError: event.lastError,
                runtimeSessionId:
                    event.runtimeSessionId ?? snapshot.runtimeSessionId,
                status: event.status,
                title: title ?? snapshot.title,
                updatedAt: event.updatedAt,
            };
        }
        case "session-closed":
            return {
                ...snapshot,
                activeTurnStartedAt: null,
                closedAt: event.closedAt,
                lastError: null,
                pendingPermission: null,
                pendingUserInput: null,
                runtimeSessionId:
                    event.runtimeSessionId ?? snapshot.runtimeSessionId,
                status: "idle",
                updatedAt: event.updatedAt,
            };
        case "plan":
            return {
                ...snapshot,
                plan: event.plan,
                runtimeSessionId:
                    event.runtimeSessionId ?? snapshot.runtimeSessionId,
                updatedAt: event.updatedAt,
            };
        case "permission-request":
            return {
                ...snapshot,
                pendingPermission: event.request,
                pendingUserInput: event.request ? null : snapshot.pendingUserInput,
                runtimeSessionId:
                    event.runtimeSessionId ?? snapshot.runtimeSessionId,
                status: event.request ? "waiting_permission" : snapshot.status,
                updatedAt: event.updatedAt,
            };
        case "user-input-request":
            return {
                ...snapshot,
                pendingPermission: event.request ? null : snapshot.pendingPermission,
                pendingUserInput: event.request,
                runtimeSessionId:
                    event.runtimeSessionId ?? snapshot.runtimeSessionId,
                status: event.request ? "waiting_user_input" : snapshot.status,
                updatedAt: event.updatedAt,
            };
        case "token-usage":
            return {
                ...snapshot,
                runtimeSessionId:
                    event.runtimeSessionId ?? snapshot.runtimeSessionId,
                tokenUsage: event.tokenUsage,
                updatedAt: event.updatedAt,
            };
        case "session-info":
            return {
                ...snapshot,
                parentSessionId: event.parentSessionId,
                projectId: event.projectId,
                runtimeSessionId:
                    event.runtimeSessionId ?? snapshot.runtimeSessionId,
                title: event.title,
                updatedAt: event.updatedAt,
                worktreeId: event.worktreeId,
            };
        case "subagent-created": {
            const reasoningEffort =
                event.reasoningEffort ?? snapshot.reasoningEffort ?? null;
            return {
                ...snapshot,
                configOptions: applyReasoningEffortToConfigOptions(
                    applyModelIdToConfigOptions(
                        snapshot.configOptions,
                        event.modelId,
                    ),
                    reasoningEffort,
                ),
                modelId: event.modelId ?? snapshot.modelId,
                parentSessionId: event.parentSessionId,
                reasoningEffort,
                runtimeSessionId:
                    event.runtimeSessionId ?? snapshot.runtimeSessionId,
                title: event.title,
                updatedAt: event.updatedAt,
            };
        }
        case "subagent-breadcrumb":
            return {
                ...snapshot,
                runtimeSessionId:
                    event.runtimeSessionId ?? snapshot.runtimeSessionId,
                updatedAt: event.updatedAt,
            };
        default:
            return snapshot;
    }
}

function upsertAiMessage(
    messages: readonly AiMessage[],
    message: AiMessage,
): readonly AiMessage[] {
    const index = messages.findIndex((candidate) => candidate.id === message.id);
    if (index === -1) {
        return [...messages, message];
    }

    const existing = messages[index];
    const nextMessages = [...messages];
    nextMessages[index] = {
        ...message,
        attachments:
            existing.attachments.length > message.attachments.length
                ? existing.attachments
                : message.attachments,
        content:
            existing.content.length > message.content.length
                ? existing.content
                : message.content,
        generatedImage: message.generatedImage ?? existing.generatedImage,
        status:
            existing.status === "completed" && message.status !== "completed"
                ? "completed"
                : message.status,
    };
    return nextMessages;
}

function applyMessageDeltaToMessages(
    messages: readonly AiMessage[],
    input: {
        readonly content: string;
        readonly delta: string;
        readonly kind: AiMessage["kind"];
        readonly messageId: string;
        readonly updatedAt: string;
    },
): readonly AiMessage[] {
    const index = messages.findIndex(
        (candidate) => candidate.id === input.messageId,
    );
    if (index === -1) {
        return [
            ...messages,
            {
                attachments: [],
                content: input.content || input.delta,
                createdAt: input.updatedAt,
                id: input.messageId,
                kind: input.kind,
                status: "streaming",
            },
        ];
    }

    const existing = messages[index];
    const nextContent =
        input.content.length >= existing.content.length
            ? input.content
            : existing.content.endsWith(input.delta)
              ? existing.content
              : `${existing.content}${input.delta}`;
    const nextMessages = [...messages];
    nextMessages[index] = {
        ...existing,
        content: nextContent,
        status: existing.status === "completed" ? "completed" : "streaming",
    };
    return nextMessages;
}

function completeMessageById(
    messages: readonly AiMessage[],
    messageId: string,
): readonly AiMessage[] {
    return messages.map((message) =>
        message.id === messageId
            ? {
                  ...message,
                  status: "completed",
              }
            : message,
    );
}

function upsertToolActivity(
    activity: readonly AiToolActivity[],
    nextActivity: AiToolActivity,
): readonly AiToolActivity[] {
    const index = activity.findIndex(
        (candidate) => candidate.id === nextActivity.id,
    );
    if (index === -1) {
        return [...activity, nextActivity];
    }

    const existing = activity[index];
    const nextActivities = [...activity];
    nextActivities[index] = {
        ...nextActivity,
        createdAt: existing.createdAt,
        exitCode: nextActivity.exitCode ?? existing.exitCode,
        terminalOutput: nextActivity.terminalOutput ?? existing.terminalOutput,
    };
    return nextActivities;
}

function hasToolActivityDetail(activity: AiToolActivity): boolean {
    return (
        activity.diffs.length > 0 ||
        activity.rawInputJson !== null ||
        activity.rawOutputJson !== null ||
        activity.terminalOutput !== null
    );
}

function applyHydratedToolActivityDetail(
    state: AiStore,
    sessionId: string,
    activityId: string,
    detail: AiToolActivityDetail,
): AiStore | Pick<AiStore, "sessions"> {
    const session = state.sessions[sessionId];
    const snapshot = session?.snapshot;
    const activity = snapshot?.toolActivity.find(
        (candidate) => candidate.id === activityId,
    );
    if (!session || !snapshot || !activity) {
        return state;
    }
    const hydratedActivity: AiToolActivity = {
        ...activity,
        diffs: detail.diffs.length > 0 ? detail.diffs : activity.diffs,
        rawInputJson: detail.rawInputJson ?? activity.rawInputJson,
        rawOutputJson: detail.rawOutputJson ?? activity.rawOutputJson,
        terminalOutput: detail.terminalOutput ?? activity.terminalOutput,
    };
    const nextSnapshot = {
        ...snapshot,
        toolActivity: snapshot.toolActivity.map((candidate) =>
            candidate.id === activityId ? hydratedActivity : candidate,
        ),
    };
    const nextTranscript = applyAiSessionDomainEventToTranscript(
        session.transcript,
        {
            activity: hydratedActivity,
            kind: "tool-activity",
            origin: "restore",
            parentSessionId: snapshot.parentSessionId ?? null,
            runtimeId: snapshot.runtimeId,
            runtimeSessionId: snapshot.runtimeSessionId,
            sessionId,
            updatedAt: hydratedActivity.updatedAt,
        },
    );
    return {
        sessions: {
            ...state.sessions,
            [sessionId]: {
                ...session,
                snapshot: nextSnapshot,
                transcript: nextTranscript,
            },
        },
    };
}

function applyHydratedReviewDelta(
    state: AiStore,
    sessionId: string,
    delta: NonNullable<AiSessionSnapshot["reviewDeltas"]>[number],
    trackedFiles: readonly AiTrackedFile[],
): AiStore | Pick<AiStore, "sessions"> {
    const session = state.sessions[sessionId];
    const snapshot = session?.snapshot;
    const currentDelta = snapshot?.reviewDeltas?.find(
        (candidate) => candidate.deltaId === delta.deltaId,
    );
    if (!session || !snapshot || currentDelta?.revision !== delta.revision) {
        return state;
    }
    const hydrated = trackedFiles.map((file) => ({
        ...file,
        nativeReviewDeltaId: delta.deltaId,
        nativeReviewInputRevision: delta.inputRevision,
        nativeReviewWorkCycleId: delta.workCycleId,
        toolCallId: delta.toolCallId,
        version: delta.revision,
    }));
    const hydratedPaths = new Set(
        hydrated.flatMap((file) => [
            file.path,
            ...(file.previousPath ? [file.previousPath] : []),
        ]),
    );
    const unavailablePlaceholders = snapshot.trackedFiles.filter(
        (file) =>
            file.nativeReviewDeltaId === delta.deltaId &&
            !hydratedPaths.has(file.path),
    );
    const nextSnapshot = {
        ...snapshot,
        trackedFiles: [
            ...snapshot.trackedFiles.filter(
                (file) => file.nativeReviewDeltaId !== delta.deltaId,
            ),
            ...hydrated,
            ...unavailablePlaceholders,
        ],
    };
    return {
        sessions: {
            ...state.sessions,
            [sessionId]: { ...session, snapshot: nextSnapshot },
        },
    };
}

function hasSessionIdentityPatch(
    changes: AiSessionPatch["changes"],
): boolean {
    return (
        changes.parentSessionId !== undefined ||
        changes.runtimeSessionId !== undefined ||
        changes.messages !== undefined
    );
}

function createSessionMetaFromSnapshot(
    snapshot: AiSessionSnapshot,
): RegisteredSessionMeta {
    return {
        projectId: snapshot.projectId,
        runtimeId: snapshot.runtimeId,
        title: snapshot.title,
        worktreeId: snapshot.worktreeId ?? null,
    };
}

function extractRuntimeCatalog(snapshot: AiSessionSnapshot): AiRuntimeCatalog {
    return {
        availableCommands: snapshot.availableCommands,
        configOptions: snapshot.configOptions,
        modeId: snapshot.modeId,
        modes: snapshot.modes,
        modelId: snapshot.modelId,
        models: snapshot.models,
    };
}

function extractRuntimeCatalogFromStatus(
    status: AiRuntimeStatus,
): AiRuntimeCatalog | null {
    if (
        !status.availableCommands &&
        !status.configOptions &&
        !status.modes &&
        !status.models
    ) {
        return null;
    }

    return {
        availableCommands: status.availableCommands ?? [],
        configOptions: status.configOptions ?? [],
        modeId: status.modeId ?? null,
        modes: status.modes ?? [],
        modelId: status.modelId ?? null,
        models: status.models ?? [],
    };
}

function hasRuntimeCatalog(catalog: AiRuntimeCatalog | null): boolean {
    return Boolean(
        catalog &&
        (catalog.availableCommands.length > 0 ||
            catalog.configOptions.length > 0 ||
            catalog.models.length > 0 ||
            catalog.modes.length > 0),
    );
}

function mergeRuntimeCatalogIntoSnapshot(
    snapshot: AiSessionSnapshot,
    catalog: AiRuntimeCatalog,
): AiSessionSnapshot {
    const modelId = snapshot.modelId ?? catalog.modelId;
    const reasoningEffort = snapshot.reasoningEffort ?? null;
    return {
        ...snapshot,
        availableCommands:
            snapshot.availableCommands.length > 0
                ? snapshot.availableCommands
                : catalog.availableCommands,
        configOptions: applyReasoningEffortToConfigOptions(
            applyModelIdToConfigOptions(
                snapshot.configOptions.length > 0
                    ? snapshot.configOptions
                    : catalog.configOptions,
                modelId,
            ),
            reasoningEffort,
        ),
        modeId: snapshot.modeId ?? catalog.modeId,
        modes: snapshot.modes.length > 0 ? snapshot.modes : catalog.modes,
        modelId,
        models: snapshot.models.length > 0 ? snapshot.models : catalog.models,
        reasoningEffort,
    };
}

function resolveIncomingSessionSnapshot(
    incomingSnapshot: AiSessionSnapshot,
    currentSession: AiSessionClientState | null | undefined,
    options: ResolveIncomingSnapshotOptions = {},
): ResolvedIncomingSessionSnapshot {
    const resolved = resolveIncomingSessionSnapshotBase(
        incomingSnapshot,
        currentSession,
        options,
    );
    const snapshot = applyPendingOptimisticSelectionMutations(
        resolved.snapshot,
    );

    return snapshot === resolved.snapshot
        ? resolved
        : {
              ...resolved,
              snapshot,
          };
}

function applyPendingOptimisticSelectionMutations(
    snapshot: AiSessionSnapshot,
): AiSessionSnapshot {
    const mutations = optimisticSnapshotMutationStates.get(snapshot.sessionId)
        ?.preservedMutations;
    if (!mutations || mutations.size === 0) {
        return snapshot;
    }

    const authoritativeUpdatedAt = snapshot.updatedAt;
    let nextSnapshot = snapshot;
    for (const mutateSnapshot of mutations.values()) {
        nextSnapshot = mutateSnapshot(nextSnapshot);
    }

    return nextSnapshot === snapshot
        ? snapshot
        : {
              ...nextSnapshot,
              updatedAt: authoritativeUpdatedAt,
          };
}

function resolveIncomingSessionSnapshotBase(
    incomingSnapshot: AiSessionSnapshot,
    currentSession: AiSessionClientState | null | undefined,
    options: ResolveIncomingSnapshotOptions = {},
): ResolvedIncomingSessionSnapshot {
    const session = currentSession ?? null;
    const currentSnapshot = session?.snapshot ?? null;
    const normalizedIncomingSnapshot = normalizeIncomingActivePromptEcho(
        incomingSnapshot,
        session,
    );
    const effectiveIncomingSnapshot = options.preserveCurrentReviewState
        ? preserveCurrentReviewTrackedFiles(
              normalizedIncomingSnapshot,
              currentSnapshot,
          )
        : normalizedIncomingSnapshot;
    const anchoredIncomingSnapshot = preserveCurrentToolActivityAnchors(
        effectiveIncomingSnapshot,
        currentSnapshot,
    );
    if (
        !session ||
        !currentSnapshot ||
        currentSnapshot.sessionId !== anchoredIncomingSnapshot.sessionId
    ) {
        const incomingTranscript =
            buildAiSessionTranscriptModelFromSnapshot(
                anchoredIncomingSnapshot,
            );
        return {
            snapshot: writeAiSessionTranscriptToSnapshot(
                anchoredIncomingSnapshot,
                incomingTranscript,
            ),
            transcript: incomingTranscript,
        };
    }

    const currentTranscript = getSessionTranscript(session, currentSnapshot);
    const boundedIncomingSnapshot = keepBlockNativeLiveTranscriptWindow(
        anchoredIncomingSnapshot,
        session,
        currentSnapshot,
        currentTranscript,
    );
    const projectedIncomingTranscript =
        buildAiSessionTranscriptModelFromSnapshot(boundedIncomingSnapshot);
    const incomingTranscript = preserveUnsealedTranscriptTail(
        projectedIncomingTranscript,
        session,
        currentTranscript,
    );
    const changedKeys = options.changedKeys ?? null;
    const hasAcceptedIncomingSnapshot =
        session.lastIncomingSnapshotUpdatedAt !== null;
    const incomingIsFreshEnough = isUpdatedAtAtLeast(
        session.lastIncomingSnapshotUpdatedAt ?? currentSnapshot.updatedAt,
        effectiveIncomingSnapshot.updatedAt,
    );

    if (
        hasAcceptedIncomingSnapshot &&
        !incomingIsFreshEnough &&
        (currentTranscript.messageOrder.length > 0 ||
            incomingTranscript.messageOrder.length > 0)
    ) {
        return {
            snapshot: writeAiSessionTranscriptToSnapshot(
                mergeHydrationMetadataIntoCurrent(
                    currentSnapshot,
                    boundedIncomingSnapshot,
                ),
                currentTranscript,
            ),
            transcript: currentTranscript,
        };
    }

    const shouldPreserveCurrent = shouldPreserveCurrentAiSessionTranscript(
        currentTranscript,
        incomingTranscript,
    );
    if (!shouldPreserveCurrent) {
        return {
            snapshot: writeAiSessionTranscriptToSnapshot(
                boundedIncomingSnapshot,
                incomingTranscript,
            ),
            transcript: incomingTranscript,
        };
    }

    if (incomingIsFreshEnough) {
        const nextTranscript = mergeAiSessionTranscriptSources(
            currentTranscript,
            incomingTranscript,
            getSnapshotTranscriptMergeOptions(changedKeys),
        );
        return {
            snapshot: writeAiSessionTranscriptToSnapshot(
                boundedIncomingSnapshot,
                nextTranscript,
            ),
            transcript: nextTranscript,
        };
    }

    return {
        snapshot: writeAiSessionTranscriptToSnapshot(
            mergeHydrationMetadataIntoCurrent(
                currentSnapshot,
                boundedIncomingSnapshot,
            ),
            currentTranscript,
        ),
        transcript: currentTranscript,
    };
}

function preserveUnsealedTranscriptTail(
    incomingTranscript: AiSessionTranscriptModel,
    session: AiSessionClientState,
    currentTranscript: AiSessionTranscriptModel,
): AiSessionTranscriptModel {
    if (session.transcriptWindow.capabilityVersion === null) {
        return incomingTranscript;
    }

    const latestSealedAt = getLatestSealedTranscriptTimestamp(session);
    const messages = currentTranscript.messages.filter((message) =>
        isTranscriptEntryNewerThanSealedWindow(message.createdAt, latestSealedAt),
    );
    const toolActivity = currentTranscript.toolActivity.filter((activity) =>
        isTranscriptEntryNewerThanSealedWindow(
            activity.createdAt,
            latestSealedAt,
        ),
    );
    if (messages.length === 0 && toolActivity.length === 0) {
        return incomingTranscript;
    }

    // Keep the not-yet-indexed tail visible until block hydration removes the
    // same entry IDs after the native seal becomes observable.
    return mergeAiSessionTranscriptSources(
        buildAiSessionTranscriptModel({ messages, toolActivity }),
        incomingTranscript,
        {
            includeMessages: true,
            includePlan: true,
            includeStatus: true,
            includeTools: true,
            // The live snapshot does not own tools that are still waiting for
            // their sealed transcript block to become observable.
            preserveMissingTools: true,
        },
    );
}

function hasPendingTranscriptBlockHandoff(
    incomingSnapshot: AiSessionSnapshot,
    session: AiSessionClientState,
): boolean {
    if (
        session.transcriptWindow.capabilityVersion === null ||
        !session.snapshot ||
        !incomingSnapshot.activeTurnStartedAt
    ) {
        return false;
    }

    const latestSealedAt = getLatestSealedTranscriptTimestamp(session);
    const incomingMessageIds = new Set(
        incomingSnapshot.messages.map((message) => message.id),
    );
    const incomingToolIds = new Set(
        incomingSnapshot.toolActivity.map((activity) => activity.id),
    );
    const activeTurnStartedAt = incomingSnapshot.activeTurnStartedAt;
    const transcript = getSessionTranscript(session, session.snapshot);

    return (
        transcript.messages.some(
            (message) =>
                isTranscriptEntryNewerThanSealedWindow(
                    message.createdAt,
                    latestSealedAt,
                ) &&
                isTimestampBefore(message.createdAt, activeTurnStartedAt) &&
                !incomingMessageIds.has(message.id),
        ) ||
        transcript.toolActivity.some(
            (activity) =>
                isTranscriptEntryNewerThanSealedWindow(
                    activity.createdAt,
                    latestSealedAt,
                ) &&
                isTimestampBefore(activity.createdAt, activeTurnStartedAt) &&
                !incomingToolIds.has(activity.id),
        )
    );
}

function getLatestSealedTranscriptTimestamp(
    session: AiSessionClientState,
): string | null {
    return session.transcriptWindow.metadata.reduce<string | null>(
        (latest, block) =>
            latest === null || isTimestampAtOrAfter(block.lastCreatedAt, latest)
                ? block.lastCreatedAt
                : latest,
        null,
    );
}

function isTranscriptEntryNewerThanSealedWindow(
    createdAt: string,
    latestSealedAt: string | null,
): boolean {
    return latestSealedAt === null || isTimestampBefore(latestSealedAt, createdAt);
}

function isTimestampBefore(candidate: string, baseline: string): boolean {
    return !isTimestampAtOrAfter(candidate, baseline);
}

function keepBlockNativeLiveTranscriptWindow(
    snapshot: AiSessionSnapshot,
    session: AiSessionClientState,
    currentSnapshot: AiSessionSnapshot,
    currentTranscript: AiSessionTranscriptModel,
): AiSessionSnapshot {
    // Block support is global, while transcript metadata is session-specific.
    // Keep legacy snapshots authoritative until this session has confirmed
    // that its sealed history can be recovered from native blocks.
    if (session.transcriptWindow.transcriptRevision === null) {
        return snapshot;
    }

    const activeTurnStartedAt =
        snapshot.activeTurnStartedAt ?? currentSnapshot.activeTurnStartedAt;
    if (!activeTurnStartedAt) {
        return snapshot;
    }

    const visibleMessageIds = new Set(
        currentTranscript.messages.map((message) => message.id),
    );
    const visibleToolActivityIds = new Set(
        currentTranscript.toolActivity.map((activity) => activity.id),
    );
    // Sealed history is owned by the transcript window. A live snapshot may
    // refresh visible entries and append the active turn, but cannot hydrate
    // older blocks behind the window's back.
    const messages = snapshot.messages.filter(
        (message) =>
            visibleMessageIds.has(message.id) ||
            isTimestampAtOrAfter(message.createdAt, activeTurnStartedAt),
    );
    const toolActivity = snapshot.toolActivity.filter(
        (activity) =>
            visibleToolActivityIds.has(activity.id) ||
            isTimestampAtOrAfter(activity.createdAt, activeTurnStartedAt),
    );

    return messages.length === snapshot.messages.length &&
        toolActivity.length === snapshot.toolActivity.length
        ? snapshot
        : { ...snapshot, messages, toolActivity };
}

function preserveCurrentToolActivityAnchors(
    incomingSnapshot: AiSessionSnapshot,
    currentSnapshot: AiSessionSnapshot | null,
): AiSessionSnapshot {
    if (!currentSnapshot || incomingSnapshot.toolActivity.length === 0) {
        return incomingSnapshot;
    }

    const currentCreatedAtByToolId = new Map(
        currentSnapshot.toolActivity.map((activity) => [
            activity.id,
            activity.createdAt,
        ]),
    );
    let changed = false;
    const toolActivity = incomingSnapshot.toolActivity.map((activity) => {
        const currentCreatedAt = currentCreatedAtByToolId.get(activity.id);
        if (!currentCreatedAt || currentCreatedAt === activity.createdAt) {
            return activity;
        }

        changed = true;
        return {
            ...activity,
            createdAt: currentCreatedAt,
        };
    });

    return changed
        ? {
              ...incomingSnapshot,
              toolActivity,
          }
        : incomingSnapshot;
}

function normalizeIncomingActivePromptEcho(
    incomingSnapshot: AiSessionSnapshot,
    session: AiSessionClientState | null,
): AiSessionSnapshot {
    const activeQueuedPrompt = session?.activeQueuedPrompt?.queuedPrompt ?? null;
    const optimisticMessageId =
        activeQueuedPrompt?.optimisticMessageId ?? activeQueuedPrompt?.id ?? null;
    if (!activeQueuedPrompt || !optimisticMessageId) {
        return incomingSnapshot;
    }

    const promptContent = getQueuedPromptDisplayContent(activeQueuedPrompt);
    let changed = false;
    const messages: AiMessage[] = [];

    for (const message of incomingSnapshot.messages) {
        const isCanonicalOptimisticMessage =
            message.kind === "user" && message.id === optimisticMessageId;
        const isActivePromptEcho =
            message.kind === "user" &&
            message.id !== optimisticMessageId &&
            isTimestampAtOrAfter(message.createdAt, activeQueuedPrompt.createdAt) &&
            message.content === promptContent;
        const nextMessage = isCanonicalOptimisticMessage
            ? {
                  ...message,
                  content: promptContent,
              }
            : isActivePromptEcho
            ? {
                  ...message,
                  id: optimisticMessageId,
              }
            : message;

        if (
            isActivePromptEcho ||
            (isCanonicalOptimisticMessage && message.content !== promptContent)
        ) {
            changed = true;
        }

        const existingIndex = messages.findIndex(
            (candidate) => candidate.id === nextMessage.id,
        );
        if (existingIndex === -1) {
            messages.push(nextMessage);
            continue;
        }

        changed = true;
        const existing = messages[existingIndex];
        messages[existingIndex] = {
            ...nextMessage,
            attachments:
                existing.attachments.length > nextMessage.attachments.length
                    ? existing.attachments
                    : nextMessage.attachments,
            content:
                existing.content.length > nextMessage.content.length
                    ? existing.content
                    : nextMessage.content,
            generatedImage: nextMessage.generatedImage ?? existing.generatedImage,
            status:
                existing.status === "completed" &&
                nextMessage.status !== "completed"
                    ? "completed"
                    : nextMessage.status,
        };
    }

    return changed
        ? {
              ...incomingSnapshot,
              messages,
          }
        : incomingSnapshot;
}

function normalizeIncomingActivePromptEvent(
    event: AiSessionDomainEvent,
    session: AiSessionClientState | null,
    activePromptMessageAlias: ActivePromptMessageAlias | null = null,
): AiSessionDomainEvent {
    const aliasedMessageId = getAliasedIncomingMessageId(event, session);
    if (aliasedMessageId) {
        return rewriteIncomingMessageEventId(event, aliasedMessageId);
    }

    const activeQueuedPrompt = session?.activeQueuedPrompt?.queuedPrompt ?? null;
    const optimisticMessageId =
        activePromptMessageAlias?.optimisticMessageId ??
        activeQueuedPrompt?.optimisticMessageId ??
        activeQueuedPrompt?.id ??
        null;
    if (!activeQueuedPrompt || !optimisticMessageId) {
        return event;
    }

    const promptContent = getQueuedPromptDisplayContent(activeQueuedPrompt);
    switch (event.kind) {
        case "message-started":
            if (
                event.messageKind !== "user" ||
                event.message.id === optimisticMessageId ||
                !isActivePromptEchoMessage(
                    event.message,
                    activeQueuedPrompt,
                    promptContent,
                )
            ) {
                return event;
            }

            return {
                ...event,
                message: {
                    ...event.message,
                    id: optimisticMessageId,
                },
            };
        case "message-delta":
            if (
                event.messageKind === "user" &&
                event.messageId === optimisticMessageId
            ) {
                return {
                    ...event,
                    content: promptContent,
                    delta: promptContent,
                };
            }
            if (
                event.messageKind !== "user" ||
                !isActivePromptEchoContent(event, promptContent)
            ) {
                return event;
            }

            return {
                ...event,
                messageId: optimisticMessageId,
            };
        case "message-completed":
            if (
                event.messageKind !== "user" ||
                event.messageId === optimisticMessageId
            ) {
                return event;
            }

            return {
                ...event,
                messageId: optimisticMessageId,
            };
        default:
            return event;
    }
}

interface ActivePromptMessageAlias {
    readonly optimisticMessageId: string;
    readonly remoteMessageId: string;
}

function getActivePromptMessageAlias(
    event: AiSessionDomainEvent,
    session: AiSessionClientState | null,
): ActivePromptMessageAlias | null {
    const activeQueuedPrompt = session?.activeQueuedPrompt?.queuedPrompt ?? null;
    const optimisticMessageId =
        activeQueuedPrompt?.optimisticMessageId ?? activeQueuedPrompt?.id ?? null;
    if (
        !activeQueuedPrompt ||
        !optimisticMessageId ||
        event.kind !== "message-started" ||
        event.messageKind !== "user" ||
        event.message.id === optimisticMessageId
    ) {
        return null;
    }

    const promptContent = getQueuedPromptDisplayContent(activeQueuedPrompt);
    if (
        !isActivePromptEchoMessage(
            event.message,
            activeQueuedPrompt,
            promptContent,
        )
    ) {
        return null;
    }

    return {
        optimisticMessageId,
        remoteMessageId: event.message.id,
    };
}

function getAliasedIncomingMessageId(
    event: AiSessionDomainEvent,
    session: AiSessionClientState | null,
): string | null {
    switch (event.kind) {
        case "message-started":
            return session?.activePromptMessageAliases[event.message.id] ?? null;
        case "message-delta":
        case "message-completed":
            return session?.activePromptMessageAliases[event.messageId] ?? null;
        default:
            return null;
    }
}

function rewriteIncomingMessageEventId(
    event: AiSessionDomainEvent,
    messageId: string,
): AiSessionDomainEvent {
    switch (event.kind) {
        case "message-started":
            return {
                ...event,
                message: {
                    ...event.message,
                    id: messageId,
                },
            };
        case "message-delta":
        case "message-completed":
            return {
                ...event,
                messageId,
            };
        default:
            return event;
    }
}

function getNextActivePromptMessageAliases(
    session: AiSessionClientState,
    event: AiSessionDomainEvent,
    activePromptMessageAlias: ActivePromptMessageAlias | null,
): Readonly<Record<string, string>> {
    if (!activePromptMessageAlias && event.kind !== "message-completed") {
        return session.activePromptMessageAliases;
    }

    const aliases = { ...session.activePromptMessageAliases };
    if (activePromptMessageAlias) {
        aliases[activePromptMessageAlias.remoteMessageId] =
            activePromptMessageAlias.optimisticMessageId;
    }

    if (event.kind === "message-completed") {
        delete aliases[event.messageId];
    }

    return aliases;
}

function isActivePromptEchoMessage(
    message: AiMessage,
    activeQueuedPrompt: QueuedPrompt,
    promptContent: string,
): boolean {
    return (
        message.kind === "user" &&
        isTimestampAtOrAfter(message.createdAt, activeQueuedPrompt.createdAt) &&
        (message.content === "" || message.content === promptContent)
    );
}

function isActivePromptEchoContent(
    event: Extract<AiSessionDomainEvent, { kind: "message-delta" }>,
    promptContent: string,
): boolean {
    return event.content === promptContent || event.delta === promptContent;
}

function isTimestampAtOrAfter(candidate: string, baseline: string): boolean {
    const candidateMs = Date.parse(candidate);
    const baselineMs = Date.parse(baseline);
    if (Number.isFinite(candidateMs) && Number.isFinite(baselineMs)) {
        return candidateMs >= baselineMs;
    }

    return candidate >= baseline;
}

function preserveCurrentReviewTrackedFiles(
    incomingSnapshot: AiSessionSnapshot,
    currentSnapshot: AiSessionSnapshot | null,
): AiSessionSnapshot {
    if (
        !currentSnapshot ||
        currentSnapshot.sessionId !== incomingSnapshot.sessionId ||
        getSnapshotReviewActionLog(incomingSnapshot) ||
        incomingSnapshot.trackedFiles.length > 0
    ) {
        return incomingSnapshot;
    }

    const currentReviewActionLog = getSnapshotReviewActionLog(currentSnapshot);
    if (!currentReviewActionLog) {
        return incomingSnapshot;
    }

    return snapshotWithReviewActionLog(incomingSnapshot, currentReviewActionLog);
}

function mergeHydrationMetadataIntoCurrent(
    currentSnapshot: AiSessionSnapshot,
    incomingSnapshot: AiSessionSnapshot,
): AiSessionSnapshot {
    const incomingCatalog = extractRuntimeCatalog(incomingSnapshot);
    const snapshotWithCatalog = hasRuntimeCatalog(incomingCatalog)
        ? mergeRuntimeCatalogIntoSnapshot(currentSnapshot, incomingCatalog)
        : currentSnapshot;

    if (
        snapshotWithCatalog.runtimeSessionId ||
        !incomingSnapshot.runtimeSessionId
    ) {
        return snapshotWithCatalog;
    }

    return {
        ...snapshotWithCatalog,
        runtimeSessionId: incomingSnapshot.runtimeSessionId,
    };
}

function getLatestIncomingSnapshotUpdatedAt(
    currentUpdatedAt: string | null,
    incomingUpdatedAt: string,
): string {
    if (!currentUpdatedAt) {
        return incomingUpdatedAt;
    }

    return isUpdatedAtAtLeast(currentUpdatedAt, incomingUpdatedAt)
        ? incomingUpdatedAt
        : currentUpdatedAt;
}

function resolveIncomingSnapshotProgress(
    session:
        | Pick<
              AiSessionClientState,
              "incomingSnapshotVersion" | "lastIncomingSnapshotUpdatedAt"
          >
        | null
        | undefined,
    incomingUpdatedAt: string,
): Pick<
    AiSessionClientState,
    "incomingSnapshotVersion" | "lastIncomingSnapshotUpdatedAt"
> {
    const lastIncomingSnapshotUpdatedAt =
        session?.lastIncomingSnapshotUpdatedAt ?? null;
    const shouldCountIncoming =
        !lastIncomingSnapshotUpdatedAt ||
        isUpdatedAtAtLeast(lastIncomingSnapshotUpdatedAt, incomingUpdatedAt);

    return {
        incomingSnapshotVersion:
            (session?.incomingSnapshotVersion ?? 0) +
            (shouldCountIncoming ? 1 : 0),
        lastIncomingSnapshotUpdatedAt: getLatestIncomingSnapshotUpdatedAt(
            lastIncomingSnapshotUpdatedAt,
            incomingUpdatedAt,
        ),
    };
}

function isUpdatedAtAtLeast(
    currentUpdatedAt: string,
    incomingUpdatedAt: string,
): boolean {
    const currentMs = Date.parse(currentUpdatedAt);
    const incomingMs = Date.parse(incomingUpdatedAt);
    if (!Number.isFinite(currentMs) || !Number.isFinite(incomingMs)) {
        return incomingUpdatedAt >= currentUpdatedAt;
    }

    return incomingMs >= currentMs;
}

function applyCatalogPatchToCatalog(
    catalog: AiRuntimeCatalog,
    changes: AiSessionPatch["changes"],
): AiRuntimeCatalog {
    return {
        availableCommands:
            changes.availableCommands ?? catalog.availableCommands,
        configOptions: changes.configOptions ?? catalog.configOptions,
        modeId: changes.modeId !== undefined ? changes.modeId : catalog.modeId,
        modes: changes.modes ?? catalog.modes,
        modelId:
            changes.modelId !== undefined ? changes.modelId : catalog.modelId,
        models: changes.models ?? catalog.models,
    };
}

function applySessionPatch(
    snapshot: AiSessionSnapshot,
    patch: AiSessionPatch,
): AiSessionSnapshot {
    const patchedSnapshot = {
        ...snapshot,
        ...patch.changes,
        runtimeId: snapshot.runtimeId,
        sessionId: snapshot.sessionId,
    };
    if (patch.changes.configOptions === undefined) {
        return patchedSnapshot;
    }

    return {
        ...patchedSnapshot,
        configOptions: applyReasoningEffortToConfigOptions(
            applyModelIdToConfigOptions(
                patchedSnapshot.configOptions,
                patchedSnapshot.modelId,
            ),
            patchedSnapshot.reasoningEffort ?? null,
        ),
    };
}

function hasCatalogChanges(changes: AiSessionPatch["changes"]): boolean {
    return Boolean(
        changes.availableCommands !== undefined ||
        changes.configOptions !== undefined ||
        changes.modeId !== undefined ||
        changes.modes !== undefined ||
        changes.modelId !== undefined ||
        changes.models !== undefined,
    );
}

function buildSessionMeta(tab: RuntimeAiSessionTab): RegisteredSessionMeta {
    return {
        projectId: tab.projectId,
        runtimeId: tab.runtimeId,
        title: tab.title,
        worktreeId: tab.worktreeId ?? null,
    };
}

function getSessionRuntimeStateForTab(
    tab: RuntimeAiSessionTab,
): AiSessionRuntimeState {
    return tab.kind === "chat" && tab.sessionOpenMode === "history"
        ? "history"
        : "live";
}

function resolveRegisteredRuntimeState(
    current: AiSessionRuntimeState | null | undefined,
    incoming: AiSessionRuntimeState,
): AiSessionRuntimeState {
    if (incoming === "live" || current === "live") {
        return "live";
    }
    return "history";
}

function sanitizeSnapshotForHistoryMode(
    snapshot: AiSessionSnapshot,
): AiSessionSnapshot {
    return {
        ...snapshot,
        activeTurnStartedAt: null,
        messages: snapshot.messages.map((message) =>
            message.status === "streaming"
                ? { ...message, status: "completed" as const }
                : message,
        ),
        pendingPermission: null,
        pendingUserInput: null,
        status: isActiveSessionStatus(snapshot.status) ? "idle" : snapshot.status,
        toolActivity: snapshot.toolActivity.map((activity) =>
            isActiveToolActivityStatus(activity.status)
                ? { ...activity, status: "failed" as const }
                : activity,
        ),
    };
}

function isActiveSessionStatus(status: AiSessionSnapshot["status"]): boolean {
    return (
        status === "starting" ||
        status === "streaming" ||
        status === "waiting_permission" ||
        status === "waiting_user_input"
    );
}

function isActiveToolActivityStatus(
    status: AiToolActivity["status"],
): boolean {
    return status === "pending" || status === "in_progress";
}

function toRendererQueuedPrompt(item: AiQueuedPrompt): QueuedPrompt {
    return {
        additionalRoots: item.additionalRoots,
        attachments: cloneDraftAttachments(item.attachments),
        composerPartsSnapshot: cloneComposerDraftParts(
            item.composerPartsSnapshot,
        ),
        createdAt: item.createdAt,
        fileContextsSnapshot: cloneDraftFileContexts(
            item.fileContextsSnapshot,
        ),
        id: item.id,
        optimisticMessageId: item.optimisticMessageId ?? item.messageId,
        prompt: item.prompt,
        status: item.status,
    };
}

function applyLocalPromptAcceptanceToSession(
    session: AiSessionClientState,
    queuedPrompt: QueuedPrompt,
): AiSessionClientState {
    const snapshot = session.snapshot;
    if (!snapshot) {
        return session;
    }

    const acceptedAt = new Date().toISOString();
    const baseSnapshot = completeLocalStreamingMessages(snapshot);
    const hasMessage = baseSnapshot.messages.some(
        (message) => message.id === queuedPrompt.id,
    );
    const nextSnapshot: AiSessionSnapshot = {
        ...baseSnapshot,
        activeTurnStartedAt: baseSnapshot.activeTurnStartedAt ?? acceptedAt,
        lastError: null,
        messages: hasMessage
            ? baseSnapshot.messages
            : [
                  ...baseSnapshot.messages,
                  {
                      attachments: queuedPrompt.attachments,
                      content: getQueuedPromptDisplayContent(queuedPrompt),
                      createdAt: acceptedAt,
                      id: queuedPrompt.id,
                      kind: "user",
                      status: "completed",
                  },
              ],
        pendingPermission: null,
        pendingUserInput: null,
        status: "starting",
        updatedAt: acceptedAt,
    };
    const nextTranscript = mergeAiSessionTranscriptSources(
        getSessionTranscript(session, snapshot),
        buildAiSessionTranscriptModelFromSnapshot(nextSnapshot),
        {
            includeMessages: true,
            includePlan: false,
            includeStatus: true,
            includeTools: false,
        },
    );

    return {
        ...session,
        localError: null,
        snapshot: writeAiSessionTranscriptToSnapshot(
            nextSnapshot,
            nextTranscript,
        ),
        transcript: nextTranscript,
    };
}

function completeLocalStreamingMessages(
    snapshot: AiSessionSnapshot,
): AiSessionSnapshot {
    return {
        ...snapshot,
        messages: snapshot.messages.map((message) =>
            message.status === "streaming"
                ? {
                      ...message,
                      status: "completed",
                  }
                : message,
        ),
    };
}

function getQueuedPromptDisplayContent(queuedPrompt: QueuedPrompt): string {
    return serializeComposerMessagePartsForDisplay(
        queuedPrompt.composerPartsSnapshot,
        queuedPrompt.prompt,
    );
}

function createQueuedPromptEditState(input: {
    readonly currentComposerParts: readonly AiComposerDraftPart[];
    readonly queue: readonly QueuedPrompt[];
    readonly queueIndex: number;
    readonly session: AiSessionClientState;
}): QueuedPromptEditState {
    const position = createQueuedPromptPositionState(
        input.queue,
        input.queueIndex,
    );

    return {
        ...position,
        previousComposerParts: cloneComposerDraftParts(
            input.currentComposerParts,
        ),
        previousDraftAttachments: cloneDraftAttachments(
            input.session.draftAttachments,
        ),
        previousDraftFileContexts: cloneDraftFileContexts(
            input.session.draftFileContexts,
        ),
    };
}

function createQueuedPromptPositionState(
    queue: readonly QueuedPrompt[],
    queueIndex: number,
): QueuedPromptPositionState {
    const normalizedQueueIndex = queueIndex < 0 ? queue.length : queueIndex;

    return {
        nextPromptId: queue[normalizedQueueIndex + 1]?.id ?? null,
        previousPromptId:
            normalizedQueueIndex > 0
                ? (queue[normalizedQueueIndex - 1]?.id ?? null)
                : null,
        queueIndex: normalizedQueueIndex,
    };
}

function insertQueuedPromptAtEditPosition(
    queue: readonly QueuedPrompt[],
    queuedPrompt: QueuedPrompt,
    editState: QueuedPromptEditState | null,
): QueuedPrompt[] {
    return insertQueuedPromptAtPosition(queue, queuedPrompt, editState);
}

function insertQueuedPromptAtPosition(
    queue: readonly QueuedPrompt[],
    queuedPrompt: QueuedPrompt,
    position: QueuedPromptPositionState | null,
): QueuedPrompt[] {
    const remainingQueue = queue.filter(
        (candidate) => candidate.id !== queuedPrompt.id,
    );
    if (!position) {
        return [queuedPrompt, ...remainingQueue];
    }

    if (position.nextPromptId) {
        const nextIndex = remainingQueue.findIndex(
            (candidate) => candidate.id === position.nextPromptId,
        );
        if (nextIndex >= 0) {
            return [
                ...remainingQueue.slice(0, nextIndex),
                queuedPrompt,
                ...remainingQueue.slice(nextIndex),
            ];
        }
    }

    if (position.previousPromptId) {
        const previousIndex = remainingQueue.findIndex(
            (candidate) => candidate.id === position.previousPromptId,
        );
        if (previousIndex >= 0) {
            const insertionIndex = previousIndex + 1;
            return [
                ...remainingQueue.slice(0, insertionIndex),
                queuedPrompt,
                ...remainingQueue.slice(insertionIndex),
            ];
        }
    }

    const insertionIndex = Math.min(
        Math.max(position.queueIndex, 0),
        remainingQueue.length,
    );

    return [
        ...remainingQueue.slice(0, insertionIndex),
        queuedPrompt,
        ...remainingQueue.slice(insertionIndex),
    ];
}

function setQueuedPromptStatusInState(
    sessionId: string,
    promptId: string,
    status: QueuedPrompt["status"],
    set: SetAiState,
): void {
    set((state) => {
        const session = state.sessions[sessionId];
        if (!session) {
            return state;
        }

        let updated = false;
        const queue = session.queue.map((queuedPrompt) => {
            if (
                queuedPrompt.id !== promptId ||
                queuedPrompt.status === status
            ) {
                return queuedPrompt;
            }

            updated = true;
            return {
                ...queuedPrompt,
                status,
            };
        });

        if (!updated) {
            return state;
        }

        return {
            sessions: {
                ...state.sessions,
                [sessionId]: {
                    ...session,
                    queue,
                },
            },
        };
    });
}

function clearEditingQueuedPromptState(
    sessionId: string,
    set: SetAiState,
): void {
    set((state) => {
        const session = state.sessions[sessionId];
        if (!session?.editingQueuedPrompt) {
            return state;
        }

        return {
            sessions: {
                ...state.sessions,
                [sessionId]: {
                    ...session,
                    editingQueuedPromptState: null,
                    editingQueuedPrompt: null,
                },
            },
        };
    });
}

function pauseQueue(sessionId: string, set: SetAiState): void {
    set((state) => {
        const session = state.sessions[sessionId];
        if (!session || session.queuePaused) {
            return state;
        }

        return {
            sessions: {
                ...state.sessions,
                [sessionId]: {
                    ...session,
                    queuePaused: true,
                },
            },
        };
    });
}

interface OptimisticSnapshotMutationOptions {
    readonly conflictKey?: string;
    readonly preserveDuringIncomingSnapshots?: boolean;
    readonly rollbackSnapshot?: (
        currentSnapshot: AiSessionSnapshot,
        previousSnapshot: AiSessionSnapshot,
    ) => AiSessionSnapshot;
}

function getSelectionMutationSnapshot(
    sessionId: string,
    get: GetAiState,
): AiSessionSnapshot | null {
    const snapshot = get().sessions[sessionId]?.snapshot ?? null;
    return snapshot
        ? hydrateOptimisticSelectionSnapshot(snapshot, get)
        : null;
}

function getConfigOptionConflictKey(
    snapshot: AiSessionSnapshot | null,
    optionId: string,
): string {
    if (snapshot && getModelConfigOption(snapshot)?.id === optionId) {
        return "model";
    }
    if (snapshot && getModeConfigOption(snapshot)?.id === optionId) {
        return "mode";
    }
    return `config:${optionId}`;
}

function hydrateOptimisticSelectionSnapshot(
    snapshot: AiSessionSnapshot,
    get: GetAiState,
): AiSessionSnapshot {
    const runtimeCatalog = get().runtimeCatalogById[snapshot.runtimeId] ?? null;
    return runtimeCatalog && hasRuntimeCatalog(runtimeCatalog)
        ? mergeRuntimeCatalogIntoSnapshot(snapshot, runtimeCatalog)
        : snapshot;
}

async function runAiSessionControlRemoteMutation(
    runRemote: () => Promise<void>,
    ensureLiveSession?: (force: boolean) => Promise<void>,
): Promise<void> {
    await ensureLiveSession?.(false);

    try {
        await runRemote();
    } catch (error) {
        if (!ensureLiveSession || !isMissingAiSessionControlError(error)) {
            throw error;
        }

        await ensureLiveSession(true);
        await runRemote();
    }
}

function isMissingAiSessionControlError(error: unknown): boolean {
    const message =
        error instanceof Error
            ? error.message
            : typeof error === "string"
              ? error
              : "";
    const normalizedMessage = message.toLowerCase();
    return (
        normalizedMessage.includes("ai session was not found") ||
        normalizedMessage.includes("ai session is no longer open")
    );
}

async function runOptimisticSnapshotMutation(
    sessionId: string,
    mutateSnapshot: OptimisticSnapshotMutator,
    runRemote: () => Promise<void>,
    set: SetAiState,
    get: GetAiState,
    options: OptimisticSnapshotMutationOptions = {},
): Promise<void> {
    const mutationState = optimisticSnapshotMutationStates.get(sessionId) ?? {
        latestVersion: 0,
        latestVersionByConflictKey: new Map<string, number>(),
        nextVersion: 0,
        pendingVersionsByConflictKey: new Map<string, Set<number>>(),
        preservedMutations: new Map<number, OptimisticSnapshotMutator>(),
        rollbackBaseSnapshotsByConflictKey: new Map<
            string,
            AiSessionSnapshot
        >(),
        pendingVersions: new Set<number>(),
    };
    const previousSession = get().sessions[sessionId] ?? null;
    const previousSnapshot = previousSession?.snapshot ?? null;
    const mutationVersion = mutationState.nextVersion + 1;
    mutationState.latestVersion = mutationVersion;
    mutationState.nextVersion = mutationVersion;
    mutationState.pendingVersions.add(mutationVersion);
    if (options.conflictKey) {
        mutationState.latestVersionByConflictKey.set(
            options.conflictKey,
            mutationVersion,
        );
        const pendingConflictVersions =
            mutationState.pendingVersionsByConflictKey.get(
                options.conflictKey,
            ) ?? new Set<number>();
        if (pendingConflictVersions.size === 0 && previousSnapshot) {
            mutationState.rollbackBaseSnapshotsByConflictKey.set(
                options.conflictKey,
                previousSnapshot,
            );
        }
        pendingConflictVersions.add(mutationVersion);
        mutationState.pendingVersionsByConflictKey.set(
            options.conflictKey,
            pendingConflictVersions,
        );
    }
    if (options.preserveDuringIncomingSnapshots) {
        mutationState.preservedMutations.set(mutationVersion, mutateSnapshot);
    }
    optimisticSnapshotMutationStates.set(sessionId, mutationState);

    if (previousSession && previousSnapshot) {
        set((state) => {
            const currentSession = state.sessions[sessionId];
            if (!currentSession?.snapshot) {
                return state;
            }

            return {
                sessions: {
                    ...state.sessions,
                    [sessionId]: {
                        ...currentSession,
                        snapshot: mutateSnapshot(currentSession.snapshot),
                    },
                },
            };
        });
    }

    try {
        await runRemote();
        if (options.conflictKey) {
            const pendingConflictVersions =
                mutationState.pendingVersionsByConflictKey.get(
                    options.conflictKey,
                );
            const hasNewerPendingMutation = Boolean(
                pendingConflictVersions &&
                    [...pendingConflictVersions].some(
                        (version) => version > mutationVersion,
                    ),
            );
            const rollbackBase =
                mutationState.rollbackBaseSnapshotsByConflictKey.get(
                    options.conflictKey,
                );
            if (hasNewerPendingMutation && rollbackBase) {
                mutationState.rollbackBaseSnapshotsByConflictKey.set(
                    options.conflictKey,
                    mutateSnapshot(rollbackBase),
                );
            }
        }
    } catch (error) {
        mutationState.preservedMutations.delete(mutationVersion);
        const latestMutationVersion = options.conflictKey
            ? mutationState.latestVersionByConflictKey.get(options.conflictKey)
            : mutationState.latestVersion;
        if (
            previousSession &&
            optimisticSnapshotMutationStates.get(sessionId) === mutationState &&
            latestMutationVersion === mutationVersion
        ) {
            set((state) => {
                const currentSession = state.sessions[sessionId];
                if (!currentSession) {
                    return state;
                }

                const currentSnapshot = currentSession.snapshot;
                const rollbackBaseSnapshot = options.conflictKey
                    ? (mutationState.rollbackBaseSnapshotsByConflictKey.get(
                          options.conflictKey,
                      ) ?? previousSnapshot)
                    : previousSnapshot;
                const rollbackSnapshot =
                    currentSnapshot && rollbackBaseSnapshot
                        ? (options.rollbackSnapshot?.(
                              currentSnapshot,
                              rollbackBaseSnapshot,
                          ) ?? rollbackBaseSnapshot)
                        : rollbackBaseSnapshot;

                return {
                    sessions: {
                        ...state.sessions,
                        [sessionId]: {
                            ...currentSession,
                            snapshot: rollbackSnapshot,
                        },
                    },
                };
            });
        }
        throw error;
    } finally {
        mutationState.pendingVersions.delete(mutationVersion);
        if (options.conflictKey) {
            const pendingConflictVersions =
                mutationState.pendingVersionsByConflictKey.get(
                    options.conflictKey,
                );
            pendingConflictVersions?.delete(mutationVersion);
            if (!pendingConflictVersions?.size) {
                mutationState.pendingVersionsByConflictKey.delete(
                    options.conflictKey,
                );
                mutationState.rollbackBaseSnapshotsByConflictKey.delete(
                    options.conflictKey,
                );
            }
        }
        if (mutationState.pendingVersions.size === 0) {
            optimisticSnapshotMutationStates.delete(sessionId);
        }
    }
}

function getModeConfigOption(
    snapshot: Pick<AiSessionSnapshot, "configOptions">,
): AiSessionConfigOption | null {
    return (
        snapshot.configOptions.find(
            (option) =>
                option.category === "mode" ||
                option.id.toLowerCase() === "mode",
        ) ?? null
    );
}

function getModelConfigOption(
    snapshot: Pick<AiSessionSnapshot, "configOptions">,
): AiSessionConfigOption | null {
    return (
        snapshot.configOptions.find(
            (option) =>
                option.category === "model" ||
                option.id.toLowerCase() === "model",
        ) ?? null
    );
}

function hasSelectConfigValue(
    option: AiSessionConfigOption,
    value: string,
): boolean {
    return (
        option.type === "select" &&
        option.options.some((candidate) => candidate.value === value)
    );
}

function setModeOnSnapshot(
    snapshot: AiSessionSnapshot,
    modeId: string,
): AiSessionSnapshot {
    return {
        ...snapshot,
        configOptions: snapshot.configOptions.map((option) =>
            option.type === "select" &&
            (option.category === "mode" ||
                option.id.toLowerCase() === "mode") &&
            hasSelectConfigValue(option, modeId)
                ? {
                      ...option,
                      value: modeId,
                  }
                : option,
        ),
        modeId,
        updatedAt: new Date().toISOString(),
    };
}

function setModelOnSnapshot(
    snapshot: AiSessionSnapshot,
    modelId: string,
): AiSessionSnapshot {
    return {
        ...snapshot,
        configOptions: applyModelIdToConfigOptions(
            snapshot.configOptions,
            modelId,
        ),
        modelId,
        updatedAt: new Date().toISOString(),
    };
}

function setConfigOptionOnSnapshot(
    snapshot: AiSessionSnapshot,
    optionId: string,
    value: boolean | string,
): AiSessionSnapshot {
    const previousOption =
        snapshot.configOptions.find((option) => option.id === optionId) ?? null;
    const nextConfigOptions = snapshot.configOptions.map((option) =>
        option.id !== optionId
            ? option
            : option.type === "boolean" && typeof value === "boolean"
              ? {
                    ...option,
                    value,
                }
              : option.type === "select" &&
                  typeof value === "string" &&
                  hasSelectConfigValue(option, value)
                ? {
                      ...option,
                      value,
                  }
                : option,
    );
    const updatedOption =
        nextConfigOptions.find((option) => option.id === optionId) ?? null;
    const hasUpdatedOptionValue =
        updatedOption !== null &&
        previousOption !== null &&
        updatedOption.value !== previousOption.value;

    return {
        ...snapshot,
        configOptions: nextConfigOptions,
        modeId:
            updatedOption?.type === "select" &&
            (updatedOption.category === "mode" ||
                updatedOption.id.toLowerCase() === "mode") &&
            typeof value === "string"
                ? value
                : snapshot.modeId,
        modelId:
            updatedOption?.type === "select" &&
            (updatedOption.category === "model" ||
                updatedOption.id.toLowerCase() === "model") &&
            typeof value === "string"
                ? value
                : snapshot.modelId,
        reasoningEffort:
            hasUpdatedOptionValue &&
            updatedOption?.type === "select" &&
            isReasoningEffortConfigOption(updatedOption) &&
            typeof value === "string"
                ? value
                : snapshot.reasoningEffort,
        updatedAt: new Date().toISOString(),
    };
}

function removeTrackedFileFromSnapshot(
    snapshot: AiSessionSnapshot,
    input: AiTrackedFileMutationInput,
    decision: "keep" | "reject",
): AiSessionSnapshot {
    const reviewActionLog = getSnapshotReviewActionLog(snapshot);
    if (reviewActionLog) {
        const nextActionLog = resolveOptimisticActionLogFileMutation(
            reviewActionLog,
            input,
            decision,
        );

        return nextActionLog === reviewActionLog
            ? snapshot
            : snapshotWithReviewActionLog(snapshot, nextActionLog);
    }

    const target = resolveTrackedFileMutationTarget(snapshot, input);
    if (!target) {
        return snapshot;
    }

    return {
        ...snapshot,
        trackedFiles: snapshot.trackedFiles.filter(
            (trackedFile) => trackedFile.identityKey !== target.identityKey,
        ),
        updatedAt: new Date().toISOString(),
    };
}

function resolveTrackedFileHunksInSnapshot(
    snapshot: AiSessionSnapshot,
    input: AiTrackedFileHunkMutationInput,
    decision: "keep" | "reject",
): AiSessionSnapshot {
    const reviewActionLog = getSnapshotReviewActionLog(snapshot);
    if (reviewActionLog) {
        const nextActionLog = resolveOptimisticActionLogHunkMutation(
            reviewActionLog,
            input,
            decision,
        );

        return nextActionLog === reviewActionLog
            ? snapshot
            : snapshotWithReviewActionLog(snapshot, nextActionLog);
    }

    const target = resolveTrackedFileMutationTarget(snapshot, input);
    if (!target) {
        return snapshot;
    }

    const nextTrackedFiles = snapshot.trackedFiles.flatMap((trackedFile) => {
        if (trackedFile.identityKey !== target.identityKey) {
            return [trackedFile];
        }

        const nextTrackedFile = resolveTrackedFileHunks(
            trackedFile,
            input.hunkIds,
            decision,
        );
        if (!nextTrackedFile) {
            return [];
        }

        return [nextTrackedFile];
    });

    return {
        ...snapshot,
        trackedFiles: nextTrackedFiles,
        updatedAt: new Date().toISOString(),
    };
}

function getSnapshotReviewActionLog(
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

function resolveOptimisticActionLogFileMutation(
    reviewActionLog: AiReviewActionLogState,
    input: AiTrackedFileMutationInput,
    decision: "keep" | "reject",
): AiReviewActionLogState {
    const target = reviewActionLogTargetFromInput(input);
    const file = resolveReviewTarget(reviewActionLog, target);
    if (!file || !isReviewTargetVersionCurrent(file, target)) {
        return reviewActionLog;
    }

    return decision === "keep"
        ? keepReviewFile(reviewActionLog, target)
        : rejectReviewFile(reviewActionLog, target);
}

function resolveOptimisticActionLogHunkMutation(
    reviewActionLog: AiReviewActionLogState,
    input: AiTrackedFileHunkMutationInput,
    decision: "keep" | "reject",
): AiReviewActionLogState {
    const target = reviewActionLogTargetFromInput(input);
    const file = resolveReviewTarget(reviewActionLog, target);
    if (!file || !isReviewTargetVersionCurrent(file, target)) {
        return reviewActionLog;
    }

    return decision === "keep"
        ? keepReviewRanges(reviewActionLog, target, input.hunkIds)
        : rejectReviewRanges(reviewActionLog, target, input.hunkIds);
}

function resolveTrackedFileMutationTarget(
    snapshot: AiSessionSnapshot,
    input: AiTrackedFileHunkMutationInput | AiTrackedFileMutationInput,
): AiTrackedFile | null {
    const trackedFile = input.trackedFileId
        ? snapshot.trackedFiles.find(
              (candidate) => candidate.identityKey === input.trackedFileId,
          )
        : snapshot.trackedFiles.find((candidate) =>
              matchesTrackedFilePath(candidate, input.path),
          );
    if (!trackedFile || !isTrackedFileMutationTargetCurrent(trackedFile, input)) {
        return null;
    }

    return trackedFile;
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

function getComandoApi() {
    if (!window.comando) {
        throw new Error(
            "The desktop bridge is not available yet. Restart the Electron app and try again.",
        );
    }

    return window.comando;
}

function getRuntimeDisplayName(runtimeId: AiRuntimeId): string {
    switch (runtimeId) {
        case "claude":
            return "Claude";
        case "grok":
            return "Grok";
        case "kilo":
            return "Kilo";
        case "opencode":
            return "OpenCode";
        case "codex":
        default:
            return "Codex";
    }
}
