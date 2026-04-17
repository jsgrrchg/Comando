import type { editor as MonacoEditor } from "monaco-editor";
import { create } from "zustand";

import type {
    AiImageAttachment,
    AiRuntimeId,
    ProjectFileDocument,
    TerminalDataEvent,
    TerminalExitEvent,
    WorkspaceChatHistoryTab,
    WorkspaceChatTab,
    WorkspaceGitCommitTab,
    WorkspaceGitTab,
    WorkspaceReviewTab,
    WorkspaceSnapshot,
} from "@shared/ipc";

import {
    activatePane,
    appendTerminalOutput,
    attachTabToPane,
    collectPaneNodes,
    closeOtherWorkspaceTabs,
    closeWorkspacePane,
    closeWorkspaceTab,
    closeWorkspaceTabsForProjectPath,
    closeWorkspaceTabsToRight,
    createDefaultWorkspaceState,
    markTerminalExited,
    moveActiveTabBetweenPanes,
    moveTabToPaneAtIndex,
    moveTabToSplit,
    moveWorkspaceTabBetweenPanes,
    removeProjectTabs,
    reorderTabInPane,
    renameWorkspaceTabsForProjectPath,
    replaceFileDocument,
    resizeSplit,
    selectAdjacentPaneTab,
    setFileTabExternalChange,
    setFileTabViewState,
    setFileTabReviewContext,
    selectPaneTab,
    setFileTabLoading,
    setFileTabLoadError,
    setFileTabSaving,
    setTerminalLaunchError,
    setTerminalSessionReady,
    splitPaneInDirection,
    updateChatDraft,
    updateFileDraft as applyFileDraft,
    workspaceStateFromSnapshot,
    workspaceStateToSnapshot,
    type RuntimeWorkspaceChatHistoryTab,
    type RuntimeWorkspaceGitCommitTab,
    type MoveDirection,
    type RuntimeWorkspaceGitTab,
    type RuntimeWorkspaceFileReviewContext,
    type RuntimeWorkspaceFileTab,
    type RuntimeWorkspaceReviewTab,
    type RuntimeWorkspaceTab,
    type RuntimeWorkspaceTerminalTab,
    type SplitDirection,
    type WorkspaceTreeState,
} from "../workspace/tree";
import {
    collectPendingTrackedFilesFromSessions,
    resolveFileTabReviewContext,
} from "../workspace/pending-review";
import { useAiStore } from "./ai-store";
import { useProjectsStore } from "./projects-store";

export type WorkspaceQuickCreateAction =
    | "claude"
    | "codex"
    | "gemini"
    | "git"
    | "history"
    | "kilo"
    | "file"
    | "terminal";

interface WorkspaceStore extends WorkspaceTreeState {
    closeOtherTabs: (tabId: string) => Promise<void>;
    readonly error: string | null;
    readonly hydrated: boolean;
    readonly lastFocusedChatTabId: string | null;
    readonly lastFocusedRuntimeId: AiRuntimeId;
    readonly lastQuickCreateAction: WorkspaceQuickCreateAction;
    readonly recentActiveTabIds: readonly string[];
    readonly recentFocusedChatTabIds: readonly string[];
    appendTerminalOutput: (event: TerminalDataEvent) => void;
    closePane: (paneId: string) => Promise<void>;
    closeTab: (tabId: string) => Promise<void>;
    closeTabsToRight: (tabId: string) => Promise<void>;
    createChatTab: (
        projectId: string | null,
        worktreeId?: string | null,
        runtimeId?: AiRuntimeId,
    ) => Promise<void>;
    createTerminalTab: (
        projectId: string | null,
        worktreeId?: string | null,
    ) => Promise<void>;
    openChatSessionTab: (input: {
        readonly projectId: string | null;
        readonly runtimeId: AiRuntimeId;
        readonly sessionId: string;
        readonly targetPaneId?: string | null;
        readonly title: string;
        readonly worktreeId?: string | null;
    }) => Promise<void>;
    openGitTab: (
        projectId: string,
        worktreeId?: string | null,
    ) => Promise<void>;
    openChatHistoryTab: (
        projectId: string | null,
        worktreeId?: string | null,
    ) => Promise<void>;
    openGitCommitTab: (input: {
        readonly commitSha: string;
        readonly projectId: string | null;
        readonly subject: string;
        readonly worktreeId?: string | null;
    }) => Promise<void>;
    handleTerminalExit: (event: TerminalExitEvent) => void;
    hydrate: () => Promise<void>;
    moveActiveTab: (paneId: string, direction: MoveDirection) => Promise<void>;
    moveTab: (tabId: string, direction: MoveDirection) => Promise<void>;
    moveTabToPane: (
        tabId: string,
        sourcePaneId: string,
        targetPaneId: string,
        targetIndex: number,
    ) => Promise<void>;
    markChatTabFocused: (tabId: string) => void;
    openFileTab: (
        projectId: string,
        relativePath: string,
        worktreeId?: string | null,
        reviewContext?: RuntimeWorkspaceFileReviewContext | null,
        targetPaneId?: string | null,
    ) => Promise<void>;
    openChatImageTab: (input: {
        readonly attachment: AiImageAttachment;
        readonly targetPaneId?: string | null;
    }) => Promise<void>;
    openReviewTab: (input: {
        readonly projectId: string | null;
        readonly runtimeId: AiRuntimeId;
        readonly sessionId: string;
        readonly title: string;
        readonly worktreeId?: string | null;
    }) => Promise<void>;
    reloadFileTab: (tabId: string) => Promise<void>;
    refreshProjectTabs: (
        projectId: string,
        worktreeId?: string | null,
        invalidatedRelativePaths?: readonly string[] | null,
    ) => Promise<void>;
    removeProjectTabs: (projectId: string) => Promise<void>;
    reorderTab: (
        paneId: string,
        tabId: string,
        targetIndex: number,
    ) => Promise<void>;
    closeTabsForProjectPath: (
        projectId: string,
        worktreeId: string | null,
        relativePath: string,
        kind: "directory" | "file",
    ) => Promise<void>;
    dropTabToSplit: (
        tabId: string,
        sourcePaneId: string,
        targetPaneId: string,
        direction: SplitDirection,
    ) => Promise<void>;
    resizeSplit: (
        splitId: string,
        nextSizes: readonly number[],
    ) => Promise<void>;
    renameTabsForProjectPath: (
        projectId: string,
        worktreeId: string | null,
        previousRelativePath: string,
        nextRelativePath: string,
        kind: "directory" | "file",
    ) => Promise<void>;
    restartTerminalTab: (tabId: string) => Promise<void>;
    saveFileTab: (
        tabId: string,
        options?: {
            readonly force?: boolean;
        },
    ) => Promise<void>;
    selectAdjacentTab: (
        paneId: string,
        direction: MoveDirection,
    ) => Promise<void>;
    selectTab: (paneId: string, tabId: string) => Promise<void>;
    sendTerminalInput: (sessionId: string, data: string) => Promise<void>;
    setLastFocusedRuntimeId: (runtimeId: AiRuntimeId) => void;
    setLastQuickCreateAction: (action: WorkspaceQuickCreateAction) => void;
    setActivePane: (paneId: string) => Promise<void>;
    splitPane: (paneId: string, direction: SplitDirection) => Promise<void>;
    updateChatDraft: (tabId: string, draft: string) => Promise<void>;
    updateFileDraft: (tabId: string, draft: string) => void;
    updateFileViewState: (
        tabId: string,
        viewState: MonacoEditor.ICodeEditorViewState | null,
    ) => void;
    updateTerminalSize: (
        sessionId: string,
        cols: number,
        rows: number,
    ) => Promise<void>;
    updateSessionTabTitles: (
        sessionId: string,
        title: string,
    ) => Promise<void>;
}

type GetWorkspaceState = () => WorkspaceStore;

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
    ...createDefaultWorkspaceState(),
    error: null,
    hydrated: false,
    lastFocusedChatTabId: null,
    lastFocusedRuntimeId: "codex",
    lastQuickCreateAction: "codex",
    recentActiveTabIds: [],
    recentFocusedChatTabIds: [],

    appendTerminalOutput: (event) => {
        set((state) => ({
            ...appendTerminalOutput(state, event.sessionId, event.data),
        }));
    },

    closeOtherTabs: async (tabId) => {
        set((state) => ({
            ...closeOtherWorkspaceTabs(state, tabId),
            error: null,
        }));
        await persistWorkspaceState(get);
    },

    closePane: async (paneId) => {
        set((state) => ({
            ...closeWorkspacePane(state, paneId),
            error: null,
        }));
        await persistWorkspaceState(get);
    },

    closeTabsForProjectPath: async (
        projectId: string,
        worktreeId: string | null,
        relativePath: string,
        kind: "directory" | "file",
    ) => {
        set((state) => ({
            ...closeWorkspaceTabsForProjectPath(
                state,
                projectId,
                worktreeId,
                relativePath,
                kind,
            ),
            error: null,
        }));
        await persistWorkspaceState(get);
    },

    closeTabsToRight: async (tabId) => {
        set((state) => ({
            ...closeWorkspaceTabsToRight(state, tabId),
            error: null,
        }));
        await persistWorkspaceState(get);
    },

    closeTab: async (tabId) => {
        const tab = get().tabsById[tabId];
        if (tab?.kind === "terminal") {
            await safeCloseTerminal(tab.sessionId);
        }
        if (tab?.kind === "chat") {
            await safeCloseAiSession(tab.sessionId);
        }

        set((state) => {
            const paneId = findPaneIdByTabId(state, tabId);
            const activeTabId = paneId
                ? getPaneActiveTabId(state, paneId)
                : null;
            const fallbackTabId =
                paneId && activeTabId === tabId
                    ? findMostRecentFocusedTabIdInPane(
                          state,
                          paneId,
                          state.recentActiveTabIds,
                          tabId,
                      )
                    : null;
            const closedState = closeWorkspaceTab(state, tabId);
            const nextState =
                paneId &&
                fallbackTabId &&
                findPaneIdByTabId(closedState, fallbackTabId) === paneId
                    ? {
                          ...selectPaneTab(closedState, paneId, fallbackTabId),
                          activePaneId: closedState.activePaneId,
                      }
                    : closedState;
            const recentFocusedChatTabIds = removeRecentChatFocus(
                state.recentFocusedChatTabIds,
                tabId,
            );
            const recentActiveTabIds = fallbackTabId
                ? recordRecentTabActivation(
                      removeRecentTabActivation(
                          state.recentActiveTabIds,
                          tabId,
                      ),
                      fallbackTabId,
                  )
                : removeRecentTabActivation(state.recentActiveTabIds, tabId);
            const fallbackFocusedChatTabId =
                findMostRecentExistingChatTabId(
                    nextState.tabsById,
                    recentFocusedChatTabIds,
                ) ?? getPaneChatTabId(nextState, nextState.activePaneId);
            const fallbackFocusedRuntimeId =
                getWorkspaceTabRuntimeId(
                    fallbackFocusedChatTabId
                        ? nextState.tabsById[fallbackFocusedChatTabId]
                        : null,
                ) ??
                getPaneRuntimeId(nextState, nextState.activePaneId) ??
                state.lastFocusedRuntimeId;
            return {
                ...nextState,
                error: null,
                lastFocusedChatTabId:
                    state.lastFocusedChatTabId === tabId
                        ? fallbackFocusedChatTabId
                        : state.lastFocusedChatTabId,
                lastFocusedRuntimeId:
                    state.lastFocusedChatTabId === tabId
                        ? fallbackFocusedRuntimeId
                        : state.lastFocusedRuntimeId,
                recentActiveTabIds,
                recentFocusedChatTabIds,
            };
        });
        await persistWorkspaceState(get);
    },

    createChatTab: async (
        projectId: string | null,
        worktreeId: string | null = null,
        runtimeId: AiRuntimeId = "codex",
    ) => {
        const paneId = get().activePaneId;
        const runtimeTitle =
            runtimeId === "claude"
                ? "Claude"
                : runtimeId === "gemini"
                  ? "Gemini"
                  : runtimeId === "kilo"
                    ? "Kilo"
                    : "Codex";
        const tab: WorkspaceChatTab = {
            createdAt: new Date().toISOString(),
            draft: "",
            id: crypto.randomUUID(),
            kind: "chat",
            projectId,
            runtimeId,
            sessionId: crypto.randomUUID(),
            title: `${runtimeTitle} ${countRuntimeChatTabs(get, runtimeId) + 1}`,
            worktreeId,
        };

        set((state) => ({
            ...attachTabToPane(state, paneId, tab),
            error: null,
            lastFocusedChatTabId: tab.id,
            lastFocusedRuntimeId: runtimeId,
            lastQuickCreateAction: runtimeId,
            recentActiveTabIds: recordRecentTabActivation(
                state.recentActiveTabIds,
                tab.id,
            ),
            recentFocusedChatTabIds: recordRecentChatFocus(
                state.recentFocusedChatTabIds,
                tab.id,
            ),
        }));
        await persistWorkspaceState(get);
    },

    createTerminalTab: async (projectId, worktreeId = null) => {
        const sessionId = crypto.randomUUID();
        const tab: RuntimeWorkspaceTerminalTab = {
            createdAt: new Date().toISOString(),
            exitCode: null,
            id: crypto.randomUUID(),
            isReady: false,
            kind: "terminal",
            launchError: null,
            output: "",
            projectId,
            session: null,
            sessionId,
            signalCode: null,
            title: `Terminal ${countTabs(get, "terminal") + 1}`,
            worktreeId,
        };

        set((state) => ({
            ...attachTabToPane(state, state.activePaneId, tab),
            error: null,
            lastQuickCreateAction: "terminal",
            recentActiveTabIds: recordRecentTabActivation(
                state.recentActiveTabIds,
                tab.id,
            ),
        }));
        await persistWorkspaceState(get);
        await bootTerminalSession(get, set, tab.id);
    },

    openChatSessionTab: async (input) => {
        const existingTab = findExistingChatTabBySessionId(
            get(),
            input.sessionId,
        );
        if (existingTab) {
            const nextTab: WorkspaceChatTab = {
                ...existingTab,
                projectId: input.projectId,
                runtimeId: input.runtimeId,
                title: input.title,
                worktreeId: input.worktreeId ?? null,
            };
            const paneId = findPaneIdByTabId(get(), existingTab.id);
            if (!paneId) {
                return;
            }

            set((state) => ({
                ...selectPaneTab(
                    {
                        ...state,
                        tabsById: {
                            ...state.tabsById,
                            [existingTab.id]: nextTab,
                        },
                    },
                    paneId,
                    existingTab.id,
                ),
                error: null,
                lastFocusedChatTabId: existingTab.id,
                lastFocusedRuntimeId: input.runtimeId,
                recentActiveTabIds: recordRecentTabActivation(
                    state.recentActiveTabIds,
                    existingTab.id,
                ),
                recentFocusedChatTabIds: recordRecentChatFocus(
                    state.recentFocusedChatTabIds,
                    existingTab.id,
                ),
            }));
            void useAiStore.getState().ensureSession(nextTab);
            await persistWorkspaceState(get);
            return;
        }

        const resolvedPaneId =
            input.targetPaneId &&
            collectPaneNodes(get().rootNode).some(
                (pane) => pane.id === input.targetPaneId,
            )
                ? input.targetPaneId
                : get().activePaneId;
        const tab: WorkspaceChatTab = {
            createdAt: new Date().toISOString(),
            draft: "",
            id: crypto.randomUUID(),
            kind: "chat",
            projectId: input.projectId,
            runtimeId: input.runtimeId,
            sessionId: input.sessionId,
            title: input.title,
            worktreeId: input.worktreeId ?? null,
        };

        set((state) => ({
            ...attachTabToPane(state, resolvedPaneId, tab),
            error: null,
            lastFocusedChatTabId: tab.id,
            lastFocusedRuntimeId: input.runtimeId,
            recentActiveTabIds: recordRecentTabActivation(
                state.recentActiveTabIds,
                tab.id,
            ),
            recentFocusedChatTabIds: recordRecentChatFocus(
                state.recentFocusedChatTabIds,
                tab.id,
            ),
        }));
        void useAiStore.getState().ensureSession(tab);
        await persistWorkspaceState(get);
    },

    openGitTab: async (projectId, worktreeId = null) => {
        const existingTab = findExistingGitTab(get(), projectId, worktreeId);
        if (existingTab) {
            const paneId = findPaneIdByTabId(get(), existingTab.id);
            if (!paneId) {
                return;
            }

            set((state) => ({
                ...selectPaneTab(state, paneId, existingTab.id),
                error: null,
                lastQuickCreateAction: "git",
                recentActiveTabIds: recordRecentTabActivation(
                    state.recentActiveTabIds,
                    existingTab.id,
                ),
            }));
            await persistWorkspaceState(get);
            return;
        }

        const projectTitle =
            useProjectsStore
                .getState()
                .projects.find((project) => project.id === projectId)?.name ??
            "Git";

        const tab: WorkspaceGitTab = {
            createdAt: new Date().toISOString(),
            id: crypto.randomUUID(),
            kind: "git",
            projectId,
            title: projectTitle,
            worktreeId,
        };

        set((state) => ({
            ...attachTabToPane(state, state.activePaneId, tab),
            error: null,
            lastQuickCreateAction: "git",
            recentActiveTabIds: recordRecentTabActivation(
                state.recentActiveTabIds,
                tab.id,
            ),
        }));
        await persistWorkspaceState(get);
    },

    openChatHistoryTab: async (projectId, worktreeId = null) => {
        const existingTab = findExistingChatHistoryTab(
            get(),
            projectId,
            worktreeId,
        );
        if (existingTab) {
            const paneId = findPaneIdByTabId(get(), existingTab.id);
            if (!paneId) {
                return;
            }

            set((state) => ({
                ...selectPaneTab(state, paneId, existingTab.id),
                error: null,
                lastQuickCreateAction: "history",
                recentActiveTabIds: recordRecentTabActivation(
                    state.recentActiveTabIds,
                    existingTab.id,
                ),
            }));
            await persistWorkspaceState(get);
            return;
        }

        const tab: WorkspaceChatHistoryTab = {
            createdAt: new Date().toISOString(),
            id: crypto.randomUUID(),
            kind: "chat_history",
            projectId,
            title: "History",
            worktreeId,
        };

        set((state) => ({
            ...attachTabToPane(state, state.activePaneId, tab),
            error: null,
            lastQuickCreateAction: "history",
            recentActiveTabIds: recordRecentTabActivation(
                state.recentActiveTabIds,
                tab.id,
            ),
        }));
        await persistWorkspaceState(get);
    },

    openGitCommitTab: async (input) => {
        const existingTab = findExistingGitCommitTab(
            get(),
            input.projectId,
            input.commitSha,
            input.worktreeId ?? null,
        );
        if (existingTab) {
            const paneId = findPaneIdByTabId(get(), existingTab.id);
            if (!paneId) {
                return;
            }

            set((state) => ({
                ...selectPaneTab(state, paneId, existingTab.id),
                error: null,
                recentActiveTabIds: recordRecentTabActivation(
                    state.recentActiveTabIds,
                    existingTab.id,
                ),
            }));
            await persistWorkspaceState(get);
            return;
        }

        const tab: WorkspaceGitCommitTab = {
            commitSha: input.commitSha,
            createdAt: new Date().toISOString(),
            id: crypto.randomUUID(),
            kind: "git_commit",
            projectId: input.projectId,
            title: input.commitSha.slice(0, 7),
            worktreeId: input.worktreeId ?? null,
        };

        set((state) => ({
            ...attachTabToPane(state, state.activePaneId, tab),
            error: null,
            recentActiveTabIds: recordRecentTabActivation(
                state.recentActiveTabIds,
                tab.id,
            ),
        }));
        await persistWorkspaceState(get);
    },

    handleTerminalExit: (event) => {
        set((state) => ({
            ...markTerminalExited(
                state,
                event.sessionId,
                event.exitCode,
                event.signalCode,
            ),
        }));
    },

    hydrate: async () => {
        try {
            const snapshot = await getComandoApi().getWorkspaceSnapshot();
            const runtimeTabs = createHydratedRuntimeTabs(snapshot);
            const hydratedState = workspaceStateFromSnapshot(
                snapshot,
                runtimeTabs,
            );
            set({
                ...hydratedState,
                error: null,
                hydrated: true,
                lastFocusedChatTabId: getPaneChatTabId(
                    hydratedState,
                    snapshot.activePaneId,
                ),
                lastFocusedRuntimeId:
                    getPaneRuntimeId(hydratedState, snapshot.activePaneId) ??
                    "codex",
                recentActiveTabIds: recordRecentTabActivation(
                    [],
                    getPaneActiveTabId(hydratedState, snapshot.activePaneId),
                ),
                recentFocusedChatTabIds: recordRecentChatFocus(
                    [],
                    getPaneChatTabId(hydratedState, snapshot.activePaneId),
                ),
            });
            void hydrateRuntimeTabs(snapshot, get, set);
        } catch (error) {
            set({
                ...createDefaultWorkspaceState(),
                error:
                    error instanceof Error
                        ? error.message
                        : "Could not restore the workspace layout.",
                hydrated: true,
            });
        }
    },

    moveActiveTab: async (paneId, direction) => {
        set((state) => {
            const nextState = moveActiveTabBetweenPanes(
                state,
                paneId,
                direction,
            );
            return {
                ...nextState,
                error: null,
                recentActiveTabIds: recordRecentTabActivation(
                    state.recentActiveTabIds,
                    getPaneActiveTabId(nextState, nextState.activePaneId),
                ),
            };
        });
        await persistWorkspaceState(get);
    },

    markChatTabFocused: (tabId) => {
        set((state) => {
            const tab = state.tabsById[tabId];
            if (tab?.kind !== "chat") {
                return state;
            }

            return {
                lastFocusedChatTabId: tab.id,
                lastFocusedRuntimeId: tab.runtimeId,
                recentFocusedChatTabIds: recordRecentChatFocus(
                    state.recentFocusedChatTabIds,
                    tab.id,
                ),
            };
        });
    },

    moveTab: async (tabId, direction) => {
        set((state) => {
            const nextState = moveWorkspaceTabBetweenPanes(
                state,
                tabId,
                direction,
            );
            return {
                ...nextState,
                error: null,
                recentActiveTabIds: recordRecentTabActivation(
                    state.recentActiveTabIds,
                    getPaneActiveTabId(nextState, nextState.activePaneId),
                ),
            };
        });
        await persistWorkspaceState(get);
    },

    moveTabToPane: async (tabId, sourcePaneId, targetPaneId, targetIndex) => {
        set((state) => {
            const nextState = moveTabToPaneAtIndex(
                state,
                tabId,
                sourcePaneId,
                targetPaneId,
                targetIndex,
            );
            return {
                ...nextState,
                error: null,
                recentActiveTabIds: recordRecentTabActivation(
                    state.recentActiveTabIds,
                    tabId,
                ),
            };
        });
        await persistWorkspaceState(get);
    },

    openFileTab: async (
        projectId: string,
        relativePath: string,
        worktreeId: string | null = null,
        reviewContext?: RuntimeWorkspaceFileReviewContext | null,
        targetPaneId?: string | null,
    ) => {
        try {
            const trackedFiles = collectPendingTrackedFilesFromSessions(
                useAiStore.getState().sessions,
            );
            const resolvedPaneId =
                targetPaneId &&
                collectPaneNodes(get().rootNode).some(
                    (pane) => pane.id === targetPaneId,
                )
                    ? targetPaneId
                    : get().activePaneId;
            const existingTabs = findExistingFileTabs(
                get(),
                projectId,
                relativePath,
                worktreeId,
            );
            const existingTabInResolvedPane =
                existingTabs.find((tab) => {
                    const paneId = findPaneIdByTabId(get(), tab.id);
                    return paneId === resolvedPaneId;
                }) ?? null;

            if (existingTabInResolvedPane) {
                const paneId = findPaneIdByTabId(
                    get(),
                    existingTabInResolvedPane.id,
                );
                if (!paneId) {
                    return;
                }

                const nextReviewContext = resolveFileTabReviewContext({
                    existingReviewContext:
                        existingTabInResolvedPane.reviewContext,
                    relativePath,
                    requestedReviewContext: reviewContext,
                    trackedFiles,
                });

                set((state) => ({
                    ...setFileTabReviewContext(
                        paneId === resolvedPaneId
                            ? selectPaneTab(
                                  state,
                                  paneId,
                                  existingTabInResolvedPane.id,
                              )
                            : moveTabToPaneAtIndex(
                                  state,
                                  existingTabInResolvedPane.id,
                                  paneId,
                                  resolvedPaneId,
                                  Number.POSITIVE_INFINITY,
                              ),
                        existingTabInResolvedPane.id,
                        nextReviewContext,
                    ),
                    error: null,
                    recentActiveTabIds: recordRecentTabActivation(
                        state.recentActiveTabIds,
                        existingTabInResolvedPane.id,
                    ),
                }));

                if (
                    !existingTabInResolvedPane.document &&
                    !existingTabInResolvedPane.isDirty
                ) {
                    await loadFileTabDocument(
                        get,
                        set,
                        existingTabInResolvedPane.id,
                    );
                }

                await persistWorkspaceState(get);
                return;
            }

            const sourceTab = existingTabs[0] ?? null;
            if (sourceTab) {
                const nextReviewContext = resolveFileTabReviewContext({
                    existingReviewContext: sourceTab.reviewContext,
                    relativePath,
                    requestedReviewContext: reviewContext,
                    trackedFiles,
                });
                const duplicatedTab: RuntimeWorkspaceFileTab = {
                    ...sourceTab,
                    createdAt: new Date().toISOString(),
                    id: crypto.randomUUID(),
                    reviewContext: nextReviewContext,
                    viewState: sourceTab.viewState ?? null,
                };

                set((state) => ({
                    ...attachTabToPane(state, resolvedPaneId, duplicatedTab),
                    error: null,
                    recentActiveTabIds: recordRecentTabActivation(
                        state.recentActiveTabIds,
                        duplicatedTab.id,
                    ),
                }));

                if (!sourceTab.document && !sourceTab.isDirty) {
                    await loadFileTabDocument(get, set, duplicatedTab.id);
                }

                await persistWorkspaceState(get);
                return;
            }

            const tab: RuntimeWorkspaceFileTab = {
                createdAt: new Date().toISOString(),
                document: null,
                draftContent: "",
                hasExternalChange: false,
                id: crypto.randomUUID(),
                isDirty: false,
                isLoading: true,
                isSaving: false,
                kind: "file",
                loadError: null,
                reviewContext: resolveFileTabReviewContext({
                    relativePath,
                    requestedReviewContext: reviewContext,
                    trackedFiles,
                }),
                projectId,
                relativePath,
                savedContent: "",
                saveError: null,
                title: getFileTitle(relativePath),
                viewState: null,
                worktreeId,
            };

            set((state) => ({
                ...attachTabToPane(state, resolvedPaneId, tab),
                error: null,
                recentActiveTabIds: recordRecentTabActivation(
                    state.recentActiveTabIds,
                    tab.id,
                ),
            }));
            await persistWorkspaceState(get);
            await loadFileTabDocument(get, set, tab.id);
        } catch (error) {
            set({
                error:
                    error instanceof Error
                        ? error.message
                        : "Could not open the selected file in the workspace.",
            });
        }
    },

    openChatImageTab: async ({ attachment, targetPaneId }) => {
        const resolvedPaneId =
            targetPaneId &&
            collectPaneNodes(get().rootNode).some((pane) => pane.id === targetPaneId)
                ? targetPaneId
                : get().activePaneId;
        const chatImageTab = buildChatImageTab(attachment);
        const existingTabs = findExistingFileTabs(
            get(),
            chatImageTab.projectId,
            chatImageTab.relativePath,
            chatImageTab.worktreeId ?? null,
        );
        const existingTabInResolvedPane =
            existingTabs.find((tab) => {
                const paneId = findPaneIdByTabId(get(), tab.id);
                return paneId === resolvedPaneId;
            }) ?? null;

        if (existingTabInResolvedPane) {
            const paneId = findPaneIdByTabId(get(), existingTabInResolvedPane.id);
            if (!paneId) {
                return;
            }

            set((state) => ({
                ...(paneId === resolvedPaneId
                    ? selectPaneTab(state, paneId, existingTabInResolvedPane.id)
                    : moveTabToPaneAtIndex(
                          state,
                          existingTabInResolvedPane.id,
                          paneId,
                          resolvedPaneId,
                          Number.POSITIVE_INFINITY,
                      )),
                error: null,
                recentActiveTabIds: recordRecentTabActivation(
                    state.recentActiveTabIds,
                    existingTabInResolvedPane.id,
                ),
                tabsById: {
                    ...state.tabsById,
                    [existingTabInResolvedPane.id]: {
                        ...existingTabInResolvedPane,
                        ...chatImageTab,
                        createdAt: existingTabInResolvedPane.createdAt,
                        id: existingTabInResolvedPane.id,
                    },
                },
            }));
            await persistWorkspaceState(get);
            return;
        }

        const sourceTab = existingTabs[0] ?? null;
        if (sourceTab) {
            const duplicatedTab: RuntimeWorkspaceFileTab = {
                ...sourceTab,
                ...chatImageTab,
                createdAt: new Date().toISOString(),
                id: crypto.randomUUID(),
                viewState: null,
            };

            set((state) => ({
                ...attachTabToPane(state, resolvedPaneId, duplicatedTab),
                error: null,
                recentActiveTabIds: recordRecentTabActivation(
                    state.recentActiveTabIds,
                    duplicatedTab.id,
                ),
            }));
            await persistWorkspaceState(get);
            return;
        }

        set((state) => ({
            ...attachTabToPane(state, resolvedPaneId, chatImageTab),
            error: null,
            recentActiveTabIds: recordRecentTabActivation(
                state.recentActiveTabIds,
                chatImageTab.id,
            ),
        }));
        await persistWorkspaceState(get);
    },

    openReviewTab: async (input) => {
        const existingTab = findExistingReviewTab(get(), input.sessionId);
        if (existingTab) {
            const paneId = findPaneIdByTabId(get(), existingTab.id);
            if (!paneId) {
                return;
            }

            set((state) => ({
                ...selectPaneTab(state, paneId, existingTab.id),
                error: null,
                recentActiveTabIds: recordRecentTabActivation(
                    state.recentActiveTabIds,
                    existingTab.id,
                ),
            }));
            await persistWorkspaceState(get);
            return;
        }

        const tab: WorkspaceReviewTab = {
            createdAt: new Date().toISOString(),
            id: crypto.randomUUID(),
            kind: "review",
            projectId: input.projectId,
            runtimeId: input.runtimeId,
            sessionId: input.sessionId,
            title: `Review · ${input.title}`,
            worktreeId: input.worktreeId ?? null,
        };

        set((state) => ({
            ...attachTabToPane(state, state.activePaneId, tab),
            error: null,
            lastFocusedRuntimeId: input.runtimeId,
            recentActiveTabIds: recordRecentTabActivation(
                state.recentActiveTabIds,
                tab.id,
            ),
        }));
        await persistWorkspaceState(get);
    },

    reloadFileTab: async (tabId) => {
        await loadFileTabDocument(get, set, tabId);
    },

    refreshProjectTabs: async (
        projectId: string,
        worktreeId: string | null = null,
        invalidatedRelativePaths: readonly string[] | null = null,
    ) => {
        const fileTabs = Object.values(get().tabsById).filter(
            (tab): tab is RuntimeWorkspaceFileTab =>
                tab.kind === "file" &&
                tab.projectId === projectId &&
                normalizeWorktreeId(tab.worktreeId) ===
                    normalizeWorktreeId(worktreeId),
        );

        if (fileTabs.length === 0) {
            return;
        }

        await Promise.all(
            fileTabs.map(async (tab) => {
                if (
                    !isFileTabAffectedByProjectInvalidation(
                        tab.relativePath,
                        invalidatedRelativePaths,
                    ) ||
                    tab.isDirty ||
                    tab.isSaving
                ) {
                    return;
                }

                await loadFileTabDocument(get, set, tab.id);
            }),
        );
    },

    removeProjectTabs: async (projectId) => {
        const terminalSessionIds = Object.values(get().tabsById)
            .filter(
                (tab): tab is RuntimeWorkspaceTerminalTab =>
                    tab.kind === "terminal" && tab.projectId === projectId,
            )
            .map((tab) => tab.sessionId);

        await Promise.all(
            terminalSessionIds.map((sessionId) => safeCloseTerminal(sessionId)),
        );

        set((state) => ({
            ...removeProjectTabs(state, projectId),
            error: null,
        }));
        await persistWorkspaceState(get);
    },

    reorderTab: async (paneId, tabId, targetIndex) => {
        set((state) => ({
            ...reorderTabInPane(state, paneId, tabId, targetIndex),
            error: null,
        }));
        await persistWorkspaceState(get);
    },

    renameTabsForProjectPath: async (
        projectId: string,
        worktreeId: string | null,
        previousRelativePath: string,
        nextRelativePath: string,
        kind: "directory" | "file",
    ) => {
        set((state) => ({
            ...renameWorkspaceTabsForProjectPath(
                state,
                projectId,
                worktreeId,
                previousRelativePath,
                nextRelativePath,
                kind,
            ),
            error: null,
        }));
        await persistWorkspaceState(get);
    },

    resizeSplit: async (splitId, nextSizes) => {
        set((state) => ({
            error: null,
            rootNode: resizeSplit(state.rootNode, splitId, nextSizes),
        }));
        await flushWorkspacePersistence(get, { force: true });
    },

    restartTerminalTab: async (tabId) => {
        const tab = get().tabsById[tabId];
        if (!tab || tab.kind !== "terminal") {
            return;
        }

        await safeCloseTerminal(tab.sessionId);
        set((state) => ({
            ...setTerminalLaunchError(state, tabId, ""),
            tabsById: {
                ...state.tabsById,
                [tabId]: {
                    ...tab,
                    exitCode: null,
                    isReady: false,
                    launchError: null,
                    output: "",
                    session: null,
                    signalCode: null,
                },
            },
        }));
        await bootTerminalSession(get, set, tabId);
    },

    saveFileTab: async (tabId, options) => {
        const tab = get().tabsById[tabId];
        if (
            !tab ||
            tab.kind !== "file" ||
            !tab.document ||
            !tab.isDirty ||
            tab.isSaving
        ) {
            return;
        }

        set((state) => ({
            ...setFileTabSaving(state, tabId, true, null),
            error: null,
        }));

        try {
            const document = await getComandoApi().saveProjectFile({
                content: tab.draftContent,
                expectedModifiedAtMs: options?.force
                    ? null
                    : tab.document.modifiedAtMs,
                projectId: tab.projectId,
                relativePath: tab.relativePath,
                worktreeId: tab.worktreeId ?? null,
            });

            set((state) => ({
                ...replaceFileDocument(state, tabId, document),
                error: null,
            }));
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : "Could not save this file.";
            const isConflict = isProjectFileConflictMessage(message);
            set((state) => ({
                ...(isConflict
                    ? setFileTabExternalChange(
                          setFileTabSaving(state, tabId, false, message),
                          tabId,
                          true,
                          message,
                      )
                    : setFileTabSaving(state, tabId, false, message)),
                error: message,
            }));
        }
    },

    selectAdjacentTab: async (paneId, direction) => {
        set((state) => ({
            ...(() => {
                const nextState = selectAdjacentPaneTab(
                    state,
                    paneId,
                    direction,
                );
                const runtimeId = getPaneRuntimeId(nextState, paneId);
                const chatTabId = getPaneChatTabId(nextState, paneId);
                return {
                    ...nextState,
                    error: null,
                    ...(chatTabId ? { lastFocusedChatTabId: chatTabId } : {}),
                    ...(runtimeId ? { lastFocusedRuntimeId: runtimeId } : {}),
                    recentActiveTabIds: recordRecentTabActivation(
                        state.recentActiveTabIds,
                        getPaneActiveTabId(nextState, paneId),
                    ),
                    recentFocusedChatTabIds: recordRecentChatFocus(
                        state.recentFocusedChatTabIds,
                        chatTabId,
                    ),
                };
            })(),
        }));
        await persistWorkspaceState(get);
    },

    selectTab: async (paneId, tabId) => {
        set((state) => ({
            ...(() => {
                const nextState = selectPaneTab(state, paneId, tabId);
                const runtimeId = getWorkspaceTabRuntimeId(
                    nextState.tabsById[tabId],
                );
                const chatTabId = getWorkspaceChatTabId(
                    nextState.tabsById[tabId],
                );
                return {
                    ...nextState,
                    error: null,
                    ...(chatTabId ? { lastFocusedChatTabId: chatTabId } : {}),
                    ...(runtimeId ? { lastFocusedRuntimeId: runtimeId } : {}),
                    recentActiveTabIds: recordRecentTabActivation(
                        state.recentActiveTabIds,
                        tabId,
                    ),
                    recentFocusedChatTabIds: recordRecentChatFocus(
                        state.recentFocusedChatTabIds,
                        chatTabId,
                    ),
                };
            })(),
        }));
        await persistWorkspaceState(get);
    },

    sendTerminalInput: async (sessionId, data) => {
        try {
            await getComandoApi().writeTerminalInput({
                data,
                sessionId,
            });
        } catch (error) {
            set({
                error:
                    error instanceof Error
                        ? error.message
                        : "Could not send input to the terminal.",
            });
        }
    },

    setLastFocusedRuntimeId: (runtimeId) => {
        set({ lastFocusedRuntimeId: runtimeId });
    },

    setLastQuickCreateAction: (action) => {
        set({ lastQuickCreateAction: action });
    },

    setActivePane: async (paneId) => {
        set((state) => ({
            ...(() => {
                const nextState = activatePane(state, paneId);
                const runtimeId = getPaneRuntimeId(nextState, paneId);
                const chatTabId = getPaneChatTabId(nextState, paneId);
                return {
                    ...nextState,
                    error: null,
                    ...(chatTabId ? { lastFocusedChatTabId: chatTabId } : {}),
                    ...(runtimeId ? { lastFocusedRuntimeId: runtimeId } : {}),
                    recentActiveTabIds: recordRecentTabActivation(
                        state.recentActiveTabIds,
                        getPaneActiveTabId(nextState, paneId),
                    ),
                    recentFocusedChatTabIds: recordRecentChatFocus(
                        state.recentFocusedChatTabIds,
                        chatTabId,
                    ),
                };
            })(),
        }));
        await persistWorkspaceState(get);
    },

    dropTabToSplit: async (tabId, sourcePaneId, targetPaneId, direction) => {
        set((state) => {
            const nextState = moveTabToSplit(
                state,
                tabId,
                sourcePaneId,
                targetPaneId,
                direction,
                {
                    paneId: crypto.randomUUID(),
                    splitId: crypto.randomUUID(),
                },
            );
            return {
                ...nextState,
                error: null,
                recentActiveTabIds: recordRecentTabActivation(
                    state.recentActiveTabIds,
                    tabId,
                ),
            };
        });
        await persistWorkspaceState(get);
    },

    splitPane: async (paneId, direction) => {
        set((state) => ({
            ...splitPaneInDirection(state, paneId, direction, {
                paneId: crypto.randomUUID(),
                splitId: crypto.randomUUID(),
            }),
            error: null,
        }));
        await persistWorkspaceState(get);
    },

    updateChatDraft: async (tabId, draft) => {
        set((state) => ({
            ...updateChatDraft(state, tabId, draft),
            error: null,
        }));
        await persistWorkspaceState(get);
    },

    updateFileDraft: (tabId, draft) => {
        set((state) => ({
            ...applyFileDraft(state, tabId, draft),
            error: null,
        }));
    },

    updateFileViewState: (tabId, viewState) => {
        set((state) => ({
            ...setFileTabViewState(state, tabId, viewState),
        }));
    },

    updateTerminalSize: async (sessionId, cols, rows) => {
        try {
            await getComandoApi().resizeTerminalSession({
                cols,
                rows,
                sessionId,
            });
        } catch (error) {
            set({
                error:
                    error instanceof Error
                        ? error.message
                        : "Could not resize the terminal session.",
            });
        }
    },

    updateSessionTabTitles: async (sessionId, title) => {
        set((state) => ({
            ...state,
            tabsById: Object.fromEntries(
                Object.entries(state.tabsById).map(([tabId, tab]) => {
                    if (
                        tab.kind === "chat" &&
                        tab.sessionId === sessionId &&
                        tab.title !== title
                    ) {
                        return [tabId, { ...tab, title }] as const;
                    }

                    if (
                        tab.kind === "review" &&
                        tab.sessionId === sessionId &&
                        tab.title !== `Review · ${title}`
                    ) {
                        return [
                            tabId,
                            {
                                ...tab,
                                title: `Review · ${title}`,
                            },
                        ] as const;
                    }

                    return [tabId, tab] as const;
                }),
            ) as Record<string, RuntimeWorkspaceTab>,
        }));
        await persistWorkspaceState(get);
    },
}));

type WorkspaceSetState = typeof useWorkspaceStore.setState;

const WORKSPACE_PERSIST_DEBOUNCE_MS = 180;

let pendingWorkspacePersistTimer: ReturnType<typeof setTimeout> | null = null;
let workspacePersistDirty = false;
let workspacePersistGet: GetWorkspaceState | null = null;
let workspacePersistInFlight: Promise<void> | null = null;

export function getWorkspaceTabRuntimeId(
    tab: RuntimeWorkspaceTab | null | undefined,
): AiRuntimeId | null {
    if (!tab) {
        return null;
    }

    if (tab.kind === "chat" || tab.kind === "review") {
        return tab.runtimeId;
    }

    return null;
}

export function getWorkspaceChatTabId(
    tab: RuntimeWorkspaceTab | null | undefined,
): string | null {
    if (!tab || tab.kind !== "chat") {
        return null;
    }

    return tab.id;
}

export function getPaneRuntimeId(
    state: Pick<WorkspaceTreeState, "rootNode" | "tabsById">,
    paneId: string,
): AiRuntimeId | null {
    const pane = collectPaneNodes(state.rootNode).find(
        (candidate) => candidate.id === paneId,
    );

    if (!pane?.activeTabId) {
        return null;
    }

    return getWorkspaceTabRuntimeId(state.tabsById[pane.activeTabId]);
}

export function getPaneChatTabId(
    state: Pick<WorkspaceTreeState, "rootNode" | "tabsById">,
    paneId: string,
): string | null {
    const pane = collectPaneNodes(state.rootNode).find(
        (candidate) => candidate.id === paneId,
    );

    if (!pane?.activeTabId) {
        return null;
    }

    return getWorkspaceChatTabId(state.tabsById[pane.activeTabId]);
}

function getPaneActiveTabId(
    state: Pick<WorkspaceTreeState, "rootNode">,
    paneId: string,
): string | null {
    const pane = collectPaneNodes(state.rootNode).find(
        (candidate) => candidate.id === paneId,
    );

    return pane?.activeTabId ?? null;
}

export function getBestMatchingChatTabId(
    state: Pick<WorkspaceTreeState, "rootNode" | "tabsById">,
    input: {
        readonly currentPaneId: string;
        readonly lastFocusedChatTabId: string | null;
        readonly projectId: string | null;
        readonly recentFocusedChatTabIds: readonly string[];
        readonly worktreeId: string | null;
    },
): string | null {
    const matchesScope = (tabId: string) => {
        const tab = state.tabsById[tabId];
        return (
            tab?.kind === "chat" &&
            tab.projectId === input.projectId &&
            normalizeWorktreeId(tab.worktreeId) ===
                normalizeWorktreeId(input.worktreeId)
        );
    };

    if (
        input.lastFocusedChatTabId &&
        matchesScope(input.lastFocusedChatTabId)
    ) {
        return input.lastFocusedChatTabId;
    }

    const recentMatch =
        input.recentFocusedChatTabIds.find(matchesScope) ?? null;
    if (recentMatch) {
        return recentMatch;
    }

    const currentPane = collectPaneNodes(state.rootNode).find(
        (candidate) => candidate.id === input.currentPaneId,
    );
    const currentPaneMatch = currentPane?.tabIds.find(matchesScope) ?? null;
    if (currentPaneMatch) {
        return currentPaneMatch;
    }

    return (
        collectPaneNodes(state.rootNode)
            .flatMap((pane) => pane.tabIds)
            .find(matchesScope) ?? null
    );
}

function recordRecentChatFocus(
    recentFocusedChatTabIds: readonly string[],
    chatTabId: string | null,
): readonly string[] {
    if (!chatTabId) {
        return recentFocusedChatTabIds;
    }

    return [
        chatTabId,
        ...recentFocusedChatTabIds.filter(
            (recentChatTabId) => recentChatTabId !== chatTabId,
        ),
    ];
}

function recordRecentTabActivation(
    recentActiveTabIds: readonly string[],
    tabId: string | null,
): readonly string[] {
    if (!tabId) {
        return recentActiveTabIds;
    }

    return [
        tabId,
        ...recentActiveTabIds.filter((recentTabId) => recentTabId !== tabId),
    ];
}

function removeRecentTabActivation(
    recentActiveTabIds: readonly string[],
    tabId: string,
): readonly string[] {
    return recentActiveTabIds.filter((recentTabId) => recentTabId !== tabId);
}

function findMostRecentFocusedTabIdInPane(
    state: Pick<WorkspaceTreeState, "rootNode">,
    paneId: string,
    recentActiveTabIds: readonly string[],
    excludedTabId: string,
): string | null {
    const pane = collectPaneNodes(state.rootNode).find(
        (candidate) => candidate.id === paneId,
    );
    if (!pane) {
        return null;
    }

    return (
        recentActiveTabIds.find(
            (recentTabId) =>
                recentTabId !== excludedTabId &&
                pane.tabIds.includes(recentTabId),
        ) ?? null
    );
}

function removeRecentChatFocus(
    recentFocusedChatTabIds: readonly string[],
    chatTabId: string,
): readonly string[] {
    return recentFocusedChatTabIds.filter(
        (recentChatTabId) => recentChatTabId !== chatTabId,
    );
}

function findMostRecentExistingChatTabId(
    tabsById: Record<string, RuntimeWorkspaceTab>,
    recentFocusedChatTabIds: readonly string[],
): string | null {
    return (
        recentFocusedChatTabIds.find(
            (recentChatTabId) => tabsById[recentChatTabId]?.kind === "chat",
        ) ?? null
    );
}

function createHydratedRuntimeTabs(
    snapshot: WorkspaceSnapshot,
): Record<string, RuntimeWorkspaceTab> {
    return Object.fromEntries(
        snapshot.tabs.map((tab) => {
            if (tab.kind === "chat") {
                return [tab.id, tab] as const;
            }

            if (tab.kind === "git") {
                return [tab.id, tab] as const;
            }

            if (tab.kind === "chat_history") {
                return [tab.id, tab] as const;
            }

            if (tab.kind === "git_commit") {
                return [tab.id, tab] as const;
            }

            if (tab.kind === "review") {
                return [tab.id, tab] as const;
            }

            if (tab.kind === "terminal") {
                return [
                    tab.id,
                    {
                        ...tab,
                        exitCode: null,
                        isReady: false,
                        launchError: null,
                        output: "",
                        session: null,
                        signalCode: null,
                    },
                ] as const;
            }

            return [
                tab.id,
                {
                    ...tab,
                    document: null,
                    draftContent: "",
                    hasExternalChange: false,
                    isDirty: false,
                    isLoading: true,
                    isSaving: false,
                    loadError: null,
                    reviewContext: null,
                    saveError: null,
                    savedContent: "",
                    title: getFileTitle(tab.relativePath),
                    viewState: null,
                },
            ] as const;
        }),
    ) as Record<string, RuntimeWorkspaceTab>;
}

async function hydrateRuntimeTabs(
    snapshot: WorkspaceSnapshot,
    get: GetWorkspaceState,
    set: WorkspaceSetState,
): Promise<void> {
    await Promise.all(
        snapshot.tabs.map(async (tab) => {
            if (tab.kind === "chat") {
                try {
                    const persistedSession =
                        await getComandoApi().getChatSessionState(
                            tab.sessionId,
                        );

                    if (!persistedSession) {
                        return;
                    }

                    set((state) => ({
                        error: null,
                        tabsById: {
                            ...state.tabsById,
                            [tab.id]: {
                                ...tab,
                                draft: persistedSession.draft,
                                projectId: persistedSession.projectId,
                                title: persistedSession.title,
                                worktreeId: persistedSession.worktreeId ?? null,
                            },
                        },
                    }));
                } catch {
                    return;
                }

                return;
            }

            if (tab.kind === "git") {
                return;
            }

            if (tab.kind === "chat_history") {
                return;
            }

            if (tab.kind === "git_commit") {
                return;
            }

            if (tab.kind === "review") {
                return;
            }

            if (tab.kind === "terminal") {
                await bootTerminalSession(get, set, tab.id);
                return;
            }

            await loadFileTabDocument(get, set, tab.id);
        }),
    );
}

function persistWorkspaceState(get: GetWorkspaceState): Promise<void> {
    scheduleWorkspacePersistence(get);
    return Promise.resolve();
}

export async function flushWorkspacePersistenceForTests(): Promise<void> {
    await flushWorkspacePersistence(undefined, { force: true });
}

export function resetWorkspacePersistenceForTests(): void {
    if (pendingWorkspacePersistTimer !== null) {
        clearTimeout(pendingWorkspacePersistTimer);
        pendingWorkspacePersistTimer = null;
    }

    workspacePersistDirty = false;
    workspacePersistGet = null;
    workspacePersistInFlight = null;
}

function scheduleWorkspacePersistence(get: GetWorkspaceState): void {
    workspacePersistGet = get;
    workspacePersistDirty = true;

    if (
        pendingWorkspacePersistTimer !== null ||
        workspacePersistInFlight !== null
    ) {
        return;
    }

    // Buffer persistence to avoid serializing snapshots for every transient UI mutation.
    pendingWorkspacePersistTimer = setTimeout(() => {
        pendingWorkspacePersistTimer = null;
        void flushWorkspacePersistence();
    }, WORKSPACE_PERSIST_DEBOUNCE_MS);
}

async function flushWorkspacePersistence(
    get?: GetWorkspaceState,
    options: {
        readonly force?: boolean;
    } = {},
): Promise<void> {
    if (get) {
        workspacePersistGet = get;
    }

    if (options.force) {
        workspacePersistDirty = true;
    }

    if (!workspacePersistGet) {
        return;
    }

    if (pendingWorkspacePersistTimer !== null) {
        clearTimeout(pendingWorkspacePersistTimer);
        pendingWorkspacePersistTimer = null;
    }

    if (workspacePersistInFlight) {
        await workspacePersistInFlight;

        if (workspacePersistDirty) {
            await flushWorkspacePersistence();
        }

        return;
    }

    if (!workspacePersistDirty) {
        return;
    }

    workspacePersistDirty = false;
    const persistPromise = persistWorkspaceStateNow(workspacePersistGet);
    workspacePersistInFlight = persistPromise;

    try {
        await persistPromise;
    } finally {
        if (workspacePersistInFlight === persistPromise) {
            workspacePersistInFlight = null;
        }
    }

    if (workspacePersistDirty) {
        await flushWorkspacePersistence();
    }
}

async function persistWorkspaceStateNow(get: GetWorkspaceState): Promise<void> {
    try {
        const state = get();
        await getComandoApi().saveWorkspaceSnapshot(
            workspaceStateToSnapshot(state),
        );
    } catch {
        return;
    }
}

async function loadFileTabDocument(
    get: GetWorkspaceState,
    set: WorkspaceSetState,
    tabId: string,
): Promise<void> {
    const tab = get().tabsById[tabId];
    if (!tab || tab.kind !== "file" || tab.isTransient) {
        return;
    }

    const hasSiblingLoadInFlight = Object.values(get().tabsById).some(
        (candidate): candidate is RuntimeWorkspaceFileTab =>
            candidate.kind === "file" &&
            candidate.id !== tab.id &&
            candidate.projectId === tab.projectId &&
            normalizeWorktreeId(candidate.worktreeId) ===
                normalizeWorktreeId(tab.worktreeId) &&
            candidate.relativePath === tab.relativePath &&
            candidate.isLoading,
    );
    if (hasSiblingLoadInFlight) {
        return;
    }

    try {
        set((state) => ({
            ...setFileTabLoading(state, tabId, true),
            error: null,
        }));

        const document = await getComandoApi().openProjectFile({
            projectId: tab.projectId,
            relativePath: tab.relativePath,
            worktreeId: tab.worktreeId ?? null,
        });

        set((state) => ({
            ...replaceFileDocument(state, tabId, document),
            error: null,
        }));
    } catch (error) {
        set((state) => ({
            ...setFileTabLoadError(
                state,
                tabId,
                error instanceof Error
                    ? error.message
                    : "Could not reload this file.",
            ),
            error:
                error instanceof Error
                    ? error.message
                    : "Could not refresh the open workspace tabs.",
        }));
    }
}

async function bootTerminalSession(
    get: GetWorkspaceState,
    set: WorkspaceSetState,
    tabId: string,
): Promise<void> {
    const tab = get().tabsById[tabId];
    if (!tab || tab.kind !== "terminal") {
        return;
    }

    try {
        const session = await getComandoApi().createTerminalSession({
            preferredSessionId: tab.sessionId,
            projectId: tab.projectId,
            worktreeId: tab.worktreeId ?? null,
        });

        set((state) => ({
            ...setTerminalSessionReady(state, tabId, session),
            error: null,
        }));
    } catch (error) {
        set((state) => ({
            ...setTerminalLaunchError(
                state,
                tabId,
                error instanceof Error
                    ? error.message
                    : "Could not create the terminal session.",
            ),
            error:
                error instanceof Error
                    ? error.message
                    : "Could not create the terminal session.",
        }));
    }
}

async function safeCloseTerminal(sessionId: string): Promise<void> {
    try {
        await getComandoApi().closeTerminalSession(sessionId);
    } catch {
        return;
    }
}

async function safeCloseAiSession(sessionId: string): Promise<void> {
    try {
        await getComandoApi().closeAiSession(sessionId);
    } catch {
        return;
    }
}

function countTabs(
    get: GetWorkspaceState,
    kind: RuntimeWorkspaceTab["kind"],
): number {
    return Object.values(get().tabsById).filter((tab) => tab.kind === kind)
        .length;
}

function countRuntimeChatTabs(
    get: GetWorkspaceState,
    runtimeId: AiRuntimeId,
): number {
    return Object.values(get().tabsById).filter(
        (tab) => tab.kind === "chat" && tab.runtimeId === runtimeId,
    ).length;
}

function getFileTitle(relativePath: string): string {
    return relativePath.split("/").at(-1) ?? relativePath;
}

const CHAT_IMAGE_PROJECT_ID = "__comando_chat_images__";
const CHAT_IMAGE_PATH_PREFIX = ".comando/chat-images";

function buildChatImageTab(
    attachment: AiImageAttachment,
): RuntimeWorkspaceFileTab {
    const title = getChatImageTitle(attachment);
    const relativePath = buildChatImageRelativePath(attachment, title);
    const document = buildChatImageDocument(attachment, relativePath, title);

    return {
        createdAt: new Date().toISOString(),
        document,
        draftContent: document.content,
        hasExternalChange: false,
        id: crypto.randomUUID(),
        isDirty: false,
        isLoading: false,
        isSaving: false,
        isTransient: true,
        kind: "file",
        loadError: null,
        projectId: CHAT_IMAGE_PROJECT_ID,
        relativePath,
        reviewContext: null,
        savedContent: document.content,
        saveError: null,
        title,
        viewState: null,
        worktreeId: null,
    };
}

function buildChatImageDocument(
    attachment: AiImageAttachment,
    relativePath: string,
    title: string,
): ProjectFileDocument {
    return {
        absolutePath: `comando://chat-attachments/${relativePath}`,
        content: "",
        imageDataBase64: attachment.dataBase64,
        isBinary: true,
        isTooLarge: false,
        kind: "image",
        languageId: "image",
        languageLabel: "Image",
        mimeType: attachment.mimeType,
        modifiedAtMs: Date.now(),
        name: title,
        projectId: CHAT_IMAGE_PROJECT_ID,
        relativePath,
        sizeBytes: attachment.sizeBytes ?? estimateBase64Size(attachment.dataBase64),
    };
}

function buildChatImageRelativePath(
    attachment: AiImageAttachment,
    title: string,
): string {
    const safeId = attachment.id.replace(/[^a-zA-Z0-9._-]+/g, "-");
    const safeTitle = title.replace(/[^a-zA-Z0-9._-]+/g, "-");
    return `${CHAT_IMAGE_PATH_PREFIX}/${safeId}-${safeTitle}`;
}

function getChatImageTitle(attachment: AiImageAttachment): string {
    const normalizedName = attachment.name?.trim();
    if (normalizedName) {
        return normalizedName;
    }

    const extension = getChatImageExtension(attachment.mimeType);
    return extension ? `Screenshot.${extension}` : "Screenshot";
}

function getChatImageExtension(mimeType: string): string | null {
    const normalizedMimeType = mimeType.trim().toLowerCase();
    const extension =
        normalizedMimeType.split("/")[1]?.split(";")[0]?.split("+")[0] ?? "";

    if (!extension) {
        return null;
    }

    if (extension === "jpeg") {
        return "jpg";
    }

    return extension;
}

function estimateBase64Size(dataBase64: string): number {
    const padding = dataBase64.endsWith("==")
        ? 2
        : dataBase64.endsWith("=")
          ? 1
          : 0;

    return Math.max(0, Math.floor((dataBase64.length * 3) / 4) - padding);
}

function isProjectFileConflictMessage(message: string): boolean {
    return /changed on disk/i.test(message);
}

function findExistingFileTabs(
    state: WorkspaceTreeState,
    projectId: string,
    relativePath: string,
    worktreeId: string | null,
): RuntimeWorkspaceFileTab[] {
    return Object.values(state.tabsById).filter(
        (tab): tab is RuntimeWorkspaceFileTab =>
            tab.kind === "file" &&
            tab.projectId === projectId &&
            normalizeWorktreeId(tab.worktreeId) ===
                normalizeWorktreeId(worktreeId) &&
            tab.relativePath === relativePath,
    );
}

function findExistingReviewTab(
    state: WorkspaceTreeState,
    sessionId: string,
): RuntimeWorkspaceReviewTab | null {
    return (
        Object.values(state.tabsById).find(
            (tab): tab is RuntimeWorkspaceReviewTab =>
                tab.kind === "review" && tab.sessionId === sessionId,
        ) ?? null
    );
}

function findExistingChatTabBySessionId(
    state: WorkspaceTreeState,
    sessionId: string,
): WorkspaceChatTab | null {
    return (
        Object.values(state.tabsById).find(
            (tab): tab is WorkspaceChatTab =>
                tab.kind === "chat" && tab.sessionId === sessionId,
        ) ?? null
    );
}

function findExistingGitTab(
    state: WorkspaceTreeState,
    projectId: string,
    worktreeId: string | null,
): RuntimeWorkspaceGitTab | null {
    return (
        Object.values(state.tabsById).find(
            (tab): tab is RuntimeWorkspaceGitTab =>
                tab.kind === "git" &&
                tab.projectId === projectId &&
                normalizeWorktreeId(tab.worktreeId) ===
                    normalizeWorktreeId(worktreeId),
        ) ?? null
    );
}

function findExistingChatHistoryTab(
    state: WorkspaceTreeState,
    projectId: string | null,
    worktreeId: string | null,
): RuntimeWorkspaceChatHistoryTab | null {
    return (
        Object.values(state.tabsById).find(
            (tab): tab is RuntimeWorkspaceChatHistoryTab =>
                tab.kind === "chat_history" &&
                tab.projectId === projectId &&
                normalizeWorktreeId(tab.worktreeId) ===
                    normalizeWorktreeId(worktreeId),
        ) ?? null
    );
}

function findExistingGitCommitTab(
    state: WorkspaceTreeState,
    projectId: string | null,
    commitSha: string,
    worktreeId: string | null,
): RuntimeWorkspaceGitCommitTab | null {
    return (
        Object.values(state.tabsById).find(
            (tab): tab is RuntimeWorkspaceGitCommitTab =>
                tab.kind === "git_commit" &&
                tab.projectId === projectId &&
                normalizeWorktreeId(tab.worktreeId) ===
                    normalizeWorktreeId(worktreeId) &&
                tab.commitSha === commitSha,
        ) ?? null
    );
}

function findPaneIdByTabId(
    state: WorkspaceTreeState,
    tabId: string,
): string | null {
    const panesToVisit = [state.rootNode];

    while (panesToVisit.length > 0) {
        const currentNode = panesToVisit.shift();
        if (!currentNode) {
            break;
        }

        if (currentNode.type === "pane") {
            if (currentNode.tabIds.includes(tabId)) {
                return currentNode.id;
            }
            continue;
        }

        panesToVisit.push(...currentNode.children);
    }

    return null;
}

function getComandoApi() {
    if (!window.comando) {
        throw new Error(
            "The desktop bridge is not available yet. Restart the Electron app and try again.",
        );
    }

    return window.comando;
}

function normalizeWorktreeId(
    worktreeId: string | null | undefined,
): string | null {
    return worktreeId ?? null;
}

function isFileTabAffectedByProjectInvalidation(
    tabRelativePath: string,
    invalidatedRelativePaths: readonly string[] | null | undefined,
): boolean {
    if (!invalidatedRelativePaths || invalidatedRelativePaths.length === 0) {
        return true;
    }

    return invalidatedRelativePaths.some((invalidatedRelativePath) =>
        doProjectPathsOverlap(tabRelativePath, invalidatedRelativePath),
    );
}

function doProjectPathsOverlap(leftPath: string, rightPath: string): boolean {
    return (
        leftPath === rightPath ||
        leftPath.startsWith(`${rightPath}/`) ||
        rightPath.startsWith(`${leftPath}/`)
    );
}
