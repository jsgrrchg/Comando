import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type PointerEvent as ReactPointerEvent,
    type ReactNode,
    type RefCallback,
    type RefObject,
    type UIEventHandler,
} from "react";

import type {
    AiHistorySessionSummary,
    AiImageAttachment,
    AiMessage,
    AiSessionSnapshot,
    AiSessionStatus,
    AiToolCardExpansionMode,
} from "@shared/ipc";
import {
    CHAT_TITLE_HISTORY_MAX_CHARS,
    truncateChatTitle,
} from "@shared/chatTitle";

import { useAiChatSettings } from "@renderer/app/hooks/use-ai-chat-settings";
import { getGitContextKey } from "@renderer/app/git/context-key";
import { buildChatFontFamily } from "@renderer/app/settings/theme";
import { useGitStore } from "@renderer/app/store/git-store";
import { useFileReferenceValidator } from "@renderer/app/store/projectFileIndexStore";
import { useProjectsStore } from "@renderer/app/store/projects-store";
import { useWorkspaceStore } from "@renderer/app/store/workspace-store";
import type {
    RuntimeWorkspaceChatHistoryTab,
    RuntimeWorkspaceFileOpenLocation,
    RuntimeWorkspaceFileReviewContext,
} from "@renderer/app/workspace/tree";

import {
    IdeActionButton,
    IdeBarDotSeparator,
    IdeBarHeader,
    IdeBarLabel,
    IdeBarSearchIcon as SearchIcon,
    IdeIconButton,
} from "./ide-bar";
import { ChatContentColumn } from "./chat/ChatContentColumn";
import { ChatMessageRow } from "./chat/ChatMessageRow";
import { PlanMessage } from "./chat/PlanMessage";
import { ToolActivityItem } from "./chat/ToolActivityItem";
import {
    reconcileChatTimelineModel,
    type ChatTimelineRow,
} from "./chat/chatTimelineModel";
import {
    collectProjectFileRoots,
    resolveProjectFileReference,
    type ResolvedProjectFileReference,
} from "./projectFileReferences";
import {
    formatHistoryMessageCount,
    formatHistoryRelativeDate,
    formatHistoryScope,
    getHistoryRuntimeLabel,
} from "./chat-history/historyPresentation";
import { getHistoryPreviewText } from "./chat-history/historyPreview";
import {
    buildAiSessionHierarchyGroups,
    countAiHistorySessionChildren,
    findAiHistorySessionParent,
    isAiHistorySessionChildOfParent,
} from "./chat-history/sessionHierarchy";
import { usePersistedWorkspaceScroll } from "./usePersistedWorkspaceScroll";

const HISTORY_PAGE_SIZE = 100;
const EMPTY_MESSAGES: readonly AiMessage[] = [];
const DEFAULT_HISTORY_SIDEBAR_WIDTH = 280;
const MIN_HISTORY_SIDEBAR_WIDTH = 200;
const MAX_HISTORY_SIDEBAR_WIDTH = 520;
const MIN_HISTORY_DETAIL_PANE_WIDTH = 360;

function getOpenLocationFromResolvedFileReference(
    reference: ResolvedProjectFileReference,
): RuntimeWorkspaceFileOpenLocation | null {
    if (reference.startLine === null) {
        return null;
    }

    return {
        endLine: reference.endLine,
        startLine: reference.startLine,
    };
}

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
    readonly canRenderFileReference?: (
        rawReference: string,
        reference: ResolvedProjectFileReference,
    ) => boolean;
    readonly chatFontFamily?: string;
    readonly chatFontSize?: number;
    readonly toolCardExpansionMode?: AiToolCardExpansionMode;
    readonly isSidebarCollapsed?: boolean;
    readonly historyScrollRef?: RefCallback<HTMLDivElement>;
    readonly transcriptScrollRef?: RefCallback<HTMLDivElement>;
    readonly onSearchQueryChange?: (value: string) => void;
    readonly onHistoryScroll?: UIEventHandler<HTMLDivElement>;
    readonly onTranscriptScroll?: UIEventHandler<HTMLDivElement>;
    readonly onToggleSidebar?: () => void;
    readonly searchQuery?: string;
    readonly totalSessionsCount?: number;
    readonly onSidebarResizePointerDown?: (
        event: ReactPointerEvent<HTMLDivElement>,
    ) => void;
    readonly sidebarWidth?: number;
    readonly splitContainerRef?: RefObject<HTMLDivElement | null>;
    readonly handleOpenFile?: (
        projectId: string,
        relativePath: string,
        worktreeId?: string | null,
        reviewContext?: RuntimeWorkspaceFileReviewContext | null,
        openLocation?: RuntimeWorkspaceFileOpenLocation | null,
    ) => Promise<void>;
    readonly handleOpenImage?: (
        attachment: AiImageAttachment,
    ) => Promise<void>;
    readonly handleOpenResolvedFileReference?: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly handleOpenSessionById?: (sessionId: string) => Promise<void>;
    readonly hasMoreMessages: boolean;
    readonly isBusy: boolean;
    readonly isLoadingSessions: boolean;
    readonly loadSessionSnapshot: (sessionId: string, reset?: boolean) => Promise<void>;
    readonly loadTranscriptPage: (sessionId: string, reset?: boolean) => Promise<void>;
    readonly handleDelete: (session: AiHistorySessionSummary) => Promise<void>;
    readonly handleOpenInChat: (session: AiHistorySessionSummary) => Promise<void>;
    readonly handleRefresh: () => Promise<void>;
    readonly handleRename: (
        session: AiHistorySessionSummary,
        nextTitle: string,
    ) => Promise<void>;
    readonly mutatingSessionId: string | null;
    readonly resolveFileReference?: (
        reference: string,
    ) => ResolvedProjectFileReference | null;
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
    const openFileTab = useWorkspaceStore((state) => state.openFileTab);
    const openChatImageTab = useWorkspaceStore(
        (state) => state.openChatImageTab,
    );
    const updateSessionTabTitles = useWorkspaceStore(
        (state) => state.updateSessionTabTitles,
    );
    const tabsById = useWorkspaceStore((state) => state.tabsById);
    const projectSummary = useProjectsStore((state) =>
        tab.projectId
            ? (state.projects.find(
                  (project) => project.id === tab.projectId,
              ) ?? null)
            : null,
    );
    const projectName = projectSummary?.name;
    const gitSnapshot = useGitStore((state) => {
        if (!tab.projectId) {
            return null;
        }

        return (
            state.snapshots[
                getGitContextKey(tab.projectId, tab.worktreeId ?? null)
            ] ?? null
        );
    });
    const aiChatSettings = useAiChatSettings();
    const chatFontFamily = useMemo(
        () => buildChatFontFamily(aiChatSettings.chatFontFamily),
        [aiChatSettings.chatFontFamily],
    );
    const handleOpenFile = useCallback(
        async (
            projectId: string,
            relativePath: string,
            worktreeId?: string | null,
            reviewContext?: RuntimeWorkspaceFileReviewContext | null,
            openLocation?: RuntimeWorkspaceFileOpenLocation | null,
        ) => {
            await openFileTab(
                projectId,
                relativePath,
                worktreeId ?? null,
                reviewContext ?? null,
                undefined,
                undefined,
                openLocation ?? null,
            );
        },
        [openFileTab],
    );
    const handleOpenImage = useCallback(
        async (attachment: AiImageAttachment) => {
            await openChatImageTab({ attachment });
        },
        [openChatImageTab],
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
    const [sidebarWidth, setSidebarWidth] = useState(
        DEFAULT_HISTORY_SIDEBAR_WIDTH,
    );
    const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const splitContainerRef = useRef<HTMLDivElement | null>(null);
    const sidebarResizeCleanupRef = useRef<(() => void) | null>(null);
    const transcriptRequestIdsRef = useRef<Record<string, number>>({});
    const snapshotRequestIdsRef = useRef<Record<string, number>>({});
    const {
        handleScroll: handleHistoryScroll,
        scrollRef: historyScrollRef,
    } = usePersistedWorkspaceScroll<HTMLDivElement>({
        projectId: tab.projectId,
        surface: tab.kind,
        worktreeId: tab.worktreeId ?? null,
    });
    const {
        handleScroll: handleTranscriptScroll,
        scrollRef: transcriptScrollRef,
    } = usePersistedWorkspaceScroll<HTMLDivElement>({
        entityId: selectedSessionId,
        projectId: tab.projectId,
        surface: `${tab.kind}_transcript`,
        worktreeId: tab.worktreeId ?? null,
    });

    useEffect(() => {
        return () => {
            sidebarResizeCleanupRef.current?.();
        };
    }, []);

    const handleSidebarResizePointerDown = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            event.preventDefault();
            event.stopPropagation();

            sidebarResizeCleanupRef.current?.();

            const startX = event.clientX;
            const startWidth = sidebarWidth;
            const previousCursor = document.body.style.cursor;
            const previousUserSelect = document.body.style.userSelect;

            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";

            const handlePointerMove = (pointerEvent: PointerEvent) => {
                const containerWidth =
                    splitContainerRef.current?.getBoundingClientRect().width ??
                    0;
                if (containerWidth <= 0) {
                    return;
                }

                const delta = pointerEvent.clientX - startX;
                const maxWidth = Math.min(
                    MAX_HISTORY_SIDEBAR_WIDTH,
                    Math.max(
                        MIN_HISTORY_SIDEBAR_WIDTH,
                        containerWidth - MIN_HISTORY_DETAIL_PANE_WIDTH,
                    ),
                );

                setSidebarWidth(
                    Math.round(
                        clampSidebarWidth(
                            startWidth + delta,
                            MIN_HISTORY_SIDEBAR_WIDTH,
                            maxWidth,
                        ),
                    ),
                );
            };

            const cleanup = () => {
                document.body.style.cursor = previousCursor;
                document.body.style.userSelect = previousUserSelect;
                window.removeEventListener("pointermove", handlePointerMove);
                window.removeEventListener("pointerup", handlePointerUp);
                window.removeEventListener("pointercancel", handlePointerUp);
                sidebarResizeCleanupRef.current = null;
            };

            const handlePointerUp = () => {
                cleanup();
            };

            sidebarResizeCleanupRef.current = cleanup;

            window.addEventListener("pointermove", handlePointerMove);
            window.addEventListener("pointerup", handlePointerUp);
            window.addEventListener("pointercancel", handlePointerUp);
        },
        [sidebarWidth],
    );

    const toggleSidebarCollapsed = useCallback(() => {
        setIsSidebarCollapsed((current) => !current);
    }, []);

    const scopeLabel = projectName ?? tab.projectId ?? "No project";
    const worktreeLabel = formatHistoryScope(tab.worktreeId);
    const selectedSession =
        sessions.find((session) => session.sessionId === selectedSessionId) ??
        null;
    const selectedSessionWorktreeId =
        selectedSession?.worktreeId ?? tab.worktreeId ?? null;
    const transcriptProjectFileRoots = useMemo(() => {
        const activeWorktreeRootPath = selectedSessionWorktreeId
            ? (gitSnapshot?.worktrees.find(
                  (worktree) => worktree.id === selectedSessionWorktreeId,
              )?.rootPath ?? null)
            : (gitSnapshot?.worktrees.find((worktree) => worktree.isCurrent)
                  ?.rootPath ??
              gitSnapshot?.worktrees.find((worktree) => worktree.isPrimary)
                  ?.rootPath ??
              null);

        return collectProjectFileRoots({
            canonicalProjectRoot: projectSummary?.canonicalRootPath,
            currentWorktreeRoot: activeWorktreeRootPath,
            projectRoot: projectSummary?.rootPath,
            repositoryCanonicalRoot: gitSnapshot?.canonicalRootPath,
            repositoryRoot: gitSnapshot?.rootPath,
        });
    }, [
        gitSnapshot?.canonicalRootPath,
        gitSnapshot?.rootPath,
        gitSnapshot?.worktrees,
        projectSummary?.canonicalRootPath,
        projectSummary?.rootPath,
        selectedSessionWorktreeId,
    ]);
    const resolveChatFileReference = useCallback(
        (reference: string): ResolvedProjectFileReference | null => {
            if (!tab.projectId || transcriptProjectFileRoots.length === 0) {
                return null;
            }

            return resolveProjectFileReference(reference, {
                projectRoots: transcriptProjectFileRoots,
            });
        },
        [tab.projectId, transcriptProjectFileRoots],
    );
    const canRenderFileReference = useFileReferenceValidator(
        tab.projectId ?? null,
        selectedSessionWorktreeId,
    );
    const handleOpenResolvedFileReference = useCallback(
        (reference: ResolvedProjectFileReference) => {
            if (!tab.projectId) {
                return;
            }

            void openFileTab(
                tab.projectId,
                reference.relativePath,
                selectedSessionWorktreeId,
                null,
                undefined,
                undefined,
                getOpenLocationFromResolvedFileReference(reference),
            );
        },
        [openFileTab, selectedSessionWorktreeId, tab.projectId],
    );
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
                limit: null,
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
    const handleOpenSessionById = useCallback(
        async (sessionId: string) => {
            const session =
                sessions.find((candidate) => candidate.sessionId === sessionId) ??
                null;
            if (session) {
                await handleOpenInChat(session);
                return;
            }

            const snapshot = await getComandoApi().getAiSessionSnapshot(
                sessionId,
            );
            if (!snapshot) {
                return;
            }

            await openChatSessionTab({
                projectId: snapshot.projectId,
                runtimeId: snapshot.runtimeId,
                sessionId: snapshot.sessionId,
                title: snapshot.title,
                worktreeId: snapshot.worktreeId ?? null,
            });
        },
        [handleOpenInChat, openChatSessionTab, sessions],
    );

    const handleRename = useCallback(
        async (session: AiHistorySessionSummary, nextTitle: string) => {
            if (isSubagentSession(session)) {
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
            const childCount = countAiHistorySessionChildren(session, sessions);
            const confirmed = window.confirm(
                childCount > 0
                    ? `Delete "${session.title}" from chat history? ${childCount} child agent${childCount === 1 ? "" : "s"} will stay in history as detached. This cannot be undone.`
                    : `Delete "${session.title}" from chat history? This cannot be undone.`,
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
            const remainingSessions = sessions
                .filter((candidate) => candidate.sessionId !== session.sessionId)
                .map((candidate) =>
                    isAiHistorySessionChildOfParent(session, candidate)
                        ? { ...candidate, parentSessionId: null }
                        : candidate,
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
    const filteredSessions = useMemo(() => {
        const query = searchQuery.trim().toLowerCase();
        if (query.length === 0) {
            return sessions;
        }

        const matchingSessionIds = new Set(
            buildAiSessionHierarchyGroups(sessions, {
                filterQuery: query,
            }).flatMap((group) =>
                group.rows.map((row) => row.session.sessionId),
            ),
        );

        return sessions.filter((session) =>
            matchingSessionIds.has(session.sessionId),
        );
    }, [searchQuery, sessions]);

    return (
        <ChatHistoryTabLayout
            chatFontFamily={chatFontFamily}
            chatFontSize={aiChatSettings.chatFontSize}
            toolCardExpansionMode={aiChatSettings.toolCardExpansionMode}
            canRenderFileReference={canRenderFileReference}
            handleDelete={handleDelete}
            handleOpenFile={handleOpenFile}
            handleOpenImage={handleOpenImage}
            handleOpenInChat={handleOpenInChat}
            handleOpenResolvedFileReference={handleOpenResolvedFileReference}
            handleOpenSessionById={handleOpenSessionById}
            handleRefresh={handleRefresh}
            handleRename={handleRename}
            historyScrollRef={historyScrollRef}
            transcriptScrollRef={transcriptScrollRef}
            hasMoreMessages={hasMoreMessages}
            isBusy={isBusy}
            isLoadingSessions={isLoadingSessions}
            isSidebarCollapsed={isSidebarCollapsed}
            loadSessionSnapshot={loadSessionSnapshot}
            loadTranscriptPage={loadTranscriptPage}
            mutatingSessionId={mutatingSessionId}
            onHistoryScroll={handleHistoryScroll}
            onTranscriptScroll={handleTranscriptScroll}
            onSearchQueryChange={setSearchQuery}
            onSidebarResizePointerDown={handleSidebarResizePointerDown}
            onToggleSidebar={toggleSidebarCollapsed}
            resolveFileReference={resolveChatFileReference}
            scopeLabel={scopeLabel}
            searchQuery={searchQuery}
            selectedSession={selectedSession}
            selectedSessionId={selectedSessionId}
            selectedSnapshot={selectedSnapshot}
            selectedSnapshotState={selectedSnapshotState}
            selectedSnapshotStatus={selectedSnapshotStatus}
            selectedTranscript={selectedTranscript}
            sessions={filteredSessions}
            sessionsError={sessionsError}
            setSelectedSessionId={setSelectedSessionId}
            totalSessionsCount={sessions.length}
            sidebarWidth={sidebarWidth}
            splitContainerRef={splitContainerRef}
            tab={tab}
            transcriptMessages={transcriptMessages}
            worktreeLabel={worktreeLabel}
        />
    );
}

export function ChatHistoryTabLayout({
    canRenderFileReference,
    chatFontFamily,
    chatFontSize,
    toolCardExpansionMode = "collapsed",
    handleDelete,
    handleOpenFile,
    handleOpenImage,
    handleOpenInChat,
    handleOpenResolvedFileReference,
    handleOpenSessionById,
    handleRefresh,
    handleRename,
    historyScrollRef,
    transcriptScrollRef,
    hasMoreMessages,
    isBusy,
    isLoadingSessions,
    isSidebarCollapsed,
    loadSessionSnapshot,
    loadTranscriptPage,
    mutatingSessionId,
    onHistoryScroll,
    onTranscriptScroll,
    onSearchQueryChange,
    onSidebarResizePointerDown,
    onToggleSidebar,
    resolveFileReference,
    scopeLabel,
    searchQuery,
    selectedSession,
    selectedSessionId,
    selectedSnapshot,
    selectedSnapshotState,
    selectedSnapshotStatus,
    selectedTranscript,
    sessions,
    sessionsError,
    setSelectedSessionId,
    sidebarWidth,
    splitContainerRef,
    tab,
    totalSessionsCount,
    transcriptMessages,
    worktreeLabel,
}: ChatHistoryTabLayoutProps) {
    void tab;
    void scopeLabel;
    void worktreeLabel;
    const resolvedSearchQuery = searchQuery ?? "";
    const hasActiveSearch = resolvedSearchQuery.trim().length > 0;
    const resolvedTotalSessionsCount = totalSessionsCount ?? sessions.length;
    const statusLine = isLoadingSessions
        ? "Loading sessions..."
        : sessionsError
          ? sessionsError
          : hasActiveSearch
            ? `${sessions.length} of ${resolvedTotalSessionsCount}`
            : formatSessionCount(sessions.length);
    const resolvedSidebarCollapsed = isSidebarCollapsed ?? false;
    const resolvedSidebarWidth = sidebarWidth ?? DEFAULT_HISTORY_SIDEBAR_WIDTH;
    const [renamingSessionId, setRenamingSessionId] = useState<string | null>(
        null,
    );
    const [renameDraft, setRenameDraft] = useState("");
    const [isTranscriptSearchOpen, setIsTranscriptSearchOpen] = useState(false);
    const [transcriptSearchQuery, setTranscriptSearchQuery] = useState("");

    const openTranscriptSearch = useCallback(() => {
        setIsTranscriptSearchOpen(true);
    }, []);

    const closeTranscriptSearch = useCallback(() => {
        setIsTranscriptSearchOpen(false);
        setTranscriptSearchQuery("");
    }, []);

    useEffect(() => {
        if (!selectedSession) {
            let cancelled = false;
            queueMicrotask(() => {
                if (!cancelled) {
                    setIsTranscriptSearchOpen(false);
                    setTranscriptSearchQuery("");
                }
            });
            return () => {
                cancelled = true;
            };
        }
    }, [selectedSession]);

    const normalizedTranscriptSearch = transcriptSearchQuery.trim().toLowerCase();
    const hasActiveTranscriptSearch = normalizedTranscriptSearch.length > 0;
    const displayedTranscriptMessages = useMemo(() => {
        if (!hasActiveTranscriptSearch) {
            return transcriptMessages;
        }

        return transcriptMessages.filter((message) =>
            message.content
                .toLowerCase()
                .includes(normalizedTranscriptSearch),
        );
    }, [hasActiveTranscriptSearch, normalizedTranscriptSearch, transcriptMessages]);
    const displayedTranscriptCount = displayedTranscriptMessages.length;
    const displayedTranscriptTotal = hasActiveTranscriptSearch
        ? transcriptMessages.length
        : (selectedTranscript?.totalMessages ?? transcriptMessages.length);

    const startRename = useCallback(
        (session: AiHistorySessionSummary) => {
            if (isSubagentSession(session)) {
                return;
            }

            setSelectedSessionId(session.sessionId);
            setRenamingSessionId(session.sessionId);
            setRenameDraft(session.title);
        },
        [setSelectedSessionId],
    );

    const cancelRename = useCallback(() => {
        setRenamingSessionId(null);
        setRenameDraft("");
    }, []);

    const commitRename = useCallback(() => {
        if (!renamingSessionId) {
            return;
        }

        const session = sessions.find(
            (candidate) => candidate.sessionId === renamingSessionId,
        );
        const draftValue = renameDraft;

        setRenamingSessionId(null);
        setRenameDraft("");

        if (!session) {
            return;
        }

        void handleRename(session, draftValue);
    }, [handleRename, renameDraft, renamingSessionId, sessions]);
    const sessionGroups = useMemo(
        () => buildAiSessionHierarchyGroups(sessions),
        [sessions],
    );
    const selectedParentSession = selectedSession
        ? findAiHistorySessionParent(selectedSession, sessions)
        : null;

    return (
        <div className="flex h-full min-h-0 flex-col bg-bg-primary">
            <IdeBarHeader>
                <IdeBarLabel>Chat History</IdeBarLabel>
                <span
                    className={[
                        "shrink-0 truncate text-[10.5px]",
                        sessionsError
                            ? "text-[var(--diff-remove)]"
                            : "text-text-secondary",
                    ].join(" ")}
                >
                    {statusLine}
                </span>
                <div className="ml-auto flex shrink-0 items-center gap-1.5">
                    {onToggleSidebar ? (
                        <IdeActionButton
                            onClick={onToggleSidebar}
                            title={
                                resolvedSidebarCollapsed
                                    ? "Show sessions panel"
                                    : "Hide sessions panel"
                            }
                        >
                            {resolvedSidebarCollapsed ? "show list" : "hide list"}
                        </IdeActionButton>
                    ) : null}
                    <IdeActionButton onClick={() => void handleRefresh()}>
                        refresh
                    </IdeActionButton>
                </div>
            </IdeBarHeader>

            <div className="flex min-h-0 flex-1" ref={splitContainerRef}>
                {resolvedSidebarCollapsed ? null : (
                    <aside
                        className="flex min-h-0 shrink-0 flex-col border-r border-border"
                        style={{
                            minWidth: MIN_HISTORY_SIDEBAR_WIDTH,
                            width: resolvedSidebarWidth,
                        }}
                    >
                    {onSearchQueryChange ? (
                        <div
                            className="shrink-0 px-2 py-1.5"
                            style={{
                                borderBottom:
                                    "1px solid color-mix(in srgb, var(--color-border) 60%, transparent)",
                            }}
                        >
                            <div className="relative w-full">
                                <input
                                    aria-label="Filter chat history by name"
                                    className="w-full min-w-0 rounded-[3px] bg-transparent pl-6 pr-6 text-[11px] text-text-primary placeholder:text-text-secondary focus:bg-[color-mix(in_srgb,var(--color-bg-primary)_70%,transparent)] focus:outline-none"
                                    onChange={(event) =>
                                        onSearchQueryChange(event.target.value)
                                    }
                                    onKeyDown={(event) => {
                                        if (event.key === "Escape") {
                                            event.preventDefault();
                                            onSearchQueryChange("");
                                        }
                                    }}
                                    placeholder="Filter by name..."
                                    style={{
                                        border:
                                            "1px solid color-mix(in srgb, var(--color-border) 45%, transparent)",
                                        fontFamily: "var(--font-mono)",
                                        height: 22,
                                        lineHeight: "20px",
                                    }}
                                    type="text"
                                    value={resolvedSearchQuery}
                                />
                                <span
                                    aria-hidden="true"
                                    className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 text-text-secondary"
                                >
                                    <SearchIcon />
                                </span>
                                {hasActiveSearch ? (
                                    <button
                                        aria-label="Clear filter"
                                        className="absolute right-1 top-1/2 -translate-y-1/2 rounded px-1 text-[10px] text-text-secondary transition-colors hover:text-text-primary"
                                        onClick={() =>
                                            onSearchQueryChange("")
                                        }
                                        type="button"
                                    >
                                        ×
                                    </button>
                                ) : null}
                            </div>
                        </div>
                    ) : null}
                    <div
                        className="shell-scrollbar min-h-0 flex-1 overflow-y-auto p-2"
                        onScroll={onHistoryScroll}
                        ref={historyScrollRef}
                    >
                        {isLoadingSessions && sessions.length === 0 ? (
                            <HistoryPlaceholder body="Loading history..." />
                        ) : null}

                        {!isLoadingSessions &&
                        !sessionsError &&
                        sessions.length === 0 ? (
                            <HistoryPlaceholder
                                body={
                                    hasActiveSearch
                                        ? `No sessions match "${resolvedSearchQuery.trim()}".`
                                        : "No chat history yet. Conversations in this scope will appear here."
                                }
                            />
                        ) : null}

                        {sessionsError && sessions.length === 0 ? (
                            <HistoryPlaceholder
                                body={sessionsError}
                                title="Could not load history"
                            />
                        ) : null}

                        {sessions.length > 0 ? (
                            <div className="flex flex-col">
                                {sessionGroups.flatMap((group) =>
                                    group.rows.map((row) => {
                                    const session = row.session;
                                    const isSubagent = row.isSubagent;
                                    const isSelected =
                                        session.sessionId === selectedSessionId;
                                    const isSessionBusy =
                                        mutatingSessionId ===
                                        session.sessionId;

                                    const isRenaming =
                                        renamingSessionId === session.sessionId;

                                    return (
                                        <div
                                            className={[
                                                "group relative flex flex-col border-l-2 transition-colors",
                                                isSelected
                                                    ? "border-accent bg-bg-secondary"
                                                    : "border-transparent hover:bg-bg-secondary",
                                                row.depth > 0 ? "ml-3" : "",
                                            ].join(" ")}
                                            key={session.sessionId}
                                            data-subagent={
                                                isSubagent ? "true" : "false"
                                            }
                                        >
                                            <div
                                                className="flex w-full cursor-pointer flex-col items-start gap-0.5 px-2.5 py-1.5 text-left"
                                                onClick={() => {
                                                    if (isRenaming) {
                                                        return;
                                                    }
                                                    setSelectedSessionId(
                                                        session.sessionId,
                                                    );
                                                }}
                                                onKeyDown={(event) => {
                                                    if (isRenaming) {
                                                        return;
                                                    }
                                                    if (
                                                        event.key === "Enter" ||
                                                        event.key === " "
                                                    ) {
                                                        event.preventDefault();
                                                        setSelectedSessionId(
                                                            session.sessionId,
                                                        );
                                                    }
                                                }}
                                                role="button"
                                                tabIndex={isRenaming ? -1 : 0}
                                            >
                                                <div className="flex w-full min-w-0 items-center gap-2">
                                                    {isRenaming ? (
                                                        <input
                                                            autoFocus
                                                            className="min-w-0 flex-1 rounded border border-border-strong bg-bg-primary px-1.5 py-0.5 text-[11.5px] font-medium text-text-primary outline-none focus:border-accent"
                                                            onBlur={commitRename}
                                                            onChange={(event) =>
                                                                setRenameDraft(
                                                                    event.target
                                                                        .value,
                                                                )
                                                            }
                                                            onClick={(event) =>
                                                                event.stopPropagation()
                                                            }
                                                            onKeyDown={(
                                                                event,
                                                            ) => {
                                                                event.stopPropagation();
                                                                if (
                                                                    event.key ===
                                                                    "Enter"
                                                                ) {
                                                                    event.preventDefault();
                                                                    commitRename();
                                                                } else if (
                                                                    event.key ===
                                                                    "Escape"
                                                                ) {
                                                                    event.preventDefault();
                                                                    cancelRename();
                                                                }
                                                            }}
                                                            type="text"
                                                            value={renameDraft}
                                                        />
                                                    ) : (
                                                        <span
                                                            className="truncate text-[11.5px] font-medium text-text-primary"
                                                            title={session.title}
                                                        >
                                                            {truncateChatTitle(
                                                                session.title,
                                                                CHAT_TITLE_HISTORY_MAX_CHARS,
                                                            )}
                                                        </span>
                                                    )}
                                                    {isRenaming ? null : (
                                                        <span className="ml-auto shrink-0 text-[10px] text-text-secondary">
                                                            {formatHistoryRelativeDate(
                                                                session.updatedAt,
                                                            )}
                                                        </span>
                                                    )}
                                                </div>
                                                <p className="line-clamp-1 w-full text-[10.5px] leading-[1.35] text-text-secondary">
                                                    {getHistoryPreviewText(
                                                        session,
                                                    )}
                                                </p>
                                                <div className="flex w-full min-w-0 items-center gap-1.5 text-[10px] text-text-secondary">
                                                    {isSubagent ? (
                                                        <>
                                                            <span className="shrink-0 rounded-[3px] border border-border/70 px-1 text-[8.5px] font-medium uppercase tracking-[0.08em]">
                                                                Agent
                                                            </span>
                                                            <span
                                                                aria-hidden="true"
                                                                className="shrink-0"
                                                            >
                                                                ·
                                                            </span>
                                                        </>
                                                    ) : null}
                                                    <span className="shrink-0">
                                                        {getHistoryRuntimeLabel(
                                                            session.runtimeId,
                                                        )}
                                                    </span>
                                                    <span
                                                        aria-hidden="true"
                                                        className="shrink-0"
                                                    >
                                                        ·
                                                    </span>
                                                    <span className="shrink-0">
                                                        {formatHistoryMessageCount(
                                                            session.messageCount,
                                                        )}
                                                    </span>
                                                </div>
                                            </div>
                                            {isRenaming ? null : (
                                                <div
                                                    className={[
                                                        "pointer-events-none absolute right-1.5 bottom-1 flex items-center gap-0.5 transition-opacity",
                                                        isSelected
                                                            ? "opacity-100"
                                                            : "opacity-0 group-hover:opacity-100",
                                                    ].join(" ")}
                                                    style={{
                                                        background: isSelected
                                                            ? "var(--color-bg-secondary)"
                                                            : "color-mix(in srgb, var(--color-bg-secondary) 92%, transparent)",
                                                        borderRadius: 3,
                                                    }}
                                                >
                                                    <button
                                                        className={
                                                            CARD_ACTION_CLASS_NAME +
                                                            " pointer-events-auto"
                                                        }
                                                        disabled={
                                                            isSessionBusy
                                                        }
                                                        onClick={() =>
                                                            void handleOpenInChat(
                                                                session,
                                                            )
                                                        }
                                                        type="button"
                                                    >
                                                        open
                                                    </button>
                                                    {isSubagent ? null : (
                                                        <button
                                                            className={
                                                                CARD_ACTION_CLASS_NAME +
                                                                " pointer-events-auto"
                                                            }
                                                            disabled={
                                                                isSessionBusy
                                                            }
                                                            onClick={() =>
                                                                startRename(
                                                                    session,
                                                                )
                                                            }
                                                            type="button"
                                                        >
                                                            rename
                                                        </button>
                                                    )}
                                                    <button
                                                        className={
                                                            CARD_ACTION_DANGER_CLASS_NAME +
                                                            " pointer-events-auto"
                                                        }
                                                        disabled={
                                                            isSessionBusy
                                                        }
                                                        onClick={() =>
                                                            void handleDelete(
                                                                session,
                                                            )
                                                        }
                                                        type="button"
                                                    >
                                                        delete
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    );
                                }),
                                )}
                            </div>
                        ) : null}
                    </div>
                </aside>
                )}

                {resolvedSidebarCollapsed || !onSidebarResizePointerDown ? null : (
                    <div
                        aria-label="Resize sessions panel"
                        aria-orientation="vertical"
                        className="group relative z-10 flex w-1.5 shrink-0 cursor-col-resize touch-none items-center justify-center bg-transparent"
                        onPointerDown={onSidebarResizePointerDown}
                        role="separator"
                        title="Drag to resize"
                    >
                        <div className="workspace-divider h-full w-px bg-border transition-colors duration-100 group-hover:bg-accent" />
                    </div>
                )}

                <section className="flex min-h-0 min-w-0 flex-1 flex-col">
                    {selectedSession ? (
                        <>
                            <IdeBarHeader>
                                <span
                                    className="min-w-0 truncate text-[11.5px] font-medium text-text-primary"
                                    title={selectedSession.title}
                                >
                                    {selectedSession.title}
                                </span>
                                <div className="flex min-w-0 items-center gap-1.5 text-[10.5px] text-text-secondary">
                                    <span className="shrink-0">
                                        {getHistoryRuntimeLabel(
                                            selectedSession.runtimeId,
                                        )}
                                    </span>
                                    {isSubagentSession(selectedSession) ? (
                                        <>
                                            <IdeBarDotSeparator />
                                            {selectedParentSession ? (
                                                <button
                                                    className="shrink min-w-0 truncate rounded px-1 text-left transition-colors hover:bg-bg-elevated hover:text-text-primary"
                                                    onClick={() =>
                                                        setSelectedSessionId(
                                                            selectedParentSession.sessionId,
                                                        )
                                                    }
                                                    title={`Select parent ${selectedParentSession.title}`}
                                                    type="button"
                                                >
                                                    Subagent of{" "}
                                                    {
                                                        selectedParentSession.title
                                                    }
                                                </button>
                                            ) : (
                                                <span className="shrink-0">
                                                    Detached agent
                                                </span>
                                            )}
                                        </>
                                    ) : null}
                                    {selectedSnapshotStatus ? (
                                        <>
                                            <IdeBarDotSeparator />
                                            <span className="shrink-0">
                                                {formatSessionStatus(
                                                    selectedSnapshotStatus,
                                                )}
                                            </span>
                                        </>
                                    ) : null}
                                    <IdeBarDotSeparator />
                                    <span className="shrink-0">
                                        {formatHistoryRelativeDate(
                                            selectedSession.updatedAt,
                                        )}
                                    </span>
                                    <IdeBarDotSeparator />
                                    <span className="shrink-0">
                                        {formatHistoryMessageCount(
                                            selectedSession.messageCount,
                                        )}
                                    </span>
                                    {selectedSnapshotState?.isLoading ? (
                                        <>
                                            <IdeBarDotSeparator />
                                            <span className="shrink-0">
                                                Loading...
                                            </span>
                                        </>
                                    ) : null}
                                    {selectedSnapshotState?.error ? (
                                        <>
                                            <IdeBarDotSeparator />
                                            <span className="shrink-0 truncate text-[var(--diff-remove)]">
                                                {selectedSnapshotState.error}
                                            </span>
                                        </>
                                    ) : null}
                                </div>
                                <div className="ml-auto flex shrink-0 items-center gap-1.5">
                                    {isTranscriptSearchOpen ? (
                                        <div className="relative min-w-0 w-[220px]">
                                            <input
                                                aria-label="Search inside chat"
                                                autoFocus
                                                className="w-full min-w-0 rounded-[3px] bg-transparent pl-6 pr-6 text-[11px] text-text-primary placeholder:text-text-secondary focus:bg-[color-mix(in_srgb,var(--color-bg-primary)_70%,transparent)] focus:outline-none"
                                                onChange={(event) =>
                                                    setTranscriptSearchQuery(
                                                        event.target.value,
                                                    )
                                                }
                                                onKeyDown={(event) => {
                                                    if (event.key === "Escape") {
                                                        event.preventDefault();
                                                        closeTranscriptSearch();
                                                    }
                                                }}
                                                placeholder="Search in chat..."
                                                style={{
                                                    border:
                                                        "1px solid color-mix(in srgb, var(--color-border) 45%, transparent)",
                                                    fontFamily:
                                                        "var(--font-mono)",
                                                    height: 22,
                                                    lineHeight: "20px",
                                                }}
                                                type="text"
                                                value={transcriptSearchQuery}
                                            />
                                            <span
                                                aria-hidden="true"
                                                className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 text-text-secondary"
                                            >
                                                <SearchIcon />
                                            </span>
                                            <button
                                                aria-label="Close search"
                                                className="absolute right-1 top-1/2 -translate-y-1/2 rounded px-1 text-[10px] text-text-secondary transition-colors hover:text-text-primary"
                                                onClick={closeTranscriptSearch}
                                                type="button"
                                            >
                                                ×
                                            </button>
                                        </div>
                                    ) : (
                                        <IdeIconButton
                                            aria-label="Search inside chat"
                                            onClick={openTranscriptSearch}
                                            title="Search in chat"
                                        >
                                            <SearchIcon />
                                        </IdeIconButton>
                                    )}
                                    <IdeActionButton
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
                                    >
                                        reload
                                    </IdeActionButton>
                                    <IdeActionButton
                                        onClick={() =>
                                            void handleOpenInChat(
                                                selectedSession,
                                            )
                                        }
                                    >
                                        open in chat
                                    </IdeActionButton>
                                </div>
                            </IdeBarHeader>

                            {selectedSnapshot?.plan ? (
                                <div
                                    className="shrink-0 px-3 pb-1 pt-2"
                                    style={{
                                        borderBottom:
                                            "1px solid color-mix(in srgb, var(--color-border) 60%, transparent)",
                                    }}
                                >
                                    <ChatContentColumn>
                                        <PlanMessage
                                            plan={selectedSnapshot.plan}
                                        />
                                    </ChatContentColumn>
                                </div>
                            ) : null}

                            <div
                                className="shell-scrollbar min-h-0 flex-1 overflow-y-auto px-3 py-3"
                                onScroll={onTranscriptScroll}
                                ref={transcriptScrollRef}
                            >
                                {selectedTranscript?.isLoading &&
                                transcriptMessages.length === 0 ? (
                                    <HistoryPlaceholder body="Loading transcript..." />
                                ) : null}

                                {selectedTranscript?.error &&
                                transcriptMessages.length === 0 ? (
                                    <HistoryPlaceholder
                                        action={
                                            <IdeActionButton
                                                onClick={() =>
                                                    void loadTranscriptPage(
                                                        selectedSession.sessionId,
                                                        true,
                                                    )
                                                }
                                            >
                                                retry
                                            </IdeActionButton>
                                        }
                                        body={selectedTranscript.error}
                                        title="Could not load transcript"
                                    />
                                ) : null}

                                {!selectedTranscript?.isLoading &&
                                !selectedTranscript?.error &&
                                transcriptMessages.length === 0 ? (
                                    <HistoryPlaceholder body="No transcript messages were persisted for this session." />
                                ) : null}

                                {transcriptMessages.length > 0 &&
                                hasActiveTranscriptSearch &&
                                displayedTranscriptCount === 0 ? (
                                    <HistoryPlaceholder
                                        body={`No messages contain "${transcriptSearchQuery.trim()}".`}
                                    />
                                ) : null}

                                {transcriptMessages.length > 0 &&
                                (!hasActiveTranscriptSearch ||
                                    displayedTranscriptCount > 0) ? (
                                    <div
                                        className="min-w-0 space-y-2"
                                        style={{ fontFamily: chatFontFamily }}
                                    >
                                        <HistoryTranscriptTimeline
                                            canRenderFileReference={
                                                canRenderFileReference
                                            }
                                            chatFontFamily={chatFontFamily}
                                            chatFontSize={chatFontSize}
                                            highlightQuery={
                                                hasActiveTranscriptSearch
                                                    ? transcriptSearchQuery
                                                    : undefined
                                            }
                                            onOpenFile={handleOpenFile}
                                            onOpenImage={handleOpenImage}
                                            onOpenResolvedFileReference={
                                                handleOpenResolvedFileReference
                                            }
                                            onOpenSession={
                                                handleOpenSessionById
                                            }
                                            projectId={
                                                selectedSession.projectId
                                            }
                                            resolveFileReference={
                                                resolveFileReference
                                            }
                                            snapshot={
                                                hasActiveTranscriptSearch
                                                    ? null
                                                    : selectedSnapshot
                                            }
                                            transcriptMessages={
                                                displayedTranscriptMessages
                                            }
                                            toolCardExpansionMode={
                                                toolCardExpansionMode
                                            }
                                            worktreeId={
                                                selectedSession.worktreeId ??
                                                null
                                            }
                                        />

                                        <div className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-3 text-[11px] text-text-secondary">
                                            <span>
                                                {selectedTranscript
                                                    ?.isLoading &&
                                                transcriptMessages.length > 0
                                                    ? "Loading more..."
                                                    : hasActiveTranscriptSearch
                                                      ? `${displayedTranscriptCount} of ${displayedTranscriptTotal} messages match`
                                                      : `${displayedTranscriptCount} of ${displayedTranscriptTotal} messages`}
                                            </span>
                                            {hasMoreMessages &&
                                            !hasActiveTranscriptSearch ? (
                                                <IdeActionButton
                                                    disabled={
                                                        selectedTranscript?.isLoading
                                                    }
                                                    onClick={() =>
                                                        void loadTranscriptPage(
                                                            selectedSession.sessionId,
                                                        )
                                                    }
                                                >
                                                    Load More
                                                </IdeActionButton>
                                            ) : null}
                                        </div>

                                        {selectedTranscript?.error &&
                                        transcriptMessages.length > 0 ? (
                                            <p className="text-[11px] text-[var(--diff-remove)]">
                                                {selectedTranscript.error}
                                            </p>
                                        ) : null}
                                    </div>
                                ) : null}
                            </div>
                        </>
                    ) : (
                        <div className="flex min-h-0 flex-1 items-center justify-center px-6">
                            <HistoryPlaceholder body="Select a conversation on the left to inspect its transcript." />
                        </div>
                    )}
                </section>
            </div>

            {isBusy ? (
                <div className="border-t border-border px-5 py-2 text-[11px] text-text-secondary">
                    Applying history changes...
                </div>
            ) : null}
        </div>
    );
}

const NOOP_OPEN_FILE = (
    ...args: [
        string,
        string,
        (string | null | undefined)?,
        (RuntimeWorkspaceFileReviewContext | null | undefined)?,
        (RuntimeWorkspaceFileOpenLocation | null | undefined)?,
    ]
) => {
    void args;
    return Promise.resolve();
};
const NOOP_OPEN_IMAGE = (...args: [AiImageAttachment]) => {
    void args;
    return Promise.resolve();
};
const NOOP_OPEN_FILE_REFERENCE = (
    ...args: [ResolvedProjectFileReference]
) => {
    void args;
};
const NOOP_OPEN_SESSION = (...args: [string]) => {
    void args;
    return Promise.resolve();
};
const NOOP_RESOLVE_FILE_REFERENCE = (
    ...args: [string]
): ResolvedProjectFileReference | null => {
    void args;
    return null;
};

interface HistoryTimelineHandlers {
    readonly canRenderFileReference?: (
        rawReference: string,
        reference: ResolvedProjectFileReference,
    ) => boolean;
    readonly chatFontFamily?: string;
    readonly chatFontSize?: number;
    readonly highlightQuery?: string;
    readonly toolCardExpansionMode: AiToolCardExpansionMode;
    readonly onOpenFile: (
        projectId: string,
        relativePath: string,
        worktreeId?: string | null,
        reviewContext?: RuntimeWorkspaceFileReviewContext | null,
        openLocation?: RuntimeWorkspaceFileOpenLocation | null,
    ) => Promise<void>;
    readonly onOpenImage: (attachment: AiImageAttachment) => Promise<void>;
    readonly onOpenResolvedFileReference: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly onOpenSession: (sessionId: string) => Promise<void> | void;
    readonly resolveFileReference: (
        reference: string,
    ) => ResolvedProjectFileReference | null;
}

function HistoryTranscriptTimeline({
    canRenderFileReference,
    chatFontFamily,
    chatFontSize,
    highlightQuery,
    onOpenFile,
    onOpenImage,
    onOpenResolvedFileReference,
    onOpenSession,
    projectId,
    resolveFileReference,
    snapshot,
    toolCardExpansionMode,
    transcriptMessages,
    worktreeId,
}: {
    readonly canRenderFileReference?: (
        rawReference: string,
        reference: ResolvedProjectFileReference,
    ) => boolean;
    readonly chatFontFamily?: string;
    readonly chatFontSize?: number;
    readonly highlightQuery?: string;
    readonly onOpenFile?: (
        projectId: string,
        relativePath: string,
        worktreeId?: string | null,
        reviewContext?: RuntimeWorkspaceFileReviewContext | null,
        openLocation?: RuntimeWorkspaceFileOpenLocation | null,
    ) => Promise<void>;
    readonly onOpenImage?: (attachment: AiImageAttachment) => Promise<void>;
    readonly onOpenResolvedFileReference?: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly onOpenSession?: (sessionId: string) => Promise<void> | void;
    readonly projectId: string | null;
    readonly resolveFileReference?: (
        reference: string,
    ) => ResolvedProjectFileReference | null;
    readonly snapshot: AiSessionSnapshot | null;
    readonly toolCardExpansionMode: AiToolCardExpansionMode;
    readonly transcriptMessages: readonly AiMessage[];
    readonly worktreeId: string | null;
}) {
    const timelineRows = useMemo(() => {
        const model = reconcileChatTimelineModel(null, {
            messages: transcriptMessages,
            status: "idle",
            toolActivity: snapshot?.toolActivity ?? [],
            trackedFiles: snapshot?.trackedFiles ?? [],
        });
        return model.orderedRows;
    }, [
        snapshot?.toolActivity,
        snapshot?.trackedFiles,
        transcriptMessages,
    ]);

    const handlers = useMemo<HistoryTimelineHandlers>(
        () => ({
            canRenderFileReference,
            chatFontFamily,
            chatFontSize,
            highlightQuery,
            toolCardExpansionMode,
            onOpenFile: onOpenFile ?? NOOP_OPEN_FILE,
            onOpenImage: onOpenImage ?? NOOP_OPEN_IMAGE,
            onOpenResolvedFileReference:
                onOpenResolvedFileReference ?? NOOP_OPEN_FILE_REFERENCE,
            onOpenSession: onOpenSession ?? NOOP_OPEN_SESSION,
            resolveFileReference:
                resolveFileReference ?? NOOP_RESOLVE_FILE_REFERENCE,
        }),
        [
            canRenderFileReference,
            chatFontFamily,
            chatFontSize,
            highlightQuery,
            toolCardExpansionMode,
            onOpenFile,
            onOpenImage,
            onOpenResolvedFileReference,
            onOpenSession,
            resolveFileReference,
        ],
    );

    return (
        <>
            {timelineRows.map((row) => (
                <HistoryTimelineRow
                    handlers={handlers}
                    key={row.id}
                    projectId={projectId}
                    row={row}
                    worktreeId={worktreeId}
                />
            ))}
        </>
    );
}

function HistoryTimelineRow({
    handlers,
    projectId,
    row,
    worktreeId,
}: {
    readonly handlers: HistoryTimelineHandlers;
    readonly projectId: string | null;
    readonly row: ChatTimelineRow;
    readonly worktreeId: string | null;
}) {
    if (row.kind === "message") {
        return (
            <ChatMessageRow
                canRenderFileReference={handlers.canRenderFileReference}
                chatFontFamily={handlers.chatFontFamily}
                chatFontSize={handlers.chatFontSize}
                highlightQuery={handlers.highlightQuery}
                message={row.message}
                onOpenFile={handlers.onOpenResolvedFileReference}
                onOpenImage={handlers.onOpenImage}
                resolveFileReference={handlers.resolveFileReference}
            />
        );
    }

    return (
        <ToolActivityItem
            activity={row.reviewEntry.activity}
            expansionMode={handlers.toolCardExpansionMode}
            isLatestStreamingTool={false}
            onOpenFile={handlers.onOpenFile}
            onOpenFileReference={handlers.onOpenResolvedFileReference}
            onOpenSession={handlers.onOpenSession}
            projectId={projectId}
            resolveFileReference={handlers.resolveFileReference}
            trackedFiles={row.reviewEntry.trackedFiles}
            worktreeId={worktreeId}
        />
    );
}

function HistoryPlaceholder({
    action,
    body,
    title,
}: {
    readonly action?: ReactNode;
    readonly body: string;
    readonly title?: string;
}) {
    return (
        <div className="flex h-full min-h-[120px] items-center justify-center px-6 py-10">
            <div className="max-w-sm text-center">
                {title ? (
                    <p className="mb-1 text-xs font-medium text-text-primary">
                        {title}
                    </p>
                ) : null}
                <p className="text-[11px] leading-[1.6] text-text-secondary">
                    {body}
                </p>
                {action ? (
                    <div className="mt-3 flex justify-center">{action}</div>
                ) : null}
            </div>
        </div>
    );
}

function formatSessionCount(count: number): string {
    return count === 1 ? "1 session" : `${count} sessions`;
}

function isSubagentSession(session: AiHistorySessionSummary): boolean {
    const parentSessionId = (session.parentSessionId ?? "").trim();
    return parentSessionId.length > 0 && parentSessionId !== session.sessionId;
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

const CARD_ACTION_CLASS_NAME =
    "app-no-drag rounded px-1 py-0 text-[8.5px] font-medium uppercase tracking-[0.06em] leading-[14px] text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50";
const CARD_ACTION_DANGER_CLASS_NAME =
    "app-no-drag rounded px-1 py-0 text-[8.5px] font-medium uppercase tracking-[0.06em] leading-[14px] text-text-secondary transition-colors hover:bg-[color-mix(in_srgb,var(--diff-remove)_14%,transparent)] hover:text-[var(--diff-remove)] disabled:cursor-not-allowed disabled:opacity-50";

function clampSidebarWidth(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}
