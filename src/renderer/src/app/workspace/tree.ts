import type { editor as MonacoEditor } from "monaco-editor";

import type {
    WorkspaceChatHistoryTab,
    ProjectFileDocument,
    TerminalSession,
    WorkspaceChatTab,
    WorkspaceFileTab,
    WorkspaceGitCommitTab,
    WorkspaceGitWorktreeDiffTab,
    WorkspaceGitHubIssueTab,
    WorkspaceGitHubIssuesTab,
    WorkspaceGitHubPullRequestTab,
    WorkspaceGitHubPullRequestsTab,
    WorkspaceGitTab,
    WorkspaceNode,
    WorkspacePaneNode,
    WorkspaceReviewTab,
    WorkspaceSnapshot,
    WorkspaceSplitNode,
    WorkspaceTab,
    WorkspaceTerminalTab,
} from "@shared/ipc";
import { resolveEditorLanguage } from "@shared/editor-language";
import { areGitWorktreeIdsEquivalent } from "../git/context-key";

export type SplitDirection = "down" | "left" | "right" | "up";
export type MoveDirection = "next" | "previous";

export interface RuntimeWorkspaceFileReviewContext {
    readonly path: string;
    readonly sessionId: string;
}

export interface RuntimeWorkspaceFileOpenLocation {
    readonly endLine?: number | null;
    readonly startLine: number;
}

export type MarkdownFileViewMode = "edit" | "preview";

export interface RuntimeWorkspaceFileTab extends WorkspaceFileTab {
    readonly contentRevision?: number;
    readonly document: ProjectFileDocument | null;
    readonly draftContent: string;
    readonly hasExternalChange: boolean;
    readonly isTransient?: boolean;
    readonly isDirty: boolean;
    readonly isLoading: boolean;
    readonly isSaving: boolean;
    readonly loadError: string | null;
    readonly markdownPreviewScrollTop?: number;
    readonly markdownViewMode?: MarkdownFileViewMode;
    readonly pendingOpenLocation?: RuntimeWorkspaceFileOpenLocation | null;
    readonly reviewContext: RuntimeWorkspaceFileReviewContext | null;
    readonly saveError: string | null;
    readonly savedContent: string;
    readonly viewState?: MonacoEditor.ICodeEditorViewState | null;
}

export function isMarkdownFilePath(filePath: string): boolean {
    return resolveEditorLanguage({ filePath }).id === "markdown";
}

export function getDefaultMarkdownFileViewMode(
    filePath: string,
): MarkdownFileViewMode | undefined {
    return isMarkdownFilePath(filePath) ? "edit" : undefined;
}

export type RuntimeWorkspaceChatTab = WorkspaceChatTab;
export type RuntimeWorkspaceChatHistoryTab = WorkspaceChatHistoryTab;
export type RuntimeWorkspaceReviewTab = WorkspaceReviewTab;
export type RuntimeWorkspaceGitCommitTab = WorkspaceGitCommitTab;
export type RuntimeWorkspaceGitHubIssueTab = WorkspaceGitHubIssueTab;
export type RuntimeWorkspaceGitHubIssuesTab = WorkspaceGitHubIssuesTab;
export type RuntimeWorkspaceGitHubPullRequestTab =
    WorkspaceGitHubPullRequestTab;
export type RuntimeWorkspaceGitHubPullRequestsTab =
    WorkspaceGitHubPullRequestsTab;

export interface RuntimeWorkspaceTerminalTab extends WorkspaceTerminalTab {
    readonly exitCode: number | null;
    readonly isReady: boolean;
    readonly launchError: string | null;
    readonly output: string;
    readonly session: TerminalSession | null;
    readonly signalCode: number | null;
    readonly terminalId: string;
}

export type RuntimeWorkspaceGitTab = WorkspaceGitTab;
export type RuntimeWorkspaceGitWorktreeDiffTab = WorkspaceGitWorktreeDiffTab;

export type RuntimeWorkspaceTab =
    | RuntimeWorkspaceFileTab
    | RuntimeWorkspaceChatTab
    | RuntimeWorkspaceChatHistoryTab
    | RuntimeWorkspaceGitCommitTab
    | RuntimeWorkspaceGitHubIssueTab
    | RuntimeWorkspaceGitHubIssuesTab
    | RuntimeWorkspaceGitHubPullRequestTab
    | RuntimeWorkspaceGitHubPullRequestsTab
    | RuntimeWorkspaceGitWorktreeDiffTab
    | RuntimeWorkspaceGitTab
    | RuntimeWorkspaceReviewTab
    | RuntimeWorkspaceTerminalTab;

export interface WorkspaceTreeState {
    readonly activePaneId: string;
    readonly rootNode: WorkspaceNode;
    readonly tabsById: Record<string, RuntimeWorkspaceTab>;
}

export function createDefaultWorkspaceState(): WorkspaceTreeState {
    return {
        activePaneId: "pane-root",
        rootNode: {
            activeTabId: null,
            id: "pane-root",
            tabIds: [],
            type: "pane",
        },
        tabsById: {},
    };
}

export function workspaceStateFromSnapshot(
    snapshot: WorkspaceSnapshot,
    tabsById: Record<string, RuntimeWorkspaceTab>,
): WorkspaceTreeState {
    return {
        activePaneId: snapshot.activePaneId,
        rootNode: normalizeWorkspaceNodeTabs(snapshot.rootNode),
        tabsById: normalizeRuntimeTabsForWorkspace(tabsById),
    };
}

export function workspaceStateToSnapshot(
    state: WorkspaceTreeState,
): WorkspaceSnapshot {
    const persistedTabIds = new Set(
        Object.values(state.tabsById)
            .filter((tab) => !isTransientWorkspaceTab(tab))
            .map((tab) => tab.id),
    );
    const sanitizedRootNode = sanitizeNodeForSnapshot(
        state.rootNode,
        persistedTabIds,
    );
    const orderedTabIds = collectPaneNodes(sanitizedRootNode).flatMap(
        (pane) => pane.tabIds,
    );

    return {
        activePaneId: state.activePaneId,
        rootNode: sanitizedRootNode,
        tabs: orderedTabIds
            .map((tabId) => state.tabsById[tabId])
            .filter((tab): tab is RuntimeWorkspaceTab => Boolean(tab))
            .map(stripRuntimeTab),
    };
}

export function splitPaneInDirection(
    state: WorkspaceTreeState,
    paneId: string,
    direction: SplitDirection,
    nextIds: {
        readonly paneId: string;
        readonly splitId: string;
    },
): WorkspaceTreeState {
    const nextPane: WorkspacePaneNode = {
        activeTabId: null,
        id: nextIds.paneId,
        tabIds: [],
        type: "pane",
    };
    const axis =
        direction === "left" || direction === "right"
            ? "horizontal"
            : "vertical";

    const nextRootNode = replaceNode(state.rootNode, paneId, (node) => {
        if (node.type !== "pane") {
            return node;
        }

        const children =
            direction === "left" || direction === "up"
                ? [nextPane, node]
                : [node, nextPane];

        return {
            axis,
            children,
            id: nextIds.splitId,
            sizes: [0.5, 0.5],
            type: "split",
        } satisfies WorkspaceSplitNode;
    });

    return {
        ...state,
        activePaneId: nextPane.id,
        rootNode: nextRootNode,
    };
}

export function resizeSplit(
    node: WorkspaceNode,
    splitId: string,
    nextSizes: readonly number[],
): WorkspaceNode {
    return replaceNode(node, splitId, (currentNode) => {
        if (currentNode.type !== "split") {
            return currentNode;
        }

        return {
            ...currentNode,
            sizes: normalizeSizes(nextSizes),
        };
    });
}

export function activatePane(
    state: WorkspaceTreeState,
    paneId: string,
): WorkspaceTreeState {
    return {
        ...state,
        activePaneId: paneId,
    };
}

export function attachTabToPane(
    state: WorkspaceTreeState,
    paneId: string,
    tab: RuntimeWorkspaceTab,
): WorkspaceTreeState {
    const existingPaneId = findPaneIdForTab(state.rootNode, tab.id);
    const stateWithoutTab =
        existingPaneId !== null && existingPaneId !== paneId
            ? moveTabBetweenPanes(state, tab.id, existingPaneId, paneId)
            : state;

    if (existingPaneId !== null) {
        return {
            ...stateWithoutTab,
            activePaneId: paneId,
            tabsById: {
                ...stateWithoutTab.tabsById,
                [tab.id]: tab,
            },
        };
    }

    return {
        activePaneId: paneId,
        rootNode: replaceNode(state.rootNode, paneId, (node) => {
            if (node.type !== "pane") {
                return node;
            }

            return normalizeWorkspacePaneNode({
                ...node,
                activeTabId: tab.id,
                tabIds: [...node.tabIds, tab.id],
            });
        }),
        tabsById: {
            ...state.tabsById,
            [tab.id]: tab,
        },
    };
}

export function attachTabToPaneAtIndex(
    state: WorkspaceTreeState,
    paneId: string,
    tab: RuntimeWorkspaceTab,
    targetIndex: number,
): WorkspaceTreeState {
    const existingPaneId = findPaneIdForTab(state.rootNode, tab.id);
    const targetPane = findPaneById(state.rootNode, paneId);
    if (!targetPane) {
        return state;
    }

    if (existingPaneId !== null) {
        const reorderedState = moveTabToPaneAtIndex(
            state,
            tab.id,
            existingPaneId,
            paneId,
            targetIndex,
            {
                preserveEmptySourcePane: existingPaneId === paneId,
            },
        );

        return {
            ...reorderedState,
            activePaneId: paneId,
            tabsById: {
                ...reorderedState.tabsById,
                [tab.id]: tab,
            },
        };
    }

    return {
        activePaneId: paneId,
        rootNode: replaceNode(state.rootNode, paneId, (node) => {
            if (node.type !== "pane") {
                return node;
            }

            const nextIndex = normalizeTabInsertionIndex(
                targetIndex,
                node.tabIds.length,
            );
            const pinnedTabIds = getPanePinnedTabIds(node);
            const pinnedAwareIndex = Math.max(nextIndex, pinnedTabIds.length);
            const nextTabIds = [
                ...node.tabIds.slice(0, pinnedAwareIndex),
                tab.id,
                ...node.tabIds.slice(pinnedAwareIndex),
            ];

            return normalizeWorkspacePaneNode({
                ...node,
                activeTabId: tab.id,
                pinnedTabIds,
                tabIds: nextTabIds,
            });
        }),
        tabsById: {
            ...state.tabsById,
            [tab.id]: tab,
        },
    };
}

export function selectPaneTab(
    state: WorkspaceTreeState,
    paneId: string,
    tabId: string,
): WorkspaceTreeState {
    return {
        activePaneId: paneId,
        rootNode: replaceNode(state.rootNode, paneId, (node) => {
            if (node.type !== "pane") {
                return node;
            }

            if (node.activeTabId === tabId) {
                return node;
            }

            return {
                ...node,
                activeTabId: tabId,
            };
        }),
        tabsById: state.tabsById,
    };
}

export function selectAdjacentPaneTab(
    state: WorkspaceTreeState,
    paneId: string,
    direction: MoveDirection,
): WorkspaceTreeState {
    const pane = findPaneById(state.rootNode, paneId);
    if (!pane || pane.tabIds.length === 0) {
        return state;
    }

    const activeTabIndex = pane.activeTabId
        ? pane.tabIds.indexOf(pane.activeTabId)
        : -1;
    const baseIndex =
        activeTabIndex === -1
            ? direction === "next"
                ? -1
                : 0
            : activeTabIndex;
    const nextIndex =
        direction === "next"
            ? (baseIndex + 1) % pane.tabIds.length
            : (baseIndex - 1 + pane.tabIds.length) % pane.tabIds.length;
    const nextTabId = pane.tabIds[nextIndex] ?? null;

    if (!nextTabId) {
        return state;
    }

    return selectPaneTab(state, paneId, nextTabId);
}

export function closeWorkspaceTab(
    state: WorkspaceTreeState,
    tabId: string,
): WorkspaceTreeState {
    const paneId = findPaneIdForTab(state.rootNode, tabId);
    if (!paneId) {
        return state;
    }

    const nextRootNode = replaceNode(state.rootNode, paneId, (node) => {
        if (node.type !== "pane") {
            return node;
        }

        const nextTabIds = node.tabIds.filter(
            (currentTabId) => currentTabId !== tabId,
        );
        const nextActiveTabId =
            node.activeTabId === tabId
                ? (nextTabIds.at(-1) ?? null)
                : node.activeTabId;

        return normalizeWorkspacePaneNode({
            ...node,
            activeTabId: nextActiveTabId,
            tabIds: nextTabIds,
        });
    });

    const nextState = {
        ...state,
        rootNode: nextRootNode,
        tabsById: omitTabFromMap(state.tabsById, tabId),
    };

    return closeEmptyPaneIfNeeded(nextState, paneId);
}

export function closeWorkspacePane(
    state: WorkspaceTreeState,
    paneId: string,
): WorkspaceTreeState {
    if (state.rootNode.type === "pane" && state.rootNode.id === paneId) {
        return state;
    }

    const pane = findPaneById(state.rootNode, paneId);
    if (!pane) {
        return state;
    }

    const rootNodeWithoutPane = removePane(state.rootNode, paneId);
    if (!rootNodeWithoutPane) {
        return state;
    }

    const fallbackPane = collectPaneNodes(rootNodeWithoutPane)[0];
    if (!fallbackPane) {
        return state;
    }

    let nextState: WorkspaceTreeState = {
        ...state,
        activePaneId:
            state.activePaneId === paneId
                ? fallbackPane.id
                : state.activePaneId,
        rootNode: rootNodeWithoutPane,
    };

    if (pane.tabIds.length > 0) {
        nextState = replacePaneTabs(
            nextState,
            fallbackPane.id,
            (existingTabIds, _activeTabId, pinnedTabIds) => {
                const sourcePinnedTabIds = getPanePinnedTabIds(pane);
                return {
                    activeTabId:
                        pane.activeTabId ?? pane.tabIds.at(-1) ?? null,
                    pinnedTabIds: [
                        ...pinnedTabIds,
                        ...sourcePinnedTabIds,
                    ],
                    tabIds: [...existingTabIds, ...pane.tabIds],
                };
            },
        );
    }

    return nextState;
}

export function moveActiveTabBetweenPanes(
    state: WorkspaceTreeState,
    paneId: string,
    direction: MoveDirection,
): WorkspaceTreeState {
    const paneIds = collectPaneNodes(state.rootNode).map((pane) => pane.id);
    if (paneIds.length < 2) {
        return state;
    }

    const sourceIndex = paneIds.indexOf(paneId);
    if (sourceIndex === -1) {
        return state;
    }

    const sourcePane = findPaneById(state.rootNode, paneId);
    if (!sourcePane?.activeTabId) {
        return state;
    }

    const targetIndex =
        direction === "next"
            ? (sourceIndex + 1) % paneIds.length
            : (sourceIndex - 1 + paneIds.length) % paneIds.length;
    const targetPaneId = paneIds[targetIndex];

    return moveTabBetweenPanes(
        state,
        sourcePane.activeTabId,
        paneId,
        targetPaneId,
    );
}

export function moveWorkspaceTabBetweenPanes(
    state: WorkspaceTreeState,
    tabId: string,
    direction: MoveDirection,
): WorkspaceTreeState {
    const paneIds = collectPaneNodes(state.rootNode).map((pane) => pane.id);
    if (paneIds.length < 2) {
        return state;
    }

    const sourcePaneId = findPaneIdForTab(state.rootNode, tabId);
    if (!sourcePaneId) {
        return state;
    }

    const sourceIndex = paneIds.indexOf(sourcePaneId);
    if (sourceIndex === -1) {
        return state;
    }

    const targetIndex =
        direction === "next"
            ? (sourceIndex + 1) % paneIds.length
            : (sourceIndex - 1 + paneIds.length) % paneIds.length;
    const targetPaneId = paneIds[targetIndex];

    const targetPane = findPaneById(state.rootNode, targetPaneId);
    if (!targetPane) {
        return state;
    }

    return moveTabToPaneAtIndex(
        state,
        tabId,
        sourcePaneId,
        targetPaneId,
        targetPane.tabIds.length,
    );
}

export function reorderTabInPane(
    state: WorkspaceTreeState,
    paneId: string,
    tabId: string,
    targetIndex: number,
): WorkspaceTreeState {
    const pane = findPaneById(state.rootNode, paneId);
    if (!pane || !pane.tabIds.includes(tabId)) {
        return state;
    }

    const normalizedPane = normalizeWorkspacePaneNode(pane);
    const pinnedTabIds = getPanePinnedTabIds(normalizedPane);
    const pinnedTabIdSet = new Set(pinnedTabIds);
    const remainingTabIds = normalizedPane.tabIds.filter(
        (currentTabId) => currentTabId !== tabId,
    );
    const requestedIndex = normalizeTabInsertionIndex(
        targetIndex,
        remainingTabIds.length,
    );
    const isPinned = pinnedTabIdSet.has(tabId);
    const remainingPinnedCount = pinnedTabIds.filter(
        (currentTabId) => currentTabId !== tabId,
    ).length;
    const nextIndex = isPinned
        ? Math.min(requestedIndex, remainingPinnedCount)
        : Math.max(requestedIndex, remainingPinnedCount);
    const nextTabIds = [
        ...remainingTabIds.slice(0, nextIndex),
        tabId,
        ...remainingTabIds.slice(nextIndex),
    ];

    return {
        activePaneId: paneId,
        rootNode: replaceNode(state.rootNode, paneId, (node) => {
            if (node.type !== "pane") {
                return node;
            }

            return normalizeWorkspacePaneNode({
                ...node,
                activeTabId: node.activeTabId ?? tabId,
                pinnedTabIds: nextTabIds.filter((currentTabId) =>
                    pinnedTabIdSet.has(currentTabId),
                ),
                tabIds: nextTabIds,
            });
        }),
        tabsById: state.tabsById,
    };
}

export function pinTabInPane(
    state: WorkspaceTreeState,
    paneId: string,
    tabId: string,
): WorkspaceTreeState {
    const pane = findPaneById(state.rootNode, paneId);
    if (!pane || !pane.tabIds.includes(tabId)) {
        return state;
    }

    const pinnedTabIds = getPanePinnedTabIds(pane);
    if (pinnedTabIds.includes(tabId)) {
        return state;
    }

    return {
        ...state,
        rootNode: replaceNode(state.rootNode, paneId, (node) => {
            if (node.type !== "pane") {
                return node;
            }

            return normalizeWorkspacePaneNode({
                ...node,
                pinnedTabIds: [...pinnedTabIds, tabId],
            });
        }),
    };
}

export function unpinTabInPane(
    state: WorkspaceTreeState,
    paneId: string,
    tabId: string,
): WorkspaceTreeState {
    const pane = findPaneById(state.rootNode, paneId);
    if (!pane) {
        return state;
    }

    const pinnedTabIds = getPanePinnedTabIds(pane);
    if (!pinnedTabIds.includes(tabId)) {
        return state;
    }

    return {
        ...state,
        rootNode: replaceNode(state.rootNode, paneId, (node) => {
            if (node.type !== "pane") {
                return node;
            }

            return normalizeWorkspacePaneNode({
                ...node,
                pinnedTabIds: pinnedTabIds.filter(
                    (currentTabId) => currentTabId !== tabId,
                ),
            });
        }),
    };
}

export function moveTabToPaneAtIndex(
    state: WorkspaceTreeState,
    tabId: string,
    sourcePaneId: string,
    targetPaneId: string,
    targetIndex: number,
    options?: {
        readonly preserveEmptySourcePane?: boolean;
    },
): WorkspaceTreeState {
    if (sourcePaneId === targetPaneId) {
        return reorderTabInPane(state, targetPaneId, tabId, targetIndex);
    }

    const sourcePane = findPaneById(state.rootNode, sourcePaneId);
    const targetPane = findPaneById(state.rootNode, targetPaneId);
    if (!sourcePane || !targetPane || !sourcePane.tabIds.includes(tabId)) {
        return state;
    }

    const withoutSourceTab = replacePaneTabs(
        state,
        sourcePaneId,
        (existingTabIds, activeTabId) => {
            const nextTabIds = existingTabIds.filter(
                (currentTabId) => currentTabId !== tabId,
            );
            return {
                activeTabId:
                    activeTabId === tabId
                        ? (nextTabIds.at(-1) ?? null)
                        : activeTabId,
                tabIds: nextTabIds,
            };
        },
    );

    const nextState = {
        activePaneId: targetPaneId,
        rootNode: replaceNode(
            withoutSourceTab.rootNode,
            targetPaneId,
            (node) => {
                if (node.type !== "pane") {
                    return node;
                }

                const existingTabIds = node.tabIds.filter(
                    (currentTabId) => currentTabId !== tabId,
                );
                const pinnedTabIds = getPanePinnedTabIds(node).filter(
                    (currentTabId) => currentTabId !== tabId,
                );
                const requestedIndex = normalizeTabInsertionIndex(
                    targetIndex,
                    existingTabIds.length,
                );
                const nextIndex = Math.max(
                    requestedIndex,
                    pinnedTabIds.length,
                );
                const nextTabIds = [
                    ...existingTabIds.slice(0, nextIndex),
                    tabId,
                    ...existingTabIds.slice(nextIndex),
                ];

                return normalizeWorkspacePaneNode({
                    ...node,
                    activeTabId: tabId,
                    pinnedTabIds,
                    tabIds: nextTabIds,
                });
            },
        ),
        tabsById: withoutSourceTab.tabsById,
    };

    if (options?.preserveEmptySourcePane) {
        return nextState;
    }

    return closeEmptyPaneIfNeeded(nextState, sourcePaneId);
}

export function moveTabToSplit(
    state: WorkspaceTreeState,
    tabId: string,
    sourcePaneId: string,
    targetPaneId: string,
    direction: SplitDirection,
    nextIds: {
        readonly paneId: string;
        readonly splitId: string;
    },
): WorkspaceTreeState {
    const sourcePane = findPaneById(state.rootNode, sourcePaneId);
    const targetPane = findPaneById(state.rootNode, targetPaneId);
    if (!sourcePane || !targetPane || !sourcePane.tabIds.includes(tabId)) {
        return state;
    }

    const splitState = splitPaneInDirection(
        state,
        targetPaneId,
        direction,
        nextIds,
    );

    return moveTabToPaneAtIndex(
        splitState,
        tabId,
        sourcePaneId,
        nextIds.paneId,
        0,
        {
            preserveEmptySourcePane: sourcePaneId === targetPaneId,
        },
    );
}

export function closeOtherWorkspaceTabs(
    state: WorkspaceTreeState,
    tabId: string,
): WorkspaceTreeState {
    const paneId = findPaneIdForTab(state.rootNode, tabId);
    if (!paneId) {
        return state;
    }

    const pane = findPaneById(state.rootNode, paneId);
    if (!pane || !pane.tabIds.includes(tabId)) {
        return state;
    }

    const tabIdsToClose = pane.tabIds.filter(
        (currentTabId) => currentTabId !== tabId,
    );

    return tabIdsToClose.reduce(
        (currentState, currentTabId) =>
            closeWorkspaceTab(currentState, currentTabId),
        state,
    );
}

export function closeWorkspaceTabsToRight(
    state: WorkspaceTreeState,
    tabId: string,
): WorkspaceTreeState {
    const paneId = findPaneIdForTab(state.rootNode, tabId);
    if (!paneId) {
        return state;
    }

    const pane = findPaneById(state.rootNode, paneId);
    if (!pane) {
        return state;
    }

    const tabIndex = pane.tabIds.indexOf(tabId);
    if (tabIndex === -1 || tabIndex === pane.tabIds.length - 1) {
        return state;
    }

    const tabIdsToClose = pane.tabIds.slice(tabIndex + 1);

    return tabIdsToClose.reduce(
        (currentState, currentTabId) =>
            closeWorkspaceTab(currentState, currentTabId),
        state,
    );
}

export function closeWorkspaceTabsForProjectPath(
    state: WorkspaceTreeState,
    projectId: string,
    worktreeId: string | null,
    relativePath: string,
    kind: "directory" | "file",
): WorkspaceTreeState {
    const tabIdsToClose = Object.values(state.tabsById)
        .filter(
            (tab): tab is RuntimeWorkspaceFileTab =>
                tab.kind === "file" &&
                tab.projectId === projectId &&
                areGitWorktreeIdsEquivalent(
                    projectId,
                    tab.worktreeId ?? null,
                    worktreeId,
                ) &&
                matchesProjectPath(tab.relativePath, relativePath, kind),
        )
        .map((tab) => tab.id);

    return tabIdsToClose.reduce(
        (currentState, tabId) => closeWorkspaceTab(currentState, tabId),
        state,
    );
}

export function renameWorkspaceTabsForProjectPath(
    state: WorkspaceTreeState,
    projectId: string,
    worktreeId: string | null,
    previousRelativePath: string,
    nextRelativePath: string,
    kind: "directory" | "file",
): WorkspaceTreeState {
    const nextTabsById = Object.fromEntries(
        Object.entries(state.tabsById).map(([tabId, tab]) => {
            if (
                tab.kind !== "file" ||
                tab.projectId !== projectId ||
                !areGitWorktreeIdsEquivalent(
                    projectId,
                    tab.worktreeId ?? null,
                    worktreeId,
                ) ||
                !matchesProjectPath(
                    tab.relativePath,
                    previousRelativePath,
                    kind,
                )
            ) {
                return [tabId, tab];
            }

            const tabNextRelativePath =
                kind === "file"
                    ? nextRelativePath
                    : `${nextRelativePath}${tab.relativePath.slice(previousRelativePath.length)}`;
            const nextTitle = getFileTitle(tabNextRelativePath);

            return [
                tabId,
                {
                    ...tab,
                    document: tab.document
                        ? {
                              ...tab.document,
                              absolutePath: rebaseAbsolutePath(
                                  tab.document.absolutePath,
                                  tab.relativePath,
                                  tabNextRelativePath,
                              ),
                              name: nextTitle,
                              relativePath: tabNextRelativePath,
                          }
                        : null,
                    relativePath: tabNextRelativePath,
                    title: nextTitle,
                } satisfies RuntimeWorkspaceFileTab,
            ];
        }),
    ) as Record<string, RuntimeWorkspaceTab>;

    return {
        ...state,
        tabsById: nextTabsById,
    };
}

export function updateChatDraft(
    state: WorkspaceTreeState,
    tabId: string,
    draft: string,
): WorkspaceTreeState {
    const tab = state.tabsById[tabId];
    if (!tab || tab.kind !== "chat") {
        return state;
    }

    return {
        ...state,
        tabsById: {
            ...state.tabsById,
            [tabId]: {
                ...tab,
                draft,
            },
        },
    };
}

export function updateFileDraft(
    state: WorkspaceTreeState,
    tabId: string,
    draftContent: string,
): WorkspaceTreeState {
    const sourceTab = state.tabsById[tabId];
    if (!sourceTab || sourceTab.kind !== "file") {
        return state;
    }

    const contentRevision =
        sourceTab.draftContent === draftContent
            ? getFileContentRevision(sourceTab)
            : getFileContentRevision(sourceTab) + 1;

    return updateMatchingFileTabs(state, tabId, (tab) => ({
        ...tab,
        contentRevision,
        draftContent,
        isDirty: draftContent !== tab.savedContent,
        saveError: null,
    }));
}

export function setFileTabReviewContext(
    state: WorkspaceTreeState,
    tabId: string,
    reviewContext: RuntimeWorkspaceFileReviewContext | null,
): WorkspaceTreeState {
    const tab = state.tabsById[tabId];
    if (!tab || tab.kind !== "file") {
        return state;
    }

    return {
        ...state,
        tabsById: {
            ...state.tabsById,
            [tabId]: {
                ...tab,
                reviewContext,
            },
        },
    };
}

export function setFileTabPendingOpenLocation(
    state: WorkspaceTreeState,
    tabId: string,
    pendingOpenLocation: RuntimeWorkspaceFileOpenLocation | null,
): WorkspaceTreeState {
    const tab = state.tabsById[tabId];
    if (!tab || tab.kind !== "file") {
        return state;
    }

    return {
        ...state,
        tabsById: {
            ...state.tabsById,
            [tabId]: {
                ...tab,
                pendingOpenLocation,
            },
        },
    };
}

export function setFileTabMarkdownViewMode(
    state: WorkspaceTreeState,
    tabId: string,
    markdownViewMode: MarkdownFileViewMode,
): WorkspaceTreeState {
    const tab = state.tabsById[tabId];
    if (!tab || tab.kind !== "file") {
        return state;
    }

    if (!isMarkdownFilePath(tab.relativePath)) {
        const { markdownViewMode: _markdownViewMode, ...nextTab } = tab;
        void _markdownViewMode;

        return {
            ...state,
            tabsById: {
                ...state.tabsById,
                [tabId]: nextTab,
            },
        };
    }

    return {
        ...state,
        tabsById: {
            ...state.tabsById,
            [tabId]: {
                ...tab,
                markdownViewMode,
            },
        },
    };
}

export function setFileTabMarkdownPreviewScrollTop(
    state: WorkspaceTreeState,
    tabId: string,
    markdownPreviewScrollTop: number,
): WorkspaceTreeState {
    const tab = state.tabsById[tabId];
    if (!tab || tab.kind !== "file" || !isMarkdownFilePath(tab.relativePath)) {
        return state;
    }

    const nextScrollTop = Math.max(0, Math.round(markdownPreviewScrollTop));
    if ((tab.markdownPreviewScrollTop ?? 0) === nextScrollTop) {
        return state;
    }

    return {
        ...state,
        tabsById: {
            ...state.tabsById,
            [tabId]: {
                ...tab,
                markdownPreviewScrollTop: nextScrollTop,
            },
        },
    };
}

export function setFileTabViewState(
    state: WorkspaceTreeState,
    tabId: string,
    viewState: MonacoEditor.ICodeEditorViewState | null,
): WorkspaceTreeState {
    const tab = state.tabsById[tabId];
    if (!tab || tab.kind !== "file") {
        return state;
    }

    return {
        ...state,
        tabsById: {
            ...state.tabsById,
            [tabId]: {
                ...tab,
                viewState,
            },
        },
    };
}

export function replaceFileDocument(
    state: WorkspaceTreeState,
    tabId: string,
    document: ProjectFileDocument,
): WorkspaceTreeState {
    const sourceTab = state.tabsById[tabId];
    if (!sourceTab || sourceTab.kind !== "file") {
        return state;
    }

    const contentRevision =
        sourceTab.draftContent === document.content &&
        sourceTab.document?.modifiedAtMs === document.modifiedAtMs
            ? getFileContentRevision(sourceTab)
            : getFileContentRevision(sourceTab) + 1;

    return updateMatchingFileTabs(state, tabId, (tab) => ({
        ...tab,
        contentRevision,
        document,
        draftContent: document.content,
        hasExternalChange: false,
        isDirty: false,
        isLoading: false,
        isSaving: false,
        loadError: null,
        saveError: null,
        savedContent: document.content,
        title: document.name,
    }));
}

export function completeFileSave(
    state: WorkspaceTreeState,
    tabId: string,
    document: ProjectFileDocument,
    savedDraftContent: string,
): WorkspaceTreeState {
    return updateMatchingFileTabs(state, tabId, (tab) => {
        const draftContent =
            tab.draftContent === savedDraftContent
                ? document.content
                : tab.draftContent;

        return {
            ...tab,
            // Saving acknowledges an existing buffer revision; it must not
            // make an older asynchronous response current again.
            contentRevision: getFileContentRevision(tab),
            document,
            draftContent,
            hasExternalChange: false,
            isDirty: draftContent !== document.content,
            isLoading: false,
            isSaving: false,
            loadError: null,
            saveError: null,
            savedContent: document.content,
            title: document.name,
        };
    });
}

export function getFileContentRevision(tab: RuntimeWorkspaceFileTab): number {
    // Persisted workspaces from before buffer versioning are revision zero.
    return tab.contentRevision ?? 0;
}

export function setFileTabSaving(
    state: WorkspaceTreeState,
    tabId: string,
    isSaving: boolean,
    saveError: string | null = null,
): WorkspaceTreeState {
    return updateMatchingFileTabs(state, tabId, (tab) => ({
        ...tab,
        isSaving,
        saveError,
    }));
}

export function setFileTabExternalChange(
    state: WorkspaceTreeState,
    tabId: string,
    hasExternalChange: boolean,
    saveError?: string | null,
): WorkspaceTreeState {
    return updateMatchingFileTabs(state, tabId, (tab) => ({
        ...tab,
        hasExternalChange,
        saveError: saveError === undefined ? tab.saveError : saveError,
    }));
}

export function setFileTabLoadError(
    state: WorkspaceTreeState,
    tabId: string,
    loadError: string,
): WorkspaceTreeState {
    return updateMatchingFileTabs(state, tabId, (tab) => ({
        ...tab,
        document: null,
        isSaving: false,
        isLoading: false,
        loadError,
    }));
}

export function setFileTabLoading(
    state: WorkspaceTreeState,
    tabId: string,
    isLoading: boolean,
): WorkspaceTreeState {
    return updateMatchingFileTabs(state, tabId, (tab) => ({
        ...tab,
        isLoading,
        loadError: isLoading ? null : tab.loadError,
    }));
}

export function collectPaneNodes(node: WorkspaceNode): WorkspacePaneNode[] {
    if (node.type === "pane") {
        return [node];
    }

    return node.children.flatMap((child) => collectPaneNodes(child));
}

export function findWorkspaceNodeById(
    node: WorkspaceNode,
    nodeId: string,
): WorkspaceNode | null {
    if (node.id === nodeId) {
        return node;
    }

    if (node.type === "pane") {
        return null;
    }

    for (const child of node.children) {
        const match = findWorkspaceNodeById(child, nodeId);
        if (match) {
            return match;
        }
    }

    return null;
}

export function findPaneById(
    node: WorkspaceNode,
    paneId: string,
): WorkspacePaneNode | null {
    const match = findWorkspaceNodeById(node, paneId);
    return match?.type === "pane" ? match : null;
}

export function findPaneIdForTab(
    node: WorkspaceNode,
    tabId: string,
): string | null {
    for (const pane of collectPaneNodes(node)) {
        if (pane.tabIds.includes(tabId)) {
            return pane.id;
        }
    }

    return null;
}

function moveTabBetweenPanes(
    state: WorkspaceTreeState,
    tabId: string,
    sourcePaneId: string,
    targetPaneId: string,
): WorkspaceTreeState {
    const targetPane = findPaneById(state.rootNode, targetPaneId);
    if (!targetPane) {
        return state;
    }

    return moveTabToPaneAtIndex(
        state,
        tabId,
        sourcePaneId,
        targetPaneId,
        targetPane.tabIds.length,
    );
}

function replacePaneTabs(
    state: WorkspaceTreeState,
    paneId: string,
    updater: (
        tabIds: readonly string[],
        activeTabId: string | null,
        pinnedTabIds: readonly string[],
    ) => {
        readonly activeTabId: string | null;
        readonly pinnedTabIds?: readonly string[];
        readonly tabIds: readonly string[];
    },
): WorkspaceTreeState {
    return {
        ...state,
        rootNode: replaceNode(state.rootNode, paneId, (node) => {
            if (node.type !== "pane") {
                return node;
            }

            const nextPaneState = updater(
                node.tabIds,
                node.activeTabId,
                getPanePinnedTabIds(node),
            );
            return normalizeWorkspacePaneNode({
                ...node,
                activeTabId: nextPaneState.activeTabId,
                pinnedTabIds:
                    nextPaneState.pinnedTabIds ?? getPanePinnedTabIds(node),
                tabIds: nextPaneState.tabIds,
            });
        }),
    };
}

function replaceNode(
    node: WorkspaceNode,
    targetId: string,
    updater: (node: WorkspaceNode) => WorkspaceNode,
): WorkspaceNode {
    if (node.id === targetId) {
        return updater(node);
    }

    if (node.type === "pane") {
        return node;
    }

    for (let index = 0; index < node.children.length; index += 1) {
        const child = node.children[index];
        const nextChild = replaceNode(child, targetId, updater);
        if (nextChild === child) {
            continue;
        }

        const nextChildren = [...node.children];
        nextChildren[index] = nextChild;
        return { ...node, children: nextChildren };
    }

    return node;
}

function removePane(node: WorkspaceNode, paneId: string): WorkspaceNode | null {
    if (node.type === "pane") {
        return node.id === paneId ? null : node;
    }

    const nextChildren = node.children
        .map((child) => removePane(child, paneId))
        .filter((child): child is WorkspaceNode => child !== null);

    if (nextChildren.length === 0) {
        return null;
    }

    if (nextChildren.length === 1) {
        return nextChildren[0];
    }

    return {
        ...node,
        children: nextChildren,
        sizes: normalizeSizes(
            node.sizes.filter((_, index) => index < nextChildren.length),
        ),
    };
}

function closeEmptyPaneIfNeeded(
    state: WorkspaceTreeState,
    paneId: string,
): WorkspaceTreeState {
    const pane = findPaneById(state.rootNode, paneId);
    if (!pane || pane.tabIds.length > 0) {
        return state;
    }

    const paneCount = collectPaneNodes(state.rootNode).length;
    if (paneCount <= 1) {
        return state;
    }

    return closeWorkspacePane(state, paneId);
}

function normalizeSizes(sizes: readonly number[]): readonly number[] {
    const minSize = 0.12;
    const clamped = sizes.map((size) => Math.max(minSize, size));
    const total = clamped.reduce((sum, size) => sum + size, 0) || 1;
    return clamped.map((size) => size / total);
}

function normalizeTabInsertionIndex(index: number, length: number): number {
    if (!Number.isFinite(index)) {
        return length;
    }

    return Math.min(Math.max(Math.trunc(index), 0), length);
}

function updateMatchingFileTabs(
    state: WorkspaceTreeState,
    tabId: string,
    updateTab: (tab: RuntimeWorkspaceFileTab) => RuntimeWorkspaceFileTab,
): WorkspaceTreeState {
    const sourceTab = state.tabsById[tabId];
    if (!sourceTab || sourceTab.kind !== "file") {
        return state;
    }

    return {
        ...state,
        tabsById: Object.fromEntries(
            Object.entries(state.tabsById).map(([currentTabId, tab]) => {
                if (
                    tab.kind !== "file" ||
                    !matchesSameWorkspaceFile(tab, sourceTab)
                ) {
                    return [currentTabId, tab];
                }

                return [currentTabId, updateTab(tab)];
            }),
        ),
    };
}

function stripRuntimeTab(tab: RuntimeWorkspaceTab): WorkspaceTab {
    if (tab.kind === "file") {
        const markdownViewMode =
            isMarkdownFilePath(tab.relativePath) &&
            (tab.markdownViewMode === "preview" ||
                tab.markdownViewMode === "edit")
                ? tab.markdownViewMode
                : undefined;

        return {
            createdAt: tab.createdAt,
            id: tab.id,
            kind: tab.kind,
            ...(markdownViewMode ? { markdownViewMode } : {}),
            projectId: tab.projectId,
            relativePath: tab.relativePath,
            title: tab.title,
            worktreeId: tab.worktreeId ?? null,
        };
    }

    if (tab.kind === "terminal") {
        return {
            createdAt: tab.createdAt,
            id: tab.id,
            kind: tab.kind,
            projectId: tab.projectId,
            sessionId: tab.sessionId,
            terminalId: tab.terminalId,
            title: tab.title,
            worktreeId: tab.worktreeId ?? null,
        };
    }

    if (tab.kind === "review") {
        return tab;
    }

    if (tab.kind === "chat_history") {
        return tab;
    }

    if (tab.kind === "git") {
        return tab;
    }

    if (tab.kind === "git_commit") {
        return tab;
    }

    return tab;
}

function normalizeRuntimeTabsForWorkspace(
    tabsById: Record<string, RuntimeWorkspaceTab>,
): Record<string, RuntimeWorkspaceTab> {
    return Object.fromEntries(
        Object.entries(tabsById).map(([tabId, tab]) => {
            if (tab.kind !== "file") {
                return [tabId, tab];
            }

            const normalizedTab = {
                ...tab,
                contentRevision: getFileContentRevision(tab),
            };

            if (!isMarkdownFilePath(tab.relativePath)) {
                const { markdownViewMode: _markdownViewMode, ...nextTab } =
                    normalizedTab;
                void _markdownViewMode;
                return [tabId, nextTab];
            }

            return [
                tabId,
                {
                    ...normalizedTab,
                    markdownViewMode:
                        tab.markdownViewMode === "preview" ? "preview" : "edit",
                },
            ];
        }),
    ) as Record<string, RuntimeWorkspaceTab>;
}

function sanitizeNodeForSnapshot(
    node: WorkspaceNode,
    persistedTabIds: ReadonlySet<string>,
): WorkspaceNode {
    if (node.type === "pane") {
        const nextTabIds = node.tabIds.filter((tabId) => persistedTabIds.has(tabId));
        const pinnedTabIds = getPanePinnedTabIds(node).filter((tabId) =>
            persistedTabIds.has(tabId),
        );
        const nextActiveTabId =
            node.activeTabId && persistedTabIds.has(node.activeTabId)
                ? node.activeTabId
                : (nextTabIds.at(-1) ?? null);

        return normalizeWorkspacePaneNode({
            ...node,
            activeTabId: nextActiveTabId,
            pinnedTabIds,
            tabIds: nextTabIds,
        });
    }

    return {
        ...node,
        children: node.children.map((child) =>
            sanitizeNodeForSnapshot(child, persistedTabIds),
        ),
    };
}

function normalizeWorkspaceNodeTabs(node: WorkspaceNode): WorkspaceNode {
    if (node.type === "pane") {
        return normalizeWorkspacePaneNode(node);
    }

    return {
        ...node,
        children: node.children.map(normalizeWorkspaceNodeTabs),
    };
}

function normalizeWorkspacePaneNode(
    pane: WorkspacePaneNode,
): WorkspacePaneNode {
    const pinnedTabIds = getPanePinnedTabIds(pane);
    const pinnedTabIdSet = new Set(pinnedTabIds);
    const orderedTabIds = [
        ...pinnedTabIds,
        ...pane.tabIds.filter((tabId) => !pinnedTabIdSet.has(tabId)),
    ];

    if (pinnedTabIds.length === 0) {
        return {
            activeTabId: pane.activeTabId,
            id: pane.id,
            tabIds: orderedTabIds,
            type: "pane",
        };
    }

    return {
        activeTabId: pane.activeTabId,
        id: pane.id,
        pinnedTabIds,
        tabIds: orderedTabIds,
        type: "pane",
    };
}

function getPanePinnedTabIds(pane: WorkspacePaneNode): string[] {
    const tabIdSet = new Set(pane.tabIds);
    const seenPinnedTabIds = new Set<string>();

    return (pane.pinnedTabIds ?? []).filter((tabId) => {
        if (!tabIdSet.has(tabId) || seenPinnedTabIds.has(tabId)) {
            return false;
        }

        seenPinnedTabIds.add(tabId);
        return true;
    });
}

function omitTabFromMap(
    tabsById: Record<string, RuntimeWorkspaceTab>,
    tabId: string,
): Record<string, RuntimeWorkspaceTab> {
    return Object.fromEntries(
        Object.entries(tabsById).filter(
            ([currentTabId]) => currentTabId !== tabId,
        ),
    );
}

function matchesProjectPath(
    candidatePath: string,
    targetPath: string,
    kind: "directory" | "file",
): boolean {
    if (kind === "file") {
        return candidatePath === targetPath;
    }

    return (
        candidatePath === targetPath ||
        candidatePath.startsWith(`${targetPath}/`)
    );
}

function matchesSameWorkspaceFile(
    left: RuntimeWorkspaceFileTab,
    right: RuntimeWorkspaceFileTab,
): boolean {
    return (
        left.projectId === right.projectId &&
        areGitWorktreeIdsEquivalent(
            left.projectId,
            left.worktreeId ?? null,
            right.worktreeId ?? null,
        ) &&
        left.relativePath === right.relativePath
    );
}

function rebaseAbsolutePath(
    absolutePath: string,
    previousRelativePath: string,
    nextRelativePath: string,
): string {
    const separator = absolutePath.includes("\\") ? "\\" : "/";
    const normalizedAbsolutePath = absolutePath.replaceAll("\\", "/");
    const normalizedPreviousPath = previousRelativePath.replaceAll("\\", "/");

    if (!normalizedAbsolutePath.endsWith(normalizedPreviousPath)) {
        return absolutePath;
    }

    const prefix = normalizedAbsolutePath.slice(
        0,
        normalizedAbsolutePath.length - normalizedPreviousPath.length,
    );

    return `${prefix}${nextRelativePath}`.replaceAll("/", separator);
}

function getFileTitle(relativePath: string): string {
    return relativePath.split("/").at(-1) ?? relativePath;
}

function isTransientWorkspaceTab(tab: RuntimeWorkspaceTab): boolean {
    return tab.kind === "file" && tab.isTransient === true;
}
