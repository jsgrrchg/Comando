import { create } from "zustand";

import type {
    ProjectEntryKind,
    ProjectEntryMutationResult,
    ProjectSummary,
    ProjectTreeNode,
} from "@shared/ipc";

const ROOT_NODE_KEY = "__root__";

type ParentKey = string;

interface ProjectsState {
    readonly activeProjectId: string | null;
    readonly error: string | null;
    readonly expandedDirectories: Record<string, readonly string[]>;
    readonly fullyLoadedTreeProjects: Record<string, boolean>;
    readonly loadingNodeKeys: readonly string[];
    readonly projects: readonly ProjectSummary[];
    readonly treeNodes: Record<
        string,
        Record<ParentKey, readonly ProjectTreeNode[]>
    >;
    addProjectPath: (projectPath: string) => Promise<void>;
    addProjects: () => Promise<void>;
    createEntry: (
        projectId: string,
        parentRelativePath: string | null,
        name: string,
        kind: ProjectEntryKind,
        worktreeId?: string | null,
    ) => Promise<ProjectEntryMutationResult>;
    deleteEntry: (
        projectId: string,
        relativePath: string,
        worktreeId?: string | null,
    ) => Promise<void>;
    hydrate: (preferredProjectId?: string | null) => Promise<void>;
    loadEntireProjectTree: (
        projectId: string,
        worktreeId?: string | null,
    ) => Promise<void>;
    refreshProjectTree: (
        projectId: string,
        worktreeId?: string | null,
    ) => Promise<void>;
    renameEntry: (
        projectId: string,
        relativePath: string,
        nextName: string,
        worktreeId?: string | null,
    ) => Promise<ProjectEntryMutationResult>;
    removeProject: (projectId: string) => Promise<void>;
    revealEntry: (
        projectId: string,
        relativePath: string | null,
        worktreeId?: string | null,
    ) => Promise<void>;
    setActiveProject: (projectId: string) => Promise<void>;
    toggleDirectory: (
        projectId: string,
        node: ProjectTreeNode,
        worktreeId?: string | null,
    ) => Promise<void>;
}

type SetProjectsState = (
    partial:
        | Partial<ProjectsState>
        | ((state: ProjectsState) => Partial<ProjectsState>),
) => void;

type GetProjectsState = () => ProjectsState;

export const useProjectsStore = create<ProjectsState>((set, get) => ({
    activeProjectId: null,
    error: null,
    expandedDirectories: {},
    fullyLoadedTreeProjects: {},
    loadingNodeKeys: [],
    projects: [],
    treeNodes: {},

    addProjectPath: async (projectPath) => {
        const normalizedPath = projectPath.trim();

        if (!normalizedPath) {
            set({ error: "Paste a folder path before adding it." });
            return;
        }

        try {
            const projects = await getComandoApi().addProjectPaths([
                normalizedPath,
            ]);
            const nextActiveProjectId = projects[0]?.id ?? null;

            set({
                activeProjectId: nextActiveProjectId,
                error: null,
                projects,
            });

            if (nextActiveProjectId) {
                await loadDirectory(nextActiveProjectId, null, set, get);
            }
        } catch (error) {
            set({
                error:
                    error instanceof Error
                        ? error.message
                        : "Could not add the provided project path.",
            });
        }
    },

    addProjects: async () => {
        try {
            const projects = await getComandoApi().openProjects();
            const nextActiveProjectId = projects[0]?.id ?? null;

            set({
                activeProjectId: nextActiveProjectId,
                error: null,
                projects,
            });

            if (nextActiveProjectId) {
                await loadDirectory(nextActiveProjectId, null, set, get);
            }
        } catch (error) {
            set({
                error:
                    error instanceof Error
                        ? error.message
                        : "Could not add the selected project.",
            });
        }
    },

    createEntry: async (
        projectId,
        parentRelativePath,
        name,
        kind,
        worktreeId = null,
    ) => {
        const contextKey = getTreeContextKey(projectId, worktreeId);
        try {
            const entry = await getComandoApi().createProjectEntry({
                kind,
                name,
                parentRelativePath,
                projectId,
                worktreeId,
            });

            set((state) => ({
                error: null,
                fullyLoadedTreeProjects: {
                    ...state.fullyLoadedTreeProjects,
                    [contextKey]: false,
                },
                treeNodes: {
                    ...state.treeNodes,
                    [contextKey]: {},
                },
            }));
            void get().refreshProjectTree(projectId, worktreeId);
            return entry;
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : `Could not create the ${kind}.`;
            set({ error: message });
            throw error;
        }
    },

    deleteEntry: async (projectId, relativePath, worktreeId = null) => {
        const contextKey = getTreeContextKey(projectId, worktreeId);
        try {
            await getComandoApi().deleteProjectEntry({
                projectId,
                relativePath,
                worktreeId,
            });

            set((state) => ({
                error: null,
                expandedDirectories: {
                    ...state.expandedDirectories,
                    [contextKey]: removeMatchingPaths(
                        state.expandedDirectories[contextKey] ?? [],
                        relativePath,
                    ),
                },
                fullyLoadedTreeProjects: {
                    ...state.fullyLoadedTreeProjects,
                    [contextKey]: false,
                },
                treeNodes: {
                    ...state.treeNodes,
                    [contextKey]: {},
                },
            }));
            void get().refreshProjectTree(projectId, worktreeId);
        } catch (error) {
            set({
                error:
                    error instanceof Error
                        ? error.message
                        : "Could not delete the selected entry.",
            });
            throw error;
        }
    },

    hydrate: async (preferredProjectId = null) => {
        try {
            const projects = await getComandoApi().listProjects();
            const currentActiveProjectId = get().activeProjectId;
            const nextActiveProjectId =
                projects.find(
                    (project) =>
                        project.id === preferredProjectId ||
                        project.id === currentActiveProjectId,
                )?.id ??
                projects[0]?.id ??
                null;

            set({
                activeProjectId: nextActiveProjectId,
                error: null,
                projects,
            });

            if (nextActiveProjectId) {
                await loadDirectory(nextActiveProjectId, null, set, get);
            }
        } catch (error) {
            set({
                error:
                    error instanceof Error
                        ? error.message
                        : "Could not load the project list.",
            });
        }
    },

    loadEntireProjectTree: async (projectId, worktreeId = null) => {
        const contextKey = getTreeContextKey(projectId, worktreeId);
        await loadDirectory(projectId, null, set, get, worktreeId);

        const queue = [...(get().treeNodes[contextKey]?.[ROOT_NODE_KEY] ?? [])];
        const visitedDirectories = new Set<string>();

        while (queue.length > 0) {
            const currentNode = queue.shift();

            if (
                !currentNode ||
                currentNode.kind !== "directory" ||
                visitedDirectories.has(currentNode.relativePath) ||
                !currentNode.hasChildren
            ) {
                continue;
            }

            visitedDirectories.add(currentNode.relativePath);

            const parentKey = getParentKey(currentNode.relativePath);
            const currentTree = get().treeNodes[contextKey] ?? {};

            if (!(parentKey in currentTree)) {
                await loadDirectory(
                    projectId,
                    currentNode.relativePath,
                    set,
                    get,
                    worktreeId,
                );
            }

            const childNodes = get().treeNodes[contextKey]?.[parentKey] ?? [];

            queue.push(...childNodes);
        }

        set((state) => ({
            fullyLoadedTreeProjects: {
                ...state.fullyLoadedTreeProjects,
                [contextKey]: true,
            },
        }));
    },

    refreshProjectTree: async (projectId, worktreeId = null) => {
        const contextKey = getTreeContextKey(projectId, worktreeId);
        const state = get();
        const expandedDirectories = state.expandedDirectories[contextKey] ?? [];
        const parentPaths = [null, ...expandedDirectories];

        try {
            const entries = await Promise.all(
                parentPaths.map(async (parentRelativePath) => ({
                    nodes: await getComandoApi().listProjectTree({
                        parentRelativePath,
                        projectId,
                        worktreeId,
                    }),
                    parentRelativePath,
                })),
            );

            set((currentState) => {
                const projectTree = {
                    ...(currentState.treeNodes[contextKey] ?? {}),
                };

                for (const entry of entries) {
                    projectTree[getParentKey(entry.parentRelativePath)] =
                        entry.nodes;
                }

                return {
                    error: null,
                    fullyLoadedTreeProjects: {
                        ...currentState.fullyLoadedTreeProjects,
                        [contextKey]: false,
                    },
                    treeNodes: {
                        ...currentState.treeNodes,
                        [contextKey]: projectTree,
                    },
                };
            });
        } catch (error) {
            set({
                error:
                    error instanceof Error
                        ? error.message
                        : "Could not refresh the project tree.",
            });
        }
    },

    renameEntry: async (
        projectId,
        relativePath,
        nextName,
        worktreeId = null,
    ) => {
        const contextKey = getTreeContextKey(projectId, worktreeId);
        try {
            const entry = await getComandoApi().renameProjectEntry({
                nextName,
                projectId,
                relativePath,
                worktreeId,
            });

            set((state) => ({
                error: null,
                expandedDirectories: {
                    ...state.expandedDirectories,
                    [contextKey]: renameMatchingPaths(
                        state.expandedDirectories[contextKey] ?? [],
                        relativePath,
                        entry.relativePath,
                    ),
                },
                fullyLoadedTreeProjects: {
                    ...state.fullyLoadedTreeProjects,
                    [contextKey]: false,
                },
                treeNodes: {
                    ...state.treeNodes,
                    [contextKey]: {},
                },
            }));
            void get().refreshProjectTree(projectId, worktreeId);
            return entry;
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : "Could not rename the selected entry.";
            set({ error: message });
            throw error;
        }
    },

    removeProject: async (projectId) => {
        try {
            await getComandoApi().removeProject(projectId);
            const projects = await getComandoApi().listProjects();

            set((state) => ({
                activeProjectId:
                    state.activeProjectId === projectId
                        ? (projects[0]?.id ?? null)
                        : state.activeProjectId,
                error: null,
                expandedDirectories: omitProjectContexts(
                    state.expandedDirectories,
                    projectId,
                ),
                fullyLoadedTreeProjects: omitProjectContexts(
                    state.fullyLoadedTreeProjects,
                    projectId,
                ),
                projects,
                treeNodes: omitProjectContexts(state.treeNodes, projectId),
            }));

            const nextProjectId = get().activeProjectId;
            if (nextProjectId) {
                await loadDirectory(nextProjectId, null, set, get);
            }
        } catch (error) {
            set({
                error:
                    error instanceof Error
                        ? error.message
                        : "Could not remove the selected project.",
            });
        }
    },

    revealEntry: async (projectId, relativePath, worktreeId = null) => {
        try {
            await getComandoApi().revealProjectEntry({
                projectId,
                relativePath,
                worktreeId,
            });
            set({ error: null });
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : "Could not reveal the selected entry.";
            set({ error: message });
            throw error;
        }
    },

    setActiveProject: async (projectId) => {
        try {
            await getComandoApi().touchProject(projectId);
            const projects = await getComandoApi().listProjects();

            set({
                activeProjectId: projectId,
                error: null,
                projects,
            });

            await loadDirectory(projectId, null, set, get);
        } catch (error) {
            set({
                error:
                    error instanceof Error
                        ? error.message
                        : "Could not activate the selected project.",
            });
        }
    },

    toggleDirectory: async (projectId, node, worktreeId = null) => {
        if (node.kind !== "directory") {
            return;
        }

        const contextKey = getTreeContextKey(projectId, worktreeId);
        const expandedDirectories = get().expandedDirectories[contextKey] ?? [];
        const isExpanded = expandedDirectories.includes(node.relativePath);

        set((state) => ({
            expandedDirectories: {
                ...state.expandedDirectories,
                [contextKey]: isExpanded
                    ? expandedDirectories.filter(
                          (path) => path !== node.relativePath,
                      )
                    : [...expandedDirectories, node.relativePath],
            },
        }));

        if (!isExpanded) {
            await loadDirectory(
                projectId,
                node.relativePath,
                set,
                get,
                worktreeId,
            );
        }
    },
}));

function getParentKey(parentRelativePath: string | null): ParentKey {
    return parentRelativePath ?? ROOT_NODE_KEY;
}

async function loadDirectory(
    projectId: string,
    parentRelativePath: string | null,
    set: SetProjectsState,
    get: GetProjectsState,
    worktreeId: string | null = null,
): Promise<void> {
    const contextKey = getTreeContextKey(projectId, worktreeId);
    const nodeKey = `${contextKey}:${getParentKey(parentRelativePath)}`;

    if (get().loadingNodeKeys.includes(nodeKey)) {
        return;
    }

    set((state) => ({
        loadingNodeKeys: [...state.loadingNodeKeys, nodeKey],
    }));

    try {
        const nodes = await getComandoApi().listProjectTree({
            parentRelativePath,
            projectId,
            worktreeId,
        });

        set((state) => ({
            error: null,
            treeNodes: {
                ...state.treeNodes,
                [contextKey]: {
                    ...(state.treeNodes[contextKey] ?? {}),
                    [getParentKey(parentRelativePath)]: nodes,
                },
            },
        }));
    } catch (error) {
        set({
            error:
                error instanceof Error
                    ? error.message
                    : "Could not read this folder.",
        });
    } finally {
        set((state) => ({
            loadingNodeKeys: state.loadingNodeKeys.filter(
                (key) => key !== nodeKey,
            ),
        }));
    }
}

function getComandoApi() {
    if (!window.comando) {
        throw new Error(
            "The desktop bridge is not available yet. Restart the Electron app and try again.",
        );
    }

    return window.comando;
}

function omitProjectContexts<TValue>(
    record: Record<string, TValue>,
    projectId: string,
): Record<string, TValue> {
    return Object.fromEntries(
        Object.entries(record).filter(
            ([key]) => !key.startsWith(`${projectId}::`),
        ),
    );
}

function getTreeContextKey(
    projectId: string,
    worktreeId: string | null | undefined,
): string {
    return `${projectId}::${worktreeId ?? "__primary__"}`;
}

function removeMatchingPaths(
    paths: readonly string[],
    relativePath: string,
): readonly string[] {
    return paths.filter(
        (path) => path !== relativePath && !path.startsWith(`${relativePath}/`),
    );
}

function renameMatchingPaths(
    paths: readonly string[],
    previousPath: string,
    nextPath: string,
): readonly string[] {
    const renamedPaths = paths.map((path) => {
        if (path === previousPath) {
            return nextPath;
        }

        if (path.startsWith(`${previousPath}/`)) {
            return `${nextPath}${path.slice(previousPath.length)}`;
        }

        return path;
    });

    return [...new Set(renamedPaths)];
}
