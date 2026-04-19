import {
    useCallback,
    useEffect,
    useEffectEvent,
    useMemo,
    useRef,
    useState,
    type KeyboardEvent as ReactKeyboardEvent,
    type MouseEvent as ReactMouseEvent,
    type PointerEvent as ReactPointerEvent,
} from "react";

import type {
    ComandoApi,
    PersistenceSnapshot,
    ProjectTreeNode,
    ProjectSummary,
    SettingsSnapshot,
} from "@shared/ipc";
import { resolveEditorLanguage } from "@shared/editor-language";

import { useSystemTheme } from "./app/hooks/use-system-theme";
import { setCachedAppEditorSettings } from "./app/settings/client";
import {
    buildFlatGitTreeNodesFromProjectEntries,
    buildGitTreeNodesFromProjectTree,
    findProjectTreeNodeByPath,
} from "./app/projects/git-tree";
import {
    reconcileFileTreeSelection,
    resolveActiveFileTreePath,
} from "./app/projects/file-tree-selection";
import {
    searchProjectQuickOpenEntries,
    type ProjectQuickOpenMatch,
} from "./app/projects/quick-open";
import { shellLayoutConstraints } from "./app/layout/shell-layout";
import {
    COMPOSER_PROJECT_ENTRY_LIST_MIME,
    COMPOSER_PROJECT_ENTRY_MIME,
    serializeComposerProjectEntryListDragData,
    serializeComposerProjectEntryDragData,
} from "./app/drag-and-drop";
import { useAppStore } from "./app/store/app-store";
import { useAiStore } from "./app/store/ai-store";
import { useGitStore } from "./app/store/git-store";
import { useProjectsStore } from "./app/store/projects-store";
import { useShellStore } from "./app/store/shell-store";
import { useWorkspaceStore } from "./app/store/workspace-store";
import { findPaneById, type RuntimeWorkspaceTab } from "./app/workspace/tree";
import {
    flattenVisibleGitTreeNodes,
    getProjectEntryParentRelativePath,
    GitTreeView,
    resolveGitTreeDragPaths,
    selectGitTreeRange,
    toggleGitTreePathSelection,
    type GitTreeDragData,
    type GitTreeNode,
} from "./components/git";
import { StickyFolderOverlay } from "./components/git/StickyFolderOverlay";
import { useStickyFolders } from "./components/git/useStickyFolders";
import {
    ContextMenu,
    type ContextMenuEntry,
    type ContextMenuState,
} from "./components/context-menu/ContextMenu";
import {
    SidebarAgentsPanel,
    SidebarGitPanel,
    SidebarGitScopePicker,
} from "./components/sidebar";
import { SplitHandle } from "./components/SplitHandle";
import {
    createWorkspaceQuickDirectory,
    createWorkspaceQuickFile,
} from "./components/workspace/quick-create";
import { QuickOpenFilePalette } from "./components/workspace/QuickOpenFilePalette";
import { WindowsTopBar } from "./components/WindowsTopBar";
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

type FileTreeInlineEditorState = {
    readonly draftName: string;
    readonly kind: "directory" | "file";
    readonly originalName: string;
    readonly path: string;
};

function selectActiveWorkspaceTab(
    state: ReturnType<typeof useWorkspaceStore.getState>,
): RuntimeWorkspaceTab | null {
    const activePane = findPaneById(state.rootNode, state.activePaneId);
    if (!activePane?.activeTabId) {
        return null;
    }

    return state.tabsById[activePane.activeTabId] ?? null;
}

export function App() {
    useSystemTheme();

    const bootstrap = useAppStore((state) => state.bootstrap);
    const bootstrapError = useAppStore((state) => state.error);
    const hydrateBootstrap = useAppStore((state) => state.hydrate);

    const activeProjectId = useProjectsStore((state) => state.activeProjectId);
    const addProjects = useProjectsStore((state) => state.addProjects);
    const hydrateProjects = useProjectsStore((state) => state.hydrate);
    const loadingNodeKeys = useProjectsStore((state) => state.loadingNodeKeys);
    const projects = useProjectsStore((state) => state.projects);
    const projectsError = useProjectsStore((state) => state.error);
    const refreshProjectTree = useProjectsStore(
        (state) => state.refreshProjectTree,
    );
    const revealPathInTree = useProjectsStore(
        (state) => state.revealPathInTree,
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
    const setLastQuickCreateAction = useWorkspaceStore(
        (state) => state.setLastQuickCreateAction,
    );
    const refreshProjectTabs = useWorkspaceStore(
        (state) => state.refreshProjectTabs,
    );
    const reopenLastClosedTab = useWorkspaceStore(
        (state) => state.reopenLastClosedTab,
    );
    const renameTabsForProjectPath = useWorkspaceStore(
        (state) => state.renameTabsForProjectPath,
    );
    const workspaceActivePaneId = useWorkspaceStore(
        (state) => state.activePaneId,
    );
    const workspaceError = useWorkspaceStore((state) => state.error);
    const activeWorkspaceTab = useWorkspaceStore(selectActiveWorkspaceTab);

    const activeSurface = useShellStore((state) => state.activeSurface);
    const focusSurface = useShellStore((state) => state.focusSurface);
    const hydrateShell = useShellStore((state) => state.hydrate);
    const leftCollapsed = useShellStore((state) => state.leftCollapsed);
    const leftWidth = useShellStore((state) => state.leftWidth);
    const nudgePanel = useShellStore((state) => state.nudgePanel);
    const resizePanel = useShellStore((state) => state.resizePanel);
    const setLeftCollapsed = useShellStore((state) => state.setLeftCollapsed);
    const setSidebarView = useShellStore((state) => state.setSidebarView);
    const sidebarView = useShellStore((state) => state.sidebarView);
    const syncViewport = useShellStore((state) => state.syncViewport);
    const toggleLeftCollapsed = useShellStore(
        (state) => state.toggleLeftCollapsed,
    );
    const applyAiRuntimeStatus = useAiStore(
        (state) => state.applyRuntimeStatus,
    );
    const applyAiSessionUpdate = useAiStore(
        (state) => state.applySessionUpdate,
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
    const [fileTreeSearchResults, setFileTreeSearchResults] = useState<
        readonly ProjectTreeNode[]
    >([]);
    const [isQuickOpenOpen, setIsQuickOpenOpen] = useState(false);
    const [isQuickOpenLoading, setIsQuickOpenLoading] = useState(false);
    const [quickOpenQuery, setQuickOpenQuery] = useState("");
    const [quickOpenSearchResults, setQuickOpenSearchResults] = useState<
        readonly ProjectTreeNode[]
    >([]);
    const [quickOpenSelectedIndex, setQuickOpenSelectedIndex] = useState(0);
    const [fileTreeInlineEditor, setFileTreeInlineEditor] =
        useState<FileTreeInlineEditorState | null>(null);
    const [persistenceReady, setPersistenceReady] = useState(false);
    const [sidebarOverlayVisible, setSidebarOverlayVisible] = useState(false);
    const [gitChangesFilter, setGitChangesFilter] = useState("");
    const [agentsFilter, setAgentsFilter] = useState("");
    const [fileTreeSelectedPaths, setFileTreeSelectedPaths] = useState<
        readonly string[]
    >([]);
    const [fileTreeSelectionAnchorPath, setFileTreeSelectionAnchorPath] =
        useState<string | null>(null);
    const [fileTreeRevealSignal, setFileTreeRevealSignal] = useState<
        number | null
    >(null);
    const fileTreeSearchInputRef = useRef<HTMLInputElement | null>(null);
    const fileTreeInlineSubmitPendingRef = useRef(false);
    const fileTreeSearchRequestRef = useRef(0);
    const overlayDismissRef = useRef<number | null>(null);
    const quickOpenSearchRequestRef = useRef(0);
    const sidebarScrollRef = useRef<HTMLDivElement | null>(null);

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

                setCachedAppEditorSettings(settingsSnapshot?.editor);
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
            void refreshProjectTabs(
                payload.projectId,
                preferredWorktreeId,
                payload.relativePaths ?? null,
            );
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
                void comandoApi.refreshAiProjectScopes(payload.projectId);
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
        const unsubscribeSession = comandoApi.onAiSessionSnapshot((update) => {
            applyAiSessionUpdate(update);
        });

        return () => {
            unsubscribeRuntime();
            unsubscribeSession();
        };
    }, [applyAiRuntimeStatus, applyAiSessionUpdate]);

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
        const comandoApi = getComandoApi();
        if (!comandoApi) {
            return;
        }

        const unsubscribe = comandoApi.onWorkspaceReopenLastClosedTab(() => {
            void reopenLastClosedTab();
        });

        return () => {
            unsubscribe();
        };
    }, [reopenLastClosedTab]);

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

    useEffect(() => {
        setFileTreeFilter("");
        setFileTreeSearchResults([]);
        setFileTreeContextMenu(null);
        setFileTreeSelectedPaths([]);
        setFileTreeSelectionAnchorPath(null);
        setIsFileTreeSearchLoading(false);
        setIsFileTreeSearchOpen(false);
        setIsQuickOpenLoading(false);
        setIsQuickOpenOpen(false);
        setQuickOpenQuery("");
        setQuickOpenSearchResults([]);
        setQuickOpenSelectedIndex(0);
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

        if (!activeProjectId || !normalizedFilter || !window.comando) {
            fileTreeSearchRequestRef.current += 1;
            setFileTreeSearchResults([]);
            setIsFileTreeSearchLoading(false);
            return;
        }

        setIsFileTreeSearchLoading(true);
        const requestId = fileTreeSearchRequestRef.current + 1;
        fileTreeSearchRequestRef.current = requestId;
        const timeoutId = window.setTimeout(() => {
            void window.comando
                .searchProjectEntries({
                    limit: 160,
                    projectId: activeProjectId,
                    query: normalizedFilter,
                    worktreeId: activeWorktreeId,
                })
                .then((results) => {
                    if (fileTreeSearchRequestRef.current !== requestId) {
                        return;
                    }

                    setFileTreeSearchResults(results);
                })
                .catch(() => {
                    if (fileTreeSearchRequestRef.current !== requestId) {
                        return;
                    }

                    setFileTreeSearchResults([]);
                })
                .finally(() => {
                    if (fileTreeSearchRequestRef.current !== requestId) {
                        return;
                    }

                    setIsFileTreeSearchLoading(false);
                });
        }, 120);

        return () => {
            window.clearTimeout(timeoutId);
        };
    }, [activeProjectId, activeWorktreeId, fileTreeFilter]);

    useEffect(() => {
        const normalizedQuery = quickOpenQuery.trim();

        if (
            !isQuickOpenOpen ||
            !activeProjectId ||
            !normalizedQuery ||
            !window.comando
        ) {
            quickOpenSearchRequestRef.current += 1;
            setQuickOpenSearchResults([]);
            setIsQuickOpenLoading(false);
            return;
        }

        setIsQuickOpenLoading(true);
        const requestId = quickOpenSearchRequestRef.current + 1;
        quickOpenSearchRequestRef.current = requestId;
        const timeoutId = window.setTimeout(() => {
            void window.comando
                .searchProjectEntries({
                    limit: 120,
                    projectId: activeProjectId,
                    query: normalizedQuery,
                    worktreeId: activeWorktreeId,
                })
                .then((results) => {
                    if (quickOpenSearchRequestRef.current !== requestId) {
                        return;
                    }

                    setQuickOpenSearchResults(results);
                })
                .catch(() => {
                    if (quickOpenSearchRequestRef.current !== requestId) {
                        return;
                    }

                    setQuickOpenSearchResults([]);
                })
                .finally(() => {
                    if (quickOpenSearchRequestRef.current !== requestId) {
                        return;
                    }

                    setIsQuickOpenLoading(false);
                });
        }, 100);

        return () => {
            window.clearTimeout(timeoutId);
        };
    }, [activeProjectId, activeWorktreeId, isQuickOpenOpen, quickOpenQuery]);

    useEffect(() => {
        if (!isQuickOpenOpen) {
            return;
        }

        setQuickOpenSelectedIndex(0);
    }, [isQuickOpenOpen, quickOpenQuery]);

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
    const activeProjectTree = useMemo(
        () => activeTreeNodesByParent[ROOT_NODE_KEY] ?? [],
        [activeTreeNodesByParent],
    );
    const activeExpandedDirectories = useMemo(
        () => expandedDirectories[activeProjectContextKey] ?? [],
        [activeProjectContextKey, expandedDirectories],
    );
    const normalizedFileTreeFilter = fileTreeFilter.trim();
    const isFilteringFileTree = normalizedFileTreeFilter.length > 0;
    const fileTreeSearchNodes = useMemo(
        () => buildFlatGitTreeNodesFromProjectEntries(fileTreeSearchResults),
        [fileTreeSearchResults],
    );
    const quickOpenResults = useMemo(
        () =>
            searchProjectQuickOpenEntries(
                quickOpenSearchResults,
                quickOpenQuery,
            ),
        [quickOpenQuery, quickOpenSearchResults],
    );
    useEffect(() => {
        if (quickOpenResults.length === 0) {
            setQuickOpenSelectedIndex(0);
            return;
        }

        setQuickOpenSelectedIndex((currentIndex) =>
            Math.min(currentIndex, quickOpenResults.length - 1),
        );
    }, [quickOpenResults.length]);
    const isProjectRootExpanded =
        projectRootExpandedByContext[activeProjectContextKey] ?? true;
    void closeTabsForProjectPath;
    void renameTabsForProjectPath;
    const activeFilePath = useMemo(
        () =>
            resolveActiveFileTreePath({
                activeProjectId,
                activeWorkspaceTab,
                activeWorktreeId,
            }),
        [activeProjectId, activeWorkspaceTab, activeWorktreeId],
    );
    const activeGitError = gitErrors[activeGitContextKey] ?? null;
    const isMac = bootstrap?.platform === "darwin";
    const isWindows = bootstrap?.platform === "win32";
    const topStatus = [
        bootstrapError,
        projectsError,
        workspaceError,
        activeGitError,
    ]
        .filter(Boolean)
        .join(" ");

    useEffect(() => {
        setFileTreeInlineEditor(null);
        fileTreeInlineSubmitPendingRef.current = false;
    }, [activeProjectContextKey]);

    const cancelFileTreeInlineEditor = useCallback(() => {
        fileTreeInlineSubmitPendingRef.current = false;
        setFileTreeInlineEditor(null);
    }, []);

    const clearFileTreeSelection = useCallback(() => {
        setFileTreeSelectedPaths([]);
        setFileTreeSelectionAnchorPath(null);
    }, []);

    const beginFileTreeInlineRename = useCallback((node: GitTreeNode) => {
        setFileTreeInlineEditor({
            draftName: node.name,
            kind: node.kind,
            originalName: node.name,
            path: node.path,
        });
    }, []);

    const submitFileTreeInlineEditor = useCallback(async () => {
        if (
            !activeProjectId ||
            !fileTreeInlineEditor ||
            fileTreeInlineSubmitPendingRef.current
        ) {
            return;
        }

        const nextName = fileTreeInlineEditor.draftName.trim();
        if (!nextName || nextName === fileTreeInlineEditor.originalName) {
            cancelFileTreeInlineEditor();
            return;
        }

        fileTreeInlineSubmitPendingRef.current = true;

        try {
            const renamedEntry = await renameEntry(
                activeProjectId,
                fileTreeInlineEditor.path,
                nextName,
                undefined,
                activeWorktreeId,
            );
            await renameTabsForProjectPath(
                activeProjectId,
                activeWorktreeId,
                fileTreeInlineEditor.path,
                renamedEntry.relativePath,
                fileTreeInlineEditor.kind,
            );
            cancelFileTreeInlineEditor();
        } catch (error) {
            window.alert(
                error instanceof Error
                    ? error.message
                    : "Could not rename the selected entry.",
            );
        } finally {
            fileTreeInlineSubmitPendingRef.current = false;
        }
    }, [
        activeProjectId,
        activeWorktreeId,
        cancelFileTreeInlineEditor,
        fileTreeInlineEditor,
        renameEntry,
        renameTabsForProjectPath,
    ]);

    const handleCreateTreeEntry = useCallback(
        async (
            kind: "directory" | "file",
            parentRelativePath: string | null,
        ) => {
            if (!activeProjectId) {
                return;
            }

            try {
                if (kind === "file") {
                    await createWorkspaceQuickFile({
                        createEntry,
                        openFileTab,
                        parentRelativePath,
                        projectId: activeProjectId,
                        reportError: (message) => {
                            window.alert(message);
                        },
                        setLastQuickCreateAction,
                        worktreeId: activeWorktreeId,
                    });
                    return;
                }

                const createdDirectory = await createWorkspaceQuickDirectory({
                    createEntry,
                    parentRelativePath,
                    projectId: activeProjectId,
                    reportError: (message) => {
                        window.alert(message);
                    },
                    worktreeId: activeWorktreeId,
                });

                if (!createdDirectory) {
                    return;
                }

                await revealPathInTree(
                    activeProjectId,
                    createdDirectory.relativePath,
                    activeWorktreeId,
                );
                setFileTreeInlineEditor({
                    draftName: createdDirectory.name,
                    kind: "directory",
                    originalName: createdDirectory.name,
                    path: createdDirectory.relativePath,
                });
            } catch (error) {
                window.alert(
                    error instanceof Error
                        ? error.message
                        : `Could not create the ${kind}.`,
                );
            }
        },
        [
            activeProjectId,
            activeWorktreeId,
            createEntry,
            openFileTab,
            revealPathInTree,
            setLastQuickCreateAction,
        ],
    );

    const handleRenameTreeNode = useCallback(
        (node: GitTreeNode) => {
            if (!activeProjectId) {
                return;
            }

            beginFileTreeInlineRename(node);
        },
        [activeProjectId, beginFileTreeInlineRename],
    );

    const handleMoveTreeNode = useCallback(
        async (draggedEntry: GitTreeDragData, destinationNode: GitTreeNode) => {
            if (!activeProjectId) {
                return;
            }

            const nextParentRelativePath = destinationNode.isProjectRoot
                ? null
                : destinationNode.path;
            const currentParentRelativePath = getProjectEntryParentRelativePath(
                draggedEntry.relativePath,
            );
            const destinationProjectTreeNode =
                destinationNode.isProjectRoot || !destinationNode.path
                    ? null
                    : findProjectTreeNodeByPath(
                          activeTreeNodesByParent,
                          destinationNode.path,
                      );
            const shouldExpandDestination =
                Boolean(destinationProjectTreeNode) &&
                !activeExpandedDirectories.includes(destinationNode.path);

            if (currentParentRelativePath === nextParentRelativePath) {
                return;
            }

            try {
                const movedEntry = await renameEntry(
                    activeProjectId,
                    draggedEntry.relativePath,
                    draggedEntry.name,
                    nextParentRelativePath,
                    activeWorktreeId,
                );
                await renameTabsForProjectPath(
                    activeProjectId,
                    activeWorktreeId,
                    draggedEntry.relativePath,
                    movedEntry.relativePath,
                    draggedEntry.kind,
                );
                if (destinationProjectTreeNode && shouldExpandDestination) {
                    await toggleDirectory(
                        activeProjectId,
                        destinationProjectTreeNode,
                        activeWorktreeId,
                    );
                }
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
            activeExpandedDirectories,
            activeWorktreeId,
            activeTreeNodesByParent,
            renameEntry,
            renameTabsForProjectPath,
            toggleDirectory,
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
                activeProjectTree,
                activeTreeNodesByParent,
                activeExpandedDirectories,
            ),
        [activeExpandedDirectories, activeProjectTree, activeTreeNodesByParent],
    );

    const sidebarTreeNodes = useMemo(() => {
        if (!activeProject) {
            return [];
        }

        if (isFilteringFileTree) {
            return fileTreeSearchNodes;
        }

        return [
            {
                children: isProjectRootExpanded ? sidebarFileNodes : undefined,
                hasChildren: activeProjectTree.length > 0,
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
        activeProjectTree.length,
        fileTreeSearchNodes,
        isFilteringFileTree,
        isProjectRootExpanded,
        sidebarFileNodes,
    ]);
    const visibleSidebarNodes = useMemo(
        () =>
            flattenVisibleGitTreeNodes(sidebarTreeNodes).filter(
                (node) => !node.isProjectRoot,
            ),
        [sidebarTreeNodes],
    );
    const visibleSidebarNodePaths = useMemo(
        () => visibleSidebarNodes.map((node) => node.path),
        [visibleSidebarNodes],
    );
    const visibleSidebarNodePathSet = useMemo(
        () => new Set(visibleSidebarNodePaths),
        [visibleSidebarNodePaths],
    );
    const effectiveFileTreeSelection = useMemo(
        () =>
            reconcileFileTreeSelection({
                activeFileTreePath: activeFilePath,
                anchorPath: fileTreeSelectionAnchorPath,
                selectedPaths: fileTreeSelectedPaths,
            }),
        [activeFilePath, fileTreeSelectionAnchorPath, fileTreeSelectedPaths],
    );
    const effectiveFileTreeSelectedPaths =
        effectiveFileTreeSelection.selectedPaths;
    const effectiveFileTreeSelectionAnchorPath =
        effectiveFileTreeSelection.anchorPath;
    const selectedFileTreePathSet = useMemo(
        () => new Set(effectiveFileTreeSelectedPaths),
        [effectiveFileTreeSelectedPaths],
    );
    const visibleSidebarNodesByPath = useMemo(
        () => new Map(visibleSidebarNodes.map((node) => [node.path, node])),
        [visibleSidebarNodes],
    );

    useEffect(() => {
        setFileTreeSelectedPaths((currentPaths) => {
            const nextPaths = currentPaths.filter((path) =>
                visibleSidebarNodePathSet.has(path),
            );
            return nextPaths.length === currentPaths.length
                ? currentPaths
                : nextPaths;
        });
        setFileTreeSelectionAnchorPath((currentPath) =>
            currentPath && visibleSidebarNodePathSet.has(currentPath)
                ? currentPath
                : null,
        );
    }, [visibleSidebarNodePathSet]);

    const handleFileTreeNodeClick = useCallback(
        (node: GitTreeNode, event: ReactMouseEvent<HTMLDivElement>) => {
            const isRangeSelection = event.shiftKey;
            const isToggleSelection = event.metaKey || event.ctrlKey;

            if (isRangeSelection) {
                const anchorPath =
                    effectiveFileTreeSelectionAnchorPath ?? node.path;
                setFileTreeSelectedPaths(
                    selectGitTreeRange(
                        visibleSidebarNodePaths,
                        anchorPath,
                        node.path,
                    ),
                );
                setFileTreeSelectionAnchorPath(anchorPath);
                return;
            }

            if (isToggleSelection) {
                setFileTreeSelectedPaths((currentPaths) =>
                    toggleGitTreePathSelection(currentPaths, node.path),
                );
                setFileTreeSelectionAnchorPath(node.path);
                return;
            }

            setFileTreeSelectedPaths([node.path]);
            setFileTreeSelectionAnchorPath(node.path);

            if (!activeProjectId || node.kind !== "file") {
                return;
            }

            void openFileTab(activeProjectId, node.path, activeWorktreeId);
        },
        [
            activeProjectId,
            activeWorktreeId,
            effectiveFileTreeSelectionAnchorPath,
            openFileTab,
            visibleSidebarNodePaths,
        ],
    );

    const handleFileTreeNodeDragStart = useCallback(
        (node: GitTreeNode, dataTransfer: DataTransfer | null) => {
            if (!dataTransfer) {
                return;
            }

            const dragPaths = resolveGitTreeDragPaths(
                node.path,
                effectiveFileTreeSelectedPaths,
                visibleSidebarNodePaths,
            );
            const dragNodes = dragPaths
                .map((path) => visibleSidebarNodesByPath.get(path))
                .filter((entry): entry is GitTreeNode => Boolean(entry));
            if (dragNodes.length === 0) {
                return;
            }

            setFileTreeSelectedPaths(dragPaths);
            setFileTreeSelectionAnchorPath(node.path);

            const composerEntries = dragNodes.map((entry) => ({
                kind: entry.kind,
                name: entry.name,
                relativePath: entry.path,
            }));

            dataTransfer.clearData();
            dataTransfer.effectAllowed =
                composerEntries.length > 1 ? "copy" : "copyMove";
            dataTransfer.setData(
                COMPOSER_PROJECT_ENTRY_LIST_MIME,
                serializeComposerProjectEntryListDragData({
                    entries: composerEntries,
                }),
            );

            if (composerEntries.length === 1) {
                dataTransfer.setData(
                    COMPOSER_PROJECT_ENTRY_MIME,
                    serializeComposerProjectEntryDragData(composerEntries[0]),
                );
            }

            dataTransfer.setData(
                "text/plain",
                composerEntries.length === 1
                    ? composerEntries[0]?.relativePath ?? ""
                    : composerEntries
                          .map((entry) => entry.relativePath)
                          .join("\n"),
            );
        },
        [
            effectiveFileTreeSelectedPaths,
            visibleSidebarNodePaths,
            visibleSidebarNodesByPath,
        ],
    );

    const { stickyFolders, stickyFolderPaths } = useStickyFolders({
        scrollContainerRef: sidebarScrollRef,
        nodes: isFilteringFileTree ? [] : sidebarTreeNodes,
        expandedPaths: isFilteringFileTree ? [] : activeExpandedDirectories,
        layout: "tree",
    });

    const handleRevealActiveFileInTree = useCallback(async () => {
        if (
            activeWorkspaceTab?.kind !== "file" ||
            !activeWorkspaceTab.projectId
        ) {
            return;
        }

        const targetProjectId = activeWorkspaceTab.projectId;
        const targetWorktreeId = activeWorkspaceTab.worktreeId ?? null;
        const targetPath = activeWorkspaceTab.relativePath;
        const targetProjectContextKey = getProjectContextKey(
            targetProjectId,
            targetWorktreeId,
        );

        setLeftCollapsed(false);
        setSidebarView("files");
        setSidebarOverlayVisible(false);
        setFileTreeFilter("");
        setProjectRootExpandedByContext((currentState) => ({
            ...currentState,
            [targetProjectContextKey]: true,
        }));

        if (activeProjectId !== targetProjectId) {
            await setActiveProject(targetProjectId);
        }

        const currentTargetWorktreeId =
            useGitStore.getState().activeWorktreeIds[targetProjectId] ?? null;

        if (currentTargetWorktreeId !== targetWorktreeId) {
            await setActiveWorktree(targetProjectId, targetWorktreeId);
        }

        await revealPathInTree(targetProjectId, targetPath, targetWorktreeId);
        setFileTreeRevealSignal((currentSignal) =>
            currentSignal === null ? 0 : currentSignal + 1,
        );
    }, [
        activeProjectId,
        activeWorkspaceTab,
        revealPathInTree,
        setActiveProject,
        setActiveWorktree,
        setLeftCollapsed,
        setSidebarView,
    ]);

    const closeQuickOpen = useCallback(() => {
        setIsQuickOpenLoading(false);
        setIsQuickOpenOpen(false);
        setQuickOpenQuery("");
        setQuickOpenSelectedIndex(0);
    }, []);

    const handleQuickOpenSelect = useCallback(
        async (item: ProjectQuickOpenMatch) => {
            if (!activeProjectId) {
                return;
            }

            closeQuickOpen();
            await openFileTab(
                activeProjectId,
                item.relativePath,
                activeWorktreeId,
                undefined,
                workspaceActivePaneId,
            );
        },
        [
            activeProjectId,
            activeWorktreeId,
            closeQuickOpen,
            openFileTab,
            workspaceActivePaneId,
        ],
    );

    const handleQuickOpenInputKeyDown = useCallback(
        (event: ReactKeyboardEvent<HTMLInputElement>) => {
            if (event.key === "Escape") {
                event.preventDefault();
                closeQuickOpen();
                return;
            }

            if (quickOpenResults.length === 0) {
                return;
            }

            if (event.key === "ArrowDown") {
                event.preventDefault();
                setQuickOpenSelectedIndex((currentIndex) =>
                    currentIndex >= quickOpenResults.length - 1
                        ? 0
                        : currentIndex + 1,
                );
                return;
            }

            if (event.key === "ArrowUp") {
                event.preventDefault();
                setQuickOpenSelectedIndex((currentIndex) =>
                    currentIndex <= 0
                        ? quickOpenResults.length - 1
                        : currentIndex - 1,
                );
                return;
            }

            if (event.key === "Home") {
                event.preventDefault();
                setQuickOpenSelectedIndex(0);
                return;
            }

            if (event.key === "End") {
                event.preventDefault();
                setQuickOpenSelectedIndex(quickOpenResults.length - 1);
                return;
            }

            if (event.key === "Enter") {
                event.preventDefault();
                const selectedItem = quickOpenResults[quickOpenSelectedIndex];
                if (selectedItem) {
                    void handleQuickOpenSelect(selectedItem);
                }
            }
        },
        [
            closeQuickOpen,
            handleQuickOpenSelect,
            quickOpenResults,
            quickOpenSelectedIndex,
        ],
    );

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
            if (event.defaultPrevented) {
                return;
            }

            if (!(event.metaKey || event.ctrlKey) || event.altKey) {
                return;
            }

            if (event.shiftKey || event.key.toLowerCase() !== "t") {
                return;
            }

            event.preventDefault();
            setIsQuickOpenOpen(true);
            setQuickOpenQuery("");
            setQuickOpenSelectedIndex(0);
        };

        window.addEventListener("keydown", handleKeyDown, true);
        return () => {
            window.removeEventListener("keydown", handleKeyDown, true);
        };
    }, []);

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
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.defaultPrevented) {
                return;
            }

            if (!(event.metaKey || event.ctrlKey) || event.altKey) {
                return;
            }

            if (event.shiftKey) {
                return;
            }

            if (event.key.toLowerCase() !== "n") {
                return;
            }

            event.preventDefault();
            void handleCreateTreeEntry("file", null);
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [handleCreateTreeEntry]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.defaultPrevented) {
                return;
            }

            if (!(event.metaKey || event.ctrlKey) || event.altKey) {
                return;
            }

            if (!event.shiftKey || event.key.toLowerCase() !== "e") {
                return;
            }

            event.preventDefault();
            void handleRevealActiveFileInTree();
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [handleRevealActiveFileInTree]);

    useEffect(() => {
        if (!isMac) return;
        const visible = !leftCollapsed || sidebarOverlayVisible;
        void window.comando?.setTrafficLightVisibility(visible);
    }, [isMac, leftCollapsed, sidebarOverlayVisible]);

    useEffect(() => {
        const platform = bootstrap?.platform;
        if (!platform) return;
        document.documentElement.setAttribute("data-platform", platform);
        return () => {
            document.documentElement.removeAttribute("data-platform");
        };
    }, [bootstrap?.platform]);

    const sidebarContent = (
        <>
            <div
                className="app-drag relative px-2 pt-2"
                style={isMac ? { paddingTop: 42 } : undefined}
            >
                {isMac && (
                    <button
                        className="sidebar-collapse-toggle app-no-drag"
                        onClick={() => {
                            toggleLeftCollapsed();
                            setSidebarOverlayVisible(false);
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
                            height="16"
                            viewBox="0 0 16 16"
                            width="16"
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
                <div className="mt-1">
                    <SidebarGitScopePicker
                        projectId={activeProjectId}
                        worktreeId={activeWorktreeId}
                    />
                </div>

                <div className="mt-1 flex items-center gap-1">
                    <button
                        className={[
                            "sidebar-action-row sidebar-action-row--compact app-no-drag min-w-0 flex-1",
                            sidebarView === "files"
                                ? "sidebar-action-row--active"
                                : "",
                        ]
                            .filter(Boolean)
                            .join(" ")}
                        onClick={() => {
                            if (sidebarView !== "files") {
                                setSidebarView("files");
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
                            "sidebar-action-row sidebar-action-row--compact app-no-drag min-w-0 flex-1",
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
                                setSidebarView("git");
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

                    <button
                        className={[
                            "sidebar-action-row sidebar-action-row--compact app-no-drag min-w-0 flex-1",
                            sidebarView === "agents"
                                ? "sidebar-action-row--active"
                                : "",
                        ]
                            .filter(Boolean)
                            .join(" ")}
                        onClick={() => {
                            if (sidebarView !== "agents") {
                                setSidebarView("agents");
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
                                d="M3 4.25A1.25 1.25 0 0 1 4.25 3h7.5A1.25 1.25 0 0 1 13 4.25v5.5A1.25 1.25 0 0 1 11.75 11H8.6l-2.2 2.05A.5.5 0 0 1 5.6 12.7V11H4.25A1.25 1.25 0 0 1 3 9.75v-5.5Z"
                                stroke="currentColor"
                                strokeWidth="1.1"
                                fill="currentColor"
                                fillOpacity="0.18"
                            />
                            <circle
                                cx="6"
                                cy="7"
                                r="0.85"
                                fill="currentColor"
                            />
                            <circle
                                cx="10"
                                cy="7"
                                r="0.85"
                                fill="currentColor"
                            />
                        </svg>
                        <span>Agents</span>
                    </button>

                </div>

                <div className="sidebar-search app-no-drag mt-1">
                    <span
                        aria-hidden="true"
                        className="sidebar-search-icon"
                    >
                        <svg
                            fill="none"
                            height="12"
                            viewBox="0 0 16 16"
                            width="12"
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
                    </span>
                    <input
                        aria-label={
                            sidebarView === "files"
                                ? "Filter files"
                                : sidebarView === "git"
                                  ? "Filter changes"
                                  : "Filter threads"
                        }
                        autoCapitalize="off"
                        autoCorrect="off"
                        className="sidebar-search-input"
                        onChange={(event) => {
                            const value = event.target.value;
                            if (sidebarView === "files") {
                                setFileTreeFilter(value);
                            } else if (sidebarView === "git") {
                                setGitChangesFilter(value);
                            } else {
                                setAgentsFilter(value);
                            }
                        }}
                        onKeyDown={(event) => {
                            if (event.key === "Escape") {
                                event.preventDefault();
                                if (sidebarView === "files") {
                                    setFileTreeFilter("");
                                } else if (sidebarView === "git") {
                                    setGitChangesFilter("");
                                } else {
                                    setAgentsFilter("");
                                }
                            }
                        }}
                        placeholder={
                            sidebarView === "files"
                                ? "Filter files..."
                                : sidebarView === "git"
                                  ? "Filter changes..."
                                  : "Filter threads..."
                        }
                        spellCheck={false}
                        type="text"
                        value={
                            sidebarView === "files"
                                ? fileTreeFilter
                                : sidebarView === "git"
                                  ? gitChangesFilter
                                  : agentsFilter
                        }
                    />
                    {(sidebarView === "files"
                        ? fileTreeFilter
                        : sidebarView === "git"
                          ? gitChangesFilter
                          : agentsFilter
                    ).length > 0 ? (
                        <button
                            aria-label="Clear filter"
                            className="sidebar-search-clear"
                            onClick={() => {
                                if (sidebarView === "files") {
                                    setFileTreeFilter("");
                                } else if (sidebarView === "git") {
                                    setGitChangesFilter("");
                                } else {
                                    setAgentsFilter("");
                                }
                            }}
                            title="Clear filter"
                            type="button"
                        >
                            ×
                        </button>
                    ) : null}
                </div>

                {projectsError ? (
                    <div className="mt-2 rounded-md bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-600">
                        {projectsError}
                    </div>
                ) : null}
            </div>

            {sidebarView === "git" && activeProjectId ? (
                <SidebarGitPanel
                    filter={gitChangesFilter}
                    projectId={activeProjectId}
                    worktreeId={activeWorktreeId}
                />
            ) : sidebarView === "agents" ? (
                <SidebarAgentsPanel
                    filter={agentsFilter}
                    projectId={activeProjectId}
                    worktreeId={activeWorktreeId}
                />
            ) : (
                <>
                    <div
                        ref={sidebarScrollRef}
                        className="shell-scrollbar flex-1 overflow-y-auto px-2 py-2"
                        onClick={(event) => {
                            if (
                                event.target instanceof HTMLElement &&
                                event.target.closest(".git-tree-row")
                            ) {
                                return;
                            }

                            clearFileTreeSelection();
                        }}
                    >
                        {activeProject ? (
                            <>
                                {!isFilteringFileTree ? (
                                    <StickyFolderOverlay
                                        stickyFolders={stickyFolders}
                                        enableNodeDrag
                                        onNodeClick={handleFileTreeNodeClick}
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
                                            if (!activeProjectId) return;
                                            const treeNode =
                                                findProjectTreeNodeByPath(
                                                    activeTreeNodesByParent,
                                                    node.path,
                                                );
                                            if (!treeNode) return;
                                            void toggleDirectory(
                                                activeProjectId,
                                                treeNode,
                                                activeWorktreeId,
                                            );
                                        }}
                                        onNodeDragStart={
                                            handleFileTreeNodeDragStart
                                        }
                                        onNodeDrop={(
                                            dragData,
                                            destinationNode,
                                        ) => {
                                            void handleMoveTreeNode(
                                                dragData,
                                                destinationNode,
                                            );
                                        }}
                                        selectedPaths={selectedFileTreePathSet}
                                    />
                                ) : null}
                                <GitTreeView
                                    activePath={activeFilePath}
                                    editingDraftName={
                                        fileTreeInlineEditor?.draftName ?? null
                                    }
                                    editingPath={
                                        fileTreeInlineEditor?.path ?? null
                                    }
                                    enableNodeDrag
                                    emptyState={
                                        isFilteringFileTree
                                            ? isFileTreeSearchLoading
                                                ? "Searching project files..."
                                                : "No matching files or folders."
                                            : undefined
                                    }
                                    expandedPaths={
                                        isFilteringFileTree
                                            ? []
                                            : activeExpandedDirectories
                                    }
                                    layout={
                                        isFilteringFileTree ? "list" : "tree"
                                    }
                                    nodes={sidebarTreeNodes}
                                    onEditingCancel={cancelFileTreeInlineEditor}
                                    onEditingDraftNameChange={(value) => {
                                        setFileTreeInlineEditor((current) =>
                                            current
                                                ? {
                                                      ...current,
                                                      draftName: value,
                                                  }
                                                : null,
                                        );
                                    }}
                                    onEditingSubmit={() => {
                                        void submitFileTreeInlineEditor();
                                    }}
                                    stickyFolderPaths={stickyFolderPaths}
                                    selectedPaths={selectedFileTreePathSet}
                                    scrollToActivePathSignal={
                                        fileTreeRevealSignal ?? undefined
                                    }
                                    onNodeClick={handleFileTreeNodeClick}
                                    onNodeContextMenu={(node, { x, y }) =>
                                        {
                                            if (
                                                !selectedFileTreePathSet.has(
                                                    node.path,
                                                )
                                            ) {
                                                setFileTreeSelectedPaths([
                                                    node.path,
                                                ]);
                                                setFileTreeSelectionAnchorPath(
                                                    node.path,
                                                );
                                            }

                                            setFileTreeContextMenu({
                                                x,
                                                y,
                                                payload: {
                                                    kind: "node",
                                                    node,
                                                },
                                            });
                                        }
                                    }
                                    onNodeDragStart={handleFileTreeNodeDragStart}
                                    onNodeDrop={(dragData, destinationNode) => {
                                        void handleMoveTreeNode(
                                            dragData,
                                            destinationNode,
                                        );
                                    }}
                                    onToggleDirectory={
                                        isFilteringFileTree
                                            ? undefined
                                            : (node) => {
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
                                                          activeTreeNodesByParent,
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
                                              }
                                    }
                                    showStatusIndicator={false}
                                />
                            </>
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
        <div
            className="min-h-screen text-text-primary"
            data-platform={bootstrap?.platform ?? undefined}
        >
            <div className="relative h-screen">
                <div className="flex h-full flex-col overflow-hidden">
                    {isWindows && <WindowsTopBar title="Comando" />}
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
                            className="app-sidebar flex min-h-0 flex-col"
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
                                onRequestCreateFile={() => {
                                    void handleCreateTreeEntry("file", null);
                                }}
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

                {leftCollapsed && sidebarOverlayVisible && (
                    <div
                        className="flex min-h-0 flex-col bg-bg-panel"
                        style={{
                            position: "absolute",
                            left: 0,
                            top: 0,
                            bottom: 0,
                            width: leftWidth,
                            zIndex: 10,
                            boxShadow: "var(--shadow-soft)",
                            borderRight: "1px solid var(--color-border)",
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

            <QuickOpenFilePalette
                loading={isQuickOpenLoading}
                onChangeQuery={setQuickOpenQuery}
                onClose={closeQuickOpen}
                onHoverIndex={setQuickOpenSelectedIndex}
                onInputKeyDown={handleQuickOpenInputKeyDown}
                onSelect={(item) => {
                    void handleQuickOpenSelect(item);
                }}
                open={isQuickOpenOpen}
                projectName={activeProject?.name ?? null}
                query={quickOpenQuery}
                results={quickOpenResults}
                selectedIndex={quickOpenSelectedIndex}
            />
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
