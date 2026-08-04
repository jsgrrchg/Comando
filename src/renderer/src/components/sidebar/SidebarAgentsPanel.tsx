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
    AiRuntimeDescriptor,
    AiRuntimeId,
    AiSessionStatus,
    ComandoApi,
    WorkspaceSurfaceAgentPresenceState,
    WorkspaceSurfaceActionRequest,
} from "@shared/ipc";
import {
    BUILT_IN_AI_RUNTIME_CATALOG,
} from "@shared/ai-runtimes";

import { useAiStore } from "@renderer/app/store/ai-store";
import { useWorkspaceStore } from "@renderer/app/store/workspace-store";
import {
    checkClaudeCodeInstalled,
    launchClaudeCodeTerminal,
} from "@renderer/features/terminal/claudeCodeTerminal";
import {
    CLAUDE_CODE_TERMINAL_RUNTIME_ID,
    closeClaudeCodeSidebarSession,
    focusClaudeCodeSidebarSession,
    isClaudeCodeSidebarSession,
    renameClaudeCodeSidebarSession,
    type SidebarAgentSessionSummary,
} from "@renderer/features/terminal/claudeCodeSidebarSession";

import {
    ContextMenu,
    type ContextMenuEntry,
    type ContextMenuState,
} from "@renderer/components/context-menu/ContextMenu";
import {
    requestNativeContextMenuAction,
} from "@renderer/components/context-menu/nativeContextMenu";
import {
    formatHistoryRelativeDateCompact,
    getHistoryRuntimeLabel,
} from "@renderer/components/workspace/chat-history/historyPresentation";
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
import { ProviderIcon } from "@renderer/components/workspace/ProviderIcon";
import { releaseScopedToolUiStateStore } from "@renderer/components/workspace/chat/toolExpansionStore";
import { releaseCachedChatTimeline } from "@renderer/components/workspace/chat/chatTimelineCache";

import {
    mergeOpenSessionFallbacks,
    SIDEBAR_AGENTS_HISTORY_LIMIT,
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
import {
    createSidebarAgentsFolder,
    deleteSidebarAgentsFolder,
    getOrderedSidebarAgentFolderIds,
    getSidebarAgentsFolderStorageKey,
    moveSidebarAgentSessionToFolder,
    persistSidebarAgentsFolderState,
    readSidebarAgentsFolderState,
    removeSidebarAgentSessionFolderAssignment,
    renameSidebarAgentsFolder,
    reorderSidebarAgentsFolder,
    toggleSidebarAgentsFolderCollapsed,
    type SidebarAgentFolder,
    type SidebarAgentsFolderState,
} from "./sidebarAgentsFolderState";
import { emitSidebarAgentDrag } from "./sidebarAgentDragEvents";
import {
    shouldCancelSidebarDragOnMove,
    shouldEmitSidebarDragCancel,
} from "./sidebarDragGuards";
import {
    SidebarAgentsFolderList,
    type EditingSidebarAgentFolder,
} from "./SidebarAgentsFolderList";
import {
    useRestorableSidebarScroll,
    type SidebarScrollPositionStoreRef,
} from "./useRestorableSidebarScroll";

interface SidebarAgentsContextMenuPayload {
    readonly sessionId: string;
}

type SidebarAgentDragPreview = {
    readonly activity: WorkspaceChatTabActivityIndicator;
    readonly canOpenInPane: boolean;
    readonly runtimeLabel: string;
    readonly title: string;
    readonly x: number;
    readonly y: number;
};

type SidebarAgentActivity = {
    readonly indicator: NonNullable<WorkspaceChatTabActivityIndicator>;
    readonly label: string;
} | null;

type SidebarAgentDragCoordinates = {
    readonly clientX: number;
    readonly clientY: number;
};

type SidebarAgentInternalDropTarget =
    | { readonly folderId: string; readonly kind: "folder" }
    | { readonly kind: "unfiled" }
    | null;

const SIDEBAR_AGENTS_REFRESH_DEBOUNCE_MS = 800;
const EMPTY_AGENTS_SESSIONS: readonly AiHistorySessionSummary[] = [];
const EMPTY_COLLAPSED_IDS: ReadonlySet<string> = new Set();

const SIDEBAR_AGENT_DRAG_THRESHOLD_PX = 6;
const CLAUDE_CODE_TERMINAL_DESCRIPTION =
    "Open the claude CLI in a workspace terminal.";
const CLAUDE_CODE_NOT_FOUND_MESSAGE =
    "The claude command was not found in Comando's PATH. Your shell may still resolve it.";

export function SidebarAgentsPanel({
    agentPresence,
    filter,
    onRequestWorkspaceAction,
    projectId,
    runtimeCatalog = BUILT_IN_AI_RUNTIME_CATALOG,
    scrollKey,
    scrollPositionsRef,
    workspaceContextKey,
    worktreeId,
}: {
    readonly agentPresence?: WorkspaceSurfaceAgentPresenceState | null;
    readonly filter?: string;
    readonly onRequestWorkspaceAction?: (
        request: WorkspaceSurfaceActionRequest,
    ) => void;
    readonly projectId: string | null;
    readonly runtimeCatalog?: readonly AiRuntimeDescriptor[];
    readonly scrollKey?: string;
    readonly scrollPositionsRef?: SidebarScrollPositionStoreRef;
    readonly workspaceContextKey?: string | null;
    readonly worktreeId: string | null;
}) {
    const localScrollPositionsRef = useRef(new Map<string, number>());
    const { handleScroll, setScrollElement } = useRestorableSidebarScroll({
        scrollKey:
            scrollKey ??
            `agents:${workspaceContextKey ?? projectId ?? "unavailable"}`,
        scrollPositionsRef: scrollPositionsRef ?? localScrollPositionsRef,
    });
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
    const aiSessions = useAiStore((state) => state.sessions);
    const activeSessionId = agentPresence?.activeSessionId ?? null;
    const historyScopeKey = useMemo(
        () => getSidebarAgentsHistoryCacheKey(projectId, worktreeId),
        [projectId, worktreeId],
    );
    const folderScopeKey = useMemo(
        () => getSidebarAgentsFolderStorageKey(projectId, worktreeId),
        [projectId, worktreeId],
    );

    const [sessions, setSessions] = useState<readonly AiHistorySessionSummary[]>(
        () => readSidebarAgentsHistoryCache(projectId, worktreeId)?.sessions ?? [],
    );
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [contextMenu, setContextMenu] = useState<
        ContextMenuState<SidebarAgentsContextMenuPayload> | null
    >(null);
    const [folderMenu, setFolderMenu] = useState<
        ContextMenuState<SidebarAgentFolder> | null
    >(null);
    const [editingFolder, setEditingFolder] =
        useState<EditingSidebarAgentFolder | null>(null);
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
    const [folderState, setFolderState] = useState<SidebarAgentsFolderState>(
        () => readSidebarAgentsFolderState(projectId, worktreeId),
    );
    const folderStateRef = useRef<{
        readonly scopeKey: string;
        readonly state: SidebarAgentsFolderState;
    } | null>(null);
    const [loadedFolderScopeKey, setLoadedFolderScopeKey] =
        useState(folderScopeKey);
    const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(
        null,
    );
    const [isDraggingOverUnfiled, setIsDraggingOverUnfiled] = useState(false);
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
    const previousPresenceSessionIdsRef = useRef<ReadonlySet<string>>(new Set());
    const deletedSessionIdsRef = useRef<Set<string>>(new Set());
    const normalizedFilter = (filter ?? "").trim().toLowerCase();
    const hasQuery = normalizedFilter.length > 0;
    const pendingHistoryCache =
        loadedHistoryScopeKey === historyScopeKey
            ? null
            : readSidebarAgentsHistoryCache(projectId, worktreeId);
    const visibleFolderState =
        loadedFolderScopeKey === folderScopeKey
            ? folderState
            : readSidebarAgentsFolderState(projectId, worktreeId);
    folderStateRef.current = {
        scopeKey: folderScopeKey,
        state: visibleFolderState,
    };
    const orderedFolders = useMemo(
        () =>
            getOrderedSidebarAgentFolderIds(
                visibleFolderState.folders,
                visibleFolderState.folderOrder,
            ).flatMap((folderId) => {
                const folder = visibleFolderState.folders[folderId];
                return folder ? [folder] : [];
            }),
        [visibleFolderState.folderOrder, visibleFolderState.folders],
    );
    const cachedHistorySessions =
        loadedHistoryScopeKey === historyScopeKey
            ? sessions
            : pendingHistoryCache?.sessions ?? EMPTY_AGENTS_SESSIONS;
    const presenceOpenSessionFallbacks = useMemo(() => {
        if (!agentPresence) {
            return [];
        }
        return agentPresence.sessions.flatMap((session) => {
            if (session.kind !== "ai") {
                return [];
            }
            return [
                {
                    createdAt: session.createdAt,
                    messageCount: 0,
                    parentSessionId: session.parentSessionId,
                    pinnedAt: null,
                    preview: null,
                    projectId: agentPresence.projectId,
                    runtimeId: session.runtimeId,
                    runtimeSessionId: session.runtimeSessionId,
                    sessionId: session.sessionId,
                    title: session.title,
                    updatedAt: session.updatedAt,
                    worktreeId: agentPresence.worktreeId,
                },
            ];
        });
    }, [agentPresence]);
    const agentPresenceStatusBySessionId = useMemo(
        () =>
            new Map<string, AiSessionStatus | null>(
                (agentPresence?.sessions ?? []).map((session) => [
                    session.sessionId,
                    session.status,
                ]),
            ),
        [agentPresence],
    );
    const historySessionsWithLivePresence = useMemo(() => {
        const liveSessionsById = new Map(
            presenceOpenSessionFallbacks.map((session) => [
                session.sessionId,
                session,
            ]),
        );
        return cachedHistorySessions.map((session) => {
            const liveSession = liveSessionsById.get(session.sessionId);
            if (!liveSession) {
                return session;
            }
            // The active surface has newer title and hierarchy metadata than history.
            return {
                ...session,
                parentSessionId: liveSession.parentSessionId,
                runtimeId: liveSession.runtimeId,
                runtimeSessionId: liveSession.runtimeSessionId,
                title: liveSession.title,
                updatedAt: liveSession.updatedAt,
            };
        });
    }, [cachedHistorySessions, presenceOpenSessionFallbacks]);
    const visibleHistorySessions = useMemo(
        () =>
            mergeOpenSessionFallbacks(
                historySessionsWithLivePresence,
                presenceOpenSessionFallbacks.filter(
                    (session) =>
                        !deletedSessionIdsRef.current.has(session.sessionId),
                ),
            ),
        [historySessionsWithLivePresence, presenceOpenSessionFallbacks],
    );
    const visibleTerminalAgentSessions = useMemo<
        readonly SidebarAgentSessionSummary[]
    >(() => {
        const presence = agentPresence;
        if (!presence) {
            return [];
        }
        return presence.sessions.flatMap((session) =>
            session.kind === "terminal"
                ? [
                      {
                          createdAt: session.createdAt,
                          isTerminalAgent: true as const,
                          messageCount: 0,
                          pinnedAt: null,
                          preview: session.preview,
                          projectId: presence.projectId,
                          runtimeId: session.runtimeId,
                          runtimeSessionId: session.runtimeSessionId,
                          sessionId: session.sessionId,
                          terminalId: session.terminalId,
                          title: session.title,
                          updatedAt: session.updatedAt,
                          worktreeId: presence.worktreeId,
                      },
                  ]
                : [],
        );
    }, [agentPresence]);
    const visibleSessions = useMemo<readonly SidebarAgentSessionSummary[]>(
        () => [...visibleTerminalAgentSessions, ...visibleHistorySessions],
        [visibleHistorySessions, visibleTerminalAgentSessions],
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

    const updateFolderState = useCallback(
        (
            updater: (
                current: SidebarAgentsFolderState,
            ) => SidebarAgentsFolderState,
        ) => {
            const currentScopeState =
                folderStateRef.current?.scopeKey === folderScopeKey
                    ? folderStateRef.current.state
                    : readSidebarAgentsFolderState(projectId, worktreeId);
            const nextState = persistSidebarAgentsFolderState(
                projectId,
                worktreeId,
                updater(currentScopeState),
            );
            folderStateRef.current = {
                scopeKey: folderScopeKey,
                state: nextState,
            };
            setLoadedFolderScopeKey(folderScopeKey);
            setFolderState(nextState);
        },
        [folderScopeKey, projectId, worktreeId],
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
        setFolderState(readSidebarAgentsFolderState(projectId, worktreeId));
        setLoadedFolderScopeKey(folderScopeKey);
        setEditingFolder(null);
        setFolderMenu(null);
        setDragOverFolderId(null);
        setIsDraggingOverUnfiled(false);
    }, [folderScopeKey, projectId, worktreeId]);

    useEffect(() => {
        const currentIds = new Set(
            (agentPresence?.sessions ?? []).map((session) => session.sessionId),
        );
        const previousIds = previousPresenceSessionIdsRef.current;
        previousPresenceSessionIdsRef.current = currentIds;

        if ([...previousIds].some((sessionId) => !currentIds.has(sessionId))) {
            // A closed live session becomes history after the surface stops reporting it.
            scheduleReload();
        }
    }, [agentPresence, scheduleReload]);

    const handleOpenSession = useCallback(
        (session: SidebarAgentSessionSummary) => {
            if (isClaudeCodeSidebarSession(session)) {
                if (onRequestWorkspaceAction) {
                    if (!projectId || !workspaceContextKey) {
                        return;
                    }
                    onRequestWorkspaceAction({
                        contextKey: workspaceContextKey,
                        kind: "focus-terminal",
                        projectId,
                        terminalId: session.terminalId,
                        worktreeId,
                    });
                    return;
                }
                void focusClaudeCodeSidebarSession(session);
                return;
            }

            if (onRequestWorkspaceAction) {
                if (!projectId || !workspaceContextKey) {
                    return;
                }
                onRequestWorkspaceAction({
                    contextKey: workspaceContextKey,
                    kind: "chat-session",
                    projectId,
                    runtimeId: session.runtimeId as AiRuntimeId,
                    sessionId: session.sessionId,
                    sessionProjectId: session.projectId,
                    sessionWorktreeId: session.worktreeId ?? null,
                    title: session.title,
                    worktreeId,
                });
                return;
            }

            void openChatSessionTab({
                projectId: session.projectId,
                runtimeId: session.runtimeId as AiRuntimeId,
                sessionOpenMode: "history",
                sessionId: session.sessionId,
                title: session.title,
                worktreeId: session.worktreeId ?? null,
            });
        },
        [
            onRequestWorkspaceAction,
            openChatSessionTab,
            projectId,
            workspaceContextKey,
            worktreeId,
        ],
    );

    const handleOpenHistoryTab = useCallback(() => {
        if (onRequestWorkspaceAction) {
            if (!projectId || !workspaceContextKey) {
                return;
            }
            onRequestWorkspaceAction({
                contextKey: workspaceContextKey,
                kind: "chat-history",
                projectId,
                worktreeId,
            });
            return;
        }
        void openChatHistoryTab(projectId, worktreeId);
    }, [
        onRequestWorkspaceAction,
        openChatHistoryTab,
        projectId,
        workspaceContextKey,
        worktreeId,
    ]);

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
            if (onRequestWorkspaceAction) {
                if (!projectId || !workspaceContextKey) {
                    return;
                }
                onRequestWorkspaceAction({
                    contextKey: workspaceContextKey,
                    kind: "new-chat",
                    projectId,
                    runtimeId,
                    worktreeId,
                });
                return;
            }
            void createChatTab(projectId, worktreeId, runtimeId);
        },
        [
            createChatTab,
            onRequestWorkspaceAction,
            projectId,
            workspaceContextKey,
            worktreeId,
        ],
    );
    const handleOpenClaudeCodeTerminal = useCallback(() => {
        if (onRequestWorkspaceAction) {
            if (!projectId || !workspaceContextKey) {
                return;
            }
            onRequestWorkspaceAction({
                contextKey: workspaceContextKey,
                kind: "new-claude-terminal",
                projectId,
                worktreeId,
            });
            return;
        }
        void launchClaudeCodeTerminal({
            projectId,
            worktreeId,
        });
    }, [
        onRequestWorkspaceAction,
        projectId,
        workspaceContextKey,
        worktreeId,
    ]);

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

    const createFolderForSession = useCallback(
        (sessionId: string | null = null) => {
            const result = createSidebarAgentsFolder(
                visibleFolderState,
                "New Folder",
            );
            if (!result.folderId) {
                return;
            }

            const nextState = sessionId
                ? moveSidebarAgentSessionToFolder(
                      result.state,
                      sessionId,
                      result.folderId,
                  )
                : result.state;
            updateFolderState(() => nextState);
            setEditingFolder({
                folderId: result.folderId,
                name: "New Folder",
            });
        },
        [updateFolderState, visibleFolderState],
    );

    const commitFolderRename = useCallback(() => {
        if (!editingFolder) {
            return;
        }
        updateFolderState((current) =>
            renameSidebarAgentsFolder(
                current,
                editingFolder.folderId,
                editingFolder.name,
            ),
        );
        setEditingFolder(null);
    }, [editingFolder, updateFolderState]);

    const handleFolderContextMenu = useCallback(
        (event: ReactMouseEvent, folder: SidebarAgentFolder) => {
            event.preventDefault();
            event.stopPropagation();
            setContextMenu(null);
            setNewAgentMenu(null);
            setFolderMenu({
                payload: folder,
                x: event.clientX,
                y: event.clientY,
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
            if (onRequestWorkspaceAction) {
                if (!projectId || !workspaceContextKey) {
                    return;
                }
                onRequestWorkspaceAction({
                    contextKey: workspaceContextKey,
                    kind: "rename-terminal",
                    projectId,
                    terminalId: session.terminalId,
                    title: trimmedTitle,
                    worktreeId,
                });
            } else {
                await renameClaudeCodeSidebarSession(session, trimmedTitle);
            }
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
        onRequestWorkspaceAction,
        projectId,
        setSessionsAndCache,
        updateSessionTabTitles,
        visibleSessions,
        workspaceContextKey,
        worktreeId,
    ]);

    const handleDelete = useCallback(
        async (session: SidebarAgentSessionSummary) => {
            if (isClaudeCodeSidebarSession(session)) {
                if (onRequestWorkspaceAction) {
                    if (!projectId || !workspaceContextKey) {
                        return;
                    }
                    onRequestWorkspaceAction({
                        contextKey: workspaceContextKey,
                        kind: "close-terminal",
                        projectId,
                        terminalId: session.terminalId,
                        worktreeId,
                    });
                } else {
                    await closeClaudeCodeSidebarSession(session);
                }
                updateFolderState((current) =>
                    removeSidebarAgentSessionFolderAssignment(
                        current,
                        session.sessionId,
                    ),
                );
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
                updateFolderState((current) =>
                    removeSidebarAgentSessionFolderAssignment(
                        current,
                        historySession.sessionId,
                    ),
                );
                releaseScopedToolUiStateStore(historySession.sessionId);
                releaseCachedChatTimeline(historySession.sessionId);

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
        [
            closeTab,
            onRequestWorkspaceAction,
            projectId,
            setSessionsAndCache,
            updateFolderState,
            visibleHistorySessions,
            workspaceContextKey,
            worktreeId,
        ],
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
                runtimeCatalog,
            }),
        [
            claudeCodeAvailable,
            handleCreateNewAgentTab,
            handleOpenClaudeCodeTerminal,
            runtimeCatalog,
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

        entries.push({
            label: "Move to Folder",
            disabled: isSubagentSession(session),
            children: [
                {
                    label: "New Folder…",
                    action: () => createFolderForSession(session.sessionId),
                },
                { type: "separator" },
                {
                    label: "No Folder",
                    disabled:
                        !visibleFolderState.sessionFolderIds[
                            session.sessionId
                        ],
                    action: () =>
                        updateFolderState((current) =>
                            moveSidebarAgentSessionToFolder(
                                current,
                                session.sessionId,
                                null,
                            ),
                        ),
                },
                ...orderedFolders.map((folder) => ({
                    label: folder.name,
                    disabled:
                        visibleFolderState.sessionFolderIds[
                            session.sessionId
                        ] === folder.id,
                    action: () =>
                        updateFolderState((current) =>
                            moveSidebarAgentSessionToFolder(
                                current,
                                session.sessionId,
                                folder.id,
                            ),
                        ),
                })),
            ],
        });

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
        createFolderForSession,
        handleDelete,
        handleTogglePinned,
        orderedFolders,
        startRename,
        updateFolderState,
        visibleFolderState.sessionFolderIds,
        visibleSessions,
    ]);
    const folderMenuEntries = useMemo<readonly ContextMenuEntry[]>(
        () =>
            folderMenu
                ? [
                      {
                          label: "Rename Folder",
                          action: () =>
                              setEditingFolder({
                                  folderId: folderMenu.payload.id,
                                  name: folderMenu.payload.name,
                              }),
                      },
                      { type: "separator" as const },
                      {
                          label: "Delete Folder",
                          danger: true,
                          action: () =>
                              updateFolderState((current) =>
                                  deleteSidebarAgentsFolder(
                                      current,
                                      folderMenu.payload.id,
                                  ),
                              ),
                      },
                  ]
                : [],
        [folderMenu, updateFolderState],
    );
    const useNativeContextMenus = Boolean(onRequestWorkspaceAction);
    const activeNativeSessionMenuRef = useRef<object | null>(null);
    const activeNativeFolderMenuRef = useRef<object | null>(null);
    const activeNativeNewAgentMenuRef = useRef<object | null>(null);

    const openNativeMenu = useCallback(
        async (
            entries: readonly ContextMenuEntry[],
            menu: ContextMenuState<unknown>,
            close: () => void,
        ) => {
            let action: (() => void) | null = null;
            try {
                action = await requestNativeContextMenuAction(entries, menu);
            } catch {
                // Native menus are best-effort; dismissal is the safe fallback.
            } finally {
                close();
            }
            if (action) queueMicrotask(action);
        },
        [],
    );

    useEffect(() => {
        if (!useNativeContextMenus || !contextMenu) {
            activeNativeSessionMenuRef.current = null;
            return;
        }
        if (activeNativeSessionMenuRef.current === contextMenu) {
            return;
        }
        activeNativeSessionMenuRef.current = contextMenu;
        void openNativeMenu(
            contextMenuEntries,
            contextMenu,
            () => setContextMenu(null),
        );
    }, [
        contextMenu,
        contextMenuEntries,
        openNativeMenu,
        useNativeContextMenus,
    ]);

    useEffect(() => {
        if (!useNativeContextMenus || !folderMenu) {
            activeNativeFolderMenuRef.current = null;
            return;
        }
        if (activeNativeFolderMenuRef.current === folderMenu) {
            return;
        }
        activeNativeFolderMenuRef.current = folderMenu;
        void openNativeMenu(
            folderMenuEntries,
            folderMenu,
            () => setFolderMenu(null),
        );
    }, [
        folderMenu,
        folderMenuEntries,
        openNativeMenu,
        useNativeContextMenus,
    ]);

    useEffect(() => {
        if (!useNativeContextMenus || !newAgentMenu) {
            activeNativeNewAgentMenuRef.current = null;
            return;
        }
        if (activeNativeNewAgentMenuRef.current === newAgentMenu) {
            return;
        }
        activeNativeNewAgentMenuRef.current = newAgentMenu;
        void openNativeMenu(
            newAgentMenuEntries,
            newAgentMenu,
            () => setNewAgentMenu(null),
        );
    }, [
        newAgentMenu,
        newAgentMenuEntries,
        openNativeMenu,
        useNativeContextMenus,
    ]);

    const openSessionIds = useMemo(() => {
        return new Set(
            (agentPresence?.sessions ?? []).map((session) => session.sessionId),
        );
    }, [agentPresence]);

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

        for (const session of visibleSessions) {
            const sessionId = session.sessionId;
            const working = isSessionWorking(
                aiSessions[sessionId],
                agentPresenceStatusBySessionId.get(sessionId),
            );
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
            if (!visibleSessions.some((session) => session.sessionId === trackedId)) {
                map.delete(trackedId);
                changed = true;
            }
        }

        if (changed) {
            setWorkingOrderRevision((value) => value + 1);
        }
    }, [agentPresenceStatusBySessionId, aiSessions, visibleSessions]);

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
    const folderGroups = useMemo(() => {
        const groupsByFolderId = new Map<
            string,
            AiSessionHierarchyGroup<SidebarAgentSessionSummary>[]
        >();
        for (const folder of orderedFolders) {
            groupsByFolderId.set(folder.id, []);
        }
        for (const group of hierarchyGroups) {
            const folderId =
                visibleFolderState.sessionFolderIds[
                    group.rootSession.sessionId
                ];
            if (folderId && groupsByFolderId.has(folderId)) {
                groupsByFolderId.get(folderId)?.push(group);
            }
        }
        return groupsByFolderId;
    }, [
        hierarchyGroups,
        orderedFolders,
        visibleFolderState.sessionFolderIds,
    ]);
    const unfiledOtherGroups = useMemo(
        () =>
            otherGroups.filter(
                (group) =>
                    !visibleFolderState.sessionFolderIds[
                        group.rootSession.sessionId
                    ],
            ),
        [otherGroups, visibleFolderState.sessionFolderIds],
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

    const updateAgentInternalDropTarget = useCallback(
        (
            session: SidebarAgentSessionSummary,
            coordinates: SidebarAgentDragCoordinates,
        ) => {
            const target = isSubagentSession(session)
                ? null
                : getSidebarAgentInternalDropTargetAtPoint(
                      coordinates.clientX,
                      coordinates.clientY,
                  );
            setDragOverFolderId(
                target?.kind === "folder" ? target.folderId : null,
            );
            setIsDraggingOverUnfiled(target?.kind === "unfiled");
        },
        [],
    );

    const handleAgentInternalDragEnd = useCallback(
        (
            session: SidebarAgentSessionSummary,
            coordinates: SidebarAgentDragCoordinates,
        ) => {
            const target = isSubagentSession(session)
                ? null
                : getSidebarAgentInternalDropTargetAtPoint(
                      coordinates.clientX,
                      coordinates.clientY,
                  );
            if (target?.kind === "folder") {
                updateFolderState((current) =>
                    moveSidebarAgentSessionToFolder(
                        current,
                        session.sessionId,
                        target.folderId,
                    ),
                );
            } else if (target?.kind === "unfiled") {
                updateFolderState((current) =>
                    moveSidebarAgentSessionToFolder(
                        current,
                        session.sessionId,
                        null,
                    ),
                );
            }
            setDragOverFolderId(null);
            setIsDraggingOverUnfiled(false);
            return target !== null;
        },
        [updateFolderState],
    );

    const handleAgentInternalDragCancel = useCallback(() => {
        setDragOverFolderId(null);
        setIsDraggingOverUnfiled(false);
    }, []);

    const handleToggleFolder = useCallback(
        (folderId: string) => {
            updateFolderState((current) =>
                toggleSidebarAgentsFolderCollapsed(current, folderId),
            );
        },
        [updateFolderState],
    );

    const handleReorderFolder = useCallback(
        (folderId: string, destinationIndex: number) => {
            updateFolderState((current) =>
                reorderSidebarAgentsFolder(
                    current,
                    folderId,
                    destinationIndex,
                ),
            );
        },
        [updateFolderState],
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
                    aria-label="New folder"
                    className="sidebar-toolbar-action sidebar-toolbar-action--icon"
                    onClick={() => createFolderForSession()}
                    title="New folder"
                    type="button"
                >
                    <NewFolderIcon />
                </button>
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
                    disabled={Boolean(onRequestWorkspaceAction) && (!projectId || !workspaceContextKey)}
                    onClick={handleOpenHistoryTab}
                    title="Open full history"
                    type="button"
                >
                    History
                </button>
            </div>

            <div
                ref={setScrollElement}
                className="shell-scrollbar min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1 pb-2"
                onScroll={handleScroll}
            >
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
                        onDragCancel={handleAgentInternalDragCancel}
                        onDragEnd={handleAgentInternalDragEnd}
                        onDragMove={updateAgentInternalDropTarget}
                        onDragStart={updateAgentInternalDropTarget}
                        onOpen={handleOpenSession}
                        onRenameDraftChange={setRenameDraft}
                        onToggleCollapsed={handleToggleCollapsed}
                        onTogglePinned={handleTogglePinned}
                        activeSessionId={activeSessionId}
                        activityStatusBySessionId={agentPresenceStatusBySessionId}
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
                        onDragCancel={handleAgentInternalDragCancel}
                        onDragEnd={handleAgentInternalDragEnd}
                        onDragMove={updateAgentInternalDropTarget}
                        onDragStart={updateAgentInternalDropTarget}
                        onOpen={handleOpenSession}
                        onRenameDraftChange={setRenameDraft}
                        onToggleCollapsed={handleToggleCollapsed}
                        onTogglePinned={handleTogglePinned}
                        activeSessionId={activeSessionId}
                        activityStatusBySessionId={agentPresenceStatusBySessionId}
                        collapsedSessionIds={collapsedSessionIds}
                        collapseEnabled={!hasQuery}
                        renameDraft={renameDraft}
                        renamingSessionId={renamingSessionId}
                        groups={openGroups}
                        title={showUnpinnedSectionHeaders ? "Open" : null}
                    />
                ) : null}

                {!showBlockingLoading &&
                !visibleError &&
                (!hasQuery || filteredSessionCount > 0) ? (
                    <SidebarAgentsFolderList
                        collapsedFolderIds={
                            visibleFolderState.collapsedFolderIds
                        }
                        dragOverFolderId={dragOverFolderId}
                        editingFolder={editingFolder}
                        folders={orderedFolders}
                        getFolderGroupCount={(folderId) =>
                            folderGroups.get(folderId)?.length ?? 0
                        }
                        onCommitFolderRename={commitFolderRename}
                        onEditingFolderChange={setEditingFolder}
                        onFolderContextMenu={handleFolderContextMenu}
                        onReorderFolder={handleReorderFolder}
                        onToggleFolder={handleToggleFolder}
                        renderFolderContents={(folder) => (
                            <SidebarAgentsSection
                                activeSessionId={activeSessionId}
                                activityStatusBySessionId={agentPresenceStatusBySessionId}
                                cancelRename={cancelRename}
                                collapsedSessionIds={collapsedSessionIds}
                                collapseEnabled={!hasQuery}
                                commitRename={() => void commitRename()}
                                groups={folderGroups.get(folder.id) ?? []}
                                onContextMenu={handleContextMenu}
                                onDragCancel={handleAgentInternalDragCancel}
                                onDragEnd={handleAgentInternalDragEnd}
                                onDragMove={updateAgentInternalDropTarget}
                                onDragStart={updateAgentInternalDropTarget}
                                onOpen={handleOpenSession}
                                onRenameDraftChange={setRenameDraft}
                                onToggleCollapsed={handleToggleCollapsed}
                                onTogglePinned={handleTogglePinned}
                                renameDraft={renameDraft}
                                renamingSessionId={renamingSessionId}
                                title={null}
                            />
                        )}
                    />
                ) : null}

                {unfiledOtherGroups.length > 0 ||
                (orderedFolders.length > 0 &&
                    (!hasQuery || filteredSessionCount > 0)) ? (
                    <div
                        className="sidebar-agents-unfiled-drop-zone rounded"
                        data-agent-unfiled-drop-zone="true"
                        data-drop-target={
                            isDraggingOverUnfiled ? "true" : "false"
                        }
                    >
                        <SidebarAgentsSection
                            cancelRename={cancelRename}
                            commitRename={() => void commitRename()}
                            onContextMenu={handleContextMenu}
                            onDragCancel={handleAgentInternalDragCancel}
                            onDragEnd={handleAgentInternalDragEnd}
                            onDragMove={updateAgentInternalDropTarget}
                            onDragStart={updateAgentInternalDropTarget}
                            onOpen={handleOpenSession}
                            onRenameDraftChange={setRenameDraft}
                            onToggleCollapsed={handleToggleCollapsed}
                            onTogglePinned={handleTogglePinned}
                            activeSessionId={activeSessionId}
                            activityStatusBySessionId={agentPresenceStatusBySessionId}
                            collapsedSessionIds={collapsedSessionIds}
                            collapseEnabled={!hasQuery}
                            renameDraft={renameDraft}
                            renamingSessionId={renamingSessionId}
                            groups={unfiledOtherGroups}
                            title={
                                showUnpinnedSectionHeaders ||
                                orderedFolders.length > 0
                                    ? "All"
                                    : null
                            }
                        />
                    </div>
                ) : null}
            </div>

            {contextMenu && !useNativeContextMenus ? (
                <ContextMenu
                    entries={contextMenuEntries}
                    menu={contextMenu}
                    minWidth={160}
                    onClose={() => setContextMenu(null)}
                />
            ) : null}

            {folderMenu && !useNativeContextMenus ? (
                <ContextMenu
                    entries={folderMenuEntries}
                    menu={folderMenu}
                    minWidth={160}
                    onClose={() => setFolderMenu(null)}
                />
            ) : null}

            {newAgentMenu && !useNativeContextMenus ? (
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
    runtimeCatalog = BUILT_IN_AI_RUNTIME_CATALOG,
}: {
    readonly claudeCodeAvailable: boolean | null;
    readonly onCreateNewAgentTab: (runtimeId: AiRuntimeId) => void;
    readonly onOpenClaudeCodeTerminal: () => void;
    readonly runtimeCatalog?: readonly AiRuntimeDescriptor[];
}): readonly ContextMenuEntry[] {
    return [
        ...runtimeCatalog
            .filter((runtime) => runtime.available)
            .map((runtime) => ({
                action: () => onCreateNewAgentTab(runtime.id),
                label: `New ${runtime.displayName} thread`,
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
    activityStatusBySessionId,
    cancelRename,
    collapsedSessionIds,
    collapseEnabled,
    commitRename,
    groups,
    onContextMenu,
    onDragCancel,
    onDragEnd,
    onDragMove,
    onDragStart,
    onOpen,
    onRenameDraftChange,
    onToggleCollapsed,
    onTogglePinned,
    renameDraft,
    renamingSessionId,
    title,
}: {
    readonly activeSessionId: string | null;
    readonly activityStatusBySessionId: ReadonlyMap<
        string,
        AiSessionStatus | null
    >;
    readonly cancelRename: () => void;
    readonly collapsedSessionIds: ReadonlySet<string>;
    readonly collapseEnabled: boolean;
    readonly commitRename: () => void;
    readonly groups: readonly AiSessionHierarchyGroup<SidebarAgentSessionSummary>[];
    readonly onContextMenu: (
        event: ReactMouseEvent,
        session: SidebarAgentSessionSummary,
    ) => void;
    readonly onDragCancel?: (session: SidebarAgentSessionSummary) => void;
    readonly onDragEnd?: (
        session: SidebarAgentSessionSummary,
        coordinates: SidebarAgentDragCoordinates,
    ) => boolean;
    readonly onDragMove?: (
        session: SidebarAgentSessionSummary,
        coordinates: SidebarAgentDragCoordinates,
    ) => void;
    readonly onDragStart?: (
        session: SidebarAgentSessionSummary,
        coordinates: SidebarAgentDragCoordinates,
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
                                activityStatus={activityStatusBySessionId.get(
                                    row.session.sessionId,
                                )}
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
                                onDragCancel={() =>
                                    onDragCancel?.(row.session)
                                }
                                onDragEnd={(coordinates) =>
                                    onDragEnd?.(row.session, coordinates) ??
                                    false
                                }
                                onDragMove={(coordinates) =>
                                    onDragMove?.(row.session, coordinates)
                                }
                                onDragStart={(coordinates) =>
                                    onDragStart?.(row.session, coordinates)
                                }
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
    activityStatus,
    depth,
    hasChildren,
    isActive,
    isCollapsed,
    isRenaming,
    isSubagent,
    onCancelRename,
    onCommitRename,
    onContextMenu,
    onDragCancel,
    onDragEnd,
    onDragMove,
    onDragStart,
    onOpen,
    onRenameDraftChange,
    onToggleCollapsed,
    onTogglePinned,
    renameDraft,
    session,
}: {
    readonly activityStatus: AiSessionStatus | null | undefined;
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
    readonly onDragCancel?: () => void;
    readonly onDragEnd?: (coordinates: SidebarAgentDragCoordinates) => boolean;
    readonly onDragMove?: (coordinates: SidebarAgentDragCoordinates) => void;
    readonly onDragStart?: (coordinates: SidebarAgentDragCoordinates) => void;
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
    const onDragCancelRef = useRef(onDragCancel);
    onDragCancelRef.current = onDragCancel;
    const [dragPreview, setDragPreview] =
        useState<SidebarAgentDragPreview | null>(null);
    const [isPointerTracking, setIsPointerTracking] = useState(false);
    const title = session.title.trim();
    const isPinned = isSessionPinned(session);
    const isTerminalAgent = isClaudeCodeSidebarSession(session);
    const canOpenInPane = !isTerminalAgent;
    const activityState = useAgentActivityIndicator(
        session.sessionId,
        activityStatus,
    );
    const activity = activityState?.indicator ?? null;
    const indentStyle =
        depth > 0
            ? { paddingLeft: `${8 + Math.min(depth, 4) * 14}px` }
            : undefined;

    const emitDrag = useCallback(
        (
            phase: "cancel" | "end" | "move" | "start",
            event?: Pick<ReactPointerEvent<HTMLElement>, "clientX" | "clientY">,
        ) => {
            if (!canOpenInPane) {
                return;
            }
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
        [canOpenInPane, session],
    );

    const updateDragPreview = useCallback(
        (event: Pick<ReactPointerEvent<HTMLElement>, "clientX" | "clientY">) => {
            setDragPreview({
                activity,
                canOpenInPane,
                runtimeLabel: getSidebarAgentRuntimeLabel(session),
                title: session.title,
                x: event.clientX,
                y: event.clientY,
            });
        },
        [activity, canOpenInPane, session],
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
                onDragCancelRef.current?.();
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
                    onDragStart?.({
                        clientX: event.clientX,
                        clientY: event.clientY,
                    });
                    emitDrag("start", event);
                } else {
                    updateDragPreview(event);
                    onDragMove?.({
                        clientX: event.clientX,
                        clientY: event.clientY,
                    });
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
                const consumed =
                    onDragEnd?.({
                        clientX: event.clientX,
                        clientY: event.clientY,
                    }) ?? false;
                emitDrag(consumed ? "cancel" : "end", event);
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
                <span className="sidebar-agents-provider-slot flex shrink-0 items-center justify-center text-text-secondary">
                    <ProviderIcon
                        className="sidebar-agents-provider-icon block"
                        opacity={0.68}
                        runtimeId={
                            isTerminalAgent
                                ? "claude"
                                : (session.runtimeId as AiRuntimeId)
                        }
                        size={13}
                    />
                </span>
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
                {activityState ? (
                    <SidebarAgentActivityLabel
                        indicator={activityState.indicator}
                        label={activityState.label}
                    />
                ) : isRenaming ? null : (
                    <span className="sidebar-agents-compact-relative-time shrink-0 text-[10px] text-text-secondary">
                        {formatHistoryRelativeDateCompact(session.updatedAt)}
                    </span>
                )}
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
                            {preview.canOpenInPane
                                ? "Drag to a folder or pane"
                                : "Drag to a folder"}{" "}
                            · {preview.runtimeLabel}
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

function getSidebarAgentInternalDropTargetAtPoint(
    clientX: number,
    clientY: number,
): SidebarAgentInternalDropTarget {
    if (
        typeof document === "undefined" ||
        typeof document.elementFromPoint !== "function"
    ) {
        return null;
    }

    const target = document.elementFromPoint(clientX, clientY);
    if (!(target instanceof Element)) {
        return null;
    }
    const folderId = target.closest<HTMLElement>("[data-agent-folder-id]")
        ?.dataset.agentFolderId;
    if (folderId) {
        return { folderId, kind: "folder" };
    }
    return target.closest("[data-agent-unfiled-drop-zone]")
        ? { kind: "unfiled" }
        : null;
}

function useAgentActivityIndicator(
    sessionId: string,
    liveStatus: AiSessionStatus | null | undefined,
): SidebarAgentActivity {
    const localError = useAiStore(
        (state) => state.sessions[sessionId]?.localError ?? null,
    );
    const storedStatus = useAiStore(
        (state) => state.sessions[sessionId]?.snapshot?.status ?? null,
    );
    const status = liveStatus ?? storedStatus;
    return useMemo(
        () => {
            const indicator = resolveWorkspaceChatTabActivityIndicator({
                localError,
                snapshot: status ? { status } : null,
            });
            if (!indicator) {
                return null;
            }

            const label =
                indicator.tone === "danger"
                    ? "Error"
                    : status === "waiting_permission"
                      ? "Waiting permission…"
                      : status === "waiting_user_input"
                        ? "Waiting input…"
                        : "Working…";
            return { indicator, label };
        },
        [localError, status],
    );
}

function SidebarAgentActivityLabel({
    indicator,
    label,
}: {
    readonly indicator: NonNullable<WorkspaceChatTabActivityIndicator>;
    readonly label: string;
}) {
    return (
        <span
            className="sidebar-agents-activity-label shrink-0"
            data-tone={indicator.tone}
            title={indicator.title}
        >
            {label}
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

function NewFolderIcon() {
    return (
        <svg
            aria-hidden="true"
            fill="none"
            height="14"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.7"
            viewBox="0 0 24 24"
            width="14"
        >
            <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2.5h6.5A2.5 2.5 0 0 1 21 10v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
            <path d="M12 11v5M9.5 13.5h5" />
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
    liveStatus: AiSessionStatus | null | undefined,
): boolean {
    if (!entry && liveStatus === undefined) {
        return false;
    }
    const indicator = resolveWorkspaceChatTabActivityIndicator({
        localError: entry?.localError ?? null,
        snapshot: (liveStatus ?? entry?.snapshot?.status)
            ? { status: liveStatus ?? entry?.snapshot?.status ?? "idle" }
            : null,
    });
    return indicator?.tone === "working";
}

function isSessionPinned(session: SidebarAgentSessionSummary): boolean {
    return (session.pinnedAt ?? null) !== null;
}

function getSidebarAgentRuntimeLabel(session: SidebarAgentSessionSummary): string {
    return session.runtimeId === CLAUDE_CODE_TERMINAL_RUNTIME_ID
        ? "Claude Code"
        : getHistoryRuntimeLabel(
              session.runtimeId,
              session.runtimeDisplayName,
          );
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
