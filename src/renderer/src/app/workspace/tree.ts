import type {
    ProjectFileDocument,
    TerminalSession,
    WorkspaceChatTab,
    WorkspaceFileTab,
    WorkspaceNode,
    WorkspacePaneNode,
    WorkspaceSnapshot,
    WorkspaceSplitNode,
    WorkspaceTab,
    WorkspaceTerminalTab,
} from "@shared/ipc";

export type SplitDirection = "down" | "left" | "right" | "up";
export type MoveDirection = "next" | "previous";

export interface RuntimeWorkspaceFileTab extends WorkspaceFileTab {
    readonly document: ProjectFileDocument | null;
    readonly draftContent: string;
    readonly isDirty: boolean;
    readonly isLoading: boolean;
    readonly isSaving: boolean;
    readonly loadError: string | null;
    readonly saveError: string | null;
    readonly savedContent: string;
}

export type RuntimeWorkspaceChatTab = WorkspaceChatTab;

export interface RuntimeWorkspaceTerminalTab extends WorkspaceTerminalTab {
    readonly exitCode: number | null;
    readonly isReady: boolean;
    readonly launchError: string | null;
    readonly output: string;
    readonly session: TerminalSession | null;
    readonly signalCode: number | null;
}

export type RuntimeWorkspaceTab =
    | RuntimeWorkspaceFileTab
    | RuntimeWorkspaceChatTab
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
        rootNode: snapshot.rootNode,
        tabsById,
    };
}

export function workspaceStateToSnapshot(
    state: WorkspaceTreeState,
): WorkspaceSnapshot {
    const orderedTabIds = collectPaneNodes(state.rootNode).flatMap(
        (pane) => pane.tabIds,
    );

    return {
        activePaneId: state.activePaneId,
        rootNode: state.rootNode,
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
        existingPaneId !== null
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

            return {
                ...node,
                activeTabId: tab.id,
                tabIds: [...node.tabIds, tab.id],
            };
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

            return {
                ...node,
                activeTabId: tabId,
            };
        }),
        tabsById: state.tabsById,
    };
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

        return {
            ...node,
            activeTabId: nextActiveTabId,
            tabIds: nextTabIds,
        };
    });

    return {
        ...state,
        rootNode: nextRootNode,
        tabsById: omitTabFromMap(state.tabsById, tabId),
    };
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
            (existingTabIds) => ({
                activeTabId: pane.activeTabId ?? pane.tabIds.at(-1) ?? null,
                tabIds: [...existingTabIds, ...pane.tabIds],
            }),
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
                draftContent,
                isDirty: draftContent !== tab.savedContent,
                saveError: null,
            },
        },
    };
}

export function replaceFileDocument(
    state: WorkspaceTreeState,
    tabId: string,
    document: ProjectFileDocument,
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
                document,
                draftContent: document.content,
                isDirty: false,
                isLoading: false,
                isSaving: false,
                loadError: null,
                saveError: null,
                savedContent: document.content,
                title: document.name,
            },
        },
    };
}

export function setFileTabSaving(
    state: WorkspaceTreeState,
    tabId: string,
    isSaving: boolean,
    saveError: string | null = null,
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
                isSaving,
                saveError,
            },
        },
    };
}

export function setFileTabLoadError(
    state: WorkspaceTreeState,
    tabId: string,
    loadError: string,
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
                document: null,
                isSaving: false,
                isLoading: false,
                loadError,
            },
        },
    };
}

export function setFileTabLoading(
    state: WorkspaceTreeState,
    tabId: string,
    isLoading: boolean,
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
                isLoading,
                loadError: isLoading ? null : tab.loadError,
            },
        },
    };
}

export function setTerminalSessionReady(
    state: WorkspaceTreeState,
    tabId: string,
    session: TerminalSession,
): WorkspaceTreeState {
    const tab = state.tabsById[tabId];
    if (!tab || tab.kind !== "terminal") {
        return state;
    }

    return {
        ...state,
        tabsById: {
            ...state.tabsById,
            [tabId]: {
                ...tab,
                isReady: true,
                launchError: null,
                session,
            },
        },
    };
}

export function setTerminalLaunchError(
    state: WorkspaceTreeState,
    tabId: string,
    launchError: string,
): WorkspaceTreeState {
    const tab = state.tabsById[tabId];
    if (!tab || tab.kind !== "terminal") {
        return state;
    }

    return {
        ...state,
        tabsById: {
            ...state.tabsById,
            [tabId]: {
                ...tab,
                isReady: false,
                launchError,
            },
        },
    };
}

export function appendTerminalOutput(
    state: WorkspaceTreeState,
    sessionId: string,
    chunk: string,
): WorkspaceTreeState {
    const tab = findTerminalTabBySessionId(state, sessionId);
    if (!tab) {
        return state;
    }

    return {
        ...state,
        tabsById: {
            ...state.tabsById,
            [tab.id]: {
                ...tab,
                output: `${tab.output}${chunk}`,
            },
        },
    };
}

export function markTerminalExited(
    state: WorkspaceTreeState,
    sessionId: string,
    exitCode: number | null,
    signalCode: number | null,
): WorkspaceTreeState {
    const tab = findTerminalTabBySessionId(state, sessionId);
    if (!tab) {
        return state;
    }

    const exitLine = `\r\n[process exited${formatExitDetails(exitCode, signalCode)}]\r\n`;

    return {
        ...state,
        tabsById: {
            ...state.tabsById,
            [tab.id]: {
                ...tab,
                exitCode,
                isReady: false,
                output: `${tab.output}${exitLine}`,
                signalCode,
            },
        },
    };
}

export function removeProjectTabs(
    state: WorkspaceTreeState,
    projectId: string,
): WorkspaceTreeState {
    const tabIdsToRemove = Object.values(state.tabsById)
        .filter((tab) => tab.projectId === projectId)
        .map((tab) => tab.id);

    return tabIdsToRemove.reduce(
        (currentState, tabId) => closeWorkspaceTab(currentState, tabId),
        state,
    );
}

export function collectPaneNodes(node: WorkspaceNode): WorkspacePaneNode[] {
    if (node.type === "pane") {
        return [node];
    }

    return node.children.flatMap((child) => collectPaneNodes(child));
}

export function findPaneById(
    node: WorkspaceNode,
    paneId: string,
): WorkspacePaneNode | null {
    if (node.type === "pane") {
        return node.id === paneId ? node : null;
    }

    for (const child of node.children) {
        const match = findPaneById(child, paneId);
        if (match) {
            return match;
        }
    }

    return null;
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

export function findTerminalTabBySessionId(
    state: WorkspaceTreeState,
    sessionId: string,
): RuntimeWorkspaceTerminalTab | null {
    return (
        Object.values(state.tabsById).find(
            (tab): tab is RuntimeWorkspaceTerminalTab =>
                tab.kind === "terminal" && tab.sessionId === sessionId,
        ) ?? null
    );
}

function moveTabBetweenPanes(
    state: WorkspaceTreeState,
    tabId: string,
    sourcePaneId: string,
    targetPaneId: string,
): WorkspaceTreeState {
    if (sourcePaneId === targetPaneId) {
        return selectPaneTab(state, targetPaneId, tabId);
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

    return {
        activePaneId: targetPaneId,
        rootNode: replaceNode(
            withoutSourceTab.rootNode,
            targetPaneId,
            (node) => {
                if (node.type !== "pane") {
                    return node;
                }

                return {
                    ...node,
                    activeTabId: tabId,
                    tabIds: node.tabIds.includes(tabId)
                        ? node.tabIds
                        : [...node.tabIds, tabId],
                };
            },
        ),
        tabsById: withoutSourceTab.tabsById,
    };
}

function replacePaneTabs(
    state: WorkspaceTreeState,
    paneId: string,
    updater: (
        tabIds: readonly string[],
        activeTabId: string | null,
    ) => {
        readonly activeTabId: string | null;
        readonly tabIds: readonly string[];
    },
): WorkspaceTreeState {
    return {
        ...state,
        rootNode: replaceNode(state.rootNode, paneId, (node) => {
            if (node.type !== "pane") {
                return node;
            }

            const nextPaneState = updater(node.tabIds, node.activeTabId);
            return {
                ...node,
                activeTabId: nextPaneState.activeTabId,
                tabIds: nextPaneState.tabIds,
            };
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

    return {
        ...node,
        children: node.children.map((child) =>
            replaceNode(child, targetId, updater),
        ),
    };
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

function normalizeSizes(sizes: readonly number[]): readonly number[] {
    const minSize = 0.12;
    const clamped = sizes.map((size) => Math.max(minSize, size));
    const total = clamped.reduce((sum, size) => sum + size, 0) || 1;
    return clamped.map((size) => size / total);
}

function stripRuntimeTab(tab: RuntimeWorkspaceTab): WorkspaceTab {
    if (tab.kind === "file") {
        return {
            createdAt: tab.createdAt,
            id: tab.id,
            kind: tab.kind,
            projectId: tab.projectId,
            relativePath: tab.relativePath,
            title: tab.title,
        };
    }

    if (tab.kind === "terminal") {
        return {
            createdAt: tab.createdAt,
            id: tab.id,
            kind: tab.kind,
            projectId: tab.projectId,
            sessionId: tab.sessionId,
            title: tab.title,
        };
    }

    return tab;
}

function omitTabFromMap(
    tabsById: Record<string, RuntimeWorkspaceTab>,
    tabId: string,
): Record<string, RuntimeWorkspaceTab> {
    return Object.fromEntries(
        Object.entries(tabsById).filter(
            ([currentTabId]) => currentTabId !== tabId,
        ),
    ) as Record<string, RuntimeWorkspaceTab>;
}

function formatExitDetails(
    exitCode: number | null,
    signalCode: number | null,
): string {
    if (signalCode !== null) {
        return `, signal ${signalCode}`;
    }

    if (exitCode !== null) {
        return `, code ${exitCode}`;
    }

    return "";
}
