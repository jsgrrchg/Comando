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
    GitBranchSummary,
    GitChangeEntry,
    GitFileDiff as SharedGitFileDiff,
    GitRepositorySnapshot,
    GitRepositoryState,
    GitWorktreeSummary,
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
import {
    GitPanel,
    type GitAction,
    type GitChangeGroup,
    type GitChangeGroupId,
    type GitDiffFile,
    type GitNodeStatus,
    type GitRepositorySummary,
    type GitTreeDragData,
    type GitTreeNode,
} from "./components/git";
import {
    ProjectGitSidebar,
    type ProjectGitSidebarProject,
    type ProjectGitSidebarWorktree,
} from "./components/projects";
import {
    ContextMenu,
    type ContextMenuEntry,
    type ContextMenuState,
} from "./components/context-menu/ContextMenu";
import { SplitHandle } from "./components/SplitHandle";
import { WorkspaceView } from "./components/workspace/WorkspaceView";

type DragState = {
    readonly side: "left" | "right";
    readonly startWidth: number;
    readonly startX: number;
} | null;

type MutableGitChangeTreeNode = {
    readonly kind: "directory" | "file";
    readonly name: string;
    readonly path: string;
    readonly children: Map<string, MutableGitChangeTreeNode>;
    change: GitChangeEntry | null;
};

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
    const refreshGitProject = useGitStore((state) => state.refreshProject);
    const ingestGitSnapshot = useGitStore((state) => state.ingestSnapshot);
    const gitSnapshots = useGitStore((state) => state.snapshots);
    const gitBranchesByProject = useGitStore(
        (state) => state.branchesByProject,
    );
    const gitPanelTabs = useGitStore((state) => state.panelTabs);
    const gitCommitMessages = useGitStore((state) => state.commitMessages);
    const gitExpandedGroups = useGitStore(
        (state) => state.expandedChangeGroups,
    );
    const gitExpandedPaths = useGitStore((state) => state.changeExpandedPaths);
    const gitSelectedDiffPaths = useGitStore(
        (state) => state.selectedDiffPaths,
    );
    const gitDiffsByContext = useGitStore((state) => state.diffsByContext);
    const gitLoadingContexts = useGitStore((state) => state.loadingContexts);
    const gitSelectedBranchNames = useGitStore(
        (state) => state.selectedBranchNames,
    );
    const gitSelectedBranchNamesByContext = useGitStore(
        (state) => state.selectedBranchNamesByContext,
    );
    const gitExpandedProjects = useGitStore((state) => state.expandedProjects);
    const gitExpandedBranches = useGitStore(
        (state) => state.expandedBranchSections,
    );
    const gitExpandedWorktrees = useGitStore(
        (state) => state.expandedWorktreeSections,
    );
    const setActiveWorktree = useGitStore((state) => state.setActiveWorktree);
    const selectGitBranch = useGitStore((state) => state.selectBranch);
    const checkoutGitBranch = useGitStore((state) => state.checkoutBranch);
    const createGitWorktree = useGitStore((state) => state.createWorktree);
    const removeGitWorktree = useGitStore((state) => state.removeWorktree);
    const selectGitDiffPath = useGitStore((state) => state.selectDiffPath);
    const stageGitPaths = useGitStore((state) => state.stagePaths);
    const unstageGitPaths = useGitStore((state) => state.unstagePaths);
    const discardGitPaths = useGitStore((state) => state.discardPaths);
    const commitGitChanges = useGitStore((state) => state.commitChanges);
    const fetchGitRepository = useGitStore((state) => state.fetchRepository);
    const pullGitRepository = useGitStore((state) => state.pullRepository);
    const pushGitRepository = useGitStore((state) => state.pushRepository);
    const setGitCommitMessage = useGitStore((state) => state.setCommitMessage);
    const setGitPanelTab = useGitStore((state) => state.setPanelTab);
    const toggleGitBranchesExpanded = useGitStore(
        (state) => state.toggleBranchesExpanded,
    );
    const toggleGitProjectExpanded = useGitStore(
        (state) => state.toggleProjectExpanded,
    );
    const toggleGitWorktreesExpanded = useGitStore(
        (state) => state.toggleWorktreesExpanded,
    );
    const toggleGitChangePath = useGitStore((state) => state.toggleChangePath);
    const toggleGitChangeGroup = useGitStore(
        (state) => state.toggleChangeGroup,
    );

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
    const rightWidth = useShellStore((state) => state.rightWidth);
    const syncViewport = useShellStore((state) => state.syncViewport);
    const toggleLeftCollapsed = useShellStore(
        (state) => state.toggleLeftCollapsed,
    );
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
    const [projectFilter, setProjectFilter] = useState("");
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
            void refreshGitProject(payload.projectId, preferredWorktreeId);
        });

        return unsubscribe;
    }, [refreshGitProject, refreshProjectTabs, refreshProjectTree]);

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
            },
        );

        return () => {
            unsubscribeInvalidation();
            unsubscribeSnapshot();
            unsubscribeWorktrees();
        };
    }, [ingestGitSnapshot, refreshGitProject]);

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
                rightWidth,
            });
        }, 120);

        return () => {
            window.clearTimeout(timeout);
        };
    }, [activeSurface, leftCollapsed, leftWidth, persistenceReady, rightWidth]);

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

    const filteredProjects = useMemo(() => {
        const normalizedFilter = projectFilter.trim().toLowerCase();

        if (!normalizedFilter) {
            return projects;
        }

        return projects.filter((project) =>
            `${project.name} ${project.rootPath}`
                .toLowerCase()
                .includes(normalizedFilter),
        );
    }, [projectFilter, projects]);

    const gridTemplateColumns = useMemo(() => {
        const leftCol = leftCollapsed ? 0 : leftWidth;
        const leftHandle = leftCollapsed
            ? 0
            : shellLayoutConstraints.handleWidth;
        return `${leftCol}px ${leftHandle}px minmax(0, 1fr) ${shellLayoutConstraints.handleWidth}px ${rightWidth}px`;
    }, [leftCollapsed, leftWidth, rightWidth]);

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
    const activeGitSnapshot = gitSnapshots[activeGitContextKey] ?? null;
    const activeGitBranches =
        (activeProjectId ? gitBranchesByProject[activeProjectId] : []) ?? [];
    void activeGitBranches;
    const activeGitPanelTab = gitPanelTabs[activeGitContextKey] ?? "changes";
    const activeGitCommitMessage = gitCommitMessages[activeGitContextKey] ?? "";
    const activeGitExpandedGroups = gitExpandedGroups[activeGitContextKey] ?? [
        "conflicts",
        "changes",
        "staged",
        "untracked",
    ];
    const activeGitExpandedPaths = gitExpandedPaths[activeGitContextKey] ?? [];
    const activeGitSelectedDiffPath =
        gitSelectedDiffPaths[activeGitContextKey] ?? null;
    const activeGitDiffCache = useMemo(
        () => gitDiffsByContext[activeGitContextKey] ?? {},
        [activeGitContextKey, gitDiffsByContext],
    );
    const activeGitError = gitErrors[activeGitContextKey] ?? null;
    const activeGitLoading = gitLoadingContexts[activeGitContextKey] ?? false;
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

    const handleMoveTreeEntry = useCallback(
        async (
            dragData: GitTreeDragData,
            nextParentRelativePath: string | null,
        ) => {
            if (!activeProjectId) {
                return;
            }

            const currentParentRelativePath = getParentRelativePath(
                dragData.relativePath,
            );
            if (currentParentRelativePath === nextParentRelativePath) {
                return;
            }

            try {
                const movedEntry = await renameEntry(
                    activeProjectId,
                    dragData.relativePath,
                    dragData.name,
                    nextParentRelativePath,
                    activeWorktreeId,
                );
                await renameTabsForProjectPath(
                    activeProjectId,
                    activeWorktreeId,
                    dragData.relativePath,
                    movedEntry.relativePath,
                    dragData.kind,
                );
            } catch (error) {
                window.alert(
                    error instanceof Error
                        ? error.message
                        : "Could not move the selected entry.",
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

    const handleSelectProject = useCallback(
        async (projectId: string) => {
            if (projectId === activeProjectId) {
                const preferredWorktreeId =
                    useGitStore.getState().activeWorktreeIds[projectId] ?? null;
                await refreshGitProject(projectId, preferredWorktreeId);
                await refreshProjectTree(projectId, preferredWorktreeId);
                return;
            }

            await getComandoApi()?.openProjectWindow({
                projectId,
            });
        },
        [activeProjectId, refreshGitProject, refreshProjectTree],
    );

    const handleSelectWorktree = useCallback(
        async (projectId: string, worktreeId: string) => {
            if (projectId !== activeProjectId) {
                await getComandoApi()?.openProjectWindow({
                    projectId,
                    worktreeId,
                });
                return;
            }

            await setActiveProject(projectId);
            await setActiveWorktree(projectId, worktreeId);
            await refreshGitProject(projectId, worktreeId);
            await refreshProjectTree(projectId, worktreeId);
        },
        [
            activeProjectId,
            refreshGitProject,
            refreshProjectTree,
            setActiveProject,
            setActiveWorktree,
        ],
    );

    const handleSelectBranch = useCallback(
        async (projectId: string, branchName: string) => {
            if (projectId !== activeProjectId) {
                await getComandoApi()?.openProjectWindow({
                    branchName,
                    projectId,
                    worktreeId:
                        useGitStore.getState().activeWorktreeIds[projectId] ??
                        null,
                });
                return;
            }

            selectGitBranch(
                projectId,
                branchName,
                useGitStore.getState().activeWorktreeIds[projectId] ?? null,
            );
            await setActiveProject(projectId);
            void refreshGitProject(
                projectId,
                useGitStore.getState().activeWorktreeIds[projectId] ?? null,
            );
        },
        [activeProjectId, refreshGitProject, selectGitBranch, setActiveProject],
    );

    const handleCheckoutBranch = useCallback(
        async (projectId: string, branchName: string) => {
            try {
                await checkoutGitBranch(
                    projectId,
                    branchName,
                    useGitStore.getState().activeWorktreeIds[projectId] ?? null,
                );
            } catch (error) {
                window.alert(
                    error instanceof Error
                        ? error.message
                        : "Could not checkout the selected branch.",
                );
            }
        },
        [checkoutGitBranch],
    );

    const handleCreateWorktreeFromBranch = useCallback(
        async (projectId: string, branchName: string) => {
            const project = projects.find((entry) => entry.id === projectId);
            if (!project) {
                return;
            }

            const suggestedPath = `${project.rootPath}-${sanitizeBranchName(branchName)}`;
            const nextPath = window.prompt(
                `Create a worktree for "${branchName}"`,
                suggestedPath,
            );

            if (!nextPath?.trim()) {
                return;
            }

            try {
                const worktree = await createGitWorktree({
                    branchName,
                    path: nextPath.trim(),
                    projectId,
                    worktreeId:
                        useGitStore.getState().activeWorktreeIds[projectId] ??
                        null,
                });
                await handleSelectWorktree(projectId, worktree.id);
            } catch (error) {
                window.alert(
                    error instanceof Error
                        ? error.message
                        : "Could not create the worktree.",
                );
            }
        },
        [createGitWorktree, handleSelectWorktree, projects],
    );

    const handleRemoveWorktree = useCallback(
        async (projectId: string, worktree: GitWorktreeSummary) => {
            if (worktree.isPrimary) {
                return;
            }

            const confirmed = window.confirm(
                `Remove worktree "${worktree.rootPath}"?`,
            );
            if (!confirmed) {
                return;
            }

            try {
                const snapshot = await removeGitWorktree(
                    projectId,
                    worktree.rootPath,
                    useGitStore.getState().activeWorktreeIds[projectId] ?? null,
                );
                const fallbackWorktreeId =
                    snapshot.currentWorktreeId ??
                    snapshot.worktrees.find((entry) => entry.isPrimary)?.id ??
                    null;
                await setActiveWorktree(projectId, fallbackWorktreeId);
                await refreshProjectTree(projectId, fallbackWorktreeId);
            } catch (error) {
                window.alert(
                    error instanceof Error
                        ? error.message
                        : "Could not remove the worktree.",
                );
            }
        },
        [refreshProjectTree, removeGitWorktree, setActiveWorktree],
    );

    const handleSelectGitDiffPath = useCallback(
        async (relativePath: string | null) => {
            if (!activeProjectId) {
                return;
            }

            await selectGitDiffPath(
                activeProjectId,
                relativePath,
                activeWorktreeId,
            );
        },
        [activeProjectId, activeWorktreeId, selectGitDiffPath],
    );

    const handleStageAllChanges = useCallback(() => {
        if (!activeProjectId || !activeGitSnapshot?.changedPaths.length) {
            return;
        }

        void stageGitPaths(
            activeProjectId,
            activeGitSnapshot.changedPaths,
            activeWorktreeId,
        );
    }, [activeGitSnapshot, activeProjectId, activeWorktreeId, stageGitPaths]);

    const handleUnstageAllChanges = useCallback(() => {
        if (!activeProjectId) {
            return;
        }

        const stagedPaths =
            activeGitSnapshot?.changes
                .filter((change) => change.scope === "staged")
                .map((change) => change.path) ?? [];
        if (stagedPaths.length === 0) {
            return;
        }

        void unstageGitPaths(activeProjectId, stagedPaths, activeWorktreeId);
    }, [activeGitSnapshot, activeProjectId, activeWorktreeId, unstageGitPaths]);

    const handleDiscardAllChanges = useCallback(() => {
        if (!activeProjectId || !activeGitSnapshot?.changedPaths.length) {
            return;
        }

        const confirmed = window.confirm(
            "Discard all current changes in the active worktree?",
        );
        if (!confirmed) {
            return;
        }

        void discardGitPaths(
            activeProjectId,
            activeGitSnapshot.changedPaths,
            activeWorktreeId,
        );
    }, [activeGitSnapshot, activeProjectId, activeWorktreeId, discardGitPaths]);

    const handleCommitChanges = useCallback(() => {
        if (!activeProjectId) {
            return;
        }

        const message = activeGitCommitMessage.trim();
        if (!message) {
            window.alert("Write a commit message first.");
            return;
        }

        void commitGitChanges({
            message,
            projectId: activeProjectId,
            worktreeId: activeWorktreeId,
        }).catch((error: unknown) => {
            window.alert(
                error instanceof Error
                    ? error.message
                    : "Could not create the commit.",
            );
        });
    }, [
        activeGitCommitMessage,
        activeProjectId,
        activeWorktreeId,
        commitGitChanges,
    ]);

    const sidebarProjects = useMemo(
        () =>
            buildSidebarProjects({
                activeProjectId,
                activeWorktreeIds: useGitStore.getState().activeWorktreeIds,
                branchesByProject: gitBranchesByProject,
                expandedBranches: gitExpandedBranches,
                expandedProjects: gitExpandedProjects,
                expandedWorktrees: gitExpandedWorktrees,
                projects: filteredProjects,
                selectedBranchNames: gitSelectedBranchNames,
                selectedBranchNamesByContext: gitSelectedBranchNamesByContext,
                snapshots: gitSnapshots,
                onRemoveWorktree: handleRemoveWorktree,
            }),
        [
            activeProjectId,
            filteredProjects,
            gitBranchesByProject,
            gitExpandedBranches,
            gitExpandedProjects,
            gitExpandedWorktrees,
            gitSelectedBranchNames,
            gitSelectedBranchNamesByContext,
            gitSnapshots,
            handleRemoveWorktree,
        ],
    );

    const gitFileNodes = useMemo(
        () =>
            activeGitPanelTab === "files"
                ? buildGitTreeNodesFromProjectTree(
                      visibleFileTreeRoots,
                      visibleFileTreeNodesByParent,
                      visibleExpandedDirectories,
                  )
                : [],
        [
            activeGitPanelTab,
            visibleExpandedDirectories,
            visibleFileTreeNodesByParent,
            visibleFileTreeRoots,
        ],
    );

    const fileTreeNodes = useMemo(() => {
        if (activeGitPanelTab !== "files" || !activeProject) {
            return [];
        }

        return [
            {
                children: isProjectRootExpanded ? gitFileNodes : undefined,
                hasChildren: visibleFileTreeRoots.length > 0,
                id: `project-root:${activeProjectContextKey}`,
                isProjectRoot: true,
                kind: "directory" as const,
                name: activeProject.name,
                path: "",
                status: null,
            },
        ] satisfies readonly GitTreeNode[];
    }, [
        activeGitPanelTab,
        activeProject,
        activeProjectContextKey,
        gitFileNodes,
        isProjectRootExpanded,
        visibleFileTreeRoots.length,
    ]);

    const gitChangeGroups = useMemo(
        () =>
            buildGitChangeGroups(activeGitSnapshot?.changes ?? [], {
                onDiscardPath: (path) => {
                    if (!activeProjectId) {
                        return;
                    }

                    const worktreeLabel =
                        activeGitSnapshot?.worktrees.find(
                            (worktree) => worktree.id === activeWorktreeId,
                        )?.branchName ??
                        getPathBase(activeGitSnapshot?.rootPath) ??
                        "current worktree";
                    const confirmed = window.confirm(
                        `Discard changes in "${path}" from ${worktreeLabel}?`,
                    );
                    if (!confirmed) {
                        return;
                    }

                    void discardGitPaths(
                        activeProjectId,
                        [path],
                        activeWorktreeId,
                    ).catch((error: unknown) => {
                        window.alert(
                            error instanceof Error
                                ? error.message
                                : `Could not discard changes for "${path}".`,
                        );
                    });
                },
                onOpenDiff: (path) => {
                    void handleSelectGitDiffPath(path);
                },
                onStagePath: (path) => {
                    if (!activeProjectId) {
                        return;
                    }

                    void stageGitPaths(
                        activeProjectId,
                        [path],
                        activeWorktreeId,
                    );
                },
                onUnstagePath: (path) => {
                    if (!activeProjectId) {
                        return;
                    }

                    void unstageGitPaths(
                        activeProjectId,
                        [path],
                        activeWorktreeId,
                    );
                },
            }),
        [
            activeGitSnapshot,
            activeProjectId,
            activeWorktreeId,
            discardGitPaths,
            handleSelectGitDiffPath,
            stageGitPaths,
            unstageGitPaths,
        ],
    );

    const activeGitDiffs = useMemo(
        () =>
            buildGitDiffFiles(
                activeGitSelectedDiffPath,
                activeGitDiffCache,
                activeGitSnapshot?.changes ?? [],
            ),
        [activeGitDiffCache, activeGitSelectedDiffPath, activeGitSnapshot],
    );

    const gitToolbar = useMemo(
        () => ({
            commit: activeProjectId
                ? {
                      commitLabel: "Commit",
                      disabled:
                          !activeGitSnapshot ||
                          activeGitSnapshot.status.stagedCount === 0 ||
                          activeGitSnapshot.status.conflictedCount > 0 ||
                          !activeGitCommitMessage.trim(),
                      hint: activeGitLoading
                          ? "Refreshing git state..."
                          : !activeGitSnapshot
                            ? "Git state is not available."
                            : activeGitSnapshot.status.conflictedCount > 0
                              ? "Resolve conflicts before committing."
                              : activeGitSnapshot.status.stagedCount === 0
                                ? "Stage at least one change to commit."
                                : "Ready to commit from Changes.",
                      message: activeGitCommitMessage,
                      onChange: (message: string) =>
                          setGitCommitMessage(
                              activeProjectId,
                              message,
                              activeWorktreeId,
                          ),
                      onCommit: handleCommitChanges,
                      placeholder: "Describe the work in this worktree...",
                  }
                : null,
            primaryActions: [
                {
                    id: "stage-all",
                    label: "Stage All",
                    onClick: handleStageAllChanges,
                    disabled:
                        !activeGitSnapshot ||
                        activeGitSnapshot.changedPaths.length === 0,
                } satisfies GitAction,
            ],
            secondaryActions: [
                {
                    id: "unstage-all",
                    label: "Unstage",
                    onClick: handleUnstageAllChanges,
                    disabled:
                        !activeGitSnapshot ||
                        activeGitSnapshot.status.stagedCount === 0,
                } satisfies GitAction,
                {
                    id: "discard-all",
                    label: "Discard",
                    onClick: handleDiscardAllChanges,
                    disabled:
                        !activeGitSnapshot ||
                        activeGitSnapshot.changedPaths.length === 0,
                    tone: "danger",
                } satisfies GitAction,
            ],
            summary: summarizeGitRepository(activeProject, activeGitSnapshot),
            syncActions: activeProjectId
                ? {
                      fetch: {
                          id: "fetch",
                          label: "Fetch",
                          onClick: () =>
                              void fetchGitRepository(
                                  activeProjectId,
                                  activeWorktreeId,
                              ),
                      } satisfies GitAction,
                      pull: {
                          id: "pull",
                          label: "Pull",
                          onClick: () =>
                              void pullGitRepository(
                                  activeProjectId,
                                  activeWorktreeId,
                              ),
                      } satisfies GitAction,
                      push: {
                          id: "push",
                          label: "Push",
                          onClick: () =>
                              void pushGitRepository(
                                  activeProjectId,
                                  activeWorktreeId,
                              ),
                      } satisfies GitAction,
                  }
                : null,
        }),
        [
            activeGitCommitMessage,
            activeGitLoading,
            activeGitSnapshot,
            activeProject,
            activeProjectId,
            activeWorktreeId,
            fetchGitRepository,
            handleCommitChanges,
            handleDiscardAllChanges,
            handleStageAllChanges,
            handleUnstageAllChanges,
            pullGitRepository,
            pushGitRepository,
            setGitCommitMessage,
        ],
    );

    useEffect(() => {
        if (!activeProjectId) {
            return;
        }

        const preferredPath =
            activeGitSelectedDiffPath ??
            activeGitSnapshot?.changedPaths[0] ??
            null;
        if (!preferredPath || preferredPath in activeGitDiffCache) {
            return;
        }

        void selectGitDiffPath(
            activeProjectId,
            preferredPath,
            activeWorktreeId,
        );
    }, [
        activeGitDiffCache,
        activeGitSelectedDiffPath,
        activeGitSnapshot,
        activeProjectId,
        activeWorktreeId,
        selectGitDiffPath,
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
            if (event.key === "Escape" && sidebarOverlayVisible) {
                setSidebarOverlayVisible(false);
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
                <button
                    className="sidebar-action-row app-no-drag"
                    onClick={() => void addProjects()}
                    type="button"
                >
                    <svg
                        aria-hidden="true"
                        className="h-4 w-4 shrink-0"
                        fill="none"
                        viewBox="0 0 16 16"
                    >
                        <path
                            d="M8 3v10M3 8h10"
                            stroke="currentColor"
                            strokeLinecap="round"
                            strokeWidth="1.5"
                        />
                    </svg>
                    <span>Add Project</span>
                </button>

                <button
                    className="sidebar-action-row app-no-drag"
                    onClick={() => {
                        setSidebarSearchVisible((v) => !v);
                        if (sidebarSearchVisible) setProjectFilter("");
                    }}
                    type="button"
                >
                    <svg
                        aria-hidden="true"
                        className="h-4 w-4 shrink-0"
                        fill="none"
                        viewBox="0 0 16 16"
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
                    <span>Search</span>
                </button>

                {sidebarSearchVisible ? (
                    <div className="sidebar-search app-no-drag mt-1">
                        <input
                            autoFocus
                            className="sidebar-search-input"
                            onChange={(event) =>
                                setProjectFilter(event.target.value)
                            }
                            placeholder="Filter projects..."
                            type="text"
                            value={projectFilter}
                        />
                    </div>
                ) : null}

                {projectsError ? (
                    <div className="mt-2 rounded-md bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-600">
                        {projectsError}
                    </div>
                ) : null}
            </div>

            <div className="shell-scrollbar flex-1 overflow-y-auto px-2 py-2">
                {sidebarProjects.length > 0 ? (
                    <ProjectGitSidebar
                        onCheckoutBranch={(projectId, branchId) =>
                            void handleCheckoutBranch(projectId, branchId)
                        }
                        onCreateWorktreeFromBranch={(projectId, branchId) =>
                            void handleCreateWorktreeFromBranch(
                                projectId,
                                branchId,
                            )
                        }
                        onSelectBranch={(projectId, branchId) =>
                            void handleSelectBranch(projectId, branchId)
                        }
                        onSelectProject={(projectId) =>
                            void handleSelectProject(projectId)
                        }
                        onSelectWorktree={(projectId, worktreeId) =>
                            void handleSelectWorktree(projectId, worktreeId)
                        }
                        onToggleBranches={toggleGitBranchesExpanded}
                        onToggleProject={toggleGitProjectExpanded}
                        onToggleWorktrees={toggleGitWorktreesExpanded}
                        projects={sidebarProjects}
                    />
                ) : (
                    <div className="px-3 py-4 text-xs text-text-secondary">
                        Open a folder to start building your git workspace.
                    </div>
                )}
            </div>

            <div className="border-t border-border/50 px-2 py-2">
                <button
                    className="sidebar-action-row app-no-drag w-full"
                    onClick={openSettingsWindow}
                    type="button"
                >
                    <svg
                        aria-hidden="true"
                        className="h-4 w-4 shrink-0"
                        fill="none"
                        viewBox="0 0 16 16"
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
                    <span>Settings</span>
                </button>
            </div>
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
                            data-active={activeSurface === "workspace"}
                            onClick={() => focusSurface("workspace")}
                            onFocus={() => focusSurface("workspace")}
                            tabIndex={0}
                        >
                            <WorkspaceView
                                defaultProjectId={activeProjectId}
                                defaultWorktreeId={activeWorktreeId}
                            />
                        </main>

                        <SplitHandle
                            label="Resize files panel"
                            onPointerDown={(event) =>
                                startDragging(
                                    "right",
                                    event,
                                    rightWidth,
                                    setDragState,
                                )
                            }
                            onStepBackward={() =>
                                nudgePanel(
                                    "right",
                                    shellLayoutConstraints.keyboardStep,
                                )
                            }
                            onStepForward={() =>
                                nudgePanel(
                                    "right",
                                    -shellLayoutConstraints.keyboardStep,
                                )
                            }
                        />

                        <aside
                            className="surface-focus flex min-h-0 flex-col bg-bg-panel"
                            data-active={activeSurface === "utility"}
                            onClick={() => focusSurface("utility")}
                            onFocus={() => focusSurface("utility")}
                            tabIndex={0}
                        >
                            <GitPanel
                                activeTab={activeGitPanelTab}
                                changes={{
                                    activePath: activeGitSelectedDiffPath,
                                    expandedGroupIds: activeGitExpandedGroups,
                                    expandedPaths: activeGitExpandedPaths,
                                    groups: gitChangeGroups,
                                    onNodeClick: (node) =>
                                        void handleSelectGitDiffPath(node.path),
                                    onToggleDirectory: (node) => {
                                        if (!activeProjectId) {
                                            return;
                                        }

                                        toggleGitChangePath(
                                            activeProjectId,
                                            node.path,
                                            activeWorktreeId,
                                        );
                                    },
                                    onToggleGroup: (groupId) => {
                                        if (!activeProjectId) {
                                            return;
                                        }

                                        toggleGitChangeGroup(
                                            activeProjectId,
                                            groupId,
                                            activeWorktreeId,
                                        );
                                    },
                                }}
                                diffs={{
                                    activeFileId: activeGitSelectedDiffPath,
                                    files: activeGitDiffs,
                                    onSelectFile: (file) =>
                                        void handleSelectGitDiffPath(file.path),
                                }}
                                files={{
                                    activePath: activeFilePath,
                                    enableNodeDrag: true,
                                    expandedPaths: visibleExpandedDirectories,
                                    nodes: fileTreeNodes,
                                    onBackgroundContextMenu: ({ x, y }) =>
                                        setFileTreeContextMenu({
                                            x,
                                            y,
                                            payload: { kind: "background" },
                                        }),
                                    onBackgroundDrop: (dragData) =>
                                        void handleMoveTreeEntry(
                                            dragData,
                                            null,
                                        ),
                                    onNodeClick: (node) =>
                                        activeProjectId
                                            ? void openFileTab(
                                                  activeProjectId,
                                                  node.path,
                                                  activeWorktreeId,
                                              )
                                            : undefined,
                                    onNodeContextMenu: (node, { x, y }) =>
                                        setFileTreeContextMenu({
                                            x,
                                            y,
                                            payload: {
                                                kind: "node",
                                                node,
                                            },
                                        }),
                                    onNodeDrop: (dragData, node) =>
                                        void handleMoveTreeEntry(
                                            dragData,
                                            node.isProjectRoot
                                                ? null
                                                : node.path,
                                        ),
                                    onNodeDragStart: (node, dataTransfer) => {
                                        if (!dataTransfer) {
                                            return;
                                        }

                                        dataTransfer.effectAllowed = "copyMove";
                                        dataTransfer.setData(
                                            COMPOSER_PROJECT_ENTRY_MIME,
                                            serializeComposerProjectEntryDragData(
                                                {
                                                    kind: node.kind,
                                                    name: node.name,
                                                    relativePath: node.path,
                                                },
                                            ),
                                        );
                                        dataTransfer.setData(
                                            "text/plain",
                                            node.path,
                                        );
                                    },
                                    onToggleDirectory: (node) => {
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

                                        const treeNode =
                                            findProjectTreeNodeByPath(
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
                                    },
                                }}
                                onTabChange={(tab) => {
                                    if (!activeProjectId) {
                                        return;
                                    }

                                    setGitPanelTab(
                                        activeProjectId,
                                        tab,
                                        activeWorktreeId,
                                    );
                                }}
                                tabCounts={{
                                    changes:
                                        activeGitSnapshot?.status
                                            .changedCount ?? 0,
                                    diffs: activeGitDiffs.length,
                                    files: visibleFileTreeRoots.length,
                                }}
                                toolbar={gitToolbar}
                            />
                        </aside>
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

function buildSidebarProjects({
    activeProjectId,
    activeWorktreeIds,
    branchesByProject,
    expandedBranches,
    expandedProjects,
    expandedWorktrees,
    onRemoveWorktree,
    projects,
    selectedBranchNames,
    selectedBranchNamesByContext,
    snapshots,
}: {
    readonly activeProjectId: string | null;
    readonly activeWorktreeIds: Record<string, string | null>;
    readonly branchesByProject: Record<string, readonly GitBranchSummary[]>;
    readonly expandedBranches: Record<string, boolean>;
    readonly expandedProjects: Record<string, boolean>;
    readonly expandedWorktrees: Record<string, boolean>;
    readonly onRemoveWorktree?: (
        projectId: string,
        worktree: GitWorktreeSummary,
    ) => void | Promise<void>;
    readonly projects: readonly ProjectSummary[];
    readonly selectedBranchNames: Record<string, string | null>;
    readonly selectedBranchNamesByContext: Record<string, string | null>;
    readonly snapshots: Record<string, GitRepositorySnapshot | null>;
}): readonly ProjectGitSidebarProject[] {
    return projects.map((project) => {
        const projectWorktreeId = activeWorktreeIds[project.id] ?? null;
        const projectContextKey = getGitContextKey(
            project.id,
            projectWorktreeId,
        );
        const snapshot =
            snapshots[projectContextKey] ??
            snapshots[getGitContextKey(project.id, null)] ??
            null;
        const worktrees = snapshot?.worktrees ?? [];
        const branches = branchesByProject[project.id] ?? [];
        const branchWorktreeCounts = new Map<string, number>();

        for (const worktree of worktrees) {
            if (!worktree.branchName) {
                continue;
            }

            branchWorktreeCounts.set(
                worktree.branchName,
                (branchWorktreeCounts.get(worktree.branchName) ?? 0) + 1,
            );
        }

        return {
            branches: branches.map((branch) => ({
                aheadCount: branch.aheadBy,
                behindCount: branch.behindBy,
                description: branch.upstreamName ?? null,
                id: branch.name,
                isActive:
                    (selectedBranchNamesByContext[projectContextKey] ??
                        selectedBranchNames[project.id] ??
                        snapshot?.branch?.name) === branch.name ||
                    branch.isCurrent,
                isRemote: branch.isRemote,
                label: branch.name,
                worktreeCount: branchWorktreeCounts.get(branch.name) ?? 0,
            })),
            branchesExpanded: expandedBranches[project.id] ?? false,
            id: project.id,
            isActive: project.id === activeProjectId,
            isExpanded:
                expandedProjects[project.id] ?? project.id === activeProjectId,
            name: project.name,
            rootPath: snapshot?.canonicalRootPath ?? project.rootPath,
            worktrees: worktrees.map((worktree) => ({
                aheadCount: worktree.branchName
                    ? (branches.find(
                          (branch) => branch.name === worktree.branchName,
                      )?.aheadBy ?? null)
                    : null,
                badges: [
                    ...(worktree.isPrimary
                        ? [{ label: "Primary", tone: "neutral" as const }]
                        : []),
                    ...(worktree.isCurrent
                        ? [{ label: "Current", tone: "accent" as const }]
                        : []),
                    ...(worktree.isLocked
                        ? [{ label: "Locked", tone: "warning" as const }]
                        : []),
                ],
                behindCount: worktree.branchName
                    ? (branches.find(
                          (branch) => branch.name === worktree.branchName,
                      )?.behindBy ?? null)
                    : null,
                id: worktree.id,
                isActive:
                    worktree.id === projectWorktreeId || worktree.isCurrent,
                label:
                    worktree.branchName ??
                    getPathBase(worktree.rootPath) ??
                    worktree.rootPath,
                branchName: worktree.branchName,
                description: worktree.rootPath,
                status:
                    worktree.id ===
                    (projectWorktreeId ?? snapshot?.currentWorktreeId)
                        ? deriveWorktreeSidebarStatus(snapshot, worktree)
                        : undefined,
                trailingActions:
                    !worktree.isPrimary && onRemoveWorktree
                        ? [
                              {
                                  label: "Remove",
                                  onClick: () =>
                                      void onRemoveWorktree(
                                          project.id,
                                          worktree,
                                      ),
                              },
                          ]
                        : [],
            })),
            worktreesExpanded: expandedWorktrees[project.id] ?? true,
        } satisfies ProjectGitSidebarProject;
    });
}

function buildGitChangeGroups(
    changes: readonly GitChangeEntry[],
    actions: {
        readonly onDiscardPath: (path: string) => void;
        readonly onOpenDiff: (path: string) => void;
        readonly onStagePath: (path: string) => void;
        readonly onUnstagePath: (path: string) => void;
    },
): readonly GitChangeGroup[] {
    const groups: readonly GitChangeGroupId[] = [
        "conflicts",
        "changes",
        "staged",
        "untracked",
    ];

    return groups.map((groupId) => {
        const groupChanges = changes.filter((change) => {
            switch (groupId) {
                case "conflicts":
                    return change.scope === "conflicted";
                case "staged":
                    return change.scope === "staged";
                case "untracked":
                    return change.scope === "untracked";
                case "changes":
                default:
                    return change.scope === "unstaged";
            }
        });

        return {
            actions: [],
            count: groupChanges.length,
            description:
                groupChanges.length > 0
                    ? `${groupChanges.length} path${groupChanges.length === 1 ? "" : "s"}`
                    : null,
            emptyLabel: `No ${groupId} entries.`,
            id: groupId,
            nodes: buildGitChangeTreeNodes(groupChanges, actions),
            title:
                groupId === "conflicts"
                    ? "Conflicts"
                    : groupId === "changes"
                      ? "Changes"
                      : groupId === "staged"
                        ? "Staged"
                        : "Untracked",
        } satisfies GitChangeGroup;
    });
}

function buildGitDiffFiles(
    selectedDiffPath: string | null,
    diffCache: Record<string, SharedGitFileDiff | null>,
    changes: readonly GitChangeEntry[],
): readonly GitDiffFile[] {
    const orderedPaths = [
        ...(selectedDiffPath ? [selectedDiffPath] : []),
        ...changes.map((change) => change.path),
        ...Object.keys(diffCache),
    ];

    const uniquePaths = Array.from(new Set(orderedPaths));

    return uniquePaths.map((path) => {
        const change = changes.find((entry) => entry.path === path) ?? null;
        const diff = diffCache[path] ?? null;

        if (diff) {
            return convertSharedGitDiff(diff, change);
        }

        return {
            hunks: [],
            id: path,
            isText: !(change?.isBinary ?? false),
            kind: mapChangeKindToDiffKind(change),
            newText: null,
            oldText: null,
            path,
            previousPath: change?.previousPath ?? null,
            reversible: change?.scope !== "untracked",
            statusLabel: formatChangeLabel(change),
            summary: formatGitCountLabel(
                change?.additions ?? null,
                change?.deletions ?? null,
            ),
        } satisfies GitDiffFile;
    });
}

function summarizeGitRepository(
    project: ProjectSummary | null,
    snapshot: GitRepositorySnapshot | null,
): GitRepositorySummary | null {
    if (!snapshot) {
        return null;
    }

    const activeWorktree = snapshot.worktrees.find(
        (worktree) => worktree.id === snapshot.currentWorktreeId,
    );

    return {
        aheadBy: snapshot.aheadBy,
        behindBy: snapshot.behindBy,
        branchName: snapshot.branch?.name ?? null,
        detached: snapshot.branch?.isDetached ?? false,
        repositoryName: project?.name ?? getPathBase(snapshot.rootPath),
        stateLabel: describeRepositoryState(snapshot.repositoryState, snapshot),
        upstreamName: snapshot.branch?.upstreamName ?? null,
        worktreeName:
            activeWorktree?.branchName ?? getPathBase(activeWorktree?.rootPath),
        worktreePath: activeWorktree?.rootPath ?? snapshot.rootPath,
    };
}

function mapGitChangeToNodeStatus(
    change: GitChangeEntry,
): GitTreeNode["status"] {
    switch (change.kind) {
        case "conflicted":
            return "conflict";
        case "added":
            return change.scope === "staged" ? "staged" : "added";
        case "deleted":
            return "deleted";
        case "renamed":
            return "renamed";
        case "untracked":
            return "untracked";
        case "typechange":
        case "copied":
        case "modified":
        default:
            return change.scope === "staged" ? "staged" : "modified";
    }
}

function deriveWorktreeSidebarStatus(
    snapshot: GitRepositorySnapshot | null,
    worktree: GitWorktreeSummary,
): ProjectGitSidebarWorktree["status"] | undefined {
    if (worktree.isBare) {
        return "missing";
    }

    if (!snapshot || snapshot.currentWorktreeId !== worktree.id) {
        return undefined;
    }

    if (snapshot.repositoryState !== "ready") {
        return "missing";
    }

    if (snapshot.status.conflictedCount > 0) {
        return "conflicted";
    }

    return snapshot.status.changedCount > 0 ? "dirty" : "clean";
}

function buildGitChangeTreeNodes(
    changes: readonly GitChangeEntry[],
    actions: {
        readonly onDiscardPath: (path: string) => void;
        readonly onOpenDiff: (path: string) => void;
        readonly onStagePath: (path: string) => void;
        readonly onUnstagePath: (path: string) => void;
    },
): readonly GitTreeNode[] {
    const roots = new Map<string, MutableGitChangeTreeNode>();

    for (const change of changes) {
        const parts = change.path.split("/").filter(Boolean);
        if (parts.length === 0) {
            continue;
        }

        let currentMap = roots;
        let currentPath = "";

        for (const [index, part] of parts.entries()) {
            currentPath = currentPath ? `${currentPath}/${part}` : part;
            const isLeaf = index === parts.length - 1;
            const existing = currentMap.get(currentPath);

            if (existing) {
                if (isLeaf) {
                    existing.change = change;
                }
                currentMap = existing.children;
                continue;
            }

            const nextNode: MutableGitChangeTreeNode = {
                change: isLeaf ? change : null,
                children: new Map<string, MutableGitChangeTreeNode>(),
                kind: isLeaf && !change.hasChildren ? "file" : "directory",
                name: part,
                path: currentPath,
            };

            currentMap.set(currentPath, nextNode);
            currentMap = nextNode.children;
        }
    }

    return Array.from(roots.values())
        .map((node) => finalizeGitChangeTreeNode(node, actions))
        .sort(compareGitTreeNodes);
}

function finalizeGitChangeTreeNode(
    node: MutableGitChangeTreeNode,
    actions: {
        readonly onDiscardPath: (path: string) => void;
        readonly onOpenDiff: (path: string) => void;
        readonly onStagePath: (path: string) => void;
        readonly onUnstagePath: (path: string) => void;
    },
): GitTreeNode {
    const children = Array.from(node.children.values())
        .map((child) => finalizeGitChangeTreeNode(child, actions))
        .sort(compareGitTreeNodes);
    const status =
        node.change !== null
            ? mapGitChangeToNodeStatus(node.change)
            : deriveDirectoryStatus(children);

    return {
        actions:
            node.kind === "file" && node.change
                ? buildGitChangeActions(node.change, actions)
                : [],
        children,
        hasChildren: children.length > 0,
        id: node.path,
        kind: node.kind,
        meta:
            node.change &&
            (node.change.additions !== null ||
                node.change.deletions !== null) ? (
                <span className="font-mono text-[11px] text-text-secondary">
                    {formatGitCountMeta(
                        node.change.additions,
                        node.change.deletions,
                    )}
                </span>
            ) : null,
        name: node.name,
        path: node.path,
        secondaryText: node.change?.previousPath
            ? `from ${node.change.previousPath}`
            : node.change?.isBinary
              ? "Binary file"
              : null,
        status,
    };
}

function buildGitChangeActions(
    change: GitChangeEntry,
    actions: {
        readonly onDiscardPath: (path: string) => void;
        readonly onOpenDiff: (path: string) => void;
        readonly onStagePath: (path: string) => void;
        readonly onUnstagePath: (path: string) => void;
    },
): readonly GitAction[] {
    const nextActions: GitAction[] = [
        {
            id: `${change.path}:diff`,
            label: "Diff",
            onClick: () => actions.onOpenDiff(change.path),
        },
    ];

    if (change.scope === "staged") {
        nextActions.push({
            id: `${change.path}:unstage`,
            label: "Unstage",
            onClick: () => actions.onUnstagePath(change.path),
        });
    } else {
        nextActions.push({
            id: `${change.path}:stage`,
            label: "Stage",
            onClick: () => actions.onStagePath(change.path),
        });
    }

    nextActions.push({
        id: `${change.path}:discard`,
        label: "Discard",
        onClick: () => actions.onDiscardPath(change.path),
        tone: "danger",
    });

    return nextActions;
}

function deriveDirectoryStatus(
    children: readonly GitTreeNode[],
): GitNodeStatus | null {
    const childStatuses = Array.from(
        new Set(children.map((child) => child.status).filter(Boolean)),
    ) as GitNodeStatus[];

    if (childStatuses.length === 0) {
        return null;
    }

    if (childStatuses.length === 1) {
        return childStatuses[0] ?? null;
    }

    return "mixed";
}

function compareGitTreeNodes(left: GitTreeNode, right: GitTreeNode): number {
    if (left.kind !== right.kind) {
        return left.kind === "directory" ? -1 : 1;
    }

    return left.path.localeCompare(right.path);
}

function convertSharedGitDiff(
    diff: SharedGitFileDiff,
    change: GitChangeEntry | null,
): GitDiffFile {
    return {
        hunks: diff.hunks.map((hunk) => {
            let oldLine = hunk.oldStart;
            let newLine = hunk.newStart;

            return {
                header: `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`,
                id: hunk.id,
                lines: hunk.lines.map((line) => {
                    if (line.type === "add") {
                        return {
                            id: line.id,
                            kind: "add" as const,
                            newLineNumber: newLine++,
                            oldLineNumber: null,
                            text: line.text,
                        };
                    }

                    if (line.type === "remove") {
                        return {
                            id: line.id,
                            kind: "remove" as const,
                            newLineNumber: null,
                            oldLineNumber: oldLine++,
                            text: line.text,
                        };
                    }

                    return {
                        id: line.id,
                        kind: "context" as const,
                        newLineNumber: newLine++,
                        oldLineNumber: oldLine++,
                        text: line.text,
                    };
                }),
                newCount: hunk.newCount,
                newStart: hunk.newStart,
                oldCount: hunk.oldCount,
                oldStart: hunk.oldStart,
            };
        }),
        id: diff.path,
        isText: diff.isText,
        kind: diff.kind,
        newText: diff.newText,
        oldText: diff.oldText,
        path: diff.path,
        previousPath: diff.previousPath,
        reversible: diff.reversible,
        statusLabel: formatChangeLabel(change),
        summary: formatGitCountLabel(
            change?.additions ?? null,
            change?.deletions ?? null,
        ),
    };
}

function mapChangeKindToDiffKind(
    change: GitChangeEntry | null,
): GitDiffFile["kind"] {
    if (!change) {
        return "update";
    }

    switch (change.kind) {
        case "added":
        case "untracked":
            return "create";
        case "deleted":
            return "delete";
        case "renamed":
            return "move";
        default:
            return "update";
    }
}

function formatChangeLabel(change: GitChangeEntry | null): string | null {
    if (!change) {
        return null;
    }

    switch (change.kind) {
        case "added":
            return "added";
        case "deleted":
            return "deleted";
        case "renamed":
            return "renamed";
        case "conflicted":
            return "conflict";
        case "untracked":
            return "untracked";
        default:
            return change.scope === "staged" ? "staged" : "modified";
    }
}

function formatGitCountMeta(
    additions: number | null,
    deletions: number | null,
): string {
    const parts: string[] = [];

    if (typeof additions === "number") {
        parts.push(`+${additions}`);
    }

    if (typeof deletions === "number") {
        parts.push(`-${deletions}`);
    }

    return parts.join(" ");
}

function formatGitCountLabel(
    additions: number | null,
    deletions: number | null,
): string | null {
    const label = formatGitCountMeta(additions, deletions);
    return label.length > 0 ? label : null;
}

function describeRepositoryState(
    repositoryState: GitRepositoryState,
    snapshot: GitRepositorySnapshot,
): string | null {
    if (repositoryState !== "ready") {
        switch (repositoryState) {
            case "not_repo":
                return "Not a git repository";
            case "missing":
                return "Missing worktree";
            case "bare":
                return "Bare repository";
            case "error":
                return "Git error";
            default:
                return repositoryState;
        }
    }

    if (snapshot.status.conflictedCount > 0) {
        return "Conflicts";
    }

    switch (snapshot.syncStatus) {
        case "ahead":
            return "Ahead";
        case "behind":
            return "Behind";
        case "diverged":
            return "Diverged";
        default:
            return null;
    }
}

function getGitContextKey(
    projectId: string | null,
    worktreeId: string | null,
): string {
    return `${projectId ?? "__none__"}::${worktreeId ?? "__primary__"}`;
}

function sanitizeBranchName(branchName: string): string {
    return branchName
        .trim()
        .replace(/[^a-zA-Z0-9._/-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .replace(/[\\/]+/g, "-")
        .slice(0, 64);
}

function getPathBase(value: string | null | undefined): string | null {
    if (!value) {
        return null;
    }

    const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
    const parts = normalized.split("/").filter(Boolean);
    return parts.at(-1) ?? null;
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

function getParentRelativePath(relativePath: string): string | null {
    const segments = relativePath.split("/").filter(Boolean);
    if (segments.length <= 1) {
        return null;
    }

    return segments.slice(0, -1).join("/");
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
    side: "left" | "right",
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
