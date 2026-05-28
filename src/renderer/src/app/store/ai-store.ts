import { create } from "zustand";

import type {
    AiFileContextAttachment,
    AiImageAttachment,
    AiRuntimeAuthDisconnectInput,
    AiRuntimeAuthLaunchInput,
    AiRuntimeAuthLogoutInput,
    AiPermissionResponseInput,
    AiRuntimeId,
    AiRuntimeStatus,
    AiSessionConfigOption,
    AiSessionConfigOptionMutationInput,
    AiSessionModeMutationInput,
    AiSessionModelMutationInput,
    AiSessionPatch,
    AiSessionRenameMutationInput,
    AiSessionSnapshot,
    AiSessionUpdate,
    AiSettingsSnapshot,
    AiTrackedFileHunkMutationInput,
    AiTrackedFileMutationInput,
    AiUserInputResponseInput,
    ClaudeRuntimeSettings,
    CodexRuntimeSettings,
    ClaudeRuntimeSettingsInput,
    GeminiRuntimeSettings,
    GeminiRuntimeSettingsInput,
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

interface QueuedPromptEditState {
    readonly nextPromptId: string | null;
    readonly previousComposerParts: readonly AiComposerDraftPart[];
    readonly previousDraftAttachments: readonly AiImageAttachment[];
    readonly previousDraftFileContexts: readonly AiFileContextAttachment[];
    readonly previousPromptId: string | null;
    readonly queueIndex: number;
}

interface AiSessionClientState {
    readonly draftAttachments: readonly AiImageAttachment[];
    readonly draftComposerParts: readonly AiComposerDraftPart[];
    readonly draftFileContexts: readonly AiFileContextAttachment[];
    readonly dismissedPlanUpdatedAt: string | null;
    readonly diffZoom: number | null;
    readonly editingQueuedPromptState: QueuedPromptEditState | null;
    readonly editingQueuedPrompt: QueuedPrompt | null;
    readonly hydrated: boolean;
    readonly isDispatching: boolean;
    readonly isHydrating: boolean;
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
    readonly kiloSettings: KiloRuntimeSettings;
    readonly opencodeSettings: OpenCodeRuntimeSettings;
    readonly runtimeCatalogById: Partial<Record<AiRuntimeId, AiRuntimeCatalog>>;
    readonly runtimeStatusById: Partial<Record<AiRuntimeId, AiRuntimeStatus>>;
    readonly sessions: Record<string, AiSessionClientState>;
    applyRuntimeStatus: (status: AiRuntimeStatus) => void;
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

export const useAiStore = create<AiStore>((set, get) => ({
    claudeSettings: createEmptyClaudeSettings(),
    codexBinaryPath: "",
    codexSettings: createEmptyCodexSettings(),
    geminiSettings: createEmptyGeminiSettings(),
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

    applySessionUpdate: (update) => {
        if (update.kind === "snapshot") {
            get().applySessionSnapshot(update.snapshot);
            return;
        }

        let syncedTitle: string | null = null;
        set((state) => {
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

            if (!baseSnapshot) {
                const nextCatalog = hasCatalogChanges(update.patch.changes)
                    ? applyCatalogPatchToCatalog(
                          state.runtimeCatalogById[update.patch.runtimeId] ??
                              EMPTY_RUNTIME_CATALOG,
                          update.patch.changes,
                      )
                    : null;

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

            const existingCatalog =
                state.runtimeCatalogById[update.patch.runtimeId] ?? null;
            const snapshotForPatch =
                existingCatalog && hasRuntimeCatalog(existingCatalog)
                    ? mergeRuntimeCatalogIntoSnapshot(
                          baseSnapshot,
                          existingCatalog,
                      )
                    : baseSnapshot;
            const nextSnapshot = applySessionPatch(
                snapshotForPatch,
                update.patch,
            );
            const nextCatalog = hasCatalogChanges(update.patch.changes)
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
                        hydrated: true,
                        isDispatching: false,
                        isHydrating: false,
                        localError: nextSnapshot.lastError,
                        meta: nextMeta,
                        snapshot: nextSnapshot,
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
        let titleChanged = false;
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
            const nextMeta = session.meta
                ? session.meta.title === nextSnapshot.title
                    ? session.meta
                    : { ...session.meta, title: nextSnapshot.title }
                : session.meta;
            titleChanged = nextMeta !== session.meta;
            const nextCatalog = extractRuntimeCatalog(nextSnapshot);

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
                        hydrated: true,
                        isDispatching: false,
                        isHydrating: false,
                        localError: nextSnapshot.lastError,
                        meta: nextMeta,
                        snapshot: nextSnapshot,
                    },
                },
            };
        });

        if (titleChanged) {
            void useWorkspaceStore
                .getState()
                .updateSessionTabTitles(
                    snapshot.sessionId,
                    snapshot.title,
                );
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
                const nextSnapshot = resolveIncomingSessionSnapshot(
                    incomingSnapshot,
                    currentSession,
                );

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
                            isHydrating: false,
                            meta: buildSessionMeta(tab),
                            snapshot: nextSnapshot,
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
        const queueIndex =
            session?.queue.findIndex(
                (candidate) => candidate.id === promptId,
            ) ?? -1;
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
            latestSession.isDispatching ||
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
            await drainQueueIfNeeded(sessionId, get, set);
            return;
        }

        // Clicking Send Now on a queued prompt is an explicit resume: the
        // user is taking over what to dispatch next. Lift any pause so the
        // remainder of the queue drains after this turn ends.
        resumeQueue(sessionId, set);

        removeQueuedPromptById(sessionId, promptId, set);

        try {
            const result = await dispatchPrompt(
                {
                    additionalRoots: collectExternalComposerRoots(
                        queuedPrompt.composerPartsSnapshot,
                    ),
                    projectId: latestSession.meta.projectId,
                    runtimeId: latestSession.meta.runtimeId,
                    sessionId,
                    title: latestSession.meta.title,
                    worktreeId: latestSession.meta.worktreeId,
                },
                queuedPrompt.prompt,
                queuedPrompt.attachments,
                set,
            );

            if (result === "sent") {
                // Let the snapshot-patch pipeline trigger the next drain when
                // the session returns to idle; draining now would race the
                // "starting" patch from the backend.
                return;
            }

            insertQueuedPromptAtIndex(
                sessionId,
                {
                    ...queuedPrompt,
                    status: "queued",
                },
                queueIndex,
                set,
            );
        } catch {
            insertQueuedPromptAtIndex(
                sessionId,
                {
                    ...queuedPrompt,
                    status: "failed",
                },
                queueIndex,
                set,
            );
        }
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
            attachments,
            composerPartsSnapshot: options.composerPartsSnapshot ?? [
                { text: trimmedPrompt, type: "text" },
            ],
            existing: editingQueuedPrompt,
            fileContextsSnapshot: options.fileContextsSnapshot ?? [],
            prompt: trimmedPrompt,
        });
        if (
            session.isDispatching ||
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
            await drainQueueIfNeeded(tab.sessionId, get, set);
            return;
        }

        const dispatchResult = await dispatchPrompt(
            {
                additionalRoots:
                    options.additionalRoots ??
                    collectExternalComposerRoots(
                        queuedPrompt.composerPartsSnapshot,
                    ),
                composerParts: queuedPrompt.composerPartsSnapshot,
                projectId: tab.projectId,
                runtimeId: tab.runtimeId,
                sessionId: tab.sessionId,
                title: tab.title,
                worktreeId: tab.worktreeId ?? null,
            },
            trimmedPrompt,
            attachments,
            set,
        );

        clearEditingQueuedPromptState(tab.sessionId, set);

        if (dispatchResult !== "sent") {
            enqueuePrompt(
                tab.sessionId,
                {
                    ...queuedPrompt,
                    status: "queued",
                },
                "head",
                set,
                buildSessionMeta(tab),
            );
        }
        // On "sent" the subsequent starting → idle snapshot patches drive the
        // drain, so no explicit drain is needed here.
    },
}));

function createSessionState(
    preferences?: SessionReviewPreferences | null,
): AiSessionClientState {
    return {
        draftAttachments: [],
        draftComposerParts: createEmptyComposerDraftParts(),
        draftFileContexts: [],
        dismissedPlanUpdatedAt: null,
        diffZoom: preferences?.diffZoom ?? null,
        editingQueuedPromptState: null,
        editingQueuedPrompt: null,
        hydrated: false,
        isDispatching: false,
        isHydrating: false,
        localError: null,
        meta: null,
        queue: [],
        queuePaused: false,
        snapshot: null,
    };
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
): AiSessionSnapshot {
    const currentSnapshot = currentSession?.snapshot ?? null;
    if (
        !currentSnapshot ||
        currentSnapshot.sessionId !== incomingSnapshot.sessionId
    ) {
        return incomingSnapshot;
    }

    const shouldPreserveCurrent =
        hasMoreTranscript(currentSnapshot, incomingSnapshot) ||
        (currentSession?.hydrated === true &&
            isSnapshotUpdatedAfter(currentSnapshot, incomingSnapshot));
    if (!shouldPreserveCurrent) {
        return incomingSnapshot;
    }

    return mergeHydrationMetadataIntoCurrent(
        currentSnapshot,
        incomingSnapshot,
    );
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

function isSnapshotUpdatedAfter(
    currentSnapshot: Pick<AiSessionSnapshot, "updatedAt">,
    incomingSnapshot: Pick<AiSessionSnapshot, "updatedAt">,
): boolean {
    const currentUpdatedAt = Date.parse(currentSnapshot.updatedAt);
    const incomingUpdatedAt = Date.parse(incomingSnapshot.updatedAt);
    return (
        Number.isFinite(currentUpdatedAt) &&
        Number.isFinite(incomingUpdatedAt) &&
        currentUpdatedAt > incomingUpdatedAt
    );
}

function hasMoreTranscript(
    currentSnapshot: Pick<AiSessionSnapshot, "messages">,
    incomingSnapshot: Pick<AiSessionSnapshot, "messages">,
): boolean {
    if (
        currentSnapshot.messages.length < incomingSnapshot.messages.length ||
        !hasCompatibleTranscriptPrefix(incomingSnapshot, currentSnapshot)
    ) {
        return false;
    }

    if (currentSnapshot.messages.length > incomingSnapshot.messages.length) {
        return true;
    }

    return (
        getTranscriptWeight(currentSnapshot) >
        getTranscriptWeight(incomingSnapshot)
    );
}

function hasCompatibleTranscriptPrefix(
    prefixSnapshot: Pick<AiSessionSnapshot, "messages">,
    candidateSnapshot: Pick<AiSessionSnapshot, "messages">,
): boolean {
    return prefixSnapshot.messages.every((message, index) => {
        const candidate = candidateSnapshot.messages[index];
        if (!candidate || candidate.kind !== message.kind) {
            return false;
        }

        if (message.id && candidate.id && message.id !== candidate.id) {
            return false;
        }

        return (
            candidate.content.startsWith(message.content) &&
            candidate.attachments.length >= message.attachments.length
        );
    });
}

function getTranscriptWeight(
    snapshot: Pick<AiSessionSnapshot, "messages">,
): number {
    return snapshot.messages.reduce(
        (total, message) =>
            total + message.content.length + message.attachments.length,
        0,
    );
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
    prompt: string,
    attachments: readonly AiImageAttachment[],
    set: SetAiState,
): Promise<"deferred" | "sent"> {
    set((state) => {
        const session = state.sessions[meta.sessionId] ?? createSessionState();

        return {
            sessions: {
                ...state.sessions,
                [meta.sessionId]: {
                    ...session,
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
                                      updatedAt: new Date().toISOString(),
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

            return {
                sessions: {
                    ...state.sessions,
                    [meta.sessionId]: {
                        ...session,
                        isDispatching: false,
                        localError:
                            error instanceof Error
                                ? error.message
                                : `Could not send the prompt to ${getRuntimeDisplayName(meta.runtimeId)}.`,
                    },
                },
            };
        });
        throw error;
    } finally {
        set((state) => {
            const session =
                state.sessions[meta.sessionId] ?? createSessionState();

            return {
                sessions: {
                    ...state.sessions,
                    [meta.sessionId]: {
                        ...session,
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
): Promise<void> {
    const session = get().sessions[sessionId];
    if (
        !session ||
        session.isDispatching ||
        !session.meta ||
        !session.snapshot ||
        session.queue.length === 0 ||
        session.queuePaused ||
        isBusySession(session.snapshot)
    ) {
        return;
    }

    const nextQueuedPrompt = session.queue.find(
        (queuedPrompt) => queuedPrompt.status === "queued",
    );
    const nextQueuedPromptIndex = session.queue.findIndex(
        (queuedPrompt) => queuedPrompt.status === "queued",
    );
    if (!nextQueuedPrompt || nextQueuedPromptIndex < 0) {
        return;
    }

    removeQueuedPromptById(sessionId, nextQueuedPrompt.id, set);

    try {
        const result = await dispatchPrompt(
            {
                additionalRoots: collectExternalComposerRoots(
                    nextQueuedPrompt.composerPartsSnapshot,
                ),
                composerParts: nextQueuedPrompt.composerPartsSnapshot,
                projectId: session.meta.projectId,
                runtimeId: session.meta.runtimeId,
                sessionId,
                title: session.meta.title,
                worktreeId: session.meta.worktreeId,
            },
            nextQueuedPrompt.prompt,
            nextQueuedPrompt.attachments,
            set,
        );

        if (result === "sent") {
            // The backend is now busy handling this prompt. Don't drain the
            // next queued item here — it would race the "starting" patch and
            // get rejected as busy. The patch pipeline (applySessionPatch /
            // applySessionSnapshot) calls drainQueueIfNeeded whenever the
            // session transitions back to idle, which is the only moment the
            // next prompt can be dispatched safely.
            return;
        }

        insertQueuedPromptAtIndex(
            sessionId,
            {
                ...nextQueuedPrompt,
                status: "queued",
            },
            nextQueuedPromptIndex,
            set,
        );
    } catch {
        insertQueuedPromptAtIndex(
            sessionId,
            {
                ...nextQueuedPrompt,
                status: "failed",
            },
            nextQueuedPromptIndex,
            set,
        );
    }
}

function createQueuedPrompt(input: {
    readonly attachments: readonly AiImageAttachment[];
    readonly composerPartsSnapshot: readonly AiComposerDraftPart[];
    readonly existing?: QueuedPrompt | null;
    readonly fileContextsSnapshot: readonly AiFileContextAttachment[];
    readonly prompt: string;
}): QueuedPrompt {
    return {
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

function createQueuedPromptEditState(input: {
    readonly currentComposerParts: readonly AiComposerDraftPart[];
    readonly queue: readonly QueuedPrompt[];
    readonly queueIndex: number;
    readonly session: AiSessionClientState;
}): QueuedPromptEditState {
    const normalizedQueueIndex =
        input.queueIndex < 0 ? input.queue.length : input.queueIndex;

    return {
        nextPromptId: input.queue[normalizedQueueIndex + 1]?.id ?? null,
        previousComposerParts: cloneComposerDraftParts(
            input.currentComposerParts,
        ),
        previousDraftAttachments: cloneDraftAttachments(
            input.session.draftAttachments,
        ),
        previousDraftFileContexts: cloneDraftFileContexts(
            input.session.draftFileContexts,
        ),
        previousPromptId:
            normalizedQueueIndex > 0
                ? (input.queue[normalizedQueueIndex - 1]?.id ?? null)
                : null,
        queueIndex: normalizedQueueIndex,
    };
}

function insertQueuedPromptAtEditPosition(
    queue: readonly QueuedPrompt[],
    queuedPrompt: QueuedPrompt,
    editState: QueuedPromptEditState | null,
): QueuedPrompt[] {
    const remainingQueue = queue.filter(
        (candidate) => candidate.id !== queuedPrompt.id,
    );
    if (!editState) {
        return [queuedPrompt, ...remainingQueue];
    }

    if (editState.nextPromptId) {
        const nextIndex = remainingQueue.findIndex(
            (candidate) => candidate.id === editState.nextPromptId,
        );
        if (nextIndex >= 0) {
            return [
                ...remainingQueue.slice(0, nextIndex),
                queuedPrompt,
                ...remainingQueue.slice(nextIndex),
            ];
        }
    }

    if (editState.previousPromptId) {
        const previousIndex = remainingQueue.findIndex(
            (candidate) => candidate.id === editState.previousPromptId,
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
        Math.max(editState.queueIndex, 0),
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

function insertQueuedPromptAtIndex(
    sessionId: string,
    queuedPrompt: QueuedPrompt,
    index: number,
    set: SetAiState,
): void {
    set((state) => {
        const session = state.sessions[sessionId] ?? createSessionState();
        const remainingQueue = session.queue.filter(
            (candidate) => candidate.id !== queuedPrompt.id,
        );
        const insertionIndex = Math.min(
            Math.max(index, 0),
            remainingQueue.length,
        );

        return {
            sessions: {
                ...state.sessions,
                [sessionId]: {
                    ...session,
                    queue: [
                        ...remainingQueue.slice(0, insertionIndex),
                        queuedPrompt,
                        ...remainingQueue.slice(insertionIndex),
                    ],
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

function removeQueuedPromptById(
    sessionId: string,
    promptId: string,
    set: SetAiState,
): void {
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
            (trackedFile) => trackedFile.path !== path,
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
        if (trackedFile.path !== input.path) {
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
        case "kilo":
            return "Kilo";
        case "opencode":
            return "OpenCode";
        case "codex":
        default:
            return "Codex";
    }
}
