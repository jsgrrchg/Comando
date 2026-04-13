import { create } from "zustand";

import type { ProjectSummary, ProjectTreeNode } from "@shared/ipc";

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
    hydrate: (preferredProjectId?: string | null) => Promise<void>;
    refreshProjectTree: (projectId: string) => Promise<void>;
    removeProject: (projectId: string) => Promise<void>;
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
