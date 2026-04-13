import {
    useEffect,
    useEffectEvent,
    useMemo,
    useState,
    type MouseEvent as ReactMouseEvent,
    type ReactNode,
    type PointerEvent as ReactPointerEvent,
} from "react";

import type {
    ComandoApi,
    GitStatusBadge,
    PersistenceSnapshot,
    ProjectSummary,
    ProjectTreeNode,
    SettingsSnapshot,
} from "@shared/ipc";

import { useSystemTheme } from "./app/hooks/use-system-theme";
import { shellLayoutConstraints } from "./app/layout/shell-layout";
import { useAppStore } from "./app/store/app-store";
import { useProjectsStore } from "./app/store/projects-store";
import { useShellStore } from "./app/store/shell-store";
import { useWorkspaceStore } from "./app/store/workspace-store";
import { findPaneById } from "./app/workspace/tree";
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

type FileTreeContextMenuPayload =
    | {
          readonly kind: "blank";
      }
    | {
          readonly kind: "directory" | "file";
          readonly node: ProjectTreeNode;
      };

const ROOT_NODE_KEY = "__root__";

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
    const removeProject = useProjectsStore((state) => state.removeProject);
    const setActiveProject = useProjectsStore(
        (state) => state.setActiveProject,
    );
    const toggleDirectory = useProjectsStore((state) => state.toggleDirectory);
    const treeNodes = useProjectsStore((state) => state.treeNodes);
    const expandedDirectories = useProjectsStore(
        (state) => state.expandedDirectories,
    );

    const workspaceHydrate = useWorkspaceStore((state) => state.hydrate);
    const appendTerminalOutput = useWorkspaceStore(
        (state) => state.appendTerminalOutput,
    );
    const handleTerminalExit = useWorkspaceStore(
        (state) => state.handleTerminalExit,
    );
    const openFileTab = useWorkspaceStore((state) => state.openFileTab);
    const refreshProjectTabs = useWorkspaceStore(
        (state) => state.refreshProjectTabs,
    );
    const removeProjectTabs = useWorkspaceStore(
        (state) => state.removeProjectTabs,
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
    const leftWidth = useShellStore((state) => state.leftWidth);
    const nudgePanel = useShellStore((state) => state.nudgePanel);
    const resizePanel = useShellStore((state) => state.resizePanel);
    const rightWidth = useShellStore((state) => state.rightWidth);
    const syncViewport = useShellStore((state) => state.syncViewport);

    const [dragState, setDragState] = useState<DragState>(null);
    const [fileTreeContextMenu, setFileTreeContextMenu] =
        useState<ContextMenuState<FileTreeContextMenuPayload> | null>(null);
    const [persistenceReady, setPersistenceReady] = useState(false);
    const [projectFilter, setProjectFilter] = useState("");

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

                hydrateShell(settingsSnapshot?.shellState ?? null);
                await hydrateProjects(
                    persistenceSnapshot?.activeProjectId ?? null,
                );
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
    }, [hydrateBootstrap, hydrateProjects, hydrateShell, workspaceHydrate]);

    useEffect(() => {
        const comandoApi = getComandoApi();
        if (!comandoApi) {
            return;
        }

        const unsubscribe = comandoApi.onProjectTreeInvalidated((payload) => {
            void refreshProjectTree(payload.projectId);
            void refreshProjectTabs(payload.projectId);
        });

        return unsubscribe;
    }, [refreshProjectTabs, refreshProjectTree]);

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
            void comandoApi.saveSettingsSnapshot({
                shellState: {
                    activeSurface,
                    leftWidth,
                    rightWidth,
                },
            });
        }, 120);

        return () => {
            window.clearTimeout(timeout);
        };
    }, [activeSurface, leftWidth, persistenceReady, rightWidth]);

    useEffect(() => {
        if (!persistenceReady || !window.comando) {
            return;
        }

        void window.comando.saveActiveProjectId(activeProjectId);
    }, [activeProjectId, persistenceReady]);

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

    const recentProjects = filteredProjects.filter(
        (project) => project.lastOpenedAt,
    );
    const otherProjects = filteredProjects.filter(
        (project) => !project.lastOpenedAt,
    );

    const gridTemplateColumns = useMemo(
        () =>
            `${leftWidth}px ${shellLayoutConstraints.handleWidth}px minmax(0, 1fr) ${shellLayoutConstraints.handleWidth}px ${rightWidth}px`,
        [leftWidth, rightWidth],
    );

    const activeProject =
        projects.find((project) => project.id === activeProjectId) ?? null;
    const activeProjectTree =
        treeNodes[activeProjectId ?? ""]?.[ROOT_NODE_KEY] ?? [];
    const activeExpandedDirectories =
        expandedDirectories[activeProjectId ?? ""] ?? [];
    const activeWorkspacePane = findPaneById(
        workspaceRootNode,
        workspaceActivePaneId,
    );
    const activeWorkspaceTab = activeWorkspacePane?.activeTabId
        ? (workspaceTabsById[activeWorkspacePane.activeTabId] ?? null)
        : null;
    const activeFilePath =
        activeWorkspaceTab?.kind === "file"
            ? activeWorkspaceTab.relativePath
            : null;
    const isMac = bootstrap?.platform === "darwin";
    const topStatus = [bootstrapError, projectsError, workspaceError]
        .filter(Boolean)
        .join(" ");

    async function handleRemoveProject(projectId: string): Promise<void> {
        await removeProject(projectId);

        const stillExists = useProjectsStore
            .getState()
            .projects.some((project) => project.id === projectId);
        if (!stillExists) {
            await removeProjectTabs(projectId);
        }
    }

    function handleTreeNodeContextMenu(
        event: ReactMouseEvent<HTMLButtonElement>,
        node: ProjectTreeNode,
    ) {
        event.preventDefault();
        focusSurface("utility");
        setFileTreeContextMenu({
            x: event.clientX,
            y: event.clientY,
            payload: {
                kind: node.kind,
                node,
            },
        });
    }

    function handleBlankTreeContextMenu(
        event: ReactMouseEvent<HTMLDivElement>,
    ) {
        if (event.target !== event.currentTarget || !activeProject) {
            return;
        }

        event.preventDefault();
        focusSurface("utility");
        setFileTreeContextMenu({
            x: event.clientX,
            y: event.clientY,
            payload: { kind: "blank" },
        });
    }

    const fileTreeContextMenuEntries: ContextMenuEntry[] = (() => {
        if (!fileTreeContextMenu || !activeProject) {
            return [];
        }

        const refreshEntry: ContextMenuEntry = {
            label: "Refresh Project Tree",
            action: () => void refreshProjectTree(activeProject.id),
        };

        if (fileTreeContextMenu.payload.kind === "blank") {
            return [refreshEntry];
        }

        const { node } = fileTreeContextMenu.payload;

        if (node.kind === "directory") {
            const isExpanded = activeExpandedDirectories.includes(
                node.relativePath,
            );

            return [
                {
                    label: isExpanded ? "Collapse" : "Expand",
                    action: () => void toggleDirectory(activeProject.id, node),
                },
                {
                    label: "Copy Relative Path",
                    action: () =>
                        void navigator.clipboard.writeText(node.relativePath),
                },
                { type: "separator" },
                refreshEntry,
            ];
        }

        return [
            {
                label: "Open",
                action: () =>
                    void openFileTab(activeProject.id, node.relativePath),
            },
            {
                label: "Copy Relative Path",
                action: () =>
                    void navigator.clipboard.writeText(node.relativePath),
            },
            { type: "separator" },
            refreshEntry,
        ];
    })();

    return (
        <div className="min-h-screen text-text-primary">
            <div className="relative h-screen">
                <div className="flex h-full flex-col overflow-hidden">
                    <div
                        className="grid min-h-0 flex-1"
                        style={{ gridTemplateColumns }}
                    >
                        <aside
                            className="flex min-h-0 flex-col"
                            data-active={activeSurface === "projects"}
                            onClick={() => focusSurface("projects")}
                            onFocus={() => focusSurface("projects")}
                            tabIndex={0}
                        >
                            <div className="app-drag px-3 pb-2 pt-2">
                                <div
                                    className="flex min-h-7 items-center justify-between"
                                    style={
                                        isMac
                                            ? {
                                                  paddingLeft: 84,
                                              }
                                            : undefined
                                    }
                                >
                                    <h1 className="text-[11px] font-medium uppercase tracking-[0.16em] text-text-secondary">
                                        Projects
                                    </h1>
                                    <button
                                        aria-label="Add project"
                                        className="sidebar-tool-button app-no-drag"
                                        onClick={() => void addProjects()}
                                        type="button"
                                    >
                                        <svg
                                            aria-hidden="true"
                                            className="h-3.5 w-3.5"
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
                                    </button>
                                </div>

                                <div className="sidebar-search app-no-drag mt-2">
                                    <svg
                                        aria-hidden="true"
                                        className="h-3 w-3 shrink-0 text-text-secondary"
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
                                    <input
                                        className="app-no-drag sidebar-search-input"
                                        onChange={(event) =>
                                            setProjectFilter(event.target.value)
                                        }
                                        placeholder="Filter..."
                                        type="text"
                                        value={projectFilter}
                                    />
                                </div>

                                {projectsError ? (
                                    <div className="mt-2 rounded-md bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-600">
                                        {projectsError}
                                    </div>
                                ) : null}
                            </div>

                            <div className="shell-scrollbar flex-1 overflow-y-auto px-2 py-1">
                                <ProjectSection
                                    emptyCopy="Open a folder to start building your project library."
                                    projects={recentProjects}
                                    title="Recent"
                                >
                                    {(project) => (
                                        <ProjectRow
                                            isActive={
                                                project.id === activeProjectId
                                            }
                                            key={project.id}
                                            onActivate={() =>
                                                void setActiveProject(
                                                    project.id,
                                                )
                                            }
                                            onRemove={() =>
                                                void handleRemoveProject(
                                                    project.id,
                                                )
                                            }
                                            project={project}
                                        />
                                    )}
                                </ProjectSection>

                                <ProjectSection
                                    emptyCopy="No additional projects yet."
                                    projects={otherProjects}
                                    title="Library"
                                >
                                    {(project) => (
                                        <ProjectRow
                                            isActive={
                                                project.id === activeProjectId
                                            }
                                            key={project.id}
                                            onActivate={() =>
                                                void setActiveProject(
                                                    project.id,
                                                )
                                            }
                                            onRemove={() =>
                                                void handleRemoveProject(
                                                    project.id,
                                                )
                                            }
                                            project={project}
                                        />
                                    )}
                                </ProjectSection>
                            </div>
                        </aside>

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

                        <main
                            className="surface-focus min-h-0 bg-bg-primary"
                            data-active={activeSurface === "workspace"}
                            onClick={() => focusSurface("workspace")}
                            onFocus={() => focusSurface("workspace")}
                            tabIndex={0}
                        >
                            <WorkspaceView defaultProjectId={activeProjectId} />
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
                            className="surface-focus flex min-h-0 flex-col border-l border-border bg-bg-panel"
                            data-active={activeSurface === "utility"}
                            onClick={() => focusSurface("utility")}
                            onFocus={() => focusSurface("utility")}
                            tabIndex={0}
                        >
                            <div className="border-b border-border px-3 py-2.5">
                                <p className="text-[11px] uppercase tracking-[0.18em] text-text-secondary">
                                    Files
                                </p>
                            </div>

                            <div
                                className="shell-scrollbar min-h-0 flex-1 overflow-y-auto px-2 py-2"
                                onContextMenu={handleBlankTreeContextMenu}
                            >
                                {activeProject ? (
                                    <div className="space-y-1">
                                        {activeProjectTree.map((node) => (
                                            <TreeNodeRow
                                                activeFilePath={activeFilePath}
                                                expandedDirectories={
                                                    activeExpandedDirectories
                                                }
                                                key={node.id}
                                                loadingNodeKeys={
                                                    loadingNodeKeys
                                                }
                                                nodesByParent={
                                                    treeNodes[
                                                        activeProject.id
                                                    ] ?? {}
                                                }
                                                onOpenFile={(relativePath) =>
                                                    void openFileTab(
                                                        activeProject.id,
                                                        relativePath,
                                                    )
                                                }
                                                onOpenMenu={(event, treeNode) =>
                                                    handleTreeNodeContextMenu(
                                                        event,
                                                        treeNode,
                                                    )
                                                }
                                                onToggleDirectory={(treeNode) =>
                                                    void toggleDirectory(
                                                        activeProject.id,
                                                        treeNode,
                                                    )
                                                }
                                                projectId={activeProject.id}
                                                rootNode={node}
                                            />
                                        ))}
                                    </div>
                                ) : (
                                    <div className="rounded-lg border border-dashed border-border px-4 py-5 text-sm text-text-secondary">
                                        Add a project and select it to browse
                                        its tree.
                                    </div>
                                )}
                            </div>
                        </aside>
                    </div>
                </div>
            </div>

            {topStatus ? (
                <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-md border border-border bg-bg-elevated px-3 py-2 text-[11px] text-text-secondary shadow-sm">
                    {topStatus}
                </div>
            ) : null}

            {fileTreeContextMenu ? (
                <ContextMenu
                    entries={fileTreeContextMenuEntries}
                    menu={fileTreeContextMenu}
                    minWidth={180}
                    onClose={() => setFileTreeContextMenu(null)}
                />
            ) : null}
        </div>
    );
}

function ProjectSection({
    children,
    emptyCopy,
    projects,
    title,
}: {
    readonly children: (project: ProjectSummary) => ReactNode;
    readonly emptyCopy: string;
    readonly projects: readonly ProjectSummary[];
    readonly title: string;
}) {
    return (
        <section className="mb-4">
            <div className="mb-1.5 px-2 text-[11px] font-medium uppercase tracking-[0.16em] text-text-secondary">
                {title}
            </div>
            <div className="space-y-0.5">
                {projects.length === 0 ? (
                    <div className="px-2 py-2 text-xs text-text-secondary">
                        {emptyCopy}
                    </div>
                ) : (
                    projects.map((project) => children(project))
                )}
            </div>
        </section>
    );
}

function ProjectRow({
    isActive,
    onActivate,
    onRemove,
    project,
}: {
    readonly isActive: boolean;
    readonly onActivate: () => void;
    readonly onRemove: () => void;
    readonly project: ProjectSummary;
}) {
    return (
        <div
            className={[
                "group flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors",
                isActive
                    ? "bg-accent/12 text-accent-strong"
                    : "hover:bg-bg-secondary/80",
            ].join(" ")}
        >
            <button
                className="app-no-drag min-w-0 flex-1 text-left"
                onClick={onActivate}
                type="button"
            >
                <div className="truncate text-[13px] font-medium text-text-primary">
                    {project.name}
                </div>
                <div className="truncate text-[11px] text-text-secondary">
                    {project.rootPath}
                </div>
            </button>

            <button
                aria-label={`Remove ${project.name}`}
                className="app-no-drag rounded-md px-1 py-0.5 text-[11px] text-text-secondary opacity-0 transition hover:bg-bg-tertiary hover:text-text-primary group-hover:opacity-100"
                onClick={onRemove}
                type="button"
            >
                ×
            </button>
        </div>
    );
}

function TreeNodeRow({
    activeFilePath,
    expandedDirectories,
    loadingNodeKeys,
    nodesByParent,
    onOpenFile,
    onOpenMenu,
    onToggleDirectory,
    projectId,
    rootNode,
}: {
    readonly activeFilePath: string | null;
    readonly expandedDirectories: readonly string[];
    readonly loadingNodeKeys: readonly string[];
    readonly nodesByParent: Record<string, readonly ProjectTreeNode[]>;
    readonly onOpenFile: (relativePath: string) => void;
    readonly onOpenMenu: (
        event: ReactMouseEvent<HTMLButtonElement>,
        node: ProjectTreeNode,
    ) => void;
    readonly onToggleDirectory: (node: ProjectTreeNode) => void;
    readonly projectId: string;
    readonly rootNode: ProjectTreeNode;
}) {
    const isDirectory = rootNode.kind === "directory";
    const isExpanded = expandedDirectories.includes(rootNode.relativePath);
    const nodeKey = `${projectId}:${getParentKey(rootNode.relativePath)}`;
    const isLoading = loadingNodeKeys.includes(nodeKey);
    const childNodes = nodesByParent[getParentKey(rootNode.relativePath)] ?? [];
    const isActiveFile = activeFilePath === rootNode.relativePath;

    return (
        <div>
            <button
                className={[
                    "app-no-drag tree-row flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-left transition",
                    isActiveFile
                        ? "bg-selection text-text-primary"
                        : "text-text-secondary hover:bg-bg-secondary hover:text-text-primary",
                ].join(" ")}
                onClick={() =>
                    isDirectory
                        ? onToggleDirectory(rootNode)
                        : onOpenFile(rootNode.relativePath)
                }
                onContextMenu={(event) => onOpenMenu(event, rootNode)}
                type="button"
            >
                <span className="inline-flex w-3 justify-center text-[10px] text-text-secondary">
                    {isDirectory ? <TreeChevronIcon open={isExpanded} /> : null}
                </span>
                <span className="inline-flex w-4 justify-center text-text-secondary">
                    <TreeEntryIcon node={rootNode} open={isExpanded} />
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px]">
                    {rootNode.name}
                </span>
                {rootNode.gitStatus ? (
                    <GitBadge status={rootNode.gitStatus} />
                ) : null}
            </button>

            {isDirectory && isExpanded ? (
                <div className="ml-4 border-l border-border pl-2">
                    {isLoading ? (
                        <div className="px-1.5 py-1 text-[11px] text-text-secondary">
                            Loading...
                        </div>
                    ) : (
                        childNodes.map((node) => (
                            <TreeNodeRow
                                activeFilePath={activeFilePath}
                                expandedDirectories={expandedDirectories}
                                key={node.id}
                                loadingNodeKeys={loadingNodeKeys}
                                nodesByParent={nodesByParent}
                                onOpenFile={onOpenFile}
                                onOpenMenu={onOpenMenu}
                                onToggleDirectory={onToggleDirectory}
                                projectId={projectId}
                                rootNode={node}
                            />
                        ))
                    )}
                </div>
            ) : null}
        </div>
    );
}

function TreeChevronIcon({ open }: { readonly open: boolean }) {
    return (
        <svg
            aria-hidden="true"
            className="h-3 w-3 opacity-55 transition-transform duration-100"
            fill="none"
            style={{
                transform: open ? "rotate(90deg)" : "rotate(0deg)",
            }}
            viewBox="0 0 16 16"
        >
            <path
                d="M6 4l4 4-4 4"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.5"
            />
        </svg>
    );
}

function TreeEntryIcon({
    node,
    open,
}: {
    readonly node: ProjectTreeNode;
    readonly open: boolean;
}) {
    if (node.kind === "directory") {
        return <TreeFolderIcon open={open} />;
    }

    if (isMarkdownExtension(node.extension)) {
        return <TreeNoteIcon />;
    }

    if (node.extension?.toLowerCase() === "pdf") {
        return <TreePdfIcon />;
    }

    if (isImageExtension(node.extension)) {
        return <TreeImageIcon />;
    }

    return <TreeGenericFileIcon />;
}

function TreeFolderIcon({ open }: { readonly open: boolean }) {
    if (open) {
        return (
            <svg
                aria-hidden="true"
                className="h-3.75 w-3.75 shrink-0"
                fill="none"
                viewBox="0 0 16 16"
            >
                <path
                    d="M1.5 3.5A1 1 0 0 1 2.5 2.5H6l1.5 1.5h5a1 1 0 0 1 1 1V5H2.5V3.5Z"
                    fill="#f4c44c"
                    opacity="0.92"
                />
                <path
                    d="M1 5.5h13l-1.5 7.5H2.5L1 5.5Z"
                    fill="#e6b33e"
                    opacity="0.84"
                />
            </svg>
        );
    }

    return (
        <svg
            aria-hidden="true"
            className="h-3.75 w-3.75 shrink-0"
            fill="none"
            viewBox="0 0 16 16"
        >
            <path
                d="M2 3a1 1 0 0 1 1-1h3.5l1.5 1.5H13a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3Z"
                fill="#f0be49"
                opacity="0.78"
            />
        </svg>
    );
}

function TreeNoteIcon() {
    return (
        <svg
            aria-hidden="true"
            className="h-3.25 w-3.25 shrink-0 opacity-55"
            fill="none"
            viewBox="0 0 16 16"
        >
            <path
                d="M4 1.5h5.5L13 5v9a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 14V3A1.5 1.5 0 0 1 4 1.5Z"
                stroke="currentColor"
                strokeWidth="1"
            />
            <path
                d="M6 8h4M6 10.5h3"
                stroke="currentColor"
                strokeLinecap="round"
                strokeWidth="0.8"
            />
        </svg>
    );
}

function TreePdfIcon() {
    return (
        <svg
            aria-hidden="true"
            className="h-3.25 w-3.25 shrink-0"
            fill="none"
            viewBox="0 0 16 16"
        >
            <path
                d="M4 1.5h5.5L13 5v9a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 14V3A1.5 1.5 0 0 1 4 1.5Z"
                stroke="#e24b3b"
                strokeWidth="1"
            />
            <path
                d="M9.5 1.5V5H13"
                stroke="#e24b3b"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="0.8"
            />
            <text
                fill="#e24b3b"
                fontFamily="sans-serif"
                fontSize="4.5"
                fontWeight="700"
                x="5"
                y="12"
            >
                PDF
            </text>
        </svg>
    );
}

function TreeImageIcon() {
    return (
        <svg
            aria-hidden="true"
            className="h-3.25 w-3.25 shrink-0 opacity-58"
            fill="none"
            viewBox="0 0 16 16"
        >
            <rect
                height="11"
                rx="1.5"
                stroke="currentColor"
                strokeWidth="1"
                width="12"
                x="2"
                y="2.5"
            />
            <circle
                cx="5.5"
                cy="5.8"
                r="1.2"
                stroke="currentColor"
                strokeWidth="0.8"
            />
            <path
                d="M2.5 11l3-3.5 2.5 2.5 1.5-1.5 4 3.5"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="0.8"
            />
        </svg>
    );
}

function TreeGenericFileIcon() {
    return (
        <svg
            aria-hidden="true"
            className="h-3.25 w-3.25 shrink-0 opacity-58"
            fill="none"
            viewBox="0 0 16 16"
        >
            <path
                d="M4 1.5h5.5L13 5v9a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 14V3A1.5 1.5 0 0 1 4 1.5Z"
                stroke="currentColor"
                strokeWidth="1"
            />
            <path
                d="M9.5 1.5V5H13"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="0.8"
            />
        </svg>
    );
}

function GitBadge({ status }: { readonly status: GitStatusBadge }) {
    const label =
        status === "modified"
            ? "M"
            : status === "added"
              ? "A"
              : status === "deleted"
                ? "D"
                : status === "untracked"
                  ? "?"
                  : "•";

    const className =
        status === "deleted"
            ? "bg-red-50 text-red-600"
            : status === "added"
              ? "bg-emerald-50 text-emerald-600"
              : status === "modified"
                ? "bg-amber-50 text-amber-700"
                : status === "untracked"
                  ? "bg-slate-100 text-slate-600"
                  : "bg-sky-50 text-sky-600";

    return (
        <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${className}`}
        >
            {label}
        </span>
    );
}

function getComandoApi(): ComandoApi | null {
    return "comando" in window ? window.comando : null;
}

function getParentKey(parentRelativePath: string | null): string {
    return parentRelativePath ?? ROOT_NODE_KEY;
}

function isImageExtension(extension: string | null): boolean {
    if (!extension) {
        return false;
    }

    return ["avif", "gif", "jpeg", "jpg", "png", "svg", "webp"].includes(
        extension.toLowerCase(),
    );
}

function isMarkdownExtension(extension: string | null): boolean {
    if (!extension) {
        return false;
    }

    return ["markdown", "md", "mdx"].includes(extension.toLowerCase());
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
