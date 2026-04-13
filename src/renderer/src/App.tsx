import {
    useEffect,
    useEffectEvent,
    useMemo,
    useState,
    type ReactNode,
    type PointerEvent as ReactPointerEvent,
} from "react";

import type {
    GitStatusBadge,
    ProjectSummary,
    ProjectTreeNode,
} from "@shared/ipc";

import { useSystemTheme } from "./app/hooks/use-system-theme";
import { shellLayoutConstraints } from "./app/layout/shell-layout";
import { useAppStore } from "./app/store/app-store";
import { useProjectsStore } from "./app/store/projects-store";
import { useShellStore } from "./app/store/shell-store";
import { useWorkspaceStore } from "./app/store/workspace-store";
import { findPaneById } from "./app/workspace/tree";
import { SplitHandle } from "./components/SplitHandle";
import { WorkspaceView } from "./components/workspace/WorkspaceView";

type DragState = {
    readonly side: "left" | "right";
    readonly startWidth: number;
    readonly startX: number;
} | null;

const ROOT_NODE_KEY = "__root__";

export function App() {
    useSystemTheme();

    const bootstrap = useAppStore((state) => state.bootstrap);
    const bootstrapError = useAppStore((state) => state.error);
    const bootstrapStatus = useAppStore((state) => state.status);
    const hydrateBootstrap = useAppStore((state) => state.hydrate);

    const activeProjectId = useProjectsStore((state) => state.activeProjectId);
    const addProjectPath = useProjectsStore((state) => state.addProjectPath);
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
    const [isPathEntryVisible, setIsPathEntryVisible] = useState(false);
    const [manualProjectPath, setManualProjectPath] = useState("");
    const [persistenceReady, setPersistenceReady] = useState(false);
    const [projectFilter, setProjectFilter] = useState("");

    useEffect(() => {
        let isDisposed = false;

        const hydrateApp = async () => {
            void hydrateBootstrap();

            try {
                const persistenceSnapshot = window.comando
                    ? await window.comando.getPersistenceSnapshot()
                    : null;

                if (isDisposed) {
                    return;
                }

                hydrateShell(persistenceSnapshot?.shellState ?? null);
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
        if (!window.comando) {
            return;
        }

        const unsubscribe = window.comando.onProjectTreeInvalidated(
            (payload) => {
                void refreshProjectTree(payload.projectId);
                void refreshProjectTabs(payload.projectId);
            },
        );

        return unsubscribe;
    }, [refreshProjectTabs, refreshProjectTree]);

    useEffect(() => {
        if (!window.comando) {
            return;
        }

        const unsubscribeData = window.comando.onTerminalData((event) => {
            appendTerminalOutput(event);
        });
        const unsubscribeExit = window.comando.onTerminalExit((event) => {
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
        if (!persistenceReady || !window.comando) {
            return;
        }

        const timeout = window.setTimeout(() => {
            void window.comando.saveShellState({
                activeSurface,
                leftWidth,
                rightWidth,
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
    const windowChromePaddingClass =
        bootstrap?.platform === "darwin" ? "pl-[92px]" : "pl-4";
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

    return (
        <div className="min-h-screen text-text-primary">
            <div className="relative h-screen">
                <div className="h-full overflow-hidden">
                    <div className="app-drag border-b border-border/50 px-4 py-2">
                        <div
                            className={`flex items-center justify-between gap-4 ${windowChromePaddingClass}`}
                        >
                            <div className="min-w-0">
                                <div className="flex items-center gap-2 text-[11px] text-text-secondary">
                                    <span>Comando</span>
                                    <span>/</span>
                                    <span>
                                        {activeProject?.name ??
                                            "No project selected"}
                                    </span>
                                    {activeWorkspaceTab ? (
                                        <>
                                            <span>/</span>
                                            <span className="truncate">
                                                {activeWorkspaceTab.kind ===
                                                "file"
                                                    ? activeWorkspaceTab.relativePath
                                                    : activeWorkspaceTab.title}
                                            </span>
                                        </>
                                    ) : null}
                                </div>
                            </div>

                            <div className="app-no-drag flex items-center gap-2 text-[11px] text-text-secondary">
                                <span>
                                    {bootstrapStatus === "ready"
                                        ? bootstrap?.versions.electron
                                        : "Booting"}
                                </span>
                                <span className="rounded-full border border-border bg-bg-elevated px-2 py-0.5">
                                    Phase 3
                                </span>
                            </div>
                        </div>
                    </div>

                    <div
                        className="grid h-[calc(100%-41px)]"
                        style={{ gridTemplateColumns }}
                    >
                        <aside
                            className="surface-focus flex min-h-0 flex-col border-r border-border"
                            data-active={activeSurface === "projects"}
                            onClick={() => focusSurface("projects")}
                            onFocus={() => focusSurface("projects")}
                            tabIndex={0}
                        >
                            <div className="border-b border-border/50 px-3 py-3">
                                <div className="mb-3 flex items-center justify-between gap-3">
                                    <div>
                                        <p className="text-[11px] uppercase tracking-[0.18em] text-text-secondary">
                                            Projects
                                        </p>
                                        <h1 className="mt-1 text-sm font-semibold text-text-primary">
                                            Workspace roots
                                        </h1>
                                    </div>

                                    <button
                                        className="ide-button app-no-drag"
                                        onClick={() => void addProjects()}
                                        type="button"
                                    >
                                        Add Project
                                    </button>
                                </div>

                                <div className="mb-3 flex items-center gap-2">
                                    <button
                                        className="ide-button app-no-drag"
                                        onClick={() =>
                                            setIsPathEntryVisible(
                                                (current) => !current,
                                            )
                                        }
                                        type="button"
                                    >
                                        Add Path
                                    </button>
                                    <span className="text-[11px] text-text-secondary">
                                        Use this if the native picker does not
                                        appear.
                                    </span>
                                </div>

                                {isPathEntryVisible ? (
                                    <form
                                        className="mb-3 space-y-2"
                                        onSubmit={(event) => {
                                            event.preventDefault();
                                            void addProjectPath(
                                                manualProjectPath,
                                            ).then(() => {
                                                setManualProjectPath("");
                                            });
                                        }}
                                    >
                                        <input
                                            className="ide-input app-no-drag w-full"
                                            onChange={(event) =>
                                                setManualProjectPath(
                                                    event.target.value,
                                                )
                                            }
                                            placeholder="/Users/you/Development/MyProject"
                                            type="text"
                                            value={manualProjectPath}
                                        />
                                        <div className="flex justify-end">
                                            <button
                                                className="ide-button app-no-drag"
                                                type="submit"
                                            >
                                                Save Path
                                            </button>
                                        </div>
                                    </form>
                                ) : null}

                                <label className="block">
                                    <span className="sr-only">
                                        Filter projects
                                    </span>
                                    <input
                                        className="ide-input app-no-drag w-full"
                                        onChange={(event) =>
                                            setProjectFilter(event.target.value)
                                        }
                                        placeholder="Filter projects..."
                                        type="text"
                                        value={projectFilter}
                                    />
                                </label>

                                {projectsError ? (
                                    <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-700">
                                        {projectsError}
                                    </div>
                                ) : null}
                            </div>

                            <div className="shell-scrollbar flex-1 overflow-y-auto px-2 py-3">
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
                                <div className="mb-3 flex items-center justify-between gap-3">
                                    <div>
                                        <p className="text-[11px] uppercase tracking-[0.18em] text-text-secondary">
                                            Files
                                        </p>
                                        <h2 className="mt-1 text-sm font-semibold text-text-primary">
                                            {activeProject?.name ??
                                                "Project explorer"}
                                        </h2>
                                    </div>

                                    {activeProject ? (
                                        <button
                                            className="ide-button app-no-drag"
                                            onClick={() =>
                                                void refreshProjectTree(
                                                    activeProject.id,
                                                )
                                            }
                                            type="button"
                                        >
                                            Refresh
                                        </button>
                                    ) : null}
                                </div>

                                <div className="ide-input pointer-events-none truncate">
                                    {activeProject?.rootPath ??
                                        "Pick a project to inspect its files."}
                                </div>
                            </div>

                            <div className="shell-scrollbar min-h-0 flex-1 overflow-y-auto px-2 py-2">
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
        <section className="mb-5">
            <div className="mb-2 px-1 text-[11px] font-medium uppercase tracking-[0.16em] text-text-secondary">
                {title}
            </div>
            <div className="space-y-1">
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
                "group flex items-center gap-2 rounded-lg border px-2 py-2 transition",
                isActive
                    ? "border-accent bg-accent-soft"
                    : "border-transparent hover:border-border hover:bg-bg-secondary",
            ].join(" ")}
        >
            <button
                className="app-no-drag min-w-0 flex-1 text-left"
                onClick={onActivate}
                type="button"
            >
                <div className="truncate text-sm font-medium text-text-primary">
                    {project.name}
                </div>
                <div className="truncate text-[11px] text-text-secondary">
                    {project.rootPath}
                </div>
            </button>

            <button
                aria-label={`Remove ${project.name}`}
                className="app-no-drag rounded px-1.5 py-1 text-[11px] text-text-secondary opacity-0 transition hover:bg-bg-tertiary hover:text-text-primary group-hover:opacity-100"
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
    onToggleDirectory,
    projectId,
    rootNode,
}: {
    readonly activeFilePath: string | null;
    readonly expandedDirectories: readonly string[];
    readonly loadingNodeKeys: readonly string[];
    readonly nodesByParent: Record<string, readonly ProjectTreeNode[]>;
    readonly onOpenFile: (relativePath: string) => void;
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
                type="button"
            >
                <span className="inline-flex w-3 justify-center text-[10px]">
                    {isDirectory ? (isExpanded ? "▾" : "▸") : ""}
                </span>
                <span className="inline-flex w-4 justify-center">
                    {isDirectory ? (
                        <span className="relative inline-flex h-3 w-3.5 rounded-[3px] border border-amber-300 bg-amber-50">
                            <span className="absolute -top-px left-0.5 h-1 w-1.5 rounded-t-[2px] border border-b-0 border-amber-300 bg-amber-50" />
                        </span>
                    ) : (
                        <span className="inline-flex h-3.5 w-3 rounded-[2px] border border-slate-300 bg-white" />
                    )}
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

function getParentKey(parentRelativePath: string | null): string {
    return parentRelativePath ?? ROOT_NODE_KEY;
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
