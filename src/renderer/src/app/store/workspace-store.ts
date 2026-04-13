import { create } from "zustand";

import type {
    TerminalDataEvent,
    TerminalExitEvent,
    WorkspaceChatTab,
    WorkspaceSnapshot,
} from "@shared/ipc";

import {
    activatePane,
    appendTerminalOutput,
    attachTabToPane,
    closeOtherWorkspaceTabs,
    closeWorkspacePane,
    closeWorkspaceTab,
    closeWorkspaceTabsForProjectPath,
    closeWorkspaceTabsToRight,
    createDefaultWorkspaceState,
    markTerminalExited,
    moveActiveTabBetweenPanes,
    moveWorkspaceTabBetweenPanes,
    removeProjectTabs,
    renameWorkspaceTabsForProjectPath,
    replaceFileDocument,
    resizeSplit,
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
    type MoveDirection,
    type RuntimeWorkspaceFileTab,
    type RuntimeWorkspaceTab,
    type RuntimeWorkspaceTerminalTab,
    type SplitDirection,
    type WorkspaceTreeState,
} from "../workspace/tree";

interface WorkspaceStore extends WorkspaceTreeState {
    closeOtherTabs: (tabId: string) => Promise<void>;
    readonly error: string | null;
    readonly hydrated: boolean;
    appendTerminalOutput: (event: TerminalDataEvent) => void;
    closePane: (paneId: string) => Promise<void>;
    closeTab: (tabId: string) => Promise<void>;
    closeTabsToRight: (tabId: string) => Promise<void>;
    createChatTab: (projectId: string | null) => Promise<void>;
    createTerminalTab: (projectId: string | null) => Promise<void>;
    handleTerminalExit: (event: TerminalExitEvent) => void;
    hydrate: () => Promise<void>;
    moveActiveTab: (paneId: string, direction: MoveDirection) => Promise<void>;
    moveTab: (tabId: string, direction: MoveDirection) => Promise<void>;
    openFileTab: (projectId: string, relativePath: string) => Promise<void>;
    refreshProjectTabs: (projectId: string) => Promise<void>;
    removeProjectTabs: (projectId: string) => Promise<void>;
    closeTabsForProjectPath: (
        projectId: string,
        relativePath: string,
        kind: "directory" | "file",
    ) => Promise<void>;
    resizeSplit: (
        splitId: string,
        nextSizes: readonly number[],
    ) => Promise<void>;
    renameTabsForProjectPath: (
        projectId: string,
        previousRelativePath: string,
        nextRelativePath: string,
        kind: "directory" | "file",
    ) => Promise<void>;
    restartTerminalTab: (tabId: string) => Promise<void>;
    saveFileTab: (tabId: string) => Promise<void>;
    selectTab: (paneId: string, tabId: string) => Promise<void>;
    sendTerminalInput: (sessionId: string, data: string) => Promise<void>;
    setActivePane: (paneId: string) => Promise<void>;
    splitPane: (paneId: string, direction: SplitDirection) => Promise<void>;
    updateChatDraft: (tabId: string, draft: string) => Promise<void>;
    updateFileDraft: (tabId: string, draft: string) => void;
    updateTerminalSize: (
        sessionId: string,
        cols: number,
        rows: number,
    ) => Promise<void>;
}

type GetWorkspaceState = () => WorkspaceStore;

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
    ...createDefaultWorkspaceState(),
    error: null,
    hydrated: false,

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

    closeTabsForProjectPath: async (projectId, relativePath, kind) => {
        set((state) => ({
            ...closeWorkspaceTabsForProjectPath(
                state,
                projectId,
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

        set((state) => ({
            ...closeWorkspaceTab(state, tabId),
            error: null,
        }));
        await persistWorkspaceState(get);
    },

    createChatTab: async (projectId) => {
        const paneId = get().activePaneId;
        const tab: WorkspaceChatTab = {
            createdAt: new Date().toISOString(),
            draft: "",
            id: crypto.randomUUID(),
            kind: "chat",
            projectId,
            sessionId: crypto.randomUUID(),
            title: `Session ${countTabs(get, "chat") + 1}`,
        };

        set((state) => ({
            ...attachTabToPane(state, paneId, tab),
            error: null,
        }));
        await persistWorkspaceState(get);
    },

    createTerminalTab: async (projectId) => {
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
        };

        set((state) => ({
            ...attachTabToPane(state, state.activePaneId, tab),
            error: null,
        }));
        await persistWorkspaceState(get);
        await bootTerminalSession(get, set, tab.id);
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
            set({
                ...workspaceStateFromSnapshot(
                    snapshot,
                    createHydratedRuntimeTabs(snapshot),
                ),
                error: null,
                hydrated: true,
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
        set((state) => ({
            ...moveActiveTabBetweenPanes(state, paneId, direction),
            error: null,
        }));
        await persistWorkspaceState(get);
    },

    moveTab: async (tabId, direction) => {
        set((state) => ({
            ...moveWorkspaceTabBetweenPanes(state, tabId, direction),
            error: null,
        }));
        await persistWorkspaceState(get);
    },

    openFileTab: async (projectId, relativePath) => {
        try {
            const existingTab = findExistingFileTab(
                get(),
                projectId,
                relativePath,
            );
            if (existingTab) {
                const paneId = findPaneIdByTabId(get(), existingTab.id);
                if (!paneId) {
                    return;
                }

                set((state) => ({
                    ...selectPaneTab(state, paneId, existingTab.id),
                    error: null,
                }));

                if (!existingTab.document && !existingTab.isDirty) {
                    await reloadFileTab(get, set, existingTab.id);
                }

                await persistWorkspaceState(get);
                return;
            }

            const tab: RuntimeWorkspaceFileTab = {
                createdAt: new Date().toISOString(),
                document: null,
                draftContent: "",
                id: crypto.randomUUID(),
                isDirty: false,
                isLoading: true,
                isSaving: false,
                kind: "file",
                loadError: null,
                projectId,
                relativePath,
                savedContent: "",
                saveError: null,
                title: getFileTitle(relativePath),
            };

            set((state) => ({
                ...attachTabToPane(state, state.activePaneId, tab),
                error: null,
            }));
            await persistWorkspaceState(get);
            await reloadFileTab(get, set, tab.id);
        } catch (error) {
            set({
                error:
                    error instanceof Error
                        ? error.message
                        : "Could not open the selected file in the workspace.",
            });
        }
    },

    refreshProjectTabs: async (projectId) => {
        const fileTabs = Object.values(get().tabsById).filter(
            (tab): tab is RuntimeWorkspaceFileTab =>
                tab.kind === "file" && tab.projectId === projectId,
        );

        if (fileTabs.length === 0) {
            return;
        }

        await Promise.all(
            fileTabs.map(async (tab) => {
                if (tab.isDirty) {
                    return;
                }

                await reloadFileTab(get, set, tab.id);
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

    renameTabsForProjectPath: async (
        projectId,
        previousRelativePath,
        nextRelativePath,
        kind,
    ) => {
        set((state) => ({
            ...renameWorkspaceTabsForProjectPath(
                state,
                projectId,
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
        await persistWorkspaceState(get);
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

    saveFileTab: async (tabId) => {
        const tab = get().tabsById[tabId];
        if (!tab || tab.kind !== "file" || !tab.document || !tab.isDirty) {
            return;
        }

        set((state) => ({
            ...setFileTabSaving(state, tabId, true, null),
            error: null,
        }));

        try {
            const document = await getComandoApi().saveProjectFile({
                content: tab.draftContent,
                projectId: tab.projectId,
                relativePath: tab.relativePath,
            });

            set((state) => ({
                ...replaceFileDocument(state, tabId, document),
                error: null,
            }));
        } catch (error) {
            set((state) => ({
                ...setFileTabSaving(
                    state,
                    tabId,
                    false,
                    error instanceof Error
                        ? error.message
                        : "Could not save this file.",
                ),
                error:
                    error instanceof Error
                        ? error.message
                        : "Could not save this file.",
            }));
        }
    },

    selectTab: async (paneId, tabId) => {
        set((state) => ({
            ...selectPaneTab(state, paneId, tabId),
            error: null,
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

    setActivePane: async (paneId) => {
        set((state) => ({
            ...activatePane(state, paneId),
            error: null,
        }));
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
}));

type WorkspaceSetState = typeof useWorkspaceStore.setState;

function createHydratedRuntimeTabs(
    snapshot: WorkspaceSnapshot,
): Record<string, RuntimeWorkspaceTab> {
    return Object.fromEntries(
        snapshot.tabs.map((tab) => {
            if (tab.kind === "chat") {
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
                    isDirty: false,
                    isLoading: true,
                    isSaving: false,
                    loadError: null,
                    saveError: null,
                    savedContent: "",
                    title: getFileTitle(tab.relativePath),
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
                            },
                        },
                    }));
                } catch {
                    return;
                }

                return;
            }

            if (tab.kind === "terminal") {
                await bootTerminalSession(get, set, tab.id);
                return;
            }

            await reloadFileTab(get, set, tab.id);
        }),
    );
}

async function persistWorkspaceState(get: GetWorkspaceState): Promise<void> {
    try {
        const state = get();
        await getComandoApi().saveWorkspaceSnapshot(
            workspaceStateToSnapshot(state),
        );
    } catch (error) {
        console.error(error);
    }
}

async function reloadFileTab(
    get: GetWorkspaceState,
    set: WorkspaceSetState,
    tabId: string,
): Promise<void> {
    const tab = get().tabsById[tabId];
    if (!tab || tab.kind !== "file") {
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
    } catch (error) {
        console.error(error);
    }
}

function countTabs(
    get: GetWorkspaceState,
    kind: RuntimeWorkspaceTab["kind"],
): number {
    return Object.values(get().tabsById).filter((tab) => tab.kind === kind)
        .length;
}

function getFileTitle(relativePath: string): string {
    return relativePath.split("/").at(-1) ?? relativePath;
}

function findExistingFileTab(
    state: WorkspaceTreeState,
    projectId: string,
    relativePath: string,
): RuntimeWorkspaceFileTab | null {
    return (
        Object.values(state.tabsById).find(
            (tab): tab is RuntimeWorkspaceFileTab =>
                tab.kind === "file" &&
                tab.projectId === projectId &&
                tab.relativePath === relativePath,
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
