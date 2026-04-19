import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type MouseEvent as ReactMouseEvent,
} from "react";

import type { AiHistorySessionSummary, ComandoApi } from "@shared/ipc";
import { truncateChatTitle } from "@shared/chatTitle";

import { useAiStore } from "@renderer/app/store/ai-store";
import { useWorkspaceStore } from "@renderer/app/store/workspace-store";

import {
    ContextMenu,
    type ContextMenuEntry,
    type ContextMenuState,
} from "@renderer/components/context-menu/ContextMenu";
import {
    formatHistoryMessageCount,
    formatHistoryRelativeDate,
    getHistoryRuntimeLabel,
} from "@renderer/components/workspace/chat-history/historyPresentation";
import { getHistoryPreviewText } from "@renderer/components/workspace/chat-history/historyPreview";
import {
    resolveWorkspaceChatTabActivityIndicator,
    type WorkspaceChatTabActivityIndicator,
} from "@renderer/components/workspace/workspaceTabActivity";

import {
    applySessionUpdateToSidebarHistory,
    SIDEBAR_AGENTS_HISTORY_LIMIT,
    type SidebarAgentsHistoryUnknownSessionSeed,
} from "./sidebarAgentsHistory";

interface SidebarAgentsContextMenuPayload {
    readonly sessionId: string;
}

const SIDEBAR_AGENTS_TITLE_MAX_CHARS = 48;
const SIDEBAR_AGENTS_REFRESH_DEBOUNCE_MS = 800;

export function SidebarAgentsPanel({
    filter,
    projectId,
    worktreeId,
}: {
    readonly filter?: string;
    readonly projectId: string | null;
    readonly worktreeId: string | null;
}) {
    const openChatSessionTab = useWorkspaceStore(
        (state) => state.openChatSessionTab,
    );
    const openChatHistoryTab = useWorkspaceStore(
        (state) => state.openChatHistoryTab,
    );
    const closeTab = useWorkspaceStore((state) => state.closeTab);
    const updateSessionTabTitles = useWorkspaceStore(
        (state) => state.updateSessionTabTitles,
    );
    const tabsById = useWorkspaceStore((state) => state.tabsById);

    const [sessions, setSessions] = useState<readonly AiHistorySessionSummary[]>(
        [],
    );
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [contextMenu, setContextMenu] = useState<
        ContextMenuState<SidebarAgentsContextMenuPayload> | null
    >(null);
    const [renamingSessionId, setRenamingSessionId] = useState<string | null>(
        null,
    );
    const [renameDraft, setRenameDraft] = useState("");
    const requestIdRef = useRef(0);
    const refreshTimerRef = useRef<number | null>(null);
    const normalizedFilter = (filter ?? "").trim().toLowerCase();
    const hasQuery = normalizedFilter.length > 0;

    const loadSessions = useCallback(async () => {
        const api = getComandoApi();
        if (!api) {
            return;
        }

        const requestId = requestIdRef.current + 1;
        requestIdRef.current = requestId;

        setIsLoading(true);
        setError(null);
        try {
            const nextSessions = await api.listAiSessionHistory({
                limit: SIDEBAR_AGENTS_HISTORY_LIMIT,
                projectId,
                worktreeId: worktreeId ?? null,
            });
            if (requestIdRef.current !== requestId) {
                return;
            }
            setSessions(nextSessions);
        } catch (err) {
            if (requestIdRef.current !== requestId) {
                return;
            }
            setError(
                err instanceof Error
                    ? err.message
                    : "Could not load threads history.",
            );
        } finally {
            if (requestIdRef.current === requestId) {
                setIsLoading(false);
            }
        }
    }, [projectId, worktreeId]);

    const clearRefreshTimer = useCallback(() => {
        if (refreshTimerRef.current !== null) {
            window.clearTimeout(refreshTimerRef.current);
            refreshTimerRef.current = null;
        }
    }, []);

    const scheduleReload = useCallback(() => {
        if (refreshTimerRef.current !== null) {
            return;
        }

        refreshTimerRef.current = window.setTimeout(() => {
            refreshTimerRef.current = null;
            void loadSessions();
        }, SIDEBAR_AGENTS_REFRESH_DEBOUNCE_MS);
    }, [loadSessions]);

    useEffect(() => {
        setSessions([]);
        setError(null);
        clearRefreshTimer();
        void loadSessions();
    }, [clearRefreshTimer, loadSessions]);

    useEffect(() => clearRefreshTimer, [clearRefreshTimer]);

    useEffect(() => {
        const api = getComandoApi();
        if (!api) {
            return;
        }

        const unsubscribe = api.onAiSessionSnapshot((update) => {
            let needsReload = false;

            setSessions((current) => {
                const result = applySessionUpdateToSidebarHistory({
                    limit: SIDEBAR_AGENTS_HISTORY_LIMIT,
                    scope: {
                        projectId,
                        worktreeId: worktreeId ?? null,
                    },
                    sessions: current,
                    unknownSessionSeed:
                        update.kind === "patch"
                            ? buildUnknownSessionSeed(
                                  useAiStore.getState().sessions[
                                      update.patch.sessionId
                                  ],
                              )
                            : null,
                    update,
                });
                needsReload = result.needsReload;
                return result.sessions;
            });

            if (needsReload) {
                scheduleReload();
            }
        });
        return () => {
            unsubscribe();
        };
    }, [projectId, scheduleReload, worktreeId]);

    const handleOpenSession = useCallback(
        (session: AiHistorySessionSummary) => {
            void openChatSessionTab({
                projectId: session.projectId,
                runtimeId: session.runtimeId,
                sessionId: session.sessionId,
                title: session.title,
                worktreeId: session.worktreeId ?? null,
            });
        },
        [openChatSessionTab],
    );

    const handleOpenHistoryTab = useCallback(() => {
        void openChatHistoryTab(projectId, worktreeId);
    }, [openChatHistoryTab, projectId, worktreeId]);

    const handleContextMenu = useCallback(
        (event: ReactMouseEvent, session: AiHistorySessionSummary) => {
            event.preventDefault();
            event.stopPropagation();
            setContextMenu({
                x: event.clientX,
                y: event.clientY,
                payload: { sessionId: session.sessionId },
            });
        },
        [],
    );

    const startRename = useCallback(
        (session: AiHistorySessionSummary) => {
            setRenamingSessionId(session.sessionId);
            setRenameDraft(session.title);
        },
        [],
    );

    const cancelRename = useCallback(() => {
        setRenamingSessionId(null);
        setRenameDraft("");
    }, []);

    const commitRename = useCallback(async () => {
        if (!renamingSessionId) {
            return;
        }

        const session = sessions.find(
            (candidate) => candidate.sessionId === renamingSessionId,
        );
        const trimmedTitle = renameDraft.trim();
        const targetSessionId = renamingSessionId;

        setRenamingSessionId(null);
        setRenameDraft("");

        if (
            !session ||
            trimmedTitle.length === 0 ||
            trimmedTitle === session.title
        ) {
            return;
        }

        const previousTitle = session.title;
        setSessions((current) =>
            current.map((candidate) =>
                candidate.sessionId === targetSessionId
                    ? { ...candidate, title: trimmedTitle }
                    : candidate,
            ),
        );

        try {
            const api = getComandoApi();
            if (!api) {
                return;
            }
            await api.renameAiSession({
                sessionId: targetSessionId,
                title: trimmedTitle,
            });
            await updateSessionTabTitles(targetSessionId, trimmedTitle);
        } catch (err) {
            setSessions((current) =>
                current.map((candidate) =>
                    candidate.sessionId === targetSessionId
                        ? { ...candidate, title: previousTitle }
                        : candidate,
                ),
            );
            setError(
                err instanceof Error
                    ? err.message
                    : "Could not rename this thread.",
            );
        }
    }, [renameDraft, renamingSessionId, sessions, updateSessionTabTitles]);

    const handleDelete = useCallback(
        async (session: AiHistorySessionSummary) => {
            const confirmed = window.confirm(
                `Delete "${session.title}" from threads? This cannot be undone.`,
            );
            if (!confirmed) {
                return;
            }

            const api = getComandoApi();
            if (!api) {
                return;
            }

            const previousSessions = sessions;
            setSessions((current) =>
                current.filter(
                    (candidate) => candidate.sessionId !== session.sessionId,
                ),
            );

            try {
                const tabsById = useWorkspaceStore.getState().tabsById;
                const matchingTabIds = Object.values(tabsById)
                    .filter(
                        (candidate) =>
                            (candidate.kind === "chat" ||
                                candidate.kind === "review") &&
                            candidate.sessionId === session.sessionId,
                    )
                    .map((candidate) => candidate.id);

                await api.deleteAiSession(session.sessionId);

                for (const tabId of matchingTabIds) {
                    await closeTab(tabId);
                }
            } catch (err) {
                setSessions(previousSessions);
                setError(
                    err instanceof Error
                        ? err.message
                        : "Could not delete this thread.",
                );
            }
        },
        [closeTab, sessions],
    );

    const contextMenuEntries = useMemo<readonly ContextMenuEntry[]>(() => {
        if (!contextMenu) {
            return [];
        }

        const session = sessions.find(
            (candidate) =>
                candidate.sessionId === contextMenu.payload.sessionId,
        );
        if (!session) {
            return [];
        }

        return [
            {
                label: "Rename",
                action: () => startRename(session),
            },
            {
                label: "Delete",
                danger: true,
                action: () => void handleDelete(session),
            },
        ];
    }, [contextMenu, handleDelete, sessions, startRename]);

    const filteredSessions = useMemo(() => {
        if (!hasQuery) {
            return sessions;
        }

        return sessions.filter((session) => {
            const preview = (session.preview ?? "").toLowerCase();
            return (
                session.title.toLowerCase().includes(normalizedFilter) ||
                preview.includes(normalizedFilter)
            );
        });
    }, [hasQuery, normalizedFilter, sessions]);

    const openSessionIds = useMemo(() => {
        const ids = new Set<string>();
        for (const tab of Object.values(tabsById)) {
            if (tab.kind === "chat" || tab.kind === "review") {
                ids.add(tab.sessionId);
            }
        }
        return ids;
    }, [tabsById]);

    const aiSessions = useAiStore((state) => state.sessions);
    const openSessions = useMemo(() => {
        const list = filteredSessions.filter((session) =>
            openSessionIds.has(session.sessionId),
        );
        return [...list].sort((a, b) => {
            const aWorking = isSessionWorking(aiSessions[a.sessionId]);
            const bWorking = isSessionWorking(aiSessions[b.sessionId]);
            if (aWorking === bWorking) {
                return 0;
            }
            return aWorking ? -1 : 1;
        });
    }, [aiSessions, filteredSessions, openSessionIds]);
    const otherSessions = useMemo(
        () =>
            filteredSessions.filter(
                (session) => !openSessionIds.has(session.sessionId),
            ),
        [filteredSessions, openSessionIds],
    );
    const showSectionHeaders =
        openSessions.length > 0 && otherSessions.length > 0;

    const statusLine = isLoading
        ? "Loading..."
        : error
          ? error
          : hasQuery
            ? `${filteredSessions.length} of ${sessions.length}`
            : formatSessionCount(sessions.length);

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="flex shrink-0 items-center gap-1 px-2 py-1.5">
                <span
                    className={[
                        "min-w-0 flex-1 truncate text-[11px] font-medium",
                        error
                            ? "text-[var(--diff-remove)]"
                            : "text-text-secondary",
                    ].join(" ")}
                >
                    {statusLine}
                </span>
                <button
                    className="rounded px-1.5 py-0.5 text-[10px] font-medium text-text-secondary transition-colors hover:bg-bg-elevated hover:text-text-primary"
                    onClick={handleOpenHistoryTab}
                    title="Open full history"
                    type="button"
                >
                    History
                </button>
            </div>

            <div className="shell-scrollbar min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1 pb-2">
                {!isLoading && !error && sessions.length === 0 ? (
                    <SidebarAgentsPlaceholder
                        body={
                            projectId
                                ? "No threads yet for this scope."
                                : "Open a project to see its threads."
                        }
                    />
                ) : null}

                {!isLoading &&
                !error &&
                sessions.length > 0 &&
                filteredSessions.length === 0 ? (
                    <SidebarAgentsPlaceholder
                        body={`No threads match "${(filter ?? "").trim()}".`}
                    />
                ) : null}

                {openSessions.length > 0 ? (
                    <SidebarAgentsSection
                        cancelRename={cancelRename}
                        commitRename={() => void commitRename()}
                        onContextMenu={handleContextMenu}
                        onOpen={handleOpenSession}
                        onRenameDraftChange={setRenameDraft}
                        renameDraft={renameDraft}
                        renamingSessionId={renamingSessionId}
                        sessions={openSessions}
                        title={showSectionHeaders ? "Open" : null}
                    />
                ) : null}

                {otherSessions.length > 0 ? (
                    <SidebarAgentsSection
                        cancelRename={cancelRename}
                        commitRename={() => void commitRename()}
                        onContextMenu={handleContextMenu}
                        onOpen={handleOpenSession}
                        onRenameDraftChange={setRenameDraft}
                        renameDraft={renameDraft}
                        renamingSessionId={renamingSessionId}
                        sessions={otherSessions}
                        title={showSectionHeaders ? "All" : null}
                    />
                ) : null}
            </div>

            {contextMenu ? (
                <ContextMenu
                    entries={contextMenuEntries}
                    menu={contextMenu}
                    minWidth={160}
                    onClose={() => setContextMenu(null)}
                />
            ) : null}
        </div>
    );
}

function SidebarAgentsSection({
    cancelRename,
    commitRename,
    onContextMenu,
    onOpen,
    onRenameDraftChange,
    renameDraft,
    renamingSessionId,
    sessions,
    title,
}: {
    readonly cancelRename: () => void;
    readonly commitRename: () => void;
    readonly onContextMenu: (
        event: ReactMouseEvent,
        session: AiHistorySessionSummary,
    ) => void;
    readonly onOpen: (session: AiHistorySessionSummary) => void;
    readonly onRenameDraftChange: (value: string) => void;
    readonly renameDraft: string;
    readonly renamingSessionId: string | null;
    readonly sessions: readonly AiHistorySessionSummary[];
    readonly title: string | null;
}) {
    return (
        <section className="mt-1 first:mt-0">
            {title ? (
                <header className="flex items-center gap-1.5 px-2 pb-0.5 pt-1 text-[9.5px] font-semibold uppercase tracking-[0.08em] text-text-secondary/80">
                    <span>{title}</span>
                    <span className="font-normal opacity-70">
                        {sessions.length}
                    </span>
                </header>
            ) : null}
            <ul className="flex flex-col gap-0.5">
                {sessions.map((session) => (
                    <li key={session.sessionId}>
                        <SidebarAgentsItem
                            isRenaming={renamingSessionId === session.sessionId}
                            onCancelRename={cancelRename}
                            onCommitRename={commitRename}
                            onContextMenu={onContextMenu}
                            onOpen={onOpen}
                            onRenameDraftChange={onRenameDraftChange}
                            renameDraft={renameDraft}
                            session={session}
                        />
                    </li>
                ))}
            </ul>
        </section>
    );
}

function SidebarAgentsItem({
    isRenaming,
    onCancelRename,
    onCommitRename,
    onContextMenu,
    onOpen,
    onRenameDraftChange,
    renameDraft,
    session,
}: {
    readonly isRenaming: boolean;
    readonly onCancelRename: () => void;
    readonly onCommitRename: () => void;
    readonly onContextMenu: (
        event: ReactMouseEvent,
        session: AiHistorySessionSummary,
    ) => void;
    readonly onOpen: (session: AiHistorySessionSummary) => void;
    readonly onRenameDraftChange: (value: string) => void;
    readonly renameDraft: string;
    readonly session: AiHistorySessionSummary;
}) {
    const preview = getHistoryPreviewText(session);
    const title = truncateChatTitle(session.title, SIDEBAR_AGENTS_TITLE_MAX_CHARS);
    const activity = useAgentActivityIndicator(session.sessionId);
    const timestampLabel = activity
        ? activity.tone === "danger"
            ? "Error"
            : "Working…"
        : formatHistoryRelativeDate(session.updatedAt);
    const timestampClassName = activity
        ? activity.tone === "danger"
            ? "text-rose-500"
            : "text-(--diff-warn)"
        : "text-text-secondary";

    return (
        <div
            className="sidebar-agents-row app-no-drag w-full"
            onClick={() => {
                if (isRenaming) return;
                onOpen(session);
            }}
            onContextMenu={(event) => onContextMenu(event, session)}
            onKeyDown={(event) => {
                if (isRenaming) return;
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onOpen(session);
                }
            }}
            role="button"
            tabIndex={isRenaming ? -1 : 0}
            title={session.title}
        >
            <div className="flex w-full min-w-0 items-center gap-2">
                <SidebarAgentActivityDot indicator={activity} />
                {isRenaming ? (
                    <input
                        autoFocus
                        className="min-w-0 flex-1 rounded border border-border-strong bg-bg-primary px-1 py-0.5 text-[11.5px] font-medium text-text-primary outline-none focus:border-accent"
                        onBlur={onCommitRename}
                        onChange={(event) =>
                            onRenameDraftChange(event.target.value)
                        }
                        onClick={(event) => event.stopPropagation()}
                        onKeyDown={(event) => {
                            event.stopPropagation();
                            if (event.key === "Enter") {
                                event.preventDefault();
                                onCommitRename();
                            } else if (event.key === "Escape") {
                                event.preventDefault();
                                onCancelRename();
                            }
                        }}
                        type="text"
                        value={renameDraft}
                    />
                ) : (
                    <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-text-primary">
                        {title}
                    </span>
                )}
                {isRenaming ? null : (
                    <span
                        className={`shrink-0 text-[10px] ${timestampClassName}`}
                        title={activity?.title}
                    >
                        {timestampLabel}
                    </span>
                )}
            </div>
            <p className="line-clamp-1 w-full text-left text-[10.5px] leading-[1.35] text-text-secondary">
                {preview}
            </p>
            <div className="flex w-full min-w-0 items-center gap-1.5 text-[10px] text-text-secondary">
                <span className="shrink-0">
                    {getHistoryRuntimeLabel(session.runtimeId)}
                </span>
                <span aria-hidden="true" className="shrink-0">
                    ·
                </span>
                <span className="shrink-0">
                    {formatHistoryMessageCount(session.messageCount)}
                </span>
            </div>
        </div>
    );
}

function useAgentActivityIndicator(
    sessionId: string,
): WorkspaceChatTabActivityIndicator {
    const localError = useAiStore(
        (state) => state.sessions[sessionId]?.localError ?? null,
    );
    const status = useAiStore(
        (state) => state.sessions[sessionId]?.snapshot?.status ?? null,
    );
    return useMemo(
        () =>
            resolveWorkspaceChatTabActivityIndicator({
                localError,
                snapshot: status ? { status } : null,
            }),
        [localError, status],
    );
}

function SidebarAgentActivityDot({
    indicator,
}: {
    readonly indicator: WorkspaceChatTabActivityIndicator;
}) {
    if (!indicator) {
        return null;
    }

    return (
        <span
            aria-hidden="true"
            className={[
                "shrink-0 text-[9px] leading-none",
                indicator.tone === "danger"
                    ? "text-rose-500"
                    : "text-(--diff-warn)",
            ].join(" ")}
            title={indicator.title}
        >
            ●
        </span>
    );
}

function SidebarAgentsPlaceholder({ body }: { readonly body: string }) {
    return (
        <div className="flex min-h-[80px] items-center justify-center px-3 py-6">
            <p className="text-center text-[11px] leading-[1.5] text-text-secondary">
                {body}
            </p>
        </div>
    );
}

function isSessionWorking(
    entry: ReturnType<typeof useAiStore.getState>["sessions"][string] | undefined,
): boolean {
    if (!entry) {
        return false;
    }
    const indicator = resolveWorkspaceChatTabActivityIndicator({
        localError: entry.localError ?? null,
        snapshot: entry.snapshot ? { status: entry.snapshot.status } : null,
    });
    return indicator?.tone === "working";
}

function buildUnknownSessionSeed(
    entry: ReturnType<typeof useAiStore.getState>["sessions"][string] | undefined,
): SidebarAgentsHistoryUnknownSessionSeed | null {
    if (!entry) {
        return null;
    }

    const title = entry.snapshot?.title ?? entry.meta?.title ?? "";
    if (title.trim().length === 0) {
        return null;
    }

    return {
        messages: entry.snapshot?.messages ?? null,
        projectId: entry.snapshot?.projectId ?? entry.meta?.projectId ?? null,
        title,
        updatedAt: entry.snapshot?.updatedAt ?? null,
        worktreeId: entry.snapshot?.worktreeId ?? entry.meta?.worktreeId ?? null,
    };
}

function formatSessionCount(count: number): string {
    return count === 1 ? "1 thread" : `${count} threads`;
}

function getComandoApi(): ComandoApi | null {
    return typeof window !== "undefined" ? (window.comando ?? null) : null;
}
