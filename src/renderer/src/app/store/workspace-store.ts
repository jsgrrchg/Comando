import type { editor as MonacoEditor } from "monaco-editor";
import { create } from "zustand";

import type {
    AiImageAttachment,
    AiRuntimeId,
    GitHubRepositoryRef,
    ProjectFileDocument,
    WorkspaceChatHistoryTab,
    WorkspaceChatTab,
    WorkspaceGitCommitTab,
    WorkspaceGitWorktreeDiffTab,
    WorkspaceGitHubIssueTab,
    WorkspaceGitHubIssuesTab,
    WorkspaceGitHubPullRequestTab,
    WorkspaceGitHubPullRequestsTab,
    WorkspaceGitTab,
    WorkspaceReviewTab,
    WorkspaceSnapshot,
} from "@shared/ipc";

import {
    activatePane,
    attachTabToPaneAtIndex,
    attachTabToPane,
    collectPaneNodes,
    closeWorkspacePane,
    closeWorkspaceTab,
    completeFileSave,
    createDefaultWorkspaceState,
    findPaneById,
    moveActiveTabBetweenPanes,
    moveTabToPaneAtIndex,
    moveTabToSplit,
    moveWorkspaceTabBetweenPanes,
    pinTabInPane,
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
    splitPaneInDirection,
    unpinTabInPane,
    updateChatDraft,
    updateFileDraft as applyFileDraft,
    workspaceStateFromSnapshot,
    workspaceStateToSnapshot,
    type RuntimeWorkspaceChatHistoryTab,
    type RuntimeWorkspaceGitCommitTab,
    type RuntimeWorkspaceGitWorktreeDiffTab,
    type RuntimeWorkspaceGitHubIssueTab,
    type RuntimeWorkspaceGitHubIssuesTab,
    type RuntimeWorkspaceGitHubPullRequestTab,
    type RuntimeWorkspaceGitHubPullRequestsTab,
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
import { areGitWorktreeIdsEquivalent } from "../git/context-key";
import { useTerminalRuntimeStore } from "@renderer/features/terminal/terminalRuntimeStore";
import { useAiStore } from "./ai-store";
import { useProjectsStore } from "./projects-store";

export type WorkspaceQuickCreateAction =
    | "claude"
    | "codex"
    | "gemini"
    | "git"
    | "grok"
    | "history"
    | "kilo"
    | "opencode"
    | "file"
    | "terminal";

export type WorkspaceOpenTarget =
    | {
          readonly insertIndex?: number;
          readonly paneId: string;
          readonly type: "pane";
      }
    | {
          readonly direction: SplitDirection;
          readonly insertIndex?: number;
          readonly paneId: string;
          readonly type: "split";
      };

interface WorkspaceStore extends WorkspaceTreeState {
    closeOtherTabs: (tabId: string) => Promise<void>;
    readonly error: string | null;
    readonly hydrated: boolean;
    readonly lastFocusedChatTabId: string | null;
    readonly lastFocusedRuntimeId: AiRuntimeId;
    readonly lastQuickCreateAction: WorkspaceQuickCreateAction;
    readonly recentActiveTabIds: readonly string[];
    readonly recentClosedTabs: readonly ClosedWorkspaceTabEntry[];
    readonly recentFocusedChatTabIds: readonly string[];
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
        options?: {
            readonly paneId?: string | null;
            readonly title?: string;
        },
    ) => Promise<string | null>;
    openChatSessionTab: (input: {
        readonly preserveSourcePaneOnMove?: boolean;
        readonly projectId: string | null;
        readonly runtimeId: AiRuntimeId;
        readonly sessionId: string;
        readonly targetIndex?: number;
        readonly targetPaneId?: string | null;
        readonly title: string;
        readonly worktreeId?: string | null;
    }) => Promise<void>;
    openChatSessionTabAtTarget: (input: {
        readonly projectId: string | null;
        readonly runtimeId: AiRuntimeId;
        readonly sessionId: string;
        readonly target: WorkspaceOpenTarget;
        readonly title: string;
        readonly worktreeId?: string | null;
    }) => Promise<string | null>;
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
    openGitWorktreeDiffTab: (
        projectId: string,
        worktreeId?: string | null,
    ) => Promise<void>;
    openGitHubIssuesTab: (input: {
        readonly projectId: string | null;
        readonly ref: GitHubRepositoryRef;
        readonly worktreeId?: string | null;
    }) => Promise<void>;
    openGitHubIssuesTabAtTarget: (input: {
        readonly projectId: string | null;
        readonly ref: GitHubRepositoryRef;
        readonly target: WorkspaceOpenTarget;
        readonly worktreeId?: string | null;
    }) => Promise<string | null>;
    openGitHubIssueTab: (input: {
        readonly issueNumber: number;
        readonly projectId: string | null;
        readonly ref: GitHubRepositoryRef;
        readonly worktreeId?: string | null;
    }) => Promise<void>;
    openGitHubIssueTabAtTarget: (input: {
        readonly issueNumber: number;
        readonly projectId: string | null;
        readonly ref: GitHubRepositoryRef;
        readonly target: WorkspaceOpenTarget;
        readonly worktreeId?: string | null;
    }) => Promise<string | null>;
    openGitHubPullRequestsTab: (input: {
        readonly projectId: string | null;
        readonly ref: GitHubRepositoryRef;
        readonly worktreeId?: string | null;
    }) => Promise<void>;
    openGitHubPullRequestsTabAtTarget: (input: {
        readonly projectId: string | null;
        readonly ref: GitHubRepositoryRef;
        readonly target: WorkspaceOpenTarget;
        readonly worktreeId?: string | null;
    }) => Promise<string | null>;
    openGitHubPullRequestTab: (input: {
        readonly projectId: string | null;
        readonly pullRequestNumber: number;
        readonly ref: GitHubRepositoryRef;
        readonly worktreeId?: string | null;
    }) => Promise<void>;
    openGitHubPullRequestTabAtTarget: (input: {
        readonly projectId: string | null;
        readonly pullRequestNumber: number;
        readonly ref: GitHubRepositoryRef;
        readonly target: WorkspaceOpenTarget;
        readonly worktreeId?: string | null;
    }) => Promise<string | null>;
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
        targetIndex?: number,
    ) => Promise<void>;
    openFileTabAtTarget: (input: {
        readonly projectId: string;
        readonly relativePath: string;
        readonly reviewContext?: RuntimeWorkspaceFileReviewContext | null;
        readonly target: WorkspaceOpenTarget;
        readonly worktreeId?: string | null;
    }) => Promise<string | null>;
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
    reopenLastClosedTab: () => Promise<void>;
    removeProjectTabs: (projectId: string) => Promise<void>;
    pinPaneTab: (paneId: string, tabId: string) => Promise<void>;
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
    closeTabsForProjectPaths: (
        projectId: string,
        worktreeId: string | null,
        entries: readonly {
            readonly kind: "directory" | "file";
            readonly relativePath: string;
        }[],
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
    setLastFocusedRuntimeId: (runtimeId: AiRuntimeId) => void;
    setLastQuickCreateAction: (action: WorkspaceQuickCreateAction) => void;
    setActivePane: (paneId: string) => Promise<void>;
    splitPane: (paneId: string, direction: SplitDirection) => Promise<void>;
    togglePaneTabPinned: (paneId: string, tabId: string) => Promise<void>;
    unpinPaneTab: (paneId: string, tabId: string) => Promise<void>;
    updateChatDraft: (tabId: string, draft: string) => Promise<void>;
    updateFileDraft: (tabId: string, draft: string) => void;
    updateFileViewState: (
        tabId: string,
        viewState: MonacoEditor.ICodeEditorViewState | null,
    ) => void;
    updateSessionTabTitles: (
        sessionId: string,
        title: string,
    ) => Promise<void>;
    updateTerminalTabTitle: (tabId: string, title: string) => Promise<void>;
}

type GetWorkspaceState = () => WorkspaceStore;

interface ClosedWorkspaceTabEntry {
    readonly paneId: string;
    readonly tab: RuntimeWorkspaceTab;
    readonly tabIndex: number;
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
    ...createDefaultWorkspaceState(),
    error: null,
    hydrated: false,
    lastFocusedChatTabId: null,
    lastFocusedRuntimeId: "codex",
    lastQuickCreateAction: "codex",
    recentActiveTabIds: [],
    recentClosedTabs: [],
    recentFocusedChatTabIds: [],

    closeOtherTabs: async (tabId) => {
        const paneId = findPaneIdByTabId(get(), tabId);
        if (!paneId) {
            return;
        }

        const pane = findPaneById(get().rootNode, paneId);
        if (!pane) {
            return;
        }

        const tabIdsToClose = pane.tabIds.filter(
            (currentTabId) => currentTabId !== tabId,
        );
        await closeTabsWithSideEffects(get, set, tabIdsToClose);
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
        const workspaceState = get();
        const workspaceTabs = Object.keys(workspaceState.tabsById).map(
            (tabId) => workspaceState.tabsById[tabId],
        );
        const fileTabsToClose: RuntimeWorkspaceFileTab[] = [];

        for (const tab of workspaceTabs) {
            if (tab.kind !== "file") {
                continue;
            }

            const matchesRelativePath =
                kind === "file"
                    ? tab.relativePath === relativePath
                    : tab.relativePath === relativePath ||
                      tab.relativePath.startsWith(`${relativePath}/`);

            if (
                tab.projectId === projectId &&
                normalizeWorktreeId(tab.worktreeId) ===
                    normalizeWorktreeId(worktreeId) &&
                matchesRelativePath
            ) {
                fileTabsToClose.push(tab);
            }
        }

        const tabIdsToClose = fileTabsToClose.map((tab) => tab.id);
        await closeTabsWithSideEffects(get, set, tabIdsToClose);
    },

    closeTabsForProjectPaths: async (
        projectId: string,
        worktreeId: string | null,
        entries: readonly {
            readonly kind: "directory" | "file";
            readonly relativePath: string;
        }[],
    ) => {
        if (entries.length === 0) {
            return;
        }

        const workspaceState = get();
        const tabIdsToClose = Object.values(workspaceState.tabsById)
            .filter((tab): tab is RuntimeWorkspaceFileTab => {
                if (
                    tab.kind !== "file" ||
                    tab.projectId !== projectId ||
                    normalizeWorktreeId(tab.worktreeId) !==
                        normalizeWorktreeId(worktreeId)
                ) {
                    return false;
                }

                return entries.some((entry) =>
                    entry.kind === "file"
                        ? tab.relativePath === entry.relativePath
                        : tab.relativePath === entry.relativePath ||
                          tab.relativePath.startsWith(
                              `${entry.relativePath}/`,
                          ),
                );
            })
            .map((tab) => tab.id);

        await closeTabsWithSideEffects(get, set, tabIdsToClose);
    },

    closeTabsToRight: async (tabId) => {
        const paneId = findPaneIdByTabId(get(), tabId);
        if (!paneId) {
            return;
        }

        const pane = findPaneById(get().rootNode, paneId);
        if (!pane) {
            return;
        }

        const tabIndex = pane.tabIds.indexOf(tabId);
        if (tabIndex === -1 || tabIndex === pane.tabIds.length - 1) {
            return;
        }

        await closeTabsWithSideEffects(get, set, pane.tabIds.slice(tabIndex + 1));
    },

    closeTab: async (tabId) => {
        await closeTabsWithSideEffects(get, set, [tabId]);
    },

    createChatTab: async (
        projectId: string | null,
        worktreeId: string | null = null,
        runtimeId: AiRuntimeId = "codex",
    ) => {
        const paneId = get().activePaneId;
        const runtimeTitle = getRuntimeDisplayName(runtimeId);
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

    createTerminalTab: async (projectId, worktreeId = null, options) => {
        const requestedPaneId = options?.paneId ?? get().activePaneId;
        const paneId = findPaneById(get().rootNode, requestedPaneId)
            ? requestedPaneId
            : get().activePaneId;
        const terminalId = crypto.randomUUID();
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
            sessionId: terminalId,
            signalCode: null,
            terminalId,
            title:
                options?.title ??
                getNextTerminalTabTitle(Object.values(get().tabsById)),
            worktreeId,
        };

        set((state) => ({
            ...attachTabToPane(state, paneId, tab),
            error: null,
            lastQuickCreateAction: "terminal",
            recentActiveTabIds: recordRecentTabActivation(
                state.recentActiveTabIds,
                tab.id,
            ),
        }));
        await persistWorkspaceState(get);
        return tab.id;
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
            const requestedPaneId = getValidPaneId(
                get(),
                input.targetPaneId ?? null,
            );
            const targetPaneId = requestedPaneId ?? paneId;
            const shouldMoveToTarget =
                requestedPaneId !== null &&
                (targetPaneId !== paneId || input.targetIndex !== undefined);

            set((state) => ({
                ...(shouldMoveToTarget
                    ? moveExistingTabToTarget(
                          {
                              ...state,
                              tabsById: {
                                  ...state.tabsById,
                                  [existingTab.id]: nextTab,
                              },
                          },
                          existingTab.id,
                          paneId,
                          targetPaneId,
                          input.targetIndex ?? Number.POSITIVE_INFINITY,
                          input.preserveSourcePaneOnMove === true,
                      )
                    : selectPaneTab(
                          {
                              ...state,
                              tabsById: {
                                  ...state.tabsById,
                                  [existingTab.id]: nextTab,
                              },
                          },
                          paneId,
                          existingTab.id,
                      )),
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
            ...(input.targetIndex === undefined
                ? attachTabToPane(state, resolvedPaneId, tab)
                : attachTabToPaneAtIndex(
                      state,
                      resolvedPaneId,
                      tab,
                      input.targetIndex,
                  )),
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

    openChatSessionTabAtTarget: async (input) => {
        const paneId = ensureWorkspaceOpenTargetPane(get, set, input.target);
        if (!paneId) {
            return null;
        }

        await get().openChatSessionTab({
            projectId: input.projectId,
            runtimeId: input.runtimeId,
            sessionId: input.sessionId,
            preserveSourcePaneOnMove: input.target.type === "split",
            targetIndex: getWorkspaceOpenTargetInsertIndex(input.target),
            targetPaneId: paneId,
            title: input.title,
            worktreeId: input.worktreeId ?? null,
        });

        return findExistingChatTabBySessionId(get(), input.sessionId)?.id ?? null;
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

    openGitWorktreeDiffTab: async (projectId, worktreeId = null) => {
        const existingTab = findExistingGitWorktreeDiffTab(
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
                lastQuickCreateAction: "git",
                recentActiveTabIds: recordRecentTabActivation(
                    state.recentActiveTabIds,
                    existingTab.id,
                ),
            }));
            await persistWorkspaceState(get);
            return;
        }

        const tab: WorkspaceGitWorktreeDiffTab = {
            createdAt: new Date().toISOString(),
            id: crypto.randomUUID(),
            kind: "git_worktree_diff",
            projectId,
            title: "Uncommitted Changes",
            worktreeId: worktreeId ?? null,
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

    openGitHubIssuesTab: async (input) => {
        await openGitHubWorkspaceTab(get, set, {
            kind: "github_issues",
            projectId: input.projectId,
            ref: input.ref,
            title: "Issues",
            worktreeId: input.worktreeId ?? null,
        });
    },

    openGitHubIssuesTabAtTarget: async (input): Promise<string | null> =>
        await openGitHubWorkspaceTabAtTarget(
            get,
            set,
            {
                kind: "github_issues",
                projectId: input.projectId,
                ref: input.ref,
                title: "Issues",
                worktreeId: input.worktreeId ?? null,
            },
            input.target,
        ),

    openGitHubIssueTab: async (input) => {
        await openGitHubWorkspaceTab(get, set, {
            issueNumber: input.issueNumber,
            kind: "github_issue",
            projectId: input.projectId,
            ref: input.ref,
            title: `#${input.issueNumber}`,
            worktreeId: input.worktreeId ?? null,
        });
    },

    openGitHubIssueTabAtTarget: async (input): Promise<string | null> =>
        await openGitHubWorkspaceTabAtTarget(
            get,
            set,
            {
                issueNumber: input.issueNumber,
                kind: "github_issue",
                projectId: input.projectId,
                ref: input.ref,
                title: `#${input.issueNumber}`,
                worktreeId: input.worktreeId ?? null,
            },
            input.target,
        ),

    openGitHubPullRequestsTab: async (input) => {
        await openGitHubWorkspaceTab(get, set, {
            kind: "github_pull_requests",
            projectId: input.projectId,
            ref: input.ref,
            title: "Pull Requests",
            worktreeId: input.worktreeId ?? null,
        });
    },

    openGitHubPullRequestsTabAtTarget: async (
        input,
    ): Promise<string | null> =>
        await openGitHubWorkspaceTabAtTarget(
            get,
            set,
            {
                kind: "github_pull_requests",
                projectId: input.projectId,
                ref: input.ref,
                title: "Pull Requests",
                worktreeId: input.worktreeId ?? null,
            },
            input.target,
        ),

    openGitHubPullRequestTab: async (input) => {
        await openGitHubWorkspaceTab(get, set, {
            kind: "github_pull_request",
            projectId: input.projectId,
            pullRequestNumber: input.pullRequestNumber,
            ref: input.ref,
            title: `PR #${input.pullRequestNumber}`,
            worktreeId: input.worktreeId ?? null,
        });
    },

    openGitHubPullRequestTabAtTarget: async (
        input,
    ): Promise<string | null> =>
        await openGitHubWorkspaceTabAtTarget(
            get,
            set,
            {
                kind: "github_pull_request",
                projectId: input.projectId,
                pullRequestNumber: input.pullRequestNumber,
                ref: input.ref,
                title: `PR #${input.pullRequestNumber}`,
                worktreeId: input.worktreeId ?? null,
            },
            input.target,
        ),

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
            const movedTabId = getPaneActiveTabId(state, paneId);
            const sourcePaneFallbackTabId = movedTabId
                ? getSourcePaneFallbackTabIdAfterMove(state, paneId, movedTabId)
                : null;
            const movedState = moveActiveTabBetweenPanes(
                state,
                paneId,
                direction,
            );
            const nextState = restoreSourcePaneActiveTabAfterMove(
                movedState,
                paneId,
                sourcePaneFallbackTabId,
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
            const sourcePaneId = findPaneIdByTabId(state, tabId);
            const sourcePaneFallbackTabId = sourcePaneId
                ? getSourcePaneFallbackTabIdAfterMove(
                      state,
                      sourcePaneId,
                      tabId,
                  )
                : null;
            const movedState = moveWorkspaceTabBetweenPanes(
                state,
                tabId,
                direction,
            );
            const nextState =
                sourcePaneId === null
                    ? movedState
                    : restoreSourcePaneActiveTabAfterMove(
                          movedState,
                          sourcePaneId,
                          sourcePaneFallbackTabId,
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
            const sourcePaneFallbackTabId = getSourcePaneFallbackTabIdAfterMove(
                state,
                sourcePaneId,
                tabId,
            );
            const movedState = moveTabToPaneAtIndex(
                state,
                tabId,
                sourcePaneId,
                targetPaneId,
                targetIndex,
            );
            const nextState = restoreSourcePaneActiveTabAfterMove(
                movedState,
                sourcePaneId,
                sourcePaneFallbackTabId,
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
        targetIndex?: number,
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
                            : restoreSourcePaneActiveTabAfterMove(
                                  moveTabToPaneAtIndex(
                                      state,
                                      existingTabInResolvedPane.id,
                                      paneId,
                                      resolvedPaneId,
                                      Number.POSITIVE_INFINITY,
                                  ),
                                  paneId,
                                  getSourcePaneFallbackTabIdAfterMove(
                                      state,
                                      paneId,
                                      existingTabInResolvedPane.id,
                                  ),
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
                    ...(targetIndex === undefined
                        ? attachTabToPane(state, resolvedPaneId, duplicatedTab)
                        : attachTabToPaneAtIndex(
                              state,
                              resolvedPaneId,
                              duplicatedTab,
                              targetIndex,
                          )),
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
                ...(targetIndex === undefined
                    ? attachTabToPane(state, resolvedPaneId, tab)
                    : attachTabToPaneAtIndex(
                          state,
                          resolvedPaneId,
                          tab,
                          targetIndex,
                      )),
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

    openFileTabAtTarget: async (input) => {
        const paneId = ensureWorkspaceOpenTargetPane(get, set, input.target);
        if (!paneId) {
            return null;
        }

        await get().openFileTab(
            input.projectId,
            input.relativePath,
            input.worktreeId ?? null,
            input.reviewContext ?? null,
            paneId,
            getWorkspaceOpenTargetInsertIndex(input.target),
        );

        return paneId;
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
                    : restoreSourcePaneActiveTabAfterMove(
                          moveTabToPaneAtIndex(
                              state,
                              existingTabInResolvedPane.id,
                              paneId,
                              resolvedPaneId,
                              Number.POSITIVE_INFINITY,
                          ),
                          paneId,
                          getSourcePaneFallbackTabIdAfterMove(
                              state,
                              paneId,
                              existingTabInResolvedPane.id,
                          ),
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

    reopenLastClosedTab: async () => {
        const closedEntry = get().recentClosedTabs[0] ?? null;
        if (!closedEntry) {
            return;
        }

        const restoredTab = createRestoredTab(closedEntry.tab);

        set((state) => restoreClosedTabInStore(state, closedEntry, restoredTab));
        await persistWorkspaceState(get);
        await restoreTabSideEffects(restoredTab, get, set);
    },

    removeProjectTabs: async (projectId) => {
        const tabIdsToClose = Object.values(get().tabsById)
            .filter((tab) => tab.projectId === projectId)
            .map((tab) => tab.id);
        await closeTabsWithSideEffects(get, set, tabIdsToClose);
    },

    pinPaneTab: async (paneId, tabId) => {
        set((state) => ({
            ...pinTabInPane(state, paneId, tabId),
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

        set((state) => ({
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
        await useTerminalRuntimeStore.getState().restart(tab.terminalId);
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

        const savedDraftContent = tab.draftContent;

        try {
            const document = await getComandoApi().saveProjectFile({
                content: savedDraftContent,
                expectedModifiedAtMs: options?.force
                    ? null
                    : tab.document.modifiedAtMs,
                projectId: tab.projectId,
                relativePath: tab.relativePath,
                worktreeId: tab.worktreeId ?? null,
            });

            set((state) => ({
                ...completeFileSave(state, tabId, document, savedDraftContent),
                error: null,
            }));
            const currentTab = get().tabsById[tabId];
            const currentBufferContent =
                currentTab?.kind === "file" &&
                currentTab.document?.absolutePath === document.absolutePath &&
                currentTab.isDirty
                    ? currentTab.draftContent
                    : null;
            void getComandoApi().notifyFileBuffer({
                absolutePath: document.absolutePath,
                content: currentBufferContent,
            });
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
        const activeTabId = getPaneActiveTabId(get(), paneId);
        const activeTab = activeTabId ? get().tabsById[activeTabId] : null;
        if (activeTab?.kind === "chat" || activeTab?.kind === "review") {
            void useAiStore.getState().ensureSession(activeTab, {
                force: true,
            });
        }
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
        const tab = get().tabsById[tabId];
        if (tab?.kind === "chat" || tab?.kind === "review") {
            void useAiStore.getState().ensureSession(tab, {
                force: true,
            });
        }
        await persistWorkspaceState(get);
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
            const sourcePaneFallbackTabId = getSourcePaneFallbackTabIdAfterMove(
                state,
                sourcePaneId,
                tabId,
            );
            const movedState = moveTabToSplit(
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
            const nextState = restoreSourcePaneActiveTabAfterMove(
                movedState,
                sourcePaneId,
                sourcePaneFallbackTabId,
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

    togglePaneTabPinned: async (paneId, tabId) => {
        const pane = findPaneById(get().rootNode, paneId);
        if (!pane || !pane.tabIds.includes(tabId)) {
            return;
        }

        if ((pane.pinnedTabIds ?? []).includes(tabId)) {
            await get().unpinPaneTab(paneId, tabId);
            return;
        }

        await get().pinPaneTab(paneId, tabId);
    },

    unpinPaneTab: async (paneId, tabId) => {
        set((state) => ({
            ...unpinTabInPane(state, paneId, tabId),
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
        const tab = get().tabsById[tabId];
        if (tab?.kind === "file" && tab.document) {
            void getComandoApi().notifyFileBuffer({
                absolutePath: tab.document.absolutePath,
                content: draft,
            });
        }
    },

    updateFileViewState: (tabId, viewState) => {
        set((state) => ({
            ...setFileTabViewState(state, tabId, viewState),
        }));
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
            ),
        }));
        await persistWorkspaceState(get);
    },

    updateTerminalTabTitle: async (tabId, title) => {
        set((state) => {
            const tab = state.tabsById[tabId];
            if (!tab || tab.kind !== "terminal" || tab.title === title) {
                return state;
            }

            return {
                ...state,
                tabsById: {
                    ...state.tabsById,
                    [tabId]: {
                        ...tab,
                        title,
                    },
                },
            };
        });
        await persistWorkspaceState(get);
    },
}));

type WorkspaceSetState = typeof useWorkspaceStore.setState;

const WORKSPACE_PERSIST_DEBOUNCE_MS = 180;
const MAX_RECENTLY_CLOSED_TABS = 20;

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

async function closeTabsWithSideEffects(
    get: GetWorkspaceState,
    set: WorkspaceSetState,
    tabIds: readonly string[],
): Promise<void> {
    const state = get();
    const normalizedTabIds = [...new Set(tabIds)].filter(
        (tabId) => state.tabsById[tabId],
    );
    if (normalizedTabIds.length === 0) {
        return;
    }

    await Promise.all(
        normalizedTabIds.map(async (tabId) => {
            const tab = state.tabsById[tabId];
            if (!tab) {
                return;
            }

            await closeTabSideEffects(tab);
        }),
    );

    set((currentState) =>
        normalizedTabIds.reduce(
            (nextState, tabId) => closeTabInStore(nextState, tabId),
            currentState,
        ),
    );
    await persistWorkspaceState(get);
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

function ensureWorkspaceOpenTargetPane(
    get: GetWorkspaceState,
    set: WorkspaceSetState,
    target: WorkspaceOpenTarget,
): string | null {
    if (target.type === "pane") {
        return getValidPaneId(get(), target.paneId);
    }

    if (!getValidPaneId(get(), target.paneId)) {
        return null;
    }

    const nextPaneId = crypto.randomUUID();
    set((state) => ({
        ...splitPaneInDirection(state, target.paneId, target.direction, {
            paneId: nextPaneId,
            splitId: crypto.randomUUID(),
        }),
        error: null,
    }));
    return nextPaneId;
}

function getWorkspaceOpenTargetInsertIndex(
    target: WorkspaceOpenTarget,
): number | undefined {
    if (target.type === "split") {
        return target.insertIndex ?? 0;
    }

    return target.insertIndex;
}

function getValidPaneId(
    state: WorkspaceTreeState,
    paneId: string | null,
): string | null {
    if (!paneId) {
        return null;
    }

    return collectPaneNodes(state.rootNode).some((pane) => pane.id === paneId)
        ? paneId
        : null;
}

function moveExistingTabToTarget(
    state: WorkspaceStore,
    tabId: string,
    sourcePaneId: string,
    targetPaneId: string,
    targetIndex: number,
    preserveEmptySourcePane: boolean,
): WorkspaceTreeState {
    const sourcePaneFallbackTabId = getSourcePaneFallbackTabIdAfterMove(
        state,
        sourcePaneId,
        tabId,
    );
    const movedState = moveTabToPaneAtIndex(
        state,
        tabId,
        sourcePaneId,
        targetPaneId,
        targetIndex,
        {
            preserveEmptySourcePane:
                preserveEmptySourcePane || sourcePaneId === targetPaneId,
        },
    );

    return sourcePaneId === targetPaneId || preserveEmptySourcePane
        ? movedState
        : restoreSourcePaneActiveTabAfterMove(
              movedState,
              sourcePaneId,
              sourcePaneFallbackTabId,
          );
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

function getSourcePaneFallbackTabIdAfterMove(
    state: Pick<WorkspaceStore, "recentActiveTabIds" | "rootNode">,
    paneId: string,
    movedTabId: string,
): string | null {
    const pane = collectPaneNodes(state.rootNode).find(
        (candidate) => candidate.id === paneId,
    );
    if (!pane || pane.activeTabId !== movedTabId) {
        return null;
    }

    const recentTabId = findMostRecentFocusedTabIdInPane(
        state,
        paneId,
        state.recentActiveTabIds,
        movedTabId,
    );
    if (recentTabId) {
        return recentTabId;
    }

    const movedTabIndex = pane.tabIds.indexOf(movedTabId);
    if (movedTabIndex === -1) {
        return null;
    }

    return (
        pane.tabIds[movedTabIndex - 1] ??
        pane.tabIds[movedTabIndex + 1] ??
        null
    );
}

function restoreSourcePaneActiveTabAfterMove(
    state: WorkspaceTreeState,
    sourcePaneId: string,
    fallbackTabId: string | null,
): WorkspaceTreeState {
    if (
        !fallbackTabId ||
        findPaneIdByTabId(state, fallbackTabId) !== sourcePaneId
    ) {
        return state;
    }

    return {
        ...selectPaneTab(state, sourcePaneId, fallbackTabId),
        activePaneId: state.activePaneId,
    };
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

function closeTabInStore(
    state: WorkspaceStore,
    tabId: string,
): WorkspaceStore {
    const closedEntry = buildClosedWorkspaceTabEntry(state, tabId);
    if (!closedEntry) {
        return state;
    }

    const paneId = closedEntry.paneId;
    const activeTabId = getPaneActiveTabId(state, paneId);
    const fallbackTabId =
        activeTabId === tabId
            ? findMostRecentFocusedTabIdInPane(
                  state,
                  paneId,
                  state.recentActiveTabIds,
                  tabId,
              )
            : null;
    const closedState = closeWorkspaceTab(state, tabId);
    const nextState =
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
              removeRecentTabActivation(state.recentActiveTabIds, tabId),
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
        ...state,
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
        recentClosedTabs: recordRecentlyClosedTab(
            state.recentClosedTabs,
            closedEntry,
        ),
        recentFocusedChatTabIds,
    };
}

function restoreClosedTabInStore(
    state: WorkspaceStore,
    closedEntry: ClosedWorkspaceTabEntry,
    restoredTab: RuntimeWorkspaceTab,
): WorkspaceStore {
    const targetPaneId = collectPaneNodes(state.rootNode).some(
        (pane) => pane.id === closedEntry.paneId,
    )
        ? closedEntry.paneId
        : state.activePaneId;
    const targetPane = findPaneById(state.rootNode, targetPaneId);
    if (!targetPane) {
        return {
            ...state,
            recentClosedTabs: state.recentClosedTabs.filter(
                (entry) => entry.tab.id !== closedEntry.tab.id,
            ),
        };
    }

    const nextState = attachTabToPaneAtIndex(
        state,
        targetPaneId,
        restoredTab,
        targetPaneId === closedEntry.paneId
            ? closedEntry.tabIndex
            : targetPane.tabIds.length,
    );
    const chatTabId = getWorkspaceChatTabId(restoredTab);
    const runtimeId = chatTabId ? null : getWorkspaceTabRuntimeId(restoredTab);

    return {
        ...state,
        ...nextState,
        error: null,
        lastFocusedChatTabId: state.lastFocusedChatTabId,
        lastFocusedRuntimeId: runtimeId ?? state.lastFocusedRuntimeId,
        recentActiveTabIds: recordRecentTabActivation(
            state.recentActiveTabIds,
            restoredTab.id,
        ),
        recentClosedTabs: state.recentClosedTabs.filter(
            (entry) => entry.tab.id !== closedEntry.tab.id,
        ),
        recentFocusedChatTabIds: state.recentFocusedChatTabIds,
    };
}

function buildClosedWorkspaceTabEntry(
    state: WorkspaceStore,
    tabId: string,
): ClosedWorkspaceTabEntry | null {
    const tab = state.tabsById[tabId];
    const paneId = findPaneIdByTabId(state, tabId);
    if (!tab || !paneId) {
        return null;
    }

    const pane = findPaneById(state.rootNode, paneId);
    if (!pane) {
        return null;
    }

    return {
        paneId,
        tab,
        tabIndex: Math.max(pane.tabIds.indexOf(tabId), 0),
    };
}

function recordRecentlyClosedTab(
    recentClosedTabs: readonly ClosedWorkspaceTabEntry[],
    closedEntry: ClosedWorkspaceTabEntry,
): readonly ClosedWorkspaceTabEntry[] {
    return [
        closedEntry,
        ...recentClosedTabs.filter(
            (entry) => entry.tab.id !== closedEntry.tab.id,
        ),
    ].slice(0, MAX_RECENTLY_CLOSED_TABS);
}

type GitHubWorkspaceTabInput =
    | Omit<WorkspaceGitHubIssuesTab, "createdAt" | "id">
    | Omit<WorkspaceGitHubIssueTab, "createdAt" | "id">
    | Omit<WorkspaceGitHubPullRequestsTab, "createdAt" | "id">
    | Omit<WorkspaceGitHubPullRequestTab, "createdAt" | "id">;

async function openGitHubWorkspaceTab(
    get: GetWorkspaceState,
    set: WorkspaceSetState,
    input: GitHubWorkspaceTabInput,
): Promise<void> {
    const existingTab = findExistingGitHubTab(get(), input);
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

    const tab = {
        ...input,
        createdAt: new Date().toISOString(),
        id: crypto.randomUUID(),
        worktreeId: input.worktreeId ?? null,
    } as RuntimeWorkspaceTab;

    set((state) => ({
        ...attachTabToPane(state, state.activePaneId, tab),
        error: null,
        recentActiveTabIds: recordRecentTabActivation(
            state.recentActiveTabIds,
            tab.id,
        ),
    }));
    await persistWorkspaceState(get);
}

async function openGitHubWorkspaceTabAtTarget(
    get: GetWorkspaceState,
    set: WorkspaceSetState,
    input: GitHubWorkspaceTabInput,
    target: WorkspaceOpenTarget,
): Promise<string | null> {
    const paneId = ensureWorkspaceOpenTargetPane(get, set, target);
    if (!paneId) {
        return null;
    }

    const targetIndex = getWorkspaceOpenTargetInsertIndex(target);
    const existingTab = findExistingGitHubTab(get(), input);
    if (existingTab) {
        const sourcePaneId = findPaneIdByTabId(get(), existingTab.id);
        if (!sourcePaneId) {
            return null;
        }
        const adjustedTargetIndex =
            targetIndex === undefined
                ? Number.POSITIVE_INFINITY
                : getExistingTabMoveTargetIndex(
                      get(),
                      existingTab.id,
                      sourcePaneId,
                      paneId,
                      targetIndex,
                  );

        set((state) => ({
            ...(sourcePaneId === paneId && targetIndex === undefined
                ? selectPaneTab(state, paneId, existingTab.id)
                : moveExistingTabToTarget(
                      state,
                      existingTab.id,
                      sourcePaneId,
                      paneId,
                      adjustedTargetIndex,
                      target.type === "split",
                  )),
            error: null,
            recentActiveTabIds: recordRecentTabActivation(
                state.recentActiveTabIds,
                existingTab.id,
            ),
        }));
        await persistWorkspaceState(get);
        return existingTab.id;
    }

    const tab = {
        ...input,
        createdAt: new Date().toISOString(),
        id: crypto.randomUUID(),
        worktreeId: input.worktreeId ?? null,
    } as RuntimeWorkspaceTab;

    set((state) => ({
        ...(targetIndex === undefined
            ? attachTabToPane(state, paneId, tab)
            : attachTabToPaneAtIndex(state, paneId, tab, targetIndex)),
        error: null,
        recentActiveTabIds: recordRecentTabActivation(
            state.recentActiveTabIds,
            tab.id,
        ),
    }));
    await persistWorkspaceState(get);
    return tab.id;
}

function getExistingTabMoveTargetIndex(
    state: WorkspaceTreeState,
    tabId: string,
    sourcePaneId: string,
    targetPaneId: string,
    targetIndex: number,
): number {
    if (sourcePaneId !== targetPaneId) {
        return targetIndex;
    }

    const pane = findPaneById(state.rootNode, sourcePaneId);
    const sourceIndex = pane?.tabIds.indexOf(tabId) ?? -1;
    if (sourceIndex < 0 || targetIndex <= sourceIndex) {
        return targetIndex;
    }

    return targetIndex - 1;
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

            if (tab.kind === "git_worktree_diff") {
                return [tab.id, tab] as const;
            }

            if (
                tab.kind === "github_issues" ||
                tab.kind === "github_issue" ||
                tab.kind === "github_pull_requests" ||
                tab.kind === "github_pull_request"
            ) {
                return [tab.id, tab] as const;
            }

            if (tab.kind === "review") {
                return [tab.id, tab] as const;
            }

            if (tab.kind === "terminal") {
                const terminalId = tab.terminalId ?? tab.sessionId;
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
                        terminalId,
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

            if (
                tab.kind === "github_issues" ||
                tab.kind === "github_issue" ||
                tab.kind === "github_pull_requests" ||
                tab.kind === "github_pull_request"
            ) {
                return;
            }

            if (tab.kind === "review") {
                return;
            }

            if (tab.kind === "terminal") {
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
    } catch (error) {
        // Workspace persistence failure silently loses layout/tabs on restart;
        // surface it at error level so diagnostics don't start from scratch.
        console.error(
            "[workspace-store] saveWorkspaceSnapshot failed",
            error,
        );
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

async function closeTabSideEffects(tab: RuntimeWorkspaceTab): Promise<void> {
    if (tab.kind === "terminal") {
        const runtime =
            useTerminalRuntimeStore.getState().runtimesById[tab.terminalId] ??
            null;
        await useTerminalRuntimeStore.getState().closeTerminal(tab.terminalId);
        if (!runtime && tab.sessionId) {
            await getComandoApi()
                .closeTerminalSession(tab.sessionId)
                .catch(() => undefined);
        }
        return;
    }

    if (tab.kind === "file" && tab.document) {
        await getComandoApi().notifyFileBuffer({
            absolutePath: tab.document.absolutePath,
            content: null,
        });
    }
}

async function restoreTabSideEffects(
    tab: RuntimeWorkspaceTab,
    get: GetWorkspaceState,
    set: WorkspaceSetState,
): Promise<void> {
    if (tab.kind === "terminal") {
        return;
    }

    if (tab.kind === "chat" || tab.kind === "review") {
        await useAiStore.getState().ensureSession(tab, {
            force: true,
        });
        return;
    }

    if (tab.kind === "file") {
        if (!tab.document && !tab.isDirty) {
            await loadFileTabDocument(get, set, tab.id);
            return;
        }

        if (tab.document && tab.isDirty) {
            await getComandoApi().notifyFileBuffer({
                absolutePath: tab.document.absolutePath,
                content: tab.draftContent,
            });
        }
    }
}

function createRestoredTab(tab: RuntimeWorkspaceTab): RuntimeWorkspaceTab {
    if (tab.kind !== "terminal") {
        return tab;
    }

    return {
        ...tab,
        exitCode: null,
        isReady: false,
        launchError: null,
        session: null,
        signalCode: null,
    };
}

function countRuntimeChatTabs(
    get: GetWorkspaceState,
    runtimeId: AiRuntimeId,
): number {
    return Object.values(get().tabsById).filter(
        (tab) => tab.kind === "chat" && tab.runtimeId === runtimeId,
    ).length;
}

const TERMINAL_TITLE_PATTERN = /^Terminal(?: (\d+))?$/;

function getNextTerminalTabTitle(tabs: readonly RuntimeWorkspaceTab[]): string {
    return `Terminal ${getNextNumberedTitleValue(
        tabs,
        TERMINAL_TITLE_PATTERN,
    )}`;
}

function getNextNumberedTitleValue(
    tabs: readonly RuntimeWorkspaceTab[],
    pattern: RegExp,
): number {
    let maxValue = 0;
    for (const tab of tabs) {
        if (tab.kind !== "terminal") {
            continue;
        }
        const match = pattern.exec(tab.title.trim());
        if (!match) {
            continue;
        }
        const value = match[1] ? Number.parseInt(match[1], 10) : 1;
        if (Number.isFinite(value)) {
            maxValue = Math.max(maxValue, value);
        }
    }

    return maxValue + 1;
}

function getRuntimeDisplayName(runtimeId: AiRuntimeId): string {
    switch (runtimeId) {
        case "claude":
            return "Claude";
        case "gemini":
            return "Gemini";
        case "grok":
            return "Grok";
        case "kilo":
            return "Kilo";
        case "opencode":
            return "OpenCode";
        case "codex":
        default:
            return "Codex";
    }
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

function findExistingGitWorktreeDiffTab(
    state: WorkspaceTreeState,
    projectId: string,
    worktreeId: string | null,
): RuntimeWorkspaceGitWorktreeDiffTab | null {
    return (
        Object.values(state.tabsById).find(
            (tab): tab is RuntimeWorkspaceGitWorktreeDiffTab =>
                tab.kind === "git_worktree_diff" &&
                tab.projectId === projectId &&
                areGitWorktreeIdsEquivalent(
                    projectId,
                    normalizeWorktreeId(tab.worktreeId),
                    normalizeWorktreeId(worktreeId),
                ),
        ) ?? null
    );
}

function findExistingGitHubTab(
    state: WorkspaceTreeState,
    input: GitHubWorkspaceTabInput,
):
    | RuntimeWorkspaceGitHubIssueTab
    | RuntimeWorkspaceGitHubIssuesTab
    | RuntimeWorkspaceGitHubPullRequestTab
    | RuntimeWorkspaceGitHubPullRequestsTab
    | null {
    return (
        Object.values(state.tabsById).find((tab): tab is
            | RuntimeWorkspaceGitHubIssueTab
            | RuntimeWorkspaceGitHubIssuesTab
            | RuntimeWorkspaceGitHubPullRequestTab
            | RuntimeWorkspaceGitHubPullRequestsTab => {
            if (
                tab.kind !== input.kind ||
                !isGitHubTabKind(tab.kind) ||
                tab.projectId !== input.projectId ||
                normalizeWorktreeId(tab.worktreeId) !==
                    normalizeWorktreeId(input.worktreeId) ||
                !matchesGitHubRepositoryRef(tab.ref, input.ref)
            ) {
                return false;
            }

            if (tab.kind === "github_issue") {
                return (
                    input.kind === "github_issue" &&
                    tab.issueNumber === input.issueNumber
                );
            }

            if (tab.kind === "github_pull_request") {
                return (
                    input.kind === "github_pull_request" &&
                    tab.pullRequestNumber === input.pullRequestNumber
                );
            }

            return true;
        }) ?? null
    );
}

function isGitHubTabKind(
    kind: RuntimeWorkspaceTab["kind"],
): kind is
    | "github_issue"
    | "github_issues"
    | "github_pull_request"
    | "github_pull_requests" {
    return (
        kind === "github_issues" ||
        kind === "github_issue" ||
        kind === "github_pull_requests" ||
        kind === "github_pull_request"
    );
}

function matchesGitHubRepositoryRef(
    left: GitHubRepositoryRef,
    right: GitHubRepositoryRef,
): boolean {
    return (
        left.host.toLowerCase() === right.host.toLowerCase() &&
        left.owner === right.owner &&
        left.repo === right.repo
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
    const comandoWindow = globalThis.window;
    if (!comandoWindow?.comando) {
        throw new Error(
            "The desktop bridge is not available yet. Restart the Electron app and try again.",
        );
    }

    return comandoWindow.comando;
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
