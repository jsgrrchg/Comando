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
    type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import type {
    AppUpdateState,
    ComandoApi,
    GitRepositorySnapshot,
    GitWorktreeSummary,
    PersistenceSnapshot,
    ProjectTreeNode,
    ProjectSummary,
    SettingsWindowCategory,
    SettingsSnapshot,
} from "@shared/ipc";
import { resolveEditorLanguage } from "@shared/editor-language";
import { isActiveAiRuntimeId } from "@shared/ai-runtimes";

import { useSystemTheme } from "./app/hooks/use-system-theme";
import { setCachedAppEditorSettings } from "./app/settings/client";
import {
    buildGitTreeNodesFromProjectTree,
    buildHierarchicalGitTreeNodesFromProjectEntries,
    findProjectTreeNodeByPath,
} from "./app/projects/git-tree";
import { createGitProjectRefreshScheduler } from "./app/git/refresh-scheduler";
import {
    areGitWorktreeIdsEquivalent,
    resolveProjectContextWorktreeId,
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
import {
    searchProjectQuickOpenEntries,
    type ProjectQuickOpenMatch,
} from "./app/projects/quick-open";
import { filterProjectEntriesForTreeFilter } from "./app/projects/tree-filter";
import { getProjectContextKey } from "./app/projects/context-key";
import { shellLayoutConstraints } from "./app/layout/shell-layout";
import {
    edgePeekConfig,
    isPointInsideInflatedRect,
    type EdgePeekPointerPosition,
} from "./app/layout/edge-peek";
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
import { useShellStore } from "./app/store/shell-store";
import {
    getBestMatchingChatTabId,
    useWorkspaceStore,
} from "./app/store/workspace-store";
import { findPaneById, type RuntimeWorkspaceTab } from "./app/workspace/tree";
import {
    compactGitTreeEntriesByAncestor,
    compactGitTreeEntriesForDeletion,
    compactGitTreeDragEntriesByAncestor,
    flattenVisibleGitTreeNodes,
    getProjectEntryMoveValidation,
    GitTreeView,
    resolveGitTreeDragPaths,
    type GitTreeDragData,
    type GitTreeDragPayload,
    type GitTreeNode,
    type GitTreeNodeActivationEvent,
} from "./components/git";
import { StickyFolderOverlay } from "./components/git/StickyFolderOverlay";
import { useStickyFolders } from "./components/git/useStickyFolders";
import { FolderTypeIcon } from "./components/icons/FolderTypeIcon";
import {
    ContextMenu,
    type ContextMenuEntry,
    type ContextMenuState,
} from "./components/context-menu/ContextMenu";
import {
    SidebarAgentsPanel,
    SidebarGitHubPanel,
    SidebarGitPanel,
    type SidebarGitHubAddToChatRequest,
} from "./components/sidebar";
import {
    appendComposerParts,
    createEmptyComposerParts,
    type AIComposerPart,
} from "./components/workspace/chat/composerParts";
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
import {
    createWorkspaceQuickDirectory,
    createWorkspaceQuickFile,
} from "./components/workspace/quick-create";
import { QuickOpenFilePalette } from "./components/workspace/QuickOpenFilePalette";
import { closeWorkspaceTabsWithConfirmation } from "./components/workspace/workspaceCloseGuard";
import {
    DesktopTopBar,
    type ProjectContextMenuProject,
    type ProjectContextTabItem,
} from "./components/DesktopTopBar";
import { WorkspaceView } from "./components/workspace/WorkspaceView";
import { WorkspaceTerminalHost } from "./features/terminal/WorkspaceTerminalHost";

type DragState = {
    readonly side: "left";
    readonly startWidth: number;
    readonly startX: number;
} | null;

type SidebarView = "files" | "git" | "agents" | "issues" | "pull_requests";

const ROOT_NODE_KEY = "__root__";
const PROJECT_SEARCH_FOLLOWUP_DEBOUNCE_MS = 50;

function collectProjectWorktrees(
    snapshots: Readonly<Record<string, GitRepositorySnapshot | null>>,
    projectId: string,
): readonly GitWorktreeSummary[] {
    const worktreesById = new Map<string, GitWorktreeSummary>();
    for (const snapshot of Object.values(snapshots)) {
        if (snapshot?.projectId !== projectId) {
            continue;
        }
        for (const worktree of snapshot.worktrees) {
            worktreesById.set(worktree.id, worktree);
        }
    }
    return [...worktreesById.values()];
}

function getWorktreeDisplayLabel(worktree: GitWorktreeSummary): string {
    if (worktree.branchName) {
        return worktree.branchName;
    }

    const pathParts = worktree.rootPath.split(/[\\/]/).filter(Boolean);
    return pathParts.at(-1) ?? "Detached worktree";
}

type FileTreeContextMenuPayload =
    | {
          readonly kind: "background";
      }
    | {
          readonly kind: "node";
          readonly node: GitTreeNode;
          readonly transientSelectionPath: string | null;
      };

type FileTreeInlineEditorState = {
    readonly draftName: string;
    readonly kind: "directory" | "file";
    readonly originalName: string;
    readonly path: string;
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
    const openWorkspaceContextKeys = useWorkspaceStore(
        (state) => state.openContextKeys,
    );
    const activeWorkspaceContext = useWorkspaceStore((state) =>
        state.activeContextKey
            ? (state.contextsByKey[state.activeContextKey] ?? null)
            : null,
    );
    const activeProjectId =
        activeWorkspaceContext?.projectId ??
        (workspaceNavigationHydrated ? null : persistedActiveProjectId);
    const addProjects = useProjectsStore((state) => state.addProjects);
    const cloneRepository = useProjectsStore((state) => state.cloneRepository);
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
    const gitSnapshots = useGitStore((state) => state.snapshots);
    const setActiveWorktree = useGitStore((state) => state.setActiveWorktree);
    const selectGitBranch = useGitStore((state) => state.selectBranch);

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
    const requestCloseWorkspaceContext = useCallback((contextKey: string) => {
        const workspaceState = useWorkspaceStore.getState();
        const context = workspaceState.contextsByKey[contextKey];
        if (!context) {
            return Promise.resolve();
        }

        const tabsById =
            workspaceState.activeContextKey === contextKey
                ? workspaceState.tabsById
                : context.workspace.tabsById;
        return closeWorkspaceTabsWithConfirmation(
            Object.keys(tabsById),
            () => useWorkspaceStore.getState().closeContext(contextKey),
            { tabsById },
        );
    }, []);
    const requestMoveWorkspaceContextToNewWindow = useCallback(
        (contextKey: string) => {
            const workspaceState = useWorkspaceStore.getState();
            const context = workspaceState.contextsByKey[contextKey];
            const workspaceSnapshot =
                workspaceState.getContextNavigationSnapshot(contextKey);
            if (!context || !workspaceSnapshot) {
                return Promise.resolve();
            }

            const tabsById =
                workspaceState.activeContextKey === contextKey
                    ? workspaceState.tabsById
                    : context.workspace.tabsById;
            return closeWorkspaceTabsWithConfirmation(
                Object.keys(tabsById),
                async () => {
                    const comandoApi = getComandoApi();
                    if (!comandoApi) {
                        throw new Error("The desktop bridge is unavailable.");
                    }

                    await comandoApi.openProjectWindow({
                        forceNewWindow: true,
                        projectId: context.projectId,
                        workspaceSnapshot,
                        worktreeId: context.worktreeId,
                    });
                    await useWorkspaceStore.getState().closeContext(contextKey);
                },
                { tabsById },
            );
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
    const setResizingPanel = useShellStore((state) => state.setResizingPanel);
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
    const setDraftComposerParts = useAiStore(
        (state) => state.setDraftComposerParts,
    );
    const hydrateAiSettings = useAiStore((state) => state.hydrateSettings);
    const stickyFoldersEnabled = useSettingsStore(
        (state) => state.appearance.stickyFoldersEnabled,
    );

    const [dragState, setDragState] = useState<DragState>(null);
    const [fileTreeContextMenu, setFileTreeContextMenu] =
        useState<ContextMenuState<FileTreeContextMenuPayload> | null>(null);
    const [isFileTreeSearchOpen, setIsFileTreeSearchOpen] = useState(false);
    const [projectRootExpandedByContext, setProjectRootExpandedByContext] =
        useState<Record<string, boolean>>({});
    const [fileTreeFilter, setFileTreeFilter] = useState("");
    const [fileTreeEntryIndexByContext, setFileTreeEntryIndexByContext] =
        useState<Record<string, readonly ProjectTreeNode[]>>({});
    const [fileTreeBackendSearchResults, setFileTreeBackendSearchResults] =
        useState<readonly ProjectTreeNode[]>([]);
    const [isQuickOpenOpen, setIsQuickOpenOpen] = useState(false);
    const [isQuickOpenLoading, setIsQuickOpenLoading] = useState(false);
    const [quickOpenQuery, setQuickOpenQuery] = useState("");
    const [quickOpenSearchResults, setQuickOpenSearchResults] = useState<
        readonly ProjectTreeNode[]
    >([]);
    const [quickOpenSelectedIndex, setQuickOpenSelectedIndex] = useState(0);
    const [fileTreeInlineEditor, setFileTreeInlineEditor] =
        useState<FileTreeInlineEditorState | null>(null);
    const [fileTreeClipboard, setFileTreeClipboard] =
        useState<FileTreeClipboardState | null>(null);
    const [fileTreeMovePickerEntries, setFileTreeMovePickerEntries] = useState<
        readonly GitTreeDragData[] | null
    >(null);
    const [fileTreeMovePickerQuery, setFileTreeMovePickerQuery] = useState("");
    const [fileTreeMovePickerSelectedIndex, setFileTreeMovePickerSelectedIndex] =
        useState(0);
    const [persistenceReady, setPersistenceReady] = useState(false);
    const [sidebarOverlayVisible, setSidebarOverlayVisible] = useState(false);
    const [sidebarOverlayClosing, setSidebarOverlayClosing] = useState(false);
    const [gitChangesFilter, setGitChangesFilter] = useState("");
    const [agentsFilter, setAgentsFilter] = useState("");
    const [issuesFilter, setIssuesFilter] = useState("");
    const [pullRequestsFilter, setPullRequestsFilter] = useState("");
    const [
        gitHubSidebarSelectionResetSignal,
        setGitHubSidebarSelectionResetSignal,
    ] = useState(0);
    const [
        fileTreeContextTargetResetSignal,
        setFileTreeContextTargetResetSignal,
    ] = useState(0);
    const [fileTreeSelectedPaths, setFileTreeSelectedPaths] = useState<
        readonly string[]
    >([]);
    const [fileTreeSelectionAnchorPath, setFileTreeSelectionAnchorPath] =
        useState<string | null>(null);
    const [
        isFileTreeSelectionSuppressed,
        setIsFileTreeSelectionSuppressed,
    ] = useState(false);
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
    const sidebarOverlayRef = useRef<HTMLDivElement | null>(null);
    const sidebarPointerRef = useRef<EdgePeekPointerPosition | null>(null);
    const sidebarDragActiveRef = useRef(false);
    const quickOpenSearchRequestRef = useRef(0);
    const sidebarScrollRef = useRef<HTMLDivElement | null>(null);
    const sidebarScrollPositionsRef = useRef<SidebarScrollPositionStore>(
        new Map(),
    );

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
                await workspaceHydrate({
                    activeProjectId: persistedProjectId,
                    activeWorktreeId: persistedWorktreeId,
                });
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

        const unsubscribe = comandoApi.onProjectWindowRequested((payload) => {
            void (async () => {
                const requestedWorktreeId =
                    payload.worktreeId !== undefined
                        ? (payload.worktreeId ?? null)
                        : (useGitStore.getState().activeWorktreeIds[
                              payload.projectId
                          ] ?? null);

                await useWorkspaceStore
                    .getState()
                    .openContext(payload.projectId, requestedWorktreeId);

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
                void refreshGitProject(projectId, worktreeId);
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
                void refreshGitHistory(payload.projectId, preferredWorktreeId);
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

    const gitActiveWorktreeId = useGitStore((state) =>
        activeProjectId
            ? (state.activeWorktreeIds[activeProjectId] ?? null)
            : null,
    );
    const activeWorktreeId = activeWorkspaceContext
        ? // Macro contexts use null for the logical primary checkout, while
          // scoped services persist and query its canonical worktree id.
          resolveProjectContextWorktreeId(
              activeWorkspaceContext.projectId,
              activeWorkspaceContext.worktreeId,
              gitActiveWorktreeId,
          )
        : workspaceNavigationHydrated
          ? null
          : gitActiveWorktreeId;
    const activeProjectContextKey = getProjectContextKey(
        activeProjectId,
        activeWorktreeId,
    );
    const activeGitContextKey = getGitContextKey(
        activeProjectId,
        activeWorktreeId,
    );

    useEffect(() => {
        if (!activeWorkspaceContext) {
            return;
        }

        let cancelled = false;
        const { projectId, worktreeId } = activeWorkspaceContext;
        void (async () => {
            await setActiveWorktree(projectId, worktreeId);
            if (useProjectsStore.getState().activeProjectId !== projectId) {
                await setActiveProject(projectId);
            }
            if (cancelled) {
                return;
            }

            await Promise.all([
                refreshProjectTree(projectId, worktreeId),
                refreshGitProject(projectId, worktreeId),
                refreshGitHistory(projectId, worktreeId),
            ]);
        })();

        return () => {
            cancelled = true;
        };
    }, [
        activeWorkspaceContext,
        refreshGitHistory,
        refreshGitProject,
        refreshProjectTree,
        setActiveProject,
        setActiveWorktree,
    ]);

    useEffect(() => {
        return scheduleEffectStateUpdate(() => {
            setFileTreeFilter("");
            setFileTreeBackendSearchResults([]);
            setFileTreeContextMenu(null);
            setFileTreeSelectedPaths([]);
            setFileTreeSelectionAnchorPath(null);
            setIsFileTreeSearchOpen(false);
            setIsQuickOpenLoading(false);
            setIsQuickOpenOpen(false);
            setQuickOpenQuery("");
            setQuickOpenSearchResults([]);
            setQuickOpenSelectedIndex(0);
        });
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

    useEffect(() => {
        const normalizedQuery = quickOpenQuery.trim();

        if (
            !isQuickOpenOpen ||
            !activeProjectId ||
            !normalizedQuery ||
            !window.comando
        ) {
            quickOpenSearchRequestRef.current += 1;
            return scheduleEffectStateUpdate(() => {
                setQuickOpenSearchResults([]);
                setIsQuickOpenLoading(false);
            });
        }

        const cancelLoadingUpdate = scheduleEffectStateUpdate(() => {
            setIsQuickOpenLoading(true);
        });
        const requestId = quickOpenSearchRequestRef.current + 1;
        quickOpenSearchRequestRef.current = requestId;
        const search = () => {
            void window.comando
                .searchProjectEntries({
                    limit: 120,
                    projectId: activeProjectId,
                    query: normalizedQuery,
                    searchContext: "quick-open",
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
        };

        const delayMs = getProjectSearchDelayMs(normalizedQuery);
        if (delayMs === 0) {
            search();
            return cancelLoadingUpdate;
        }

        const timeoutId = window.setTimeout(search, delayMs);

        return () => {
            cancelLoadingUpdate();
            window.clearTimeout(timeoutId);
        };
    }, [activeProjectId, activeWorktreeId, isQuickOpenOpen, quickOpenQuery]);

    useEffect(() => {
        if (!isQuickOpenOpen) {
            return;
        }

        return scheduleEffectStateUpdate(() => {
            setQuickOpenSelectedIndex(0);
        });
    }, [isQuickOpenOpen, quickOpenQuery]);

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

    const cancelSidebarOverlayClose = useCallback(() => {
        setSidebarOverlayClosing(false);
    }, []);

    const hideSidebarOverlayImmediately = useCallback(() => {
        sidebarDragActiveRef.current = false;
        setSidebarOverlayClosing(false);
        setSidebarOverlayVisible(false);
    }, []);

    const rememberSidebarPointer = useCallback(
        (event: ReactMouseEvent<HTMLDivElement>) => {
            sidebarPointerRef.current = {
                x: event.clientX,
                y: event.clientY,
            };
        },
        [],
    );

    const isSidebarPointerInSafeZone = useCallback(() => {
        const rect = sidebarOverlayRef.current?.getBoundingClientRect() ?? null;
        return isPointInsideInflatedRect(
            sidebarPointerRef.current,
            rect,
            edgePeekConfig.safeGap,
        );
    }, []);

    const showSidebarOverlay = useCallback(
        (event: ReactMouseEvent<HTMLDivElement>) => {
            rememberSidebarPointer(event);
            cancelSidebarOverlayClose();
            setSidebarOverlayVisible(true);
        },
        [cancelSidebarOverlayClose, rememberSidebarPointer],
    );

    const hideSidebarOverlayWithAnimation = useCallback(() => {
        if (
            sidebarDragActiveRef.current ||
            sidebarOverlayClosing ||
            isSidebarPointerInSafeZone()
        ) {
            return;
        }

        setSidebarOverlayClosing(true);
    }, [isSidebarPointerInSafeZone, sidebarOverlayClosing]);

    const startSidebarOriginDrag = useCallback(() => {
        sidebarDragActiveRef.current = true;
        cancelSidebarOverlayClose();
        setSidebarOverlayVisible(true);
    }, [cancelSidebarOverlayClose]);

    const finishSidebarOriginDrag = useCallback(() => {
        if (!sidebarDragActiveRef.current) {
            return;
        }

        sidebarDragActiveRef.current = false;
        if (leftCollapsed) {
            hideSidebarOverlayWithAnimation();
        }
    }, [hideSidebarOverlayWithAnimation, leftCollapsed]);

    const isPointInsideSidebarOverlay = useCallback(
        (point: EdgePeekPointerPosition) => {
            const rect =
                sidebarOverlayRef.current?.getBoundingClientRect() ?? null;
            if (!rect || (rect.width <= 0 && rect.height <= 0)) {
                return false;
            }

            return (
                point.x >= rect.left &&
                point.x <= rect.right &&
                point.y >= rect.top &&
                point.y <= rect.bottom
            );
        },
        [],
    );

    useEffect(() => {
        const handleSidebarOriginDrag = (
            detail: SidebarAgentDragDetail | SidebarGitHubDragDetail,
        ) => {
            if (!detail) {
                return;
            }

            if (Number.isFinite(detail.x) && Number.isFinite(detail.y)) {
                sidebarPointerRef.current = {
                    x: detail.x,
                    y: detail.y,
                };
            }

            if (detail.phase === "start" || detail.phase === "move") {
                const startedInsideSidebarOverlay =
                    detail.phase === "start" &&
                    leftCollapsed &&
                    sidebarOverlayVisible &&
                    isPointInsideSidebarOverlay({
                        x: detail.x,
                        y: detail.y,
                    });

                if (
                    !sidebarDragActiveRef.current &&
                    !startedInsideSidebarOverlay
                ) {
                    return;
                }

                startSidebarOriginDrag();
                return;
            }

            if (detail.phase === "end" || detail.phase === "cancel") {
                finishSidebarOriginDrag();
            }
        };

        const handleSidebarAgentDrag = (event: Event) => {
            handleSidebarOriginDrag(
                (event as CustomEvent<SidebarAgentDragDetail>).detail,
            );
        };

        const handleSidebarGitHubDrag = (event: Event) => {
            handleSidebarOriginDrag(
                (event as CustomEvent<SidebarGitHubDragDetail>).detail,
            );
        };

        window.addEventListener(SIDEBAR_AGENT_DRAG_EVENT, handleSidebarAgentDrag);
        window.addEventListener(
            SIDEBAR_GITHUB_DRAG_EVENT,
            handleSidebarGitHubDrag,
        );
        return () => {
            window.removeEventListener(
                SIDEBAR_AGENT_DRAG_EVENT,
                handleSidebarAgentDrag,
            );
            window.removeEventListener(
                SIDEBAR_GITHUB_DRAG_EVENT,
                handleSidebarGitHubDrag,
            );
        };
    }, [
        finishSidebarOriginDrag,
        isPointInsideSidebarOverlay,
        leftCollapsed,
        sidebarOverlayVisible,
        startSidebarOriginDrag,
    ]);

    useEffect(() => {
        if (!sidebarOverlayVisible) {
            return;
        }

        const handlePointerMove = (event: PointerEvent) => {
            sidebarPointerRef.current = {
                x: event.clientX,
                y: event.clientY,
            };

            if (isSidebarPointerInSafeZone()) {
                cancelSidebarOverlayClose();
                return;
            }

            hideSidebarOverlayWithAnimation();
        };

        window.addEventListener("pointermove", handlePointerMove);
        return () => {
            window.removeEventListener("pointermove", handlePointerMove);
        };
    }, [
        cancelSidebarOverlayClose,
        hideSidebarOverlayWithAnimation,
        isSidebarPointerInSafeZone,
        sidebarOverlayVisible,
    ]);

    const gridTemplateColumns = useMemo(() => {
        const leftCol = leftCollapsed ? 0 : leftWidth;
        const leftHandle = leftCollapsed
            ? 0
            : shellLayoutConstraints.handleWidth;
        return `${leftCol}px ${leftHandle}px minmax(0, 1fr)`;
    }, [leftCollapsed, leftWidth]);

    const activeProject =
        projects.find((project) => project.id === activeProjectId) ?? null;
    useEffect(() => {
        document.title = activeProject
            ? `${activeProject.name} — Comando`
            : (bootstrap?.app.windowTitle ?? "Comando");
    }, [activeProject, bootstrap?.app.windowTitle]);
    const projectContextTabs = useMemo<readonly ProjectContextTabItem[]>(
        () =>
            openWorkspaceContextKeys.flatMap((contextKey) => {
                const context = workspaceContextsByKey[contextKey];
                const project = context
                    ? projects.find((entry) => entry.id === context.projectId)
                    : null;
                if (!context || !project) {
                    return [];
                }

                const worktrees = collectProjectWorktrees(
                    gitSnapshots,
                    context.projectId,
                );
                const worktree = worktrees.find((entry) =>
                    areGitWorktreeIdsEquivalent(
                        context.projectId,
                        context.worktreeId,
                        entry.isPrimary ? null : entry.id,
                    ),
                );
                return [
                    {
                        key: context.key,
                        projectId: context.projectId,
                        projectName: project.name,
                        worktreeId: context.worktreeId,
                        worktreeLabel: worktree
                            ? getWorktreeDisplayLabel(worktree)
                            : context.worktreeId
                              ? "Worktree"
                              : "Main checkout",
                    },
                ];
            }),
        [
            gitSnapshots,
            openWorkspaceContextKeys,
            projects,
            workspaceContextsByKey,
        ],
    );
    const projectContextMenuProjects = useMemo<
        readonly ProjectContextMenuProject[]
    >(() => {
        const openContextIdentities = openWorkspaceContextKeys.flatMap(
            (contextKey) => {
                const context = workspaceContextsByKey[contextKey];
                return context
                    ? [
                          {
                              projectId: context.projectId,
                              worktreeId: context.worktreeId,
                          },
                      ]
                    : [];
            },
        );

        return projects.map((project) => {
            const primaryIsOpen = openContextIdentities.some(
                (context) =>
                    context.projectId === project.id &&
                    areGitWorktreeIdsEquivalent(
                        project.id,
                        context.worktreeId,
                        null,
                    ),
            );
            const worktrees = collectProjectWorktrees(gitSnapshots, project.id)
                .filter((worktree) => !worktree.isPrimary)
                .map((worktree) => ({
                    id: worktree.id,
                    isActive:
                        activeWorkspaceContext?.projectId === project.id &&
                        areGitWorktreeIdsEquivalent(
                            project.id,
                            activeWorkspaceContext.worktreeId,
                            worktree.id,
                        ),
                    isOpen: openContextIdentities.some(
                        (context) =>
                            context.projectId === project.id &&
                            areGitWorktreeIdsEquivalent(
                                project.id,
                                context.worktreeId,
                                worktree.id,
                            ),
                    ),
                    label: getWorktreeDisplayLabel(worktree),
                }));

            return {
                id: project.id,
                mainIsActive:
                    activeWorkspaceContext?.projectId === project.id &&
                    areGitWorktreeIdsEquivalent(
                        project.id,
                        activeWorkspaceContext.worktreeId,
                        null,
                    ),
                mainIsOpen: primaryIsOpen,
                name: project.name,
                worktrees,
            };
        });
    }, [
        activeWorkspaceContext,
        gitSnapshots,
        openWorkspaceContextKeys,
        projects,
        workspaceContextsByKey,
    ]);
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
    const fileTreeFilterMatches = useMemo(() => {
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
    ]);
    const fileTreeSearchTree = useMemo(
        () =>
            buildHierarchicalGitTreeNodesFromProjectEntries(
                fileTreeFilterMatches,
                fileTreeFilterEntries,
            ),
        [fileTreeFilterEntries, fileTreeFilterMatches],
    );
    const fileTreeSearchNodes = fileTreeSearchTree.nodes;
    const fileTreeSearchExpandedPaths = fileTreeSearchTree.expandedDirectoryPaths;
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
            return scheduleEffectStateUpdate(() => {
                setQuickOpenSelectedIndex(0);
            });
        }

        return scheduleEffectStateUpdate(() => {
            setQuickOpenSelectedIndex((currentIndex) =>
                Math.min(currentIndex, quickOpenResults.length - 1),
            );
        });
    }, [quickOpenResults.length]);
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
        [],
    );

    const focusWorkspaceSurface = useCallback(() => {
        focusSurface("workspace");
        clearFileTreeSelection({ suppressActivePathFallback: true });
        setFileTreeContextTargetResetSignal((signal) => signal + 1);
        setGitHubSidebarSelectionResetSignal((signal) => signal + 1);
        setFileTreeContextMenu(null);
    }, [clearFileTreeSelection, focusSurface]);

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
    }, [fileTreeContextMenu]);

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
                await navigator.clipboard.writeText(text);
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

            const currentTabsById = useWorkspaceStore.getState().tabsById;
            const worktreeId = activeWorktreeId ?? null;
            const existingChatTab = Object.values(currentTabsById).find(
                (tab) =>
                    tab.kind === "chat" &&
                    tab.projectId === activeProjectId &&
                    (tab.worktreeId ?? null) === worktreeId,
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
                    isActiveAiRuntimeId(lastFocusedRuntimeId)
                        ? lastFocusedRuntimeId
                        : "codex",
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

    const handleAddGitHubItemsToChat = useCallback(
        async (request: SidebarGitHubAddToChatRequest) => {
            if (request.parts.length === 0) {
                return;
            }

            const appendPartsToSession = (
                sessionId: string,
                parts: readonly AIComposerPart[],
            ) => {
                const existingParts =
                    useAiStore.getState().sessions[sessionId]
                        ?.draftComposerParts ?? createEmptyComposerParts();
                setDraftComposerParts(
                    sessionId,
                    appendComposerParts(existingParts, parts),
                );
            };

            const workspaceState = useWorkspaceStore.getState();
            const worktreeId = request.worktreeId ?? null;
            const targetChatTabId = request.forceNewChat
                ? null
                : getBestMatchingChatTabId(workspaceState, {
                      currentPaneId: workspaceState.activePaneId,
                      lastFocusedChatTabId:
                          workspaceState.lastFocusedChatTabId,
                      projectId: request.projectId,
                      recentFocusedChatTabIds:
                          workspaceState.recentFocusedChatTabIds,
                      worktreeId,
                  });
            const targetChatTab = targetChatTabId
                ? workspaceState.tabsById[targetChatTabId]
                : null;

            if (targetChatTab?.kind === "chat") {
                appendPartsToSession(targetChatTab.sessionId, request.parts);
                return;
            }

            const existingTabIds = new Set(Object.keys(workspaceState.tabsById));

            try {
                await createChatTab(
                    request.projectId,
                    worktreeId,
                    isActiveAiRuntimeId(lastFocusedRuntimeId)
                        ? lastFocusedRuntimeId
                        : "codex",
                );
            } catch (error) {
                window.alert(
                    error instanceof Error
                        ? error.message
                        : "Could not create a chat tab for this GitHub item.",
                );
                return;
            }

            const createdChatTab = Object.values(
                useWorkspaceStore.getState().tabsById,
            ).find(
                (tab) =>
                    tab.kind === "chat" &&
                    tab.projectId === request.projectId &&
                    (tab.worktreeId ?? null) === worktreeId &&
                    !existingTabIds.has(tab.id),
            );

            if (createdChatTab?.kind === "chat") {
                appendPartsToSession(createdChatTab.sessionId, request.parts);
            }
        },
        [createChatTab, lastFocusedRuntimeId, setDraftComposerParts],
    );

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
    }, [visibleSidebarNodePathSet]);

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
            void openFileTab(activeProjectId, node.path, activeWorktreeId);
        },
        [
            activeProjectId,
            activeWorktreeId,
            clearFileTreeSelection,
            effectiveFileTreeSelectedPaths,
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
                            ? void openFileTab(
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
    ]);

    const { stickyFolders, stickyFolderPaths } = useStickyFolders({
        scrollContainer: fileTreeScrollElement,
        nodes: isFilteringFileTree ? [] : sidebarTreeNodes,
        expandedPaths: isFilteringFileTree
            ? fileTreeSearchExpandedPaths
            : activeExpandedDirectories,
        layout: "tree",
        enabled: stickyFoldersEnabled && !isFilteringFileTree,
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
        hideSidebarOverlayImmediately();
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
        hideSidebarOverlayImmediately,
        revealPathInTree,
        setActiveProject,
        setActiveWorktree,
        setLeftCollapsed,
        setSidebarView,
    ]);

    const handleSidebarViewChange = useCallback(
        (nextSidebarView: SidebarView) => {
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
            if (sidebarView === "files") {
                setFileTreeFilter(value);
            } else if (sidebarView === "git") {
                setGitChangesFilter(value);
            } else if (sidebarView === "issues") {
                setIssuesFilter(value);
            } else if (sidebarView === "pull_requests") {
                setPullRequestsFilter(value);
            } else {
                setAgentsFilter(value);
            }
        },
        [sidebarView],
    );

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
            void requestCloseWorkspaceContext(workspaceActiveContextKey);
        };

        window.addEventListener("keydown", handleKeyDown, true);
        return () => {
            window.removeEventListener("keydown", handleKeyDown, true);
        };
    }, [requestCloseWorkspaceContext, workspaceActiveContextKey]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "b" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                toggleLeftCollapsed();
                hideSidebarOverlayImmediately();
            }
            if (event.key === "Escape") {
                if (sidebarOverlayVisible) hideSidebarOverlayImmediately();
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [
        hideSidebarOverlayImmediately,
        sidebarOverlayVisible,
        toggleLeftCollapsed,
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
    const sidebarSearchAriaLabel =
        sidebarView === "files"
            ? "Filter files"
            : sidebarView === "git"
              ? "Filter changes"
              : sidebarView === "issues"
                ? "Search issues"
                : sidebarView === "pull_requests"
                  ? "Search pull requests"
                  : "Filter threads";
    const sidebarSearchPlaceholder =
        sidebarView === "files"
            ? "Filter files..."
            : sidebarView === "git"
              ? "Filter changes..."
              : sidebarView === "issues"
                ? "Search issues..."
                : sidebarView === "pull_requests"
                  ? "Search pull requests..."
                  : "Filter threads...";

    const sidebarContent = (
        <>
            <div className="app-drag px-2">
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
                                handleSidebarViewChange("files");
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
                            sidebarView === "agents"
                                ? "sidebar-action-row--active"
                                : "",
                        ]
                            .filter(Boolean)
                            .join(" ")}
                        onClick={() => {
                            if (sidebarView !== "agents") {
                                handleSidebarViewChange("agents");
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
                            {/* Robot head — reads clearly as an agent */}
                            <rect
                                x="3.75"
                                y="5.5"
                                width="8.5"
                                height="7"
                                rx="2"
                                stroke="currentColor"
                                strokeWidth="1.2"
                                fill="currentColor"
                                fillOpacity="0.15"
                            />
                            <path
                                d="M8 5.5V3.4"
                                stroke="currentColor"
                                strokeWidth="1.2"
                                strokeLinecap="round"
                            />
                            <circle
                                cx="8"
                                cy="2.8"
                                r="0.95"
                                fill="currentColor"
                            />
                            <circle
                                cx="6.3"
                                cy="9"
                                r="1"
                                fill="currentColor"
                            />
                            <circle
                                cx="9.7"
                                cy="9"
                                r="1"
                                fill="currentColor"
                            />
                        </svg>
                        <span>Agents</span>
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
                                handleSidebarViewChange("git");
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
                            {/* Classic git-branch glyph */}
                            <circle
                                cx="4.5"
                                cy="4"
                                r="1.6"
                                stroke="currentColor"
                                strokeWidth="1.2"
                            />
                            <circle
                                cx="4.5"
                                cy="12"
                                r="1.6"
                                stroke="currentColor"
                                strokeWidth="1.2"
                            />
                            <circle
                                cx="11.5"
                                cy="4"
                                r="1.6"
                                stroke="currentColor"
                                strokeWidth="1.2"
                            />
                            <path
                                d="M4.5 5.6v4.8"
                                stroke="currentColor"
                                strokeWidth="1.2"
                                strokeLinecap="round"
                            />
                            <path
                                d="M11.5 5.6v1.4A2.5 2.5 0 0 1 9 9.5H7a2.5 2.5 0 0 0-2.5 2.5"
                                stroke="currentColor"
                                strokeWidth="1.2"
                                strokeLinecap="round"
                            />
                        </svg>
                        <span>Git</span>
                    </button>

                    <button
                        aria-label="Issues"
                        className={[
                            "sidebar-action-row sidebar-action-row--compact sidebar-action-row--icon app-no-drag shrink-0",
                            sidebarView === "issues"
                                ? "sidebar-action-row--active"
                                : "",
                        ]
                            .filter(Boolean)
                            .join(" ")}
                        disabled={!activeProjectId}
                        onClick={() => {
                            if (!activeProjectId) return;
                            if (sidebarView !== "issues") {
                                handleSidebarViewChange("issues");
                            }
                        }}
                        title="Issues"
                        type="button"
                    >
                        <svg
                            aria-hidden="true"
                            className="h-4 w-4 shrink-0"
                            fill="none"
                            viewBox="0 0 16 16"
                        >
                            <circle
                                cx="8"
                                cy="8"
                                r="5.2"
                                stroke="currentColor"
                                strokeWidth="1.15"
                            />
                            <path
                                d="M8 4.9v3.8"
                                stroke="currentColor"
                                strokeLinecap="round"
                                strokeWidth="1.25"
                            />
                            <circle
                                cx="8"
                                cy="11.1"
                                fill="currentColor"
                                r="0.75"
                            />
                        </svg>
                    </button>

                    <button
                        aria-label="Pull Requests"
                        className={[
                            "sidebar-action-row sidebar-action-row--compact sidebar-action-row--icon app-no-drag shrink-0",
                            sidebarView === "pull_requests"
                                ? "sidebar-action-row--active"
                                : "",
                        ]
                            .filter(Boolean)
                            .join(" ")}
                        disabled={!activeProjectId}
                        onClick={() => {
                            if (!activeProjectId) return;
                            if (sidebarView !== "pull_requests") {
                                handleSidebarViewChange("pull_requests");
                            }
                        }}
                        title="Pull Requests"
                        type="button"
                    >
                        <svg
                            aria-hidden="true"
                            className="h-4 w-4 shrink-0"
                            fill="none"
                            viewBox="0 0 16 16"
                        >
                            <circle
                                cx="5"
                                cy="4"
                                fill="currentColor"
                                r="1.2"
                            />
                            <circle
                                cx="5"
                                cy="12"
                                fill="currentColor"
                                r="1.2"
                            />
                            <circle
                                cx="11"
                                cy="8"
                                fill="currentColor"
                                r="1.2"
                            />
                            <path
                                d="M5 5.2v5.6M6.2 4H8a3 3 0 0 1 3 3v0"
                                stroke="currentColor"
                                strokeLinecap="round"
                                strokeWidth="1.15"
                            />
                        </svg>
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
                        aria-label={sidebarSearchAriaLabel}
                        autoCapitalize="off"
                        autoCorrect="off"
                        className="sidebar-search-input"
                        onChange={(event) => {
                            setSidebarSearchValue(event.target.value);
                        }}
                        onKeyDown={(event) => {
                            if (event.key === "Escape") {
                                event.preventDefault();
                                setSidebarSearchValue("");
                            }
                        }}
                        placeholder={sidebarSearchPlaceholder}
                        spellCheck={false}
                        type="text"
                        value={sidebarSearchValue}
                    />
                    {sidebarSearchValue.length > 0 ? (
                        <button
                            aria-label="Clear filter"
                            className="sidebar-search-clear"
                            onClick={() => {
                                setSidebarSearchValue("");
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

            <div className="flex min-h-0 flex-1 flex-col">
                {sidebarView === "git" && activeProjectId ? (
                    <SidebarGitPanel
                        filter={gitChangesFilter}
                        projectId={activeProjectId}
                        worktreeId={activeWorktreeId}
                    />
                ) : sidebarView === "issues" ? (
                    <SidebarGitHubPanel
                        filter={issuesFilter}
                        kind="issues"
                        onAddToChat={(request) =>
                            void handleAddGitHubItemsToChat(request)
                        }
                        onOpenSettings={openSettingsWindow}
                        projectId={activeProjectId}
                        selectionResetSignal={gitHubSidebarSelectionResetSignal}
                        worktreeId={activeWorktreeId}
                    />
                ) : sidebarView === "pull_requests" ? (
                    <SidebarGitHubPanel
                        filter={pullRequestsFilter}
                        kind="pull_requests"
                        onAddToChat={(request) =>
                            void handleAddGitHubItemsToChat(request)
                        }
                        onOpenSettings={openSettingsWindow}
                        projectId={activeProjectId}
                        selectionResetSignal={gitHubSidebarSelectionResetSignal}
                        worktreeId={activeWorktreeId}
                    />
                ) : sidebarView === "agents" ? (
                    <SidebarAgentsPanel
                        filter={agentsFilter}
                        projectId={activeProjectId}
                        worktreeId={activeWorktreeId}
                    />
                ) : (
                    <div
                        ref={setFileTreeScrollElement}
                        className="shell-scrollbar flex-1 overflow-y-auto px-2 py-2"
                        onClick={(event) => {
                            if (
                                event.target instanceof HTMLElement &&
                                event.target.closest(".git-tree-row")
                            ) {
                                return;
                            }

                            clearFileTreeSelection({
                                suppressActivePathFallback: true,
                            });
                        }}
                        onScroll={handleFileTreeScroll}
                    >
                        {activeProject ? (
                            <>
                                {!isFilteringFileTree &&
                                stickyFoldersEnabled ? (
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
                                        onExternalFilesDrop={(
                                            sourcePaths,
                                            destinationNode,
                                        ) => {
                                            void handleImportExternalTreeEntries(
                                                sourcePaths,
                                                destinationNode,
                                            );
                                        }}
                                        selectedPaths={selectedFileTreePathSet}
                                    />
                                ) : null}
                                <GitTreeView
                                    activePath={activeFilePath}
                                    contextTargetResetSignal={
                                        fileTreeContextTargetResetSignal
                                    }
                                    editingDraftName={
                                        fileTreeInlineEditor?.draftName ?? null
                                    }
                                    editingPath={
                                        fileTreeInlineEditor?.path ?? null
                                    }
                                    enableNodeDrag
                                    emptyState={
                                        isFilteringFileTree ? null : undefined
                                    }
                                    expandedPaths={
                                        isFilteringFileTree
                                            ? fileTreeSearchExpandedPaths
                                            : activeExpandedDirectories
                                    }
                                    layout="tree"
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
                                    suppressKeyboardCursor={
                                        isFileTreeSelectionSuppressed
                                    }
                                    scrollToActivePathSignal={
                                        fileTreeRevealSignal ?? undefined
                                    }
                                    onBackgroundContextMenu={({ x, y }) => {
                                        clearFileTreeSelection({
                                            suppressActivePathFallback: true,
                                        });
                                        setFileTreeContextMenu({
                                            x,
                                            y,
                                            payload: {
                                                kind: "background",
                                            },
                                        });
                                    }}
                                    onBackgroundDrop={
                                        isFilteringFileTree
                                            ? undefined
                                            : (dragData) => {
                                                  const rootNode =
                                                      sidebarTreeNodes.find(
                                                          (node) =>
                                                              node.isProjectRoot,
                                                      );
                                                  if (!rootNode) {
                                                      return;
                                                  }

                                                  void handleMoveTreeNode(
                                                      dragData,
                                                      rootNode,
                                                  );
                                              }
                                    }
                                    onExternalFilesDrop={
                                        isFilteringFileTree
                                            ? undefined
                                            : (sourcePaths, destinationNode) => {
                                                  void handleImportExternalTreeEntries(
                                                      sourcePaths,
                                                      destinationNode,
                                                  );
                                              }
                                    }
                                    onNodeClick={handleFileTreeNodeClick}
                                    onNodeContextMenu={(node, { x, y }) => {
                                        setIsFileTreeSelectionSuppressed(false);
                                        const isNodeSelected =
                                            selectedFileTreePathSet.has(
                                                node.path,
                                            );

                                        if (!isNodeSelected) {
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
                                                transientSelectionPath:
                                                    isNodeSelected
                                                        ? null
                                                        : node.path,
                                            },
                                        });
                                    }}
                                    onNodeDragStart={handleFileTreeNodeDragStart}
                                    onNodeDrop={(dragData, destinationNode) => {
                                        void handleMoveTreeNode(
                                            dragData,
                                            destinationNode,
                                        );
                                    }}
                                    onScrollToActivePathConsumed={() => {
                                        setFileTreeRevealSignal(null);
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
                )}
            </div>

            <div className="border-t border-border/50 px-2 py-2">
                <ProjectSwitcher
                    activeProject={activeProject}
                    appUpdateState={appUpdateState}
                    onCloneRepository={async (repositoryUrl) => {
                        const projectIds = await cloneRepository(repositoryUrl);
                        for (const projectId of projectIds) {
                            await useWorkspaceStore
                                .getState()
                                .openContext(projectId);
                        }
                        return projectIds.length > 0;
                    }}
                    onOpenProjects={() => {
                        void (async () => {
                            const projectIds = await addProjects();
                            for (const projectId of projectIds) {
                                await useWorkspaceStore
                                    .getState()
                                    .openContext(projectId);
                            }
                        })();
                    }}
                    onOpenSettings={openSettingsWindow}
                    onSelectProject={(projectId) => {
                        if (projectId === activeProjectId) {
                            return;
                        }

                        void useWorkspaceStore
                            .getState()
                            .openContext(projectId);
                    }}
                    projects={projects}
                />
            </div>
        </>
    );

    return (
        <div
            className="min-h-screen text-text-primary"
            data-platform={bootstrap?.platform ?? undefined}
        >
            <div className="relative h-screen">
                <div className="flex h-full flex-col overflow-hidden">
                    <DesktopTopBar
                        activeContextKey={workspaceActiveContextKey}
                        contexts={projectContextTabs}
                        leftSidebarCollapsed={leftCollapsed}
                        menuProjects={projectContextMenuProjects}
                        onActivateContext={(contextKey) => {
                            void useWorkspaceStore
                                .getState()
                                .activateContext(contextKey);
                        }}
                        onCloneRepository={async (repositoryUrl) => {
                            const projectIds =
                                await cloneRepository(repositoryUrl);
                            for (const projectId of projectIds) {
                                await useWorkspaceStore
                                    .getState()
                                    .openContext(projectId);
                            }
                            return projectIds.length > 0;
                        }}
                        onCloseContext={(contextKey) => {
                            void requestCloseWorkspaceContext(contextKey);
                        }}
                        onMoveContextToNewWindow={(contextKey) => {
                            void requestMoveWorkspaceContextToNewWindow(
                                contextKey,
                            );
                        }}
                        onOpenProject={(projectId) => {
                            void useWorkspaceStore
                                .getState()
                                .openContext(projectId);
                        }}
                        onOpenProjects={() => {
                            void (async () => {
                                const projectIds = await addProjects();
                                for (const projectId of projectIds) {
                                    await useWorkspaceStore
                                        .getState()
                                        .openContext(projectId);
                                }
                            })();
                        }}
                        onOpenSettings={() => openSettingsWindow()}
                        onOpenWorktree={(projectId, worktreeId) => {
                            void useWorkspaceStore
                                .getState()
                                .openContext(projectId, worktreeId);
                        }}
                        onReorderContext={(contextKey, targetIndex) => {
                            void useWorkspaceStore
                                .getState()
                                .reorderContext(contextKey, targetIndex);
                        }}
                        onToggleLeftSidebar={() => {
                            toggleLeftCollapsed();
                            hideSidebarOverlayImmediately();
                        }}
                        platform={bootstrap?.platform ?? null}
                    />
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
                            onFocus={focusWorkspaceSurface}
                            onPointerDown={focusWorkspaceSurface}
                            tabIndex={0}
                        >
                            <WorkspaceTerminalHost />
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
                            top: "var(--desktop-titlebar-height, 40px)",
                            bottom: 0,
                            width: sidebarOverlayVisible
                                ? 0
                                : edgePeekConfig.hotspotWidth,
                            zIndex: 10,
                        }}
                        onMouseEnter={showSidebarOverlay}
                    />
                )}

                {leftCollapsed && sidebarOverlayVisible && (
                    <div
                        ref={sidebarOverlayRef}
                        className="flex min-h-0 flex-col bg-bg-panel"
                        data-edge-peek-overlay="left"
                        data-edge-peek-state={
                            sidebarOverlayClosing ? "closing" : "opening"
                        }
                        style={{
                            position: "absolute",
                            left: 0,
                            top: "var(--desktop-titlebar-height, 40px)",
                            bottom: 0,
                            width: leftWidth,
                            zIndex: 10,
                            boxShadow: "var(--shadow-soft)",
                            borderRight: "1px solid var(--color-border)",
                        }}
                        onMouseEnter={(event) => {
                            rememberSidebarPointer(event);
                            cancelSidebarOverlayClose();
                        }}
                        onMouseMove={rememberSidebarPointer}
                        onMouseLeave={(event) => {
                            rememberSidebarPointer(event);
                            hideSidebarOverlayWithAnimation();
                        }}
                        onDragStartCapture={startSidebarOriginDrag}
                        onDragEndCapture={(event) => {
                            sidebarPointerRef.current = {
                                x: event.clientX,
                                y: event.clientY,
                            };
                            finishSidebarOriginDrag();
                        }}
                        onAnimationEnd={(event) => {
                            if (
                                event.currentTarget !== event.target ||
                                !sidebarOverlayClosing
                            ) {
                                return;
                            }

                            setSidebarOverlayClosing(false);
                            setSidebarOverlayVisible(false);
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
                    onClose={closeFileTreeContextMenu}
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
    const inputRef = useRef<HTMLInputElement | null>(null);
    const listRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!open) {
            return;
        }

        const frameId = window.requestAnimationFrame(() => {
            inputRef.current?.focus();
            inputRef.current?.select();
        });

        return () => window.cancelAnimationFrame(frameId);
    }, [open]);

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
            className="app-no-drag fixed inset-0 z-10030 flex items-start justify-center px-5 pt-[min(14vh,104px)]"
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
        >
            <div
                className="app-no-drag flex w-full max-w-[520px] flex-col overflow-hidden rounded-lg border"
                style={{
                    background: "var(--color-bg-elevated)",
                    borderColor:
                        "color-mix(in srgb, var(--color-border) 80%, transparent)",
                    boxShadow:
                        "0 24px 80px rgba(0, 0, 0, 0.22), 0 0 0 1px color-mix(in srgb, var(--color-border) 40%, transparent)",
                }}
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

function getProjectSwitcherUpdateMenuLabel(
    state: AppUpdateState,
): string | null {
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

function ProjectSwitcher({
    activeProject,
    appUpdateState,
    onCloneRepository,
    onOpenProjects,
    onOpenSettings,
    onSelectProject,
    projects,
}: {
    readonly activeProject: ProjectSummary | null;
    readonly appUpdateState: AppUpdateState;
    readonly onCloneRepository: (repositoryUrl: string) => Promise<boolean>;
    readonly onOpenProjects: () => void;
    readonly onOpenSettings: (initialCategory?: SettingsWindowCategory) => void;
    readonly onSelectProject: (projectId: string) => void;
    readonly projects: readonly ProjectSummary[];
}) {
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState("");
    const [cloneMode, setCloneMode] = useState(false);
    const [cloneUrl, setCloneUrl] = useState("");
    const [cloneError, setCloneError] = useState<string | null>(null);
    const [cloneSubmitting, setCloneSubmitting] = useState(false);
    const ref = useRef<HTMLDivElement | null>(null);
    const searchRef = useRef<HTMLInputElement | null>(null);
    const cloneInputRef = useRef<HTMLInputElement | null>(null);
    const normalizedSearch = search.trim().toLowerCase();
    const filteredProjects = projects.filter((project) => {
        if (!normalizedSearch) return true;
        return (
            project.name.toLowerCase().includes(normalizedSearch) ||
            project.rootPath.toLowerCase().includes(normalizedSearch)
        );
    });
    const updateMenuLabel = getProjectSwitcherUpdateMenuLabel(appUpdateState);
    const hasUpdateNotice = updateMenuLabel !== null;

    const resetMenuState = () => {
        setOpen(false);
        setSearch("");
        setCloneMode(false);
        setCloneUrl("");
        setCloneError(null);
        setCloneSubmitting(false);
    };

    useEffect(() => {
        if (!open) return;
        if (cloneMode) {
            cloneInputRef.current?.focus();
        } else {
            searchRef.current?.focus();
        }
        const handleDown = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                resetMenuState();
            }
        };
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                if (cloneMode) {
                    setCloneMode(false);
                    setCloneUrl("");
                    setCloneError(null);
                    return;
                }
                resetMenuState();
            }
        };
        document.addEventListener("mousedown", handleDown);
        document.addEventListener("keydown", handleKey);
        return () => {
            document.removeEventListener("mousedown", handleDown);
            document.removeEventListener("keydown", handleKey);
        };
    }, [open, cloneMode]);

    const handleAction = (action: () => void) => {
        resetMenuState();
        queueMicrotask(action);
    };

    const handleCloneSubmit = async () => {
        const trimmedUrl = cloneUrl.trim();
        if (!trimmedUrl) {
            setCloneError("Paste a repository URL before cloning.");
            return;
        }

        setCloneSubmitting(true);
        setCloneError(null);
        try {
            const completed = await onCloneRepository(trimmedUrl);
            if (completed) {
                resetMenuState();
            } else {
                setCloneSubmitting(false);
            }
        } catch (error) {
            setCloneSubmitting(false);
            setCloneError(
                error instanceof Error
                    ? error.message
                    : "Could not clone the repository.",
            );
        }
    };

    const menuItem = (
        label: string,
        action: () => void,
        checked = false,
        muted = false,
        trailing?: ReactNode,
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
            {trailing}
        </button>
    );

    return (
        <div ref={ref} style={{ position: "relative" }}>
            {open && (
                <div className="project-switcher-menu">
                    {cloneMode ? (
                        <div className="project-switcher-clone">
                            <div className="project-switcher-clone-label">
                                Clone repository
                            </div>
                            <input
                                autoCapitalize="off"
                                autoCorrect="off"
                                className="project-switcher-clone-input"
                                disabled={cloneSubmitting}
                                onChange={(e) => {
                                    setCloneUrl(e.target.value);
                                    if (cloneError) setCloneError(null);
                                }}
                                onKeyDown={(e) => {
                                    e.stopPropagation();
                                    if (e.key === "Enter") {
                                        e.preventDefault();
                                        void handleCloneSubmit();
                                    }
                                }}
                                placeholder="https://github.com/user/repo.git"
                                ref={cloneInputRef}
                                spellCheck={false}
                                value={cloneUrl}
                            />
                            {cloneError && (
                                <div className="project-switcher-clone-error">
                                    {cloneError}
                                </div>
                            )}
                            <div className="project-switcher-clone-actions">
                                <button
                                    className="project-switcher-clone-btn"
                                    disabled={cloneSubmitting}
                                    onClick={() => {
                                        setCloneMode(false);
                                        setCloneUrl("");
                                        setCloneError(null);
                                    }}
                                    type="button"
                                >
                                    Back
                                </button>
                                <button
                                    className="project-switcher-clone-btn project-switcher-clone-btn-primary"
                                    disabled={
                                        cloneSubmitting || !cloneUrl.trim()
                                    }
                                    onClick={() => {
                                        void handleCloneSubmit();
                                    }}
                                    type="button"
                                >
                                    {cloneSubmitting
                                        ? "Cloning…"
                                        : "Choose folder & clone"}
                                </button>
                            </div>
                        </div>
                    ) : (
                        <>
                            {projects.length > 0 && (
                                <div className="project-switcher-search">
                                    <svg
                                        fill="none"
                                        height="12"
                                        style={{
                                            opacity: 0.4,
                                            flexShrink: 0,
                                        }}
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
                                        onChange={(e) =>
                                            setSearch(e.target.value)
                                        }
                                        onKeyDown={(e) => e.stopPropagation()}
                                        placeholder="Search projects…"
                                        ref={searchRef}
                                        spellCheck={false}
                                        value={search}
                                    />
                                    <span className="project-switcher-search-count">
                                        {filteredProjects.length}/
                                        {projects.length}
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
                            {menuItem(
                                "Open folder…",
                                onOpenProjects,
                                false,
                                true,
                            )}
                            <button
                                className="project-switcher-menu-item"
                                onClick={() => {
                                    setCloneMode(true);
                                    setCloneError(null);
                                    setCloneUrl("");
                                }}
                                type="button"
                            >
                                <span className="project-switcher-check" />
                                <span
                                    className="truncate"
                                    style={{
                                        color: "var(--color-text-secondary)",
                                    }}
                                >
                                    Clone repository…
                                </span>
                            </button>
                            {menuItem(
                                updateMenuLabel ?? "Settings",
                                () =>
                                    onOpenSettings(
                                        hasUpdateNotice
                                            ? "updates"
                                            : undefined,
                                    ),
                                false,
                                true,
                                hasUpdateNotice ? (
                                    <span
                                        aria-hidden="true"
                                        className="project-switcher-update-dot"
                                    />
                                ) : undefined,
                            )}
                        </>
                    )}
                </div>
            )}

            <button
                className="sidebar-action-row sidebar-action-row--switcher app-no-drag w-full"
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

function normalizeFileTreeClipboardWorktreeId(
    worktreeId: string | null | undefined,
): string {
    return worktreeId ?? "__primary__";
}

function getComandoApi(): ComandoApi | null {
    return "comando" in window ? window.comando : null;
}

function startDragging(
    side: "left",
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
