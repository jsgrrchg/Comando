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
    ) => Promise<ProjectEntryMutationResult>;
    deleteEntry: (projectId: string, relativePath: string) => Promise<void>;
    hydrate: (preferredProjectId?: string | null) => Promise<void>;
    refreshProjectTree: (projectId: string) => Promise<void>;
    renameEntry: (
        projectId: string,
        relativePath: string,
        nextName: string,
    ) => Promise<ProjectEntryMutationResult>;
    removeProject: (projectId: string) => Promise<void>;
    revealEntry: (
        projectId: string,
        relativePath: string | null,
    ) => Promise<void>;
    setActiveProject: (projectId: string) => Promise<void>;
    toggleDirectory: (
        projectId: string,
        node: ProjectTreeNode,
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

    createEntry: async (projectId, parentRelativePath, name, kind) => {
        try {
            const entry = await getComandoApi().createProjectEntry({
                kind,
                name,
                parentRelativePath,
                projectId,
            });

            set((state) => ({
                error: null,
                treeNodes: {
                    ...state.treeNodes,
                    [projectId]: {},
                },
            }));
            void get().refreshProjectTree(projectId);
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

    deleteEntry: async (projectId, relativePath) => {
        try {
            await getComandoApi().deleteProjectEntry({
                projectId,
                relativePath,
            });

            set((state) => ({
                error: null,
                expandedDirectories: {
                    ...state.expandedDirectories,
                    [projectId]: removeMatchingPaths(
                        state.expandedDirectories[projectId] ?? [],
                        relativePath,
                    ),
                },
                treeNodes: {
                    ...state.treeNodes,
                    [projectId]: {},
                },
            }));
            void get().refreshProjectTree(projectId);
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

    refreshProjectTree: async (projectId) => {
        const state = get();
        const expandedDirectories = state.expandedDirectories[projectId] ?? [];
        const parentPaths = [null, ...expandedDirectories];

        try {
            const entries = await Promise.all(
                parentPaths.map(async (parentRelativePath) => ({
                    nodes: await getComandoApi().listProjectTree({
                        parentRelativePath,
                        projectId,
                    }),
                    parentRelativePath,
                })),
            );

            set((currentState) => {
                const projectTree = {
                    ...(currentState.treeNodes[projectId] ?? {}),
                };

                for (const entry of entries) {
                    projectTree[getParentKey(entry.parentRelativePath)] =
                        entry.nodes;
                }

                return {
                    error: null,
                    treeNodes: {
                        ...currentState.treeNodes,
                        [projectId]: projectTree,
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

    renameEntry: async (projectId, relativePath, nextName) => {
        try {
            const entry = await getComandoApi().renameProjectEntry({
                nextName,
                projectId,
                relativePath,
            });

            set((state) => ({
                error: null,
                expandedDirectories: {
                    ...state.expandedDirectories,
                    [projectId]: renameMatchingPaths(
                        state.expandedDirectories[projectId] ?? [],
                        relativePath,
                        entry.relativePath,
                    ),
                },
                treeNodes: {
                    ...state.treeNodes,
                    [projectId]: {},
                },
            }));
            void get().refreshProjectTree(projectId);
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
                expandedDirectories: omitProjectKey(
                    state.expandedDirectories,
                    projectId,
                ),
                projects,
                treeNodes: omitProjectKey(state.treeNodes, projectId),
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

    revealEntry: async (projectId, relativePath) => {
        try {
            await getComandoApi().revealProjectEntry({
                projectId,
                relativePath,
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

    toggleDirectory: async (projectId, node) => {
        if (node.kind !== "directory") {
            return;
        }

        const expandedDirectories = get().expandedDirectories[projectId] ?? [];
        const isExpanded = expandedDirectories.includes(node.relativePath);

        set((state) => ({
            expandedDirectories: {
                ...state.expandedDirectories,
                [projectId]: isExpanded
                    ? expandedDirectories.filter(
                          (path) => path !== node.relativePath,
                      )
                    : [...expandedDirectories, node.relativePath],
            },
        }));

        if (!isExpanded) {
            await loadDirectory(projectId, node.relativePath, set, get);
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
): Promise<void> {
    const nodeKey = `${projectId}:${getParentKey(parentRelativePath)}`;

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
        });

        set((state) => ({
            error: null,
            treeNodes: {
                ...state.treeNodes,
                [projectId]: {
                    ...(state.treeNodes[projectId] ?? {}),
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

function omitProjectKey<TValue>(
    record: Record<string, TValue>,
    projectId: string,
): Record<string, TValue> {
    return Object.fromEntries(
        Object.entries(record).filter(([key]) => key !== projectId),
    );
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
