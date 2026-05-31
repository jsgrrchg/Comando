import { create } from "zustand";

import type { TerminalSession } from "@shared/ipc";
import type { RuntimeWorkspaceTerminalTab } from "@renderer/app/workspace/tree";

import {
    clearAllReplaySnapshotsForTests,
    clearReplaySnapshot,
    getReplaySnapshot,
    saveReplaySnapshot,
} from "./terminalReplayStorage";
import {
    allocateTerminalSessionVersion,
    collectSessionIdsToClose,
    deleteTerminalSessionVersions,
} from "./terminalSessionTracking";
import {
    EMPTY_TERMINAL_SNAPSHOT,
    type TerminalOutputCommand,
    type TerminalOutputEventPayload,
    type TerminalSessionCreateInput,
    type TerminalSessionSnapshot,
    type TerminalSessionView,
} from "./terminalTypes";

export interface WorkspaceTerminalRuntime {
    readonly terminalId: string;
    readonly tabId: string;
    readonly projectId: string | null;
    readonly worktreeId: string | null;
    readonly sessionId: string | null;
    readonly sessionGeneration: number | null;
    readonly snapshot: TerminalSessionSnapshot;
    readonly hasOutput: boolean;
    readonly busy: boolean;
    readonly launchError: string | null;
}

interface WorkspaceTerminalRuntimeStoreState {
    readonly runtimesById: Record<string, WorkspaceTerminalRuntime>;
}

interface WorkspaceTerminalRuntimeStoreActions {
    readonly ensureTerminal: (tab: RuntimeWorkspaceTerminalTab) => void;
    readonly writeInput: (terminalId: string, input: string) => Promise<void>;
    readonly resize: (
        terminalId: string,
        cols: number,
        rows: number,
    ) => Promise<void>;
    readonly restart: (terminalId: string) => Promise<void>;
    readonly clear: (terminalId: string) => void;
    readonly closeTerminal: (terminalId: string) => Promise<void>;
    readonly closeMissingTerminals: (
        liveTerminalIds: Iterable<string>,
    ) => void;
    readonly handleTerminalOutput: (
        payload: TerminalOutputEventPayload,
    ) => void;
    readonly handleTerminalExited: (payload: {
        readonly sessionId: string;
        readonly exitCode: number | null;
    }) => void;
}

export type WorkspaceTerminalRuntimeStore =
    WorkspaceTerminalRuntimeStoreState & WorkspaceTerminalRuntimeStoreActions;

const pendingOutputBySessionId = new Map<string, string>();
const pendingExitBySessionId = new Map<
    string,
    { readonly exitCode: number | null }
>();
const terminalSessionVersions = new Map<string, number>();
const retiredSessionIds = new Map<string, true>();
const pendingResizeByTerminalId = new Map<
    string,
    { readonly cols: number; readonly rows: number }
>();
const suppressedOutputSessionIds = new Map<string, true>();
const nextTerminalSessionVersionRef = { current: 1 };

const MAX_BOOTSTRAP_BACKLOG_CHARS = 256_000;
const MAX_PENDING_SESSION_OUTPUT_CHARS = 256_000;
const MAX_PENDING_EXIT_SESSIONS = 256;

interface TerminalOutputChannel {
    readonly listeners: Set<(command: TerminalOutputCommand) => void>;
    backlog: TerminalOutputCommand[];
    backlogChars: number;
}

const outputChannelsByTerminalId = new Map<string, TerminalOutputChannel>();

function getComandoApi() {
    const comandoWindow = globalThis.window;
    if (!comandoWindow?.comando) {
        throw new Error(
            "The desktop bridge is not available yet. Restart the Electron app and try again.",
        );
    }

    return comandoWindow.comando;
}

function getOutputChannel(terminalId: string): TerminalOutputChannel {
    let channel = outputChannelsByTerminalId.get(terminalId);
    if (!channel) {
        channel = {
            backlog: [],
            backlogChars: 0,
            listeners: new Set(),
        };
        outputChannelsByTerminalId.set(terminalId, channel);
    }
    return channel;
}

function emitOutputCommand(
    terminalId: string,
    command: TerminalOutputCommand,
): void {
    const channel = getOutputChannel(terminalId);
    if (channel.listeners.size === 0) {
        channel.backlog.push(command);
        if (command.type === "write") {
            channel.backlogChars += command.data.length;
        }
        while (
            channel.backlogChars > MAX_BOOTSTRAP_BACKLOG_CHARS &&
            channel.backlog.length > 1
        ) {
            const dropped = channel.backlog.shift();
            if (dropped?.type === "write") {
                channel.backlogChars -= dropped.data.length;
            }
        }
        return;
    }

    for (const listener of channel.listeners) {
        listener(command);
    }
}

function subscribeOutputChannel(
    terminalId: string,
    listener: (command: TerminalOutputCommand) => void,
): () => void {
    const channel = getOutputChannel(terminalId);
    if (channel.listeners.size === 0 && channel.backlog.length > 0) {
        const pending = channel.backlog;
        channel.backlog = [];
        channel.backlogChars = 0;
        for (const command of pending) {
            listener(command);
        }
    }
    channel.listeners.add(listener);
    return () => {
        channel.listeners.delete(listener);
    };
}

function resetOutputChannel(terminalId: string): void {
    const channel = outputChannelsByTerminalId.get(terminalId);
    if (!channel) {
        return;
    }
    channel.backlog = [];
    channel.backlogChars = 0;
}

function normalizeError(error: unknown, fallback: string): string {
    if (error instanceof Error) {
        return error.message;
    }
    if (typeof error === "string" && error.trim()) {
        return error;
    }
    return fallback;
}

function appendBoundedPendingOutput(current: string, chunk: string): string {
    const next = current + chunk;
    if (next.length <= MAX_PENDING_SESSION_OUTPUT_CHARS) {
        return next;
    }
    return next.slice(next.length - MAX_PENDING_SESSION_OUTPUT_CHARS);
}

function rememberPendingExit(
    sessionId: string,
    exitCode: number | null,
): void {
    pendingExitBySessionId.set(sessionId, { exitCode });
    while (pendingExitBySessionId.size > MAX_PENDING_EXIT_SESSIONS) {
        const oldestSessionId = pendingExitBySessionId.keys().next().value;
        if (!oldestSessionId) {
            break;
        }
        pendingExitBySessionId.delete(oldestSessionId);
    }
}

function createRuntimeSnapshot(tab: RuntimeWorkspaceTerminalTab) {
    return {
        ...EMPTY_TERMINAL_SNAPSHOT,
        cwd: tab.session?.cwd ?? "",
        errorMessage: null,
        status: "starting" as const,
    };
}

function createInitialRuntime(
    tab: RuntimeWorkspaceTerminalTab,
): WorkspaceTerminalRuntime {
    return {
        busy: true,
        hasOutput: false,
        launchError: null,
        projectId: tab.projectId,
        sessionGeneration: null,
        sessionId: null,
        snapshot: createRuntimeSnapshot(tab),
        tabId: tab.id,
        terminalId: tab.terminalId,
        worktreeId: tab.worktreeId ?? null,
    };
}

function terminalSessionToSnapshot(
    session: TerminalSession,
): TerminalSessionSnapshot {
    return {
        cols: session.cols ?? EMPTY_TERMINAL_SNAPSHOT.cols,
        cwd: session.cwd,
        displayName: "Shell",
        errorMessage: session.errorMessage ?? null,
        exitCode: session.exitCode ?? null,
        program: "",
        rows: session.rows ?? EMPTY_TERMINAL_SNAPSHOT.rows,
        sessionId: session.sessionId,
        status: session.status ?? "running",
    };
}

function getRuntimeBySessionId(
    runtimesById: Record<string, WorkspaceTerminalRuntime>,
    sessionId: string,
): WorkspaceTerminalRuntime | null {
    return (
        Object.values(runtimesById).find(
            (runtime) => runtime.sessionId === sessionId,
        ) ?? null
    );
}

async function closeSessionIds(sessionIds: readonly string[]): Promise<void> {
    await Promise.all(
        sessionIds.map((sessionId) =>
            Promise.resolve(getComandoApi().closeTerminalSession(sessionId)).catch(
                () => undefined,
            ),
        ),
    );
}

function collectTrackedSessionIdsToClose(sessionIds: readonly string[]) {
    const sessionIdsToClose = collectSessionIdsToClose(
        sessionIds,
        retiredSessionIds,
        pendingOutputBySessionId,
    );
    for (const sessionId of sessionIdsToClose) {
        pendingExitBySessionId.delete(sessionId);
    }
    return sessionIdsToClose;
}

function retireAndCloseSessionIds(sessionIds: readonly string[]): void {
    const nextSessionIds = collectTrackedSessionIdsToClose(sessionIds);
    for (const sessionId of nextSessionIds) {
        suppressedOutputSessionIds.delete(sessionId);
    }
    if (nextSessionIds.length > 0) {
        void closeSessionIds(nextSessionIds);
    }
}

function allocateSessionVersion(terminalId: string): number {
    return allocateTerminalSessionVersion(
        terminalSessionVersions,
        nextTerminalSessionVersionRef,
        terminalId,
    );
}

async function createSessionForTerminal(
    terminalId: string,
    input: TerminalSessionCreateInput,
): Promise<TerminalSessionSnapshot | null> {
    const requestVersion = allocateSessionVersion(terminalId);

    try {
        const nextSession = await getComandoApi().createTerminalSession({
            cols: input.cols,
            extraEnv: input.extraEnv,
            projectId: input.projectId,
            rows: input.rows,
            terminalId: input.terminalId ?? terminalId,
            worktreeId: input.worktreeId ?? null,
        });
        const next = terminalSessionToSnapshot(nextSession);
        const currentState = useTerminalRuntimeStore.getState();
        const runtime = currentState.runtimesById[terminalId];

        if (
            !runtime ||
            terminalSessionVersions.get(terminalId) !== requestVersion
        ) {
            retireAndCloseSessionIds([next.sessionId]);
            return next;
        }

        const bufferedRaw = pendingOutputBySessionId.get(next.sessionId) ?? "";
        pendingOutputBySessionId.delete(next.sessionId);
        const pendingExit = pendingExitBySessionId.get(next.sessionId) ?? null;
        pendingExitBySessionId.delete(next.sessionId);
        pendingResizeByTerminalId.delete(terminalId);

        useTerminalRuntimeStore.setState((state) => {
            const current = state.runtimesById[terminalId];
            if (!current) {
                return state;
            }

            return {
                runtimesById: {
                    ...state.runtimesById,
                    [terminalId]: {
                        ...current,
                        busy: false,
                        hasOutput: current.hasOutput || bufferedRaw.length > 0,
                        launchError: null,
                        sessionGeneration: requestVersion,
                        sessionId: next.sessionId,
                        snapshot: pendingExit
                            ? {
                                  ...next,
                                  errorMessage: null,
                                  exitCode: pendingExit.exitCode,
                                  status: "exited",
                              }
                            : next,
                    },
                },
            };
        });

        if (bufferedRaw.length > 0) {
            emitOutputCommand(terminalId, {
                data: bufferedRaw,
                type: "write",
            });
        }

        return next;
    } catch (error) {
        if (terminalSessionVersions.get(terminalId) !== requestVersion) {
            return null;
        }

        useTerminalRuntimeStore.setState((state) => {
            const current = state.runtimesById[terminalId];
            if (!current) {
                return state;
            }

            const message = normalizeError(error, "Terminal session failed");
            return {
                runtimesById: {
                    ...state.runtimesById,
                    [terminalId]: {
                        ...current,
                        busy: false,
                        launchError: message,
                        snapshot: {
                            ...current.snapshot,
                            errorMessage: message,
                            status: "error",
                        },
                    },
                },
            };
        });
        return null;
    }
}

function updateRuntimeBySessionId(
    sessionId: string,
    updater: (
        runtime: WorkspaceTerminalRuntime,
    ) => WorkspaceTerminalRuntime,
): void {
    useTerminalRuntimeStore.setState((state) => {
        const runtime = getRuntimeBySessionId(state.runtimesById, sessionId);
        if (!runtime) {
            return state;
        }

        return {
            runtimesById: {
                ...state.runtimesById,
                [runtime.terminalId]: updater(runtime),
            },
        };
    });
}

export const useTerminalRuntimeStore = create<WorkspaceTerminalRuntimeStore>(
    (set, get) => ({
        runtimesById: {},

        ensureTerminal: (tab) => {
            const existing = get().runtimesById[tab.terminalId];

            if (!existing) {
                const runtime = createInitialRuntime(tab);
                set((state) => ({
                    runtimesById: {
                        ...state.runtimesById,
                        [tab.terminalId]: runtime,
                    },
                }));
                void createSessionForTerminal(tab.terminalId, {
                    cols: runtime.snapshot.cols,
                    projectId: tab.projectId,
                    rows: runtime.snapshot.rows,
                    terminalId: tab.terminalId,
                    worktreeId: tab.worktreeId ?? null,
                });
                return;
            }

            if (
                existing.tabId !== tab.id ||
                existing.projectId !== tab.projectId ||
                existing.worktreeId !== (tab.worktreeId ?? null)
            ) {
                set((state) => ({
                    runtimesById: {
                        ...state.runtimesById,
                        [tab.terminalId]: {
                            ...existing,
                            projectId: tab.projectId,
                            tabId: tab.id,
                            worktreeId: tab.worktreeId ?? null,
                        },
                    },
                }));
            }

            if (!existing.sessionId && !existing.busy) {
                set((state) => ({
                    runtimesById: {
                        ...state.runtimesById,
                        [tab.terminalId]: {
                            ...existing,
                            busy: true,
                            launchError: null,
                            projectId: tab.projectId,
                            sessionGeneration: null,
                            snapshot: {
                                ...existing.snapshot,
                                errorMessage: null,
                                exitCode: null,
                                status: "starting",
                            },
                            tabId: tab.id,
                            worktreeId: tab.worktreeId ?? null,
                        },
                    },
                }));
                void createSessionForTerminal(tab.terminalId, {
                    cols: existing.snapshot.cols,
                    projectId: tab.projectId,
                    rows: existing.snapshot.rows,
                    terminalId: tab.terminalId,
                    worktreeId: tab.worktreeId ?? null,
                });
            }
        },

        writeInput: async (terminalId, input) => {
            if (!input) {
                return;
            }

            const runtime = get().runtimesById[terminalId];
            if (!runtime?.sessionId) {
                return;
            }

            await getComandoApi().writeTerminalInput({
                data: input,
                sessionId: runtime.sessionId,
            });
        },

        resize: async (terminalId, cols, rows) => {
            if (cols < 1 || rows < 1) {
                return;
            }

            const runtime = get().runtimesById[terminalId];
            if (!runtime?.sessionId) {
                return;
            }
            if (
                runtime.snapshot.cols === cols &&
                runtime.snapshot.rows === rows
            ) {
                return;
            }

            const pendingResize = pendingResizeByTerminalId.get(terminalId);
            if (
                pendingResize &&
                pendingResize.cols === cols &&
                pendingResize.rows === rows
            ) {
                return;
            }

            pendingResizeByTerminalId.set(terminalId, { cols, rows });
            try {
                await getComandoApi().resizeTerminalSession({
                    cols,
                    rows,
                    sessionId: runtime.sessionId,
                });

                const pending = pendingResizeByTerminalId.get(terminalId);
                if (!pending || pending.cols !== cols || pending.rows !== rows) {
                    return;
                }

                const current = get().runtimesById[terminalId];
                if (!current || current.sessionId !== runtime.sessionId) {
                    return;
                }

                pendingResizeByTerminalId.delete(terminalId);
                set((state) => ({
                    runtimesById: {
                        ...state.runtimesById,
                        [terminalId]: {
                            ...current,
                            snapshot: {
                                ...current.snapshot,
                                cols,
                                rows,
                            },
                        },
                    },
                }));
            } catch (error) {
                const pending = pendingResizeByTerminalId.get(terminalId);
                if (pending?.cols === cols && pending.rows === rows) {
                    pendingResizeByTerminalId.delete(terminalId);
                }
                throw error;
            }
        },

        restart: async (terminalId) => {
            const runtime = get().runtimesById[terminalId];
            if (!runtime) {
                return;
            }

            const previousSessionId = runtime.sessionId;
            if (previousSessionId) {
                suppressedOutputSessionIds.set(previousSessionId, true);
            }
            pendingResizeByTerminalId.delete(terminalId);
            resetOutputChannel(terminalId);
            clearReplaySnapshot(terminalId);
            emitOutputCommand(terminalId, { type: "clear" });

            set((state) => {
                const current = state.runtimesById[terminalId];
                if (!current) {
                    return state;
                }

                return {
                    runtimesById: {
                        ...state.runtimesById,
                        [terminalId]: {
                            ...current,
                            busy: true,
                            hasOutput: false,
                            launchError: null,
                            sessionGeneration: null,
                            sessionId: null,
                            snapshot: {
                                ...current.snapshot,
                                errorMessage: null,
                                exitCode: null,
                                status: "starting",
                            },
                        },
                    },
                };
            });

            if (previousSessionId) {
                const sessionIds = collectTrackedSessionIdsToClose([
                    previousSessionId,
                ]);
                for (const sessionId of sessionIds) {
                    suppressedOutputSessionIds.delete(sessionId);
                }
                await closeSessionIds(sessionIds);
            }

            await createSessionForTerminal(terminalId, {
                cols: runtime.snapshot.cols,
                projectId: runtime.projectId,
                rows: runtime.snapshot.rows,
                terminalId,
                worktreeId: runtime.worktreeId,
            });
        },

        clear: (terminalId) => {
            resetOutputChannel(terminalId);
            clearReplaySnapshot(terminalId);
            emitOutputCommand(terminalId, { type: "clear" });
            set((state) => {
                const runtime = state.runtimesById[terminalId];
                if (!runtime || !runtime.hasOutput) {
                    return state;
                }

                return {
                    runtimesById: {
                        ...state.runtimesById,
                        [terminalId]: {
                            ...runtime,
                            hasOutput: false,
                        },
                    },
                };
            });
        },

        closeTerminal: async (terminalId) => {
            const runtime = get().runtimesById[terminalId];
            if (!runtime) {
                return;
            }

            allocateSessionVersion(terminalId);
            deleteTerminalSessionVersions(terminalSessionVersions, [terminalId]);
            pendingResizeByTerminalId.delete(terminalId);
            outputChannelsByTerminalId.delete(terminalId);
            clearReplaySnapshot(terminalId);

            set((state) => {
                const { [terminalId]: _removed, ...remaining } =
                    state.runtimesById;
                void _removed;
                return { runtimesById: remaining };
            });

            if (runtime.sessionId) {
                const sessionIds = collectTrackedSessionIdsToClose([
                    runtime.sessionId,
                ]);
                for (const sessionId of sessionIds) {
                    suppressedOutputSessionIds.delete(sessionId);
                }
                await closeSessionIds(sessionIds);
            }
        },

        closeMissingTerminals: (liveTerminalIds) => {
            const live = new Set(liveTerminalIds);
            const missingTerminalIds = Object.keys(get().runtimesById).filter(
                (terminalId) => !live.has(terminalId),
            );

            for (const terminalId of missingTerminalIds) {
                void get().closeTerminal(terminalId);
            }
        },

        handleTerminalOutput: ({ sessionId, chunk }) => {
            if (!sessionId || !chunk) {
                return;
            }
            if (retiredSessionIds.has(sessionId)) {
                return;
            }
            if (suppressedOutputSessionIds.has(sessionId)) {
                return;
            }

            const runtime = getRuntimeBySessionId(
                get().runtimesById,
                sessionId,
            );

            if (!runtime) {
                const existing = pendingOutputBySessionId.get(sessionId) ?? "";
                pendingOutputBySessionId.set(
                    sessionId,
                    appendBoundedPendingOutput(existing, chunk),
                );
                return;
            }

            emitOutputCommand(runtime.terminalId, {
                data: chunk,
                type: "write",
            });

            if (!runtime.hasOutput) {
                set((state) => {
                    const current = state.runtimesById[runtime.terminalId];
                    if (!current || current.hasOutput) {
                        return state;
                    }
                    return {
                        runtimesById: {
                            ...state.runtimesById,
                            [runtime.terminalId]: {
                                ...current,
                                hasOutput: true,
                            },
                        },
                    };
                });
            }
        },

        handleTerminalExited: ({ sessionId, exitCode }) => {
            if (!sessionId) {
                return;
            }
            suppressedOutputSessionIds.delete(sessionId);
            if (retiredSessionIds.has(sessionId)) {
                return;
            }

            let matchedRuntime = false;
            updateRuntimeBySessionId(sessionId, (runtime) => {
                matchedRuntime = true;
                return {
                    ...runtime,
                    busy: false,
                    snapshot: {
                        ...runtime.snapshot,
                        errorMessage: null,
                        exitCode,
                        status: "exited",
                    },
                };
            });

            if (!matchedRuntime) {
                rememberPendingExit(sessionId, exitCode);
            }
        },
    }),
);

export function selectWorkspaceTerminalRuntime(
    terminalId: string | null | undefined,
): WorkspaceTerminalRuntime | null {
    return terminalId
        ? (useTerminalRuntimeStore.getState().runtimesById[terminalId] ?? null)
        : null;
}

export function resetTerminalRuntimeStoreForTests(): void {
    pendingOutputBySessionId.clear();
    pendingExitBySessionId.clear();
    terminalSessionVersions.clear();
    retiredSessionIds.clear();
    pendingResizeByTerminalId.clear();
    suppressedOutputSessionIds.clear();
    outputChannelsByTerminalId.clear();
    clearAllReplaySnapshotsForTests();
    nextTerminalSessionVersionRef.current = 1;
    useTerminalRuntimeStore.setState({ runtimesById: {} });
}

export function createTerminalSessionView(
    runtime: WorkspaceTerminalRuntime,
): TerminalSessionView {
    const readCurrentRuntime = () =>
        useTerminalRuntimeStore.getState().runtimesById[runtime.terminalId] ??
        null;

    return {
        busy: runtime.busy,
        clearViewport: () =>
            useTerminalRuntimeStore.getState().clear(runtime.terminalId),
        getReplaySnapshot: () => {
            const current = readCurrentRuntime();
            if (!current) {
                return null;
            }
            const serialized = getReplaySnapshot(
                current.terminalId,
                current.sessionId,
                current.sessionGeneration,
            );
            return serialized && current.sessionId
                ? {
                      serialized,
                      sessionId: current.sessionId,
                  }
                : null;
        },
        hasOutput: runtime.hasOutput,
        resize: (cols, rows) =>
            useTerminalRuntimeStore
                .getState()
                .resize(runtime.terminalId, cols, rows),
        restart: () =>
            useTerminalRuntimeStore.getState().restart(runtime.terminalId),
        saveReplaySnapshot: (serialized) => {
            const current = readCurrentRuntime();
            if (!current) {
                return;
            }
            saveReplaySnapshot(
                current.terminalId,
                current.sessionId,
                current.sessionGeneration,
                serialized,
            );
        },
        snapshot: runtime.snapshot,
        subscribeOutput: (listener) =>
            subscribeOutputChannel(runtime.terminalId, listener),
        writeInput: (input) =>
            useTerminalRuntimeStore
                .getState()
                .writeInput(runtime.terminalId, input),
    };
}
