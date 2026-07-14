import type { editor as MonacoEditor } from "monaco-editor";
import { create } from "zustand";

import type {
    AiImageAttachment,
    AiRuntimeId,
    GitHubRepositoryRef,
    PersistedWorkspaceSnapshot,
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
    WorkspaceLayoutSnapshot,
    WorkspaceNavigationSnapshot,
    WorkspaceReviewTab,
} from "@shared/ipc";
import {
    getAiRuntimeDisplayName,
    type ActiveAiRuntimeId,
} from "@shared/ai-runtimes";
import { normalizeWorkspaceNavigationSnapshot } from "@shared/workspace-restore";

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
    getDefaultMarkdownFileViewMode,
    isMarkdownFilePath,
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
    setFileTabMarkdownPreviewScrollTop,
    setFileTabPendingOpenLocation,
    setFileTabViewState,
    setFileTabReviewContext,
    selectPaneTab,
    setFileTabLoading,
    setFileTabLoadError,
    setFileTabMarkdownViewMode,
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
    type RuntimeWorkspaceFileOpenLocation,
    type RuntimeWorkspaceFileReviewContext,
    type RuntimeWorkspaceFileTab,
    type MarkdownFileViewMode,
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
import { getProjectContextKey } from "../projects/context-key";

export type WorkspaceQuickCreateAction =
    | ActiveAiRuntimeId
    | "git"
    | "history"
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

export interface RuntimeWorkspaceContext {
    readonly key: string;
    readonly lastActivatedAt: string;
    readonly projectId: string;
    readonly workspace: WorkspaceTreeState;
    readonly worktreeId: string | null;
}

interface WorkspaceStore extends WorkspaceTreeState {
    readonly activeContextKey: string | null;
    readonly contextsByKey: Record<string, RuntimeWorkspaceContext>;
    readonly deferredPaneIds: ReadonlySet<string>;
    getContextNavigationSnapshot: (
        contextKey: string,
    ) => WorkspaceNavigationSnapshot | null;
    readonly openContextKeys: readonly string[];
    readonly scopeEpoch: number;
    activateContext: (contextKey: string) => Promise<void>;
    closeContext: (contextKey: string) => Promise<void>;
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
        runtimeId?: ActiveAiRuntimeId,
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
        readonly sessionOpenMode?: "history" | "live";
        readonly sessionId: string;
        readonly targetIndex?: number;
        readonly targetPaneId?: string | null;
        readonly title: string;
        readonly worktreeId?: string | null;
    }) => Promise<void>;
    openChatSessionTabAtTarget: (input: {
        readonly projectId: string | null;
        readonly runtimeId: AiRuntimeId;
        readonly sessionOpenMode?: "history" | "live";
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
    hydrate: (input?: {
        readonly activeProjectId?: string | null;
        readonly activeWorktreeId?: string | null;
    }) => Promise<void>;
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
        openLocation?: RuntimeWorkspaceFileOpenLocation | null,
    ) => Promise<void>;
    openFileTabAtTarget: (input: {
        readonly openLocation?: RuntimeWorkspaceFileOpenLocation | null;
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
    openContext: (
        projectId: string,
        worktreeId?: string | null,
        options?: { readonly emptyLayout?: boolean },
    ) => Promise<void>;
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
    reorderContext: (contextKey: string, targetIndex: number) => Promise<void>;
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
    updateFilePendingOpenLocation: (
        tabId: string,
        pendingOpenLocation: RuntimeWorkspaceFileOpenLocation | null,
    ) => void;
    updateFileMarkdownViewMode: (
        tabId: string,
        markdownViewMode: MarkdownFileViewMode,
    ) => void;
    updateFileMarkdownPreviewScrollTop: (
        tabId: string,
        markdownPreviewScrollTop: number,
    ) => void;
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
    activeContextKey: null,
    contextsByKey: {},
    deferredPaneIds: new Set(),
    error: null,
    hydrated: false,
    lastFocusedChatTabId: null,
    lastFocusedRuntimeId: "codex",
    lastQuickCreateAction: "codex",
    recentActiveTabIds: [],
    recentClosedTabs: [],
    recentFocusedChatTabIds: [],
    openContextKeys: [],
    scopeEpoch: 0,

    getContextNavigationSnapshot: (contextKey) => {
        const context = captureVisibleWorkspaceContext(get())[contextKey];
        if (!context) {
            return null;
        }

        return {
            activeContextKey: context.key,
            contexts: [
                {
                    key: context.key,
                    lastActivatedAt: context.lastActivatedAt,
                    projectId: context.projectId,
                    workspace: workspaceStateToSnapshot(context.workspace),
                    worktreeId: context.worktreeId,
                },
            ],
            openContextKeys: [context.key],
            version: 3,
        };
    },

    activateContext: async (contextKey) => {
        const currentState = get();
        if (currentState.activeContextKey === contextKey) {
            return;
        }

        const contextsByKey = captureVisibleWorkspaceContext(currentState);
        const targetContext = contextsByKey[contextKey];
        if (!targetContext) {
            return;
        }

        const scopeEpoch = currentState.scopeEpoch + 1;
        const targetWorkspace = targetContext.workspace;
        set({
            ...targetWorkspace,
            activeContextKey: contextKey,
            contextsByKey: {
                ...contextsByKey,
                [contextKey]: {
                    ...targetContext,
                    lastActivatedAt: new Date().toISOString(),
                },
            },
            deferredPaneIds: getDeferredWorkspacePaneIds(targetWorkspace),
            error: null,
            lastFocusedChatTabId: getPaneChatTabId(
                targetWorkspace,
                targetWorkspace.activePaneId,
            ),
            lastFocusedRuntimeId:
                getPaneRuntimeId(
                    targetWorkspace,
                    targetWorkspace.activePaneId,
                ) ?? "codex",
            recentActiveTabIds: recordRecentTabActivation(
                [],
                getPaneActiveTabId(
                    targetWorkspace,
                    targetWorkspace.activePaneId,
                ),
            ),
            recentClosedTabs: [],
            recentFocusedChatTabIds: recordRecentChatFocus(
                [],
                getPaneChatTabId(
                    targetWorkspace,
                    targetWorkspace.activePaneId,
                ),
            ),
            scopeEpoch,
        });

        void activateWorkspaceRuntimePanes(
            targetWorkspace,
            get,
            set,
            { contextKey, scopeEpoch },
        );
        await persistWorkspaceState(get);
    },

    closeContext: async (contextKey) => {
        const state = get();
        const contextsByKey = captureVisibleWorkspaceContext(state);
        const targetContext = contextsByKey[contextKey];
        if (!targetContext) {
            return;
        }

        await Promise.all(
            Object.values(targetContext.workspace.tabsById).map(
                closeTabSideEffects,
            ),
        );

        const nextContextsByKey = { ...contextsByKey };
        delete nextContextsByKey[contextKey];
        const closedIndex = state.openContextKeys.indexOf(contextKey);
        const openContextKeys = state.openContextKeys.filter(
            (key) => key !== contextKey,
        );

        if (state.activeContextKey !== contextKey) {
            set({ contextsByKey: nextContextsByKey, openContextKeys });
            await persistWorkspaceState(get);
            return;
        }

        const nextContextKey =
            openContextKeys[Math.min(closedIndex, openContextKeys.length - 1)] ??
            null;
        const nextContext = nextContextKey
            ? nextContextsByKey[nextContextKey]
            : null;
        const nextWorkspace =
            nextContext?.workspace ?? createDefaultWorkspaceState();
        set({
            ...nextWorkspace,
            activeContextKey: nextContextKey,
            contextsByKey: nextContextsByKey,
            deferredPaneIds: getDeferredWorkspacePaneIds(nextWorkspace),
            error: null,
            lastFocusedChatTabId: getPaneChatTabId(
                nextWorkspace,
                nextWorkspace.activePaneId,
            ),
            lastFocusedRuntimeId:
                getPaneRuntimeId(
                    nextWorkspace,
                    nextWorkspace.activePaneId,
                ) ?? "codex",
            openContextKeys,
            recentActiveTabIds: recordRecentTabActivation(
                [],
                getPaneActiveTabId(
                    nextWorkspace,
                    nextWorkspace.activePaneId,
                ),
            ),
            recentClosedTabs: [],
            recentFocusedChatTabIds: recordRecentChatFocus(
                [],
                getPaneChatTabId(
                    nextWorkspace,
                    nextWorkspace.activePaneId,
                ),
            ),
            scopeEpoch: state.scopeEpoch + 1,
        });

        if (nextContextKey) {
            void activateWorkspaceRuntimePanes(
                nextWorkspace,
                get,
                set,
                { contextKey: nextContextKey, scopeEpoch: get().scopeEpoch },
            );
        }
        await persistWorkspaceState(get);
    },

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
        runtimeId: ActiveAiRuntimeId = "codex",
    ) => {
        const paneId = get().activePaneId;
        const runtimeTitle = getAiRuntimeDisplayName(runtimeId);
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
                sessionOpenMode:
                    input.sessionOpenMode ??
                    existingTab.sessionOpenMode ??
                    "history",
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
            prewarmFocusedAiSession(nextTab);
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
            // This API opens an existing session. Loading its durable
            // transcript must not depend on every caller passing a mode.
            sessionOpenMode: input.sessionOpenMode ?? "history",
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
        prewarmFocusedAiSession(tab);
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
            sessionOpenMode: input.sessionOpenMode,
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

    openContext: async (projectId, worktreeId = null) => {
        const normalizedWorktreeId =
            worktreeId === `${projectId}:primary` ? null : worktreeId;
        const contextKey = getProjectContextKey(
            projectId,
            normalizedWorktreeId,
        );
        if (get().contextsByKey[contextKey]) {
            await get().activateContext(contextKey);
            return;
        }

        const context: RuntimeWorkspaceContext = {
            key: contextKey,
            lastActivatedAt: new Date().toISOString(),
            projectId,
            workspace: createDefaultWorkspaceState(),
            worktreeId: normalizedWorktreeId,
        };
        set((state) => ({
            contextsByKey: {
                ...captureVisibleWorkspaceContext(state),
                [contextKey]: context,
            },
            openContextKeys: [...state.openContextKeys, contextKey],
        }));
        await get().activateContext(contextKey);
    },

    hydrate: async (input = {}) => {
        try {
            const persistedSnapshot =
                await getComandoApi().getWorkspaceSnapshot();
            const navigation = resolveWorkspaceNavigationSnapshot(
                persistedSnapshot,
                input.activeProjectId ?? null,
                input.activeWorktreeId ?? null,
            );
            const contextsByKey = Object.fromEntries(
                navigation.contexts.map((context) => [
                    context.key,
                    {
                        ...context,
                        workspace: workspaceStateFromSnapshot(
                            context.workspace,
                            createHydratedRuntimeTabs(context.workspace),
                        ),
                    } satisfies RuntimeWorkspaceContext,
                ]),
            );
            const openContextKeys = navigation.openContextKeys.filter(
                (key) => Boolean(contextsByKey[key]),
            );
            const activeContextKey =
                navigation.activeContextKey &&
                openContextKeys.includes(navigation.activeContextKey)
                    ? navigation.activeContextKey
                    : (openContextKeys[0] ?? null);
            const activeContext = activeContextKey
                ? contextsByKey[activeContextKey]
                : null;
            const hydratedState =
                activeContext?.workspace ?? createDefaultWorkspaceState();
            const scopeEpoch = get().scopeEpoch + 1;
            set({
                ...hydratedState,
                activeContextKey,
                contextsByKey,
                deferredPaneIds: getDeferredWorkspacePaneIds(hydratedState),
                error: null,
                hydrated: true,
                openContextKeys,
                lastFocusedChatTabId: getPaneChatTabId(
                    hydratedState,
                    hydratedState.activePaneId,
                ),
                lastFocusedRuntimeId:
                    getPaneRuntimeId(
                        hydratedState,
                        hydratedState.activePaneId,
                    ) ?? "codex",
                recentActiveTabIds: recordRecentTabActivation(
                    [],
                    getPaneActiveTabId(
                        hydratedState,
                        hydratedState.activePaneId,
                    ),
                ),
                recentFocusedChatTabIds: recordRecentChatFocus(
                    [],
                    getPaneChatTabId(
                        hydratedState,
                        hydratedState.activePaneId,
                    ),
                ),
                scopeEpoch,
            });
            if (activeContextKey) {
                void activateWorkspaceRuntimePanes(
                    hydratedState,
                    get,
                    set,
                    { contextKey: activeContextKey, scopeEpoch },
                );
            }
            if (!isWorkspaceNavigationSnapshot(persistedSnapshot)) {
                await persistWorkspaceState(get);
            }
        } catch (error) {
            set({
                ...createDefaultWorkspaceState(),
                activeContextKey: null,
                contextsByKey: {},
                deferredPaneIds: new Set(),
                error:
                    error instanceof Error
                        ? error.message
                        : "Could not restore the workspace layout.",
                hydrated: true,
                openContextKeys: [],
                scopeEpoch: get().scopeEpoch + 1,
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
        openLocation?: RuntimeWorkspaceFileOpenLocation | null,
    ) => {
        try {
            const pendingOpenLocation = openLocation ?? null;
            const shouldRevealOpenLocationInEditor =
                pendingOpenLocation !== null && isMarkdownFilePath(relativePath);
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
                    ...setFileTabPendingOpenLocation(
                        setFileTabMarkdownViewMode(
                            setFileTabReviewContext(
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
                            existingTabInResolvedPane.id,
                            shouldRevealOpenLocationInEditor
                                ? "edit"
                                : (existingTabInResolvedPane.markdownViewMode ??
                                      "edit"),
                        ),
                        existingTabInResolvedPane.id,
                        pendingOpenLocation,
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
                const {
                    markdownPreviewScrollTop: _markdownPreviewScrollTop,
                    ...sourceTabWithoutPreviewScroll
                } = sourceTab;
                void _markdownPreviewScrollTop;
                const markdownViewModeForDuplicatedTab =
                    shouldRevealOpenLocationInEditor
                        ? "edit"
                        : getDefaultMarkdownFileViewMode(relativePath);
                const duplicatedTab: RuntimeWorkspaceFileTab = {
                    ...sourceTabWithoutPreviewScroll,
                    createdAt: new Date().toISOString(),
                    id: crypto.randomUUID(),
                    ...(markdownViewModeForDuplicatedTab
                        ? { markdownViewMode: markdownViewModeForDuplicatedTab }
                        : {}),
                    pendingOpenLocation,
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
                    await loadFileTabDocument(
                        get,
                        set,
                        duplicatedTab.id,
                        getCurrentWorkspaceScope(get),
                    );
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
                ...(getDefaultMarkdownFileViewMode(relativePath)
                    ? {
                          markdownViewMode:
                              getDefaultMarkdownFileViewMode(relativePath),
                      }
                    : {}),
                pendingOpenLocation,
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
            await loadFileTabDocument(
                get,
                set,
                tab.id,
                getCurrentWorkspaceScope(get),
                { force: true },
            );
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
            input.openLocation ?? null,
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
            const {
                markdownPreviewScrollTop: _markdownPreviewScrollTop,
                ...sourceTabWithoutPreviewScroll
            } = sourceTab;
            void _markdownPreviewScrollTop;
            const duplicatedTab: RuntimeWorkspaceFileTab = {
                ...sourceTabWithoutPreviewScroll,
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
        await loadFileTabDocument(
            get,
            set,
            tabId,
            getCurrentWorkspaceScope(get),
            { force: true },
        );
    },

    refreshProjectTabs: async (
        projectId: string,
        worktreeId: string | null = null,
        invalidatedRelativePaths: readonly string[] | null = null,
    ) => {
        set((state) => {
            const contextsByKey = invalidateInactiveContextFileDocuments(
                state,
                projectId,
                worktreeId,
                invalidatedRelativePaths,
            );
            return contextsByKey === state.contextsByKey
                ? state
                : { contextsByKey };
        });

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

                await loadFileTabDocument(
                    get,
                    set,
                    tab.id,
                    getCurrentWorkspaceScope(get),
                    { force: true },
                );
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

    reorderContext: async (contextKey, targetIndex) => {
        const state = get();
        const sourceIndex = state.openContextKeys.indexOf(contextKey);
        if (sourceIndex < 0 || state.openContextKeys.length < 2) {
            return;
        }

        const normalizedTargetIndex = Math.max(
            0,
            Math.min(
                state.openContextKeys.length - 1,
                Number.isFinite(targetIndex)
                    ? Math.trunc(targetIndex)
                    : sourceIndex,
            ),
        );
        if (normalizedTargetIndex === sourceIndex) {
            return;
        }

        const openContextKeys = [...state.openContextKeys];
        openContextKeys.splice(sourceIndex, 1);
        openContextKeys.splice(normalizedTargetIndex, 0, contextKey);
        set({
            contextsByKey: captureVisibleWorkspaceContext(state),
            openContextKeys,
        });
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
        prepareFocusedWorkspaceTab(activeTab, get, set);
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
        prepareFocusedWorkspaceTab(tab, get, set);
        await persistWorkspaceState(get);
    },

    setLastFocusedRuntimeId: (runtimeId) => {
        set({ lastFocusedRuntimeId: runtimeId });
    },

    setLastQuickCreateAction: (action) => {
        set({ lastQuickCreateAction: action });
    },

    setActivePane: async (paneId) => {
        // A mouse-down inside a pane bubbles to the pane container. Avoid
        // treating an interaction in the already focused pane as navigation.
        if (get().activePaneId === paneId) {
            return;
        }

        set((state) => ({
            ...(() => {
                const nextState = activatePane(state, paneId);
                const runtimeId = getPaneRuntimeId(nextState, paneId);
                const chatTabId = getPaneChatTabId(nextState, paneId);
                return {
                    ...nextState,
                    deferredPaneIds: removeDeferredWorkspacePane(
                        state.deferredPaneIds,
                        paneId,
                    ),
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
        prepareFocusedWorkspaceTab(activeTab, get, set);
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

    updateFilePendingOpenLocation: (tabId, pendingOpenLocation) => {
        set((state) => ({
            ...setFileTabPendingOpenLocation(
                state,
                tabId,
                pendingOpenLocation,
            ),
        }));
    },

    updateFileMarkdownViewMode: (tabId, markdownViewMode) => {
        set((state) => ({
            ...setFileTabMarkdownViewMode(state, tabId, markdownViewMode),
        }));
        void persistWorkspaceState(get);
    },

    updateFileMarkdownPreviewScrollTop: (
        tabId,
        markdownPreviewScrollTop,
    ) => {
        set((state) =>
            setFileTabMarkdownPreviewScrollTop(
                state,
                tabId,
                markdownPreviewScrollTop,
            ),
        );
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

// Every workspace mutation may choose a new active pane. Keep the active pane
// outside the deferred queue regardless of which tree helper produced it.
const unsubscribeActivePaneDeferredInvariant = useWorkspaceStore.subscribe(
    (state) => {
        if (!state.deferredPaneIds.has(state.activePaneId)) {
            return;
        }

        const activeTabId = getPaneActiveTabId(state, state.activePaneId);
        const activeTab = activeTabId ? state.tabsById[activeTabId] : null;
        useWorkspaceStore.setState({
            deferredPaneIds: removeDeferredWorkspacePane(
                state.deferredPaneIds,
                state.activePaneId,
            ),
        });
        prepareFocusedWorkspaceTab(
            activeTab,
            useWorkspaceStore.getState,
            useWorkspaceStore.setState,
        );
    },
);

if (import.meta.hot) {
    import.meta.hot.dispose(unsubscribeActivePaneDeferredInvariant);
}

type WorkspaceSetState = typeof useWorkspaceStore.setState;

const WORKSPACE_PERSIST_DEBOUNCE_MS = 180;
const MAX_RECENTLY_CLOSED_TABS = 20;

let pendingWorkspacePersistTimer: ReturnType<typeof setTimeout> | null = null;
let workspacePersistDirty = false;
let workspacePersistGet: GetWorkspaceState | null = null;
let workspacePersistInFlight: Promise<void> | null = null;
let workspacePersistFailureCount = 0;
const pendingFileDocumentLoads = new Map<string, Promise<ProjectFileDocument>>();

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

function captureVisibleWorkspaceContext(
    state: WorkspaceStore,
): Record<string, RuntimeWorkspaceContext> {
    if (!state.activeContextKey) {
        return state.contextsByKey;
    }

    const activeContext = state.contextsByKey[state.activeContextKey];
    if (!activeContext) {
        return state.contextsByKey;
    }

    return {
        ...state.contextsByKey,
        [state.activeContextKey]: {
            ...activeContext,
            workspace: {
                activePaneId: state.activePaneId,
                rootNode: state.rootNode,
                tabsById: state.tabsById,
            },
        },
    };
}

function invalidateInactiveContextFileDocuments(
    state: WorkspaceStore,
    projectId: string,
    worktreeId: string | null,
    invalidatedRelativePaths: readonly string[] | null,
): Record<string, RuntimeWorkspaceContext> {
    let nextContextsByKey = state.contextsByKey;

    for (const [contextKey, context] of Object.entries(state.contextsByKey)) {
        if (contextKey === state.activeContextKey) {
            continue;
        }

        let nextTabsById = context.workspace.tabsById;
        for (const [tabId, tab] of Object.entries(
            context.workspace.tabsById,
        )) {
            if (
                tab.kind !== "file" ||
                tab.projectId !== projectId ||
                normalizeWorktreeId(tab.worktreeId) !==
                    normalizeWorktreeId(worktreeId) ||
                !isFileTabAffectedByProjectInvalidation(
                    tab.relativePath,
                    invalidatedRelativePaths,
                ) ||
                tab.isDirty ||
                tab.isSaving ||
                !tab.document
            ) {
                continue;
            }

            if (nextTabsById === context.workspace.tabsById) {
                nextTabsById = { ...context.workspace.tabsById };
            }
            nextTabsById[tabId] = {
                ...tab,
                document: null,
                isLoading: false,
                loadError: null,
            };
        }

        if (nextTabsById === context.workspace.tabsById) {
            continue;
        }
        if (nextContextsByKey === state.contextsByKey) {
            nextContextsByKey = { ...state.contextsByKey };
        }
        nextContextsByKey[contextKey] = {
            ...context,
            workspace: {
                ...context.workspace,
                tabsById: nextTabsById,
            },
        };
    }

    return nextContextsByKey;
}

function isWorkspaceNavigationSnapshot(
    snapshot: PersistedWorkspaceSnapshot,
): snapshot is WorkspaceNavigationSnapshot {
    return "version" in snapshot && snapshot.version === 3;
}

function resolveWorkspaceNavigationSnapshot(
    snapshot: PersistedWorkspaceSnapshot,
    activeProjectId: string | null,
    activeWorktreeId: string | null,
): WorkspaceNavigationSnapshot {
    return normalizeWorkspaceNavigationSnapshot(snapshot, {
        projectId: activeProjectId,
        worktreeId: activeWorktreeId,
    }).snapshot;
}

function workspaceStoreToNavigationSnapshot(
    state: WorkspaceStore,
): WorkspaceNavigationSnapshot {
    const contextsByKey = captureVisibleWorkspaceContext(state);
    const contexts = state.openContextKeys.flatMap((key) => {
        const context = contextsByKey[key];
        if (!context) {
            return [];
        }

        return [
            {
                key: context.key,
                lastActivatedAt: context.lastActivatedAt,
                projectId: context.projectId,
                workspace: workspaceStateToSnapshot(context.workspace),
                worktreeId: context.worktreeId,
            },
        ];
    });

    return {
        activeContextKey:
            state.activeContextKey && contextsByKey[state.activeContextKey]
                ? state.activeContextKey
                : null,
        contexts,
        openContextKeys: contexts.map((context) => context.key),
        version: 3,
    };
}

function createHydratedRuntimeTabs(
    snapshot: WorkspaceLayoutSnapshot,
): Record<string, RuntimeWorkspaceTab> {
    return Object.fromEntries(
        snapshot.tabs.map((tab) => {
            if (tab.kind === "chat") {
                return [
                    tab.id,
                    {
                        ...tab,
                        // Tabs persisted before passive history hydration did
                        // not have this field. Restore them without starting
                        // a runtime so their saved transcript is preserved.
                        sessionOpenMode: tab.sessionOpenMode ?? "history",
                    },
                ] as const;
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
                    isLoading: false,
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

function prepareFocusedWorkspaceTab(
    tab: RuntimeWorkspaceTab | null | undefined,
    get: GetWorkspaceState,
    set: WorkspaceSetState,
): void {
    if (tab?.kind === "file") {
        void loadFileTabDocument(
            get,
            set,
            tab.id,
            getCurrentWorkspaceScope(get),
        );
        return;
    }

    if (tab?.kind === "chat" || tab?.kind === "review") {
        prewarmFocusedAiSession(tab);
    }
}

function prewarmFocusedAiSession(
    tab: RuntimeWorkspaceTab,
): void {
    if (tab.kind !== "chat" || tab.sessionOpenMode !== "history") {
        return;
    }

    // History is readable without a live ACP runtime. Runtime preparation is
    // intentionally deferred to prompt dispatch or an explicit control action.
    void useAiStore.getState().ensureSession(tab);
}

async function activateWorkspaceRuntimePanes(
    workspace: WorkspaceTreeState,
    get: GetWorkspaceState,
    set: WorkspaceSetState,
    scope?: {
        readonly contextKey: string;
        readonly scopeEpoch: number;
    },
): Promise<void> {
    const panes = collectPaneNodes(workspace.rootNode);
    const focusedPane = panes.find(
        (pane) => pane.id === workspace.activePaneId,
    ) ?? null;
    const focusedTab = focusedPane?.activeTabId
        ? workspace.tabsById[focusedPane.activeTabId]
        : null;
    const focusedLoad = focusedTab
        ? hydrateWorkspaceRuntimeTab(focusedTab, get, set, scope)
        : Promise.resolve();
    const backgroundPaneIds = panes
        .filter((pane) => pane.id !== workspace.activePaneId)
        .map((pane) => pane.id);

    // Let the focused pane commit before secondary panes start file I/O and
    // history hydration. This keeps context switching responsive on dense layouts.
    const backgroundLoads: Promise<void>[] = [];
    for (const paneId of backgroundPaneIds) {
        await waitForWorkspaceActivationFrame();
        if (!isWorkspaceScopeCurrent(get, scope)) {
            break;
        }

        if (!get().deferredPaneIds.has(paneId)) {
            continue;
        }

        set((state) => ({
            deferredPaneIds: removeDeferredWorkspacePane(
                state.deferredPaneIds,
                paneId,
            ),
        }));

        const currentState = get();
        const currentPane = findPaneById(currentState.rootNode, paneId);
        const currentTab = currentPane?.activeTabId
            ? currentState.tabsById[currentPane.activeTabId]
            : null;
        if (currentTab) {
            backgroundLoads.push(
                hydrateWorkspaceRuntimeTab(currentTab, get, set, scope),
            );
        }
    }

    await Promise.all([focusedLoad, ...backgroundLoads]);
}

function getDeferredWorkspacePaneIds(
    workspace: WorkspaceTreeState,
): ReadonlySet<string> {
    return new Set(
        collectPaneNodes(workspace.rootNode)
            .filter((pane) => pane.id !== workspace.activePaneId)
            .map((pane) => pane.id),
    );
}

function removeDeferredWorkspacePane(
    deferredPaneIds: ReadonlySet<string>,
    paneId: string,
): ReadonlySet<string> {
    if (!deferredPaneIds.has(paneId)) {
        return deferredPaneIds;
    }

    const nextDeferredPaneIds = new Set(deferredPaneIds);
    nextDeferredPaneIds.delete(paneId);
    return nextDeferredPaneIds;
}

async function hydrateWorkspaceRuntimeTab(
    tab: RuntimeWorkspaceTab,
    get: GetWorkspaceState,
    set: WorkspaceSetState,
    scope?: {
        readonly contextKey: string;
        readonly scopeEpoch: number;
    },
): Promise<void> {
    if (tab.kind === "file") {
        await loadFileTabDocument(get, set, tab.id, scope);
        return;
    }

    if (tab.kind === "chat" || tab.kind === "review") {
        prewarmFocusedAiSession(tab);
    }
}

function waitForWorkspaceActivationFrame(): Promise<void> {
    return new Promise((resolve) => {
        if (typeof window.requestAnimationFrame === "function") {
            window.requestAnimationFrame(() => resolve());
            return;
        }

        queueMicrotask(resolve);
    });
}

function isWorkspaceScopeCurrent(
    get: GetWorkspaceState,
    scope?: {
        readonly contextKey: string;
        readonly scopeEpoch: number;
    },
): boolean {
    if (!scope) {
        return true;
    }

    const state = get();
    return (
        state.activeContextKey === scope.contextKey &&
        state.scopeEpoch === scope.scopeEpoch
    );
}

function getCurrentWorkspaceScope(get: GetWorkspaceState):
    | {
          readonly contextKey: string;
          readonly scopeEpoch: number;
      }
    | undefined {
    const state = get();
    return state.activeContextKey
        ? {
              contextKey: state.activeContextKey,
              scopeEpoch: state.scopeEpoch,
          }
        : undefined;
}

function persistWorkspaceState(get: GetWorkspaceState): Promise<void> {
    scheduleWorkspacePersistence(get);
    return Promise.resolve();
}

export async function flushWorkspacePersistenceForTests(): Promise<void> {
    await flushWorkspacePersistence(undefined, { force: true });
}

export async function flushWorkspacePersistenceNow(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        if (pendingWorkspacePersistTimer !== null) {
            clearTimeout(pendingWorkspacePersistTimer);
            pendingWorkspacePersistTimer = null;
        }
        await flushWorkspacePersistence(undefined, { force: true });
        if (!workspacePersistDirty) {
            return;
        }
    }
    throw new Error("Could not persist the workspace before closing.");
}

export function resetWorkspacePersistenceForTests(): void {
    if (pendingWorkspacePersistTimer !== null) {
        clearTimeout(pendingWorkspacePersistTimer);
        pendingWorkspacePersistTimer = null;
    }

    workspacePersistDirty = false;
    workspacePersistGet = null;
    workspacePersistInFlight = null;
    workspacePersistFailureCount = 0;
    pendingFileDocumentLoads.clear();
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

        if (workspacePersistDirty && workspacePersistFailureCount === 0) {
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

    if (workspacePersistDirty && workspacePersistFailureCount === 0) {
        await flushWorkspacePersistence();
    }
}

async function persistWorkspaceStateNow(get: GetWorkspaceState): Promise<void> {
    try {
        const state = get();
        await getComandoApi().saveWorkspaceSnapshot(
            workspaceStoreToNavigationSnapshot(state),
        );
        workspacePersistFailureCount = 0;
    } catch (error) {
        // Workspace persistence failure silently loses layout/tabs on restart;
        // surface it at error level so diagnostics don't start from scratch.
        console.error(
            "[workspace-store] saveWorkspaceSnapshot failed",
            error,
        );
        workspacePersistDirty = true;
        workspacePersistFailureCount += 1;
        if (
            pendingWorkspacePersistTimer === null &&
            workspacePersistFailureCount <= 3
        ) {
            pendingWorkspacePersistTimer = setTimeout(() => {
                pendingWorkspacePersistTimer = null;
                void flushWorkspacePersistence();
            }, Math.min(1_000 * workspacePersistFailureCount, 3_000));
        }
    }
}

async function loadFileTabDocument(
    get: GetWorkspaceState,
    set: WorkspaceSetState,
    tabId: string,
    scope?: {
        readonly contextKey: string;
        readonly scopeEpoch: number;
    },
    options: {
        readonly force?: boolean;
    } = {},
): Promise<void> {
    if (!isWorkspaceScopeCurrent(get, scope)) {
        return;
    }
    const tab = get().tabsById[tabId];
    if (!tab || tab.kind !== "file" || tab.isTransient) {
        return;
    }

    if (!options.force && tab.document) {
        return;
    }

    try {
        set((state) => ({
            ...setFileTabLoading(state, tabId, true),
            error: null,
        }));

        const document = await getOrCreateFileDocumentLoad(tab);

        if (!isWorkspaceScopeCurrent(get, scope)) {
            clearStaleFileTabLoading(set, tabId, scope);
            return;
        }

        set((state) => ({
            ...replaceFileDocument(state, tabId, document),
            error: null,
        }));
    } catch (error) {
        if (!isWorkspaceScopeCurrent(get, scope)) {
            clearStaleFileTabLoading(set, tabId, scope);
            return;
        }
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

function getOrCreateFileDocumentLoad(
    tab: RuntimeWorkspaceFileTab,
): Promise<ProjectFileDocument> {
    const key = getWorkspaceFileLoadKey(tab);
    const existingLoad = pendingFileDocumentLoads.get(key);
    if (existingLoad) {
        return existingLoad;
    }

    const load = getComandoApi().openProjectFile({
        projectId: tab.projectId,
        relativePath: tab.relativePath,
        worktreeId: tab.worktreeId ?? null,
    });
    pendingFileDocumentLoads.set(key, load);
    void load.then(
        () => {
            if (pendingFileDocumentLoads.get(key) === load) {
                pendingFileDocumentLoads.delete(key);
            }
        },
        () => {
            if (pendingFileDocumentLoads.get(key) === load) {
                pendingFileDocumentLoads.delete(key);
            }
        },
    );
    return load;
}

function getWorkspaceFileLoadKey(tab: RuntimeWorkspaceFileTab): string {
    return [
        tab.projectId,
        normalizeWorktreeId(tab.worktreeId) ?? "__primary__",
        tab.relativePath,
    ].join("\u0000");
}

function clearStaleFileTabLoading(
    set: WorkspaceSetState,
    tabId: string,
    scope: { readonly contextKey: string; readonly scopeEpoch: number } | undefined,
): void {
    if (!scope) {
        return;
    }

    set((state) => {
        if (state.activeContextKey === scope.contextKey) {
            // A newer activation already owns the visible tab state.
            return state;
        }

        const context = state.contextsByKey[scope.contextKey];
        const tab = context?.workspace.tabsById[tabId];
        if (!context || !tab || tab.kind !== "file" || !tab.isLoading) {
            return state;
        }

        return {
            ...state,
            contextsByKey: {
                ...state.contextsByKey,
                [scope.contextKey]: {
                    ...context,
                    workspace: {
                        ...context.workspace,
                        tabsById: {
                            ...context.workspace.tabsById,
                            [tabId]: { ...tab, isLoading: false },
                        },
                    },
                },
            },
        };
    });
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
            await loadFileTabDocument(
                get,
                set,
                tab.id,
                getCurrentWorkspaceScope(get),
            );
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
