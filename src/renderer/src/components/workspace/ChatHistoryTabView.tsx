import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type ReactNode,
} from "react";

import type {
    AiHistorySessionSummary,
    AiMessage,
    AiMessageKind,
    AiSessionSnapshot,
    AiSessionStatus,
} from "@shared/ipc";

import { useProjectsStore } from "@renderer/app/store/projects-store";
import { useWorkspaceStore } from "@renderer/app/store/workspace-store";
import type { RuntimeWorkspaceChatHistoryTab } from "@renderer/app/workspace/tree";
import { MarkdownContent } from "@renderer/components/workspace/MarkdownContent";

import {
    formatHistoryMessageCount,
    formatHistoryRelativeDate,
    formatHistoryScope,
    getHistoryRuntimeLabel,
} from "./chat-history/historyPresentation";
import { HistorySessionArtifacts } from "./chat-history/HistorySessionArtifacts";
import { getHistoryPreviewText } from "./chat-history/historyPreview";

const HISTORY_PAGE_SIZE = 100;
const EMPTY_MESSAGES: readonly AiMessage[] = [];

interface ChatHistoryTabViewProps {
    readonly tab: RuntimeWorkspaceChatHistoryTab;
}

export interface TranscriptState {
    readonly error: string | null;
    readonly isLoading: boolean;
    readonly messages: readonly AiMessage[];
    readonly totalMessages: number;
}

export interface SessionSnapshotState {
    readonly error: string | null;
    readonly isLoading: boolean;
    readonly snapshot: AiSessionSnapshot | null;
}

export interface ChatHistoryTabLayoutProps {
    readonly hasMoreMessages: boolean;
    readonly isBusy: boolean;
    readonly isLoadingSessions: boolean;
    readonly loadSessionSnapshot: (sessionId: string, reset?: boolean) => Promise<void>;
    readonly loadTranscriptPage: (sessionId: string, reset?: boolean) => Promise<void>;
    readonly handleDelete: (session: AiHistorySessionSummary) => Promise<void>;
    readonly handleOpenInChat: (session: AiHistorySessionSummary) => Promise<void>;
    readonly handleRefresh: () => Promise<void>;
    readonly handleRename: (session: AiHistorySessionSummary) => Promise<void>;
    readonly mutatingSessionId: string | null;
    readonly scopeLabel: string;
    readonly selectedSession: AiHistorySessionSummary | null;
    readonly selectedSessionId: string | null;
    readonly selectedSnapshot: AiSessionSnapshot | null;
    readonly selectedSnapshotState: SessionSnapshotState | null;
    readonly selectedSnapshotStatus: AiSessionStatus | null;
    readonly selectedTranscript: TranscriptState | null;
    readonly sessions: readonly AiHistorySessionSummary[];
    readonly sessionsError: string | null;
    readonly setSelectedSessionId: (sessionId: string) => void;
    readonly tab: RuntimeWorkspaceChatHistoryTab;
    readonly transcriptMessages: readonly AiMessage[];
    readonly worktreeLabel: string;
}

export function ChatHistoryTabView({ tab }: ChatHistoryTabViewProps) {
    const closeTab = useWorkspaceStore((state) => state.closeTab);
    const openChatSessionTab = useWorkspaceStore(
        (state) => state.openChatSessionTab,
    );
    const updateSessionTabTitles = useWorkspaceStore(
        (state) => state.updateSessionTabTitles,
    );
    const tabsById = useWorkspaceStore((state) => state.tabsById);
    const projectName = useProjectsStore((state) =>
        state.projects.find((project) => project.id === tab.projectId)?.name,
    );

    const [sessions, setSessions] = useState<readonly AiHistorySessionSummary[]>(
        [],
    );
    const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
        null,
    );
    const [isLoadingSessions, setIsLoadingSessions] = useState(false);
    const [sessionsError, setSessionsError] = useState<string | null>(null);
    const [transcriptsBySessionId, setTranscriptsBySessionId] = useState<
        Record<string, TranscriptState>
    >({});
    const [snapshotsBySessionId, setSnapshotsBySessionId] = useState<
        Record<string, SessionSnapshotState>
    >({});
    const [mutatingSessionId, setMutatingSessionId] = useState<string | null>(
        null,
    );
    const transcriptRequestIdsRef = useRef<Record<string, number>>({});
    const snapshotRequestIdsRef = useRef<Record<string, number>>({});

    const scopeLabel = projectName ?? tab.projectId ?? "No project";
    const worktreeLabel = formatHistoryScope(tab.worktreeId);
    const selectedSession =
        sessions.find((session) => session.sessionId === selectedSessionId) ??
        null;
    const selectedTranscript = selectedSessionId
        ? (transcriptsBySessionId[selectedSessionId] ?? null)
        : null;
    const selectedSnapshotState = selectedSessionId
        ? (snapshotsBySessionId[selectedSessionId] ?? null)
        : null;

    const loadSessions = useCallback(async () => {
        setIsLoadingSessions(true);
        setSessionsError(null);

        try {
            const nextSessions = await getComandoApi().listAiSessionHistory({
                limit: 250,
                projectId: tab.projectId,
                worktreeId: tab.worktreeId ?? null,
            });

            setSessions(nextSessions);
            setSelectedSessionId((current) => {
                if (
                    current &&
                    nextSessions.some(
                        (session) => session.sessionId === current,
                    )
                ) {
                    return current;
                }

                return nextSessions[0]?.sessionId ?? null;
            });
        } catch (error) {
            setSessionsError(
                error instanceof Error
                    ? error.message
                    : "Could not load chat history.",
            );
        } finally {
            setIsLoadingSessions(false);
        }
    }, [tab.projectId, tab.worktreeId]);

    const loadTranscriptPage = useCallback(
        async (sessionId: string, reset = false) => {
            const currentTranscript = transcriptsBySessionId[sessionId];
            if (!reset && currentTranscript?.isLoading) {
                return;
            }

            const nextOffset = reset
                ? 0
                : (currentTranscript?.messages.length ?? 0);
            const requestId =
                (transcriptRequestIdsRef.current[sessionId] ?? 0) + 1;
            transcriptRequestIdsRef.current[sessionId] = requestId;

            setTranscriptsBySessionId((current) => ({
                ...current,
                [sessionId]: {
                    error: null,
                    isLoading: true,
                    messages: reset
                        ? EMPTY_MESSAGES
                        : (current[sessionId]?.messages ?? EMPTY_MESSAGES),
                    totalMessages: reset
                        ? 0
                        : (current[sessionId]?.totalMessages ?? 0),
                },
            }));

            try {
                const page = await getComandoApi().getAiSessionTranscriptPage({
                    limit: HISTORY_PAGE_SIZE,
                    offset: nextOffset,
                    sessionId,
                });

                setTranscriptsBySessionId((current) => {
                    if (
                        transcriptRequestIdsRef.current[sessionId] !== requestId
                    ) {
                        return current;
                    }

                    const previousMessages = reset
                        ? EMPTY_MESSAGES
                        : (current[sessionId]?.messages ?? EMPTY_MESSAGES);

                    return {
                        ...current,
                        [sessionId]: {
                            error: null,
                            isLoading: false,
                            messages:
                                nextOffset === 0
                                    ? page.messages
                                    : mergeTranscriptMessages(
                                          previousMessages,
                                          page.messages,
                                      ),
                            totalMessages: page.totalMessages,
                        },
                    };
                });
            } catch (error) {
                setTranscriptsBySessionId((current) => {
                    if (
                        transcriptRequestIdsRef.current[sessionId] !== requestId
                    ) {
                        return current;
                    }

                    return {
                        ...current,
                        [sessionId]: {
                            error:
                                error instanceof Error
                                    ? error.message
                                    : "Could not load this transcript.",
                            isLoading: false,
                            messages:
                                current[sessionId]?.messages ?? EMPTY_MESSAGES,
                            totalMessages:
                                current[sessionId]?.totalMessages ?? 0,
                        },
                    };
                });
            }
        },
        [transcriptsBySessionId],
    );

    const loadSessionSnapshot = useCallback(
        async (sessionId: string, reset = false) => {
            const currentSnapshot = snapshotsBySessionId[sessionId];
            if (!reset && currentSnapshot?.isLoading) {
                return;
            }

            const requestId =
                (snapshotRequestIdsRef.current[sessionId] ?? 0) + 1;
            snapshotRequestIdsRef.current[sessionId] = requestId;

            setSnapshotsBySessionId((current) => ({
                ...current,
                [sessionId]: {
                    error: null,
                    isLoading: true,
                    snapshot: reset
                        ? null
                        : (current[sessionId]?.snapshot ?? null),
                },
            }));

            try {
                const snapshot = await getComandoApi().getAiSessionSnapshot(
                    sessionId,
                );
                setSnapshotsBySessionId((current) => {
                    if (
                        snapshotRequestIdsRef.current[sessionId] !== requestId
                    ) {
                        return current;
                    }

                    return {
                        ...current,
                        [sessionId]: {
                            error: snapshot
                                ? null
                                : "Could not load this session snapshot.",
                            isLoading: false,
                            snapshot,
                        },
                    };
                });
            } catch (error) {
                setSnapshotsBySessionId((current) => {
                    if (
                        snapshotRequestIdsRef.current[sessionId] !== requestId
                    ) {
                        return current;
                    }

                    return {
                        ...current,
                        [sessionId]: {
                            error:
                                error instanceof Error
                                    ? error.message
                                    : "Could not load this session snapshot.",
                            isLoading: false,
                            snapshot: current[sessionId]?.snapshot ?? null,
                        },
                    };
                });
            }
        },
        [snapshotsBySessionId],
    );

    useEffect(() => {
        setSessions([]);
        setSelectedSessionId(null);
        setSessionsError(null);
        setTranscriptsBySessionId({});
        setSnapshotsBySessionId({});
        void loadSessions();
    }, [loadSessions]);

    useEffect(() => {
        if (!selectedSessionId || transcriptsBySessionId[selectedSessionId]) {
            return;
        }

        void loadTranscriptPage(selectedSessionId, true);
    }, [loadTranscriptPage, selectedSessionId, transcriptsBySessionId]);

    useEffect(() => {
        if (!selectedSessionId || snapshotsBySessionId[selectedSessionId]) {
            return;
        }

        void loadSessionSnapshot(selectedSessionId, true);
    }, [loadSessionSnapshot, selectedSessionId, snapshotsBySessionId]);

    const handleRefresh = useCallback(async () => {
        setTranscriptsBySessionId({});
        setSnapshotsBySessionId({});
        await loadSessions();
    }, [loadSessions]);

    const handleOpenInChat = useCallback(
        async (session: AiHistorySessionSummary) => {
            await openChatSessionTab({
                projectId: session.projectId,
                runtimeId: session.runtimeId,
                sessionId: session.sessionId,
                title: session.title,
                worktreeId: session.worktreeId ?? null,
            });
        },
        [openChatSessionTab],
    );

    const handleRename = useCallback(
        async (session: AiHistorySessionSummary) => {
            const nextTitle = window.prompt(
                "Rename this chat session",
                session.title,
            );

            if (nextTitle === null) {
                return;
            }

            const trimmedTitle = nextTitle.trim();
            if (trimmedTitle.length === 0 || trimmedTitle === session.title) {
                return;
            }

            setMutatingSessionId(session.sessionId);
            setSessionsError(null);
            const previousTitle = session.title;
            setSessions((current) =>
                current.map((candidate) =>
                    candidate.sessionId === session.sessionId
                        ? { ...candidate, title: trimmedTitle }
                        : candidate,
                ),
            );
            setSnapshotsBySessionId((current) => {
                const existingState = current[session.sessionId];
                if (!existingState) {
                    return current;
                }

                return {
                    ...current,
                    [session.sessionId]: {
                        ...existingState,
                        snapshot: existingState.snapshot
                            ? {
                                  ...existingState.snapshot,
                                  title: trimmedTitle,
                              }
                            : null,
                    },
                };
            });
            try {
                await getComandoApi().renameAiSession({
                    sessionId: session.sessionId,
                    title: trimmedTitle,
                });
                await updateSessionTabTitles(session.sessionId, trimmedTitle);
            } catch (error) {
                setSessions((current) =>
                    current.map((candidate) =>
                        candidate.sessionId === session.sessionId
                            ? { ...candidate, title: previousTitle }
                            : candidate,
                    ),
                );
                setSnapshotsBySessionId((current) => {
                    const existingState = current[session.sessionId];
                    if (!existingState) {
                        return current;
                    }

                    return {
                        ...current,
                        [session.sessionId]: {
                            ...existingState,
                            snapshot: existingState.snapshot
                                ? {
                                      ...existingState.snapshot,
                                      title: previousTitle,
                                  }
                                : null,
                        },
                    };
                });
                setSessionsError(
                    error instanceof Error
                        ? error.message
                        : "Could not rename this session.",
                );
            } finally {
                setMutatingSessionId(null);
            }
        },
        [updateSessionTabTitles],
    );

    const handleDelete = useCallback(
        async (session: AiHistorySessionSummary) => {
            const confirmed = window.confirm(
                `Delete "${session.title}" from chat history? This cannot be undone.`,
            );
            if (!confirmed) {
                return;
            }

            setMutatingSessionId(session.sessionId);
            setSessionsError(null);
            const previousSessions = sessions;
            const previousSelection = selectedSessionId;
            const previousTranscriptState =
                transcriptsBySessionId[session.sessionId] ?? null;
            const previousSnapshotState =
                snapshotsBySessionId[session.sessionId] ?? null;
            const remainingSessions = sessions.filter(
                (candidate) => candidate.sessionId !== session.sessionId,
            );
            const nextSelectedSessionId =
                selectedSessionId === session.sessionId
                    ? (remainingSessions[0]?.sessionId ?? null)
                    : selectedSessionId;

            setSessions(remainingSessions);
            setTranscriptsBySessionId((current) => {
                const next = { ...current };
                delete next[session.sessionId];
                return next;
            });
            setSnapshotsBySessionId((current) => {
                const next = { ...current };
                delete next[session.sessionId];
                return next;
            });
            setSelectedSessionId(nextSelectedSessionId);
            try {
                const matchingTabIds = Object.values(tabsById)
                    .filter(
                        (candidate) =>
                            (candidate.kind === "chat" ||
                                candidate.kind === "review") &&
                            candidate.sessionId === session.sessionId,
                    )
                    .map((candidate) => candidate.id);

                await getComandoApi().deleteAiSession(session.sessionId);

                for (const tabId of matchingTabIds) {
                    await closeTab(tabId);
                }
            } catch (error) {
                setSessions(previousSessions);
                setSelectedSessionId(previousSelection);
                setTranscriptsBySessionId((current) => ({
                    ...current,
                    ...(previousTranscriptState
                        ? {
                              [session.sessionId]: previousTranscriptState,
                          }
                        : {}),
                }));
                setSnapshotsBySessionId((current) => ({
                    ...current,
                    ...(previousSnapshotState
                        ? {
                              [session.sessionId]: previousSnapshotState,
                          }
                        : {}),
                }));
                setSessionsError(
                    error instanceof Error
                        ? error.message
                        : "Could not delete this session.",
                );
            } finally {
                setMutatingSessionId(null);
            }
        },
        [
            closeTab,
            selectedSessionId,
            sessions,
            snapshotsBySessionId,
            tabsById,
            transcriptsBySessionId,
        ],
    );

    const transcriptMessages = selectedTranscript?.messages ?? EMPTY_MESSAGES;
    const hasMoreMessages =
        selectedTranscript !== null &&
        transcriptMessages.length < selectedTranscript.totalMessages;
    const isBusy = mutatingSessionId !== null;
    const selectedSnapshot = selectedSnapshotState?.snapshot ?? null;
    const selectedSnapshotStatus = selectedSnapshot?.status ?? null;

    return (
        <ChatHistoryTabLayout
            hasMoreMessages={hasMoreMessages}
            handleDelete={handleDelete}
            handleOpenInChat={handleOpenInChat}
            handleRefresh={handleRefresh}
            handleRename={handleRename}
            isBusy={isBusy}
            isLoadingSessions={isLoadingSessions}
            loadSessionSnapshot={loadSessionSnapshot}
            loadTranscriptPage={loadTranscriptPage}
            mutatingSessionId={mutatingSessionId}
            scopeLabel={scopeLabel}
            selectedSession={selectedSession}
            selectedSessionId={selectedSessionId}
            selectedSnapshot={selectedSnapshot}
            selectedSnapshotState={selectedSnapshotState}
            selectedSnapshotStatus={selectedSnapshotStatus}
            selectedTranscript={selectedTranscript}
            sessions={sessions}
            sessionsError={sessionsError}
            setSelectedSessionId={setSelectedSessionId}
            tab={tab}
            transcriptMessages={transcriptMessages}
            worktreeLabel={worktreeLabel}
        />
    );
}

export function ChatHistoryTabLayout({
    hasMoreMessages,
    handleDelete,
    handleOpenInChat,
    handleRefresh,
    handleRename,
    isBusy,
    isLoadingSessions,
    loadSessionSnapshot,
    loadTranscriptPage,
    mutatingSessionId,
    scopeLabel,
    selectedSession,
    selectedSessionId,
    selectedSnapshot,
    selectedSnapshotState,
    selectedSnapshotStatus,
    selectedTranscript,
    sessions,
    sessionsError,
    setSelectedSessionId,
    tab,
    transcriptMessages,
    worktreeLabel,
}: ChatHistoryTabLayoutProps) {
    return (
        <div className="flex h-full min-h-0 flex-col bg-editor">
            <div className="border-b border-border px-4 py-3">
                <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                        <h2 className="text-sm font-medium text-text-primary">
                            Chat History
                        </h2>
                        <p className="mt-1 text-xs text-text-secondary">
                            Browse saved sessions for this workspace scope and
                            reopen any conversation in a live chat tab.
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        <div className="text-right text-[11px] text-text-secondary">
                            <div>{scopeLabel}</div>
                            <div>{worktreeLabel}</div>
                        </div>
                        <button
                            className={BUTTON_CLASS_NAME}
                            onClick={() => void handleRefresh()}
                            type="button"
                        >
                            Refresh
                        </button>
                    </div>
                </div>
                <div className="mt-2 flex min-h-[18px] items-center gap-3 text-[11px] text-text-secondary">
                    {isLoadingSessions ? <span>Loading sessions…</span> : null}
                    {sessionsError ? (
                        <span className="text-status-error">
                            {sessionsError}
                        </span>
                    ) : null}
                    {!isLoadingSessions && !sessionsError ? (
                        <span>{formatSessionCount(sessions.length)}</span>
                    ) : null}
                </div>
            </div>

            <div className="flex min-h-0 flex-1">
                <aside className="flex min-h-0 w-[340px] min-w-[300px] flex-col border-r border-border bg-bg-panel/40">
                    <div className="min-h-0 flex-1 overflow-y-auto p-3">
                        {isLoadingSessions && sessions.length === 0 ? (
                            <HistoryPlaceholder
                                body="Loading saved sessions for this scope."
                                title="Loading history"
                            />
                        ) : null}

                        {!isLoadingSessions &&
                        !sessionsError &&
                        sessions.length === 0 ? (
                            <HistoryPlaceholder
                                body="Start a conversation in this project and it will appear here once it has persisted."
                                title="No chat history yet"
                            />
                        ) : null}

                        {sessionsError && sessions.length === 0 ? (
                            <HistoryPlaceholder
                                body={sessionsError}
                                title="Could not load history"
                            />
                        ) : null}

                        {sessions.length > 0 ? (
                            <div className="space-y-3">
                                {sessions.map((session) => {
                                    const isSelected =
                                        session.sessionId === selectedSessionId;
                                    const isSessionBusy =
                                        mutatingSessionId ===
                                        session.sessionId;

                                    return (
                                        <div
                                            className={[
                                                "rounded-xl border transition",
                                                isSelected
                                                    ? "border-accent bg-bg-primary shadow-[0_0_0_1px_var(--color-accent)]"
                                                    : "border-border bg-bg-panel hover:border-border-strong hover:bg-bg-primary/80",
                                            ].join(" ")}
                                            key={session.sessionId}
                                        >
                                            <button
                                                className="flex w-full flex-col items-start gap-2 px-3 py-3 text-left"
                                                onClick={() =>
                                                    setSelectedSessionId(
                                                        session.sessionId,
                                                    )
                                                }
                                                type="button"
                                            >
                                                <div className="flex w-full items-start justify-between gap-3">
                                                    <div className="min-w-0">
                                                        <div className="truncate text-[13px] font-medium text-text-primary">
                                                            {session.title}
                                                        </div>
                                                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-text-secondary">
                                                            <span>
                                                                {getHistoryRuntimeLabel(
                                                                    session.runtimeId,
                                                                )}
                                                            </span>
                                                            <span>
                                                                {formatHistoryRelativeDate(
                                                                    session.updatedAt,
                                                                )}
                                                            </span>
                                                            <span>
                                                                {formatHistoryMessageCount(
                                                                    session.messageCount,
                                                                )}
                                                            </span>
                                                        </div>
                                                    </div>
                                                </div>
                                                <p className="line-clamp-3 text-[12px] leading-5 text-text-secondary">
                                                    {getHistoryPreviewText(
                                                        session,
                                                    )}
                                                </p>
                                            </button>
                                            <div className="flex items-center gap-2 border-t border-border/70 px-3 py-2">
                                                <button
                                                    className={BUTTON_CLASS_NAME}
                                                    disabled={isSessionBusy}
                                                    onClick={() =>
                                                        void handleOpenInChat(
                                                            session,
                                                        )
                                                    }
                                                    type="button"
                                                >
                                                    Open in Chat
                                                </button>
                                                <button
                                                    className={
                                                        SECONDARY_BUTTON_CLASS_NAME
                                                    }
                                                    disabled={isSessionBusy}
                                                    onClick={() =>
                                                        void handleRename(
                                                            session,
                                                        )
                                                    }
                                                    type="button"
                                                >
                                                    Rename
                                                </button>
                                                <button
                                                    className={
                                                        SECONDARY_BUTTON_CLASS_NAME
                                                    }
                                                    disabled={isSessionBusy}
                                                    onClick={() =>
                                                        void handleDelete(
                                                            session,
                                                        )
                                                    }
                                                    type="button"
                                                >
                                                    Delete
                                                </button>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        ) : null}
                    </div>
                </aside>

                <section className="flex min-h-0 min-w-0 flex-1 flex-col">
                    {selectedSession ? (
                        <>
                            <div className="border-b border-border px-5 py-4">
                                <div className="flex items-start justify-between gap-4">
                                    <div className="min-w-0">
                                        <h3 className="truncate text-sm font-medium text-text-primary">
                                            {selectedSession.title}
                                        </h3>
                                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-secondary">
                                            <span>
                                                {getHistoryRuntimeLabel(
                                                    selectedSession.runtimeId,
                                                )}
                                            </span>
                                            {selectedSnapshotStatus ? (
                                                <span>
                                                    {formatSessionStatus(
                                                        selectedSnapshotStatus,
                                                    )}
                                                </span>
                                            ) : null}
                                            <span>
                                                Updated{" "}
                                                {formatHistoryRelativeDate(
                                                    selectedSession.updatedAt,
                                                )}
                                            </span>
                                            <span>
                                                {formatHistoryMessageCount(
                                                    selectedSession.messageCount,
                                                )}
                                            </span>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <button
                                            className={BUTTON_CLASS_NAME}
                                            onClick={() =>
                                                void handleOpenInChat(
                                                    selectedSession,
                                                )
                                            }
                                            type="button"
                                        >
                                            Open in Chat
                                        </button>
                                        <button
                                            className={
                                                SECONDARY_BUTTON_CLASS_NAME
                                            }
                                            onClick={() =>
                                                void Promise.all([
                                                    loadSessionSnapshot(
                                                        selectedSession.sessionId,
                                                        true,
                                                    ),
                                                    loadTranscriptPage(
                                                        selectedSession.sessionId,
                                                        true,
                                                    ),
                                                ])
                                            }
                                            type="button"
                                        >
                                            Reload Detail
                                        </button>
                                    </div>
                                </div>
                                <div className="mt-2 flex min-h-[18px] items-center gap-3 text-[11px] text-text-secondary">
                                    {selectedSnapshotState?.isLoading ? (
                                        <span>Loading session detail…</span>
                                    ) : null}
                                    {selectedSnapshotState?.error ? (
                                        <span className="text-status-error">
                                            {selectedSnapshotState.error}
                                        </span>
                                    ) : null}
                                </div>
                            </div>

                            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                                {selectedSnapshot ? (
                                    <div className="mb-4">
                                        <HistorySessionArtifacts
                                            snapshot={selectedSnapshot}
                                        />
                                    </div>
                                ) : null}

                                {selectedTranscript?.isLoading &&
                                transcriptMessages.length === 0 ? (
                                    <HistoryPlaceholder
                                        body="Loading the saved transcript for this session."
                                        title="Loading transcript"
                                    />
                                ) : null}

                                {selectedTranscript?.error &&
                                transcriptMessages.length === 0 ? (
                                    <HistoryPlaceholder
                                        action={
                                            <button
                                                className={BUTTON_CLASS_NAME}
                                                onClick={() =>
                                                    void loadTranscriptPage(
                                                        selectedSession.sessionId,
                                                        true,
                                                    )
                                                }
                                                type="button"
                                            >
                                                Retry
                                            </button>
                                        }
                                        body={selectedTranscript.error}
                                        title="Could not load transcript"
                                    />
                                ) : null}

                                {!selectedTranscript?.isLoading &&
                                !selectedTranscript?.error &&
                                transcriptMessages.length === 0 ? (
                                    <HistoryPlaceholder
                                        body="This session exists in history, but no transcript messages were found."
                                        title="No transcript messages"
                                    />
                                ) : null}

                                {transcriptMessages.length > 0 ? (
                                    <div className="space-y-4">
                                        {transcriptMessages.map((message) => {
                                            const tone =
                                                getMessageTone(message.kind);
                                            return (
                                                <article
                                                    className="rounded-xl border border-border bg-bg-panel/80 px-4 py-3"
                                                    key={message.id}
                                                >
                                                    <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px]">
                                                        <span
                                                            className={[
                                                                "rounded-full px-2 py-0.5 font-medium",
                                                                tone.badgeClassName,
                                                            ].join(" ")}
                                                        >
                                                            {tone.label}
                                                        </span>
                                                        <span className="text-text-secondary">
                                                            {formatHistoryRelativeDate(
                                                                message.createdAt,
                                                            )}
                                                        </span>
                                                        {message.attachments
                                                            .length > 0 ? (
                                                            <span className="text-text-secondary">
                                                                {formatAttachmentCount(
                                                                    message.attachments.length,
                                                                )}
                                                            </span>
                                                        ) : null}
                                                    </div>
                                                    {message.content.trim()
                                                        .length > 0 ? (
                                                        <div className="text-[13px] leading-6 text-text-primary">
                                                            <MarkdownContent
                                                                content={
                                                                    message.content
                                                                }
                                                            />
                                                        </div>
                                                    ) : (
                                                        <p className="text-[12px] italic text-text-secondary">
                                                            Empty message
                                                        </p>
                                                    )}
                                                </article>
                                            );
                                        })}

                                        <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
                                            <div className="text-[11px] text-text-secondary">
                                                {selectedTranscript
                                                    ?.isLoading &&
                                                transcriptMessages.length > 0
                                                    ? "Loading more messages…"
                                                    : `${transcriptMessages.length} of ${selectedTranscript?.totalMessages ?? transcriptMessages.length} loaded`}
                                            </div>
                                            {hasMoreMessages ? (
                                                <button
                                                    className={
                                                        BUTTON_CLASS_NAME
                                                    }
                                                    disabled={
                                                        selectedTranscript?.isLoading
                                                    }
                                                    onClick={() =>
                                                        void loadTranscriptPage(
                                                            selectedSession.sessionId,
                                                        )
                                                    }
                                                    type="button"
                                                >
                                                    Load More
                                                </button>
                                            ) : null}
                                        </div>

                                        {selectedTranscript?.error &&
                                        transcriptMessages.length > 0 ? (
                                            <p className="text-[11px] text-status-error">
                                                {selectedTranscript.error}
                                            </p>
                                        ) : null}
                                    </div>
                                ) : null}
                            </div>
                        </>
                    ) : (
                        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
                            <HistoryPlaceholder
                                body="Select a session on the left to inspect its transcript."
                                title="Pick a conversation"
                            />
                        </div>
                    )}
                </section>
            </div>

            {isBusy ? (
                <div className="border-t border-border px-4 py-2 text-[11px] text-text-secondary">
                    Applying history changes…
                </div>
            ) : null}
        </div>
    );
}

function HistoryPlaceholder({
    action,
    body,
    title,
}: {
    readonly action?: ReactNode;
    readonly body: string;
    readonly title: string;
}) {
    return (
        <div className="flex h-full min-h-[160px] items-center justify-center">
            <div className="max-w-md rounded-xl border border-border bg-bg-panel px-4 py-5 text-center">
                <p className="text-sm font-medium text-text-primary">{title}</p>
                <p className="mt-2 text-xs leading-5 text-text-secondary">
                    {body}
                </p>
                {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
            </div>
        </div>
    );
}

function formatSessionCount(count: number): string {
    return count === 1 ? "1 session" : `${count} sessions`;
}

function formatAttachmentCount(count: number): string {
    return count === 1 ? "1 attachment" : `${count} attachments`;
}

function mergeTranscriptMessages(
    current: readonly AiMessage[],
    incoming: readonly AiMessage[],
): readonly AiMessage[] {
    const seenIds = new Set(current.map((message) => message.id));
    const nextMessages = [...current];

    for (const message of incoming) {
        if (seenIds.has(message.id)) {
            continue;
        }

        seenIds.add(message.id);
        nextMessages.push(message);
    }

    return nextMessages;
}

function getMessageTone(kind: AiMessageKind): {
    readonly badgeClassName: string;
    readonly label: string;
} {
    switch (kind) {
        case "assistant":
            return {
                badgeClassName:
                    "bg-accent/12 text-accent border border-accent/20",
                label: "Assistant",
            };
        case "thinking":
            return {
                badgeClassName:
                    "border border-border-strong bg-bg-tertiary text-text-secondary",
                label: "Thinking",
            };
        case "user_input_request":
            return {
                badgeClassName:
                    "border border-amber-400/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
                label: "Question",
            };
        case "user":
        default:
            return {
                badgeClassName:
                    "border border-border-strong bg-bg-primary text-text-primary",
                label: "User",
            };
    }
}

function formatSessionStatus(status: AiSessionStatus): string {
    switch (status) {
        case "waiting_permission":
            return "Waiting Permission";
        case "waiting_user_input":
            return "Waiting Input";
        case "starting":
            return "Starting";
        case "streaming":
            return "Streaming";
        case "error":
            return "Error";
        case "idle":
        default:
            return "Idle";
    }
}

function getComandoApi() {
    if (!window.comando) {
        throw new Error(
            "The desktop bridge is not available yet. Restart the Electron app and try again.",
        );
    }

    return window.comando;
}

const BUTTON_CLASS_NAME =
    "app-no-drag rounded-md border border-border-strong bg-bg-primary px-2.5 py-1.5 text-[11px] font-medium text-text-primary transition hover:bg-bg-tertiary disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY_BUTTON_CLASS_NAME =
    "app-no-drag rounded-md px-2 py-1.5 text-[11px] text-text-secondary transition hover:bg-bg-tertiary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50";
