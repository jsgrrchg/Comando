import {
    lazy,
    Suspense,
    useCallback,
    useEffect,
    useEffectEvent,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type KeyboardEvent as ReactKeyboardEvent,
    type PointerEvent as ReactPointerEvent,
    type SetStateAction,
} from "react";
import { createPortal } from "react-dom";

import type {
    AppUpdateState,
    ComandoApi,
    GitRepositorySnapshot,
    PersistenceSnapshot,
    ProjectSummary,
    ProjectTreeNode,
    SettingsWindowCategory,
    SettingsSnapshot,
    WorkspaceSurfaceActionRequest,
    WorkspaceSurfaceFileRevealRequest,
    WorkspaceInspectorView,
} from "@shared/ipc";
import { resolveEditorLanguage } from "@shared/editor-language";

import { useSystemTheme } from "./app/hooks/use-system-theme";
import { writeClipboardText } from "./app/utils/clipboard";
import { joinProjectPath } from "./app/utils/projectPath";
import { setCachedAppEditorSettings } from "./app/settings/client";
import {
    buildGitTreeNodesFromProjectTree,
    buildHierarchicalGitTreeNodesFromProjectEntries,
    findProjectTreeNodeByPath,
} from "./app/projects/git-tree";
import { createGitProjectRefreshScheduler } from "./app/git/refresh-scheduler";
import {
    areGitWorktreeIdsEquivalent,
    getGitContextKey,
    resolveCommittedProjectWorktreeId,
} from "./app/git/context-key";
import {
    reconcileFileTreeSelection,
    resolveActiveFileTreePath,
    resolveFileTreeNodeClickSelection,
} from "./app/projects/file-tree-selection";
import {
    buildFileTreeMoveDestinations,
    findNextFileTreeMoveDestinationIndex,
    getFileTreeMoveValidationMessage,
    resolveFileTreeMovePickerSelectedIndex,
    type FileTreeMoveDestination,
} from "./app/projects/file-tree-move-destinations";
import { filterProjectEntriesForTreeFilter } from "./app/projects/tree-filter";
import { filterProjectEntriesInWorker } from "./app/projects/tree-filter-worker-client";
import { getProjectContextKey } from "./app/projects/context-key";
import {
    resolveWorkspaceContextRefreshPlan,
    runDeduplicatedContextRefresh,
} from "./app/workspace/context-activation-refresh";
import {
    getShellGridTemplateColumns,
    getOpenShellDrawerSide,
    getShellPanelWidthRange,
    getShellSurfaceSideInsets,
    scaleShellSurfaceInsets,
    shouldHideWorkspaceSurfaceForHostOverlay,
    shellLayoutConstraints,
    type ShellPanelSide,
} from "./app/layout/shell-layout";
import {
    COMPOSER_PROJECT_FILE_ENTRY_LIST_MIME,
    COMPOSER_PROJECT_ENTRY_LIST_MIME,
    COMPOSER_PROJECT_ENTRY_MIME,
    serializeComposerProjectEntryListDragData,
    serializeComposerProjectEntryDragData,
} from "./app/drag-and-drop";
import {
    hasPrimaryPointerButton,
    isPrimaryPointerButton,
} from "./app/pointerGuards";
import { useAppStore } from "./app/store/app-store";
import { useAiStore } from "./app/store/ai-store";
import { useGitStore } from "./app/store/git-store";
import { useGitHubStore } from "./app/store/github-store";
import { useProjectsStore } from "./app/store/projects-store";
import { useSettingsStore } from "./app/store/settings-store";
import {
    createPersistedShellState,
    useShellStore,
} from "./app/store/shell-store";
import {
    refreshDurableWorkspaceCatalog,
    workspaceCatalogStore,
} from "./app/store/workspace-catalog-store";
import { useWorkspaceNavigatorModel } from "./app/workspace-navigator/use-workspace-navigator-model";
import {
    flushWorkspacePersistenceNow,
    useWorkspaceStore,
} from "./app/store/workspace-store";
import { findPaneById, type RuntimeWorkspaceTab } from "./app/workspace/tree";
import {
    compactGitTreeEntriesByAncestor,
    compactGitTreeEntriesForDeletion,
    compactGitTreeDragEntriesByAncestor,
    flattenVisibleGitTreeNodes,
    getProjectEntryMoveValidation,
    resolveGitTreeDragPaths,
    type GitTreeDragData,
    type GitTreeDragPayload,
    type GitTreeNode,
    type GitTreeNodeActivationEvent,
} from "./components/git";
import { useStickyFolders } from "./components/git/useStickyFolders";
import { FolderTypeIcon } from "./components/icons/FolderTypeIcon";
import {
    ContextMenu,
    type ContextMenuEntry,
    type ContextMenuState,
} from "./components/context-menu/ContextMenu";
import { requestNativeContextMenuAction } from "./components/context-menu/nativeContextMenu";
import {
    SidebarAgentsPanel,
    SidebarGitHubPanel,
    SidebarGitPanel,
} from "./components/sidebar";
import {
    SIDEBAR_AGENT_DRAG_EVENT,
    type SidebarAgentDragDetail,
} from "./components/sidebar/sidebarAgentDragEvents";
import {
    SIDEBAR_GITHUB_DRAG_EVENT,
    type SidebarGitHubDragDetail,
} from "./components/sidebar/sidebarGitHubDragEvents";
import {
    useRestorableSidebarScroll,
    type SidebarScrollPositionStore,
} from "./components/sidebar/useRestorableSidebarScroll";
import { SplitHandle } from "./components/SplitHandle";
import { ShellDrawer } from "./components/ShellDrawer";
import {
    createWorkspaceQuickDirectory,
    createWorkspaceQuickFile,
} from "./components/workspace/quick-create";
import type { WorkspacePaneRecentProject } from "./components/workspace/WorkspacePaneEmptyState";
import {
    closeWorkspaceTabsWithConfirmation,
} from "./components/workspace/workspaceCloseGuard";
import { DesktopWindowChrome } from "./components/DesktopWindowChrome";
import { WorkspaceSwitcher } from "./components/WorkspaceSwitcher";
import { SidebarGitScopePicker } from "./components/sidebar/SidebarGitScopePicker";
import { WorkspaceNavigatorPanel } from "./components/workspace-navigator/WorkspaceNavigatorPanel";
import {
    FileExplorerPanel,
    WorkspaceInspector,
    type FileExplorerInlineEditorState,
} from "./components/workspace-inspector";
import { useModalFocusScope } from "./components/accessibility/useModalFocusScope";

const EmbeddedSettingsApp = lazy(async () => {
    const module = await import("./SettingsApp");
    return { default: module.SettingsApp };
});
const LegacyWorkspaceView = lazy(async () => {
    const module = await import("./components/workspace/WorkspaceView");
    return { default: module.WorkspaceView };
});
const LegacyWorkspaceTerminalHost = lazy(async () => {
    const module = await import("./features/terminal/WorkspaceTerminalHost");
    return { default: module.WorkspaceTerminalHost };
});

type DragState = {
    readonly side: ShellPanelSide;
    readonly startWidth: number;
    readonly startX: number;
} | null;

const ROOT_NODE_KEY = "__root__";
const PROJECT_SEARCH_FOLLOWUP_DEBOUNCE_MS = 50;
const WORKSPACE_RECENT_PROJECTS_LIMIT = 6;
const rendererWindowMode = new URLSearchParams(window.location.search).get(
    "window",
);
const isWorkspaceHostRenderer = rendererWindowMode === "workspace-host";

type FileTreeContextMenuPayload =
    | {
          readonly kind: "background";
      }
    | {
          readonly kind: "node";
          readonly node: GitTreeNode;
          readonly transientSelectionPath: string | null;
      };

interface FileTreeClipboardEntry {
    readonly kind: "directory" | "file";
    readonly name: string;
    readonly path: string;
}

interface FileTreeClipboardState {
    readonly entries: readonly FileTreeClipboardEntry[];
    readonly operation: "copy";
    readonly projectId: string;
    readonly worktreeId: string | null;
}

function getProjectSearchDelayMs(query: string): number {
    return query.trim().length <= 1 ? 0 : PROJECT_SEARCH_FOLLOWUP_DEBOUNCE_MS;
}

type FileTreeFilterSource =
    | {
          readonly contextKey: string;
          readonly kind: "full";
      }
    | {
          readonly contextKey: string;
          readonly kind: "backend";
      };

function scheduleEffectStateUpdate(update: () => void): () => void {
    let cancelled = false;
    queueMicrotask(() => {
        if (!cancelled) {
            update();
        }
    });

    return () => {
        cancelled = true;
    };
}

function resolveStateAction<T>(action: SetStateAction<T>, current: T): T {
    return typeof action === "function"
        ? (action as (value: T) => T)(current)
        : action;
}

function selectActiveWorkspaceTab(
    state: ReturnType<typeof useWorkspaceStore.getState>,
): RuntimeWorkspaceTab | null {
    const activePane = findPaneById(state.rootNode, state.activePaneId);
    if (!activePane?.activeTabId) {
        return null;
    }

    return state.tabsById[activePane.activeTabId] ?? null;
}

export function WorkspaceHostApp() {
    useSystemTheme();

    const bootstrap = useAppStore((state) => state.bootstrap);
    const bootstrapError = useAppStore((state) => state.error);
    const hydrateBootstrap = useAppStore((state) => state.hydrate);

    const persistedActiveProjectId = useProjectsStore(
        (state) => state.activeProjectId,
    );
    const workspaceActiveContextKey = useWorkspaceStore(
        (state) => state.activeContextKey,
    );
    const workspaceNavigationHydrated = useWorkspaceStore(
        (state) => state.hydrated,
    );
    const workspaceContextsByKey = useWorkspaceStore(
        (state) => state.contextsByKey,
    );
    const workspaceSurfaceTopologyKey = useMemo(
        () =>
            JSON.stringify(
                Object.values(workspaceContextsByKey)
                    .map((context) => [
                        context.key,
                        context.projectId,
                        context.worktreeId,
                    ])
                    .sort(([left], [right]) =>
                        String(left).localeCompare(String(right)),
                    ),
            ),
        [workspaceContextsByKey],
    );
    const activeWorkspaceContext = useWorkspaceStore((state) =>
        state.activeContextKey
            ? (state.contextsByKey[state.activeContextKey] ?? null)
            : null,
    );
    const activeProjectId =
        activeWorkspaceContext?.projectId ??
        (workspaceNavigationHydrated ? null : persistedActiveProjectId);
    const [workspaceSurfaceActionError, setWorkspaceSurfaceActionError] =
        useState<string | null>(null);
    const workspaceSurfaceActionErrorTimerRef = useRef<number | null>(null);
    const workspaceSurfaceDragBindingRef = useRef<{
        readonly contextKey: string;
        readonly projectId: string;
        readonly worktreeId: string | null;
    } | null>(null);
    const reportWorkspaceSurfaceActionError = useCallback((message: string) => {
        if (workspaceSurfaceActionErrorTimerRef.current !== null) {
            window.clearTimeout(workspaceSurfaceActionErrorTimerRef.current);
        }
        setWorkspaceSurfaceActionError(message);
        workspaceSurfaceActionErrorTimerRef.current = window.setTimeout(() => {
            workspaceSurfaceActionErrorTimerRef.current = null;
            setWorkspaceSurfaceActionError(null);
        }, 6_000);
    }, []);
    useEffect(
        () => () => {
            if (workspaceSurfaceActionErrorTimerRef.current !== null) {
                window.clearTimeout(workspaceSurfaceActionErrorTimerRef.current);
            }
        },
        [],
    );
    const dispatchWorkspaceSurfaceAction = useCallback(
        async (request: WorkspaceSurfaceActionRequest): Promise<void> => {
            const api = getComandoApi();
            if (!api) {
                throw new Error("The desktop bridge is unavailable.");
            }
            const result = await api.dispatchWorkspaceSurfaceAction(request);
            if (!result.delivered) {
                throw new Error(
                    `The workspace action could not be delivered (${result.reason}).`,
                );
            }
        },
        [],
    );
    const requestWorkspaceSurfaceAction = useCallback(
        (request: WorkspaceSurfaceActionRequest) => {
            void dispatchWorkspaceSurfaceAction(request).catch((error) => {
                console.error("[workspace-host] action delivery failed", error);
                reportWorkspaceSurfaceActionError(
                    error instanceof Error
                        ? error.message
                        : "The workspace action could not be delivered.",
                );
            });
        },
        [dispatchWorkspaceSurfaceAction, reportWorkspaceSurfaceActionError],
    );
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
    const copyEntries = useProjectsStore((state) => state.copyEntries);
    const copyExternalEntries = useProjectsStore(
        (state) => state.copyExternalEntries,
    );
    const deleteEntry = useProjectsStore((state) => state.deleteEntry);
    const trashEntry = useProjectsStore((state) => state.trashEntry);
    const openEntryExternally = useProjectsStore(
        (state) => state.openEntryExternally,
    );
    const renameEntry = useProjectsStore((state) => state.renameEntry);
    const revealEntry = useProjectsStore((state) => state.revealEntry);
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
    const gitSnapshots = useGitStore((state) => state.snapshots);
    const gitWorktreesByProject = useGitStore(
        (state) => state.worktreesByProject,
    );
    const setActiveWorktree = useGitStore((state) => state.setActiveWorktree);
    const selectGitBranch = useGitStore((state) => state.selectBranch);

    useEffect(() => {
        if (!isWorkspaceHostRenderer || !workspaceNavigationHydrated) {
            return;
        }
        workspaceCatalogStore
            .getState()
            .mergeRegistry(projects, gitWorktreesByProject);
    }, [gitWorktreesByProject, projects, workspaceNavigationHydrated]);

    useEffect(() => {
        if (!isWorkspaceHostRenderer || !workspaceNavigationHydrated) {
            return;
        }
        const api = getComandoApi();
        if (!api) {
            return;
        }
        let cancelled = false;
        void refreshDurableWorkspaceCatalog(api)
            .then(() => {
                if (!cancelled) {
                    workspaceCatalogStore
                        .getState()
                        .mergeRegistry(
                            useProjectsStore.getState().projects,
                            useGitStore.getState().worktreesByProject,
                        );
                }
            })
            .catch(() => {
                if (cancelled) {
                    return;
                }
                // Registered projects remain navigable while durable catalog
                // recovery is retried independently.
                workspaceCatalogStore
                    .getState()
                    .mergeRegistry(
                        useProjectsStore.getState().projects,
                        useGitStore.getState().worktreesByProject,
                    );
            });
        const unsubscribe = api.onWorkspaceSurfacePoolChanged(
            (diagnostics) => {
                workspaceCatalogStore
                    .getState()
                    .setSurfaceDiagnostics(diagnostics);
            },
        );
        return () => {
            cancelled = true;
            unsubscribe();
        };
    }, [workspaceNavigationHydrated]);

    void loadingNodeKeys;
    void removeProject;
    void createEntry;

    const workspaceHydrate = useWorkspaceStore((state) => state.hydrate);
    const createChatTab = useWorkspaceStore((state) => state.createChatTab);
    const openFileTab = useWorkspaceStore((state) => state.openFileTab);
    const closeTabsForProjectPaths = useWorkspaceStore(
        (state) => state.closeTabsForProjectPaths,
    );
    const removeProjectTabs = useWorkspaceStore(
        (state) => state.removeProjectTabs,
    );
    const closeWorkspaceTab = useWorkspaceStore((state) => state.closeTab);
    const requestCloseWorkspaceTab = useCallback(
        (tabId: string) =>
            closeWorkspaceTabsWithConfirmation([tabId], () =>
                closeWorkspaceTab(tabId),
            ),
        [closeWorkspaceTab],
    );
    const requestCloseWorkspaceSurface = useCallback(
        async (contextKey: string) => {
            const comandoApi = getComandoApi();
            if (!comandoApi) {
                throw new Error("The desktop bridge is unavailable.");
            }
            const result = await comandoApi.closeWorkspaceSurface(contextKey);
            if (result.status === "blocked") {
                throw new Error(
                    result.leases.map((lease) => lease.message).join(" "),
                );
            }
            if (result.status === "failed") {
                throw new Error(result.message);
            }
        },
        [],
    );
    const requestCloseActiveWorkspaceTab = useEffectEvent(() => {
        const workspaceState = useWorkspaceStore.getState();
        const activePane = findPaneById(
            workspaceState.rootNode,
            workspaceState.activePaneId,
        );
        const activeTabId = activePane?.activeTabId ?? null;
        if (!activeTabId) {
            return;
        }

        void requestCloseWorkspaceTab(activeTabId);
    });
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
    const workspaceError = useWorkspaceStore((state) => state.error);
    const activeWorkspaceTab = useWorkspaceStore(selectActiveWorkspaceTab);

    const activeSurface = useShellStore((state) => state.activeSurface);
    const focusSurface = useShellStore((state) => state.focusSurface);
    const expandedProjectIds = useShellStore(
        (state) => state.expandedProjectIds,
    );
    const hydrateShell = useShellStore((state) => state.hydrate);
    const leftCollapsedPreference = useShellStore(
        (state) => state.leftCollapsed,
    );
    const leftWidth = useShellStore((state) => state.leftWidth);
    const leftEffectiveWidth = useShellStore(
        (state) => state.responsive.left.width,
    );
    const nudgePanel = useShellStore((state) => state.nudgePanel);
    const preferredDrawer = useShellStore((state) => state.preferredDrawer);
    const projectOrder = useShellStore((state) => state.projectOrder);
    const resizePanel = useShellStore((state) => state.resizePanel);
    const rightCollapsed = useShellStore((state) => state.rightCollapsed);
    const rightWidth = useShellStore((state) => state.rightWidth);
    const rightEffectiveWidth = useShellStore(
        (state) => state.responsive.right.width,
    );
    const shellResponsive = useShellStore((state) => state.responsive);
    const shellViewportWidth = useShellStore((state) => state.viewportWidth);
    const setResizingPanel = useShellStore((state) => state.setResizingPanel);
    const setLeftCollapsed = useShellStore((state) => state.setLeftCollapsed);
    const setRightCollapsed = useShellStore(
        (state) => state.setRightCollapsed,
    );
    const setSidebarView = useShellStore(
        (state) => state.setRightInspectorView,
    );
    const sidebarView = useShellStore((state) => state.rightInspectorView);
    const syncViewport = useShellStore((state) => state.syncViewport);
    const toggleLeftCollapsed = useShellStore(
        (state) => state.toggleLeftCollapsed,
    );
    const toggleRightCollapsed = useShellStore(
        (state) => state.toggleRightCollapsed,
    );
    const applyAiRuntimeStatus = useAiStore(
        (state) => state.applyRuntimeStatus,
    );
    const applyAiSessionEvent = useAiStore((state) => state.applySessionEvent);
    const applyAiPromptQueueSnapshot = useAiStore(
        (state) => state.applyPromptQueueSnapshot,
    );
    const applyAiSessionUpdate = useAiStore(
        (state) => state.applySessionUpdate,
    );
    const addDraftFileContext = useAiStore(
        (state) => state.addDraftFileContext,
    );
    const hydrateAiSettings = useAiStore((state) => state.hydrateSettings);
    const stickyFoldersEnabled = useSettingsStore(
        (state) => state.appearance.stickyFoldersEnabled,
    );
    const workspaceNavigatorModel = useWorkspaceNavigatorModel();
    const activateWorkspaceFromCatalog = useCallback(
        async (scopeKey: string) => {
            const workspace = workspaceNavigatorModel.projects
                .flatMap((project) => project.workspaces)
                .find((candidate) => candidate.scopeKey === scopeKey);
            const comandoApi = getComandoApi();
            if (!workspace || !comandoApi) {
                throw new Error("This workspace is no longer available.");
            }
            const contextKey = await useWorkspaceStore
                .getState()
                .registerWorkspaceScope(workspace.projectId, workspace.worktreeId);
            await comandoApi.initializeWorkspaceSurfaces(
                useWorkspaceStore.getState().getWorkspaceSurfaceRegistry(),
            );
            const result = await comandoApi.activateWorkspaceSurface(contextKey);
            if (result.status === "failed") {
                throw new Error(result.message);
            }
            if (result.status === "stale") {
                throw new Error(
                    "A newer workspace selection replaced this request.",
                );
            }
        },
        [workspaceNavigatorModel.projects],
    );
    const navigateWorkspace = useCallback(
        (direction: "next" | "previous") => {
            const scopeKeys = workspaceNavigatorModel.projects.flatMap(
                (project) =>
                    project.workspaces
                        .filter((workspace) => !workspace.isMissing)
                        .map((workspace) => workspace.scopeKey),
            );
            if (scopeKeys.length < 2) {
                return;
            }
            const activeIndex = scopeKeys.indexOf(
                workspaceNavigatorModel.activeScopeKey ?? "",
            );
            if (activeIndex < 0) {
                return;
            }
            const targetIndex =
                direction === "next"
                    ? (activeIndex + 1) % scopeKeys.length
                    : (activeIndex - 1 + scopeKeys.length) % scopeKeys.length;
            const scopeKey = scopeKeys[targetIndex];
            if (scopeKey) {
                void activateWorkspaceFromCatalog(scopeKey);
            }
        },
        [activateWorkspaceFromCatalog, workspaceNavigatorModel],
    );
    const appZoomFactor = useSettingsStore(
        (state) => state.appearance.zoomFactor,
    );
    const runtimeCatalog = useSettingsStore((state) => state.runtimeCatalog);

    const [dragState, setDragState] = useState<DragState>(null);
    const [fileTreeContextMenu, setFileTreeContextMenu] =
        useState<ContextMenuState<FileTreeContextMenuPayload> | null>(null);
    const activeNativeFileTreeMenuRef =
        useRef<ContextMenuState<FileTreeContextMenuPayload> | null>(null);
    const [isFileTreeSearchOpen, setIsFileTreeSearchOpen] = useState(false);
    const [projectRootExpandedByContext, setProjectRootExpandedByContext] =
        useState<Record<string, boolean>>({});
    const [fileTreeEntryIndexByContext, setFileTreeEntryIndexByContext] =
        useState<Record<string, readonly ProjectTreeNode[]>>({});
    const [fileTreeBackendSearchResults, setFileTreeBackendSearchResults] =
        useState<readonly ProjectTreeNode[]>([]);
    const [fileTreeInlineEditor, setFileTreeInlineEditor] =
        useState<FileExplorerInlineEditorState | null>(null);
    const [fileTreeClipboard, setFileTreeClipboard] =
        useState<FileTreeClipboardState | null>(null);
    const [fileTreeMovePickerEntries, setFileTreeMovePickerEntries] = useState<
        readonly GitTreeDragData[] | null
    >(null);
    const [fileTreeMovePickerQuery, setFileTreeMovePickerQuery] = useState("");
    const [fileTreeMovePickerSelectedIndex, setFileTreeMovePickerSelectedIndex] =
        useState(0);
    const [persistenceReady, setPersistenceReady] = useState(false);
    const [workspaceSwitcherOpen, setWorkspaceSwitcherOpen] = useState(false);
    const [settingsView, setSettingsView] = useState<{
        readonly initialCategory?: SettingsWindowCategory;
        readonly projectId: string | null;
        readonly requestId: number;
    } | null>(null);
    const pendingContextTreeRefreshesRef = useRef(
        new Map<string, Promise<void>>(),
    );
    const pendingContextGitRefreshesRef = useRef(
        new Map<string, Promise<GitRepositorySnapshot | null>>(),
    );
    const [inspectorFiltersByScope, setInspectorFiltersByScope] = useState<
        Record<string, Partial<Record<WorkspaceInspectorView, string>>>
    >({});
    const [
        gitHubSidebarSelectionResetSignal,
        setGitHubSidebarSelectionResetSignal,
    ] = useState(0);
    const [
        fileTreeContextTargetResetSignal,
        setFileTreeContextTargetResetSignal,
    ] = useState(0);
    const [fileTreeSelectionByScope, setFileTreeSelectionByScope] = useState<
        Record<
            string,
            {
                readonly anchorPath: string | null;
                readonly selectedPaths: readonly string[];
                readonly suppressed: boolean;
            }
        >
    >({});
    const [fileTreeRevealSignal, setFileTreeRevealSignal] = useState<
        number | null
    >(null);
    const fileTreeSearchInputRef = useRef<HTMLInputElement | null>(null);
    const fileTreeInlineSubmitPendingRef = useRef(false);
    const fileTreeEntryIndexGenerationsRef = useRef(new Map<string, number>());
    const fileTreeEntryIndexRequestsRef = useRef(new Map<string, number>());
    // Mirror of the loaded index, readable from the (async) invalidation handler
    // without capturing a stale closure over the state value.
    const fileTreeEntryIndexByContextRef = useRef(fileTreeEntryIndexByContext);
    useEffect(() => {
        fileTreeEntryIndexByContextRef.current = fileTreeEntryIndexByContext;
    }, [fileTreeEntryIndexByContext]);
    // Loads (or revalidates) the full project file index for a context, keeping
    // the previous entries visible until the fresh ones arrive (no blanking).
    const loadFileTreeEntryIndex = useCallback(
        (projectId: string, worktreeId: string | null) => {
            const comandoApi = getComandoApi();
            const listProjectEntries = (
                comandoApi as {
                    readonly listProjectEntries?: ComandoApi["listProjectEntries"];
                } | null
            )?.listProjectEntries;
            if (!listProjectEntries) {
                return;
            }

            const contextKey = getProjectContextKey(projectId, worktreeId);
            const generation =
                fileTreeEntryIndexGenerationsRef.current.get(contextKey) ?? 0;
            // Dedupe a single in-flight request per (context, generation).
            if (
                fileTreeEntryIndexRequestsRef.current.get(contextKey) ===
                generation
            ) {
                return;
            }
            fileTreeEntryIndexRequestsRef.current.set(contextKey, generation);

            void listProjectEntries({ projectId, worktreeId })
                .then((entries) => {
                    if (
                        fileTreeEntryIndexGenerationsRef.current.get(
                            contextKey,
                        ) !== generation
                    ) {
                        return; // stale response from a superseded generation
                    }
                    // Overwrite atomically (even if already present) so a
                    // revalidation swaps the index without a blank gap.
                    setFileTreeEntryIndexByContext((currentState) => ({
                        ...currentState,
                        [contextKey]: entries,
                    }));
                })
                .catch(() => {
                    // Keep the existing index usable; a later mount or
                    // invalidation retries.
                })
                .finally(() => {
                    if (
                        fileTreeEntryIndexRequestsRef.current.get(contextKey) ===
                        generation
                    ) {
                        fileTreeEntryIndexRequestsRef.current.delete(contextKey);
                    }
                });
        },
        [setFileTreeEntryIndexByContext],
    );
    const fileTreeBackendSearchRequestRef = useRef(0);
    const sidebarScrollRef = useRef<HTMLDivElement | null>(null);
    const sidebarScrollPositionsRef = useRef<SidebarScrollPositionStore>(
        new Map(),
    );
    const workspaceHostTitleBarRef = useRef<HTMLDivElement | null>(null);
    const navigatorToggleRef = useRef<HTMLButtonElement | null>(null);
    const inspectorToggleRef = useRef<HTMLButtonElement | null>(null);
    const openShellDrawerSide = getOpenShellDrawerSide(shellResponsive);
    const presentedShellDrawerSide = workspaceSwitcherOpen
        ? null
        : openShellDrawerSide;
    const hostOverlayVisible = shouldHideWorkspaceSurfaceForHostOverlay({
        responsive: shellResponsive,
        settingsOpen: settingsView !== null,
        workspaceSwitcherOpen,
    });

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
        if (!isWorkspaceHostRenderer || !workspaceNavigationHydrated) {
            return;
        }
        const comandoApi = getComandoApi();
        if (!comandoApi) {
            return;
        }
        void comandoApi.initializeWorkspaceSurfaces(
            useWorkspaceStore.getState().getWorkspaceSurfaceRegistry(),
        );
    }, [
        workspaceActiveContextKey,
        workspaceNavigationHydrated,
        workspaceSurfaceTopologyKey,
    ]);

    useEffect(() => {
        if (!isWorkspaceHostRenderer) {
            return;
        }
        const comandoApi = getComandoApi();
        if (!comandoApi) {
            return;
        }
        return comandoApi.onWorkspaceSurfaceNavigationChanged((navigation) => {
            useWorkspaceStore.getState().applyWorkspaceSurfaceNavigation(navigation);
        });
    }, []);

    useEffect(() => {
        if (!isWorkspaceHostRenderer) {
            return;
        }
        const api = getComandoApi();
        return api?.onWorkspaceScopeActivationRequested((input) => {
            void (async () => {
                const store = useWorkspaceStore.getState();
                const contextKey = await store.registerWorkspaceScope(
                    input.projectId,
                    input.worktreeId,
                );
                if (input.emptyLayout) {
                    await store.requestWorkspaceNavigation(
                        input.projectId,
                        input.worktreeId,
                        { emptyLayout: true },
                    );
                }
                await api.initializeWorkspaceSurfaces(
                    useWorkspaceStore.getState().getWorkspaceSurfaceRegistry(),
                );
                const result = await api.activateWorkspaceSurface(contextKey);
                if (result.status === "failed") {
                    throw new Error(result.message);
                }
            })().catch((error) => {
                console.error(
                    "[workspace-host] requested activation failed",
                    error,
                );
            });
        });
    }, []);

    useEffect(() => {
        if (!isWorkspaceHostRenderer) {
            return;
        }
        return getComandoApi()?.onWorkspaceSurfaceActionStatus((status) => {
            if (status.status === "completed") {
                return;
            }
            reportWorkspaceSurfaceActionError(
                status.message ?? "The workspace action could not be completed.",
            );
        });
    }, [reportWorkspaceSurfaceActionError]);

    useEffect(() => {
        if (!isWorkspaceHostRenderer) {
            return;
        }
        const comandoApi = getComandoApi();
        if (!comandoApi) {
            return;
        }
        const forwardDrag = (
            kind: "agent" | "github",
            event: CustomEvent<
                SidebarAgentDragDetail | SidebarGitHubDragDetail
            >,
        ) => {
            const workspaceState = useWorkspaceStore.getState();
            if (event.detail.phase === "start") {
                const contextKey = workspaceState.activeContextKey;
                const context = contextKey
                    ? workspaceState.contextsByKey[contextKey]
                    : null;
                workspaceSurfaceDragBindingRef.current =
                    contextKey && context
                        ? {
                              contextKey,
                              projectId: context.projectId,
                              worktreeId: context.worktreeId,
                          }
                        : null;
            }
            const binding = workspaceSurfaceDragBindingRef.current;
            if (!binding) {
                return;
            }
            void comandoApi.dispatchWorkspaceSurfaceDrag({
                contextKey: binding.contextKey,
                detail: event.detail,
                kind,
                projectId: binding.projectId,
                worktreeId: binding.worktreeId,
            });
            if (
                event.detail.phase === "end" ||
                event.detail.phase === "cancel"
            ) {
                workspaceSurfaceDragBindingRef.current = null;
            }
        };
        const handleAgentDrag = (event: Event) =>
            forwardDrag(
                "agent",
                event as CustomEvent<SidebarAgentDragDetail>,
            );
        const handleGitHubDrag = (event: Event) =>
            forwardDrag(
                "github",
                event as CustomEvent<SidebarGitHubDragDetail>,
            );
        window.addEventListener(SIDEBAR_AGENT_DRAG_EVENT, handleAgentDrag);
        window.addEventListener(SIDEBAR_GITHUB_DRAG_EVENT, handleGitHubDrag);
        return () => {
            window.removeEventListener(
                SIDEBAR_AGENT_DRAG_EVENT,
                handleAgentDrag,
            );
            window.removeEventListener(
                SIDEBAR_GITHUB_DRAG_EVENT,
                handleGitHubDrag,
            );
        };
    }, []);


    useLayoutEffect(() => {
        if (!isWorkspaceHostRenderer) {
            return;
        }
        const element = workspaceHostTitleBarRef.current;
        const comandoApi = getComandoApi();
        if (!element || !comandoApi) {
            return;
        }
        const updateInsets = () => {
            const sideInsets = getShellSurfaceSideInsets(shellResponsive);
            void comandoApi.setWorkspaceSurfaceContentInsets(
                scaleShellSurfaceInsets(
                    {
                        // WebContentsView bounds use device-independent pixels,
                        // while the renderer reports zoomed CSS coordinates.
                        left: sideInsets.left,
                        right: sideInsets.right,
                        top: element.getBoundingClientRect().height,
                    },
                    appZoomFactor,
                ),
            );
        };
        updateInsets();
        const observer = new ResizeObserver(updateInsets);
        observer.observe(element);
        return () => observer.disconnect();
    }, [appZoomFactor, shellResponsive]);

    useEffect(() => {
        const comandoApi = getComandoApi();
        if (!comandoApi) {
            return;
        }

        const unsubscribeProjectsUpdated = comandoApi.onProjectsUpdated(() => {
            void hydrateProjects();
        });
        const unsubscribeProjectAppDataCleared =
            comandoApi.onProjectAppDataCleared((projectId) => {
                void removeProjectTabs(projectId);
                void hydrateProjects();
            });

        return () => {
            unsubscribeProjectsUpdated();
            unsubscribeProjectAppDataCleared();
        };
    }, [hydrateProjects, removeProjectTabs]);

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
            const affectedPairs = [
                {
                    projectId: payload.projectId,
                    worktreeId: payload.worktreeId ?? null,
                },
                {
                    projectId: payload.projectId,
                    worktreeId: preferredWorktreeId,
                },
            ];
            const uniqueAffectedContextKeys = [
                ...new Set(
                    affectedPairs.map(({ projectId, worktreeId }) =>
                        getProjectContextKey(projectId, worktreeId),
                    ),
                ),
            ];

            for (const contextKey of uniqueAffectedContextKeys) {
                const nextGeneration =
                    (fileTreeEntryIndexGenerationsRef.current.get(contextKey) ??
                        0) + 1;

                fileTreeEntryIndexGenerationsRef.current.set(
                    contextKey,
                    nextGeneration,
                );
                fileTreeEntryIndexRequestsRef.current.delete(contextKey);
            }

            // Revalidate only contexts already loaded, keeping their old index
            // visible until the fresh one replaces it (stale-while-revalidate),
            // so the file-tree filter never blanks out.
            const revalidatedKeys = new Set<string>();
            for (const { projectId, worktreeId } of affectedPairs) {
                const contextKey = getProjectContextKey(projectId, worktreeId);
                if (
                    revalidatedKeys.has(contextKey) ||
                    !fileTreeEntryIndexByContextRef.current[contextKey]
                ) {
                    continue;
                }
                revalidatedKeys.add(contextKey);
                loadFileTreeEntryIndex(projectId, worktreeId);
            }

            void refreshProjectTree(payload.projectId, preferredWorktreeId);
            void refreshProjectTabs(
                payload.projectId,
                preferredWorktreeId,
                payload.relativePaths ?? null,
            );
        });

        return unsubscribe;
    }, [loadFileTreeEntryIndex, refreshProjectTabs, refreshProjectTree]);

    useEffect(() => {
        const comandoApi = getComandoApi();
        if (!comandoApi) {
            return;
        }

        const unsubscribe = comandoApi.onProjectWorkspaceRequested((payload) => {
            void (async () => {
                const requestedWorktreeId =
                    payload.worktreeId !== undefined
                        ? (payload.worktreeId ?? null)
                        : (useGitStore.getState().activeWorktreeIds[
                              payload.projectId
                          ] ?? null);

                const contextKey = await useWorkspaceStore
                    .getState()
                    .registerWorkspaceScope(payload.projectId, requestedWorktreeId);
                await comandoApi.initializeWorkspaceSurfaces(
                    useWorkspaceStore.getState().getWorkspaceSurfaceRegistry(),
                );
                await comandoApi.activateWorkspaceSurface(contextKey);

                if (payload.branchName !== undefined) {
                    selectGitBranch(
                        payload.projectId,
                        payload.branchName,
                        requestedWorktreeId,
                    );
                }

            })();
        });

        return unsubscribe;
    }, [
        selectGitBranch,
    ]);

    useEffect(() => {
        const comandoApi = getComandoApi();
        if (!comandoApi) {
            return;
        }

        const resolvePreferredWorktreeId = (
            projectId: string,
            worktreeId: string | null,
        ): string | null =>
            worktreeId ??
            useGitStore.getState().activeWorktreeIds[projectId] ??
            null;
        const projectRefreshScheduler = createGitProjectRefreshScheduler({
            refreshProject: (projectId, worktreeId) => {
                return refreshGitProject(projectId, worktreeId).then(() => undefined);
            },
        });

        const unsubscribeInvalidation = comandoApi.onGitRepositoryInvalidated(
            (payload) => {
                const preferredWorktreeId = resolvePreferredWorktreeId(
                    payload.projectId,
                    payload.worktreeId,
                );
                projectRefreshScheduler.schedule(
                    payload.projectId,
                    preferredWorktreeId,
                );
                if (
                    payload.reason === "branch" ||
                    payload.reason === "remote" ||
                    payload.reason === "worktree" ||
                    payload.reason === "unknown"
                ) {
                    void refreshGitHistory(
                        payload.projectId,
                        preferredWorktreeId,
                    );
                }
            },
        );
        const unsubscribeSnapshot = comandoApi.onGitRepositorySnapshotUpdated(
            (snapshot) => {
                projectRefreshScheduler.cancel(
                    snapshot.projectId,
                    snapshot.currentWorktreeId,
                );
                projectRefreshScheduler.cancel(snapshot.projectId, null);
                ingestGitSnapshot(snapshot);
            },
        );
        const unsubscribeWorktrees = comandoApi.onGitWorktreesUpdated(
            (payload) => {
                void comandoApi.refreshAiProjectScopes(payload.projectId);
            },
        );

        return () => {
            unsubscribeInvalidation();
            unsubscribeSnapshot();
            unsubscribeWorktrees();
            projectRefreshScheduler.clear();
        };
    }, [ingestGitSnapshot, refreshGitHistory, refreshGitProject]);

    useEffect(() => {
        const comandoApi = getComandoApi();
        if (!comandoApi) {
            return;
        }

        return comandoApi.onGitHubAuthUpdated((status) => {
            useGitHubStore.setState((state) => ({
                authStatusByHost: {
                    ...state.authStatusByHost,
                    [status.host]: status,
                },
            }));
        });
    }, []);

    useEffect(() => {
        const comandoApi = getComandoApi();
        if (!comandoApi) {
            return;
        }

        const unsubscribeRuntime = comandoApi.onAiRuntimeStatus((status) => {
            applyAiRuntimeStatus(status);
        });
        const unsubscribeSessionEvent =
            comandoApi.onAiSessionEvent?.((event) => {
                applyAiSessionEvent(event);
            }) ?? (() => undefined);
        const unsubscribeSession = comandoApi.onAiSessionSnapshot((update) => {
            applyAiSessionUpdate(update);
        });
        const unsubscribePromptQueue = comandoApi.onAiPromptQueue((snapshot) => {
            applyAiPromptQueueSnapshot(snapshot);
        });

        return () => {
            unsubscribeRuntime();
            unsubscribeSessionEvent();
            unsubscribeSession();
            unsubscribePromptQueue();
        };
    }, [
        applyAiPromptQueueSnapshot,
        applyAiRuntimeStatus,
        applyAiSessionEvent,
        applyAiSessionUpdate,
    ]);

    useEffect(() => {
        const comandoApi = getComandoApi();
        if (!comandoApi) {
            return;
        }

        return comandoApi.onNavigatorToggleRequested(() => {
            toggleLeftCollapsed();
        });
    }, [toggleLeftCollapsed]);

    useEffect(() => {
        const comandoApi = getComandoApi();
        if (!comandoApi) {
            return;
        }

        return comandoApi.onInspectorToggleRequested(() => {
            toggleRightCollapsed();
        });
    }, [toggleRightCollapsed]);

    useEffect(() => {
        const comandoApi = getComandoApi();
        if (!comandoApi || !isWorkspaceHostRenderer) {
            return;
        }

        return comandoApi.onInternalNavigationRequested((rawUrl) => {
            try {
                const url = new URL(rawUrl);
                if (url.protocol !== "comando:") {
                    return;
                }
                if (url.hostname === "settings") {
                    const category = url.searchParams.get("category");
                    void comandoApi.openSettingsWindow({
                        initialCategory: isSettingsWindowCategory(category)
                            ? category
                            : undefined,
                        projectId: activeProjectId,
                    });
                    return;
                }
                if (url.hostname === "workspace") {
                    const projectId = url.searchParams.get("projectId");
                    if (!projectId) {
                        return;
                    }
                    void comandoApi.activateProjectWorkspace({
                        branchName: url.searchParams.get("branch"),
                        projectId,
                        worktreeId: url.searchParams.get("worktreeId"),
                    });
                }
            } catch {
                // Invalid internal URLs are rejected without navigating the host renderer.
            }
        });
    }, [activeProjectId]);

    useEffect(() => {
        const comandoApi = getComandoApi();
        if (!comandoApi || !isWorkspaceHostRenderer) {
            return;
        }

        return comandoApi.onWorkspaceSwitcherRequested(() => {
            setSettingsView(null);
            setWorkspaceSwitcherOpen(true);
        });
    }, []);

    useEffect(() => {
        const comandoApi = getComandoApi();
        if (!comandoApi || !isWorkspaceHostRenderer) {
            return;
        }

        return comandoApi.onSettingsViewRequested((request) => {
            setWorkspaceSwitcherOpen(false);
            setSettingsView((current) => ({
                initialCategory: request.initialCategory,
                projectId: request.projectId,
                requestId: (current?.requestId ?? 0) + 1,
            }));
        });
    }, []);

    useEffect(() => {
        const comandoApi = getComandoApi();
        if (!comandoApi || !isWorkspaceHostRenderer) {
            return;
        }

        return comandoApi.onWorkspaceNavigationRequested(navigateWorkspace);
    }, [navigateWorkspace]);

    useEffect(() => {
        const comandoApi = getComandoApi();
        if (!comandoApi) {
            return;
        }

        const unsubscribe = comandoApi.onWorkspaceCloseActiveTab(() => {
            requestCloseActiveWorkspaceTab();
        });

        return () => {
            unsubscribe();
        };
    }, []);

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
        if (!isWorkspaceHostRenderer) {
            return;
        }
        void getComandoApi()?.setWorkspaceHostOverlayVisible(
            hostOverlayVisible,
        );
    }, [hostOverlayVisible]);

    useEffect(() => {
        if (!isWorkspaceHostRenderer) {
            return;
        }
        return () => {
            void getComandoApi()?.setWorkspaceHostOverlayVisible(false);
        };
    }, []);

    useEffect(() => {
        const comandoApi = getComandoApi();
        if (!comandoApi) {
            return;
        }
        return comandoApi.onWorkspaceFlushRequested(
            flushWorkspacePersistenceNow,
        );
    }, []);

    useLayoutEffect(() => {
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
            void comandoApi.saveShellState(
                createPersistedShellState({
                    activeSurface,
                    expandedProjectIds,
                    leftCollapsed: leftCollapsedPreference,
                    leftWidth,
                    preferredDrawer,
                    projectOrder,
                    rightCollapsed,
                    rightInspectorView: sidebarView,
                    rightWidth,
                }),
            );
        }, 120);

        return () => {
            window.clearTimeout(timeout);
        };
    }, [
        activeSurface,
        expandedProjectIds,
        leftCollapsedPreference,
        leftWidth,
        persistenceReady,
        preferredDrawer,
        projectOrder,
        rightCollapsed,
        rightWidth,
        sidebarView,
    ]);

    const gitActiveWorktreeId = useGitStore((state) =>
        activeProjectId
            ? (state.activeWorktreeIds[activeProjectId] ?? null)
            : null,
    );
    const activeWorktreeId = activeWorkspaceContext
        ? resolveCommittedProjectWorktreeId(
              activeWorkspaceContext.projectId,
              activeWorkspaceContext.worktreeId,
          )
        : workspaceNavigationHydrated
          ? null
          : gitActiveWorktreeId;
    const activeProjectContextKey = getProjectContextKey(
        activeProjectId,
        activeWorktreeId,
    );
    const inspectorScopeKey =
        workspaceActiveContextKey ?? activeProjectContextKey;
    const activeInspectorFilters =
        inspectorFiltersByScope[inspectorScopeKey] ?? {};
    const fileTreeFilter = activeInspectorFilters.files ?? "";
    const gitChangesFilter = activeInspectorFilters.git ?? "";
    const agentsFilter = activeInspectorFilters.agents ?? "";
    const issuesFilter = activeInspectorFilters.issues ?? "";
    const pullRequestsFilter =
        activeInspectorFilters.pull_requests ?? "";
    const setInspectorFilter = useCallback(
        (
            view: WorkspaceInspectorView,
            action: SetStateAction<string>,
        ) => {
            setInspectorFiltersByScope((current) => {
                const scopeFilters = current[inspectorScopeKey] ?? {};
                const nextValue = resolveStateAction(
                    action,
                    scopeFilters[view] ?? "",
                );
                if (scopeFilters[view] === nextValue) {
                    return current;
                }
                return {
                    ...current,
                    [inspectorScopeKey]: {
                        ...scopeFilters,
                        [view]: nextValue,
                    },
                };
            });
        },
        [inspectorScopeKey],
    );
    const setFileTreeFilter = useCallback(
        (action: SetStateAction<string>) =>
            setInspectorFilter("files", action),
        [setInspectorFilter],
    );
    const fileTreeSelection = fileTreeSelectionByScope[inspectorScopeKey] ?? {
        anchorPath: null,
        selectedPaths: [],
        suppressed: false,
    };
    const fileTreeSelectedPaths = fileTreeSelection.selectedPaths;
    const fileTreeSelectionAnchorPath = fileTreeSelection.anchorPath;
    const isFileTreeSelectionSuppressed = fileTreeSelection.suppressed;
    const updateFileTreeSelection = useCallback(
        (
            update: (
                current: (typeof fileTreeSelectionByScope)[string],
            ) => (typeof fileTreeSelectionByScope)[string],
        ) => {
            setFileTreeSelectionByScope((current) => {
                const selection = current[inspectorScopeKey] ?? {
                    anchorPath: null,
                    selectedPaths: [],
                    suppressed: false,
                };
                return {
                    ...current,
                    [inspectorScopeKey]: update(selection),
                };
            });
        },
        [inspectorScopeKey],
    );
    const setFileTreeSelectedPaths = useCallback(
        (action: SetStateAction<readonly string[]>) =>
            updateFileTreeSelection((current) => ({
                ...current,
                selectedPaths: resolveStateAction(
                    action,
                    current.selectedPaths,
                ),
            })),
        [updateFileTreeSelection],
    );
    const setFileTreeSelectionAnchorPath = useCallback(
        (action: SetStateAction<string | null>) =>
            updateFileTreeSelection((current) => ({
                ...current,
                anchorPath: resolveStateAction(action, current.anchorPath),
            })),
        [updateFileTreeSelection],
    );
    const setIsFileTreeSelectionSuppressed = useCallback(
        (action: SetStateAction<boolean>) =>
            updateFileTreeSelection((current) => ({
                ...current,
                suppressed: resolveStateAction(action, current.suppressed),
            })),
        [updateFileTreeSelection],
    );
    const activeGitContextKey = activeProjectId
        ? getGitContextKey(activeProjectId, activeWorktreeId)
        : null;
    const activeGitChanges = useMemo(
        () =>
            activeGitContextKey
                ? (gitSnapshots[activeGitContextKey]?.changes ?? [])
                : [],
        [activeGitContextKey, gitSnapshots],
    );

    useEffect(() => {
        if (!activeWorkspaceContext) {
            return;
        }

        const { projectId, worktreeId } = activeWorkspaceContext;
        void setActiveWorktree(projectId, worktreeId);

        const projectContextKey = getProjectContextKey(projectId, worktreeId);
        const gitContextKey = getGitContextKey(projectId, worktreeId);
        const projectsState = useProjectsStore.getState();
        const gitState = useGitStore.getState();
        const refreshPlan = resolveWorkspaceContextRefreshPlan({
            hasGitSnapshot: Object.hasOwn(gitState.snapshots, gitContextKey),
            hasProjectTree: Object.hasOwn(
                projectsState.treeNodes[projectContextKey] ?? {},
                ROOT_NODE_KEY,
            ),
            sidebarView,
            sidebarVisible: !shellResponsive.right.collapsed,
        });

        if (refreshPlan.projectTree) {
            void runDeduplicatedContextRefresh(
                pendingContextTreeRefreshesRef.current,
                projectContextKey,
                () => refreshProjectTree(projectId, worktreeId),
            );
        }
        if (refreshPlan.gitSnapshot) {
            void runDeduplicatedContextRefresh(
                pendingContextGitRefreshesRef.current,
                gitContextKey,
                () => refreshGitProject(projectId, worktreeId),
            );
        }
    }, [
        activeWorkspaceContext,
        refreshGitProject,
        refreshProjectTree,
        setActiveWorktree,
        shellResponsive.right.collapsed,
        sidebarView,
    ]);

    useEffect(() => {
        return scheduleEffectStateUpdate(() => {
            setFileTreeBackendSearchResults([]);
            setFileTreeContextMenu(null);
            setIsFileTreeSearchOpen(false);
        });
    }, [activeProjectId, activeWorktreeId]);

    useEffect(() => {
        if (!isFileTreeSearchOpen) {
            return;
        }

        fileTreeSearchInputRef.current?.focus();
    }, [isFileTreeSearchOpen]);

    useEffect(() => {
        if (!activeProjectId) {
            return;
        }
        // Initial load only; revalidation after invalidation is driven by the
        // invalidation handler (which keeps the old index visible meanwhile).
        if (fileTreeEntryIndexByContext[activeProjectContextKey]) {
            return;
        }
        loadFileTreeEntryIndex(activeProjectId, activeWorktreeId);
    }, [
        activeProjectContextKey,
        activeProjectId,
        activeWorktreeId,
        fileTreeEntryIndexByContext,
        loadFileTreeEntryIndex,
    ]);

    const stopDragging = useEffectEvent(() => {
        setDragState(null);
    });

    const handlePointerMove = useEffectEvent((event: PointerEvent) => {
        if (!dragState) {
            return;
        }
        if (!hasPrimaryPointerButton(event.buttons)) {
            stopDragging();
            return;
        }

        const delta = event.clientX - dragState.startX;
        const nextWidth =
            dragState.side === "left"
                ? dragState.startWidth + delta
                : dragState.startWidth - delta;

        resizePanel(dragState.side, nextWidth);
    });

    useEffect(() => {
        if (!dragState) {
            return;
        }

        // Mark the splitter drag as active for the whole gesture. The chat
        // timeline reads this to freeze its virtualized layout while dragging,
        // so the scroll stays put instead of jittering on every reflow. Every
        // drag-end path (pointerup/cancel/blur/hidden) clears dragState, which
        // runs this cleanup and lifts the freeze.
        setResizingPanel(true);

        const previousCursor = document.body.style.cursor;
        const previousUserSelect = document.body.style.userSelect;

        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        const handleVisibilityChange = () => {
            if (document.visibilityState === "hidden") {
                stopDragging();
            }
        };

        window.addEventListener("pointermove", handlePointerMove);
        window.addEventListener("pointercancel", stopDragging);
        window.addEventListener("pointerup", stopDragging);
        window.addEventListener("blur", stopDragging);
        document.addEventListener("visibilitychange", handleVisibilityChange);

        return () => {
            setResizingPanel(false);
            document.body.style.cursor = previousCursor;
            document.body.style.userSelect = previousUserSelect;
            window.removeEventListener("pointermove", handlePointerMove);
            window.removeEventListener("pointercancel", stopDragging);
            window.removeEventListener("pointerup", stopDragging);
            window.removeEventListener("blur", stopDragging);
            document.removeEventListener(
                "visibilitychange",
                handleVisibilityChange,
            );
        };
    }, [dragState, setResizingPanel]);

    const gridTemplateColumns = useMemo(() => {
        return getShellGridTemplateColumns(shellResponsive);
    }, [shellResponsive]);
    const leftPanelPersistent =
        !shellResponsive.left.collapsed && !shellResponsive.left.overlay;
    const rightPanelPersistent =
        !shellResponsive.right.collapsed && !shellResponsive.right.overlay;
    const leftPanelWidthRange = useMemo(
        () =>
            getShellPanelWidthRange(
                {
                    leftWidth: leftEffectiveWidth,
                    rightWidth: rightEffectiveWidth,
                },
                "left",
                shellViewportWidth,
            ),
        [leftEffectiveWidth, rightEffectiveWidth, shellViewportWidth],
    );
    const rightPanelWidthRange = useMemo(
        () =>
            getShellPanelWidthRange(
                {
                    leftWidth: leftEffectiveWidth,
                    rightWidth: rightEffectiveWidth,
                },
                "right",
                shellViewportWidth,
            ),
        [leftEffectiveWidth, rightEffectiveWidth, shellViewportWidth],
    );

    const activeProject =
        projects.find((project) => project.id === activeProjectId) ?? null;
    useEffect(() => {
        document.title = bootstrap?.app.windowTitle ?? "Comando";
    }, [bootstrap?.app.windowTitle]);
    const workspaceRecentProjects = useMemo<
        readonly WorkspacePaneRecentProject[]
    >(() => {
        const lastOpenedTime = (project: ProjectSummary) =>
            project.lastOpenedAt ? Date.parse(project.lastOpenedAt) : 0;
        return projects
            .filter((project) => project.id !== activeProjectId)
            .toSorted((a, b) => lastOpenedTime(b) - lastOpenedTime(a))
            .slice(0, WORKSPACE_RECENT_PROJECTS_LIMIT)
            .map((project) => ({ id: project.id, name: project.name }));
    }, [activeProjectId, projects]);
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
    const cachedFileTreeEntryIndex =
        fileTreeEntryIndexByContext[activeProjectContextKey] ?? null;
    const fileTreeFilterSource = useMemo<FileTreeFilterSource | null>(() => {
        if (!isFilteringFileTree) {
            return null;
        }

        return {
            contextKey: activeProjectContextKey,
            kind: cachedFileTreeEntryIndex ? "full" : "backend",
        };
    }, [activeProjectContextKey, cachedFileTreeEntryIndex, isFilteringFileTree]);

    useEffect(() => {
        if (
            fileTreeFilterSource?.kind !== "backend" ||
            !activeProjectId ||
            !window.comando
        ) {
            fileTreeBackendSearchRequestRef.current += 1;
            return scheduleEffectStateUpdate(() => {
                setFileTreeBackendSearchResults([]);
            });
        }

        const requestId = fileTreeBackendSearchRequestRef.current + 1;
        fileTreeBackendSearchRequestRef.current = requestId;
        const search = () => {
            void window.comando
                .searchProjectEntries({
                    includeAncestorDirectories: true,
                    limit: 160,
                    projectId: activeProjectId,
                    query: normalizedFileTreeFilter,
                    searchContext: "file-tree",
                    worktreeId: activeWorktreeId,
                })
                .then((results) => {
                    if (fileTreeBackendSearchRequestRef.current !== requestId) {
                        return;
                    }

                    setFileTreeBackendSearchResults(results);
                })
                .catch(() => {
                    if (fileTreeBackendSearchRequestRef.current !== requestId) {
                        return;
                    }

                    setFileTreeBackendSearchResults([]);
                });
        };

        const delayMs = getProjectSearchDelayMs(normalizedFileTreeFilter);
        if (delayMs === 0) {
            search();
            return;
        }

        const timeoutId = window.setTimeout(search, delayMs);

        return () => {
            window.clearTimeout(timeoutId);
        };
    }, [
        activeProjectId,
        activeWorktreeId,
        fileTreeFilterSource,
        normalizedFileTreeFilter,
    ]);

    const fileTreeFilterEntries = useMemo(() => {
        if (!fileTreeFilterSource) {
            return [];
        }

        return fileTreeFilterSource.kind === "full" && cachedFileTreeEntryIndex
            ? cachedFileTreeEntryIndex
            : fileTreeBackendSearchResults;
    }, [
        cachedFileTreeEntryIndex,
        fileTreeBackendSearchResults,
        fileTreeFilterSource,
    ]);
    const shouldFilterTreeInWorker =
        fileTreeFilterSource?.kind === "full" &&
        fileTreeFilterEntries.length >= 2_000 &&
        typeof Worker !== "undefined";
    const synchronousFileTreeFilterMatches = useMemo(() => {
        if (shouldFilterTreeInWorker) {
            return [];
        }
        if (!fileTreeFilterSource) {
            return [];
        }

        return filterProjectEntriesForTreeFilter(
            fileTreeFilterEntries,
            normalizedFileTreeFilter,
            fileTreeFilterSource.kind === "backend"
                ? "backend-ranked"
                : "substring",
        );
    }, [
        fileTreeFilterEntries,
        fileTreeFilterSource,
        normalizedFileTreeFilter,
        shouldFilterTreeInWorker,
    ]);
    const [workerFileTreeFilterMatches, setWorkerFileTreeFilterMatches] =
        useState<{
            readonly entries: readonly ProjectTreeNode[];
            readonly matches: readonly ProjectTreeNode[];
            readonly query: string;
        } | null>(null);
    useEffect(() => {
        if (!shouldFilterTreeInWorker || !fileTreeFilterSource) {
            return;
        }
        const controller = new AbortController();
        void filterProjectEntriesInWorker({
            entries: fileTreeFilterEntries,
            query: normalizedFileTreeFilter,
            signal: controller.signal,
            strategy: "substring",
        }).then((matches) => {
            if (!controller.signal.aborted) {
                setWorkerFileTreeFilterMatches({
                    entries: fileTreeFilterEntries,
                    matches,
                    query: normalizedFileTreeFilter,
                });
            }
        });
        return () => controller.abort();
    }, [
        fileTreeFilterEntries,
        fileTreeFilterSource,
        normalizedFileTreeFilter,
        shouldFilterTreeInWorker,
    ]);
    const fileTreeFilterMatches = useMemo(
        () =>
            shouldFilterTreeInWorker
                ? (workerFileTreeFilterMatches?.entries === fileTreeFilterEntries &&
                  workerFileTreeFilterMatches.query === normalizedFileTreeFilter
                      ? workerFileTreeFilterMatches.matches
                      : [])
                : synchronousFileTreeFilterMatches,
        [
            fileTreeFilterEntries,
            normalizedFileTreeFilter,
            shouldFilterTreeInWorker,
            synchronousFileTreeFilterMatches,
            workerFileTreeFilterMatches,
        ],
    );
    const fileTreeSearchTree = useMemo(
        () =>
            buildHierarchicalGitTreeNodesFromProjectEntries(
                fileTreeFilterMatches,
                fileTreeFilterEntries,
                activeGitChanges,
            ),
        [activeGitChanges, fileTreeFilterEntries, fileTreeFilterMatches],
    );
    const fileTreeSearchNodes = fileTreeSearchTree.nodes;
    const fileTreeSearchExpandedPaths = fileTreeSearchTree.expandedDirectoryPaths;
    const isProjectRootExpanded =
        projectRootExpandedByContext[activeProjectContextKey] ?? true;
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
    const activeGitError = activeGitContextKey
        ? (gitErrors[activeGitContextKey] ?? null)
        : null;
    const isMac = bootstrap?.platform === "darwin";
    const topStatus = [
        bootstrapError,
        projectsError,
        workspaceError,
        activeGitError,
        workspaceSurfaceActionError,
    ]
        .filter(Boolean)
        .join(" ");

    useEffect(() => {
        return scheduleEffectStateUpdate(() => {
            setFileTreeInlineEditor(null);
            fileTreeInlineSubmitPendingRef.current = false;
        });
    }, [activeProjectContextKey]);

    const cancelFileTreeInlineEditor = useCallback(() => {
        fileTreeInlineSubmitPendingRef.current = false;
        setFileTreeInlineEditor(null);
    }, []);

    const clearFileTreeSelection = useCallback(
        (
            options: {
                readonly suppressActivePathFallback?: boolean;
            } = {},
        ) => {
            setIsFileTreeSelectionSuppressed(
                options.suppressActivePathFallback === true,
            );
            setFileTreeSelectedPaths([]);
            setFileTreeSelectionAnchorPath(null);
        },
        [
            setFileTreeSelectedPaths,
            setFileTreeSelectionAnchorPath,
            setIsFileTreeSelectionSuppressed,
        ],
    );

    const focusWorkspaceSurface = useCallback(() => {
        focusSurface("workspace");
        clearFileTreeSelection({ suppressActivePathFallback: true });
        setFileTreeContextTargetResetSignal((signal) => signal + 1);
        setGitHubSidebarSelectionResetSignal((signal) => signal + 1);
        setFileTreeContextMenu(null);
    }, [clearFileTreeSelection, focusSurface]);

    useEffect(() => {
        if (!isWorkspaceHostRenderer) {
            return;
        }
        return getComandoApi()?.onWorkspaceSurfaceFocused(
            focusWorkspaceSurface,
        );
    }, [focusWorkspaceSurface]);

    const closeFileTreeContextMenu = useCallback(() => {
        const transientSelectionPath =
            fileTreeContextMenu?.payload.kind === "node"
                ? fileTreeContextMenu.payload.transientSelectionPath
                : null;

        setFileTreeContextMenu(null);

        if (!transientSelectionPath) {
            return;
        }

        setFileTreeSelectedPaths((currentPaths) =>
            currentPaths.length === 1 &&
            currentPaths[0] === transientSelectionPath
                ? []
                : currentPaths,
        );
        setFileTreeSelectionAnchorPath((currentPath) =>
            currentPath === transientSelectionPath ? null : currentPath,
        );
    }, [
        fileTreeContextMenu,
        setFileTreeSelectedPaths,
        setFileTreeSelectionAnchorPath,
    ]);

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
                        openFileTab: async (
                            projectId,
                            relativePath,
                            worktreeId,
                        ) => {
                            if (isWorkspaceHostRenderer) {
                                if (!workspaceActiveContextKey) {
                                    throw new Error(
                                        "The active workspace surface is unavailable.",
                                    );
                                }
                                await dispatchWorkspaceSurfaceAction({
                                    contextKey: workspaceActiveContextKey,
                                    kind: "file",
                                    origin: "quick-create",
                                    projectId,
                                    relativePath,
                                    worktreeId: worktreeId ?? null,
                                });
                                return;
                            }
                            await openFileTab(
                                projectId,
                                relativePath,
                                worktreeId,
                            );
                        },
                        parentRelativePath,
                        projectId: activeProjectId,
                        reportError: (message) => {
                            window.alert(message);
                        },
                        setLastQuickCreateAction: (action) => {
                            if (!isWorkspaceHostRenderer) {
                                setLastQuickCreateAction(action);
                            }
                        },
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
            dispatchWorkspaceSurfaceAction,
            openFileTab,
            revealPathInTree,
            setLastQuickCreateAction,
            workspaceActiveContextKey,
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

    const closeFileTreeMovePicker = useCallback(() => {
        setFileTreeMovePickerEntries(null);
        setFileTreeMovePickerQuery("");
        setFileTreeMovePickerSelectedIndex(0);
    }, []);

    const openFileTreeMovePicker = useCallback(
        (nodes: readonly GitTreeNode[]) => {
            const entries = compactGitTreeDragEntriesByAncestor(
                nodes
                    .filter((node) => !node.isProjectRoot)
                    .map((node) => ({
                        kind: node.kind,
                        name: node.name,
                        relativePath: node.path,
                    })),
            );

            if (entries.length === 0) {
                return;
            }

            setFileTreeMovePickerEntries(entries);
            setFileTreeMovePickerQuery("");
            setFileTreeMovePickerSelectedIndex(0);
        },
        [],
    );

    const handleMoveTreeNode = useCallback(
        async (
            draggedPayload: GitTreeDragPayload,
            destinationNode: GitTreeNode,
        ) => {
            if (!activeProjectId) {
                return;
            }

            const nextParentRelativePath = destinationNode.isProjectRoot
                ? null
                : destinationNode.path;
            const validation = getProjectEntryMoveValidation(
                draggedPayload,
                nextParentRelativePath,
            );
            if (!validation.canMove) {
                if (
                    validation.reason === "directory-self" ||
                    validation.reason === "directory-descendant"
                ) {
                    window.alert(
                        getFileTreeMoveValidationMessage(validation.reason),
                    );
                }
                return;
            }

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

            try {
                for (const entry of validation.entries) {
                    const movedEntry = await renameEntry(
                        activeProjectId,
                        entry.relativePath,
                        entry.name,
                        nextParentRelativePath,
                        activeWorktreeId,
                    );
                    await renameTabsForProjectPath(
                        activeProjectId,
                        activeWorktreeId,
                        entry.relativePath,
                        movedEntry.relativePath,
                        entry.kind,
                    );
                }
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
                        : validation.entries.length > 1
                          ? "Could not move the selected items."
                          : "Could not move the selected item.",
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

    const handleDeleteTreeNodes = useCallback(
        async (nodes: readonly GitTreeNode[]) => {
            if (!activeProjectId) {
                return;
            }

            const deletableNodes = nodes.filter((node) => !node.isProjectRoot);
            if (deletableNodes.length === 0) {
                return;
            }

            const confirmed = window.confirm(
                deletableNodes.length === 1
                    ? deletableNodes[0].kind === "directory"
                        ? `Delete folder "${deletableNodes[0].name}" and all its contents?`
                        : `Delete file "${deletableNodes[0].name}"?`
                    : `Delete ${deletableNodes.length} selected items?`,
            );
            if (!confirmed) {
                return;
            }

            const entriesToDelete =
                compactGitTreeEntriesForDeletion(deletableNodes);
            const deletedEntries: {
                readonly kind: "directory" | "file";
                readonly relativePath: string;
            }[] = [];

            try {
                for (const entry of entriesToDelete) {
                    await deleteEntry(
                        activeProjectId,
                        entry.path,
                        activeWorktreeId,
                    );
                    deletedEntries.push({
                        kind: entry.kind,
                        relativePath: entry.path,
                    });
                }

                await closeTabsForProjectPaths(
                    activeProjectId,
                    activeWorktreeId,
                    deletedEntries,
                );
            } catch (error) {
                if (deletedEntries.length > 0) {
                    await closeTabsForProjectPaths(
                        activeProjectId,
                        activeWorktreeId,
                        deletedEntries,
                    );
                }
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
            closeTabsForProjectPaths,
            deleteEntry,
        ],
    );

    const handleTrashTreeNodes = useCallback(
        async (nodes: readonly GitTreeNode[]) => {
            if (!activeProjectId) {
                return;
            }

            const trashableNodes = nodes.filter((node) => !node.isProjectRoot);
            if (trashableNodes.length === 0) {
                return;
            }

            const confirmed = window.confirm(
                trashableNodes.length === 1
                    ? trashableNodes[0].kind === "directory"
                        ? `Move folder "${trashableNodes[0].name}" and all its contents to Trash?`
                        : `Move file "${trashableNodes[0].name}" to Trash?`
                    : `Move ${trashableNodes.length} selected items to Trash?`,
            );
            if (!confirmed) {
                return;
            }

            const entriesToTrash =
                compactGitTreeEntriesForDeletion(trashableNodes);
            const trashedEntries: {
                readonly kind: "directory" | "file";
                readonly relativePath: string;
            }[] = [];

            try {
                for (const entry of entriesToTrash) {
                    await trashEntry(
                        activeProjectId,
                        entry.path,
                        activeWorktreeId,
                    );
                    trashedEntries.push({
                        kind: entry.kind,
                        relativePath: entry.path,
                    });
                }

                await closeTabsForProjectPaths(
                    activeProjectId,
                    activeWorktreeId,
                    trashedEntries,
                );
            } catch (error) {
                if (trashedEntries.length > 0) {
                    await closeTabsForProjectPaths(
                        activeProjectId,
                        activeWorktreeId,
                        trashedEntries,
                    );
                }
                window.alert(
                    error instanceof Error
                        ? error.message
                        : "Could not move the selected entry to Trash.",
                );
            }
        },
        [
            activeProjectId,
            activeWorktreeId,
            closeTabsForProjectPaths,
            trashEntry,
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

    const handleCopyTreeFullPaths = useCallback(
        async (nodes: readonly GitTreeNode[]) => {
            const text = nodes
                .map((node) =>
                    activeProject
                        ? joinProjectPath(activeProject.rootPath, node.path)
                        : null,
                )
                .filter((path): path is string => path !== null)
                .join("\n");

            if (!text) {
                return;
            }

            try {
                await writeClipboardText(text);
            } catch {
                window.alert("Could not copy the requested path.");
            }
        },
        [activeProject],
    );

    const isFileTreeClipboardCompatible = useMemo(
        () =>
            Boolean(
                activeProjectId &&
                    fileTreeClipboard &&
                    fileTreeClipboard.operation === "copy" &&
                    fileTreeClipboard.projectId === activeProjectId &&
                    normalizeFileTreeClipboardWorktreeId(
                        fileTreeClipboard.worktreeId,
                    ) ===
                        normalizeFileTreeClipboardWorktreeId(
                            activeWorktreeId,
                        ) &&
                    fileTreeClipboard.entries.length > 0,
            ),
        [activeProjectId, activeWorktreeId, fileTreeClipboard],
    );

    const fileTreePasteLabel = useMemo(() => {
        const count = fileTreeClipboard?.entries.length ?? 0;
        return count > 1 ? `Paste ${count} Items Here` : "Paste Here";
    }, [fileTreeClipboard]);

    const handleCopyTreeEntries = useCallback(
        (nodes: readonly GitTreeNode[]) => {
            if (!activeProjectId) {
                return;
            }

            const entries = compactGitTreeEntriesByAncestor(
                nodes
                    .filter((node) => !node.isProjectRoot)
                    .map((node) => ({
                        kind: node.kind,
                        name: node.name,
                        path: node.path,
                    })),
            );

            if (entries.length === 0) {
                return;
            }

            setFileTreeClipboard({
                entries,
                operation: "copy",
                projectId: activeProjectId,
                worktreeId: activeWorktreeId ?? null,
            });
        },
        [activeProjectId, activeWorktreeId],
    );

    const handlePasteTreeEntries = useCallback(
        async (destinationParentRelativePath: string | null) => {
            if (
                !activeProjectId ||
                !fileTreeClipboard ||
                !isFileTreeClipboardCompatible
            ) {
                return;
            }

            try {
                const result = await copyEntries(
                    activeProjectId,
                    fileTreeClipboard.entries.map((entry) => entry.path),
                    destinationParentRelativePath,
                    activeWorktreeId,
                );
                const firstCopiedEntry = result.entries[0] ?? null;

                if (firstCopiedEntry) {
                    await revealPathInTree(
                        activeProjectId,
                        firstCopiedEntry.relativePath,
                        activeWorktreeId,
                    );
                } else if (destinationParentRelativePath) {
                    await revealPathInTree(
                        activeProjectId,
                        destinationParentRelativePath,
                        activeWorktreeId,
                    );
                }
            } catch (error) {
                window.alert(
                    error instanceof Error
                        ? error.message
                        : "Could not paste the selected entries.",
                );
            }
        },
        [
            activeProjectId,
            activeWorktreeId,
            copyEntries,
            fileTreeClipboard,
            isFileTreeClipboardCompatible,
            revealPathInTree,
        ],
    );

    const handleImportExternalTreeEntries = useCallback(
        async (
            sourcePaths: readonly string[],
            destinationNode: GitTreeNode | null,
        ) => {
            if (!activeProjectId) {
                return;
            }

            const destinationParentRelativePath = destinationNode?.isProjectRoot
                ? null
                : (destinationNode?.path ?? null);

            try {
                const result = await copyExternalEntries(
                    activeProjectId,
                    sourcePaths,
                    destinationParentRelativePath,
                    activeWorktreeId,
                );
                const firstImportedEntry = result.entries[0] ?? null;

                if (firstImportedEntry) {
                    await revealPathInTree(
                        activeProjectId,
                        firstImportedEntry.relativePath,
                        activeWorktreeId,
                    );
                } else if (destinationParentRelativePath) {
                    await revealPathInTree(
                        activeProjectId,
                        destinationParentRelativePath,
                        activeWorktreeId,
                    );
                }
            } catch (error) {
                window.alert(
                    error instanceof Error
                        ? error.message
                        : "Could not import the dropped entries.",
                );
            }
        },
        [
            activeProjectId,
            activeWorktreeId,
            copyExternalEntries,
            revealPathInTree,
        ],
    );

    const handleDuplicateTreeEntries = useCallback(
        async (nodes: readonly GitTreeNode[]) => {
            if (!activeProjectId) {
                return;
            }

            const entries = compactGitTreeEntriesByAncestor(
                nodes
                    .filter((node) => !node.isProjectRoot)
                    .map((node) => ({
                        kind: node.kind,
                        name: node.name,
                        path: node.path,
                    })),
            );
            const firstEntry = entries[0] ?? null;
            if (!firstEntry) {
                return;
            }

            const destinationParentRelativePath =
                firstEntry.path.split("/").slice(0, -1).join("/") || null;

            try {
                const result = await copyEntries(
                    activeProjectId,
                    entries.map((entry) => entry.path),
                    destinationParentRelativePath,
                    activeWorktreeId,
                );
                const firstDuplicatedEntry = result.entries[0] ?? null;

                if (firstDuplicatedEntry) {
                    await revealPathInTree(
                        activeProjectId,
                        firstDuplicatedEntry.relativePath,
                        activeWorktreeId,
                    );
                }
            } catch (error) {
                window.alert(
                    error instanceof Error
                        ? error.message
                        : "Could not duplicate the selected entry.",
                );
            }
        },
        [
            activeProjectId,
            activeWorktreeId,
            copyEntries,
            revealPathInTree,
        ],
    );

    const handleOpenTreeEntryExternally = useCallback(
        async (relativePath: string) => {
            if (!activeProjectId) {
                return;
            }

            try {
                await openEntryExternally(
                    activeProjectId,
                    relativePath,
                    activeWorktreeId,
                );
            } catch (error) {
                window.alert(
                    error instanceof Error
                        ? error.message
                        : "Could not open the selected file externally.",
                );
            }
        },
        [activeProjectId, activeWorktreeId, openEntryExternally],
    );

    const handleAddFilesToChat = useCallback(
        async (
            nodes: readonly GitTreeNode[],
            options: { readonly forceNewChat?: boolean } = {},
        ) => {
            if (!activeProjectId) {
                return;
            }

            const fileNodes = nodes.filter((node) => node.kind === "file");
            if (fileNodes.length === 0) {
                return;
            }

            if (isWorkspaceHostRenderer) {
                if (!workspaceActiveContextKey) {
                    return;
                }
                requestWorkspaceSurfaceAction({
                    contextKey: workspaceActiveContextKey,
                    files: fileNodes.map((node) => ({
                        name: node.name,
                        relativePath: node.path,
                    })),
                    forceNewChat: options.forceNewChat === true,
                    kind: "add-files-to-chat",
                    projectId: activeProjectId,
                    worktreeId: activeWorktreeId ?? null,
                });
                return;
            }

            const currentTabsById = useWorkspaceStore.getState().tabsById;
            const worktreeId = activeWorktreeId ?? null;
            const existingChatTab = Object.values(currentTabsById).find(
                (tab) =>
                    tab.kind === "chat" &&
                    tab.projectId === activeProjectId &&
                    areGitWorktreeIdsEquivalent(
                        activeProjectId,
                        tab.worktreeId ?? null,
                        worktreeId,
                    ),
            );

            const attachContext = (sessionId: string) => {
                fileNodes.forEach((node) => {
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
                });
            };

            if (!options.forceNewChat && existingChatTab?.kind === "chat") {
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
                    areGitWorktreeIdsEquivalent(
                        activeProjectId,
                        tab.worktreeId ?? null,
                        worktreeId,
                    ) &&
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
            requestWorkspaceSurfaceAction,
            workspaceActiveContextKey,
        ],
    );

    const sidebarFileNodes = useMemo(
        () =>
            buildGitTreeNodesFromProjectTree(
                activeProjectTree,
                activeTreeNodesByParent,
                activeExpandedDirectories,
                activeGitChanges,
            ),
        [
            activeExpandedDirectories,
            activeGitChanges,
            activeProjectTree,
            activeTreeNodesByParent,
        ],
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
    const fileTreeScrollFilterKey = isFilteringFileTree
        ? fileTreeFilter.trim().toLowerCase()
        : "";
    const fileTreeScrollKey = `files:${activeProjectContextKey}:${
        isFilteringFileTree ? `filter:${fileTreeScrollFilterKey}` : "tree"
    }`;
    const {
        handleScroll: handleFileTreeScroll,
        saveScrollPosition: saveFileTreeScrollPosition,
        scrollElement: fileTreeScrollElement,
        setScrollElement: setFileTreeScrollElement,
    } = useRestorableSidebarScroll({
        enabled: sidebarView === "files",
        externalRef: sidebarScrollRef,
        restoreToken: `${sidebarView}:${fileTreeScrollKey}:${visibleSidebarNodePaths.length}`,
        scrollKey: fileTreeScrollKey,
        scrollPositionsRef: sidebarScrollPositionsRef,
    });
    const visibleSidebarNodePathSet = useMemo(
        () => new Set(visibleSidebarNodePaths),
        [visibleSidebarNodePaths],
    );
    const effectiveFileTreeSelection = useMemo(
        () =>
            reconcileFileTreeSelection({
                activeFileTreePath: activeFilePath,
                anchorPath: fileTreeSelectionAnchorPath,
                includeActivePathFallback: !isFileTreeSelectionSuppressed,
                selectedPaths: fileTreeSelectedPaths,
            }),
        [
            activeFilePath,
            fileTreeSelectionAnchorPath,
            fileTreeSelectedPaths,
            isFileTreeSelectionSuppressed,
        ],
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
    const fileTreeMoveDestinations = useMemo(
        () =>
            buildFileTreeMoveDestinations({
                activeProjectName: activeProject?.name ?? null,
                entries: fileTreeMovePickerEntries,
                projectEntryIndex: cachedFileTreeEntryIndex,
                query: fileTreeMovePickerQuery,
                treeNodesByParent: activeTreeNodesByParent,
            }),
        [
            activeProject?.name,
            activeTreeNodesByParent,
            cachedFileTreeEntryIndex,
            fileTreeMovePickerEntries,
            fileTreeMovePickerQuery,
        ],
    );
    const resolvedFileTreeMovePickerSelectedIndex = useMemo(
        () =>
            resolveFileTreeMovePickerSelectedIndex(
                fileTreeMoveDestinations,
                fileTreeMovePickerSelectedIndex,
            ),
        [fileTreeMoveDestinations, fileTreeMovePickerSelectedIndex],
    );

    const handleFileTreeMoveDestinationSelect = useCallback(
        (destination: FileTreeMoveDestination) => {
            if (!fileTreeMovePickerEntries || !destination.canMove) {
                return;
            }

            closeFileTreeMovePicker();
            void handleMoveTreeNode(fileTreeMovePickerEntries, {
                id: destination.path ?? ROOT_NODE_KEY,
                isProjectRoot: destination.path === null,
                kind: "directory",
                name: destination.name,
                path: destination.path ?? "",
                status: null,
            });
        },
        [
            closeFileTreeMovePicker,
            fileTreeMovePickerEntries,
            handleMoveTreeNode,
        ],
    );

    useEffect(() => {
        return scheduleEffectStateUpdate(() => {
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
        });
    }, [
        setFileTreeSelectedPaths,
        setFileTreeSelectionAnchorPath,
        visibleSidebarNodePathSet,
    ]);

    const handleFileTreeNodeClick = useCallback(
        (node: GitTreeNode, event: GitTreeNodeActivationEvent) => {
            setIsFileTreeSelectionSuppressed(false);

            const isRangeSelection = event.shiftKey;
            const isToggleSelection = event.metaKey || event.ctrlKey;

            const nextSelection = resolveFileTreeNodeClickSelection({
                anchorPath: effectiveFileTreeSelectionAnchorPath,
                isRangeSelection,
                isToggleSelection,
                nodePath: node.path,
                selectedPaths: effectiveFileTreeSelectedPaths,
                visiblePaths: visibleSidebarNodePaths,
            });

            if (
                isRangeSelection ||
                isToggleSelection ||
                !activeProjectId ||
                node.kind !== "file"
            ) {
                setFileTreeSelectedPaths(nextSelection.selectedPaths);
                setFileTreeSelectionAnchorPath(nextSelection.anchorPath);
                return;
            }

            clearFileTreeSelection();
            if (isWorkspaceHostRenderer) {
                if (!workspaceActiveContextKey) {
                    return;
                }
                requestWorkspaceSurfaceAction({
                    contextKey: workspaceActiveContextKey,
                    kind: "file",
                    origin: "tree",
                    projectId: activeProjectId,
                    relativePath: node.path,
                    worktreeId: activeWorktreeId ?? null,
                });
                return;
            }
            void openFileTab(activeProjectId, node.path, activeWorktreeId);
        },
        [
            activeProjectId,
            activeWorktreeId,
            clearFileTreeSelection,
            effectiveFileTreeSelectedPaths,
            effectiveFileTreeSelectionAnchorPath,
            openFileTab,
            requestWorkspaceSurfaceAction,
            setFileTreeSelectedPaths,
            setFileTreeSelectionAnchorPath,
            setIsFileTreeSelectionSuppressed,
            visibleSidebarNodePaths,
            workspaceActiveContextKey,
        ],
    );

    const handleFileTreeNodeDragStart = useCallback(
        (node: GitTreeNode, dataTransfer: DataTransfer | null) => {
            if (!dataTransfer) {
                return;
            }

            setIsFileTreeSelectionSuppressed(false);

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
            })) satisfies GitTreeDragData[];

            dataTransfer.clearData();
            dataTransfer.effectAllowed = "copyMove";
            dataTransfer.setData(
                COMPOSER_PROJECT_ENTRY_LIST_MIME,
                serializeComposerProjectEntryListDragData({
                    entries: composerEntries,
                }),
            );

            if (composerEntries.some((entry) => entry.kind === "file")) {
                dataTransfer.setData(COMPOSER_PROJECT_FILE_ENTRY_LIST_MIME, "1");
            }

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

            return composerEntries.length === 1
                ? composerEntries[0]
                : composerEntries;
        },
        [
            effectiveFileTreeSelectedPaths,
            setFileTreeSelectedPaths,
            setFileTreeSelectionAnchorPath,
            setIsFileTreeSelectionSuppressed,
            visibleSidebarNodePaths,
            visibleSidebarNodesByPath,
        ],
    );

    const getFileTreeContextSelection = useCallback(
        (node: GitTreeNode): readonly GitTreeNode[] => {
            if (!selectedFileTreePathSet.has(node.path)) {
                return [node];
            }

            const selectedNodes = effectiveFileTreeSelectedPaths
                .map((path) => visibleSidebarNodesByPath.get(path))
                .filter((entry): entry is GitTreeNode => Boolean(entry));

            return selectedNodes.length > 0 ? selectedNodes : [node];
        },
        [
            effectiveFileTreeSelectedPaths,
            selectedFileTreePathSet,
            visibleSidebarNodesByPath,
        ],
    );

    const handleCloseFileTreeTabs = useCallback(
        async (nodes: readonly GitTreeNode[]) => {
            if (!activeProjectId) {
                return;
            }

            const entries = nodes
                .filter((node) => !node.isProjectRoot)
                .map((node) => ({
                    kind: node.kind,
                    relativePath: node.path,
                }));
            await closeTabsForProjectPaths(
                activeProjectId,
                activeWorktreeId,
                entries,
            );
        },
        [activeProjectId, activeWorktreeId, closeTabsForProjectPaths],
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
                ...(isFileTreeClipboardCompatible
                    ? ([
                          {
                              label: fileTreePasteLabel,
                              action: () => void handlePasteTreeEntries(null),
                              disabled: !activeProjectId,
                          },
                      ] satisfies ContextMenuEntry[])
                    : ([] satisfies ContextMenuEntry[])),
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
        const contextSelection = getFileTreeContextSelection(node);
        const copyableContextSelection = contextSelection.filter(
            (entry) => !entry.isProjectRoot,
        );
        const contextSelectionFileCount = contextSelection.filter(
            (entry) => entry.kind === "file",
        ).length;
        const addToChatLabel =
            contextSelectionFileCount === 0
                ? "Add Files to Chat"
                : contextSelection.length > 1
                ? `Add ${contextSelectionFileCount} ${
                      contextSelectionFileCount === 1 ? "File" : "Files"
                  } to Chat`
                : "Add to Chat";
        const addToNewChatLabel =
            contextSelectionFileCount === 0
                ? "Add Files to New Chat"
                : contextSelection.length > 1
                ? `Add ${contextSelectionFileCount} ${
                      contextSelectionFileCount === 1 ? "File" : "Files"
                  } to New Chat`
                : "Add to New Chat";
        const copyAbsolutePathLabel =
            contextSelection.length > 1
                ? `Copy ${contextSelection.length} Full Paths`
                : "Copy Full Path";
        const copyEntryLabel =
            copyableContextSelection.length > 1
                ? `Copy ${copyableContextSelection.length} Selected Items`
                : "Copy";
        const canDuplicateContextSelection =
            copyableContextSelection.length === 1;
        const moveEntryLabel =
            copyableContextSelection.length > 1
                ? "Move Selected Items to..."
                : "Move to...";
        const deleteLabel =
            contextSelection.length > 1
                ? `Delete ${contextSelection.length} Selected Items`
                : node.kind === "directory"
                  ? "Delete Folder"
                  : "Delete File";
        const trashLabel =
            copyableContextSelection.length > 1
                ? `Move ${copyableContextSelection.length} Selected Items to Trash`
                : copyableContextSelection[0]?.kind === "directory"
                  ? "Move Folder to Trash"
                  : "Move File to Trash";
        const multiSelectionEntries =
            contextSelection.length > 1
                ? ([
                      {
                          label: addToChatLabel,
                          action: () =>
                              void handleAddFilesToChat(contextSelection),
                          disabled:
                              !activeProjectId ||
                              contextSelectionFileCount === 0,
                      },
                      {
                          label: addToNewChatLabel,
                          action: () =>
                              void handleAddFilesToChat(contextSelection, {
                                  forceNewChat: true,
                              }),
                          disabled:
                              !activeProjectId ||
                              contextSelectionFileCount === 0,
                      },
                      {
                          label: `Close ${contextSelection.length} Selected Tabs`,
                          action: () =>
                              void handleCloseFileTreeTabs(contextSelection),
                          disabled: !activeProjectId,
                      },
                      { type: "separator" },
                  ] satisfies ContextMenuEntry[])
                : ([] satisfies ContextMenuEntry[]);

        if (node.isProjectRoot) {
            return [
                ...multiSelectionEntries,
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
                ...(isFileTreeClipboardCompatible
                    ? ([
                          {
                              label: fileTreePasteLabel,
                              action: () => void handlePasteTreeEntries(null),
                              disabled: !activeProjectId,
                          },
                      ] satisfies ContextMenuEntry[])
                    : ([] satisfies ContextMenuEntry[])),
                { type: "separator" },
                {
                    label: "Reveal in Finder",
                    action: () => void handleRevealTreeEntry(null),
                    disabled: !activeProjectId,
                },
                {
                    label: "Copy Full Path",
                    action: () => void handleCopyTreeFullPaths([node]),
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
                ...multiSelectionEntries,
                {
                    label: "Open",
                    action: () =>
                        activeProjectId
                            ? isWorkspaceHostRenderer
                                ? workspaceActiveContextKey
                                    ? requestWorkspaceSurfaceAction({
                                          contextKey: workspaceActiveContextKey,
                                          kind: "file",
                                          origin: "tree",
                                          projectId: activeProjectId,
                                          relativePath: node.path,
                                          worktreeId: activeWorktreeId ?? null,
                                      })
                                    : undefined
                                : void openFileTab(
                                      activeProjectId,
                                      node.path,
                                      activeWorktreeId,
                                  )
                            : undefined,
                    disabled: !activeProjectId,
                },
                ...(contextSelection.length === 1
                    ? ([
                          {
                              label: "Open Externally",
                              action: () =>
                                  void handleOpenTreeEntryExternally(node.path),
                              disabled: !activeProjectId,
                          },
                      ] satisfies ContextMenuEntry[])
                    : ([] satisfies ContextMenuEntry[])),
                ...(contextSelection.length === 1
                    ? ([
                          {
                              label: addToChatLabel,
                              action: () =>
                                  void handleAddFilesToChat(contextSelection),
                              disabled: !activeProjectId,
                          },
                          {
                              label: addToNewChatLabel,
                              action: () =>
                                  void handleAddFilesToChat(contextSelection, {
                                      forceNewChat: true,
                                  }),
                              disabled: !activeProjectId,
                          },
                      ] satisfies ContextMenuEntry[])
                    : ([] satisfies ContextMenuEntry[])),
                { type: "separator" },
                {
                    label: "Rename",
                    action: () => void handleRenameTreeNode(node),
                    disabled: !activeProjectId,
                },
                ...(canDuplicateContextSelection
                    ? ([
                          {
                              label: "Duplicate",
                              action: () =>
                                  void handleDuplicateTreeEntries(
                                      copyableContextSelection,
                                  ),
                              disabled: !activeProjectId,
                          },
                      ] satisfies ContextMenuEntry[])
                    : ([] satisfies ContextMenuEntry[])),
                {
                    label: moveEntryLabel,
                    action: () =>
                        void openFileTreeMovePicker(copyableContextSelection),
                    disabled:
                        !activeProjectId || copyableContextSelection.length === 0,
                },
                {
                    label: "Reveal in Finder",
                    action: () => void handleRevealTreeEntry(node.path),
                    disabled: !activeProjectId,
                },
                {
                    label: copyEntryLabel,
                    action: () => void handleCopyTreeEntries(contextSelection),
                    disabled:
                        !activeProjectId || copyableContextSelection.length === 0,
                },
                {
                    label: copyAbsolutePathLabel,
                    action: () =>
                        void handleCopyTreeFullPaths(contextSelection),
                    disabled: !activeProject,
                },
                { type: "separator" },
                {
                    label: trashLabel,
                    action: () => void handleTrashTreeNodes(contextSelection),
                    danger: true,
                    disabled:
                        !activeProjectId || copyableContextSelection.length === 0,
                },
                {
                    label: deleteLabel,
                    action: () => void handleDeleteTreeNodes(contextSelection),
                    danger: true,
                    disabled: !activeProjectId,
                },
            ] satisfies ContextMenuEntry[];
        }

        return [
            ...multiSelectionEntries,
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
            ...(isFileTreeClipboardCompatible
                ? ([
                      {
                          label: fileTreePasteLabel,
                          action: () => void handlePasteTreeEntries(node.path),
                          disabled: !activeProjectId,
                      },
                  ] satisfies ContextMenuEntry[])
                : ([] satisfies ContextMenuEntry[])),
            { type: "separator" },
            {
                label: "Rename",
                action: () => void handleRenameTreeNode(node),
                disabled: !activeProjectId,
            },
            ...(canDuplicateContextSelection
                ? ([
                      {
                          label: "Duplicate",
                          action: () =>
                              void handleDuplicateTreeEntries(
                                  copyableContextSelection,
                              ),
                          disabled: !activeProjectId,
                      },
                  ] satisfies ContextMenuEntry[])
                : ([] satisfies ContextMenuEntry[])),
            {
                label: moveEntryLabel,
                action: () => void openFileTreeMovePicker(copyableContextSelection),
                disabled: !activeProjectId || copyableContextSelection.length === 0,
            },
            {
                label: "Reveal in Finder",
                action: () => void handleRevealTreeEntry(node.path),
                disabled: !activeProjectId,
            },
            {
                label: copyEntryLabel,
                action: () => void handleCopyTreeEntries(contextSelection),
                disabled: !activeProjectId || copyableContextSelection.length === 0,
            },
            {
                label: copyAbsolutePathLabel,
                action: () =>
                    void handleCopyTreeFullPaths(contextSelection),
                disabled: !activeProject,
            },
            { type: "separator" },
            {
                label: trashLabel,
                action: () => void handleTrashTreeNodes(contextSelection),
                danger: true,
                disabled: !activeProjectId || copyableContextSelection.length === 0,
            },
            {
                label: deleteLabel,
                action: () => void handleDeleteTreeNodes(contextSelection),
                danger: true,
                disabled: !activeProjectId,
            },
        ] satisfies ContextMenuEntry[];
    }, [
        activeProject,
        activeProjectId,
        activeWorktreeId,
        fileTreeContextMenu,
        fileTreePasteLabel,
        getFileTreeContextSelection,
        handleAddFilesToChat,
        handleCloseFileTreeTabs,
        handleCopyTreeEntries,
        handleCopyTreeFullPaths,
        handleCreateTreeEntry,
        handleDeleteTreeNodes,
        handleDuplicateTreeEntries,
        handleOpenTreeEntryExternally,
        handlePasteTreeEntries,
        handleRenameTreeNode,
        handleRevealTreeEntry,
        handleTrashTreeNodes,
        isFileTreeClipboardCompatible,
        openFileTab,
        openFileTreeMovePicker,
        refreshProjectTree,
        requestWorkspaceSurfaceAction,
        workspaceActiveContextKey,
    ]);

    const openNativeFileTreeContextMenu = useEffectEvent(
        async (
            menu: ContextMenuState<FileTreeContextMenuPayload>,
            entries: readonly ContextMenuEntry[],
        ) => {
            let action: (() => void) | null = null;
            try {
                action = await requestNativeContextMenuAction(entries, menu);
            } catch {
                // Treat native menu failures like a dismissed menu.
            } finally {
                closeFileTreeContextMenu();
            }

            if (action) queueMicrotask(action);
        },
    );

    useEffect(() => {
        if (!isWorkspaceHostRenderer || !fileTreeContextMenu) {
            activeNativeFileTreeMenuRef.current = null;
            return;
        }
        if (
            fileTreeContextMenuEntries.length === 0 ||
            activeNativeFileTreeMenuRef.current === fileTreeContextMenu
        ) {
            return;
        }

        activeNativeFileTreeMenuRef.current = fileTreeContextMenu;
        void openNativeFileTreeContextMenu(
            fileTreeContextMenu,
            fileTreeContextMenuEntries,
        );
    }, [fileTreeContextMenu, fileTreeContextMenuEntries]);

    const { stickyFolders, stickyFolderPaths } = useStickyFolders({
        scrollContainer: fileTreeScrollElement,
        nodes: isFilteringFileTree ? [] : sidebarTreeNodes,
        expandedPaths: isFilteringFileTree
            ? fileTreeSearchExpandedPaths
            : activeExpandedDirectories,
        layout: "tree",
        enabled: stickyFoldersEnabled && !isFilteringFileTree,
    });

    const revealFileInHostTree = useCallback(async (
        request: WorkspaceSurfaceFileRevealRequest,
    ) => {
        if (
            useWorkspaceStore.getState().activeContextKey !==
            request.contextKey
        ) {
            // The host may switch workspaces after main validates the request.
            return;
        }
        const targetProjectContextKey = getProjectContextKey(
            request.projectId,
            request.worktreeId,
        );

        setRightCollapsed(false);
        setSidebarView("files");
        setFileTreeFilter("");
        setProjectRootExpandedByContext((currentState) => ({
            ...currentState,
            [targetProjectContextKey]: true,
        }));

        await revealPathInTree(
            request.projectId,
            request.relativePath,
            request.worktreeId,
        );
        setFileTreeRevealSignal((currentSignal) =>
            currentSignal === null ? 0 : currentSignal + 1,
        );
    }, [
        revealPathInTree,
        setFileTreeFilter,
        setRightCollapsed,
        setSidebarView,
    ]);

    const handleRevealActiveFileInTree = useCallback(async () => {
        if (
            activeWorkspaceTab?.kind !== "file" ||
            !activeWorkspaceTab.projectId
        ) {
            return;
        }
        const request: WorkspaceSurfaceFileRevealRequest = {
            contextKey: getProjectContextKey(
                activeWorkspaceTab.projectId,
                activeWorkspaceTab.worktreeId ?? null,
            ),
            projectId: activeWorkspaceTab.projectId,
            relativePath: activeWorkspaceTab.relativePath,
            worktreeId: activeWorkspaceTab.worktreeId ?? null,
        };

        await revealFileInHostTree(request);
    }, [activeWorkspaceTab, revealFileInHostTree]);

    useEffect(() => {
        if (!isWorkspaceHostRenderer) {
            return;
        }
        return getComandoApi()?.onWorkspaceSurfaceFileRevealRequested(
            (request) => {
                void revealFileInHostTree(request).catch((error) => {
                    console.error(
                        "[workspace-host] file reveal execution failed",
                        error,
                    );
                });
            },
        );
    }, [revealFileInHostTree]);

    const handleSidebarViewChange = useCallback(
        (nextSidebarView: WorkspaceInspectorView) => {
            if (sidebarView === nextSidebarView) {
                return;
            }

            if (sidebarView === "files") {
                saveFileTreeScrollPosition();
            }

            setSidebarView(nextSidebarView);
        },
        [saveFileTreeScrollPosition, setSidebarView, sidebarView],
    );

    const setSidebarSearchValue = useCallback(
        (value: string) => {
            setInspectorFilter(sidebarView, value);
        },
        [setInspectorFilter, sidebarView],
    );
    const openWorkspaceFromInspector = useCallback(
        async (
            projectId: string,
            worktreeId: string | null,
        ) => {
            const api = getComandoApi();
            if (!api) {
                throw new Error("The desktop bridge is unavailable.");
            }
            const contextKey = await useWorkspaceStore
                .getState()
                .registerWorkspaceScope(projectId, worktreeId);
            await api.initializeWorkspaceSurfaces(
                useWorkspaceStore.getState().getWorkspaceSurfaceRegistry(),
            );
            const result = await api.activateWorkspaceSurface(contextKey);
            if (result.status === "failed") {
                throw new Error(result.message);
            }
            if (result.status === "stale") {
                throw new Error(
                    "A newer workspace selection replaced this request.",
                );
            }
        },
        [],
    );

    const [appUpdateState, setAppUpdateState] = useState<AppUpdateState>(() =>
        createInitialAppUpdateState(),
    );

    useEffect(() => {
        if (!window.comando) {
            return;
        }

        let cancelled = false;
        void window.comando.getAppUpdateState().then((state) => {
            if (!cancelled) {
                setAppUpdateState(state);
            }
        });

        const unsubscribe = window.comando.onAppUpdateState((state) => {
            setAppUpdateState(state);
        });

        return () => {
            cancelled = true;
            unsubscribe();
        };
    }, []);

    const openSettingsWindow = useCallback((initialCategory?: SettingsWindowCategory) => {
        if (!window.comando) {
            return;
        }

        void window.comando.openSettingsWindow({
            initialCategory,
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
        if (isMac) {
            return;
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.defaultPrevented) {
                return;
            }

            if (!(event.metaKey || event.ctrlKey) || event.altKey) {
                return;
            }

            if (event.shiftKey || event.key.toLowerCase() !== "w") {
                return;
            }

            event.preventDefault();
            requestCloseActiveWorkspaceTab();
        };

        window.addEventListener("keydown", handleKeyDown, true);
        return () => {
            window.removeEventListener("keydown", handleKeyDown, true);
        };
    }, [isMac]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (
                event.defaultPrevented ||
                !(event.metaKey || event.ctrlKey) ||
                event.altKey ||
                !event.shiftKey ||
                event.key.toLowerCase() !== "w" ||
                !workspaceActiveContextKey
            ) {
                return;
            }

            event.preventDefault();
            void requestCloseWorkspaceSurface(workspaceActiveContextKey).catch(
                (error) => {
                    window.alert(
                        error instanceof Error
                            ? error.message
                            : "Could not close this workspace.",
                    );
                },
            );
        };

        window.addEventListener("keydown", handleKeyDown, true);
        return () => {
            window.removeEventListener("keydown", handleKeyDown, true);
        };
    }, [requestCloseWorkspaceSurface, workspaceActiveContextKey]);

    useEffect(() => {
        const isSupportedPlatform =
            bootstrap?.platform === "darwin" ||
            bootstrap?.platform === "linux" ||
            bootstrap?.platform === "win32";
        if (!isSupportedPlatform) {
            return;
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            if (
                event.defaultPrevented ||
                event.shiftKey ||
                !event.altKey ||
                (isMac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey)
            ) {
                return;
            }

            const direction =
                event.code === "BracketRight"
                    ? "next"
                    : event.code === "BracketLeft"
                      ? "previous"
                      : null;
            if (!direction) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            navigateWorkspace(direction);
        };

        window.addEventListener("keydown", handleKeyDown, true);
        return () => {
            window.removeEventListener("keydown", handleKeyDown, true);
        };
    }, [
        bootstrap?.platform,
        isMac,
        navigateWorkspace,
    ]);

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
        void window.comando?.setTrafficLightVisibility(true);
    }, [isMac]);

    useEffect(() => {
        const platform = bootstrap?.platform;
        if (!platform) return;
        document.documentElement.setAttribute("data-platform", platform);
        return () => {
            document.documentElement.removeAttribute("data-platform");
        };
    }, [bootstrap?.platform]);

    const sidebarSearchValue =
        sidebarView === "files"
            ? fileTreeFilter
            : sidebarView === "git"
              ? gitChangesFilter
              : sidebarView === "issues"
                ? issuesFilter
                : sidebarView === "pull_requests"
                  ? pullRequestsFilter
                  : agentsFilter;
    const inspectorOverlayBounds = useMemo(
        () => ({
            left: shellViewportWidth - rightEffectiveWidth,
            width: rightEffectiveWidth,
        }),
        [rightEffectiveWidth, shellViewportWidth],
    );
    const workspaceInspectorContent = (
        <WorkspaceInspector
            activeView={sidebarView}
            error={projectsError}
            filter={sidebarSearchValue}
            gitScopePicker={
                <SidebarGitScopePicker
                    onOpenWorkspace={openWorkspaceFromInspector}
                    overlayBounds={inspectorOverlayBounds}
                    projectId={activeProjectId}
                    worktreeId={activeWorktreeId}
                />
            }
            hasCommittedWorkspace={Boolean(
                workspaceActiveContextKey && activeProjectId,
            )}
            loading={!persistenceReady || !workspaceNavigationHydrated}
            onChangeFilter={setSidebarSearchValue}
            onChangeView={handleSidebarViewChange}
            panels={{
                agents: (
                    <SidebarAgentsPanel
                        filter={agentsFilter}
                        onRequestWorkspaceAction={requestWorkspaceSurfaceAction}
                        projectId={activeProjectId}
                        runtimeCatalog={runtimeCatalog}
                        scrollKey={`agents:${inspectorScopeKey}`}
                        scrollPositionsRef={sidebarScrollPositionsRef}
                        workspaceContextKey={workspaceActiveContextKey}
                        worktreeId={activeWorktreeId}
                    />
                ),
                files: (
                    <FileExplorerPanel
                        activeFilePath={activeFilePath}
                        contextTargetResetSignal={
                            fileTreeContextTargetResetSignal
                        }
                        expandedPaths={
                            isFilteringFileTree
                                ? fileTreeSearchExpandedPaths
                                : activeExpandedDirectories
                        }
                        inlineEditor={fileTreeInlineEditor}
                        isFiltering={isFilteringFileTree}
                        onBackgroundContextMenu={({ x, y }) => {
                            clearFileTreeSelection({
                                suppressActivePathFallback: true,
                            });
                            setFileTreeContextMenu({
                                payload: { kind: "background" },
                                x,
                                y,
                            });
                        }}
                        onBackgroundDrop={(dragData) => {
                            const rootNode = sidebarTreeNodes.find(
                                (node) => node.isProjectRoot,
                            );
                            if (rootNode) {
                                void handleMoveTreeNode(dragData, rootNode);
                            }
                        }}
                        onClearSelection={() =>
                            clearFileTreeSelection({
                                suppressActivePathFallback: true,
                            })
                        }
                        onEditingCancel={cancelFileTreeInlineEditor}
                        onEditingDraftNameChange={(value) => {
                            setFileTreeInlineEditor((current) =>
                                current
                                    ? { ...current, draftName: value }
                                    : null,
                            );
                        }}
                        onEditingSubmit={() => {
                            void submitFileTreeInlineEditor();
                        }}
                        onExternalFilesDrop={(sourcePaths, destinationNode) => {
                            void handleImportExternalTreeEntries(
                                sourcePaths,
                                destinationNode,
                            );
                        }}
                        onNodeClick={handleFileTreeNodeClick}
                        onNodeContextMenu={(node, { x, y }) => {
                            setIsFileTreeSelectionSuppressed(false);
                            const isNodeSelected =
                                selectedFileTreePathSet.has(node.path);
                            if (!isNodeSelected) {
                                setFileTreeSelectedPaths([node.path]);
                                setFileTreeSelectionAnchorPath(node.path);
                            }
                            setFileTreeContextMenu({
                                payload: {
                                    kind: "node",
                                    node,
                                    transientSelectionPath: isNodeSelected
                                        ? null
                                        : node.path,
                                },
                                x,
                                y,
                            });
                        }}
                        onNodeDragStart={handleFileTreeNodeDragStart}
                        onNodeDrop={(dragData, destinationNode) => {
                            void handleMoveTreeNode(dragData, destinationNode);
                        }}
                        onScroll={handleFileTreeScroll}
                        onScrollToActivePathConsumed={() => {
                            setFileTreeRevealSignal(null);
                        }}
                        onToggleDirectory={(node) => {
                            if (node.isProjectRoot) {
                                setProjectRootExpandedByContext((current) => ({
                                    ...current,
                                    [activeProjectContextKey]:
                                        !isProjectRootExpanded,
                                }));
                                return;
                            }
                            if (!activeProjectId) {
                                return;
                            }
                            const treeNode = findProjectTreeNodeByPath(
                                activeTreeNodesByParent,
                                node.path,
                            );
                            if (treeNode) {
                                void toggleDirectory(
                                    activeProjectId,
                                    treeNode,
                                    activeWorktreeId,
                                );
                            }
                        }}
                        project={activeProject}
                        revealSignal={fileTreeRevealSignal}
                        scrollRef={setFileTreeScrollElement}
                        selectedPaths={selectedFileTreePathSet}
                        stickyFolderPaths={stickyFolderPaths}
                        stickyFolders={stickyFolders}
                        stickyFoldersEnabled={stickyFoldersEnabled}
                        suppressKeyboardCursor={
                            isFileTreeSelectionSuppressed
                        }
                        treeNodes={sidebarTreeNodes}
                    />
                ),
                git: activeProjectId ? (
                    <SidebarGitPanel
                        filter={gitChangesFilter}
                        onRequestWorkspaceAction={requestWorkspaceSurfaceAction}
                        projectId={activeProjectId}
                        scrollKey={`git:${inspectorScopeKey}`}
                        scrollPositionsRef={sidebarScrollPositionsRef}
                        workspaceContextKey={workspaceActiveContextKey}
                        worktreeId={activeWorktreeId}
                    />
                ) : null,
                issues: (
                    <SidebarGitHubPanel
                        filter={issuesFilter}
                        kind="issues"
                        onOpenSettings={openSettingsWindow}
                        onRequestWorkspaceAction={requestWorkspaceSurfaceAction}
                        projectId={activeProjectId}
                        scrollKey={`issues:${inspectorScopeKey}`}
                        scrollPositionsRef={sidebarScrollPositionsRef}
                        selectionResetSignal={
                            gitHubSidebarSelectionResetSignal
                        }
                        workspaceContextKey={workspaceActiveContextKey}
                        worktreeId={activeWorktreeId}
                    />
                ),
                pull_requests: (
                    <SidebarGitHubPanel
                        filter={pullRequestsFilter}
                        kind="pull_requests"
                        onOpenSettings={openSettingsWindow}
                        onRequestWorkspaceAction={requestWorkspaceSurfaceAction}
                        projectId={activeProjectId}
                        scrollKey={`pull_requests:${inspectorScopeKey}`}
                        scrollPositionsRef={sidebarScrollPositionsRef}
                        selectionResetSignal={
                            gitHubSidebarSelectionResetSignal
                        }
                        workspaceContextKey={workspaceActiveContextKey}
                        worktreeId={activeWorktreeId}
                    />
                ),
            }}
        />
    );

    const leftSidebarContent = (
        <WorkspaceNavigatorPanel
            model={workspaceNavigatorModel}
            settingsLabel={getSettingsUpdateMenuLabel(appUpdateState)}
        />
    );

    const handleOpenProject = (projectId: string) => {
        void useWorkspaceStore.getState().requestWorkspaceNavigation(projectId);
    };

    const handleOpenProjects = () => {
        void (async () => {
            const projectIds = await addProjects();
            for (const projectId of projectIds) {
                await useWorkspaceStore.getState().requestWorkspaceNavigation(projectId);
            }
        })();
    };

    const workspaceSwitcherEntries = useMemo(
        () =>
            workspaceNavigatorModel.projects.flatMap((project) =>
                project.workspaces.map((workspace) => ({
                    isMissing: workspace.isMissing,
                    projectId: project.id,
                    projectName: project.name,
                    scopeKey: workspace.scopeKey,
                    statusLabel:
                        workspace.scopeKey ===
                        workspaceNavigatorModel.activeScopeKey
                            ? "Active"
                            : workspace.status === "activity"
                              ? "Activity"
                              : workspace.status === "error"
                                ? "Needs attention"
                                : null,
                    worktreeLabel: workspace.label,
                })),
            ),
        [workspaceNavigatorModel],
    );
    const desktopWindowChrome = (
        <DesktopWindowChrome
            inspectorControlsId={
                shellResponsive.right.overlay
                    ? "workspace-inspector-drawer"
                    : "workspace-inspector"
            }
            inspectorExpanded={!shellResponsive.right.collapsed}
            navigatorControlsId={
                shellResponsive.left.overlay
                    ? "workspace-navigator-drawer"
                    : "workspace-navigator"
            }
            navigatorExpanded={!shellResponsive.left.collapsed}
            onToggleInspector={toggleRightCollapsed}
            onToggleNavigator={toggleLeftCollapsed}
            platform={bootstrap?.platform ?? null}
            inspectorToggleRef={inspectorToggleRef}
            navigatorToggleRef={navigatorToggleRef}
        />
    );
    const workspaceSwitcher = (
        <WorkspaceSwitcher
            entries={workspaceSwitcherEntries}
            onActivate={activateWorkspaceFromCatalog}
            onClose={() => setWorkspaceSwitcherOpen(false)}
            open={workspaceSwitcherOpen}
        />
    );
    const shellDrawers = (
        <>
            {shellResponsive.left.overlay &&
            presentedShellDrawerSide !== "left" ? (
                <div hidden id="workspace-navigator-drawer" />
            ) : null}
            {presentedShellDrawerSide === "left" ? (
                <ShellDrawer
                    id="workspace-navigator-drawer"
                    label="Workspace navigator"
                    onDismiss={() => setLeftCollapsed(true)}
                    restoreFocusRef={navigatorToggleRef}
                    side="left"
                    width={shellResponsive.left.width}
                >
                    <div
                        className="flex min-h-0 flex-1 flex-col"
                        onClick={() => focusSurface("navigator")}
                        onFocus={() => focusSurface("navigator")}
                    >
                        {leftSidebarContent}
                    </div>
                </ShellDrawer>
            ) : null}
            {shellResponsive.right.overlay &&
            presentedShellDrawerSide !== "right" ? (
                <div hidden id="workspace-inspector-drawer" />
            ) : null}
            {presentedShellDrawerSide === "right" ? (
                <ShellDrawer
                    id="workspace-inspector-drawer"
                    label="Workspace inspector"
                    onDismiss={() => setRightCollapsed(true)}
                    restoreFocusRef={inspectorToggleRef}
                    side="right"
                    width={shellResponsive.right.width}
                >
                    <div
                        className="min-h-0 flex-1"
                        onClick={() => focusSurface("inspector")}
                        onFocus={() => focusSurface("inspector")}
                    >
                        {workspaceInspectorContent}
                    </div>
                </ShellDrawer>
            ) : null}
        </>
    );

    if (isWorkspaceHostRenderer) {
        return (
            <div
                className="relative flex h-screen min-h-0 flex-col text-text-primary"
                data-platform={bootstrap?.platform ?? undefined}
            >
                <div ref={workspaceHostTitleBarRef}>{desktopWindowChrome}</div>
                {workspaceSwitcher}
                {settingsView ? (
                    <main className="min-h-0 flex-1 overflow-hidden bg-bg-primary">
                        <Suspense
                            fallback={
                                <div className="grid h-full place-items-center text-xs text-text-secondary">
                                    Loading settings…
                                </div>
                            }
                        >
                            <EmbeddedSettingsApp
                                embedded
                                initialCategory={settingsView.initialCategory}
                                initialCategoryRequestId={settingsView.requestId}
                                onClose={() => setSettingsView(null)}
                                projectId={settingsView.projectId}
                            />
                        </Suspense>
                    </main>
                ) : (
                <div
                    className="shell-responsive-grid relative grid min-h-0 flex-1"
                    data-resizing={dragState ? "true" : undefined}
                    style={{ gridTemplateColumns }}
                >
                    <aside
                        aria-hidden={!leftPanelPersistent}
                        className="app-sidebar flex min-h-0 flex-col"
                        aria-label="Workspace navigator"
                        id={
                            shellResponsive.left.overlay
                                ? undefined
                                : "workspace-navigator"
                        }
                        style={
                            leftPanelPersistent
                                ? undefined
                                : { overflow: "hidden" }
                        }
                        data-active={activeSurface === "navigator"}
                        onClick={() => focusSurface("navigator")}
                        onFocus={() => focusSurface("navigator")}
                        tabIndex={leftPanelPersistent ? 0 : -1}
                    >
                        {leftPanelPersistent && leftSidebarContent}
                    </aside>

                    <div
                        style={
                            !leftPanelPersistent
                                ? {
                                      overflow: "hidden",
                                      pointerEvents: "none",
                                  }
                                : undefined
                        }
                    >
                        <SplitHandle
                            controlsId="workspace-navigator"
                            hidden={!leftPanelPersistent}
                            label="Resize workspace navigator"
                            max={leftPanelWidthRange.max}
                            min={leftPanelWidthRange.min}
                            onDecrease={() =>
                                nudgePanel(
                                    "left",
                                    -shellLayoutConstraints.keyboardStep,
                                )
                            }
                            onIncrease={() =>
                                nudgePanel(
                                    "left",
                                    shellLayoutConstraints.keyboardStep,
                                )
                            }
                            onMaximum={() =>
                                resizePanel("left", leftPanelWidthRange.max)
                            }
                            onMinimum={() =>
                                resizePanel("left", leftPanelWidthRange.min)
                            }
                            onPointerDown={(event) =>
                                startDragging(
                                    "left",
                                    event,
                                    leftEffectiveWidth,
                                    setDragState,
                                )
                            }
                            side="left"
                            value={leftEffectiveWidth}
                        />
                    </div>
                    <main className="flex min-h-0 items-center justify-center bg-bg-primary">
                        {!workspaceNavigatorModel.activeScopeKey ? (
                            <div className="max-w-sm px-8 text-center">
                                <h1 className="text-sm font-semibold text-text-primary">
                                    Choose a workspace
                                </h1>
                                <p className="mt-2 text-xs leading-5 text-text-secondary">
                                    Select a primary checkout or worktree from the
                                    navigator. Its layout and renderer will be
                                    restored here.
                                </p>
                            </div>
                        ) : null}
                    </main>
                    <div
                        style={
                            !rightPanelPersistent
                                ? {
                                      overflow: "hidden",
                                      pointerEvents: "none",
                                  }
                                : undefined
                        }
                    >
                        <SplitHandle
                            controlsId="workspace-inspector"
                            hidden={!rightPanelPersistent}
                            label="Resize workspace inspector"
                            max={rightPanelWidthRange.max}
                            min={rightPanelWidthRange.min}
                            onDecrease={() =>
                                nudgePanel(
                                    "right",
                                    -shellLayoutConstraints.keyboardStep,
                                )
                            }
                            onIncrease={() =>
                                nudgePanel(
                                    "right",
                                    shellLayoutConstraints.keyboardStep,
                                )
                            }
                            onMaximum={() =>
                                resizePanel("right", rightPanelWidthRange.max)
                            }
                            onMinimum={() =>
                                resizePanel("right", rightPanelWidthRange.min)
                            }
                            onPointerDown={(event) =>
                                startDragging(
                                    "right",
                                    event,
                                    rightEffectiveWidth,
                                    setDragState,
                                )
                            }
                            side="right"
                            value={rightEffectiveWidth}
                        />
                    </div>
                    <aside
                        aria-label="Workspace inspector"
                        aria-hidden={!rightPanelPersistent}
                        className="app-sidebar min-h-0"
                        data-active={activeSurface === "inspector"}
                        data-shell-panel="right"
                        id={
                            shellResponsive.right.overlay
                                ? undefined
                                : "workspace-inspector"
                        }
                        onClick={() => focusSurface("inspector")}
                        onFocus={() => focusSurface("inspector")}
                        style={
                            rightPanelPersistent
                                ? undefined
                                : { overflow: "hidden" }
                        }
                        tabIndex={rightPanelPersistent ? 0 : -1}
                    >
                        {rightPanelPersistent && workspaceInspectorContent}
                    </aside>

                    {shellDrawers}
                </div>
                )}
            </div>
        );
    }

    return (
        <div
            className="min-h-screen text-text-primary"
            data-platform={bootstrap?.platform ?? undefined}
        >
            <div className="relative h-screen">
                <div className="flex h-full flex-col overflow-hidden">
                    {desktopWindowChrome}
                    {workspaceSwitcher}
                    <div
                        className="shell-responsive-grid relative grid min-h-0 flex-1"
                        data-resizing={dragState ? "true" : undefined}
                        style={{
                            gridTemplateColumns,
                        }}
                    >
                        <aside
                            aria-label="Workspace navigator"
                            aria-hidden={!leftPanelPersistent}
                            className="app-sidebar flex min-h-0 flex-col"
                            id={
                                shellResponsive.left.overlay
                                    ? undefined
                                    : "workspace-navigator"
                            }
                            style={
                                leftPanelPersistent
                                    ? undefined
                                    : { overflow: "hidden" }
                            }
                            data-active={activeSurface === "navigator"}
                            onClick={() => focusSurface("navigator")}
                            onFocus={() => focusSurface("navigator")}
                            tabIndex={leftPanelPersistent ? 0 : -1}
                        >
                            {leftPanelPersistent && leftSidebarContent}
                        </aside>

                        <div
                            style={
                                !leftPanelPersistent
                                    ? {
                                          overflow: "hidden",
                                          pointerEvents: "none",
                                      }
                                    : undefined
                            }
                        >
                            <SplitHandle
                                controlsId="workspace-navigator"
                                hidden={!leftPanelPersistent}
                                label="Resize workspace navigator"
                                max={leftPanelWidthRange.max}
                                min={leftPanelWidthRange.min}
                                onDecrease={() =>
                                    nudgePanel(
                                        "left",
                                        -shellLayoutConstraints.keyboardStep,
                                    )
                                }
                                onIncrease={() =>
                                    nudgePanel(
                                        "left",
                                        shellLayoutConstraints.keyboardStep,
                                    )
                                }
                                onMaximum={() =>
                                    resizePanel(
                                        "left",
                                        leftPanelWidthRange.max,
                                    )
                                }
                                onMinimum={() =>
                                    resizePanel(
                                        "left",
                                        leftPanelWidthRange.min,
                                    )
                                }
                                onPointerDown={(event) =>
                                    startDragging(
                                        "left",
                                        event,
                                        leftEffectiveWidth,
                                        setDragState,
                                    )
                                }
                                side="left"
                                value={leftEffectiveWidth}
                            />
                        </div>

                        <main
                            className="surface-focus min-h-0 bg-bg-primary"
                            data-active={activeSurface === "workspace"}
                            onFocus={focusWorkspaceSurface}
                            onPointerDown={focusWorkspaceSurface}
                            tabIndex={0}
                        >
                            <LegacyWorkspaceTerminalHost />
                            <LegacyWorkspaceView
                                defaultProjectId={activeProjectId}
                                defaultWorktreeId={activeWorktreeId}
                                onOpenProject={handleOpenProject}
                                onOpenProjects={handleOpenProjects}
                                onRequestCreateFile={() => {
                                    void handleCreateTreeEntry("file", null);
                                }}
                                recentProjects={workspaceRecentProjects}
                                runtimeCatalog={runtimeCatalog}
                            />
                        </main>
                        <div
                            style={
                                !rightPanelPersistent
                                    ? {
                                          overflow: "hidden",
                                          pointerEvents: "none",
                                      }
                                    : undefined
                            }
                        >
                            <SplitHandle
                                controlsId="workspace-inspector"
                                hidden={!rightPanelPersistent}
                                label="Resize workspace inspector"
                                max={rightPanelWidthRange.max}
                                min={rightPanelWidthRange.min}
                                onDecrease={() =>
                                    nudgePanel(
                                        "right",
                                        -shellLayoutConstraints.keyboardStep,
                                    )
                                }
                                onIncrease={() =>
                                    nudgePanel(
                                        "right",
                                        shellLayoutConstraints.keyboardStep,
                                    )
                                }
                                onMaximum={() =>
                                    resizePanel(
                                        "right",
                                        rightPanelWidthRange.max,
                                    )
                                }
                                onMinimum={() =>
                                    resizePanel(
                                        "right",
                                        rightPanelWidthRange.min,
                                    )
                                }
                                onPointerDown={(event) =>
                                    startDragging(
                                        "right",
                                        event,
                                        rightEffectiveWidth,
                                        setDragState,
                                    )
                                }
                                side="right"
                                value={rightEffectiveWidth}
                            />
                        </div>
                        <aside
                            aria-label="Workspace inspector"
                            aria-hidden={!rightPanelPersistent}
                            className="app-sidebar min-h-0"
                            data-active={activeSurface === "inspector"}
                            data-shell-panel="right"
                            id={
                                shellResponsive.right.overlay
                                    ? undefined
                                    : "workspace-inspector"
                            }
                            onClick={() => focusSurface("inspector")}
                            onFocus={() => focusSurface("inspector")}
                            style={
                                rightPanelPersistent
                                    ? undefined
                                    : { overflow: "hidden" }
                            }
                            tabIndex={rightPanelPersistent ? 0 : -1}
                        >
                            {rightPanelPersistent && workspaceInspectorContent}
                        </aside>

                        {shellDrawers}
                    </div>
                </div>

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
                    onClose={closeFileTreeContextMenu}
                />
            ) : null}

            <FileTreeMoveDestinationPicker
                destinations={fileTreeMoveDestinations}
                entries={fileTreeMovePickerEntries ?? []}
                onChangeQuery={setFileTreeMovePickerQuery}
                onClose={closeFileTreeMovePicker}
                onHoverIndex={setFileTreeMovePickerSelectedIndex}
                onSelect={handleFileTreeMoveDestinationSelect}
                open={fileTreeMovePickerEntries !== null}
                query={fileTreeMovePickerQuery}
                selectedIndex={resolvedFileTreeMovePickerSelectedIndex}
            />
        </div>
    );
}

export const App = WorkspaceHostApp;

function FileTreeMoveDestinationPicker({
    destinations,
    entries,
    onChangeQuery,
    onClose,
    onHoverIndex,
    onSelect,
    open,
    query,
    selectedIndex,
}: {
    readonly destinations: readonly FileTreeMoveDestination[];
    readonly entries: readonly GitTreeDragData[];
    readonly onChangeQuery: (value: string) => void;
    readonly onClose: () => void;
    readonly onHoverIndex: (index: number) => void;
    readonly onSelect: (destination: FileTreeMoveDestination) => void;
    readonly open: boolean;
    readonly query: string;
    readonly selectedIndex: number;
}) {
    const backdropRef = useRef<HTMLDivElement | null>(null);
    const dialogRef = useRef<HTMLDivElement | null>(null);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const listRef = useRef<HTMLDivElement | null>(null);
    useModalFocusScope({
        active: open,
        containerRef: dialogRef,
        initialFocusRef: inputRef,
        modalRootRef: backdropRef,
        onDismiss: onClose,
    });

    useEffect(() => {
        if (!open) {
            return;
        }

        const selectedElement = listRef.current?.querySelector<HTMLElement>(
            "[data-move-destination-selected='true']",
        );
        selectedElement?.scrollIntoView({ block: "nearest" });
    }, [open, selectedIndex]);

    if (!open) {
        return null;
    }

    const selectedDestination = destinations[selectedIndex] ?? null;
    const itemCountLabel =
        entries.length === 1 ? "1 item" : `${entries.length} items`;

    const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
        }

        if (destinations.length === 0) {
            return;
        }

        if (event.key === "ArrowDown") {
            event.preventDefault();
            onHoverIndex(
                findNextFileTreeMoveDestinationIndex(
                    destinations,
                    selectedIndex,
                    1,
                ),
            );
            return;
        }

        if (event.key === "ArrowUp") {
            event.preventDefault();
            onHoverIndex(
                findNextFileTreeMoveDestinationIndex(
                    destinations,
                    selectedIndex,
                    -1,
                ),
            );
            return;
        }

        if (event.key === "Home") {
            event.preventDefault();
            onHoverIndex(resolveFileTreeMovePickerSelectedIndex(destinations, 0));
            return;
        }

        if (event.key === "End") {
            event.preventDefault();
            onHoverIndex(
                resolveFileTreeMovePickerSelectedIndex(
                    destinations,
                    destinations.length - 1,
                ),
            );
            return;
        }

        if (event.key === "Enter") {
            event.preventDefault();
            if (selectedDestination?.canMove) {
                onSelect(selectedDestination);
            }
        }
    };

    return createPortal(
        <div
            className="shell-modal-backdrop app-no-drag fixed inset-0 z-10030 flex items-start justify-center px-5 pt-[min(14vh,104px)]"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                    onClose();
                }
            }}
            style={{
                background:
                    "color-mix(in srgb, var(--color-bg-primary) 70%, transparent)",
                backdropFilter: "blur(10px)",
            }}
            ref={backdropRef}
        >
            <div
                aria-label="Move files to folder"
                aria-modal="true"
                className="app-no-drag flex w-full max-w-[520px] flex-col overflow-hidden rounded-lg border"
                ref={dialogRef}
                role="dialog"
                style={{
                    background: "var(--color-bg-elevated)",
                    borderColor:
                        "color-mix(in srgb, var(--color-border) 80%, transparent)",
                    boxShadow:
                        "0 24px 80px rgba(0, 0, 0, 0.22), 0 0 0 1px color-mix(in srgb, var(--color-border) 40%, transparent)",
                }}
                tabIndex={-1}
            >
                <div
                    className="border-b px-3.5 py-2.5"
                    style={{
                        borderColor:
                            "color-mix(in srgb, var(--color-border) 60%, transparent)",
                    }}
                >
                    <div className="mb-2 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                            <div className="truncate text-[13px] font-medium text-text-primary">
                                Move to Folder
                            </div>
                            <div className="truncate text-[11px] text-text-secondary/75">
                                {itemCountLabel}
                            </div>
                        </div>
                    </div>
                    <input
                        aria-label="Search destination folders"
                        autoCapitalize="off"
                        autoComplete="off"
                        autoCorrect="off"
                        className="w-full rounded-md border bg-bg-primary px-2.5 py-1.75 text-[13px] text-text-primary outline-none placeholder:text-text-secondary/60"
                        onChange={(event) => onChangeQuery(event.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Search folders..."
                        ref={inputRef}
                        spellCheck={false}
                        style={{
                            borderColor:
                                "color-mix(in srgb, var(--color-border) 60%, transparent)",
                        }}
                        type="text"
                        value={query}
                    />
                </div>

                <div
                    className="shell-scrollbar max-h-[min(48vh,380px)] overflow-y-auto py-1"
                    ref={listRef}
                >
                    {destinations.length > 0 ? (
                        destinations.map((destination, index) => {
                            const isSelected = index === selectedIndex;

                            return (
                                <button
                                    className={[
                                        "flex w-full items-center gap-2.5 px-3.5 py-1.5 text-left transition",
                                        destination.canMove
                                            ? "text-text-primary"
                                            : "text-text-secondary/45",
                                    ].join(" ")}
                                    data-move-destination-selected={isSelected}
                                    disabled={!destination.canMove}
                                    key={destination.path ?? ROOT_NODE_KEY}
                                    onClick={() => onSelect(destination)}
                                    onMouseEnter={() => onHoverIndex(index)}
                                    style={{
                                        background: isSelected
                                            ? "color-mix(in srgb, var(--color-accent) 14%, var(--color-bg-primary))"
                                            : "transparent",
                                        paddingLeft: 14 + destination.depth * 14,
                                    }}
                                    title={
                                        destination.invalidReason ??
                                        destination.pathLabel
                                    }
                                    type="button"
                                >
                                    <FolderTypeIcon
                                        folderName={destination.name}
                                        opacity={
                                            destination.canMove ? 0.9 : 0.45
                                        }
                                        open={isSelected}
                                        size={15}
                                    />
                                    <span className="min-w-0 flex-1 truncate text-[13px]">
                                        {destination.name}
                                    </span>
                                    <span className="min-w-0 truncate font-mono text-[11px] text-text-secondary/70">
                                        {destination.invalidReason ??
                                            destination.pathLabel}
                                    </span>
                                </button>
                            );
                        })
                    ) : (
                        <div className="px-3.5 py-6 text-center text-[12px] text-text-secondary">
                            No matching folders
                        </div>
                    )}
                </div>

                <div
                    className="flex items-center justify-between border-t px-3.5 py-1.5 text-[11px] text-text-secondary/70"
                    style={{
                        borderColor:
                            "color-mix(in srgb, var(--color-border) 50%, transparent)",
                    }}
                >
                    <span>
                        {selectedDestination?.invalidReason ??
                            "Select a destination"}
                    </span>
                    <span>↑↓ Navigate · Enter Move · Esc Close</span>
                </div>
            </div>
        </div>,
        document.body,
    );
}

function createInitialAppUpdateState(): AppUpdateState {
    return {
        autoUpdatesEnabled: false,
        availableVersion: null,
        canCheckForUpdates: false,
        canInstallUpdate: false,
        currentVersion: "",
        downloadedVersion: null,
        lastCheckedAt: null,
        message: "Auto-updates are initializing.",
        progressPercent: null,
        status: "unsupported",
    };
}

function getSettingsUpdateMenuLabel(state: AppUpdateState): string | null {
    if (state.canInstallUpdate || state.status === "downloaded") {
        return "Settings · Update ready";
    }

    if (state.status === "downloading" || state.status === "available") {
        return "Settings · Downloading update";
    }

    if (state.availableVersion || state.downloadedVersion) {
        return "Settings · Update available";
    }

    return null;
}

function isSettingsWindowCategory(
    value: string | null,
): value is SettingsWindowCategory {
    return (
        value === "appearance" ||
        value === "editor" ||
        value === "terminal" ||
        value === "projects" ||
        value === "github" ||
        value === "ai" ||
        value === "privacy" ||
        value === "shortcuts" ||
        value === "runtimes" ||
        value === "updates"
    );
}

function normalizeFileTreeClipboardWorktreeId(
    worktreeId: string | null | undefined,
): string {
    return worktreeId ?? "__primary__";
}

function getComandoApi(): ComandoApi | null {
    return "comando" in window ? window.comando : null;
}

function startDragging(
    side: ShellPanelSide,
    event: ReactPointerEvent<HTMLDivElement>,
    startWidth: number,
    setDragState: (dragState: DragState) => void,
): void {
    if (!isPrimaryPointerButton(event.button)) {
        return;
    }

    event.preventDefault();
    setDragState({
        side,
        startWidth,
        startX: event.clientX,
    });
}
