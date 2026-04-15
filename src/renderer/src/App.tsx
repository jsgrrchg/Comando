import {
    useCallback,
    useEffect,
    useEffectEvent,
    useMemo,
    useRef,
    useState,
    type PointerEvent as ReactPointerEvent,
} from "react";

import type {
    ComandoApi,
    PersistenceSnapshot,
    ProjectSummary,
    SettingsSnapshot,
} from "@shared/ipc";
import { resolveEditorLanguage } from "@shared/editor-language";

import { useSystemTheme } from "./app/hooks/use-system-theme";
import {
    buildGitTreeNodesFromProjectTree,
    findProjectTreeNodeByPath,
} from "./app/projects/git-tree";
import { shellLayoutConstraints } from "./app/layout/shell-layout";
import { buildFilteredProjectTree } from "./app/projects/tree-filter";
import {
    COMPOSER_PROJECT_ENTRY_MIME,
    serializeComposerProjectEntryDragData,
} from "./app/drag-and-drop";
import { useAppStore } from "./app/store/app-store";
import { useAiStore } from "./app/store/ai-store";
import { useGitStore } from "./app/store/git-store";
import { useProjectsStore } from "./app/store/projects-store";
import { useShellStore } from "./app/store/shell-store";
import { useWorkspaceStore } from "./app/store/workspace-store";
import { findPaneById } from "./app/workspace/tree";
import { GitTreeView, type GitTreeNode } from "./components/git";
import {
    ContextMenu,
    type ContextMenuEntry,
    type ContextMenuState,
} from "./components/context-menu/ContextMenu";
import { SidebarGitPanel } from "./components/sidebar";
import { SplitHandle } from "./components/SplitHandle";
import { WorkspaceView } from "./components/workspace/WorkspaceView";

type DragState = {
    readonly side: "left";
    readonly startWidth: number;
    readonly startX: number;
} | null;

const ROOT_NODE_KEY = "__root__";

type FileTreeContextMenuPayload =
    | {
          readonly kind: "background";
      }
    | {
          readonly kind: "node";
          readonly node: GitTreeNode;
      };

export function App() {
    useSystemTheme();

    const bootstrap = useAppStore((state) => state.bootstrap);
    const bootstrapError = useAppStore((state) => state.error);
    const hydrateBootstrap = useAppStore((state) => state.hydrate);

    const activeProjectId = useProjectsStore((state) => state.activeProjectId);
    const addProjects = useProjectsStore((state) => state.addProjects);
    const hydrateProjects = useProjectsStore((state) => state.hydrate);
    const fullyLoadedTreeProjects = useProjectsStore(
        (state) => state.fullyLoadedTreeProjects,
    );
    const loadEntireProjectTree = useProjectsStore(
        (state) => state.loadEntireProjectTree,
    );
    const loadingNodeKeys = useProjectsStore((state) => state.loadingNodeKeys);
    const projects = useProjectsStore((state) => state.projects);
    const projectsError = useProjectsStore((state) => state.error);
    const refreshProjectTree = useProjectsStore(
        (state) => state.refreshProjectTree,
    );
    const removeProject = useProjectsStore((state) => state.removeProject);
    const createEntry = useProjectsStore((state) => state.createEntry);
    const deleteEntry = useProjectsStore((state) => state.deleteEntry);
    const renameEntry = useProjectsStore((state) => state.renameEntry);
    const revealEntry = useProjectsStore((state) => state.revealEntry);
    const setActiveProject = useProjectsStore(
        (state) => state.setActiveProject,
    );
    const toggleDirectory = useProjectsStore((state) => state.toggleDirectory);
    const treeNodes = useProjectsStore((state) => state.treeNodes);
    const expandedDirectories = useProjectsStore(
        (state) => state.expandedDirectories,
    );
    const gitHydrate = useGitStore((state) => state.hydrate);
    const gitErrors = useGitStore((state) => state.errors);
    const refreshGitHistory = useGitStore((state) => state.refreshHistory);
    const refreshGitProject = useGitStore((state) => state.refreshProject);
    const ingestGitSnapshot = useGitStore((state) => state.ingestSnapshot);
    const setActiveWorktree = useGitStore((state) => state.setActiveWorktree);
    const selectGitBranch = useGitStore((state) => state.selectBranch);

    void loadingNodeKeys;
    void removeProject;
    void createEntry;
    void deleteEntry;
    void renameEntry;
    void revealEntry;

    const workspaceHydrate = useWorkspaceStore((state) => state.hydrate);
    const appendTerminalOutput = useWorkspaceStore(
        (state) => state.appendTerminalOutput,
    );
    const handleTerminalExit = useWorkspaceStore(
        (state) => state.handleTerminalExit,
    );
    const createChatTab = useWorkspaceStore((state) => state.createChatTab);
    const openFileTab = useWorkspaceStore((state) => state.openFileTab);
    const closeTabsForProjectPath = useWorkspaceStore(
        (state) => state.closeTabsForProjectPath,
    );
    const closeWorkspaceTab = useWorkspaceStore((state) => state.closeTab);
    const lastFocusedRuntimeId = useWorkspaceStore(
        (state) => state.lastFocusedRuntimeId,
    );
    const refreshProjectTabs = useWorkspaceStore(
        (state) => state.refreshProjectTabs,
    );
    const renameTabsForProjectPath = useWorkspaceStore(
        (state) => state.renameTabsForProjectPath,
    );
    const workspaceActivePaneId = useWorkspaceStore(
        (state) => state.activePaneId,
    );
    const workspaceError = useWorkspaceStore((state) => state.error);
    const workspaceRootNode = useWorkspaceStore((state) => state.rootNode);
    const workspaceTabsById = useWorkspaceStore((state) => state.tabsById);

    const activeSurface = useShellStore((state) => state.activeSurface);
    const focusSurface = useShellStore((state) => state.focusSurface);
    const hydrateShell = useShellStore((state) => state.hydrate);
    const leftCollapsed = useShellStore((state) => state.leftCollapsed);
    const leftWidth = useShellStore((state) => state.leftWidth);
    const nudgePanel = useShellStore((state) => state.nudgePanel);
    const resizePanel = useShellStore((state) => state.resizePanel);
    const rightCollapsed = useShellStore((state) => state.rightCollapsed);
    const rightWidth = useShellStore((state) => state.rightWidth);
    const sidebarView = useShellStore((state) => state.sidebarView);
    const syncViewport = useShellStore((state) => state.syncViewport);
    const toggleLeftCollapsed = useShellStore(
        (state) => state.toggleLeftCollapsed,
    );
    const toggleSidebarView = useShellStore((state) => state.toggleSidebarView);
    const applyAiRuntimeStatus = useAiStore(
        (state) => state.applyRuntimeStatus,
    );
    const applyAiSessionSnapshot = useAiStore(
        (state) => state.applySessionSnapshot,
    );
    const addDraftFileContext = useAiStore(
        (state) => state.addDraftFileContext,
    );
    const hydrateAiSettings = useAiStore((state) => state.hydrateSettings);

    const [dragState, setDragState] = useState<DragState>(null);
    const [fileTreeContextMenu, setFileTreeContextMenu] =
        useState<ContextMenuState<FileTreeContextMenuPayload> | null>(null);
    const [isFileTreeSearchOpen, setIsFileTreeSearchOpen] = useState(false);
    const [isFileTreeSearchLoading, setIsFileTreeSearchLoading] =
        useState(false);
    const [projectRootExpandedByContext, setProjectRootExpandedByContext] =
        useState<Record<string, boolean>>({});
    const [fileTreeFilter, setFileTreeFilter] = useState("");
    void isFileTreeSearchLoading;
    const [persistenceReady, setPersistenceReady] = useState(false);
    const [sidebarOverlayVisible, setSidebarOverlayVisible] = useState(false);
    const [sidebarSearchVisible, setSidebarSearchVisible] = useState(false);
    const fileTreeSearchInputRef = useRef<HTMLInputElement | null>(null);
    const overlayDismissRef = useRef<number | null>(null);

    useEffect(() => {
        let isDisposed = false;

        const hydrateApp = async () => {
            void hydrateBootstrap();

            try {
                const comandoApi = getComandoApi();
                let persistenceSnapshot: PersistenceSnapshot | null = null;
                let settingsSnapshot: SettingsSnapshot | null = null;

                if (comandoApi) {
                    [persistenceSnapshot, settingsSnapshot] = await Promise.all(
                        [
                            comandoApi.getPersistenceSnapshot(),
                            comandoApi.getSettingsSnapshot(),
                        ],
                    );
                }

                if (isDisposed) {
                    return;
                }

                hydrateAiSettings(settingsSnapshot?.ai ?? null);
                hydrateShell(persistenceSnapshot?.shellState ?? null);
                const persistedProjectId =
                    persistenceSnapshot?.activeProjectId ?? null;
                const persistedWorktreeId =
                    persistenceSnapshot?.activeWorktreeId ?? null;

                await hydrateProjects(persistedProjectId);
                await gitHydrate({
                    activeProjectId: persistedProjectId,
                    activeWorktreeId: persistedWorktreeId,
                    projects: useProjectsStore.getState().projects,
                });
                if (persistedProjectId) {
                    const resolvedWorktreeId =
                        useGitStore.getState().activeWorktreeIds[
                            persistedProjectId
                        ] ?? persistedWorktreeId;
                    await refreshProjectTree(
                        persistedProjectId,
                        resolvedWorktreeId,
                    );
                }
                await workspaceHydrate();
            } finally {
                if (!isDisposed) {
                    setPersistenceReady(true);
                }
            }
        };

        void hydrateApp();

        return () => {
            isDisposed = true;
        };
    }, [
        hydrateAiSettings,
        hydrateBootstrap,
        gitHydrate,
        hydrateProjects,
        hydrateShell,
        refreshProjectTree,
        workspaceHydrate,
    ]);

    useEffect(() => {
        const comandoApi = getComandoApi();
        if (!comandoApi) {
            return;
        }

        const unsubscribe = comandoApi.onProjectTreeInvalidated((payload) => {
            const preferredWorktreeId =
                payload.worktreeId ??
                useGitStore.getState().activeWorktreeIds[payload.projectId] ??
                null;

            void refreshProjectTree(payload.projectId, preferredWorktreeId);
            void refreshProjectTabs(payload.projectId, preferredWorktreeId);
        });

        return unsubscribe;
    }, [refreshProjectTabs, refreshProjectTree]);

    useEffect(() => {
        const comandoApi = getComandoApi();
        if (!comandoApi) {
            return;
        }

        const unsubscribe = comandoApi.onProjectWindowRequested((payload) => {
            void (async () => {
                if (activeProjectId !== payload.projectId) {
                    await setActiveProject(payload.projectId);
                }

                const requestedWorktreeId =
                    payload.worktreeId !== undefined
                        ? (payload.worktreeId ?? null)
                        : (useGitStore.getState().activeWorktreeIds[
                              payload.projectId
                          ] ?? null);

                if (payload.worktreeId !== undefined) {
                    await setActiveWorktree(
                        payload.projectId,
                        requestedWorktreeId,
                    );
                }

                if (payload.branchName !== undefined) {
                    selectGitBranch(
                        payload.projectId,
                        payload.branchName,
                        requestedWorktreeId,
                    );
                }

                await refreshGitProject(payload.projectId, requestedWorktreeId);
                await refreshProjectTree(
                    payload.projectId,
                    requestedWorktreeId,
                );
            })();
        });

        return unsubscribe;
    }, [
        activeProjectId,
        refreshGitProject,
        refreshProjectTree,
        selectGitBranch,
        setActiveProject,
        setActiveWorktree,
    ]);

    useEffect(() => {
        const comandoApi = getComandoApi();
        if (!comandoApi) {
            return;
        }

        const unsubscribeInvalidation = comandoApi.onGitRepositoryInvalidated(
            (payload) => {
                const preferredWorktreeId =
                    payload.worktreeId ??
                    useGitStore.getState().activeWorktreeIds[
                        payload.projectId
                    ] ??
                    null;
                void refreshGitProject(payload.projectId, preferredWorktreeId);
                void refreshGitHistory(payload.projectId, preferredWorktreeId);
            },
        );
        const unsubscribeSnapshot = comandoApi.onGitRepositorySnapshotUpdated(
            (snapshot) => {
                ingestGitSnapshot(snapshot);
            },
        );
        const unsubscribeWorktrees = comandoApi.onGitWorktreesUpdated(
            (payload) => {
                const preferredWorktreeId =
                    payload.worktreeId ??
                    useGitStore.getState().activeWorktreeIds[
                        payload.projectId
                    ] ??
                    null;
                void refreshGitProject(payload.projectId, preferredWorktreeId);
                void refreshGitHistory(payload.projectId, preferredWorktreeId);
            },
        );

        return () => {
            unsubscribeInvalidation();
            unsubscribeSnapshot();
            unsubscribeWorktrees();
        };
    }, [ingestGitSnapshot, refreshGitHistory, refreshGitProject]);

    useEffect(() => {
        const comandoApi = getComandoApi();
        if (!comandoApi) {
            return;
        }

        const unsubscribeRuntime = comandoApi.onAiRuntimeStatus((status) => {
            applyAiRuntimeStatus(status);
        });
        const unsubscribeSession = comandoApi.onAiSessionSnapshot(
            (snapshot) => {
                applyAiSessionSnapshot(snapshot);
            },
        );

        return () => {
            unsubscribeRuntime();
            unsubscribeSession();
        };
    }, [applyAiRuntimeStatus, applyAiSessionSnapshot]);

    useEffect(() => {
        const comandoApi = getComandoApi();
        if (!comandoApi) {
            return;
        }

        const unsubscribeData = comandoApi.onTerminalData((event) => {
            appendTerminalOutput(event);
        });
        const unsubscribeExit = comandoApi.onTerminalExit((event) => {
            handleTerminalExit(event);
        });

        return () => {
            unsubscribeData();
            unsubscribeExit();
        };
    }, [appendTerminalOutput, handleTerminalExit]);

    useEffect(() => {
        const comandoApi = getComandoApi();
        if (!comandoApi) {
            return;
        }

        const unsubscribe = comandoApi.onWorkspaceCloseActiveTab(() => {
            const activePane = findPaneById(
                useWorkspaceStore.getState().rootNode,
                useWorkspaceStore.getState().activePaneId,
            );
            const activeTabId = activePane?.activeTabId ?? null;
            if (!activeTabId) {
                return;
            }

            void closeWorkspaceTab(activeTabId);
        });

        return () => {
            unsubscribe();
        };
    }, [closeWorkspaceTab]);

    useEffect(() => {
        syncViewport(window.innerWidth);

        const handleResize = () => {
            syncViewport(window.innerWidth);
        };

        window.addEventListener("resize", handleResize);
        return () => {
            window.removeEventListener("resize", handleResize);
        };
    }, [syncViewport]);

    useEffect(() => {
        const comandoApi = getComandoApi();
        if (!persistenceReady || !comandoApi) {
            return;
        }

        const timeout = window.setTimeout(() => {
            void comandoApi.saveShellState({
                activeSurface,
                leftCollapsed,
                leftWidth,
                rightCollapsed,
                rightWidth,
                sidebarView,
            });
        }, 120);

        return () => {
            window.clearTimeout(timeout);
        };
    }, [
        activeSurface,
        leftCollapsed,
        leftWidth,
        persistenceReady,
        rightCollapsed,
        rightWidth,
        sidebarView,
    ]);

    useEffect(() => {
        if (!persistenceReady || !window.comando) {
            return;
        }

        void window.comando.saveActiveProjectId(activeProjectId);
    }, [activeProjectId, persistenceReady]);

    const activeWorktreeId = useGitStore((state) =>
        activeProjectId
            ? (state.activeWorktreeIds[activeProjectId] ?? null)
            : null,
    );
    const activeProjectContextKey = getProjectContextKey(
        activeProjectId,
        activeWorktreeId,
    );
    const activeGitContextKey = getGitContextKey(
        activeProjectId,
        activeWorktreeId,
    );
    const isActiveProjectTreeFullyLoaded = activeProjectId
        ? Boolean(fullyLoadedTreeProjects[activeProjectContextKey])
        : false;

    useEffect(() => {
        setFileTreeFilter("");
        setFileTreeContextMenu(null);
        setIsFileTreeSearchLoading(false);
        setIsFileTreeSearchOpen(false);
    }, [activeProjectId, activeWorktreeId]);

    useEffect(() => {
        if (!persistenceReady || !window.comando) {
            return;
        }

        void window.comando.saveActiveWorktreeId(activeWorktreeId);
    }, [activeWorktreeId, persistenceReady]);

    useEffect(() => {
        if (!isFileTreeSearchOpen) {
            return;
        }

        fileTreeSearchInputRef.current?.focus();
    }, [isFileTreeSearchOpen]);

    useEffect(() => {
        const normalizedFilter = fileTreeFilter.trim();

        if (
            !activeProjectId ||
            !normalizedFilter ||
            isActiveProjectTreeFullyLoaded
        ) {
            setIsFileTreeSearchLoading(false);
            return;
        }

        let isCancelled = false;
        setIsFileTreeSearchLoading(true);

        void loadEntireProjectTree(activeProjectId, activeWorktreeId).finally(
            () => {
                if (!isCancelled) {
                    setIsFileTreeSearchLoading(false);
                }
            },
        );

        return () => {
            isCancelled = true;
        };
    }, [
        activeProjectId,
        activeWorktreeId,
        fileTreeFilter,
        isActiveProjectTreeFullyLoaded,
        loadEntireProjectTree,
    ]);

    const handlePointerMove = useEffectEvent((event: PointerEvent) => {
        if (!dragState) {
            return;
        }

        const delta = event.clientX - dragState.startX;
        const nextWidth =
            dragState.side === "left"
                ? dragState.startWidth + delta
                : dragState.startWidth - delta;

        resizePanel(dragState.side, nextWidth);
    });

    const stopDragging = useEffectEvent(() => {
        setDragState(null);
    });

    useEffect(() => {
        if (!dragState) {
            return;
        }

        const previousCursor = document.body.style.cursor;
        const previousUserSelect = document.body.style.userSelect;

        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";

        window.addEventListener("pointermove", handlePointerMove);
        window.addEventListener("pointerup", stopDragging);

        return () => {
            document.body.style.cursor = previousCursor;
            document.body.style.userSelect = previousUserSelect;
            window.removeEventListener("pointermove", handlePointerMove);
            window.removeEventListener("pointerup", stopDragging);
        };
    }, [dragState]);

    const gridTemplateColumns = useMemo(() => {
        const leftCol = leftCollapsed ? 0 : leftWidth;
        const leftHandle = leftCollapsed
            ? 0
            : shellLayoutConstraints.handleWidth;
        return `${leftCol}px ${leftHandle}px minmax(0, 1fr)`;
    }, [leftCollapsed, leftWidth]);

    const activeProject =
        projects.find((project) => project.id === activeProjectId) ?? null;
    const activeTreeNodesByParent = useMemo(
        () => treeNodes[activeProjectContextKey] ?? {},
        [activeProjectContextKey, treeNodes],
    );
    const activeProjectTree = activeTreeNodesByParent[ROOT_NODE_KEY] ?? [];
    const activeExpandedDirectories =
        expandedDirectories[activeProjectContextKey] ?? [];
    const normalizedFileTreeFilter = fileTreeFilter.trim();
    const filteredFileTree = useMemo(
        () =>
            buildFilteredProjectTree(
                activeTreeNodesByParent,
                normalizedFileTreeFilter,
            ),
        [activeTreeNodesByParent, normalizedFileTreeFilter],
    );
    const isFilteringFileTree = normalizedFileTreeFilter.length > 0;
    const visibleFileTreeRoots = isFilteringFileTree
        ? filteredFileTree.rootNodes
        : activeProjectTree;
    const visibleFileTreeNodesByParent = isFilteringFileTree
        ? filteredFileTree.nodesByParent
        : activeTreeNodesByParent;
    const visibleExpandedDirectories = isFilteringFileTree
        ? filteredFileTree.expandedDirectories
        : activeExpandedDirectories;
    const isProjectRootExpanded =
        projectRootExpandedByContext[activeProjectContextKey] ?? true;
    const activeWorkspacePane = findPaneById(
        workspaceRootNode,
        workspaceActivePaneId,
    );
    const activeWorkspaceTab = activeWorkspacePane?.activeTabId
        ? (workspaceTabsById[activeWorkspacePane.activeTabId] ?? null)
        : null;
    void closeTabsForProjectPath;
    void renameTabsForProjectPath;
    const activeFilePath =
        activeWorkspaceTab?.kind === "file"
            ? activeWorkspaceTab.relativePath
            : null;
    const activeGitError = gitErrors[activeGitContextKey] ?? null;
    const isMac = bootstrap?.platform === "darwin";
    const topStatus = [
        bootstrapError,
        projectsError,
        workspaceError,
        activeGitError,
    ]
        .filter(Boolean)
        .join(" ");

    const handleCreateTreeEntry = useCallback(
        async (
            kind: "directory" | "file",
            parentRelativePath: string | null,
        ) => {
            if (!activeProjectId) {
                return;
            }

            const defaultName = kind === "file" ? "untitled.txt" : "new-folder";
            const requestedName = window.prompt(
                kind === "file" ? "New file name" : "New folder name",
                defaultName,
            );

            if (requestedName === null) {
                return;
            }

            const nextName = requestedName.trim();
            if (!nextName) {
                return;
            }

            try {
                const entry = await createEntry(
                    activeProjectId,
                    parentRelativePath,
                    nextName,
                    kind,
                    activeWorktreeId,
                );

                if (kind === "file") {
                    await openFileTab(
                        activeProjectId,
                        entry.relativePath,
                        activeWorktreeId,
                    );
                }
            } catch (error) {
                window.alert(
                    error instanceof Error
                        ? error.message
                        : `Could not create the ${kind}.`,
                );
            }
        },
        [activeProjectId, activeWorktreeId, createEntry, openFileTab],
    );

    const handleRenameTreeNode = useCallback(
        async (node: GitTreeNode) => {
            if (!activeProjectId) {
                return;
            }

            const requestedName = window.prompt(
                node.kind === "file" ? "Rename file" : "Rename folder",
                node.name,
            );

            if (requestedName === null) {
                return;
            }

            const nextName = requestedName.trim();
            if (!nextName || nextName === node.name) {
                return;
            }

            try {
                const renamedEntry = await renameEntry(
                    activeProjectId,
                    node.path,
                    nextName,
                    activeWorktreeId,
                );
                await renameTabsForProjectPath(
                    activeProjectId,
                    activeWorktreeId,
                    node.path,
                    renamedEntry.relativePath,
                    node.kind,
                );
            } catch (error) {
                window.alert(
                    error instanceof Error
                        ? error.message
                        : "Could not rename the selected entry.",
                );
            }
        },
        [
            activeProjectId,
            activeWorktreeId,
            renameEntry,
            renameTabsForProjectPath,
        ],
    );

    const handleDeleteTreeNode = useCallback(
        async (node: GitTreeNode) => {
            if (!activeProjectId) {
                return;
            }

            const confirmed = window.confirm(
                node.kind === "directory"
                    ? `Delete folder "${node.name}" and all its contents?`
                    : `Delete file "${node.name}"?`,
            );
            if (!confirmed) {
                return;
            }

            try {
                await deleteEntry(activeProjectId, node.path, activeWorktreeId);
                await closeTabsForProjectPath(
                    activeProjectId,
                    activeWorktreeId,
                    node.path,
                    node.kind,
                );
            } catch (error) {
                window.alert(
                    error instanceof Error
                        ? error.message
                        : "Could not delete the selected entry.",
                );
            }
        },
        [
            activeProjectId,
            activeWorktreeId,
            closeTabsForProjectPath,
            deleteEntry,
        ],
    );

    const handleRevealTreeEntry = useCallback(
        async (relativePath: string | null) => {
            if (!activeProjectId) {
                return;
            }

            try {
                await revealEntry(
                    activeProjectId,
                    relativePath,
                    activeWorktreeId,
                );
            } catch (error) {
                window.alert(
                    error instanceof Error
                        ? error.message
                        : "Could not reveal the selected entry.",
                );
            }
        },
        [activeProjectId, activeWorktreeId, revealEntry],
    );

    const handleCopyTreePath = useCallback(
        async (relativePath: string, mode: "absolute" | "relative") => {
            const text =
                mode === "absolute"
                    ? activeProject
                        ? joinProjectPath(activeProject.rootPath, relativePath)
                        : null
                    : relativePath;

            if (!text) {
                return;
            }

            try {
                await navigator.clipboard.writeText(text);
            } catch {
                window.alert("Could not copy the requested path.");
            }
        },
        [activeProject],
    );

    const handleAddFileToChat = useCallback(
        async (node: GitTreeNode) => {
            if (!activeProjectId || node.kind !== "file") {
                return;
            }

            const currentTabsById = useWorkspaceStore.getState().tabsById;
            const worktreeId = activeWorktreeId ?? null;
            const existingChatTab = Object.values(currentTabsById).find(
                (tab) =>
                    tab.kind === "chat" &&
                    tab.projectId === activeProjectId &&
                    (tab.worktreeId ?? null) === worktreeId,
            );

            const attachContext = (sessionId: string) => {
                addDraftFileContext(sessionId, {
                    extension: node.path.split(".").pop() ?? null,
                    id: `file-ctx:${crypto.randomUUID()}`,
                    languageId: resolveEditorLanguage({
                        filePath: node.path,
                    }).id,
                    name: node.name,
                    projectId: activeProjectId,
                    relativePath: node.path,
                });
            };

            if (existingChatTab?.kind === "chat") {
                attachContext(existingChatTab.sessionId);
                return;
            }

            const existingTabIds = new Set(Object.keys(currentTabsById));

            try {
                await createChatTab(
                    activeProjectId,
                    worktreeId,
                    lastFocusedRuntimeId,
                );
            } catch (error) {
                window.alert(
                    error instanceof Error
                        ? error.message
                        : "Could not create a chat tab for this file.",
                );
                return;
            }

            const createdChatTab = Object.values(
                useWorkspaceStore.getState().tabsById,
            ).find(
                (tab) =>
                    tab.kind === "chat" &&
                    tab.projectId === activeProjectId &&
                    (tab.worktreeId ?? null) === worktreeId &&
                    !existingTabIds.has(tab.id),
            );

            if (createdChatTab?.kind === "chat") {
                attachContext(createdChatTab.sessionId);
            }
        },
        [
            activeProjectId,
            activeWorktreeId,
            addDraftFileContext,
            createChatTab,
            lastFocusedRuntimeId,
        ],
    );

    const fileTreeContextMenuEntries = useMemo(() => {
        if (!fileTreeContextMenu) {
            return [] satisfies ContextMenuEntry[];
        }

        if (fileTreeContextMenu.payload.kind === "background") {
            return [
                {
                    label: "New File",
                    action: () => void handleCreateTreeEntry("file", null),
                    disabled: !activeProjectId,
                },
                {
                    label: "New Folder",
                    action: () => void handleCreateTreeEntry("directory", null),
                    disabled: !activeProjectId,
                },
                { type: "separator" },
                {
                    label: "Reveal Project Root",
                    action: () => void handleRevealTreeEntry(null),
                    disabled: !activeProjectId,
                },
                {
                    label: "Refresh",
                    action: () =>
                        activeProjectId
                            ? void refreshProjectTree(
                                  activeProjectId,
                                  activeWorktreeId,
                              )
                            : undefined,
                    disabled: !activeProjectId,
                },
            ] satisfies ContextMenuEntry[];
        }

        const node = fileTreeContextMenu.payload.node;
        if (node.isProjectRoot) {
            return [
                {
                    label: "New File",
                    action: () => void handleCreateTreeEntry("file", null),
                    disabled: !activeProjectId,
                },
                {
                    label: "New Folder",
                    action: () => void handleCreateTreeEntry("directory", null),
                    disabled: !activeProjectId,
                },
                { type: "separator" },
                {
                    label: "Reveal in Finder",
                    action: () => void handleRevealTreeEntry(null),
                    disabled: !activeProjectId,
                },
                {
                    label: "Copy Absolute Path",
                    action: () => void handleCopyTreePath("", "absolute"),
                    disabled: !activeProject,
                },
                {
                    label: "Refresh",
                    action: () =>
                        activeProjectId
                            ? void refreshProjectTree(
                                  activeProjectId,
                                  activeWorktreeId,
                              )
                            : undefined,
                    disabled: !activeProjectId,
                },
            ] satisfies ContextMenuEntry[];
        }

        if (node.kind === "file") {
            return [
                {
                    label: "Open",
                    action: () =>
                        activeProjectId
                            ? void openFileTab(
                                  activeProjectId,
                                  node.path,
                                  activeWorktreeId,
                              )
                            : undefined,
                    disabled: !activeProjectId,
                },
                {
                    label: "Add to Chat",
                    action: () => void handleAddFileToChat(node),
                    disabled: !activeProjectId,
                },
                { type: "separator" },
                {
                    label: "Rename",
                    action: () => void handleRenameTreeNode(node),
                    disabled: !activeProjectId,
                },
                {
                    label: "Reveal in Finder",
                    action: () => void handleRevealTreeEntry(node.path),
                    disabled: !activeProjectId,
                },
                {
                    label: "Copy Relative Path",
                    action: () =>
                        void handleCopyTreePath(node.path, "relative"),
                },
                {
                    label: "Copy Absolute Path",
                    action: () =>
                        void handleCopyTreePath(node.path, "absolute"),
                    disabled: !activeProject,
                },
                { type: "separator" },
                {
                    label: "Delete",
                    action: () => void handleDeleteTreeNode(node),
                    danger: true,
                    disabled: !activeProjectId,
                },
            ] satisfies ContextMenuEntry[];
        }

        return [
            {
                label: "New File",
                action: () => void handleCreateTreeEntry("file", node.path),
                disabled: !activeProjectId,
            },
            {
                label: "New Folder",
                action: () =>
                    void handleCreateTreeEntry("directory", node.path),
                disabled: !activeProjectId,
            },
            { type: "separator" },
            {
                label: "Rename",
                action: () => void handleRenameTreeNode(node),
                disabled: !activeProjectId,
            },
            {
                label: "Reveal in Finder",
                action: () => void handleRevealTreeEntry(node.path),
                disabled: !activeProjectId,
            },
            {
                label: "Copy Relative Path",
                action: () => void handleCopyTreePath(node.path, "relative"),
            },
            {
                label: "Copy Absolute Path",
                action: () => void handleCopyTreePath(node.path, "absolute"),
                disabled: !activeProject,
            },
            { type: "separator" },
            {
                label: "Delete",
                action: () => void handleDeleteTreeNode(node),
                danger: true,
                disabled: !activeProjectId,
            },
        ] satisfies ContextMenuEntry[];
    }, [
        activeProject,
        activeProjectId,
        activeWorktreeId,
        fileTreeContextMenu,
        handleAddFileToChat,
        handleCopyTreePath,
        handleCreateTreeEntry,
        handleDeleteTreeNode,
        handleRenameTreeNode,
        handleRevealTreeEntry,
        openFileTab,
        refreshProjectTree,
    ]);

    const sidebarFileNodes = useMemo(
        () =>
            buildGitTreeNodesFromProjectTree(
                visibleFileTreeRoots,
                visibleFileTreeNodesByParent,
                visibleExpandedDirectories,
            ),
        [
            visibleExpandedDirectories,
            visibleFileTreeNodesByParent,
            visibleFileTreeRoots,
        ],
    );

    const sidebarTreeNodes = useMemo(() => {
        if (!activeProject) {
            return [];
        }

        return [
            {
                children: isProjectRootExpanded ? sidebarFileNodes : undefined,
                hasChildren: visibleFileTreeRoots.length > 0,
                id: `sidebar-root:${activeProjectContextKey}`,
                isProjectRoot: true,
                kind: "directory" as const,
                name: activeProject.name,
                path: "",
                status: null,
            },
        ] satisfies readonly GitTreeNode[];
    }, [
        activeProject,
        activeProjectContextKey,
        isProjectRootExpanded,
        sidebarFileNodes,
        visibleFileTreeRoots.length,
    ]);

    const openSettingsWindow = useCallback(() => {
        if (!window.comando) {
            return;
        }

        void window.comando.openSettingsWindow({
            projectId: activeProjectId,
        });
    }, [activeProjectId]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== ",") {
                return;
            }

            if (!event.metaKey && !event.ctrlKey) {
                return;
            }

            event.preventDefault();
            openSettingsWindow();
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => {
            window.removeEventListener("keydown", handleKeyDown);
        };
    }, [openSettingsWindow]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "b" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                toggleLeftCollapsed();
                setSidebarOverlayVisible(false);
            }
            if (event.key === "Escape") {
                if (sidebarOverlayVisible) setSidebarOverlayVisible(false);
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [sidebarOverlayVisible, toggleLeftCollapsed]);

    useEffect(() => {
        if (!isMac) return;
        const visible = !leftCollapsed || sidebarOverlayVisible;
        void window.comando?.setTrafficLightVisibility(visible);
    }, [isMac, leftCollapsed, sidebarOverlayVisible]);

    const sidebarContent = (
        <>
            <div
                className="app-drag relative px-2 pt-2"
                style={isMac ? { paddingTop: 42 } : undefined}
            >
                {isMac && (
                    <button
                        className="app-no-drag"
                        onClick={() => {
                            toggleLeftCollapsed();
                            setSidebarOverlayVisible(false);
                        }}
                        style={{
                            position: "absolute",
                            top: 14,
                            right: 8,
                            background: "none",
                            border: "none",
                            padding: 4,
                            cursor: "pointer",
                            color: "var(--color-text-secondary)",
                            borderRadius: 4,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            opacity: 0.6,
                            transition: "opacity 120ms ease",
                        }}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.opacity = "1";
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.opacity = "0.6";
                        }}
                        title={
                            leftCollapsed
                                ? "Expand sidebar"
                                : "Collapse sidebar"
                        }
                        type="button"
                    >
                        <svg
                            aria-hidden="true"
                            fill="none"
                            height="13"
                            viewBox="0 0 16 16"
                            width="13"
                        >
                            <rect
                                x="1.5"
                                y="2.5"
                                width="13"
                                height="11"
                                rx="1.5"
                                stroke="currentColor"
                                strokeWidth="1.2"
                            />
                            <line
                                x1="5.5"
                                y1="2.5"
                                x2="5.5"
                                y2="13.5"
                                stroke="currentColor"
                                strokeWidth="1.2"
                            />
                        </svg>
                    </button>
                )}
                <div className="mt-1 flex items-center gap-1">
                    <button
                        className={[
                            "sidebar-action-row app-no-drag min-w-0 flex-1",
                            sidebarView === "files"
                                ? "sidebar-action-row--active"
                                : "",
                        ]
                            .filter(Boolean)
                            .join(" ")}
                        onClick={() => {
                            if (sidebarView !== "files") {
                                toggleSidebarView();
                                setSidebarSearchVisible(false);
                                setFileTreeFilter("");
                            }
                        }}
                        type="button"
                    >
                        <svg
                            aria-hidden="true"
                            className="h-4 w-4 shrink-0"
                            fill="none"
                            viewBox="0 0 16 16"
                        >
                            <path
                                d="M2 3a1 1 0 0 1 1-1h3.5l1.5 1.5H13a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3Z"
                                fill="currentColor"
                                opacity="0.55"
                            />
                        </svg>
                        <span>Files</span>
                    </button>

                    <button
                        className={[
                            "sidebar-action-row app-no-drag min-w-0 flex-1",
                            sidebarView === "git"
                                ? "sidebar-action-row--active"
                                : "",
                        ]
                            .filter(Boolean)
                            .join(" ")}
                        disabled={!activeProjectId}
                        onClick={() => {
                            if (!activeProjectId) return;
                            if (sidebarView !== "git") {
                                toggleSidebarView();
                                setSidebarSearchVisible(false);
                                setFileTreeFilter("");
                            }
                        }}
                        type="button"
                    >
                        <svg
                            aria-hidden="true"
                            className="h-4 w-4 shrink-0"
                            fill="none"
                            viewBox="0 0 16 16"
                        >
                            <path
                                d="M5.1 2.9 2.9 5.1a1 1 0 0 0 0 1.4l5.6 5.6a1 1 0 0 0 1.4 0l2.2-2.2a1 1 0 0 0 0-1.4L6.5 2.9a1 1 0 0 0-1.4 0Z"
                                stroke="currentColor"
                                strokeWidth="1.15"
                            />
                            <circle
                                cx="5"
                                cy="5"
                                r="0.85"
                                fill="currentColor"
                                stroke="none"
                            />
                            <path
                                d="M7.2 7.2 10.6 10.6"
                                stroke="currentColor"
                                strokeWidth="1"
                            />
                            <path
                                d="M8.8 5.6 10.4 7.2"
                                stroke="currentColor"
                                strokeWidth="1"
                            />
                        </svg>
                        <span>Git</span>
                    </button>

                    {sidebarView === "files" && (
                        <button
                            className="sidebar-search-toggle app-no-drag"
                            onClick={() => {
                                setSidebarSearchVisible((v) => !v);
                                if (sidebarSearchVisible) setFileTreeFilter("");
                            }}
                            title="Filter files"
                            type="button"
                        >
                            <svg
                                aria-hidden="true"
                                fill="none"
                                height="13"
                                viewBox="0 0 16 16"
                                width="13"
                            >
                                <circle
                                    cx="7"
                                    cy="7"
                                    r="4.5"
                                    stroke="currentColor"
                                    strokeWidth="1.3"
                                />
                                <path
                                    d="M10.5 10.5L14 14"
                                    stroke="currentColor"
                                    strokeLinecap="round"
                                    strokeWidth="1.3"
                                />
                            </svg>
                        </button>
                    )}
                </div>

                {sidebarView === "files" && sidebarSearchVisible ? (
                    <div className="sidebar-search app-no-drag mt-1">
                        <input
                            autoCapitalize="off"
                            autoCorrect="off"
                            autoFocus
                            className="sidebar-search-input"
                            onChange={(event) =>
                                setFileTreeFilter(event.target.value)
                            }
                            placeholder="Filter files..."
                            spellCheck={false}
                            type="text"
                            value={fileTreeFilter}
                        />
                    </div>
                ) : null}

                {projectsError ? (
                    <div className="mt-2 rounded-md bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-600">
                        {projectsError}
                    </div>
                ) : null}
            </div>

            {sidebarView === "git" && activeProjectId ? (
                <SidebarGitPanel
                    projectId={activeProjectId}
                    worktreeId={activeWorktreeId}
                />
            ) : (
                <>
                    <div className="shell-scrollbar flex-1 overflow-y-auto px-2 py-2">
                        {activeProject ? (
                            <GitTreeView
                                activePath={activeFilePath}
                                enableNodeDrag
                                expandedPaths={visibleExpandedDirectories}
                                nodes={sidebarTreeNodes}
                                onNodeClick={(node) =>
                                    activeProjectId
                                        ? void openFileTab(
                                              activeProjectId,
                                              node.path,
                                              activeWorktreeId,
                                          )
                                        : undefined
                                }
                                onNodeContextMenu={(node, { x, y }) =>
                                    setFileTreeContextMenu({
                                        x,
                                        y,
                                        payload: {
                                            kind: "node",
                                            node,
                                        },
                                    })
                                }
                                onNodeDragStart={(node, dataTransfer) => {
                                    if (!dataTransfer) return;
                                    dataTransfer.effectAllowed = "copyMove";
                                    dataTransfer.setData(
                                        COMPOSER_PROJECT_ENTRY_MIME,
                                        serializeComposerProjectEntryDragData({
                                            kind: node.kind,
                                            name: node.name,
                                            relativePath: node.path,
                                        }),
                                    );
                                    dataTransfer.setData(
                                        "text/plain",
                                        node.path,
                                    );
                                }}
                                onToggleDirectory={(node) => {
                                    if (node.isProjectRoot) {
                                        setProjectRootExpandedByContext(
                                            (currentState) => ({
                                                ...currentState,
                                                [activeProjectContextKey]:
                                                    !isProjectRootExpanded,
                                            }),
                                        );
                                        return;
                                    }

                                    if (!activeProjectId) {
                                        return;
                                    }

                                    const treeNode = findProjectTreeNodeByPath(
                                        visibleFileTreeNodesByParent,
                                        node.path,
                                    );
                                    if (!treeNode) {
                                        return;
                                    }

                                    void toggleDirectory(
                                        activeProjectId,
                                        treeNode,
                                        activeWorktreeId,
                                    );
                                }}
                                showStatusIndicator={false}
                            />
                        ) : (
                            <div className="px-3 py-4 text-xs text-text-secondary">
                                Open a folder to get started.
                            </div>
                        )}
                    </div>

                    <div className="border-t border-border/50 px-2 py-2">
                        <ProjectSwitcher
                            activeProject={activeProject}
                            onOpenProjects={() => {
                                void addProjects();
                            }}
                            onOpenSettings={openSettingsWindow}
                            onSelectProject={(projectId) => {
                                if (projectId === activeProjectId) {
                                    return;
                                }

                                void getComandoApi()?.openProjectWindow({
                                    projectId,
                                });
                            }}
                            projects={projects}
                        />
                    </div>
                </>
            )}
        </>
    );

    return (
        <div className="min-h-screen text-text-primary">
            <div className="relative h-screen">
                <div className="flex h-full flex-col overflow-hidden">
                    <div
                        className="grid min-h-0 flex-1"
                        style={{
                            gridTemplateColumns,
                            transition: dragState
                                ? undefined
                                : "grid-template-columns 200ms ease",
                        }}
                    >
                        <aside
                            className="flex min-h-0 flex-col"
                            style={
                                leftCollapsed
                                    ? { overflow: "hidden" }
                                    : undefined
                            }
                            data-active={activeSurface === "projects"}
                            onClick={() => focusSurface("projects")}
                            onFocus={() => focusSurface("projects")}
                            tabIndex={0}
                        >
                            {!leftCollapsed && sidebarContent}
                        </aside>

                        <div
                            style={
                                leftCollapsed
                                    ? {
                                          overflow: "hidden",
                                          pointerEvents: "none",
                                      }
                                    : undefined
                            }
                        >
                            <SplitHandle
                                label="Resize project sidebar"
                                onPointerDown={(event) =>
                                    startDragging(
                                        "left",
                                        event,
                                        leftWidth,
                                        setDragState,
                                    )
                                }
                                onStepBackward={() =>
                                    nudgePanel(
                                        "left",
                                        -shellLayoutConstraints.keyboardStep,
                                    )
                                }
                                onStepForward={() =>
                                    nudgePanel(
                                        "left",
                                        shellLayoutConstraints.keyboardStep,
                                    )
                                }
                            />
                        </div>

                        <main
                            className="surface-focus min-h-0 bg-bg-primary"
                            data-active={
                                activeSurface === "workspace" ||
                                activeSurface === "utility"
                            }
                            onClick={() => focusSurface("workspace")}
                            onFocus={() => focusSurface("workspace")}
                            tabIndex={0}
                        >
                            <WorkspaceView
                                defaultProjectId={activeProjectId}
                                defaultWorktreeId={activeWorktreeId}
                            />
                        </main>
                    </div>
                </div>

                {leftCollapsed && (
                    <div
                        style={{
                            position: "absolute",
                            left: 0,
                            top: 0,
                            bottom: 0,
                            width: sidebarOverlayVisible ? 0 : 8,
                            zIndex: 10,
                        }}
                        onMouseEnter={() => setSidebarOverlayVisible(true)}
                    />
                )}

                {leftCollapsed && (
                    <div
                        className="flex min-h-0 flex-col bg-bg-panel"
                        style={{
                            position: "absolute",
                            left: 0,
                            top: 0,
                            bottom: 0,
                            width: leftWidth,
                            zIndex: 10,
                            boxShadow: sidebarOverlayVisible
                                ? "var(--shadow-soft)"
                                : "none",
                            borderRight: "1px solid var(--color-border)",
                            transition:
                                "opacity 200ms ease, transform 200ms ease",
                            opacity: sidebarOverlayVisible ? 1 : 0,
                            transform: sidebarOverlayVisible
                                ? "translateX(0)"
                                : "translateX(-8px)",
                            pointerEvents: sidebarOverlayVisible
                                ? "auto"
                                : "none",
                        }}
                        onMouseEnter={() => {
                            if (overlayDismissRef.current) {
                                clearTimeout(overlayDismissRef.current);
                                overlayDismissRef.current = null;
                            }
                        }}
                        onMouseLeave={() => {
                            overlayDismissRef.current = window.setTimeout(
                                () => {
                                    setSidebarOverlayVisible(false);
                                    overlayDismissRef.current = null;
                                },
                                200,
                            );
                        }}
                    >
                        {sidebarContent}
                    </div>
                )}
            </div>

            {topStatus ? (
                <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-md border border-border bg-bg-elevated px-3 py-2 text-[11px] text-text-secondary shadow-sm">
                    {topStatus}
                </div>
            ) : null}

            {fileTreeContextMenu && fileTreeContextMenuEntries.length > 0 ? (
                <ContextMenu
                    entries={fileTreeContextMenuEntries}
                    menu={fileTreeContextMenu}
                    onClose={() => setFileTreeContextMenu(null)}
                />
            ) : null}
        </div>
    );
}

function ProjectSwitcher({
    activeProject,
    onOpenProjects,
    onOpenSettings,
    onSelectProject,
    projects,
}: {
    readonly activeProject: ProjectSummary | null;
    readonly onOpenProjects: () => void;
    readonly onOpenSettings: () => void;
    readonly onSelectProject: (projectId: string) => void;
    readonly projects: readonly ProjectSummary[];
}) {
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState("");
    const ref = useRef<HTMLDivElement | null>(null);
    const searchRef = useRef<HTMLInputElement | null>(null);
    const normalizedSearch = search.trim().toLowerCase();
    const filteredProjects = projects.filter((project) => {
        if (!normalizedSearch) return true;
        return (
            project.name.toLowerCase().includes(normalizedSearch) ||
            project.rootPath.toLowerCase().includes(normalizedSearch)
        );
    });

    useEffect(() => {
        if (!open) return;
        searchRef.current?.focus();
        const handleDown = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                setOpen(false);
                setSearch("");
            }
        };
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                setOpen(false);
                setSearch("");
            }
        };
        document.addEventListener("mousedown", handleDown);
        document.addEventListener("keydown", handleKey);
        return () => {
            document.removeEventListener("mousedown", handleDown);
            document.removeEventListener("keydown", handleKey);
        };
    }, [open]);

    const handleAction = (action: () => void) => {
        setOpen(false);
        setSearch("");
        queueMicrotask(action);
    };

    const menuItem = (
        label: string,
        action: () => void,
        checked = false,
        muted = false,
    ) => (
        <button
            className="project-switcher-menu-item"
            key={label}
            onClick={() => handleAction(action)}
            type="button"
        >
            <span className="project-switcher-check">{checked ? "✓" : ""}</span>
            <span
                className="truncate"
                style={{
                    color: muted
                        ? "var(--color-text-secondary)"
                        : "var(--color-text-primary)",
                }}
            >
                {label}
            </span>
        </button>
    );

    return (
        <div ref={ref} style={{ position: "relative" }}>
            {open && (
                <div className="project-switcher-menu">
                    {projects.length > 0 && (
                        <div className="project-switcher-search">
                            <svg
                                fill="none"
                                height="12"
                                style={{ opacity: 0.4, flexShrink: 0 }}
                                viewBox="0 0 16 16"
                                width="12"
                            >
                                <circle
                                    cx="7"
                                    cy="7"
                                    r="5"
                                    stroke="currentColor"
                                    strokeWidth="1.5"
                                />
                                <path
                                    d="m13 13-2.5-2.5"
                                    stroke="currentColor"
                                    strokeLinecap="round"
                                    strokeWidth="1.5"
                                />
                            </svg>
                            <input
                                autoCapitalize="off"
                                autoCorrect="off"
                                className="project-switcher-search-input"
                                onChange={(e) => setSearch(e.target.value)}
                                onKeyDown={(e) => e.stopPropagation()}
                                placeholder="Search projects…"
                                ref={searchRef}
                                spellCheck={false}
                                value={search}
                            />
                            <span className="project-switcher-search-count">
                                {filteredProjects.length}/{projects.length}
                            </span>
                        </div>
                    )}
                    <div className="project-switcher-list">
                        {projects.length > 0 &&
                        filteredProjects.length === 0 ? (
                            <div className="project-switcher-empty">
                                No projects match your search.
                            </div>
                        ) : (
                            filteredProjects.map((project) =>
                                menuItem(
                                    project.name,
                                    () => onSelectProject(project.id),
                                    project.id === activeProject?.id,
                                ),
                            )
                        )}
                    </div>
                    {projects.length > 0 && (
                        <div className="project-switcher-sep" />
                    )}
                    {menuItem("Open folder…", onOpenProjects, false, true)}
                    {menuItem("Settings", onOpenSettings, false, true)}
                </div>
            )}

            <button
                className="sidebar-action-row app-no-drag w-full"
                onClick={() => setOpen((v) => !v)}
                type="button"
            >
                <svg
                    aria-hidden="true"
                    fill="none"
                    height="13"
                    style={{ flexShrink: 0 }}
                    viewBox="0 0 16 16"
                    width="13"
                >
                    <path
                        d="M6.73 1.2H9.27L9.58 2.77C10.01 2.9 10.42 3.07 10.8 3.3L12.18 2.49L13.97 4.28L13.16 5.66C13.39 6.04 13.56 6.45 13.69 6.88L15.26 7.19V9.73L13.69 10.04C13.56 10.47 13.39 10.88 13.16 11.26L13.97 12.64L12.18 14.43L10.8 13.62C10.42 13.85 10.01 14.02 9.58 14.15L9.27 15.72H6.73L6.42 14.15C5.99 14.02 5.58 13.85 5.2 13.62L3.82 14.43L2.03 12.64L2.84 11.26C2.61 10.88 2.44 10.47 2.31 10.04L0.74 9.73V7.19L2.31 6.88C2.44 6.45 2.61 6.04 2.84 5.66L2.03 4.28L3.82 2.49L5.2 3.3C5.58 3.07 5.99 2.9 6.42 2.77L6.73 1.2Z"
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="1"
                    />
                    <circle
                        cx="8"
                        cy="8"
                        r="2.1"
                        stroke="currentColor"
                        strokeWidth="1.4"
                    />
                </svg>
                <span
                    className="flex-1 truncate text-left"
                    style={{
                        color: "var(--color-text-primary)",
                        fontWeight: 500,
                    }}
                >
                    {activeProject?.name ?? "Open project"}
                </span>
                <svg
                    aria-hidden="true"
                    fill="none"
                    height="10"
                    style={{ flexShrink: 0 }}
                    viewBox="0 0 16 16"
                    width="10"
                >
                    <path
                        d="M5 6l3-3 3 3M5 10l3 3 3-3"
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="1.5"
                    />
                </svg>
            </button>
        </div>
    );
}

function getGitContextKey(
    projectId: string | null,
    worktreeId: string | null,
): string {
    return `${projectId ?? "__none__"}::${worktreeId ?? "__primary__"}`;
}

function joinProjectPath(rootPath: string, relativePath: string): string {
    if (!relativePath) {
        return rootPath;
    }

    const separator = rootPath.includes("\\") ? "\\" : "/";
    return `${rootPath.replace(/[\\/]+$/, "")}${separator}${relativePath
        .split("/")
        .join(separator)}`;
}

function getComandoApi(): ComandoApi | null {
    return "comando" in window ? window.comando : null;
}

function getProjectContextKey(
    projectId: string | null,
    worktreeId: string | null,
): string {
    return `${projectId ?? "__none__"}::${worktreeId ?? "__primary__"}`;
}

function startDragging(
    side: "left",
    event: ReactPointerEvent<HTMLDivElement>,
    startWidth: number,
    setDragState: (dragState: DragState) => void,
): void {
    event.preventDefault();
    setDragState({
        side,
        startWidth,
        startX: event.clientX,
    });
}
