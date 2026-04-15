import { create } from "zustand";

import type {
    AiFileContextAttachment,
    AiImageAttachment,
    AiRuntimeAuthLaunchInput,
    AiPermissionResponseInput,
    AiRuntimeId,
    AiRuntimeStatus,
    AiSessionConfigOption,
    AiSessionConfigOptionMutationInput,
    AiSessionModeMutationInput,
    AiSessionModelMutationInput,
    AiSessionSnapshot,
    AiSettingsSnapshot,
    AiTrackedFileHunkMutationInput,
    AiTrackedFileMutationInput,
    AiUserInputResponseInput,
    ClaudeRuntimeSettings,
    ClaudeRuntimeSettingsInput,
    GeminiRuntimeSettings,
    GeminiRuntimeSettingsInput,
    KiloRuntimeSettings,
    KiloRuntimeSettingsInput,
} from "@shared/ipc";
import { resolveTrackedFileHunks } from "@shared/ai-tracked-file";

import {
    appendSelectionMentionDraftPart,
    cloneComposerDraftParts,
    cloneDraftAttachments,
    cloneDraftFileContexts,
    createEmptyComposerDraftParts,
    DEFAULT_AI_DIFF_ZOOM,
    normalizeAiDiffZoom,
    type AiComposerDraftPart,
    type QueuedPrompt,
} from "@renderer/app/ai/sessionReviewContracts";
import { collectExternalComposerRoots } from "@renderer/components/workspace/chat/composerParts";
import type {
    RuntimeWorkspaceChatTab,
    RuntimeWorkspaceReviewTab,
} from "../workspace/tree";

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
    readonly diffZoom: number;
    readonly editingQueuedPromptState: QueuedPromptEditState | null;
    readonly editingQueuedPrompt: QueuedPrompt | null;
    readonly hydrated: boolean;
    readonly isDispatching: boolean;
    readonly isHydrating: boolean;
    readonly localError: string | null;
    readonly meta: RegisteredSessionMeta | null;
    readonly queue: readonly QueuedPrompt[];
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

interface AiStore {
    readonly claudeSettings: ClaudeRuntimeSettings;
    readonly codexBinaryPath: string;
    readonly geminiSettings: GeminiRuntimeSettings;
    readonly kiloSettings: KiloRuntimeSettings;
    readonly runtimeCatalogById: Partial<Record<AiRuntimeId, AiRuntimeCatalog>>;
    readonly runtimeStatusById: Partial<Record<AiRuntimeId, AiRuntimeStatus>>;
    readonly sessions: Record<string, AiSessionClientState>;
    applyRuntimeStatus: (status: AiRuntimeStatus) => void;
    applySessionSnapshot: (snapshot: AiSessionSnapshot) => void;
    cancelSession: (sessionId: string) => Promise<void>;
    cancelQueuedPromptEdit: (
        sessionId: string,
    ) => readonly AiComposerDraftPart[] | null;
    clearDraftAttachments: (sessionId: string) => void;
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
    ensureSession: (tab: RuntimeAiSessionTab) => Promise<void>;
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
    saveClaudeRuntimeSettings: (
        settings: ClaudeRuntimeSettingsInput,
    ) => Promise<AiRuntimeStatus>;
    saveGeminiRuntimeSettings: (
        settings: GeminiRuntimeSettingsInput,
    ) => Promise<AiRuntimeStatus>;
    saveKiloRuntimeSettings: (
        settings: KiloRuntimeSettingsInput,
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
    geminiSettings: createEmptyGeminiSettings(),
    kiloSettings: createEmptyKiloSettings(),
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

    applySessionSnapshot: (snapshot) => {
        set((state) => {
            const session =
                state.sessions[snapshot.sessionId] ?? createSessionState();

            return {
                runtimeCatalogById: {
                    ...state.runtimeCatalogById,
                    [snapshot.runtimeId]: extractRuntimeCatalog(snapshot),
                },
                sessions: {
                    ...state.sessions,
                    [snapshot.sessionId]: {
                        ...session,
                        hydrated: true,
                        isDispatching: false,
                        isHydrating: false,
                        localError: snapshot.lastError,
                        snapshot,
                    },
                },
            };
        });

        void drainQueueIfNeeded(snapshot.sessionId, get, set);
    },

    cancelSession: async (sessionId) => {
        await getComandoApi().cancelAiSession(sessionId);
    },

    ensureSession: async (tab) => {
        get().registerSessionTab(tab);
        const currentSession = get().sessions[tab.sessionId];

        if (currentSession?.hydrated || currentSession?.isHydrating) {
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

            set((state) => ({
                runtimeCatalogById: {
                    ...state.runtimeCatalogById,
                    [tab.runtimeId]:
                        extractRuntimeCatalogFromStatus(runtimeStatus) ??
                        extractRuntimeCatalog(resolvedSnapshot),
                },
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
                        snapshot: resolvedSnapshot,
                    },
                },
            }));
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
                        hydrated: true,
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
            geminiSettings: settings?.gemini ?? createEmptyGeminiSettings(),
            kiloSettings: settings?.kilo ?? createEmptyKiloSettings(),
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
        set((state) => ({
            sessions: {
                ...state.sessions,
                [tab.sessionId]: {
                    ...(state.sessions[tab.sessionId] ?? createSessionState()),
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
        set((state) => ({
            sessions: {
                ...state.sessions,
                [sessionId]: {
                    ...(state.sessions[sessionId] ?? createSessionState()),
                    diffZoom: normalizeAiDiffZoom(diffZoom),
                },
            },
        }));
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

    saveCodexBinaryPath: async (binaryPath) => {
        const normalizedPath = binaryPath.trim();
        const status = await getComandoApi().saveCodexRuntimeSettings({
            binaryPath: normalizedPath || null,
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
        if (
            !latestSession?.meta ||
            latestSession.isDispatching ||
            !latestSession.snapshot ||
            isBusySession(latestSession.snapshot)
        ) {
            return;
        }

        setQueuedPromptStatusInState(sessionId, promptId, "sending", set);

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
                {
                    ...queuedPrompt,
                    status: "queued",
                },
                set,
            );

            if (result === "sent") {
                removeQueuedPromptById(sessionId, promptId, set);
                await drainQueueIfNeeded(sessionId, get, set);
                return;
            }

            setQueuedPromptStatusInState(sessionId, promptId, "queued", set);
        } catch {
            setQueuedPromptStatusInState(sessionId, promptId, "failed", set);
        }
    },

    verifyCodexBinaryPath: async (binaryPath) => {
        const normalizedPath = binaryPath.trim();
        const status = await getComandoApi().verifyCodexRuntimeSettings({
            binaryPath: normalizedPath || null,
        });

        get().applyRuntimeStatus(status);

        return status;
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
                projectId: tab.projectId,
                runtimeId: tab.runtimeId,
                sessionId: tab.sessionId,
                title: tab.title,
                worktreeId: tab.worktreeId ?? null,
            },
            trimmedPrompt,
            attachments,
            queuedPrompt,
            set,
        );

        clearEditingQueuedPromptState(tab.sessionId, set);

        if (dispatchResult === "sent") {
            await drainQueueIfNeeded(tab.sessionId, get, set);
        }
    },
}));

function createSessionState(): AiSessionClientState {
    return {
        draftAttachments: [],
        draftComposerParts: createEmptyComposerDraftParts(),
        draftFileContexts: [],
        diffZoom: DEFAULT_AI_DIFF_ZOOM,
        editingQueuedPromptState: null,
        editingQueuedPrompt: null,
        hydrated: false,
        isDispatching: false,
        isHydrating: false,
        localError: null,
        meta: null,
        queue: [],
        snapshot: null,
    };
}

function createEmptyClaudeSettings(): ClaudeRuntimeSettings {
    return {
        authInvalidatedAtMs: null,
        authMethod: null,
        binaryPath: null,
        gatewayBaseUrl: null,
        hasGatewayAuthToken: false,
        hasGatewayCustomHeaders: false,
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
        binaryPath: null,
    };
}

function createEmptySessionSnapshot(
    tab: RuntimeAiSessionTab,
    catalog: AiRuntimeCatalog | null = null,
): AiSessionSnapshot {
    const now = new Date().toISOString();

    return {
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
        (catalog.configOptions.length > 0 ||
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
        readonly projectId: string | null;
        readonly runtimeId: AiRuntimeId;
        readonly sessionId: string;
        readonly title: string;
        readonly worktreeId: string | null;
    },
    prompt: string,
    attachments: readonly AiImageAttachment[],
    queuedPrompt: QueuedPrompt,
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
            projectId: meta.projectId,
            prompt,
            runtimeId: meta.runtimeId,
            sessionId: meta.sessionId,
            title: meta.title,
            worktreeId: meta.worktreeId,
        });
    } catch (error) {
        if (isSessionBusyError(error)) {
            enqueuePrompt(
                meta.sessionId,
                {
                    ...queuedPrompt,
                    status: "queued",
                },
                "head",
                set,
            );
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
        isBusySession(session.snapshot)
    ) {
        return;
    }

    const nextQueuedPrompt = session.queue.find(
        (queuedPrompt) => queuedPrompt.status === "queued",
    );
    if (!nextQueuedPrompt) {
        return;
    }

    setQueuedPromptStatusInState(
        sessionId,
        nextQueuedPrompt.id,
        "sending",
        set,
    );

    try {
        const result = await dispatchPrompt(
            {
                additionalRoots: collectExternalComposerRoots(
                    nextQueuedPrompt.composerPartsSnapshot,
                ),
                projectId: session.meta.projectId,
                runtimeId: session.meta.runtimeId,
                sessionId,
                title: session.meta.title,
                worktreeId: session.meta.worktreeId,
            },
            nextQueuedPrompt.prompt,
            nextQueuedPrompt.attachments,
            nextQueuedPrompt,
            set,
        );

        if (result === "sent") {
            removeQueuedPromptById(sessionId, nextQueuedPrompt.id, set);
            await drainQueueIfNeeded(sessionId, get, set);
            return;
        }

        setQueuedPromptStatusInState(
            sessionId,
            nextQueuedPrompt.id,
            "queued",
            set,
        );
    } catch {
        setQueuedPromptStatusInState(
            sessionId,
            nextQueuedPrompt.id,
            "failed",
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
    return (
        error instanceof Error &&
        error.message === "La sesión todavía está ocupada."
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
        case "gemini":
            return "Gemini";
        case "kilo":
            return "Kilo";
        case "codex":
        default:
            return "Codex";
    }
}
