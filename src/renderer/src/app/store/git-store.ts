import { create } from "zustand";

import type {
    GitBranchSummary,
    GitCommitDetail,
    GitCommitInput,
    GitCreateWorktreeInput,
    GitFileDiff,
    GitHistoryCommitSummary,
    GitRepositorySnapshot,
    GitWorktreeSummary,
    ProjectSummary,
} from "@shared/ipc";

import { resolveGitHubAvatars } from "../git/github-avatar-cache";

import type { GitChangeGroupId, GitPanelTabId } from "../../components/git";

const DEFAULT_CHANGE_GROUPS: readonly GitChangeGroupId[] = [
    "conflicts",
    "changes",
    "staged",
    "untracked",
];

interface GitStoreState {
    readonly activeWorktreeIds: Record<string, string | null>;
    readonly branchesByProject: Record<string, readonly GitBranchSummary[]>;
    readonly changeExpandedPaths: Record<string, readonly string[]>;
    readonly commitDetailsByContext: Record<
        string,
        Record<string, GitCommitDetail | null>
    >;
    readonly commitMessages: Record<string, string>;
    readonly diffsByContext: Record<string, Record<string, GitFileDiff | null>>;
    readonly errors: Record<string, string | null>;
    readonly expandedBranchSections: Record<string, boolean>;
    readonly expandedChangeGroups: Record<string, readonly GitChangeGroupId[]>;
    readonly expandedProjects: Record<string, boolean>;
    readonly expandedWorktreeSections: Record<string, boolean>;
    readonly historyByContext: Record<
        string,
        readonly GitHistoryCommitSummary[]
    >;
    readonly loadingCommitShas: Record<string, readonly string[]>;
    readonly loadingContexts: Record<string, boolean>;
    readonly loadingDiffPaths: Record<string, readonly string[]>;
    readonly loadingHistoryContexts: Record<string, boolean>;
    readonly panelTabs: Record<string, GitPanelTabId>;
    readonly selectedBranchNames: Record<string, string | null>;
    readonly selectedBranchNamesByContext: Record<string, string | null>;
    readonly selectedCommitShas: Record<string, string | null>;
    readonly selectedDiffPaths: Record<string, string | null>;
    readonly snapshots: Record<string, GitRepositorySnapshot | null>;
    checkoutBranch: (
        projectId: string,
        branchName: string,
        worktreeId?: string | null,
    ) => Promise<GitRepositorySnapshot>;
    commitChanges: (input: GitCommitInput) => Promise<{
        readonly commitSha: string;
        readonly branchName: string | null;
    }>;
    createWorktree: (
        input: GitCreateWorktreeInput,
    ) => Promise<GitWorktreeSummary>;
    discardPaths: (
        projectId: string,
        paths: readonly string[],
        worktreeId?: string | null,
    ) => Promise<GitRepositorySnapshot>;
    fetchRepository: (
        projectId: string,
        worktreeId?: string | null,
    ) => Promise<GitRepositorySnapshot>;
    ensureCommitDetail: (
        projectId: string,
        commitSha: string,
        worktreeId?: string | null,
    ) => Promise<GitCommitDetail | null>;
    ingestSnapshot: (snapshot: GitRepositorySnapshot) => void;
    hydrate: (options: {
        readonly activeProjectId: string | null;
        readonly activeWorktreeId?: string | null;
        readonly projects: readonly ProjectSummary[];
    }) => Promise<void>;
    pullRepository: (
        projectId: string,
        worktreeId?: string | null,
    ) => Promise<GitRepositorySnapshot>;
    pushRepository: (
        projectId: string,
        worktreeId?: string | null,
    ) => Promise<GitRepositorySnapshot>;
    refreshHistory: (
        projectId: string,
        worktreeId?: string | null,
    ) => Promise<readonly GitHistoryCommitSummary[]>;
    refreshProject: (
        projectId: string,
        preferredWorktreeId?: string | null,
    ) => Promise<GitRepositorySnapshot | null>;
    removeWorktree: (
        projectId: string,
        path: string,
        worktreeId?: string | null,
    ) => Promise<GitRepositorySnapshot>;
    selectBranch: (
        projectId: string,
        branchName: string | null,
        worktreeId?: string | null,
    ) => void;
    selectCommit: (
        projectId: string,
        commitSha: string | null,
        worktreeId?: string | null,
    ) => Promise<GitCommitDetail | null>;
    selectDiffPath: (
        projectId: string,
        path: string | null,
        worktreeId?: string | null,
    ) => Promise<void>;
    setActiveWorktree: (
        projectId: string,
        worktreeId: string | null,
    ) => Promise<void>;
    setCommitMessage: (
        projectId: string,
        message: string,
        worktreeId?: string | null,
    ) => void;
    setPanelTab: (
        projectId: string,
        tab: GitPanelTabId,
        worktreeId?: string | null,
    ) => void;
    stagePaths: (
        projectId: string,
        paths: readonly string[],
        worktreeId?: string | null,
    ) => Promise<GitRepositorySnapshot>;
    toggleBranchesExpanded: (projectId: string) => void;
    toggleChangeGroup: (
        projectId: string,
        groupId: GitChangeGroupId,
        worktreeId?: string | null,
    ) => void;
    toggleChangePath: (
        projectId: string,
        path: string,
        worktreeId?: string | null,
    ) => void;
    toggleProjectExpanded: (projectId: string) => void;
    toggleWorktreesExpanded: (projectId: string) => void;
    unstagePaths: (
        projectId: string,
        paths: readonly string[],
        worktreeId?: string | null,
    ) => Promise<GitRepositorySnapshot>;
}

export const useGitStore = create<GitStoreState>((set, get) => ({
    activeWorktreeIds: {},
    branchesByProject: {},
    changeExpandedPaths: {},
    commitDetailsByContext: {},
    commitMessages: {},
    diffsByContext: {},
    errors: {},
    expandedBranchSections: {},
    expandedChangeGroups: {},
    expandedProjects: {},
    expandedWorktreeSections: {},
    historyByContext: {},
    loadingCommitShas: {},
    loadingContexts: {},
    loadingDiffPaths: {},
    loadingHistoryContexts: {},
    panelTabs: {},
    selectedBranchNames: {},
    selectedBranchNamesByContext: {},
    selectedCommitShas: {},
    selectedDiffPaths: {},
    snapshots: {},

    checkoutBranch: async (projectId, branchName, worktreeId = null) => {
        const snapshot = await getComandoApi().checkoutGitBranch({
            branchName,
            projectId,
            worktreeId,
        });

        applySnapshotState(set, projectId, snapshot);
        void get().refreshProject(projectId, snapshot.currentWorktreeId);
        void get().refreshHistory(projectId, snapshot.currentWorktreeId);
        return snapshot;
    },

    commitChanges: async (input) => {
        const result = await getComandoApi().commitGitChanges(input);
        set((state) => ({
            commitMessages: {
                ...state.commitMessages,
                [getContextKey(input.projectId, input.worktreeId ?? null)]: "",
            },
            errors: {
                ...state.errors,
                [getContextKey(input.projectId, input.worktreeId ?? null)]:
                    null,
            },
        }));
        void get().refreshProject(input.projectId, input.worktreeId ?? null);
        void get().refreshHistory(input.projectId, input.worktreeId ?? null);
        return {
            branchName: result.branchName,
            commitSha: result.commitSha,
        };
    },

    createWorktree: async (input) => {
        const worktree = await getComandoApi().createGitWorktree(input);
        await get().refreshProject(input.projectId, input.worktreeId ?? null);
        return worktree;
    },

    discardPaths: async (projectId, paths, worktreeId = null) => {
        const snapshot = await getComandoApi().discardGitPaths({
            paths,
            projectId,
            worktreeId,
        });
        applySnapshotState(set, projectId, snapshot);
        return snapshot;
    },

    fetchRepository: async (projectId, worktreeId = null) => {
        const snapshot = await getComandoApi().fetchGitRepository({
            projectId,
            worktreeId,
        });
        applySnapshotState(set, projectId, snapshot);
        void get().refreshProject(projectId, snapshot.currentWorktreeId);
        void get().refreshHistory(projectId, snapshot.currentWorktreeId);
        return snapshot;
    },

    ensureCommitDetail: async (projectId, commitSha, worktreeId = null) => {
        const contextKey = getContextKey(projectId, worktreeId);
        const cachedContext = get().commitDetailsByContext[contextKey];
        if (cachedContext && commitSha in cachedContext) {
            return cachedContext[commitSha] ?? null;
        }

        set((state) => ({
            loadingCommitShas: {
                ...state.loadingCommitShas,
                [contextKey]: [
                    ...(state.loadingCommitShas[contextKey] ?? []).filter(
                        (entry) => entry !== commitSha,
                    ),
                    commitSha,
                ],
            },
        }));

        try {
            const detail = await getComandoApi().getGitCommitDetail({
                commitSha,
                projectId,
                worktreeId,
            });

            set((state) => ({
                commitDetailsByContext: {
                    ...state.commitDetailsByContext,
                    [contextKey]: {
                        ...(state.commitDetailsByContext[contextKey] ?? {}),
                        [commitSha]: detail,
                    },
                },
                errors: {
                    ...state.errors,
                    [contextKey]: null,
                },
                loadingCommitShas: {
                    ...state.loadingCommitShas,
                    [contextKey]: (
                        state.loadingCommitShas[contextKey] ?? []
                    ).filter((entry) => entry !== commitSha),
                },
            }));

            return detail;
        } catch (error) {
            set((state) => ({
                errors: {
                    ...state.errors,
                    [contextKey]:
                        error instanceof Error
                            ? error.message
                            : "Could not load the selected commit.",
                },
                loadingCommitShas: {
                    ...state.loadingCommitShas,
                    [contextKey]: (
                        state.loadingCommitShas[contextKey] ?? []
                    ).filter((entry) => entry !== commitSha),
                },
            }));
            return null;
        }
    },

    ingestSnapshot: (snapshot) => {
        applySnapshotState(set, snapshot.projectId, snapshot);
    },

    hydrate: async ({ activeProjectId, activeWorktreeId = null, projects }) => {
        const snapshots = await Promise.all(
            projects.map(async (project) => {
                try {
                    const [snapshot, branches] = await Promise.all([
                        getComandoApi().getGitRepositorySnapshot({
                            projectId: project.id,
                        }),
                        getComandoApi().listGitBranches({
                            includeRemote: true,
                            projectId: project.id,
                        }),
                    ]);
                    return [project.id, snapshot, branches] as const;
                } catch {
                    return [project.id, null, []] as const;
                }
            }),
        );

        set((state) => {
            const nextSnapshots = { ...state.snapshots };
            const nextBranches = { ...state.branchesByProject };
            const nextActiveWorktrees = { ...state.activeWorktreeIds };
            const nextExpandedProjects = { ...state.expandedProjects };
            const nextExpandedBranches = { ...state.expandedBranchSections };
            const nextExpandedWorktrees = { ...state.expandedWorktreeSections };
            const nextSelectedBranches = { ...state.selectedBranchNames };
            const nextSelectedBranchesByContext = {
                ...state.selectedBranchNamesByContext,
            };

            for (const [projectId, snapshot, branches] of snapshots) {
                const snapshotWorktreeId =
                    snapshot?.currentWorktreeId ??
                    snapshot?.worktrees.find((worktree) => worktree.isCurrent)
                        ?.id ??
                    snapshot?.worktrees.find((worktree) => worktree.isPrimary)
                        ?.id ??
                    null;
                const contextKey = getContextKey(projectId, snapshotWorktreeId);

                nextSnapshots[contextKey] = snapshot;
                nextBranches[projectId] = branches;
                nextActiveWorktrees[projectId] = resolveSnapshotWorktreeId(
                    snapshot,
                    activeWorktreeId,
                );
                nextExpandedProjects[projectId] =
                    state.expandedProjects[projectId] ??
                    projectId === activeProjectId;
                nextExpandedBranches[projectId] =
                    state.expandedBranchSections[projectId] ?? true;
                nextExpandedWorktrees[projectId] =
                    state.expandedWorktreeSections[projectId] ?? true;
                nextSelectedBranches[projectId] =
                    snapshot?.branch?.name ?? null;
                nextSelectedBranchesByContext[contextKey] =
                    snapshot?.branch?.name ?? null;
            }

            return {
                activeWorktreeIds: nextActiveWorktrees,
                branchesByProject: nextBranches,
                expandedBranchSections: nextExpandedBranches,
                expandedProjects: nextExpandedProjects,
                expandedWorktreeSections: nextExpandedWorktrees,
                selectedBranchNames: nextSelectedBranches,
                selectedBranchNamesByContext: nextSelectedBranchesByContext,
                snapshots: nextSnapshots,
            };
        });

        for (const [, snapshot] of snapshots) {
            if (snapshot) {
                void resolveGitHubAvatars(snapshot.remotes);
            }
        }
    },

    pullRepository: async (projectId, worktreeId = null) => {
        const snapshot = await getComandoApi().pullGitRepository({
            projectId,
            worktreeId,
        });
        applySnapshotState(set, projectId, snapshot);
        void get().refreshProject(projectId, snapshot.currentWorktreeId);
        void get().refreshHistory(projectId, snapshot.currentWorktreeId);
        return snapshot;
    },

    pushRepository: async (projectId, worktreeId = null) => {
        const snapshot = await getComandoApi().pushGitRepository({
            projectId,
            worktreeId,
        });
        applySnapshotState(set, projectId, snapshot);
        void get().refreshProject(projectId, snapshot.currentWorktreeId);
        void get().refreshHistory(projectId, snapshot.currentWorktreeId);
        return snapshot;
    },

    refreshHistory: async (projectId, worktreeId = null) => {
        const contextKey = getContextKey(projectId, worktreeId);
        set((state) => ({
            errors: { ...state.errors, [contextKey]: null },
            loadingHistoryContexts: {
                ...state.loadingHistoryContexts,
                [contextKey]: true,
            },
        }));

        try {
            const history = await getComandoApi().listGitHistory({
                limit: 200,
                projectId,
                worktreeId,
            });

            set((state) => ({
                errors: {
                    ...state.errors,
                    [contextKey]: null,
                },
                historyByContext: {
                    ...state.historyByContext,
                    [contextKey]: history,
                },
                loadingHistoryContexts: {
                    ...state.loadingHistoryContexts,
                    [contextKey]: false,
                },
                selectedCommitShas: {
                    ...state.selectedCommitShas,
                    [contextKey]: history.some(
                        (commit) =>
                            commit.sha ===
                            (state.selectedCommitShas[contextKey] ?? null),
                    )
                        ? (state.selectedCommitShas[contextKey] ?? null)
                        : (history[0]?.sha ?? null),
                },
            }));

            const nextSelectedSha =
                get().selectedCommitShas[contextKey] ?? history[0]?.sha ?? null;
            if (nextSelectedSha) {
                void get().ensureCommitDetail(
                    projectId,
                    nextSelectedSha,
                    worktreeId,
                );
            }

            return history;
        } catch (error) {
            set((state) => ({
                errors: {
                    ...state.errors,
                    [contextKey]:
                        error instanceof Error
                            ? error.message
                            : "Could not load git history.",
                },
                loadingHistoryContexts: {
                    ...state.loadingHistoryContexts,
                    [contextKey]: false,
                },
            }));
            return [];
        }
    },

    refreshProject: async (projectId, preferredWorktreeId = null) => {
        const contextKey = getContextKey(projectId, preferredWorktreeId);
        set((state) => ({
            errors: { ...state.errors, [contextKey]: null },
            loadingContexts: { ...state.loadingContexts, [contextKey]: true },
        }));

        try {
            const [snapshot, branches] = await Promise.all([
                getComandoApi().getGitRepositorySnapshot({
                    projectId,
                    worktreeId: preferredWorktreeId,
                }),
                getComandoApi().listGitBranches({
                    includeRemote: true,
                    projectId,
                    worktreeId: preferredWorktreeId,
                }),
            ]);

            if (snapshot) {
                applySnapshotState(set, projectId, snapshot);
            }

            const resolvedWorktreeId =
                snapshot?.currentWorktreeId ??
                snapshot?.worktrees.find((worktree) => worktree.isCurrent)
                    ?.id ??
                snapshot?.worktrees.find((worktree) => worktree.isPrimary)
                    ?.id ??
                preferredWorktreeId ??
                null;
            const resolvedKey = getContextKey(projectId, resolvedWorktreeId);
            set((state) => ({
                branchesByProject: {
                    ...state.branchesByProject,
                    [projectId]: branches,
                },
                errors: {
                    ...state.errors,
                    [contextKey]: null,
                    [resolvedKey]: null,
                },
                loadingContexts: {
                    ...state.loadingContexts,
                    [contextKey]: false,
                    [resolvedKey]: false,
                },
            }));

            return snapshot;
        } catch (error) {
            set((state) => ({
                errors: {
                    ...state.errors,
                    [contextKey]:
                        error instanceof Error
                            ? error.message
                            : "Could not refresh git state.",
                },
                loadingContexts: {
                    ...state.loadingContexts,
                    [contextKey]: false,
                },
            }));
            return null;
        }
    },

    removeWorktree: async (projectId, path, worktreeId = null) => {
        const snapshot = await getComandoApi().removeGitWorktree({
            path,
            projectId,
            worktreeId,
        });
        applySnapshotState(set, projectId, snapshot);
        void get().refreshProject(projectId, snapshot.currentWorktreeId);
        return snapshot;
    },

    selectBranch: (projectId, branchName, worktreeId = null) =>
        set((state) => {
            const resolvedWorktreeId =
                worktreeId ?? state.activeWorktreeIds[projectId] ?? null;
            const contextKey = getContextKey(projectId, resolvedWorktreeId);

            return {
                selectedBranchNames: {
                    ...state.selectedBranchNames,
                    ...(worktreeId == null ? { [projectId]: branchName } : {}),
                },
                selectedBranchNamesByContext: {
                    ...state.selectedBranchNamesByContext,
                    [contextKey]: branchName,
                },
            };
        }),

    selectCommit: async (projectId, commitSha, worktreeId = null) => {
        const contextKey = getContextKey(projectId, worktreeId);

        set((state) => ({
            selectedCommitShas: {
                ...state.selectedCommitShas,
                [contextKey]: commitSha,
            },
        }));

        if (!commitSha) {
            return null;
        }

        return get().ensureCommitDetail(projectId, commitSha, worktreeId);
    },

    selectDiffPath: async (projectId, path, worktreeId = null) => {
        const contextKey = getContextKey(projectId, worktreeId);

        set((state) => ({
            panelTabs: { ...state.panelTabs, [contextKey]: "diffs" },
            selectedDiffPaths: {
                ...state.selectedDiffPaths,
                [contextKey]: path,
            },
        }));

        if (!path) {
            return;
        }

        set((state) => ({
            loadingDiffPaths: {
                ...state.loadingDiffPaths,
                [contextKey]: [
                    ...(state.loadingDiffPaths[contextKey] ?? []).filter(
                        (entry) => entry !== path,
                    ),
                    path,
                ],
            },
        }));

        try {
            const diff = await getComandoApi().getGitDiff({
                path,
                projectId,
                worktreeId,
            });

            set((state) => ({
                diffsByContext: {
                    ...state.diffsByContext,
                    [contextKey]: {
                        ...(state.diffsByContext[contextKey] ?? {}),
                        [path]: diff,
                    },
                },
                loadingDiffPaths: {
                    ...state.loadingDiffPaths,
                    [contextKey]: (
                        state.loadingDiffPaths[contextKey] ?? []
                    ).filter((entry) => entry !== path),
                },
            }));
        } catch (error) {
            set((state) => ({
                errors: {
                    ...state.errors,
                    [contextKey]:
                        error instanceof Error
                            ? error.message
                            : "Could not load the selected diff.",
                },
                loadingDiffPaths: {
                    ...state.loadingDiffPaths,
                    [contextKey]: (
                        state.loadingDiffPaths[contextKey] ?? []
                    ).filter((entry) => entry !== path),
                },
            }));
        }
    },

    setActiveWorktree: (projectId, worktreeId) => {
        set((state) => ({
            activeWorktreeIds: {
                ...state.activeWorktreeIds,
                [projectId]: worktreeId,
            },
        }));
        return Promise.resolve();
    },

    setCommitMessage: (projectId, message, worktreeId = null) =>
        set((state) => ({
            commitMessages: {
                ...state.commitMessages,
                [getContextKey(projectId, worktreeId)]: message,
            },
        })),

    setPanelTab: (projectId, tab, worktreeId = null) =>
        set((state) => ({
            panelTabs: {
                ...state.panelTabs,
                [getContextKey(projectId, worktreeId)]: tab,
            },
        })),

    stagePaths: async (projectId, paths, worktreeId = null) => {
        const snapshot = await getComandoApi().stageGitPaths({
            paths,
            projectId,
            worktreeId,
        });
        applySnapshotState(set, projectId, snapshot);
        return snapshot;
    },

    toggleBranchesExpanded: (projectId) =>
        set((state) => ({
            expandedBranchSections: {
                ...state.expandedBranchSections,
                [projectId]: !(state.expandedBranchSections[projectId] ?? true),
            },
        })),

    toggleChangeGroup: (projectId, groupId, worktreeId = null) =>
        set((state) => {
            const contextKey = getContextKey(projectId, worktreeId);
            const currentGroups =
                state.expandedChangeGroups[contextKey] ?? DEFAULT_CHANGE_GROUPS;
            const isExpanded = currentGroups.includes(groupId);

            return {
                expandedChangeGroups: {
                    ...state.expandedChangeGroups,
                    [contextKey]: isExpanded
                        ? currentGroups.filter((entry) => entry !== groupId)
                        : [...currentGroups, groupId],
                },
            };
        }),

    toggleChangePath: (projectId, path, worktreeId = null) =>
        set((state) => {
            const contextKey = getContextKey(projectId, worktreeId);
            const currentPaths = state.changeExpandedPaths[contextKey] ?? [];
            const isExpanded = currentPaths.includes(path);

            return {
                changeExpandedPaths: {
                    ...state.changeExpandedPaths,
                    [contextKey]: isExpanded
                        ? currentPaths.filter((entry) => entry !== path)
                        : [...currentPaths, path],
                },
            };
        }),

    toggleProjectExpanded: (projectId) =>
        set((state) => ({
            expandedProjects: {
                ...state.expandedProjects,
                [projectId]: !(state.expandedProjects[projectId] ?? false),
            },
        })),

    toggleWorktreesExpanded: (projectId) =>
        set((state) => ({
            expandedWorktreeSections: {
                ...state.expandedWorktreeSections,
                [projectId]: !(
                    state.expandedWorktreeSections[projectId] ?? true
                ),
            },
        })),

    unstagePaths: async (projectId, paths, worktreeId = null) => {
        const snapshot = await getComandoApi().unstageGitPaths({
            paths,
            projectId,
            worktreeId,
        });
        applySnapshotState(set, projectId, snapshot);
        return snapshot;
    },
}));

function applySnapshotState(
    set: (
        partial:
            | Partial<GitStoreState>
            | ((state: GitStoreState) => Partial<GitStoreState>),
    ) => void,
    projectId: string,
    snapshot: GitRepositorySnapshot,
): void {
    void resolveGitHubAvatars(snapshot.remotes);
    const contextKey = getContextKey(projectId, snapshot.currentWorktreeId);

    set((state) => ({
        activeWorktreeIds: {
            ...state.activeWorktreeIds,
            [projectId]: resolveSnapshotWorktreeId(
                snapshot,
                state.activeWorktreeIds[projectId] ?? null,
            ),
        },
        errors: {
            ...state.errors,
            [contextKey]: null,
        },
        expandedChangeGroups: {
            ...state.expandedChangeGroups,
            [contextKey]:
                state.expandedChangeGroups[contextKey] ?? DEFAULT_CHANGE_GROUPS,
        },
        expandedProjects: {
            ...state.expandedProjects,
            [projectId]: state.expandedProjects[projectId] ?? true,
        },
        expandedBranchSections: {
            ...state.expandedBranchSections,
            [projectId]: state.expandedBranchSections[projectId] ?? true,
        },
        expandedWorktreeSections: {
            ...state.expandedWorktreeSections,
            [projectId]: state.expandedWorktreeSections[projectId] ?? true,
        },
        loadingContexts: {
            ...state.loadingContexts,
            [contextKey]: false,
        },
        panelTabs: {
            ...state.panelTabs,
            [contextKey]: state.panelTabs[contextKey] ?? "changes",
        },
        selectedBranchNames: {
            ...state.selectedBranchNames,
            [projectId]: snapshot.branch?.name ?? null,
        },
        selectedBranchNamesByContext: {
            ...state.selectedBranchNamesByContext,
            [contextKey]: snapshot.branch?.name ?? null,
        },
        selectedDiffPaths: {
            ...state.selectedDiffPaths,
            [contextKey]: snapshot.changedPaths.includes(
                state.selectedDiffPaths[contextKey] ?? "",
            )
                ? (state.selectedDiffPaths[contextKey] ?? null)
                : (snapshot.changedPaths[0] ?? null),
        },
        snapshots: {
            ...state.snapshots,
            [contextKey]: snapshot,
        },
    }));
}

function resolveSnapshotWorktreeId(
    snapshot: GitRepositorySnapshot | null,
    preferredWorktreeId: string | null,
): string | null {
    if (!snapshot) {
        return preferredWorktreeId;
    }

    const currentWorktreeId =
        snapshot.currentWorktreeId ??
        snapshot.worktrees.find((worktree) => worktree.isCurrent)?.id ??
        null;

    if (
        currentWorktreeId &&
        snapshot.worktrees.some((worktree) => worktree.id === currentWorktreeId)
    ) {
        return currentWorktreeId;
    }

    if (
        preferredWorktreeId &&
        snapshot.worktrees.some(
            (worktree) => worktree.id === preferredWorktreeId,
        )
    ) {
        return preferredWorktreeId;
    }

    return (
        snapshot.currentWorktreeId ??
        snapshot.worktrees.find((worktree) => worktree.isCurrent)?.id ??
        snapshot.worktrees.find((worktree) => worktree.isPrimary)?.id ??
        null
    );
}

function getContextKey(projectId: string, worktreeId: string | null): string {
    return `${projectId}::${worktreeId ?? "primary"}`;
}

function getComandoApi() {
    if (!("comando" in window)) {
        throw new Error("The renderer bridge is not available.");
    }

    return window.comando;
}
