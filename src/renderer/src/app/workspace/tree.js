export function createDefaultWorkspaceState() {
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
export function workspaceStateFromSnapshot(snapshot, tabsById) {
    return {
        activePaneId: snapshot.activePaneId,
        rootNode: snapshot.rootNode,
        tabsById,
    };
}
export function workspaceStateToSnapshot(state) {
    const orderedTabIds = collectPaneNodes(state.rootNode).flatMap((pane) => pane.tabIds);
    return {
        activePaneId: state.activePaneId,
        rootNode: state.rootNode,
        tabs: orderedTabIds
            .map((tabId) => state.tabsById[tabId])
            .filter((tab) => Boolean(tab))
            .map(stripRuntimeTab),
    };
}
export function splitPaneInDirection(state, paneId, direction, nextIds) {
    const nextPane = {
        activeTabId: null,
        id: nextIds.paneId,
        tabIds: [],
        type: "pane",
    };
    const axis = direction === "left" || direction === "right"
        ? "horizontal"
        : "vertical";
    const nextRootNode = replaceNode(state.rootNode, paneId, (node) => {
        if (node.type !== "pane") {
            return node;
        }
        const children = direction === "left" || direction === "up"
            ? [nextPane, node]
            : [node, nextPane];
        return {
            axis,
            children,
            id: nextIds.splitId,
            sizes: [0.5, 0.5],
            type: "split",
        };
    });
    return {
        ...state,
        activePaneId: nextPane.id,
        rootNode: nextRootNode,
    };
}
export function resizeSplit(node, splitId, nextSizes) {
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
export function activatePane(state, paneId) {
    return {
        ...state,
        activePaneId: paneId,
    };
}
export function attachTabToPane(state, paneId, tab) {
    const existingPaneId = findPaneIdForTab(state.rootNode, tab.id);
    const stateWithoutTab = existingPaneId !== null
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
export function selectPaneTab(state, paneId, tabId) {
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
export function closeWorkspaceTab(state, tabId) {
    const paneId = findPaneIdForTab(state.rootNode, tabId);
    if (!paneId) {
        return state;
    }
    const nextRootNode = replaceNode(state.rootNode, paneId, (node) => {
        if (node.type !== "pane") {
            return node;
        }
        const nextTabIds = node.tabIds.filter((currentTabId) => currentTabId !== tabId);
        const nextActiveTabId = node.activeTabId === tabId
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
export function closeWorkspacePane(state, paneId) {
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
    let nextState = {
        ...state,
        activePaneId: state.activePaneId === paneId
            ? fallbackPane.id
            : state.activePaneId,
        rootNode: rootNodeWithoutPane,
    };
    if (pane.tabIds.length > 0) {
        nextState = replacePaneTabs(nextState, fallbackPane.id, (existingTabIds) => ({
            activeTabId: pane.activeTabId ?? pane.tabIds.at(-1) ?? null,
            tabIds: [...existingTabIds, ...pane.tabIds],
        }));
    }
    return nextState;
}
export function moveActiveTabBetweenPanes(state, paneId, direction) {
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
    const targetIndex = direction === "next"
        ? (sourceIndex + 1) % paneIds.length
        : (sourceIndex - 1 + paneIds.length) % paneIds.length;
    const targetPaneId = paneIds[targetIndex];
    return moveTabBetweenPanes(state, sourcePane.activeTabId, paneId, targetPaneId);
}
export function moveWorkspaceTabBetweenPanes(state, tabId, direction) {
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
    const targetIndex = direction === "next"
        ? (sourceIndex + 1) % paneIds.length
        : (sourceIndex - 1 + paneIds.length) % paneIds.length;
    const targetPaneId = paneIds[targetIndex];
    return moveTabBetweenPanes(state, tabId, sourcePaneId, targetPaneId);
}
export function closeOtherWorkspaceTabs(state, tabId) {
    const paneId = findPaneIdForTab(state.rootNode, tabId);
    if (!paneId) {
        return state;
    }
    const pane = findPaneById(state.rootNode, paneId);
    if (!pane || !pane.tabIds.includes(tabId)) {
        return state;
    }
    const tabIdsToClose = pane.tabIds.filter((currentTabId) => currentTabId !== tabId);
    return tabIdsToClose.reduce((currentState, currentTabId) => closeWorkspaceTab(currentState, currentTabId), state);
}
export function closeWorkspaceTabsToRight(state, tabId) {
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
    return tabIdsToClose.reduce((currentState, currentTabId) => closeWorkspaceTab(currentState, currentTabId), state);
}
export function closeWorkspaceTabsForProjectPath(state, projectId, relativePath, kind) {
    const tabIdsToClose = Object.values(state.tabsById)
        .filter((tab) => tab.kind === "file" &&
        tab.projectId === projectId &&
        matchesProjectPath(tab.relativePath, relativePath, kind))
        .map((tab) => tab.id);
    return tabIdsToClose.reduce((currentState, tabId) => closeWorkspaceTab(currentState, tabId), state);
}
export function renameWorkspaceTabsForProjectPath(state, projectId, previousRelativePath, nextRelativePath, kind) {
    const nextTabsById = Object.fromEntries(Object.entries(state.tabsById).map(([tabId, tab]) => {
        if (tab.kind !== "file" ||
            tab.projectId !== projectId ||
            !matchesProjectPath(tab.relativePath, previousRelativePath, kind)) {
            return [tabId, tab];
        }
        const tabNextRelativePath = kind === "file"
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
                        absolutePath: rebaseAbsolutePath(tab.document.absolutePath, tab.relativePath, tabNextRelativePath),
                        name: nextTitle,
                        relativePath: tabNextRelativePath,
                    }
                    : null,
                relativePath: tabNextRelativePath,
                title: nextTitle,
            },
        ];
    }));
    return {
        ...state,
        tabsById: nextTabsById,
    };
}
export function updateChatDraft(state, tabId, draft) {
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
export function updateFileDraft(state, tabId, draftContent) {
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
export function replaceFileDocument(state, tabId, document) {
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
export function setFileTabSaving(state, tabId, isSaving, saveError = null) {
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
export function setFileTabLoadError(state, tabId, loadError) {
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
export function setFileTabLoading(state, tabId, isLoading) {
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
export function setTerminalSessionReady(state, tabId, session) {
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
export function setTerminalLaunchError(state, tabId, launchError) {
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
export function appendTerminalOutput(state, sessionId, chunk) {
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
export function markTerminalExited(state, sessionId, exitCode, signalCode) {
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
export function removeProjectTabs(state, projectId) {
    const tabIdsToRemove = Object.values(state.tabsById)
        .filter((tab) => tab.projectId === projectId)
        .map((tab) => tab.id);
    return tabIdsToRemove.reduce((currentState, tabId) => closeWorkspaceTab(currentState, tabId), state);
}
export function collectPaneNodes(node) {
    if (node.type === "pane") {
        return [node];
    }
    return node.children.flatMap((child) => collectPaneNodes(child));
}
export function findPaneById(node, paneId) {
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
export function findPaneIdForTab(node, tabId) {
    for (const pane of collectPaneNodes(node)) {
        if (pane.tabIds.includes(tabId)) {
            return pane.id;
        }
    }
    return null;
}
export function findTerminalTabBySessionId(state, sessionId) {
    return (Object.values(state.tabsById).find((tab) => tab.kind === "terminal" && tab.sessionId === sessionId) ?? null);
}
function moveTabBetweenPanes(state, tabId, sourcePaneId, targetPaneId) {
    if (sourcePaneId === targetPaneId) {
        return selectPaneTab(state, targetPaneId, tabId);
    }
    const withoutSourceTab = replacePaneTabs(state, sourcePaneId, (existingTabIds, activeTabId) => {
        const nextTabIds = existingTabIds.filter((currentTabId) => currentTabId !== tabId);
        return {
            activeTabId: activeTabId === tabId
                ? (nextTabIds.at(-1) ?? null)
                : activeTabId,
            tabIds: nextTabIds,
        };
    });
    return {
        activePaneId: targetPaneId,
        rootNode: replaceNode(withoutSourceTab.rootNode, targetPaneId, (node) => {
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
        }),
        tabsById: withoutSourceTab.tabsById,
    };
}
function replacePaneTabs(state, paneId, updater) {
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
function replaceNode(node, targetId, updater) {
    if (node.id === targetId) {
        return updater(node);
    }
    if (node.type === "pane") {
        return node;
    }
    return {
        ...node,
        children: node.children.map((child) => replaceNode(child, targetId, updater)),
    };
}
function removePane(node, paneId) {
    if (node.type === "pane") {
        return node.id === paneId ? null : node;
    }
    const nextChildren = node.children
        .map((child) => removePane(child, paneId))
        .filter((child) => child !== null);
    if (nextChildren.length === 0) {
        return null;
    }
    if (nextChildren.length === 1) {
        return nextChildren[0];
    }
    return {
        ...node,
        children: nextChildren,
        sizes: normalizeSizes(node.sizes.filter((_, index) => index < nextChildren.length)),
    };
}
function normalizeSizes(sizes) {
    const minSize = 0.12;
    const clamped = sizes.map((size) => Math.max(minSize, size));
    const total = clamped.reduce((sum, size) => sum + size, 0) || 1;
    return clamped.map((size) => size / total);
}
function stripRuntimeTab(tab) {
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
    if (tab.kind === "review") {
        return tab;
    }
    return tab;
}
function omitTabFromMap(tabsById, tabId) {
    return Object.fromEntries(Object.entries(tabsById).filter(([currentTabId]) => currentTabId !== tabId));
}
function formatExitDetails(exitCode, signalCode) {
    if (signalCode !== null) {
        return `, signal ${signalCode}`;
    }
    if (exitCode !== null) {
        return `, code ${exitCode}`;
    }
    return "";
}
function matchesProjectPath(candidatePath, targetPath, kind) {
    if (kind === "file") {
        return candidatePath === targetPath;
    }
    return (candidatePath === targetPath ||
        candidatePath.startsWith(`${targetPath}/`));
}
function rebaseAbsolutePath(absolutePath, previousRelativePath, nextRelativePath) {
    const separator = absolutePath.includes("\\") ? "\\" : "/";
    const normalizedAbsolutePath = absolutePath.replaceAll("\\", "/");
    const normalizedPreviousPath = previousRelativePath.replaceAll("\\", "/");
    if (!normalizedAbsolutePath.endsWith(normalizedPreviousPath)) {
        return absolutePath;
    }
    const prefix = normalizedAbsolutePath.slice(0, normalizedAbsolutePath.length - normalizedPreviousPath.length);
    return `${prefix}${nextRelativePath}`.replaceAll("/", separator);
}
function getFileTitle(relativePath) {
    return relativePath.split("/").at(-1) ?? relativePath;
}
