import { create } from "zustand";

import type {
    CopyProjectEntriesResult,
    ProjectAppDataSummary,
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
    clearProjectAppData: (projectId: string) => Promise<void>;
    cloneRepository: (repositoryUrl: string) => Promise<boolean>;
    createEntry: (
        projectId: string,
        parentRelativePath: string | null,
        name: string,
        kind: ProjectEntryKind,
        worktreeId?: string | null,
    ) => Promise<ProjectEntryMutationResult>;
    copyEntries: (
        projectId: string,
        sourceRelativePaths: readonly string[],
        destinationParentRelativePath: string | null,
        worktreeId?: string | null,
    ) => Promise<CopyProjectEntriesResult>;
    deleteEntry: (
        projectId: string,
        relativePath: string,
        worktreeId?: string | null,
    ) => Promise<void>;
    trashEntry: (
        projectId: string,
        relativePath: string,
        worktreeId?: string | null,
    ) => Promise<void>;
    openEntryExternally: (
        projectId: string,
        relativePath: string,
        worktreeId?: string | null,
    ) => Promise<void>;
    getProjectAppDataSummary: (
        projectId: string,
    ) => Promise<ProjectAppDataSummary>;
    hydrate: (preferredProjectId?: string | null) => Promise<void>;
    loadEntireProjectTree: (
        projectId: string,
        worktreeId?: string | null,
    ) => Promise<void>;
    refreshProjectTree: (
        projectId: string,
        worktreeId?: string | null,
    ) => Promise<void>;
    revealPathInTree: (
        projectId: string,
        relativePath: string,
        worktreeId?: string | null,
    ) => Promise<void>;
    renameEntry: (
        projectId: string,
        relativePath: string,
        nextName: string,
        nextParentRelativePath?: string | null,
        worktreeId?: string | null,
    ) => Promise<ProjectEntryMutationResult>;
    removeProject: (projectId: string) => Promise<void>;
    relocateProject: (projectId: string) => Promise<boolean>;
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

interface ResolveNextActiveProjectIdInput {
    readonly currentActiveProjectId: string | null;
    readonly projects: readonly ProjectSummary[];
}

type SetProjectsState = (
    partial:
        | Partial<ProjectsState>
        | ((state: ProjectsState) => Partial<ProjectsState>),
) => void;

type GetProjectsState = () => ProjectsState;

interface ProjectTreeRefreshEntry {
    readonly nodes: readonly ProjectTreeNode[];
    readonly parentRelativePath: string | null;
}

interface ProjectTreeRefreshResolution {
    readonly error: Error | null;
    readonly expandedDirectories: readonly string[];
    readonly treeNodes: Record<ParentKey, readonly ProjectTreeNode[]>;
}

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
            const { projectIdsToOpen, projects } =
                await getComandoApi().addProjectPaths([
                    normalizedPath,
                ]);
            const currentActiveProjectId = get().activeProjectId;
            const nextActiveProjectId = resolveNextActiveProjectId({
                currentActiveProjectId,
                projects,
            });

            set({
                activeProjectId: nextActiveProjectId,
                error: null,
                projects,
            });

            if (nextActiveProjectId) {
                await loadDirectory(nextActiveProjectId, null, set, get);
            }

            await openProjectsInWindows(projectIdsToOpen);
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
            const { projectIdsToOpen, projects } =
                await getComandoApi().openProjects();
            const currentActiveProjectId = get().activeProjectId;
            const nextActiveProjectId = resolveNextActiveProjectId({
                currentActiveProjectId,
                projects,
            });

            set({
                activeProjectId: nextActiveProjectId,
                error: null,
                projects,
            });

            if (nextActiveProjectId) {
                await loadDirectory(nextActiveProjectId, null, set, get);
            }

            await openProjectsInWindows(projectIdsToOpen);
        } catch (error) {
            set({
                error:
                    error instanceof Error
                        ? error.message
                        : "Could not add the selected project.",
            });
        }
    },

    clearProjectAppData: async (projectId) => {
        try {
            const { projects } = await getComandoApi().clearProjectAppData({
                projectId,
            });

            set((state) => ({
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
        } catch (error) {
            set({
                error:
                    error instanceof Error
                        ? error.message
                        : "Could not clear this project's app data.",
            });
            throw error;
        }
    },

    cloneRepository: async (repositoryUrl) => {
        const normalizedUrl = repositoryUrl.trim();
        if (!normalizedUrl) {
            set({ error: "Paste a repository URL before cloning." });
            return false;
        }

        try {
            const response = await getComandoApi().cloneRepository({
                repositoryUrl: normalizedUrl,
            });

            if (response.kind === "canceled") {
                set({ error: null });
                return false;
            }

            const { projectIdsToOpen, projects } = response.result;
            const currentActiveProjectId = get().activeProjectId;
            const nextActiveProjectId = resolveNextActiveProjectId({
                currentActiveProjectId,
                projects,
            });

            set({
                activeProjectId: nextActiveProjectId,
                error: null,
                projects,
            });

            if (nextActiveProjectId) {
                await loadDirectory(nextActiveProjectId, null, set, get);
            }

            await openProjectsInWindows(projectIdsToOpen);
            return true;
        } catch (error) {
            set({
                error:
                    error instanceof Error
                        ? error.message
                        : "Could not clone the repository.",
            });
            return false;
        }
    },

    getProjectAppDataSummary: async (projectId) => {
        try {
            const summary =
                await getComandoApi().getProjectAppDataSummary(projectId);
            set({ error: null });
            return summary;
        } catch (error) {
            set({
                error:
                    error instanceof Error
                        ? error.message
                        : "Could not inspect this project's app data.",
            });
            throw error;
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

    copyEntries: async (
        projectId,
        sourceRelativePaths,
        destinationParentRelativePath,
        worktreeId = null,
    ) => {
        const contextKey = getTreeContextKey(projectId, worktreeId);
        try {
            const result = await getComandoApi().copyProjectEntries({
                destinationParentRelativePath,
                projectId,
                sourceRelativePaths,
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
            await get().refreshProjectTree(projectId, worktreeId);
            return result;
        } catch (error) {
            set({
                error:
                    error instanceof Error
                        ? error.message
                        : "Could not paste the selected entries.",
            });
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

    trashEntry: async (projectId, relativePath, worktreeId = null) => {
        const contextKey = getTreeContextKey(projectId, worktreeId);
        try {
            await getComandoApi().trashProjectEntry({
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
                        : "Could not move the selected entry to Trash.",
            });
            throw error;
        }
    },

    openEntryExternally: async (projectId, relativePath, worktreeId = null) => {
        try {
            await getComandoApi().openProjectEntryExternally({
                projectId,
                relativePath,
                worktreeId,
            });
            set({ error: null });
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : "Could not open the selected file externally.";
            set({ error: message });
            throw error;
        }
    },

    hydrate: async (preferredProjectId = null) => {
        try {
            const projects = await getComandoApi().listProjects();
            const currentActiveProjectId = get().activeProjectId;
            const nextActiveProjectId = preferredProjectId
                ? (projects.find((project) => project.id === preferredProjectId)
                      ?.id ?? null)
                : (projects.find(
                      (project) => project.id === currentActiveProjectId,
                  )?.id ?? null);

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
            const results = await Promise.allSettled(
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
                const resolution = resolveProjectTreeRefresh({
                    currentTree: currentState.treeNodes[contextKey] ?? {},
                    expandedDirectories:
                        currentState.expandedDirectories[contextKey] ?? [],
                    parentPaths,
                    results,
                });

                if (resolution.error) {
                    throw resolution.error;
                }

                return {
                    error: null,
                    expandedDirectories: {
                        ...currentState.expandedDirectories,
                        [contextKey]: resolution.expandedDirectories,
                    },
                    fullyLoadedTreeProjects: {
                        ...currentState.fullyLoadedTreeProjects,
                        [contextKey]: false,
                    },
                    treeNodes: {
                        ...currentState.treeNodes,
                        [contextKey]: resolution.treeNodes,
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

    revealPathInTree: async (projectId, relativePath, worktreeId = null) => {
        const contextKey = getTreeContextKey(projectId, worktreeId);
        const ancestorDirectories = getAncestorDirectoryPaths(relativePath);

        await loadDirectory(projectId, null, set, get, worktreeId);

        for (const directoryPath of ancestorDirectories) {
            await loadDirectory(projectId, directoryPath, set, get, worktreeId);
        }

        set((state) => ({
            error: null,
            expandedDirectories: {
                ...state.expandedDirectories,
                [contextKey]: mergeUniquePaths(
                    state.expandedDirectories[contextKey] ?? [],
                    ancestorDirectories,
                ),
            },
        }));
    },

    renameEntry: async (
        projectId,
        relativePath,
        nextName,
        nextParentRelativePath = undefined,
        worktreeId = null,
    ) => {
        const contextKey = getTreeContextKey(projectId, worktreeId);
        try {
            const entry = await getComandoApi().renameProjectEntry({
                nextName,
                nextParentRelativePath,
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

    relocateProject: async (projectId) => {
        try {
            const response = await getComandoApi().relocateProject(projectId);
            const projects = response.projects;

            set((state) => ({
                activeProjectId:
                    state.activeProjectId &&
                    projects.some(
                        (project) => project.id === state.activeProjectId,
                    )
                        ? state.activeProjectId
                        : null,
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

            if (response.kind !== "relocated") {
                return false;
            }

            const nextProjectId = get().activeProjectId;
            if (nextProjectId === projectId) {
                await loadDirectory(projectId, null, set, get);
            }

            return true;
        } catch (error) {
            set({
                error:
                    error instanceof Error
                        ? error.message
                        : "Could not change this project's location.",
            });
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
                        ? null
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

export function resolveNextActiveProjectId({
    currentActiveProjectId,
    projects,
}: ResolveNextActiveProjectIdInput): string | null {
    if (
        currentActiveProjectId &&
        projects.some((project) => project.id === currentActiveProjectId)
    ) {
        return currentActiveProjectId;
    }

    return null;
}

async function openProjectsInWindows(
    projectIdsToOpen: readonly string[],
): Promise<void> {
    const comandoApi = getComandoApi();
    if (!comandoApi || projectIdsToOpen.length === 0) {
        return;
    }

    for (const projectId of projectIdsToOpen) {
        await comandoApi.openProjectWindow({ projectId });
    }
}

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
        if (isMissingProjectTreePathError(error)) {
            set((state) => ({
                error: null,
                expandedDirectories: {
                    ...state.expandedDirectories,
                    [contextKey]:
                        parentRelativePath === null
                            ? []
                            : removeMatchingPaths(
                                  state.expandedDirectories[contextKey] ?? [],
                                  parentRelativePath,
                              ),
                },
                treeNodes: {
                    ...state.treeNodes,
                    [contextKey]:
                        parentRelativePath === null
                            ? { [ROOT_NODE_KEY]: [] }
                            : omitTreeBranch(
                                  state.treeNodes[contextKey] ?? {},
                                  parentRelativePath,
                              ),
                },
            }));
            return;
        }

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

export function resolveProjectTreeRefresh(input: {
    readonly currentTree: Record<ParentKey, readonly ProjectTreeNode[]>;
    readonly expandedDirectories: readonly string[];
    readonly parentPaths: readonly (string | null)[];
    readonly results: readonly PromiseSettledResult<ProjectTreeRefreshEntry>[];
}): ProjectTreeRefreshResolution {
    let nextTree = { ...input.currentTree };
    let nextExpandedDirectories: readonly string[] = [
        ...input.expandedDirectories,
    ];
    let nextError: Error | null = null;

    for (const [index, result] of input.results.entries()) {
        if (result.status === "fulfilled") {
            nextTree[getParentKey(result.value.parentRelativePath)] =
                result.value.nodes;
            continue;
        }

        if (!isMissingProjectTreePathError(result.reason)) {
            nextError ??=
                result.reason instanceof Error
                    ? result.reason
                    : new Error("Could not refresh the project tree.");
            continue;
        }

        const missingPath = input.parentPaths[index] ?? null;
        if (missingPath === null) {
            nextExpandedDirectories = [];
            nextTree = { [ROOT_NODE_KEY]: [] };
            continue;
        }

        nextExpandedDirectories = removeMatchingPaths(
            nextExpandedDirectories,
            missingPath,
        );
        nextTree = omitTreeBranch(nextTree, missingPath);
    }

    return {
        error: nextError,
        expandedDirectories: nextExpandedDirectories,
        treeNodes: nextTree,
    };
}

function removeMatchingPaths(
    paths: readonly string[],
    relativePath: string,
): readonly string[] {
    return paths.filter(
        (path) => path !== relativePath && !path.startsWith(`${relativePath}/`),
    );
}

function omitTreeBranch(
    treeNodes: Record<ParentKey, readonly ProjectTreeNode[]>,
    relativePath: string,
): Record<ParentKey, readonly ProjectTreeNode[]> {
    return Object.fromEntries(
        Object.entries(treeNodes).filter(
            ([parentKey]) =>
                parentKey !== relativePath &&
                !parentKey.startsWith(`${relativePath}/`),
        ),
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

export function getAncestorDirectoryPaths(
    relativePath: string,
): readonly string[] {
    const segments = relativePath.split("/").filter(Boolean);

    if (segments.length <= 1) {
        return [];
    }

    return segments
        .slice(0, -1)
        .map((_, index) => segments.slice(0, index + 1).join("/"));
}

function mergeUniquePaths(
    existingPaths: readonly string[],
    nextPaths: readonly string[],
): readonly string[] {
    const mergedPaths = [...existingPaths];

    for (const nextPath of nextPaths) {
        if (!mergedPaths.includes(nextPath)) {
            mergedPaths.push(nextPath);
        }
    }

    return mergedPaths;
}

function isMissingProjectTreePathError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("ENOENT") || message.includes("ENOTDIR");
}
