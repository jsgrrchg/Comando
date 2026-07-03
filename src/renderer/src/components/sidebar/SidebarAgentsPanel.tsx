import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type CSSProperties,
    type MouseEvent as ReactMouseEvent,
    type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";

import type {
    AiHistorySessionSummary,
    AiRuntimeId,
    ComandoApi,
} from "@shared/ipc";
import {
    ACTIVE_AI_RUNTIME_IDS,
    type ActiveAiRuntimeId,
} from "@shared/ai-runtimes";
import { truncateChatTitle } from "@shared/chatTitle";

import { useAiStore } from "@renderer/app/store/ai-store";
import { useWorkspaceStore } from "@renderer/app/store/workspace-store";
import { collectPaneNodes } from "@renderer/app/workspace/tree";
import {
    checkClaudeCodeInstalled,
    launchClaudeCodeTerminal,
} from "@renderer/features/terminal/claudeCodeTerminal";
import {
    CLAUDE_CODE_TERMINAL_RUNTIME_ID,
    closeClaudeCodeSidebarSession,
    focusClaudeCodeSidebarSession,
    getClaudeCodeSidebarSessionByTerminalId,
    getClaudeCodeSidebarSessions,
    isClaudeCodeSidebarSession,
    reconcileClaudeCodeSidebarSessions,
    refreshClaudeCodeSidebarSessionTranscript,
    renameClaudeCodeSidebarSession,
    subscribeClaudeCodeSidebarSessions,
    type SidebarAgentSessionSummary,
} from "@renderer/features/terminal/claudeCodeSidebarSession";

import {
    ContextMenu,
    type ContextMenuEntry,
    type ContextMenuState,
} from "@renderer/components/context-menu/ContextMenu";
import {
    formatHistoryMessageCount,
    formatHistoryRelativeDateCompact,
    getHistoryRuntimeLabel,
} from "@renderer/components/workspace/chat-history/historyPresentation";
import { getHistoryPreviewText } from "@renderer/components/workspace/chat-history/historyPreview";
import {
    buildAiSessionHierarchyGroups,
    countAiHistorySessionChildren,
    filterAiSessionHierarchyRowsForCollapsedParents,
    isAiHistorySessionChildOfParent,
    type AiSessionHierarchyGroup,
    type AiSessionHierarchyRow,
} from "@renderer/components/workspace/chat-history/sessionHierarchy";
import {
    resolveWorkspaceChatTabActivityIndicator,
    type WorkspaceChatTabActivityIndicator,
} from "@renderer/components/workspace/workspaceTabActivity";

import {
    applySessionUpdateToSidebarHistory,
    SIDEBAR_AGENTS_HISTORY_LIMIT,
    type SidebarAgentsHistoryUnknownSessionSeed,
} from "./sidebarAgentsHistory";
import {
    getSidebarAgentsHistoryCacheKey,
    readSidebarAgentsHistoryCache,
    writeSidebarAgentsHistoryCache,
} from "./sidebarAgentsHistoryCache";
import {
    persistSidebarAgentsCollapsedSessionIds,
    readSidebarAgentsCollapsedSessionIds,
} from "./sidebarAgentsCollapseState";
import { emitSidebarAgentDrag } from "./sidebarAgentDragEvents";
import {
    shouldCancelSidebarDragOnMove,
    shouldEmitSidebarDragCancel,
} from "./sidebarDragGuards";

interface SidebarAgentsContextMenuPayload {
    readonly sessionId: string;
}

type SidebarAgentDragPreview = {
    readonly activity: WorkspaceChatTabActivityIndicator;
    readonly runtimeLabel: string;
    readonly title: string;
    readonly x: number;
    readonly y: number;
};

const SIDEBAR_AGENTS_TITLE_MAX_CHARS = 48;
const SIDEBAR_AGENTS_REFRESH_DEBOUNCE_MS = 800;
const EMPTY_AGENTS_SESSIONS: readonly AiHistorySessionSummary[] = [];
const EMPTY_COLLAPSED_IDS: ReadonlySet<string> = new Set();

const SIDEBAR_AGENTS_NEW_RUNTIMES = ACTIVE_AI_RUNTIME_IDS;
const SIDEBAR_AGENT_DRAG_THRESHOLD_PX = 6;
const CLAUDE_CODE_TERMINAL_DESCRIPTION =
    "Open the claude CLI in a workspace terminal.";
const CLAUDE_CODE_NOT_FOUND_MESSAGE =
    "The claude command was not found in Comando's PATH. Your shell may still resolve it.";

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
    const createChatTab = useWorkspaceStore((state) => state.createChatTab);
    const closeTab = useWorkspaceStore((state) => state.closeTab);
    const updateSessionTabTitles = useWorkspaceStore(
        (state) => state.updateSessionTabTitles,
    );
    const tabsById = useWorkspaceStore((state) => state.tabsById);
    const activePaneSessionId = useWorkspaceStore((state) => {
        const activePane = collectPaneNodes(state.rootNode).find(
            (pane) => pane.id === state.activePaneId,
        );
        const activeTab = activePane?.activeTabId
            ? state.tabsById[activePane.activeTabId]
            : null;

        if (activeTab?.kind === "chat" || activeTab?.kind === "review") {
            return activeTab.sessionId;
        }
        if (activeTab?.kind === "terminal") {
            return (
                getClaudeCodeSidebarSessionByTerminalId(activeTab.terminalId)
                    ?.sessionId ?? null
            );
        }
        return null;
    });
    const historyScopeKey = useMemo(
        () => getSidebarAgentsHistoryCacheKey(projectId, worktreeId),
        [projectId, worktreeId],
    );

    const [sessions, setSessions] = useState<readonly AiHistorySessionSummary[]>(
        () => readSidebarAgentsHistoryCache(projectId, worktreeId)?.sessions ?? [],
    );
    const [terminalAgentSessions, setTerminalAgentSessions] = useState(
        () => getClaudeCodeSidebarSessions(),
    );
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [contextMenu, setContextMenu] = useState<
        ContextMenuState<SidebarAgentsContextMenuPayload> | null
    >(null);
    const [newAgentMenu, setNewAgentMenu] = useState<
        ContextMenuState<undefined> | null
    >(null);
    const [renamingSessionId, setRenamingSessionId] = useState<string | null>(
        null,
    );
    const [renameDraft, setRenameDraft] = useState("");
    const [claudeCodeAvailable, setClaudeCodeAvailable] = useState<
        boolean | null
    >(null);
    const [collapsedSessionIds, setCollapsedSessionIds] = useState<
        ReadonlySet<string>
    >(() => readSidebarAgentsCollapsedSessionIds(projectId, worktreeId));
    const [loadedHistoryScopeKey, setLoadedHistoryScopeKey] = useState<
        string | null
    >(
        () =>
            readSidebarAgentsHistoryCache(projectId, worktreeId)
                ? historyScopeKey
                : null,
    );
    const requestIdRef = useRef(0);
    const refreshTimerRef = useRef<number | null>(null);
    const deletedSessionIdsRef = useRef<Set<string>>(new Set());
    const normalizedFilter = (filter ?? "").trim().toLowerCase();
    const hasQuery = normalizedFilter.length > 0;
    const pendingHistoryCache =
        loadedHistoryScopeKey === historyScopeKey
            ? null
            : readSidebarAgentsHistoryCache(projectId, worktreeId);
    const visibleHistorySessions =
        loadedHistoryScopeKey === historyScopeKey
            ? sessions
            : pendingHistoryCache?.sessions ?? EMPTY_AGENTS_SESSIONS;
    const scopedTerminalAgentSessions = useMemo(
        () =>
            terminalAgentSessions.filter(
                (session) =>
                    session.projectId === projectId &&
                    (session.worktreeId ?? null) === (worktreeId ?? null),
        ),
        [projectId, terminalAgentSessions, worktreeId],
    );
    const terminalAgentSessionByTerminalId = useMemo(
        () =>
            new Map(
                terminalAgentSessions.map((session) => [
                    session.terminalId,
                    session,
                ]),
            ),
        [terminalAgentSessions],
    );
    const visibleSessions = useMemo<readonly SidebarAgentSessionSummary[]>(
        () => [...scopedTerminalAgentSessions, ...visibleHistorySessions],
        [scopedTerminalAgentSessions, visibleHistorySessions],
    );
    const visibleError =
        loadedHistoryScopeKey === historyScopeKey ? error : null;
    const showBlockingLoading =
        !visibleError &&
        (isLoading ||
            (loadedHistoryScopeKey !== historyScopeKey && !pendingHistoryCache));

    const setSessionsAndCache = useCallback(
        (
            updater: (
                current: readonly AiHistorySessionSummary[],
            ) => readonly AiHistorySessionSummary[],
        ) => {
            setLoadedHistoryScopeKey(historyScopeKey);
            setSessions((current) => {
                const currentScopeSessions =
                    loadedHistoryScopeKey === historyScopeKey
                        ? current
                        : readSidebarAgentsHistoryCache(projectId, worktreeId)
                              ?.sessions ?? EMPTY_AGENTS_SESSIONS;
                const nextSessions = updater(currentScopeSessions);
                writeSidebarAgentsHistoryCache(
                    projectId,
                    worktreeId,
                    nextSessions,
                );
                return nextSessions;
            });
        },
        [historyScopeKey, loadedHistoryScopeKey, projectId, worktreeId],
    );

    const loadSessions = useCallback(async ({
        showBlockingLoading = true,
    }: {
        readonly showBlockingLoading?: boolean;
    } = {}) => {
        const api = getComandoApi();
        if (!api) {
            setIsLoading(false);
            return;
        }

        const requestId = requestIdRef.current + 1;
        requestIdRef.current = requestId;

        setIsLoading(showBlockingLoading);
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
            writeSidebarAgentsHistoryCache(projectId, worktreeId, nextSessions);
            setLoadedHistoryScopeKey(historyScopeKey);
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
    }, [historyScopeKey, projectId, worktreeId]);

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
            void loadSessions({ showBlockingLoading: false });
        }, SIDEBAR_AGENTS_REFRESH_DEBOUNCE_MS);
    }, [loadSessions]);

    useEffect(() => {
        const cached = readSidebarAgentsHistoryCache(projectId, worktreeId);

        setError(null);
        clearRefreshTimer();
        setSessions(cached?.sessions ?? []);
        setLoadedHistoryScopeKey(cached ? historyScopeKey : null);
        if (cached) {
            setIsLoading(false);
        }

        void loadSessions({ showBlockingLoading: !cached });

        return () => {
            requestIdRef.current += 1;
            clearRefreshTimer();
        };
    }, [clearRefreshTimer, historyScopeKey, loadSessions, projectId, worktreeId]);

    useEffect(() => {
        setCollapsedSessionIds(
            readSidebarAgentsCollapsedSessionIds(projectId, worktreeId),
        );
    }, [projectId, worktreeId]);

    useEffect(() => {
        return subscribeClaudeCodeSidebarSessions(() => {
            setTerminalAgentSessions(getClaudeCodeSidebarSessions());
        });
    }, []);

    useEffect(() => {
        reconcileClaudeCodeSidebarSessions(Object.values(tabsById));
    }, [tabsById]);

    useEffect(() => {
        const refreshableSessions = terminalAgentSessions.filter(
            (session) => session.cwd && session.transcriptSessionId,
        );
        if (refreshableSessions.length === 0) {
            return;
        }

        const refresh = () => {
            for (const session of getClaudeCodeSidebarSessions()) {
                if (!session.cwd || !session.transcriptSessionId) {
                    continue;
                }
                void refreshClaudeCodeSidebarSessionTranscript(session).catch(
                    () => undefined,
                );
            }
        };
        refresh();
        const intervalId = window.setInterval(refresh, 4_000);
        return () => {
            window.clearInterval(intervalId);
        };
    }, [terminalAgentSessions]);

    useEffect(() => {
        const api = getComandoApi();
        if (!api) {
            return;
        }

        const unsubscribe = api.onAiSessionSnapshot((update) => {
            let needsReload = false;

            setLoadedHistoryScopeKey(historyScopeKey);
            setSessions((current) => {
                const currentScopeSessions =
                    loadedHistoryScopeKey === historyScopeKey
                        ? current
                        : readSidebarAgentsHistoryCache(projectId, worktreeId)
                              ?.sessions ?? EMPTY_AGENTS_SESSIONS;
                const result = applySessionUpdateToSidebarHistory({
                    deletedSessionIds: deletedSessionIdsRef.current,
                    limit: SIDEBAR_AGENTS_HISTORY_LIMIT,
                    scope: {
                        projectId,
                        worktreeId: worktreeId ?? null,
                    },
                    sessions: currentScopeSessions,
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
                writeSidebarAgentsHistoryCache(
                    projectId,
                    worktreeId,
                    result.sessions,
                );
                return result.sessions;
            });

            if (needsReload) {
                scheduleReload();
            }
        });
        return () => {
            unsubscribe();
        };
    }, [
        historyScopeKey,
        loadedHistoryScopeKey,
        projectId,
        scheduleReload,
        worktreeId,
    ]);

    const handleOpenSession = useCallback(
        (session: SidebarAgentSessionSummary) => {
            if (isClaudeCodeSidebarSession(session)) {
                void focusClaudeCodeSidebarSession(session);
                return;
            }

            void openChatSessionTab({
                projectId: session.projectId,
                runtimeId: session.runtimeId as AiRuntimeId,
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

    const handleOpenNewAgentMenu = useCallback(
        (event: ReactMouseEvent<HTMLButtonElement>) => {
            event.preventDefault();
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            setNewAgentMenu({
                payload: undefined,
                x: rect.right,
                y: rect.bottom + 4,
            });
        },
        [],
    );

    const handleCreateNewAgentTab = useCallback(
        (runtimeId: ActiveAiRuntimeId) => {
            void createChatTab(projectId, worktreeId, runtimeId);
        },
        [createChatTab, projectId, worktreeId],
    );
    const handleOpenClaudeCodeTerminal = useCallback(() => {
        void launchClaudeCodeTerminal({
            projectId,
            worktreeId,
        });
    }, [projectId, worktreeId]);

    useEffect(() => {
        let cancelled = false;
        void checkClaudeCodeInstalled().then((available) => {
            if (!cancelled) {
                setClaudeCodeAvailable(available);
            }
        });

        return () => {
            cancelled = true;
        };
    }, []);

    const handleContextMenu = useCallback(
        (event: ReactMouseEvent, session: SidebarAgentSessionSummary) => {
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
        (session: SidebarAgentSessionSummary) => {
            if (!isClaudeCodeSidebarSession(session) && isSubagentSession(session)) {
                return;
            }

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

        const session = visibleSessions.find(
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

        if (isClaudeCodeSidebarSession(session)) {
            await renameClaudeCodeSidebarSession(session, trimmedTitle);
            return;
        }

        const previousTitle = session.title;
        setSessionsAndCache((current) =>
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
            setSessionsAndCache((current) =>
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
    }, [
        renameDraft,
        renamingSessionId,
        setSessionsAndCache,
        updateSessionTabTitles,
        visibleSessions,
    ]);

    const handleDelete = useCallback(
        async (session: SidebarAgentSessionSummary) => {
            if (isClaudeCodeSidebarSession(session)) {
                await closeClaudeCodeSidebarSession(session);
                return;
            }
            const historySession = session as AiHistorySessionSummary;

            const childCount = countAiHistorySessionChildren(
                historySession,
                visibleHistorySessions,
            );
            const confirmed = window.confirm(
                childCount > 0
                    ? `Delete "${historySession.title}" from threads? ${childCount} child agent${childCount === 1 ? "" : "s"} will stay in history as detached. This cannot be undone.`
                    : `Delete "${historySession.title}" from threads? This cannot be undone.`,
            );
            if (!confirmed) {
                return;
            }

            const api = getComandoApi();
            if (!api) {
                return;
            }

            const previousSessions = visibleHistorySessions;
            deletedSessionIdsRef.current.add(historySession.sessionId);
            setSessionsAndCache((current) =>
                current
                    .filter(
                        (candidate) =>
                            candidate.sessionId !== historySession.sessionId,
                    )
                    .map((candidate) =>
                        isAiHistorySessionChildOfParent(historySession, candidate)
                            ? { ...candidate, parentSessionId: null }
                            : candidate,
                    ),
            );

            try {
                const tabsById = useWorkspaceStore.getState().tabsById;
                const matchingTabIds = Object.values(tabsById)
                    .filter(
                        (candidate) =>
                            (candidate.kind === "chat" ||
                                candidate.kind === "review") &&
                            candidate.sessionId === historySession.sessionId,
                    )
                    .map((candidate) => candidate.id);

                await api.deleteAiSession(historySession.sessionId);

                for (const tabId of matchingTabIds) {
                    await closeTab(tabId);
                }
            } catch (err) {
                deletedSessionIdsRef.current.delete(historySession.sessionId);
                setSessionsAndCache(() => previousSessions);
                setError(
                    err instanceof Error
                        ? err.message
                        : "Could not delete this thread.",
                );
            }
        },
        [closeTab, setSessionsAndCache, visibleHistorySessions],
    );

    const handleTogglePinned = useCallback(
        async (session: SidebarAgentSessionSummary) => {
            if (isClaudeCodeSidebarSession(session)) {
                return;
            }
            const historySession = session as AiHistorySessionSummary;

            const api = getComandoApi();
            if (!api) {
                return;
            }

            const previousPinnedAt = historySession.pinnedAt ?? null;
            const nextPinned = previousPinnedAt === null;
            const optimisticPinnedAt = nextPinned
                ? new Date().toISOString()
                : null;

            setSessionsAndCache((current) =>
                current.map((candidate) =>
                    candidate.sessionId === session.sessionId
                        ? { ...candidate, pinnedAt: optimisticPinnedAt }
                        : candidate,
                ),
            );

            try {
                await api.setAiSessionPinned({
                    pinned: nextPinned,
                    sessionId: historySession.sessionId,
                });
            } catch (err) {
                setSessionsAndCache((current) =>
                    current.map((candidate) =>
                        candidate.sessionId === session.sessionId
                            ? { ...candidate, pinnedAt: previousPinnedAt }
                            : candidate,
                    ),
                );
                setError(
                    err instanceof Error
                        ? err.message
                        : nextPinned
                          ? "Could not pin this thread."
                          : "Could not unpin this thread.",
                );
            }
        },
        [setSessionsAndCache],
    );

    const newAgentMenuEntries = useMemo<readonly ContextMenuEntry[]>(
        () =>
            buildSidebarAgentsNewAgentMenuEntries({
                claudeCodeAvailable,
                onCreateNewAgentTab: handleCreateNewAgentTab,
                onOpenClaudeCodeTerminal: handleOpenClaudeCodeTerminal,
            }),
        [
            claudeCodeAvailable,
            handleCreateNewAgentTab,
            handleOpenClaudeCodeTerminal,
        ],
    );

    const contextMenuEntries = useMemo<readonly ContextMenuEntry[]>(() => {
        if (!contextMenu) {
            return [];
        }

        const session = visibleSessions.find(
            (candidate) =>
                candidate.sessionId === contextMenu.payload.sessionId,
        );
        if (!session) {
            return [];
        }

        const entries: ContextMenuEntry[] = [];

        if (!isClaudeCodeSidebarSession(session)) {
            entries.push({
                label: isSessionPinned(session)
                    ? "Unpin from Sidebar"
                    : "Pin to Sidebar",
                action: () => void handleTogglePinned(session),
            });
        }

        if (isClaudeCodeSidebarSession(session) || !isSubagentSession(session)) {
            entries.push({
                label: "Rename",
                action: () => startRename(session),
            });
        }

        entries.push(
            {
                label: isClaudeCodeSidebarSession(session)
                    ? "Close Terminal"
                    : "Delete",
                danger: true,
                action: () => void handleDelete(session),
            },
        );

        return entries;
    }, [
        contextMenu,
        handleDelete,
        handleTogglePinned,
        startRename,
        visibleSessions,
    ]);

    const openSessionIds = useMemo(() => {
        const ids = new Set<string>();
        for (const tab of Object.values(tabsById)) {
            if (tab.kind === "chat" || tab.kind === "review") {
                ids.add(tab.sessionId);
            } else if (tab.kind === "terminal") {
                const terminalSession = terminalAgentSessionByTerminalId.get(
                    tab.terminalId,
                );
                if (terminalSession) {
                    ids.add(terminalSession.sessionId);
                }
            }
        }
        return ids;
    }, [tabsById, terminalAgentSessionByTerminalId]);

    const aiSessions = useAiStore((state) => state.sessions);
    const workingOrderRef = useRef<Map<string, number>>(new Map());
    const workingCounterRef = useRef(0);
    const [workingOrderRevision, setWorkingOrderRevision] = useState(0);

    const hierarchyGroups = useMemo(
        () => {
            const workingOrder = workingOrderRef.current;
            return buildAiSessionHierarchyGroups(visibleSessions, {
                compareSiblings: (left, right) =>
                    compareSidebarHierarchySiblings(left, right, workingOrder),
                filterQuery: normalizedFilter,
            });
        },
        // workingOrderRevision keeps this memo in sync with the ref-backed map.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [normalizedFilter, visibleSessions, workingOrderRevision],
    );
    const filteredSessionCount = useMemo(
        () => countHierarchyGroupRows(hierarchyGroups),
        [hierarchyGroups],
    );
    const collapsibleSessionIds = useMemo(() => {
        const ids = new Set<string>();
        for (const group of hierarchyGroups) {
            for (const row of group.rows) {
                if (row.hasChildren) {
                    ids.add(row.session.sessionId);
                }
            }
        }
        return ids;
    }, [hierarchyGroups]);

    useEffect(() => {
        const map = workingOrderRef.current;
        let changed = false;

        for (const [sessionId, entry] of Object.entries(aiSessions)) {
            const working = isSessionWorking(entry);
            const tracked = map.has(sessionId);
            if (working && !tracked) {
                workingCounterRef.current += 1;
                map.set(sessionId, workingCounterRef.current);
                changed = true;
            } else if (!working && tracked) {
                map.delete(sessionId);
                changed = true;
            }
        }

        for (const trackedId of Array.from(map.keys())) {
            if (!(trackedId in aiSessions)) {
                map.delete(trackedId);
                changed = true;
            }
        }

        if (changed) {
            setWorkingOrderRevision((value) => value + 1);
        }
    }, [aiSessions]);

    useEffect(() => {
        if (hasQuery || loadedHistoryScopeKey !== historyScopeKey) {
            return;
        }

        setCollapsedSessionIds((current) => {
            const next = new Set(
                [...current].filter((sessionId) =>
                    collapsibleSessionIds.has(sessionId),
                ),
            );
            const unchanged =
                next.size === current.size &&
                [...next].every((sessionId) => current.has(sessionId));
            if (unchanged) {
                return current;
            }

            persistSidebarAgentsCollapsedSessionIds(
                projectId,
                worktreeId,
                next,
            );
            return next;
        });
    }, [
        collapsibleSessionIds,
        hasQuery,
        historyScopeKey,
        loadedHistoryScopeKey,
        projectId,
        worktreeId,
    ]);

    const pinnedGroups = useMemo(
        () =>
            hierarchyGroups
                .filter((group) =>
                    group.rows.some((row) => isSessionPinned(row.session)),
                )
                .sort(comparePinnedHierarchyGroups),
        [hierarchyGroups],
    );
    const unpinnedGroups = useMemo(
        () =>
            hierarchyGroups.filter(
                (group) =>
                    !group.rows.some((row) => isSessionPinned(row.session)),
            ),
        [hierarchyGroups],
    );
    const openGroups = useMemo(() => {
        const list = unpinnedGroups.filter((group) =>
            group.rows.some((row) => openSessionIds.has(row.session.sessionId)),
        );
        const workingOrder = workingOrderRef.current;
        return [...list].sort((a, b) => {
            const aOrder = getHierarchyGroupWorkingOrder(a, workingOrder);
            const bOrder = getHierarchyGroupWorkingOrder(b, workingOrder);
            const aWorking = aOrder !== undefined;
            const bWorking = bOrder !== undefined;
            if (aWorking && bWorking) {
                // Freeze working sessions in the order they entered the working state.
                return aOrder - bOrder;
            }
            if (aWorking !== bWorking) {
                return aWorking ? -1 : 1;
            }
            return 0;
        });
        // workingOrderRevision keeps this memo in sync with the ref-backed map.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [openSessionIds, unpinnedGroups, workingOrderRevision]);
    const otherGroups = useMemo(
        () =>
            unpinnedGroups.filter(
                (group) =>
                    !group.rows.some((row) =>
                        openSessionIds.has(row.session.sessionId),
                    ),
            ),
        [openSessionIds, unpinnedGroups],
    );
    const showUnpinnedSectionHeaders =
        pinnedGroups.length > 0 ||
        (openGroups.length > 0 && otherGroups.length > 0);
    const handleToggleCollapsed = useCallback(
        (sessionId: string) => {
            setCollapsedSessionIds((current) => {
                const next = new Set(current);
                if (next.has(sessionId)) {
                    next.delete(sessionId);
                } else {
                    next.add(sessionId);
                }
                persistSidebarAgentsCollapsedSessionIds(
                    projectId,
                    worktreeId,
                    next,
                );
                return next;
            });
        },
        [projectId, worktreeId],
    );

    const statusLine = showBlockingLoading
        ? "Loading..."
        : visibleError
          ? visibleError
          : hasQuery
            ? `${filteredSessionCount} of ${visibleSessions.length}`
            : formatSessionCount(visibleSessions.length);

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="sidebar-agents-summary flex shrink-0 items-center gap-1 px-2.5 py-2">
                <span
                    className={[
                        "min-w-0 flex-1 truncate text-[12px] font-medium",
                        visibleError
                            ? "text-[var(--diff-remove)]"
                            : "text-text-secondary",
                    ].join(" ")}
                >
                    {statusLine}
                </span>
                <button
                    aria-haspopup="menu"
                    aria-label="New agent thread"
                    className="sidebar-toolbar-action sidebar-toolbar-action--icon"
                    onClick={handleOpenNewAgentMenu}
                    title="New agent thread"
                    type="button"
                >
                    <PlusIcon />
                </button>
                <button
                    className="sidebar-toolbar-action"
                    onClick={handleOpenHistoryTab}
                    title="Open full history"
                    type="button"
                >
                    History
                </button>
            </div>

            <div className="shell-scrollbar min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1 pb-2">
                {!showBlockingLoading &&
                !visibleError &&
                visibleSessions.length === 0 ? (
                    <SidebarAgentsPlaceholder
                        body={
                            projectId
                                ? "No threads yet for this scope."
                                : "Open a project to see its threads."
                        }
                    />
                ) : null}

                {!showBlockingLoading &&
                !visibleError &&
                visibleSessions.length > 0 &&
                filteredSessionCount === 0 ? (
                    <SidebarAgentsPlaceholder
                        body={`No threads match "${(filter ?? "").trim()}".`}
                    />
                ) : null}

                {pinnedGroups.length > 0 ? (
                    <SidebarAgentsSection
                        cancelRename={cancelRename}
                        commitRename={() => void commitRename()}
                        onContextMenu={handleContextMenu}
                        onOpen={handleOpenSession}
                        onRenameDraftChange={setRenameDraft}
                        onToggleCollapsed={handleToggleCollapsed}
                        onTogglePinned={handleTogglePinned}
                        activeSessionId={activePaneSessionId}
                        collapsedSessionIds={collapsedSessionIds}
                        collapseEnabled={!hasQuery}
                        renameDraft={renameDraft}
                        renamingSessionId={renamingSessionId}
                        groups={pinnedGroups}
                        title="Pinned"
                    />
                ) : null}

                {openGroups.length > 0 ? (
                    <SidebarAgentsSection
                        cancelRename={cancelRename}
                        commitRename={() => void commitRename()}
                        onContextMenu={handleContextMenu}
                        onOpen={handleOpenSession}
                        onRenameDraftChange={setRenameDraft}
                        onToggleCollapsed={handleToggleCollapsed}
                        onTogglePinned={handleTogglePinned}
                        activeSessionId={activePaneSessionId}
                        collapsedSessionIds={collapsedSessionIds}
                        collapseEnabled={!hasQuery}
                        renameDraft={renameDraft}
                        renamingSessionId={renamingSessionId}
                        groups={openGroups}
                        title={showUnpinnedSectionHeaders ? "Open" : null}
                    />
                ) : null}

                {otherGroups.length > 0 ? (
                    <SidebarAgentsSection
                        cancelRename={cancelRename}
                        commitRename={() => void commitRename()}
                        onContextMenu={handleContextMenu}
                        onOpen={handleOpenSession}
                        onRenameDraftChange={setRenameDraft}
                        onToggleCollapsed={handleToggleCollapsed}
                        onTogglePinned={handleTogglePinned}
                        activeSessionId={activePaneSessionId}
                        collapsedSessionIds={collapsedSessionIds}
                        collapseEnabled={!hasQuery}
                        renameDraft={renameDraft}
                        renamingSessionId={renamingSessionId}
                        groups={otherGroups}
                        title={showUnpinnedSectionHeaders ? "All" : null}
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

            {newAgentMenu ? (
                <ContextMenu
                    entries={newAgentMenuEntries}
                    menu={newAgentMenu}
                    minWidth={180}
                    onClose={() => setNewAgentMenu(null)}
                />
            ) : null}
        </div>
    );
}

export function buildSidebarAgentsNewAgentMenuEntries({
    claudeCodeAvailable,
    onCreateNewAgentTab,
    onOpenClaudeCodeTerminal,
}: {
    readonly claudeCodeAvailable: boolean | null;
    readonly onCreateNewAgentTab: (runtimeId: ActiveAiRuntimeId) => void;
    readonly onOpenClaudeCodeTerminal: () => void;
}): readonly ContextMenuEntry[] {
    return [
        ...SIDEBAR_AGENTS_NEW_RUNTIMES.map((runtimeId) => ({
            action: () => onCreateNewAgentTab(runtimeId),
            label: `New ${getHistoryRuntimeLabel(runtimeId)} thread`,
        })),
        {
            action: onOpenClaudeCodeTerminal,
            label: "New Claude Code Terminal",
            title:
                claudeCodeAvailable === false
                    ? CLAUDE_CODE_NOT_FOUND_MESSAGE
                    : CLAUDE_CODE_TERMINAL_DESCRIPTION,
        },
    ];
}

function SidebarAgentsSection({
    activeSessionId,
    cancelRename,
    collapsedSessionIds,
    collapseEnabled,
    commitRename,
    groups,
    onContextMenu,
    onOpen,
    onRenameDraftChange,
    onToggleCollapsed,
    onTogglePinned,
    renameDraft,
    renamingSessionId,
    title,
}: {
    readonly activeSessionId: string | null;
    readonly cancelRename: () => void;
    readonly collapsedSessionIds: ReadonlySet<string>;
    readonly collapseEnabled: boolean;
    readonly commitRename: () => void;
    readonly groups: readonly AiSessionHierarchyGroup<SidebarAgentSessionSummary>[];
    readonly onContextMenu: (
        event: ReactMouseEvent,
        session: SidebarAgentSessionSummary,
    ) => void;
    readonly onOpen: (session: SidebarAgentSessionSummary) => void;
    readonly onRenameDraftChange: (value: string) => void;
    readonly onToggleCollapsed: (sessionId: string) => void;
    readonly onTogglePinned: (
        session: SidebarAgentSessionSummary,
    ) => Promise<void> | void;
    readonly renameDraft: string;
    readonly renamingSessionId: string | null;
    readonly title: string | null;
}) {
    const sessionCount = countHierarchyGroupRows(groups);

    return (
        <section className="sidebar-agents-section mt-3 first:mt-0">
            {title ? (
                <header className="sidebar-agents-section-header flex items-center gap-2 px-2 pb-1 pt-1 font-semibold uppercase tracking-[0.09em] text-text-secondary/80">
                    <span>{title}</span>
                    <span className="sidebar-agents-section-count font-normal text-text-secondary/60">
                        {sessionCount}
                    </span>
                </header>
            ) : null}
            <ul className="flex flex-col gap-0.5">
                {groups.flatMap((group) => {
                    const rows = getVisibleSidebarHierarchyRows(
                        group,
                        collapseEnabled ? collapsedSessionIds : EMPTY_COLLAPSED_IDS,
                    );
                    return rows.map((row) => (
                        <li
                            className={
                                row.depth > 0
                                    ? "sidebar-agents-subitem"
                                    : undefined
                            }
                            key={row.session.sessionId}
                            style={
                                row.depth > 0
                                    ? ({
                                          ["--sidebar-agents-depth"]:
                                              row.depth,
                                      } as CSSProperties)
                                    : undefined
                            }
                        >
                            <SidebarAgentsItem
                                depth={row.depth}
                                hasChildren={row.hasChildren}
                                isActive={
                                    activeSessionId === row.session.sessionId
                                }
                                isCollapsed={
                                    collapseEnabled &&
                                    collapsedSessionIds.has(row.session.sessionId)
                                }
                                isRenaming={
                                    renamingSessionId ===
                                    row.session.sessionId
                                }
                                isSubagent={row.isSubagent}
                                onCancelRename={cancelRename}
                                onCommitRename={commitRename}
                                onContextMenu={onContextMenu}
                                onOpen={onOpen}
                                onRenameDraftChange={onRenameDraftChange}
                                onToggleCollapsed={onToggleCollapsed}
                                onTogglePinned={onTogglePinned}
                                renameDraft={renameDraft}
                                session={row.session}
                            />
                        </li>
                    ));
                })}
            </ul>
        </section>
    );
}

function SidebarAgentsItem({
    depth,
    hasChildren,
    isActive,
    isCollapsed,
    isRenaming,
    isSubagent,
    onCancelRename,
    onCommitRename,
    onContextMenu,
    onOpen,
    onRenameDraftChange,
    onToggleCollapsed,
    onTogglePinned,
    renameDraft,
    session,
}: {
    readonly depth: number;
    readonly hasChildren: boolean;
    readonly isActive: boolean;
    readonly isCollapsed: boolean;
    readonly isRenaming: boolean;
    readonly isSubagent: boolean;
    readonly onCancelRename: () => void;
    readonly onCommitRename: () => void;
    readonly onContextMenu: (
        event: ReactMouseEvent,
        session: SidebarAgentSessionSummary,
    ) => void;
    readonly onOpen: (session: SidebarAgentSessionSummary) => void;
    readonly onRenameDraftChange: (value: string) => void;
    readonly onToggleCollapsed: (sessionId: string) => void;
    readonly onTogglePinned: (
        session: SidebarAgentSessionSummary,
    ) => Promise<void> | void;
    readonly renameDraft: string;
    readonly session: SidebarAgentSessionSummary;
}) {
    const dragStateRef = useRef<{
        readonly pointerId: number;
        readonly startX: number;
        readonly startY: number;
        active: boolean;
    } | null>(null);
    const suppressClickRef = useRef(false);
    const [dragPreview, setDragPreview] =
        useState<SidebarAgentDragPreview | null>(null);
    const [isPointerTracking, setIsPointerTracking] = useState(false);
    const preview = getHistoryPreviewText(session);
    const title = truncateChatTitle(session.title, SIDEBAR_AGENTS_TITLE_MAX_CHARS);
    const isPinned = isSessionPinned(session);
    const isTerminalAgent = isClaudeCodeSidebarSession(session);
    const activity = useAgentActivityIndicator(session.sessionId);
    const timestampLabel = activity
        ? activity.tone === "danger"
            ? "Error"
            : "Working…"
        : formatHistoryRelativeDateCompact(session.updatedAt);
    const timestampClassName = activity
        ? activity.tone === "danger"
            ? "text-rose-500"
            : "text-(--diff-warn)"
        : "text-text-secondary";
    const indentStyle =
        depth > 0
            ? { paddingLeft: `${8 + Math.min(depth, 4) * 14}px` }
            : undefined;

    const emitDrag = useCallback(
        (
            phase: "cancel" | "end" | "move" | "start",
            event?: Pick<ReactPointerEvent<HTMLElement>, "clientX" | "clientY">,
        ) => {
            emitSidebarAgentDrag({
                phase,
                projectId: session.projectId,
                runtimeId: session.runtimeId as AiRuntimeId,
                sessionId: session.sessionId,
                title: session.title,
                worktreeId: session.worktreeId ?? null,
                x: event?.clientX ?? 0,
                y: event?.clientY ?? 0,
            });
        },
        [session],
    );

    const updateDragPreview = useCallback(
        (event: Pick<ReactPointerEvent<HTMLElement>, "clientX" | "clientY">) => {
            setDragPreview({
                activity,
                runtimeLabel: getSidebarAgentRuntimeLabel(session),
                title: session.title,
                x: event.clientX,
                y: event.clientY,
            });
        },
        [activity, session],
    );

    const clearDragState = useCallback(
        ({
            emitCancel,
            event,
            pointerId,
            releaseTarget,
        }: {
            readonly emitCancel: boolean;
            readonly event?: Pick<
                ReactPointerEvent<HTMLElement>,
                "clientX" | "clientY"
            >;
            readonly pointerId?: number;
            readonly releaseTarget?: EventTarget | null;
        }) => {
            const dragState = dragStateRef.current;
            if (!dragState) {
                return;
            }

            dragStateRef.current = null;
            setIsPointerTracking(false);
            setDragPreview(null);

            if (
                releaseTarget instanceof HTMLElement &&
                pointerId !== undefined
            ) {
                releaseTarget.releasePointerCapture?.(pointerId);
            }

            if (emitCancel && shouldEmitSidebarDragCancel(dragState.active)) {
                emitDrag("cancel", event);
            }
        },
        [emitDrag],
    );

    useEffect(() => {
        if (!isPointerTracking) {
            return;
        }

        const handleWindowBlur = () => {
            clearDragState({ emitCancel: true });
        };
        const handleVisibilityChange = () => {
            if (document.visibilityState !== "hidden") {
                return;
            }

            clearDragState({ emitCancel: true });
        };

        window.addEventListener("blur", handleWindowBlur);
        document.addEventListener("visibilitychange", handleVisibilityChange);

        return () => {
            window.removeEventListener("blur", handleWindowBlur);
            document.removeEventListener(
                "visibilitychange",
                handleVisibilityChange,
            );
            clearDragState({ emitCancel: true });
        };
    }, [clearDragState, isPointerTracking]);

    return (
        <>
            <div
            className="sidebar-agents-row app-no-drag w-full"
            aria-current={isActive ? "true" : undefined}
            data-active={isActive ? "true" : "false"}
            data-subagent={isSubagent ? "true" : "false"}
            onClick={() => {
                if (suppressClickRef.current) return;
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
            onPointerCancel={(event) => {
                const dragState = dragStateRef.current;
                if (!dragState || dragState.pointerId !== event.pointerId) {
                    return;
                }

                clearDragState({
                    emitCancel: true,
                    event,
                    pointerId: event.pointerId,
                    releaseTarget: event.currentTarget,
                });
            }}
            onLostPointerCapture={(event) => {
                const dragState = dragStateRef.current;
                if (!dragState || dragState.pointerId !== event.pointerId) {
                    return;
                }

                clearDragState({
                    emitCancel: true,
                    event,
                });
            }}
            onPointerDown={(event) => {
                if (
                    isRenaming ||
                    isTerminalAgent ||
                    event.button !== 0 ||
                    isInteractiveSidebarAgentDragTarget(
                        event.target,
                        event.currentTarget,
                    )
                ) {
                    return;
                }

                dragStateRef.current = {
                    active: false,
                    pointerId: event.pointerId,
                    startX: event.clientX,
                    startY: event.clientY,
                };
                setIsPointerTracking(true);
                event.currentTarget.setPointerCapture?.(event.pointerId);
            }}
            onPointerMove={(event) => {
                const dragState = dragStateRef.current;
                if (!dragState || dragState.pointerId !== event.pointerId) {
                    return;
                }
                if (shouldCancelSidebarDragOnMove(event.buttons)) {
                    clearDragState({
                        emitCancel: true,
                        event,
                        pointerId: event.pointerId,
                        releaseTarget: event.currentTarget,
                    });
                    return;
                }

                if (!dragState.active) {
                    const deltaX = event.clientX - dragState.startX;
                    const deltaY = event.clientY - dragState.startY;
                    if (
                        Math.hypot(deltaX, deltaY) <
                        SIDEBAR_AGENT_DRAG_THRESHOLD_PX
                    ) {
                        return;
                    }

                    dragState.active = true;
                    updateDragPreview(event);
                    emitDrag("start", event);
                } else {
                    updateDragPreview(event);
                    emitDrag("move", event);
                }

                event.preventDefault();
            }}
            onPointerUp={(event) => {
                const dragState = dragStateRef.current;
                if (!dragState || dragState.pointerId !== event.pointerId) {
                    return;
                }

                dragStateRef.current = null;
                setIsPointerTracking(false);
                event.currentTarget.releasePointerCapture?.(event.pointerId);
                if (!dragState.active) {
                    setDragPreview(null);
                    return;
                }

                event.preventDefault();
                event.stopPropagation();
                setDragPreview(null);
                suppressClickRef.current = true;
                window.requestAnimationFrame(() => {
                    suppressClickRef.current = false;
                });
                emitDrag("end", event);
            }}
            role="button"
            style={indentStyle}
            tabIndex={isRenaming ? -1 : 0}
            title={session.title}
        >
            <div className="sidebar-agents-main-line flex w-full min-w-0 items-center gap-2">
                {hasChildren ? (
                    <button
                        aria-expanded={!isCollapsed}
                        aria-label={
                            isCollapsed
                                ? "Expand subagents"
                                : "Collapse subagents"
                        }
                        className="sidebar-agents-collapse-button -ml-1 flex h-4 w-4 shrink-0 items-center justify-center rounded text-text-secondary transition-colors hover:bg-bg-elevated hover:text-text-primary"
                        onClick={(event) => {
                            event.stopPropagation();
                            onToggleCollapsed(session.sessionId);
                        }}
                        onKeyDown={(event) => {
                            event.stopPropagation();
                        }}
                        title={
                            isCollapsed
                                ? "Expand subagents"
                                : "Collapse subagents"
                        }
                        type="button"
                    >
                        <ChevronIcon collapsed={isCollapsed} />
                    </button>
                ) : null}
                <SidebarAgentActivityDot indicator={activity} />
                {isRenaming ? (
                    <input
                        autoFocus
                        className="sidebar-agents-rename min-w-0 flex-1 rounded border border-border-strong bg-bg-primary px-1 py-0.5 text-[11.5px] font-medium text-text-primary outline-none focus:border-accent"
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
                    <span className="sidebar-agents-title min-w-0 flex-1 truncate text-[11.5px] font-medium text-text-primary">
                        {title}
                    </span>
                )}
                {isRenaming || isTerminalAgent ? null : (
                    <button
                        aria-label={
                            isPinned
                                ? "Unpin thread from sidebar"
                                : "Pin thread to sidebar"
                        }
                        aria-pressed={isPinned}
                        className="sidebar-agents-pin-button flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-secondary transition-colors hover:text-text-primary"
                        data-pinned={isPinned ? "true" : "false"}
                        onClick={(event) => {
                            event.stopPropagation();
                            void onTogglePinned(session);
                        }}
                        onKeyDown={(event) => {
                            event.stopPropagation();
                        }}
                        title={
                            isPinned
                                ? "Unpin from sidebar"
                                : "Pin to sidebar"
                        }
                        type="button"
                    >
                        <PinIcon active={isPinned} />
                    </button>
                )}
                {isRenaming ? null : (
                    <span
                        className={`sidebar-agents-timestamp shrink-0 text-[10px] ${timestampClassName}`}
                        title={activity?.title}
                    >
                        {timestampLabel}
                    </span>
                )}
            </div>
            <p className="sidebar-agents-preview line-clamp-1 w-full text-left text-[10.5px] leading-[1.35] text-text-secondary">
                {preview}
            </p>
            <div className="sidebar-agents-meta flex w-full min-w-0 items-center gap-1.5 text-[10px] text-text-secondary">
                {isSubagent ? (
                    <>
                        <span
                            className="shrink-0 rounded-[3px] px-1 text-[9px] font-medium"
                            style={{
                                color: "var(--color-accent)",
                                background:
                                    "color-mix(in srgb, var(--color-accent) 14%, transparent)",
                            }}
                        >
                            Agent
                        </span>
                        <span aria-hidden="true" className="shrink-0">
                            ·
                        </span>
                    </>
                ) : null}
                <span className="shrink-0">
                    {getSidebarAgentRuntimeLabel(session)}
                </span>
                <span aria-hidden="true" className="shrink-0">
                    ·
                </span>
                <span className="shrink-0">
                    {isTerminalAgent
                        ? "Terminal"
                        : formatHistoryMessageCount(session.messageCount)}
                </span>
            </div>
            </div>
            {dragPreview && typeof document !== "undefined"
                ? createPortal(
                      <SidebarAgentDragGhost preview={dragPreview} />,
                      document.body,
                  )
                : null}
        </>
    );
}

function SidebarAgentDragGhost({
    preview,
}: {
    readonly preview: SidebarAgentDragPreview;
}) {
    const toneClassName =
        preview.activity?.tone === "danger"
            ? "text-rose-500"
            : preview.activity?.tone === "working"
              ? "text-(--diff-warn)"
              : "text-accent";

    return (
        <div
            aria-hidden="true"
            className="pointer-events-none fixed min-w-40 max-w-72 rounded-lg border border-accent/30 bg-bg-panel/96 px-2.5 py-2 text-text-primary shadow-[0_14px_34px_rgba(15,23,42,0.28)] backdrop-blur-sm"
            style={{
                left: preview.x + 14,
                top: preview.y + 14,
                transform: "translate3d(0, 0, 0) scale(1.02)",
                zIndex: 10050,
            }}
        >
            <div className="flex min-w-0 items-center gap-2">
                <span
                    aria-hidden="true"
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-accent/10 text-[10px] font-semibold ${toneClassName}`}
                >
                    AI
                </span>
                <div className="min-w-0 flex-1">
                    <div className="truncate text-[11.5px] font-medium leading-tight">
                        {preview.title}
                    </div>
                    <div className="mt-0.5 flex min-w-0 items-center gap-1 text-[10px] leading-tight text-text-secondary">
                        {preview.activity ? (
                            <span
                                aria-hidden="true"
                                className={`text-[8px] leading-none ${toneClassName}`}
                            >
                                ●
                            </span>
                        ) : null}
                        <span className="truncate">
                            Drag to open in pane · {preview.runtimeLabel}
                        </span>
                    </div>
                </div>
            </div>
        </div>
    );
}

function isInteractiveSidebarAgentDragTarget(
    target: EventTarget | null,
    currentTarget: HTMLElement,
): boolean {
    if (!(target instanceof Element)) {
        return false;
    }

    const interactive = target.closest(
        "button,input,textarea,select,a,[role='button']",
    );
    return Boolean(interactive && interactive !== currentTarget);
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
                "sidebar-agents-activity-dot shrink-0 text-[9px] leading-none",
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

function PlusIcon() {
    return (
        <svg
            aria-hidden="true"
            fill="none"
            height="14"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            viewBox="0 0 24 24"
            width="14"
        >
            <path d="M12 5v14" />
            <path d="M5 12h14" />
        </svg>
    );
}

function ChevronIcon({ collapsed }: { readonly collapsed: boolean }) {
    return (
        <svg
            aria-hidden="true"
            fill="none"
            height="11"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.8"
            viewBox="0 0 24 24"
            width="11"
        >
            {collapsed ? <path d="m9 6 6 6-6 6" /> : <path d="m6 9 6 6 6-6" />}
        </svg>
    );
}

function PinIcon({ active }: { readonly active: boolean }) {
    return (
        <svg
            aria-hidden="true"
            className="sidebar-agents-pin-icon"
            fill={active ? "currentColor" : "none"}
            height="11"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.7"
            viewBox="0 0 24 24"
            width="11"
        >
            <path d="M9 3h6l-1 6 4 4v2H6v-2l4-4-1-6Z" />
            <path d="M12 15v6" />
        </svg>
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
        parentSessionId: entry.snapshot?.parentSessionId ?? null,
        pinnedAt: null,
        projectId: entry.snapshot?.projectId ?? entry.meta?.projectId ?? null,
        title,
        updatedAt: entry.snapshot?.updatedAt ?? null,
        worktreeId: entry.snapshot?.worktreeId ?? entry.meta?.worktreeId ?? null,
    };
}

function isSessionPinned(session: SidebarAgentSessionSummary): boolean {
    return (session.pinnedAt ?? null) !== null;
}

function getSidebarAgentRuntimeLabel(session: SidebarAgentSessionSummary): string {
    return session.runtimeId === CLAUDE_CODE_TERMINAL_RUNTIME_ID
        ? "Claude Code"
        : getHistoryRuntimeLabel(session.runtimeId);
}

function isSubagentSession(session: SidebarAgentSessionSummary): boolean {
    const parentSessionId = (session.parentSessionId ?? "").trim();
    return parentSessionId.length > 0 && parentSessionId !== session.sessionId;
}

function countHierarchyGroupRows(
    groups: readonly AiSessionHierarchyGroup<SidebarAgentSessionSummary>[],
): number {
    return groups.reduce((count, group) => count + group.rows.length, 0);
}

function getVisibleSidebarHierarchyRows(
    group: AiSessionHierarchyGroup<SidebarAgentSessionSummary>,
    collapsedSessionIds: ReadonlySet<string>,
): readonly AiSessionHierarchyRow<SidebarAgentSessionSummary>[] {
    return filterAiSessionHierarchyRowsForCollapsedParents(
        group.rows,
        collapsedSessionIds,
    );
}

function comparePinnedHierarchyGroups(
    left: AiSessionHierarchyGroup<SidebarAgentSessionSummary>,
    right: AiSessionHierarchyGroup<SidebarAgentSessionSummary>,
): number {
    const pinnedComparison = getLatestPinnedAt(right).localeCompare(
        getLatestPinnedAt(left),
    );
    if (pinnedComparison !== 0) {
        return pinnedComparison;
    }

    return getLatestUpdatedAt(right).localeCompare(getLatestUpdatedAt(left));
}

function getLatestPinnedAt(
    group: AiSessionHierarchyGroup<SidebarAgentSessionSummary>,
): string {
    return group.rows.reduce(
        (latest, row) =>
            (row.session.pinnedAt ?? "").localeCompare(latest) > 0
                ? (row.session.pinnedAt ?? "")
                : latest,
        "",
    );
}

function getLatestUpdatedAt(
    group: AiSessionHierarchyGroup<SidebarAgentSessionSummary>,
): string {
    return group.rows.reduce(
        (latest, row) =>
            row.session.updatedAt.localeCompare(latest) > 0
                ? row.session.updatedAt
                : latest,
        "",
    );
}

function compareSidebarHierarchySiblings(
    left: SidebarAgentSessionSummary,
    right: SidebarAgentSessionSummary,
    workingOrder: ReadonlyMap<string, number>,
): number {
    const leftOrder = workingOrder.get(left.sessionId);
    const rightOrder = workingOrder.get(right.sessionId);
    const leftWorking = leftOrder !== undefined;
    const rightWorking = rightOrder !== undefined;

    if (leftWorking && rightWorking) {
        return leftOrder - rightOrder;
    }
    if (leftWorking !== rightWorking) {
        return leftWorking ? -1 : 1;
    }

    return 0;
}

function getHierarchyGroupWorkingOrder(
    group: AiSessionHierarchyGroup<SidebarAgentSessionSummary>,
    workingOrder: ReadonlyMap<string, number>,
): number | undefined {
    let order: number | undefined;
    for (const row of group.rows) {
        const candidateOrder = workingOrder.get(row.session.sessionId);
        if (candidateOrder === undefined) {
            continue;
        }
        order =
            order === undefined
                ? candidateOrder
                : Math.min(order, candidateOrder);
    }
    return order;
}

function formatSessionCount(count: number): string {
    return count === 1 ? "1 thread" : `${count} threads`;
}

function getComandoApi(): ComandoApi | null {
    return typeof window !== "undefined" ? (window.comando ?? null) : null;
}
