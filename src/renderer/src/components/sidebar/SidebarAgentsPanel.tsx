import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type MouseEvent as ReactMouseEvent,
} from "react";

import type {
    AiHistorySessionSummary,
    AiRuntimeId,
    ComandoApi,
} from "@shared/ipc";
import { truncateChatTitle } from "@shared/chatTitle";

import { useAiStore } from "@renderer/app/store/ai-store";
import { useWorkspaceStore } from "@renderer/app/store/workspace-store";
import { collectPaneNodes } from "@renderer/app/workspace/tree";

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
    buildAiSessionHierarchyGroups,
    filterAiSessionHierarchyRowsForCollapsedParents,
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
    getSidebarAgentsCollapseStorageKey,
    persistSidebarAgentsCollapsedSessionIds,
    readSidebarAgentsCollapsedSessionIds,
} from "./sidebarAgentsCollapseState";

interface SidebarAgentsContextMenuPayload {
    readonly sessionId: string;
}

const SIDEBAR_AGENTS_TITLE_MAX_CHARS = 48;
const SIDEBAR_AGENTS_REFRESH_DEBOUNCE_MS = 800;
const EMPTY_COLLAPSED_IDS: ReadonlySet<string> = new Set();

const SIDEBAR_AGENTS_NEW_RUNTIMES: readonly AiRuntimeId[] = [
    "codex",
    "claude",
    "gemini",
    "kilo",
];

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

        return activeTab?.kind === "chat" || activeTab?.kind === "review"
            ? activeTab.sessionId
            : null;
    });

    const [sessions, setSessions] = useState<readonly AiHistorySessionSummary[]>(
        [],
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
    const [collapsedSessionIds, setCollapsedSessionIds] = useState<
        ReadonlySet<string>
    >(() => readSidebarAgentsCollapsedSessionIds(projectId, worktreeId));
    const [loadedHistoryScopeKey, setLoadedHistoryScopeKey] = useState<
        string | null
    >(null);
    const requestIdRef = useRef(0);
    const refreshTimerRef = useRef<number | null>(null);
    const normalizedFilter = (filter ?? "").trim().toLowerCase();
    const hasQuery = normalizedFilter.length > 0;
    const collapseStorageKey = useMemo(
        () => getSidebarAgentsCollapseStorageKey(projectId, worktreeId),
        [projectId, worktreeId],
    );

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
            setLoadedHistoryScopeKey(collapseStorageKey);
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
    }, [collapseStorageKey, projectId, worktreeId]);

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
        setLoadedHistoryScopeKey(null);
        clearRefreshTimer();
        void loadSessions();
    }, [clearRefreshTimer, loadSessions]);

    useEffect(() => clearRefreshTimer, [clearRefreshTimer]);

    useEffect(() => {
        setCollapsedSessionIds(
            readSidebarAgentsCollapsedSessionIds(projectId, worktreeId),
        );
    }, [projectId, worktreeId]);

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
        (runtimeId: AiRuntimeId) => {
            void createChatTab(projectId, worktreeId, runtimeId);
        },
        [createChatTab, projectId, worktreeId],
    );

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
            if (isSubagentSession(session)) {
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
            const childCount = sessions.filter(
                (candidate) => candidate.parentSessionId === session.sessionId,
            ).length;
            const confirmed = window.confirm(
                childCount > 0
                    ? `Delete "${session.title}" from threads? ${childCount} child agent${childCount === 1 ? "" : "s"} will stay in history as detached. This cannot be undone.`
                    : `Delete "${session.title}" from threads? This cannot be undone.`,
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
                current
                    .filter(
                        (candidate) =>
                            candidate.sessionId !== session.sessionId,
                    )
                    .map((candidate) =>
                        candidate.parentSessionId === session.sessionId
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

    const handleTogglePinned = useCallback(
        async (session: AiHistorySessionSummary) => {
            const api = getComandoApi();
            if (!api) {
                return;
            }

            const previousPinnedAt = session.pinnedAt ?? null;
            const nextPinned = previousPinnedAt === null;
            const optimisticPinnedAt = nextPinned
                ? new Date().toISOString()
                : null;

            setSessions((current) =>
                current.map((candidate) =>
                    candidate.sessionId === session.sessionId
                        ? { ...candidate, pinnedAt: optimisticPinnedAt }
                        : candidate,
                ),
            );

            try {
                await api.setAiSessionPinned({
                    pinned: nextPinned,
                    sessionId: session.sessionId,
                });
            } catch (err) {
                setSessions((current) =>
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
        [],
    );

    const newAgentMenuEntries = useMemo<readonly ContextMenuEntry[]>(
        () =>
            SIDEBAR_AGENTS_NEW_RUNTIMES.map((runtimeId) => ({
                action: () => handleCreateNewAgentTab(runtimeId),
                label: `New ${getHistoryRuntimeLabel(runtimeId)} thread`,
            })),
        [handleCreateNewAgentTab],
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

        const entries: ContextMenuEntry[] = [
            {
                label: isSessionPinned(session)
                    ? "Unpin from Sidebar"
                    : "Pin to Sidebar",
                action: () => void handleTogglePinned(session),
            },
        ];

        if (!isSubagentSession(session)) {
            entries.push({
                label: "Rename",
                action: () => startRename(session),
            });
        }

        entries.push(
            {
                label: "Delete",
                danger: true,
                action: () => void handleDelete(session),
            },
        );

        return entries;
    }, [contextMenu, handleDelete, handleTogglePinned, sessions, startRename]);

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
    const workingOrderRef = useRef<Map<string, number>>(new Map());
    const workingCounterRef = useRef(0);
    const [workingOrderRevision, setWorkingOrderRevision] = useState(0);

    const hierarchyGroups = useMemo(
        () => {
            const workingOrder = workingOrderRef.current;
            return buildAiSessionHierarchyGroups(sessions, {
                compareSiblings: (left, right) =>
                    compareSidebarHierarchySiblings(left, right, workingOrder),
                filterQuery: normalizedFilter,
            });
        },
        // workingOrderRevision keeps this memo in sync with the ref-backed map.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [normalizedFilter, sessions, workingOrderRevision],
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
        if (hasQuery || loadedHistoryScopeKey !== collapseStorageKey) {
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
        collapseStorageKey,
        collapsibleSessionIds,
        hasQuery,
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

    const statusLine = isLoading
        ? "Loading..."
        : error
          ? error
          : hasQuery
            ? `${filteredSessionCount} of ${sessions.length}`
            : formatSessionCount(sessions.length);

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="sidebar-agents-summary flex shrink-0 items-center gap-1 px-2 py-1.5">
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
                    aria-haspopup="menu"
                    aria-label="New agent thread"
                    className="sidebar-agents-summary-action flex h-6 w-6 items-center justify-center rounded text-text-secondary transition-colors hover:bg-bg-elevated hover:text-text-primary"
                    onClick={handleOpenNewAgentMenu}
                    title="New agent thread"
                    type="button"
                >
                    <PlusIcon />
                </button>
                <button
                    className="sidebar-agents-summary-action rounded px-1.5 py-0.5 text-[10px] font-medium text-text-secondary transition-colors hover:bg-bg-elevated hover:text-text-primary"
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
    readonly groups: readonly AiSessionHierarchyGroup[];
    readonly onContextMenu: (
        event: ReactMouseEvent,
        session: AiHistorySessionSummary,
    ) => void;
    readonly onOpen: (session: AiHistorySessionSummary) => void;
    readonly onRenameDraftChange: (value: string) => void;
    readonly onToggleCollapsed: (sessionId: string) => void;
    readonly onTogglePinned: (
        session: AiHistorySessionSummary,
    ) => Promise<void> | void;
    readonly renameDraft: string;
    readonly renamingSessionId: string | null;
    readonly title: string | null;
}) {
    const sessionCount = countHierarchyGroupRows(groups);

    return (
        <section className="mt-1 first:mt-0">
            {title ? (
                <header className="sidebar-agents-section-header flex items-center gap-1.5 px-2 pb-0.5 pt-1 text-[9.5px] font-semibold uppercase tracking-[0.08em] text-text-secondary/80">
                    <span>{title}</span>
                    <span className="font-normal opacity-70">
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
                            className={row.depth > 0 ? "pl-3" : undefined}
                            key={row.session.sessionId}
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
        session: AiHistorySessionSummary,
    ) => void;
    readonly onOpen: (session: AiHistorySessionSummary) => void;
    readonly onRenameDraftChange: (value: string) => void;
    readonly onToggleCollapsed: (sessionId: string) => void;
    readonly onTogglePinned: (
        session: AiHistorySessionSummary,
    ) => Promise<void> | void;
    readonly renameDraft: string;
    readonly session: AiHistorySessionSummary;
}) {
    const preview = getHistoryPreviewText(session);
    const title = truncateChatTitle(session.title, SIDEBAR_AGENTS_TITLE_MAX_CHARS);
    const isPinned = isSessionPinned(session);
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
    const indentStyle =
        depth > 1 ? { marginLeft: `${Math.min(depth - 1, 3) * 10}px` } : undefined;

    return (
        <div
            className="sidebar-agents-row app-no-drag w-full"
            aria-current={isActive ? "true" : undefined}
            data-active={isActive ? "true" : "false"}
            data-subagent={isSubagent ? "true" : "false"}
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
                        className="sidebar-agents-collapse-button -ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded text-text-secondary transition-colors hover:bg-bg-elevated hover:text-text-primary"
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
                ) : (
                    <span
                        aria-hidden="true"
                        className="h-4 w-4 shrink-0"
                    />
                )}
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
                {isRenaming ? null : (
                    <button
                        aria-label={
                            isPinned
                                ? "Unpin thread from sidebar"
                                : "Pin thread to sidebar"
                        }
                        aria-pressed={isPinned}
                        className={[
                            "sidebar-agents-pin-button flex h-5 w-5 shrink-0 items-center justify-center rounded border text-text-secondary transition-colors",
                            isPinned
                                ? "border-border bg-bg-elevated text-text-primary"
                                : "border-transparent hover:border-border hover:bg-bg-elevated hover:text-text-primary",
                        ].join(" ")}
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
                        <span className="shrink-0 rounded-[3px] border border-border/70 px-1 text-[8.5px] font-medium uppercase tracking-[0.08em]">
                            Agent
                        </span>
                        <span aria-hidden="true" className="shrink-0">
                            ·
                        </span>
                    </>
                ) : null}
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

function isSessionPinned(session: AiHistorySessionSummary): boolean {
    return (session.pinnedAt ?? null) !== null;
}

function isSubagentSession(session: AiHistorySessionSummary): boolean {
    const parentSessionId = (session.parentSessionId ?? "").trim();
    return parentSessionId.length > 0 && parentSessionId !== session.sessionId;
}

function countHierarchyGroupRows(
    groups: readonly AiSessionHierarchyGroup[],
): number {
    return groups.reduce((count, group) => count + group.rows.length, 0);
}

function getVisibleSidebarHierarchyRows(
    group: AiSessionHierarchyGroup,
    collapsedSessionIds: ReadonlySet<string>,
): readonly AiSessionHierarchyRow[] {
    return filterAiSessionHierarchyRowsForCollapsedParents(
        group.rows,
        collapsedSessionIds,
    );
}

function comparePinnedHierarchyGroups(
    left: AiSessionHierarchyGroup,
    right: AiSessionHierarchyGroup,
): number {
    const pinnedComparison = getLatestPinnedAt(right).localeCompare(
        getLatestPinnedAt(left),
    );
    if (pinnedComparison !== 0) {
        return pinnedComparison;
    }

    return getLatestUpdatedAt(right).localeCompare(getLatestUpdatedAt(left));
}

function getLatestPinnedAt(group: AiSessionHierarchyGroup): string {
    return group.rows.reduce(
        (latest, row) =>
            (row.session.pinnedAt ?? "").localeCompare(latest) > 0
                ? (row.session.pinnedAt ?? "")
                : latest,
        "",
    );
}

function getLatestUpdatedAt(group: AiSessionHierarchyGroup): string {
    return group.rows.reduce(
        (latest, row) =>
            row.session.updatedAt.localeCompare(latest) > 0
                ? row.session.updatedAt
                : latest,
        "",
    );
}

function compareSidebarHierarchySiblings(
    left: AiHistorySessionSummary,
    right: AiHistorySessionSummary,
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
    group: AiSessionHierarchyGroup,
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
