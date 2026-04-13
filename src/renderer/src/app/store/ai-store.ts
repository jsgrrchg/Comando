import { create } from "zustand";

import type {
    AiPermissionResponseInput,
    AiRuntimeId,
    AiRuntimeStatus,
    AiSessionSnapshot,
    AiSettingsSnapshot,
    AiTrackedFileMutationInput,
} from "@shared/ipc";

import type {
    RuntimeWorkspaceChatTab,
    RuntimeWorkspaceReviewTab,
} from "../workspace/tree";

type RuntimeAiSessionTab = RuntimeWorkspaceChatTab | RuntimeWorkspaceReviewTab;

interface QueuedPrompt {
    readonly createdAt: string;
    readonly id: string;
    readonly prompt: string;
}

interface RegisteredSessionMeta {
    readonly projectId: string | null;
    readonly runtimeId: AiRuntimeId;
    readonly title: string;
}

interface AiSessionClientState {
    readonly hydrated: boolean;
    readonly isDispatching: boolean;
    readonly isHydrating: boolean;
    readonly localError: string | null;
    readonly meta: RegisteredSessionMeta | null;
    readonly queue: readonly QueuedPrompt[];
    readonly snapshot: AiSessionSnapshot | null;
}

interface AiStore {
    readonly codexBinaryPath: string;
    readonly runtimeStatusById: Partial<Record<AiRuntimeId, AiRuntimeStatus>>;
    readonly sessions: Record<string, AiSessionClientState>;
    applyRuntimeStatus: (status: AiRuntimeStatus) => void;
    applySessionSnapshot: (snapshot: AiSessionSnapshot) => void;
    cancelSession: (sessionId: string) => Promise<void>;
    ensureSession: (tab: RuntimeAiSessionTab) => Promise<void>;
    hydrateSettings: (settings: AiSettingsSnapshot | null | undefined) => void;
    keepAllTrackedFiles: (sessionId: string) => Promise<void>;
    keepTrackedFile: (input: AiTrackedFileMutationInput) => Promise<void>;
    refreshRuntimeStatus: (runtimeId: AiRuntimeId) => Promise<void>;
    registerSessionTab: (tab: RuntimeAiSessionTab) => void;
    rejectAllTrackedFiles: (sessionId: string) => Promise<void>;
    rejectTrackedFile: (input: AiTrackedFileMutationInput) => Promise<void>;
    removeQueuedPrompt: (sessionId: string, promptId: string) => void;
    respondPermission: (input: AiPermissionResponseInput) => Promise<void>;
    saveCodexBinaryPath: (binaryPath: string) => Promise<AiRuntimeStatus>;
    sendPrompt: (tab: RuntimeWorkspaceChatTab, prompt: string) => Promise<void>;
}

type SetAiState = typeof useAiStore.setState;
type GetAiState = () => AiStore;

export const useAiStore = create<AiStore>((set, get) => ({
    codexBinaryPath: "",
    runtimeStatusById: {},
    sessions: {},

    applyRuntimeStatus: (status) => {
        set((state) => ({
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
            const [runtimeStatus, snapshot] = await Promise.all([
                getComandoApi().getAiRuntimeStatus(tab.runtimeId),
                getComandoApi().getAiSessionSnapshot(tab.sessionId),
            ]);

            set((state) => ({
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
                        snapshot: snapshot ?? createEmptySessionSnapshot(tab),
                    },
                },
            }));
        } catch (error) {
            set((state) => ({
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
                                : "Could not hydrate the Codex session.",
                        meta: buildSessionMeta(tab),
                        snapshot: createEmptySessionSnapshot(tab),
                    },
                },
            }));
        }
    },

    hydrateSettings: (settings) => {
        set({
            codexBinaryPath: settings?.codex.binaryPath ?? "",
        });
    },

    keepAllTrackedFiles: async (sessionId) => {
        await getComandoApi().keepAllAiTrackedFiles(sessionId);
    },

    keepTrackedFile: async (input) => {
        await getComandoApi().keepAiTrackedFile(input);
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
                    meta: buildSessionMeta(tab),
                    snapshot:
                        state.sessions[tab.sessionId]?.snapshot ??
                        createEmptySessionSnapshot(tab),
                },
            },
        }));
    },

    rejectAllTrackedFiles: async (sessionId) => {
        await getComandoApi().rejectAllAiTrackedFiles(sessionId);
    },

    rejectTrackedFile: async (input) => {
        await getComandoApi().rejectAiTrackedFile(input);
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

    respondPermission: async (input) => {
        await getComandoApi().respondAiPermission(input);
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

    sendPrompt: async (tab, prompt) => {
        const trimmedPrompt = prompt.trim();
        if (!trimmedPrompt) {
            return;
        }

        get().registerSessionTab(tab);
        const session = get().sessions[tab.sessionId] ?? createSessionState();
        if (
            session.isDispatching ||
            (session.snapshot ? isBusySession(session.snapshot) : false)
        ) {
            set((state) => ({
                sessions: {
                    ...state.sessions,
                    [tab.sessionId]: {
                        ...(state.sessions[tab.sessionId] ??
                            createSessionState()),
                        meta: buildSessionMeta(tab),
                        queue: [
                            ...(state.sessions[tab.sessionId]?.queue ?? []),
                            {
                                createdAt: new Date().toISOString(),
                                id: crypto.randomUUID(),
                                prompt: trimmedPrompt,
                            },
                        ],
                    },
                },
            }));
            return;
        }

        await dispatchPrompt(
            {
                projectId: tab.projectId,
                runtimeId: tab.runtimeId,
                sessionId: tab.sessionId,
                title: tab.title,
            },
            trimmedPrompt,
            set,
            get,
        );
    },
}));

function createSessionState(): AiSessionClientState {
    return {
        hydrated: false,
        isDispatching: false,
        isHydrating: false,
        localError: null,
        meta: null,
        queue: [],
        snapshot: null,
    };
}

function createEmptySessionSnapshot(
    tab: RuntimeAiSessionTab,
): AiSessionSnapshot {
    const now = new Date().toISOString();

    return {
        availableCommands: [],
        lastError: null,
        messages: [],
        pendingPermission: null,
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
    };
}

function buildSessionMeta(tab: RuntimeAiSessionTab): RegisteredSessionMeta {
    return {
        projectId: tab.projectId,
        runtimeId: tab.runtimeId,
        title: tab.title,
    };
}

async function dispatchPrompt(
    meta: {
        readonly projectId: string | null;
        readonly runtimeId: AiRuntimeId;
        readonly sessionId: string;
        readonly title: string;
    },
    prompt: string,
    set: SetAiState,
    get: GetAiState,
): Promise<void> {
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

    try {
        await getComandoApi().sendAiPrompt({
            projectId: meta.projectId,
            prompt,
            runtimeId: meta.runtimeId,
            sessionId: meta.sessionId,
            title: meta.title,
        });
    } catch (error) {
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
                                : "Could not send the prompt to Codex.",
                    },
                },
            };
        });
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

    await drainQueueIfNeeded(meta.sessionId, get, set);
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

    const [nextQueuedPrompt, ...remainingQueue] = session.queue;
    if (!nextQueuedPrompt) {
        return;
    }

    set((state) => ({
        sessions: {
            ...state.sessions,
            [sessionId]: {
                ...(state.sessions[sessionId] ?? createSessionState()),
                queue: remainingQueue,
            },
        },
    }));

    await dispatchPrompt(
        {
            projectId: session.meta.projectId,
            runtimeId: session.meta.runtimeId,
            sessionId,
            title: session.meta.title,
        },
        nextQueuedPrompt.prompt,
        set,
        get,
    );
}

function isBusySession(snapshot: AiSessionSnapshot): boolean {
    return (
        snapshot.status === "starting" ||
        snapshot.status === "streaming" ||
        snapshot.status === "waiting_permission"
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
