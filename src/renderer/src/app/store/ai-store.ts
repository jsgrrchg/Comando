import { create } from "zustand";

import type {
    AiFileContextAttachment,
    AiImageAttachment,
    AiMessage,
    AiRuntimeAuthDisconnectInput,
    AiRuntimeAuthLaunchInput,
    AiRuntimeAuthLogoutInput,
    AiPermissionResponseInput,
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
    AiTrackedFileHunkMutationInput,
    AiTrackedFileMutationInput,
    AiUserInputResponseInput,
    ClaudeRuntimeSettings,
    CodexRuntimeSettings,
    ClaudeRuntimeSettingsInput,
    GeminiRuntimeSettings,
    GeminiRuntimeSettingsInput,
    GrokRuntimeSettings,
    GrokRuntimeSettingsInput,
    KiloRuntimeSettings,
    KiloRuntimeSettingsInput,
    OpenCodeRuntimeSettings,
    OpenCodeRuntimeSettingsInput,
    SecretValuePatch,
} from "@shared/ipc";
import { resolveTrackedFileHunks } from "@shared/ai-tracked-file";
import { isSessionBusyErrorMessage } from "@shared/ai-errors";

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
    buildAiSessionTranscriptModelFromSnapshot,
    createEmptyAiSessionTranscriptModel,
    getSnapshotTranscriptMergeOptions,
    mergeAiSessionTranscriptSources,
    shouldPreserveCurrentAiSessionTranscript,
    writeAiSessionTranscriptToSnapshot,
    type AiSessionTranscriptModel,
} from "@renderer/app/ai/transcriptModel";
import { matchesTrackedFilePath } from "@renderer/app/ai/trackedFilePath";
import { collectExternalComposerRoots } from "@renderer/components/workspace/chat/composerParts";
import type {
    RuntimeWorkspaceChatTab,
    RuntimeWorkspaceReviewTab,
} from "../workspace/tree";
import { useWorkspaceStore } from "./workspace-store";

type RuntimeAiSessionTab = RuntimeWorkspaceChatTab | RuntimeWorkspaceReviewTab;

interface RegisteredSessionMeta {
    readonly projectId: string | null;
    readonly runtimeId: AiRuntimeId;
    readonly title: string;
    readonly worktreeId: string | null;
}

interface ResolveIncomingSnapshotOptions {
    readonly changedKeys?: ReadonlySet<keyof AiSessionPatch["changes"]> | null;
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

interface AiSessionClientState {
    readonly activeDispatchToken: string | null;
    readonly activeQueuedPrompt: ActiveQueuedPromptState | null;
    readonly draftAttachments: readonly AiImageAttachment[];
    readonly draftComposerParts: readonly AiComposerDraftPart[];
    readonly draftFileContexts: readonly AiFileContextAttachment[];
    readonly dismissedPlanUpdatedAt: string | null;
    readonly diffZoom: number | null;
    readonly editingQueuedPromptState: QueuedPromptEditState | null;
    readonly editingQueuedPrompt: QueuedPrompt | null;
    readonly hydrated: boolean;
    readonly incomingSnapshotVersion: number;
    readonly isDispatching: boolean;
    readonly isHydrating: boolean;
    readonly lastIncomingSnapshotUpdatedAt: string | null;
    readonly localError: string | null;
    readonly meta: RegisteredSessionMeta | null;
    readonly queue: readonly QueuedPrompt[];
    // True after the user cancels an inference while there are still queued
    // prompts. While paused, drainQueueIfNeeded is a no-op even when the
    // agent becomes idle. Pause is released the next time the user manually
    // sends a prompt (either through the composer or an explicit Send Now on
    // a queued item), at which point that prompt dispatches and the rest of
    // the queue resumes draining when its turn completes.
    readonly queuePaused: boolean;
    readonly snapshot: AiSessionSnapshot | null;
    readonly transcript: AiSessionTranscriptModel;
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
    readonly geminiSettings: GeminiRuntimeSettings;
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
    saveGeminiRuntimeSettings: (
        settings: GeminiRuntimeSettingsInput,
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
    setSessionMode: (input: AiSessionModeMutationInput) => Promise<void>;
    setSessionModel: (input: AiSessionModelMutationInput) => Promise<void>;
    setSessionConfigOption: (
        input: AiSessionConfigOptionMutationInput,
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

const activeQueueDrainSessionIds = new Set<string>();
const pendingQueueDrainSessionIds = new Set<string>();

export const useAiStore = create<AiStore>((set, get) => ({
    claudeSettings: createEmptyClaudeSettings(),
    codexBinaryPath: "",
    codexSettings: createEmptyCodexSettings(),
    geminiSettings: createEmptyGeminiSettings(),
    grokSettings: createEmptyGrokSettings(),
    kiloSettings: createEmptyKiloSettings(),
    opencodeSettings: createEmptyOpenCodeSettings(),
    runtimeCatalogById: {},
    runtimeStatusById: {},
    sessions: {},

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
                        activeQueuedPrompt: null,
                        editingQueuedPromptState: null,
                        editingQueuedPrompt: null,
                        queue: [],
                        queuePaused: false,
                    },
                },
            };
        });
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

    applySessionEvent: (event) => {
        let syncedTitle: string | null = null;
        set((state) => {
            const session =
                state.sessions[event.sessionId] ?? createSessionState();
            const existingCatalog = state.runtimeCatalogById[event.runtimeId] ?? null;
            const baseSnapshot =
                session.snapshot ??
                createSessionSnapshotFromEvent(event, existingCatalog);
            const nextTranscript = applyAiSessionDomainEventToTranscript(
                getSessionTranscript(session, baseSnapshot),
                event,
            );
            const nextSnapshot = writeAiSessionTranscriptToSnapshot(
                applySessionDomainEventToSnapshot(baseSnapshot, event),
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
                    [event.sessionId]: {
                        ...session,
                        ...reconcileDispatchStateForIncomingSnapshot(
                            session,
                            nextSnapshot,
                        ),
                        hydrated: true,
                        ...resolveIncomingSnapshotProgress(
                            session,
                            nextSnapshot.updatedAt,
                        ),
                        isHydrating: false,
                        localError: nextSnapshot.lastError,
                        meta: nextMeta,
                        snapshot: nextSnapshot,
                        transcript: nextTranscript,
                    },
                },
            };
        });

        if (syncedTitle !== null) {
            void useWorkspaceStore
                .getState()
                .updateSessionTabTitles(event.sessionId, syncedTitle);
        }

        void drainQueueIfNeeded(event.sessionId, get, set);
    },

    applySessionUpdate: (update) => {
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
                                ...reconcileDispatchStateForIncomingSnapshot(
                                    session,
                                    nextSnapshot,
                                ),
                                hydrated: true,
                                ...resolveIncomingSnapshotProgress(
                                    session,
                                    incomingSnapshot.updatedAt,
                                ),
                                isHydrating: false,
                                localError: nextSnapshot.lastError,
                                meta: nextMeta,
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
            const resolvedCatalog = hasCatalogChanges(update.patch.changes)
                ? extractRuntimeCatalog(nextSnapshot)
                : null;
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
                        ...reconcileDispatchStateForIncomingSnapshot(
                            session,
                            incomingSnapshot,
                        ),
                        hydrated: true,
                        ...resolveIncomingSnapshotProgress(
                            session,
                            incomingSnapshot.updatedAt,
                        ),
                        isHydrating: false,
                        localError: nextSnapshot.lastError,
                        meta: nextMeta,
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

        void drainQueueIfNeeded(update.patch.sessionId, get, set);
    },

    applySessionSnapshot: (snapshot) => {
        let syncedTitle: string | null = null;
        set((state) => {
            const session =
                state.sessions[snapshot.sessionId] ?? createSessionState();
            const existingCatalog =
                state.runtimeCatalogById[snapshot.runtimeId] ?? null;
            const nextSnapshot =
                existingCatalog && hasRuntimeCatalog(existingCatalog)
                    ? mergeRuntimeCatalogIntoSnapshot(
                          snapshot,
                          existingCatalog,
                      )
                    : snapshot;
            const resolved = resolveIncomingSessionSnapshot(
                nextSnapshot,
                session,
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
            const nextCatalog = extractRuntimeCatalog(resolvedSnapshot);

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
                        ...reconcileDispatchStateForIncomingSnapshot(
                            session,
                            nextSnapshot,
                        ),
                        hydrated: true,
                        ...resolveIncomingSnapshotProgress(
                            session,
                            nextSnapshot.updatedAt,
                        ),
                        isHydrating: false,
                        localError: resolvedSnapshot.lastError,
                        meta: nextMeta,
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

        void drainQueueIfNeeded(snapshot.sessionId, get, set);
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
        get().registerSessionTab(tab);
        const currentSession = get().sessions[tab.sessionId];

        if (
            !options?.force &&
            (currentSession?.hydrated || currentSession?.isHydrating)
        ) {
            return;
        }

        set((state) => ({
            sessions: {
                ...state.sessions,
                [tab.sessionId]: {
                    ...(state.sessions[tab.sessionId] ?? createSessionState()),
                    isHydrating: true,
                    meta: buildSessionMeta(tab),
                },
            },
        }));

        try {
            const runtimeStatusPromise = getComandoApi()
                .getAiRuntimeStatus(tab.runtimeId)
                .then((runtimeStatus) => {
                    const runtimeCatalog =
                        extractRuntimeCatalogFromStatus(runtimeStatus);

                    set((state) => {
                        const existingSession =
                            state.sessions[tab.sessionId] ??
                            createSessionState();
                        const existingSnapshot =
                            existingSession.snapshot ??
                            createEmptySessionSnapshot(
                                tab,
                                state.runtimeCatalogById[tab.runtimeId] ?? null,
                            );
                        const nextCatalog =
                            runtimeCatalog && hasRuntimeCatalog(runtimeCatalog)
                                ? runtimeCatalog
                                : (state.runtimeCatalogById[tab.runtimeId] ??
                                  null);

                        return {
                            runtimeCatalogById:
                                nextCatalog && hasRuntimeCatalog(nextCatalog)
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
                                    ...existingSession,
                                    snapshot:
                                        nextCatalog &&
                                        hasRuntimeCatalog(nextCatalog)
                                            ? mergeRuntimeCatalogIntoSnapshot(
                                                  existingSnapshot,
                                                  nextCatalog,
                                              )
                                            : existingSnapshot,
                                },
                            },
                        };
                    });

                    return runtimeStatus;
                });
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
                        await getComandoApi().getAiSessionSnapshot(
                            tab.sessionId,
                        );
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
                const runtimeCatalog =
                    extractRuntimeCatalogFromStatus(runtimeStatus);
                const nextCatalog =
                    runtimeCatalog && hasRuntimeCatalog(runtimeCatalog)
                        ? runtimeCatalog
                        : (state.runtimeCatalogById[tab.runtimeId] ??
                          extractRuntimeCatalog(resolvedSnapshot));
                const incomingSnapshot = hasRuntimeCatalog(nextCatalog)
                    ? mergeRuntimeCatalogIntoSnapshot(
                          resolvedSnapshot,
                          nextCatalog,
                      )
                    : resolvedSnapshot;
                const currentSession = state.sessions[tab.sessionId];
                const resolved = resolveIncomingSessionSnapshot(
                    incomingSnapshot,
                    currentSession,
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
                            hydrated: true,
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
                            isHydrating: false,
                            meta: buildSessionMeta(tab),
                            snapshot: nextSnapshot,
                            transcript: nextTranscript,
                        },
                    },
                };
            });
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
                        ...(state.sessions[tab.sessionId] ??
                            createSessionState()),
                        // Keep `hydrated: false` so a subsequent ensureSession
                        // call (tab re-focus, window restore) can retry instead
                        // of landing on the early-return that treats hydrated
                        // as "done forever".
                        hydrated: false,
                        isHydrating: false,
                        localError:
                            error instanceof Error
                                ? error.message
                                : `Could not hydrate the ${getRuntimeDisplayName(tab.runtimeId)} session.`,
                        meta: buildSessionMeta(tab),
                        snapshot: createEmptySessionSnapshot(
                            tab,
                            state.runtimeCatalogById[tab.runtimeId] ?? null,
                        ),
                        transcript: createEmptyAiSessionTranscriptModel(),
                    },
                },
            }));
        }
    },

    hydrateSettings: (settings) => {
        set({
            claudeSettings: settings?.claude ?? createEmptyClaudeSettings(),
            codexBinaryPath: settings?.codex.binaryPath ?? "",
            codexSettings: settings?.codex ?? createEmptyCodexSettings(),
            geminiSettings: settings?.gemini ?? createEmptyGeminiSettings(),
            grokSettings: settings?.grok ?? createEmptyGrokSettings(),
            kiloSettings: settings?.kilo ?? createEmptyKiloSettings(),
            opencodeSettings:
                settings?.opencode ?? createEmptyOpenCodeSettings(),
        });
    },

    keepAllTrackedFiles: async (sessionId) => {
        await runOptimisticSnapshotMutation(
            sessionId,
            (snapshot) => ({
                ...snapshot,
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
            (snapshot) => removeTrackedFileFromSnapshot(snapshot, input.path),
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
                        createSessionState(persistedPreferences)),
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
                },
            },
        }));
    },

    rejectAllTrackedFiles: async (sessionId) => {
        await runOptimisticSnapshotMutation(
            sessionId,
            (snapshot) => ({
                ...snapshot,
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
            (snapshot) => removeTrackedFileFromSnapshot(snapshot, input.path),
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
            geminiSettings: snapshot.ai?.gemini ?? state.geminiSettings,
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
            geminiSettings: snapshot.ai?.gemini ?? state.geminiSettings,
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

    saveGeminiRuntimeSettings: async (settings) => {
        const status =
            await getComandoApi().saveGeminiRuntimeSettings(settings);
        const snapshot = await getComandoApi().getSettingsSnapshot();

        set((state) => ({
            geminiSettings: snapshot.ai?.gemini ?? state.geminiSettings,
            runtimeStatusById: {
                ...state.runtimeStatusById,
                gemini: status,
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

    setSessionMode: async (input) => {
        const snapshot = get().sessions[input.sessionId]?.snapshot ?? null;
        const modeConfig = snapshot ? getModeConfigOption(snapshot) : null;

        await runOptimisticSnapshotMutation(
            input.sessionId,
            (currentSnapshot) =>
                setModeOnSnapshot(currentSnapshot, input.modeId),
            () =>
                modeConfig?.type === "select" &&
                hasSelectConfigValue(modeConfig, input.modeId)
                    ? getComandoApi().setAiSessionConfigOption({
                          optionId: modeConfig.id,
                          sessionId: input.sessionId,
                          value: input.modeId,
                      })
                    : getComandoApi().setAiSessionMode(input),
            set,
            get,
        );
    },

    setSessionModel: async (input) => {
        const snapshot = get().sessions[input.sessionId]?.snapshot ?? null;
        const modelConfig = snapshot ? getModelConfigOption(snapshot) : null;

        await runOptimisticSnapshotMutation(
            input.sessionId,
            (currentSnapshot) =>
                setModelOnSnapshot(currentSnapshot, input.modelId),
            () =>
                modelConfig?.type === "select" &&
                hasSelectConfigValue(modelConfig, input.modelId)
                    ? getComandoApi().setAiSessionConfigOption({
                          optionId: modelConfig.id,
                          sessionId: input.sessionId,
                          value: input.modelId,
                      })
                    : getComandoApi().setAiSessionModel(input),
            set,
            get,
        );
    },

    setSessionConfigOption: async (input) => {
        await runOptimisticSnapshotMutation(
            input.sessionId,
            (snapshot) =>
                setConfigOptionOnSnapshot(
                    snapshot,
                    input.optionId,
                    input.value,
                ),
            () => getComandoApi().setAiSessionConfigOption(input),
            set,
            get,
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
            (snapshot) => ({
                ...snapshot,
                title: input.title,
                updatedAt: new Date().toISOString(),
            }),
            () => getComandoApi().renameAiSession(input),
            set,
            get,
        );
    },

    sendQueuedPromptNow: async (sessionId, promptId) => {
        const session = get().sessions[sessionId];
        const queuedPrompt = session?.queue.find(
            (candidate) => candidate.id === promptId,
        );
        if (!session || !queuedPrompt || queuedPrompt.status === "sending") {
            return;
        }

        enqueuePrompt(
            sessionId,
            {
                ...queuedPrompt,
                status: "queued",
            },
            "head",
            set,
        );

        const latestSession = get().sessions[sessionId];
        if (!latestSession?.meta || !latestSession.snapshot) {
            return;
        }

        if (
            hasActiveLocalDispatch(latestSession) ||
            isBusySession(latestSession.snapshot)
        ) {
            try {
                await getComandoApi().cancelAiSession(sessionId);
            } catch (error) {
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
                                localError:
                                    error instanceof Error
                                        ? error.message
                                        : "Could not cancel the current response before steering.",
                            },
                        },
                    };
                });
                return;
            }
            // The cancel succeeded, so the steer action becomes the new
            // intentional queue owner. Resume before draining the selected head.
            resumeQueue(sessionId, set);
            await drainQueueIfNeeded(sessionId, get, set, {
                lockDrain: false,
            });
            return;
        }

        // Clicking Send Now on a queued prompt is an explicit resume: the
        // user is taking over what to dispatch next. Lift any pause so the
        // remainder of the queue drains after this turn ends.
        resumeQueue(sessionId, set);
        await drainQueueIfNeeded(sessionId, get, set, {
            lockDrain: false,
        });
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
        const queuedPrompt = createQueuedPrompt({
            additionalRoots: options.additionalRoots,
            attachments,
            composerPartsSnapshot: options.composerPartsSnapshot ?? [
                { text: trimmedPrompt, type: "text" },
            ],
            existing: editingQueuedPrompt,
            fileContextsSnapshot: options.fileContextsSnapshot ?? [],
            prompt: trimmedPrompt,
        });
        if (
            hasActiveLocalDispatch(session) ||
            (session.snapshot ? isBusySession(session.snapshot) : false)
        ) {
            if (editingQueuedPrompt) {
                commitQueuedPromptEdit(
                    tab.sessionId,
                    queuedPrompt,
                    set,
                    buildSessionMeta(tab),
                );
            } else {
                enqueuePrompt(
                    tab.sessionId,
                    queuedPrompt,
                    "tail",
                    set,
                    buildSessionMeta(tab),
                );
            }
            clearEditingQueuedPromptState(tab.sessionId, set);
            return;
        }

        // The user is manually sending a prompt with the agent idle. If the
        // queue was paused after a cancel, this is the explicit resume: the
        // rest of the queued prompts will drain when this turn completes.
        resumeQueue(tab.sessionId, set);

        if (editingQueuedPrompt) {
            commitQueuedPromptEdit(
                tab.sessionId,
                queuedPrompt,
                set,
                buildSessionMeta(tab),
            );
            clearEditingQueuedPromptState(tab.sessionId, set);
            await drainQueueIfNeeded(tab.sessionId, get, set, {
                lockDrain: false,
            });
            return;
        }

        enqueuePrompt(
            tab.sessionId,
            {
                ...queuedPrompt,
                status: "pending_dispatch",
            },
            "head",
            set,
            buildSessionMeta(tab),
        );
        clearEditingQueuedPromptState(tab.sessionId, set);

        await drainQueueIfNeeded(tab.sessionId, get, set, {
            lockDrain: false,
        });
    },
}));

function createSessionState(
    preferences?: SessionReviewPreferences | null,
): AiSessionClientState {
    return {
        activeDispatchToken: null,
        activeQueuedPrompt: null,
        draftAttachments: [],
        draftComposerParts: createEmptyComposerDraftParts(),
        draftFileContexts: [],
        dismissedPlanUpdatedAt: null,
        diffZoom: preferences?.diffZoom ?? null,
        editingQueuedPromptState: null,
        editingQueuedPrompt: null,
        hydrated: false,
        incomingSnapshotVersion: 0,
        isDispatching: false,
        isHydrating: false,
        lastIncomingSnapshotUpdatedAt: null,
        localError: null,
        meta: null,
        queue: [],
        queuePaused: false,
        snapshot: null,
        transcript: createEmptyAiSessionTranscriptModel(),
    };
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

function createEmptyGeminiSettings(): GeminiRuntimeSettings {
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
            : "AI Session";

    return {
        activeTurnStartedAt:
            event.kind === "status" ? event.activeTurnStartedAt : null,
        availableCommands: catalog?.availableCommands ?? [],
        closedAt: null,
        configOptions: catalog?.configOptions ?? [],
        lastError: event.kind === "status" ? event.lastError : null,
        messages: [],
        modeId: catalog?.modeId ?? null,
        modes: catalog?.modes ?? [],
        modelId: catalog?.modelId ?? null,
        models: catalog?.models ?? [],
        pendingPermission:
            event.kind === "permission-request" ? event.request : null,
        pendingUserInput:
            event.kind === "user-input-request" ? event.request : null,
        plan: event.kind === "plan" ? event.plan : null,
        parentSessionId: event.parentSessionId,
        projectId: event.kind === "session-info" ? event.projectId : null,
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
        case "status":
            return {
                ...snapshot,
                activeTurnStartedAt: event.activeTurnStartedAt,
                lastError: event.lastError,
                runtimeSessionId:
                    event.runtimeSessionId ?? snapshot.runtimeSessionId,
                status: event.status,
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
        case "subagent-created":
            return {
                ...snapshot,
                parentSessionId: event.parentSessionId,
                runtimeSessionId:
                    event.runtimeSessionId ?? snapshot.runtimeSessionId,
                title: event.title,
                updatedAt: event.updatedAt,
            };
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

    const nextActivities = [...activity];
    nextActivities[index] = nextActivity;
    return nextActivities;
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

function resolveIncomingSessionSnapshot(
    incomingSnapshot: AiSessionSnapshot,
    currentSession: AiSessionClientState | null | undefined,
    options: ResolveIncomingSnapshotOptions = {},
): ResolvedIncomingSessionSnapshot {
    const incomingTranscript =
        buildAiSessionTranscriptModelFromSnapshot(incomingSnapshot);
    const session = currentSession ?? null;
    const currentSnapshot = session?.snapshot ?? null;
    if (
        !session ||
        !currentSnapshot ||
        currentSnapshot.sessionId !== incomingSnapshot.sessionId
    ) {
        return {
            snapshot: writeAiSessionTranscriptToSnapshot(
                incomingSnapshot,
                incomingTranscript,
            ),
            transcript: incomingTranscript,
        };
    }

    const currentTranscript = getSessionTranscript(
        session,
        currentSnapshot,
    );
    const changedKeys = options.changedKeys ?? null;
    const incomingIsFreshEnough = isUpdatedAtAtLeast(
        session.lastIncomingSnapshotUpdatedAt ?? currentSnapshot.updatedAt,
        incomingSnapshot.updatedAt,
    );

    if (
        !incomingIsFreshEnough &&
        session.hydrated &&
        (currentTranscript.messageOrder.length > 0 ||
            incomingTranscript.messageOrder.length > 0)
    ) {
        return {
            snapshot: writeAiSessionTranscriptToSnapshot(
                mergeHydrationMetadataIntoCurrent(currentSnapshot, incomingSnapshot),
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
                incomingSnapshot,
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
                incomingSnapshot,
                nextTranscript,
            ),
            transcript: nextTranscript,
        };
    }

    return {
        snapshot: writeAiSessionTranscriptToSnapshot(
            mergeHydrationMetadataIntoCurrent(currentSnapshot, incomingSnapshot),
            currentTranscript,
        ),
        transcript: currentTranscript,
    };
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
    return {
        ...snapshot,
        ...patch.changes,
        runtimeId: snapshot.runtimeId,
        sessionId: snapshot.sessionId,
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

async function dispatchPrompt(
    meta: {
        readonly additionalRoots?: readonly string[];
        readonly composerParts?: readonly AiComposerDraftPart[];
        readonly projectId: string | null;
        readonly runtimeId: AiRuntimeId;
        readonly sessionId: string;
        readonly title: string;
        readonly worktreeId: string | null;
    },
    messageId: string,
    prompt: string,
    attachments: readonly AiImageAttachment[],
    set: SetAiState,
): Promise<"deferred" | "sent"> {
    const dispatchToken = crypto.randomUUID();

    set((state) => {
        const session = state.sessions[meta.sessionId] ?? createSessionState();

        return {
            sessions: {
                ...state.sessions,
                [meta.sessionId]: {
                    ...session,
                    activeDispatchToken: dispatchToken,
                    isDispatching: true,
                    localError: null,
                },
            },
        };
    });

    let result: "deferred" | "sent" = "sent";

    try {
        await getComandoApi().sendAiPrompt({
            additionalRoots: meta.additionalRoots,
            attachments,
            composerParts: meta.composerParts,
            messageId,
            projectId: meta.projectId,
            prompt,
            runtimeId: meta.runtimeId,
            sessionId: meta.sessionId,
            title: meta.title,
            worktreeId: meta.worktreeId,
        });
    } catch (error) {
        if (isSessionBusyError(error)) {
            set((state) => {
                const session =
                    state.sessions[meta.sessionId] ?? createSessionState();
                if (session.activeDispatchToken !== dispatchToken) {
                    return state;
                }

                return {
                    sessions: {
                        ...state.sessions,
                        [meta.sessionId]: {
                            ...session,
                            localError: null,
                            snapshot: session.snapshot
                                ? {
                                      ...session.snapshot,
                                      status: "starting",
                                      updatedAt: session.snapshot.updatedAt,
                                  }
                                : session.snapshot,
                        },
                    },
                };
            });
            result = "deferred";
            return result;
        }

        set((state) => {
            const session =
                state.sessions[meta.sessionId] ?? createSessionState();
            if (session.activeDispatchToken !== dispatchToken) {
                return state;
            }
            const message =
                error instanceof Error
                    ? error.message
                    : `Could not send the prompt to ${getRuntimeDisplayName(meta.runtimeId)}.`;

            return {
                sessions: {
                    ...state.sessions,
                    [meta.sessionId]: {
                        ...session,
                        activeDispatchToken: null,
                        isDispatching: false,
                        localError: message,
                        snapshot: session.snapshot
                            ? {
                                  ...session.snapshot,
                                  activeTurnStartedAt: null,
                                  lastError: message,
                                  status: "error",
                                  updatedAt: session.snapshot.updatedAt,
                              }
                            : session.snapshot,
                    },
                },
            };
        });
        throw error;
    } finally {
        set((state) => {
            const session =
                state.sessions[meta.sessionId] ?? createSessionState();
            if (session.activeDispatchToken !== dispatchToken) {
                return state;
            }

            return {
                sessions: {
                    ...state.sessions,
                    [meta.sessionId]: {
                        ...session,
                        activeDispatchToken: null,
                        isDispatching: false,
                    },
                },
            };
        });
    }

    return result;
}

async function drainQueueIfNeeded(
    sessionId: string,
    get: GetAiState,
    set: SetAiState,
    options: {
        readonly lockDrain?: boolean;
    } = {},
): Promise<void> {
    const lockDrain = options.lockDrain ?? true;
    if (lockDrain && activeQueueDrainSessionIds.has(sessionId)) {
        pendingQueueDrainSessionIds.add(sessionId);
        return;
    }

    const session = get().sessions[sessionId];
    if (
        !session ||
        hasActiveLocalDispatch(session) ||
        !session.meta ||
        !session.snapshot ||
        session.queue.length === 0 ||
        session.queuePaused ||
        isBusySession(session.snapshot) ||
        isClosedSubagentSession(session.snapshot)
    ) {
        return;
    }

    const nextQueuedPromptIndex = session.queue.findIndex((queuedPrompt) =>
        isDispatchableQueuedPrompt(queuedPrompt),
    );
    const nextQueuedPrompt =
        nextQueuedPromptIndex >= 0
            ? session.queue[nextQueuedPromptIndex]
            : null;
    if (!nextQueuedPrompt || nextQueuedPromptIndex < 0) {
        return;
    }

    const activeQueuedPrompt = activateQueuedPromptForDrain(
        sessionId,
        nextQueuedPrompt.id,
        set,
    );
    if (!activeQueuedPrompt) {
        return;
    }

    if (lockDrain) {
        activeQueueDrainSessionIds.add(sessionId);
    }
    let shouldDrainAfterUnlock = false;
    try {
        const result = await dispatchPrompt(
            {
                additionalRoots:
                    activeQueuedPrompt.queuedPrompt.additionalRoots ??
                    collectExternalComposerRoots(
                        activeQueuedPrompt.queuedPrompt.composerPartsSnapshot,
                    ),
                composerParts:
                    activeQueuedPrompt.queuedPrompt.composerPartsSnapshot,
                projectId: session.meta.projectId,
                runtimeId: session.meta.runtimeId,
                sessionId,
                title: session.meta.title,
                worktreeId: session.meta.worktreeId,
            },
            activeQueuedPrompt.queuedPrompt.id,
            activeQueuedPrompt.queuedPrompt.prompt,
            activeQueuedPrompt.queuedPrompt.attachments,
            set,
        );

        if (result === "sent") {
            // The backend is now busy handling this prompt. Don't drain the
            // next queued item here — it would race the "starting" patch and
            // get rejected as busy. The patch pipeline (applySessionPatch /
            // applySessionSnapshot) calls drainQueueIfNeeded whenever the
            // session transitions back to idle. If that idle snapshot already
            // arrived while IPC was still resolving, reconcile it after this
            // drain lock is released.
            shouldDrainAfterUnlock =
                completeActiveQueuedPromptAfterSuccessfulDispatch(
                    sessionId,
                    activeQueuedPrompt,
                    get,
                    set,
                );
            return;
        }

        restoreActiveQueuedPrompt(
            sessionId,
            activeQueuedPrompt,
            "pending_dispatch",
            set,
        );
    } catch {
        restoreActiveQueuedPrompt(
            sessionId,
            activeQueuedPrompt,
            "failed",
            set,
        );
    } finally {
        if (lockDrain) {
            activeQueueDrainSessionIds.delete(sessionId);
        }
        const hasPendingDrain =
            lockDrain && pendingQueueDrainSessionIds.delete(sessionId);
        if (shouldDrainAfterUnlock || hasPendingDrain) {
            await drainQueueIfNeeded(sessionId, get, set);
        }
    }
}

function createQueuedPrompt(input: {
    readonly additionalRoots?: readonly string[];
    readonly attachments: readonly AiImageAttachment[];
    readonly composerPartsSnapshot: readonly AiComposerDraftPart[];
    readonly existing?: QueuedPrompt | null;
    readonly fileContextsSnapshot: readonly AiFileContextAttachment[];
    readonly prompt: string;
}): QueuedPrompt {
    return {
        additionalRoots: input.additionalRoots,
        attachments: cloneDraftAttachments(input.attachments),
        composerPartsSnapshot: cloneComposerDraftParts(
            input.composerPartsSnapshot,
        ),
        createdAt: input.existing?.createdAt ?? new Date().toISOString(),
        fileContextsSnapshot: cloneDraftFileContexts(
            input.fileContextsSnapshot,
        ),
        id: input.existing?.id ?? crypto.randomUUID(),
        prompt: input.prompt,
        status: "queued",
    };
}

function isDispatchableQueuedPrompt(queuedPrompt: QueuedPrompt): boolean {
    return (
        queuedPrompt.status === "pending_dispatch" ||
        queuedPrompt.status === "queued"
    );
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
                      createdAt: queuedPrompt.createdAt,
                      id: queuedPrompt.id,
                      kind: "user",
                      status: "completed",
                  },
              ],
        pendingPermission: null,
        pendingUserInput: null,
        status: "starting",
        updatedAt: baseSnapshot.updatedAt,
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
    if (queuedPrompt.prompt.trim()) {
        return queuedPrompt.prompt.trim();
    }

    return queuedPrompt.composerPartsSnapshot
        .map((part) => {
            switch (part.type) {
                case "text":
                    return part.text;
                case "file_mention":
                case "folder_mention":
                case "file_attachment":
                case "git_commit_mention":
                case "github_issue_mention":
                case "github_pull_request_mention":
                case "selection_mention":
                    return part.label;
                case "fetch_mention":
                    return "@fetch";
                case "plan_mention":
                    return "/plan";
            }
        })
        .join("")
        .trim();
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

function commitQueuedPromptEdit(
    sessionId: string,
    queuedPrompt: QueuedPrompt,
    set: SetAiState,
    meta?: RegisteredSessionMeta,
): void {
    set((state) => {
        const session = state.sessions[sessionId] ?? createSessionState();

        return {
            sessions: {
                ...state.sessions,
                [sessionId]: {
                    ...session,
                    meta: meta ?? session.meta,
                    queue: insertQueuedPromptAtEditPosition(
                        session.queue,
                        queuedPrompt,
                        session.editingQueuedPromptState,
                    ),
                },
            },
        };
    });
}

function enqueuePrompt(
    sessionId: string,
    queuedPrompt: QueuedPrompt,
    position: "head" | "tail",
    set: SetAiState,
    meta?: RegisteredSessionMeta,
): void {
    set((state) => {
        const session = state.sessions[sessionId] ?? createSessionState();
        const remainingQueue = session.queue.filter(
            (candidate) => candidate.id !== queuedPrompt.id,
        );
        const queue =
            position === "head"
                ? [queuedPrompt, ...remainingQueue]
                : [...remainingQueue, queuedPrompt];

        return {
            sessions: {
                ...state.sessions,
                [sessionId]: {
                    ...session,
                    meta: meta ?? session.meta,
                    queue,
                },
            },
        };
    });
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

function activateQueuedPromptForDrain(
    sessionId: string,
    promptId: string,
    set: SetAiState,
): ActiveQueuedPromptState | null {
    let activeQueuedPrompt: ActiveQueuedPromptState | null = null;

    set((state) => {
        const session = state.sessions[sessionId];
        if (!session || session.activeQueuedPrompt) {
            return state;
        }

        const queueIndex = session.queue.findIndex(
            (candidate) => candidate.id === promptId,
        );
        const queuedPrompt = session.queue[queueIndex];
        if (!queuedPrompt || !isDispatchableQueuedPrompt(queuedPrompt)) {
            return state;
        }

        activeQueuedPrompt = {
            activatedAfterIncomingSnapshotVersion:
                session.incomingSnapshotVersion,
            position: createQueuedPromptPositionState(
                session.queue,
                queueIndex,
            ),
            queuedPrompt: {
                ...queuedPrompt,
                status: "sending",
            },
        };

        const nextSession = applyLocalPromptAcceptanceToSession(
            {
                ...session,
                activeQueuedPrompt,
                queue: session.queue.filter(
                    (candidate) => candidate.id !== promptId,
                ),
            },
            queuedPrompt,
        );

        return {
            sessions: {
                ...state.sessions,
                [sessionId]: nextSession,
            },
        };
    });

    return activeQueuedPrompt;
}

function restoreActiveQueuedPrompt(
    sessionId: string,
    activeQueuedPrompt: ActiveQueuedPromptState,
    status: QueuedPrompt["status"],
    set: SetAiState,
): void {
    set((state) => {
        const session = state.sessions[sessionId];
        if (
            !session ||
            session.activeQueuedPrompt?.queuedPrompt.id !==
                activeQueuedPrompt.queuedPrompt.id
        ) {
            return state;
        }

        return {
            sessions: {
                ...state.sessions,
                [sessionId]: {
                    ...session,
                    activeQueuedPrompt: null,
                    queue: insertQueuedPromptAtPosition(
                        session.queue,
                        {
                            ...activeQueuedPrompt.queuedPrompt,
                            status,
                        },
                        activeQueuedPrompt.position,
                    ),
                },
            },
        };
    });
}

function completeActiveQueuedPromptAfterSuccessfulDispatch(
    sessionId: string,
    activeQueuedPrompt: ActiveQueuedPromptState,
    get: GetAiState,
    set: SetAiState,
): boolean {
    let shouldDrainAfterUnlock = false;

    set((state) => {
        const session = state.sessions[sessionId];
        if (
            !session ||
            session.activeQueuedPrompt?.queuedPrompt.id !==
                activeQueuedPrompt.queuedPrompt.id ||
            !session.snapshot
        ) {
            return state;
        }

        shouldDrainAfterUnlock =
            hasIncomingSnapshotVersionAdvancedPastActiveQueuedPrompt(
                session,
                activeQueuedPrompt,
            ) &&
            session.queue.some((queuedPrompt) =>
                isDispatchableQueuedPrompt(queuedPrompt),
            ) &&
            !session.queuePaused &&
            !isBusySession(session.snapshot) &&
            !isClosedSubagentSession(session.snapshot);

        return {
            sessions: {
                ...state.sessions,
                [sessionId]: {
                    ...session,
                    activeQueuedPrompt: null,
                },
            },
        };
    });

    return shouldDrainAfterUnlock && Boolean(get().sessions[sessionId]);
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

function resumeQueue(sessionId: string, set: SetAiState): void {
    set((state) => {
        const session = state.sessions[sessionId];
        if (!session || !session.queuePaused) {
            return state;
        }

        return {
            sessions: {
                ...state.sessions,
                [sessionId]: {
                    ...session,
                    queuePaused: false,
                },
            },
        };
    });
}

async function runOptimisticSnapshotMutation(
    sessionId: string,
    mutateSnapshot: (snapshot: AiSessionSnapshot) => AiSessionSnapshot,
    runRemote: () => Promise<void>,
    set: SetAiState,
    get: GetAiState,
): Promise<void> {
    const previousSession = get().sessions[sessionId] ?? null;
    const previousSnapshot = previousSession?.snapshot ?? null;

    if (previousSession && previousSnapshot) {
        set((state) => ({
            sessions: {
                ...state.sessions,
                [sessionId]: {
                    ...previousSession,
                    snapshot: mutateSnapshot(previousSnapshot),
                },
            },
        }));
    }

    try {
        await runRemote();
    } catch (error) {
        if (previousSession) {
            set((state) => ({
                sessions: {
                    ...state.sessions,
                    [sessionId]: previousSession,
                },
            }));
        }
        throw error;
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
        configOptions: snapshot.configOptions.map((option) =>
            option.type === "select" &&
            (option.category === "model" ||
                option.id.toLowerCase() === "model") &&
            hasSelectConfigValue(option, modelId)
                ? {
                      ...option,
                      value: modelId,
                  }
                : option,
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

    return {
        ...snapshot,
        configOptions: nextConfigOptions,
        modeId:
            updatedOption?.type === "select" &&
            updatedOption.category === "mode" &&
            typeof value === "string"
                ? value
                : snapshot.modeId,
        modelId:
            updatedOption?.type === "select" &&
            updatedOption.category === "model" &&
            typeof value === "string"
                ? value
                : snapshot.modelId,
        updatedAt: new Date().toISOString(),
    };
}

function removeTrackedFileFromSnapshot(
    snapshot: AiSessionSnapshot,
    path: string,
): AiSessionSnapshot {
    return {
        ...snapshot,
        trackedFiles: snapshot.trackedFiles.filter(
            (trackedFile) => !matchesTrackedFilePath(trackedFile, path),
        ),
        updatedAt: new Date().toISOString(),
    };
}

function resolveTrackedFileHunksInSnapshot(
    snapshot: AiSessionSnapshot,
    input: AiTrackedFileHunkMutationInput,
    decision: "keep" | "reject",
): AiSessionSnapshot {
    const nextTrackedFiles = snapshot.trackedFiles.flatMap((trackedFile) => {
        if (!matchesTrackedFilePath(trackedFile, input.path)) {
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

function isBusySession(snapshot: AiSessionSnapshot): boolean {
    return (
        snapshot.status === "starting" ||
        snapshot.status === "streaming" ||
        snapshot.status === "waiting_permission" ||
        snapshot.status === "waiting_user_input"
    );
}

function hasActiveLocalDispatch(session: AiSessionClientState): boolean {
    return Boolean(session.isDispatching || session.activeQueuedPrompt);
}

function reconcileDispatchStateForIncomingSnapshot(
    session: AiSessionClientState,
    snapshot: AiSessionSnapshot,
): Pick<
    AiSessionClientState,
    "activeDispatchToken" | "activeQueuedPrompt" | "isDispatching"
> {
    if (!session.activeQueuedPrompt) {
        return {
            activeDispatchToken: null,
            activeQueuedPrompt: null,
            isDispatching: false,
        };
    }

    if (
        doesIncomingSnapshotAdvancePastActiveQueuedPrompt(
            session,
            snapshot,
            session.activeQueuedPrompt,
        )
    ) {
        return {
            activeDispatchToken: null,
            activeQueuedPrompt: null,
            isDispatching: false,
        };
    }

    return {
        activeDispatchToken: session.activeDispatchToken,
        activeQueuedPrompt: session.activeQueuedPrompt,
        isDispatching: session.isDispatching,
    };
}

function doesIncomingSnapshotAdvancePastActiveQueuedPrompt(
    session: AiSessionClientState,
    snapshot: AiSessionSnapshot,
    activeQueuedPrompt: ActiveQueuedPromptState,
): boolean {
    return (
        resolveIncomingSnapshotProgress(session, snapshot.updatedAt)
            .incomingSnapshotVersion >
        activeQueuedPrompt.activatedAfterIncomingSnapshotVersion
    );
}

function hasIncomingSnapshotVersionAdvancedPastActiveQueuedPrompt(
    session: AiSessionClientState,
    activeQueuedPrompt: ActiveQueuedPromptState,
): boolean {
    return (
        session.incomingSnapshotVersion >
        activeQueuedPrompt.activatedAfterIncomingSnapshotVersion
    );
}

function isClosedSubagentSession(snapshot: AiSessionSnapshot): boolean {
    return Boolean(snapshot.parentSessionId && snapshot.closedAt);
}

function isSessionBusyError(error: unknown): boolean {
    // Match by a sentinel embedded in the error message so detection survives
    // Electron's IPC wrapping, which prefixes the original message and drops
    // custom Error subclasses and extra properties.
    return error instanceof Error && isSessionBusyErrorMessage(error.message);
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
        case "gemini":
            return "Gemini";
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
