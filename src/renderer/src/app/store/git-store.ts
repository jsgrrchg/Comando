import { create } from "zustand";

import type {
    GitBranchDiffResult,
    GitBranchSummary,
    GitCommitDetail,
    GitCommitInput,
    GitCreateBranchInput,
    GitCreateWorktreeInput,
    GitFileDiff,
    GitHistoryCommitSummary,
    GitRepositorySnapshot,
    GitWorktreeDiffResult,
    GitWorktreeSummary,
    ProjectSummary,
} from "@shared/ipc";

import {
    getGitContextKey,
    getPrimaryWorktreeId,
} from "../git/context-key";
import { buildGitDiffFileId } from "../git/presentation";
import { resolveGitHubAvatars } from "../git/github-avatar-cache";

import type { GitChangeGroupId, GitPanelTabId } from "../../components/git";

const DEFAULT_CHANGE_GROUPS: readonly GitChangeGroupId[] = [
    "conflicts",
    "changes",
    "staged",
    "untracked",
];
const DEFAULT_GIT_HISTORY_LIMIT = 200;
const GIT_HISTORY_LOAD_MORE_INCREMENT = 200;

type GitFetchRepositoryOptions = {
    readonly all?: boolean;
    readonly prune?: boolean;
    readonly remoteName?: string | null;
};

type GitPullRepositoryOptions = {
    readonly rebase?: boolean;
    readonly remoteName?: string | null;
    readonly remoteRef?: string | null;
};

type GitPushRepositoryOptions = {
    readonly force?: boolean;
    readonly forceWithLease?: boolean;
    readonly remoteName?: string | null;
    readonly remoteRef?: string | null;
    readonly setUpstream?: boolean;
};

export type GitDiffMode = "branch" | "worktree";

type GitHistorySearchOptions = {
    readonly caseSensitive?: boolean;
    readonly query?: string;
    readonly resetLimit?: boolean;
};

type GitHistorySearchState = {
    readonly caseSensitive: boolean;
    readonly query: string;
};

interface GitStoreState {
    readonly activeDiffModesByContext: Record<string, GitDiffMode>;
    readonly branchDiffErrorsByContext: Record<string, string | null>;
    readonly branchDiffRequestKeysByContext: Record<string, string>;
    readonly branchDiffsByContext: Record<string, GitBranchDiffResult | null>;
    readonly collapsedBranchDiffFileIds: Record<string, readonly string[]>;
    readonly failedBranchDiffContexts: Record<string, boolean>;
    readonly loadingBranchDiffContexts: Record<string, boolean>;
    readonly selectedBranchDiffFileIds: Record<string, string | null>;
    readonly staleBranchDiffContexts: Record<string, boolean>;
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
    readonly failedWorktreeDiffContexts: Record<string, boolean>;
    readonly historyByContext: Record<
        string,
        readonly GitHistoryCommitSummary[]
    >;
    readonly historyLimitsByContext: Record<string, number>;
    readonly historyMatchedCountsByContext: Record<string, number>;
    readonly historyRequestKeysByContext: Record<string, string>;
    readonly historySearchesByContext: Record<string, GitHistorySearchState>;
    readonly historyTotalsByContext: Record<string, number>;
    readonly loadingCommitShas: Record<string, readonly string[]>;
    readonly loadingContexts: Record<string, boolean>;
    readonly loadingDiffPaths: Record<string, readonly string[]>;
    readonly loadingHistoryContexts: Record<string, boolean>;
    readonly loadingWorktreeDiffContexts: Record<string, boolean>;
    readonly panelTabs: Record<string, GitPanelTabId>;
    readonly projectRefreshRequestKeysByContext: Record<string, string>;
    readonly selectedBranchNames: Record<string, string | null>;
    readonly selectedBranchNamesByContext: Record<string, string | null>;
    readonly selectedCommitShas: Record<string, string | null>;
    readonly selectedDiffPaths: Record<string, string | null>;
    readonly selectedWorktreeDiffFileIds: Record<string, string | null>;
    readonly snapshots: Record<string, GitRepositorySnapshot | null>;
    readonly staleWorktreeDiffContexts: Record<string, boolean>;
    readonly worktreeInventoryUpdatedAtByProject: Record<string, string>;
    readonly worktreesByProject: Record<
        string,
        readonly GitWorktreeSummary[]
    >;
    readonly worktreeDiffRequestKeysByContext: Record<string, string>;
    readonly worktreeDiffsByContext: Record<
        string,
        GitWorktreeDiffResult | null
    >;
    readonly collapsedWorktreeDiffFileIds: Record<string, readonly string[]>;
    checkoutBranch: (
        projectId: string,
        branchName: string,
        worktreeId?: string | null,
        options?: {
            readonly force?: boolean;
            readonly newBranchName?: string | null;
            readonly startPoint?: string | null;
        },
    ) => Promise<GitRepositorySnapshot>;
    commitChanges: (input: GitCommitInput) => Promise<{
        readonly commitSha: string;
        readonly branchName: string | null;
    }>;
    createBranch: (
        input: GitCreateBranchInput,
    ) => Promise<GitRepositorySnapshot>;
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
        options?: GitFetchRepositoryOptions,
    ) => Promise<GitRepositorySnapshot>;
    ensureCommitDetail: (
        projectId: string,
        commitSha: string,
        worktreeId?: string | null,
    ) => Promise<GitCommitDetail | null>;
    ensureBranchDiff: (
        projectId: string,
        worktreeId?: string | null,
    ) => Promise<GitBranchDiffResult | null>;
    ensureWorktreeDiff: (
        projectId: string,
        worktreeId?: string | null,
    ) => Promise<GitWorktreeDiffResult | null>;
    ingestSnapshot: (snapshot: GitRepositorySnapshot) => void;
    initRepository: (
        projectId: string,
        worktreeId?: string | null,
    ) => Promise<GitRepositorySnapshot>;
    hydrate: (options: {
        readonly activeProjectId: string | null;
        readonly activeWorktreeId?: string | null;
        readonly projects: readonly ProjectSummary[];
    }) => Promise<void>;
    loadMoreHistory: (
        projectId: string,
        worktreeId?: string | null,
    ) => Promise<readonly GitHistoryCommitSummary[]>;
    pullRepository: (
        projectId: string,
        worktreeId?: string | null,
        options?: GitPullRepositoryOptions,
    ) => Promise<GitRepositorySnapshot>;
    pushRepository: (
        projectId: string,
        worktreeId?: string | null,
        options?: GitPushRepositoryOptions,
    ) => Promise<GitRepositorySnapshot>;
    refreshHistory: (
        projectId: string,
        worktreeId?: string | null,
        options?: GitHistorySearchOptions,
    ) => Promise<readonly GitHistoryCommitSummary[]>;
    refreshProject: (
        projectId: string,
        preferredWorktreeId?: string | null,
    ) => Promise<GitRepositorySnapshot | null>;
    refreshBranchDiff: (
        projectId: string,
        worktreeId?: string | null,
    ) => Promise<GitBranchDiffResult | null>;
    refreshWorktreeDiff: (
        projectId: string,
        worktreeId?: string | null,
    ) => Promise<GitWorktreeDiffResult | null>;
    deleteLocalBranch: (
        projectId: string,
        branchName: string,
        worktreeId?: string | null,
        options?: {
            readonly force?: boolean;
        },
    ) => Promise<GitRepositorySnapshot>;
    deleteRemoteBranch: (
        projectId: string,
        remoteName: string,
        remoteRef: string,
        worktreeId?: string | null,
    ) => Promise<GitRepositorySnapshot>;
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
    selectBranchDiffFile: (
        projectId: string,
        fileId: string | null,
        worktreeId?: string | null,
    ) => void;
    selectWorktreeDiffFile: (
        projectId: string,
        fileId: string | null,
        worktreeId?: string | null,
    ) => void;
    setBranchDiffCollapsedFileIds: (
        projectId: string,
        fileIds: readonly string[],
        worktreeId?: string | null,
    ) => void;
    setWorktreeDiffCollapsedFileIds: (
        projectId: string,
        fileIds: readonly string[],
        worktreeId?: string | null,
    ) => void;
    setActiveDiffMode: (
        projectId: string,
        mode: GitDiffMode,
        worktreeId?: string | null,
    ) => void;
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
    toggleBranchDiffFileCollapse: (
        projectId: string,
        fileId: string,
        worktreeId?: string | null,
    ) => void;
    toggleWorktreeDiffFileCollapse: (
        projectId: string,
        fileId: string,
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
    activeDiffModesByContext: {},
    branchDiffErrorsByContext: {},
    branchDiffRequestKeysByContext: {},
    branchDiffsByContext: {},
    collapsedBranchDiffFileIds: {},
    failedBranchDiffContexts: {},
    loadingBranchDiffContexts: {},
    selectedBranchDiffFileIds: {},
    staleBranchDiffContexts: {},
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
    failedWorktreeDiffContexts: {},
    historyByContext: {},
    historyLimitsByContext: {},
    historyMatchedCountsByContext: {},
    historyRequestKeysByContext: {},
    historySearchesByContext: {},
    historyTotalsByContext: {},
    loadingCommitShas: {},
    loadingContexts: {},
    loadingDiffPaths: {},
    loadingHistoryContexts: {},
    loadingWorktreeDiffContexts: {},
    panelTabs: {},
    projectRefreshRequestKeysByContext: {},
    selectedBranchNames: {},
    selectedBranchNamesByContext: {},
    selectedCommitShas: {},
    selectedDiffPaths: {},
    selectedWorktreeDiffFileIds: {},
    snapshots: {},
    staleWorktreeDiffContexts: {},
    worktreeInventoryUpdatedAtByProject: {},
    worktreesByProject: {},
    worktreeDiffRequestKeysByContext: {},
    worktreeDiffsByContext: {},
    collapsedWorktreeDiffFileIds: {},

    checkoutBranch: async (
        projectId,
        branchName,
        worktreeId = null,
        options = {},
    ) => {
        const snapshot = await getComandoApi().checkoutGitBranch({
            branchName,
            force: options.force,
            newBranchName: options.newBranchName,
            projectId,
            startPoint: options.startPoint,
            worktreeId,
        });

        applySnapshotState(set, projectId, snapshot);
        void get().refreshHistory(projectId, snapshot.currentWorktreeId);
        return snapshot;
    },

    commitChanges: async (input) => {
        const result = await getComandoApi().commitGitChanges(input);
        applySnapshotState(set, input.projectId, result.snapshot);
        const inputContextKey = getContextKey(
            input.projectId,
            input.worktreeId ?? null,
        );
        const resolvedContextKey = getContextKey(
            input.projectId,
            result.snapshot.currentWorktreeId ?? input.worktreeId ?? null,
        );
        set((state) => ({
            commitMessages: {
                ...state.commitMessages,
                [inputContextKey]: "",
                [resolvedContextKey]: "",
            },
            errors: {
                ...state.errors,
                [inputContextKey]: null,
                [resolvedContextKey]: null,
            },
        }));
        void get().refreshHistory(
            input.projectId,
            result.snapshot.currentWorktreeId ?? input.worktreeId ?? null,
        );
        refreshCachedWorktreeDiff(get, input.projectId, result.worktreeId);
        return {
            branchName: result.branchName,
            commitSha: result.commitSha,
        };
    },

    createBranch: async (input) => {
        const snapshot = await getComandoApi().createGitBranch(input);
        applySnapshotState(set, input.projectId, snapshot);
        void get().refreshHistory(
            input.projectId,
            snapshot.currentWorktreeId ?? input.worktreeId ?? null,
        );
        return snapshot;
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
        refreshCachedWorktreeDiff(
            get,
            projectId,
            snapshot.currentWorktreeId ?? worktreeId,
        );
        return snapshot;
    },

    fetchRepository: async (projectId, worktreeId = null, options = {}) => {
        const snapshot = await getComandoApi().fetchGitRepository({
            all: options.all,
            projectId,
            prune: options.prune,
            remoteName: options.remoteName,
            worktreeId,
        });
        applySnapshotState(set, projectId, snapshot);
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

    ensureBranchDiff: async (projectId, worktreeId = null) => {
        const contextKey = getContextKey(projectId, worktreeId);
        const state = get();
        const cachedResult = state.branchDiffsByContext[contextKey] ?? null;
        if (
            hasOwn(state.branchDiffsByContext, contextKey) &&
            state.staleBranchDiffContexts[contextKey] !== true
        ) {
            return cachedResult;
        }
        if (
            state.loadingBranchDiffContexts[contextKey] === true ||
            state.failedBranchDiffContexts[contextKey] === true
        ) {
            return cachedResult;
        }

        return get().refreshBranchDiff(projectId, worktreeId);
    },

    ensureWorktreeDiff: async (projectId, worktreeId = null) => {
        const contextKey = getContextKey(projectId, worktreeId);
        const state = get();
        const cachedResult = state.worktreeDiffsByContext[contextKey] ?? null;
        const hasCachedResult = hasOwn(
            state.worktreeDiffsByContext,
            contextKey,
        );
        if (
            hasCachedResult &&
            state.staleWorktreeDiffContexts[contextKey] !== true
        ) {
            return cachedResult;
        }

        if (state.loadingWorktreeDiffContexts[contextKey] === true) {
            return cachedResult;
        }

        if (state.failedWorktreeDiffContexts[contextKey] === true) {
            return cachedResult;
        }

        return get().refreshWorktreeDiff(projectId, worktreeId);
    },

    ingestSnapshot: (snapshot) => {
        applySnapshotState(set, snapshot.projectId, snapshot);
    },

    initRepository: async (projectId, worktreeId = null) => {
        const snapshot = await getComandoApi().initGitRepository({
            projectId,
            worktreeId,
        });
        applySnapshotState(set, projectId, snapshot);
        void get().refreshHistory(projectId, snapshot.currentWorktreeId);
        return snapshot;
    },

    hydrate: async ({ activeProjectId, activeWorktreeId = null, projects }) => {
        const snapshots = await Promise.all(
            projects.map(async (project) => {
                try {
                    const snapshot =
                        await getComandoApi().getGitRepositorySnapshot({
                            projectId: project.id,
                        });
                    return [project.id, snapshot] as const;
                } catch {
                    return [project.id, null] as const;
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
            const nextWorktreeInventoryUpdatedAtByProject = {
                ...state.worktreeInventoryUpdatedAtByProject,
            };
            const nextWorktreesByProject = { ...state.worktreesByProject };

            for (const [projectId, snapshot] of snapshots) {
                const snapshotWorktreeId =
                    snapshot?.currentWorktreeId ??
                    snapshot?.worktrees.find((worktree) => worktree.isCurrent)
                        ?.id ??
                    snapshot?.worktrees.find((worktree) => worktree.isPrimary)
                        ?.id ??
                    null;
                const contextKey = getContextKey(projectId, snapshotWorktreeId);

                nextSnapshots[contextKey] = snapshot;
                nextBranches[projectId] = snapshot?.branches ?? [];
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
                if (
                    snapshot &&
                    isSnapshotNewerThanWorktreeInventory(
                        snapshot,
                        nextWorktreeInventoryUpdatedAtByProject[projectId],
                    )
                ) {
                    nextWorktreeInventoryUpdatedAtByProject[projectId] =
                        snapshot.updatedAt;
                    nextWorktreesByProject[projectId] = snapshot.worktrees;
                }
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
                worktreeInventoryUpdatedAtByProject:
                    nextWorktreeInventoryUpdatedAtByProject,
                worktreesByProject: nextWorktreesByProject,
            };
        });

        for (const [, snapshot] of snapshots) {
            if (snapshot) {
                void resolveGitHubAvatars(snapshot.remotes);
            }
        }
    },

    pullRepository: async (projectId, worktreeId = null, options = {}) => {
        const snapshot = await getComandoApi().pullGitRepository({
            projectId,
            rebase: options.rebase,
            remoteName: options.remoteName,
            remoteRef: options.remoteRef,
            worktreeId,
        });
        applySnapshotState(set, projectId, snapshot);
        void get().refreshHistory(projectId, snapshot.currentWorktreeId);
        return snapshot;
    },

    pushRepository: async (projectId, worktreeId = null, options = {}) => {
        const snapshot = await getComandoApi().pushGitRepository({
            force: options.force,
            forceWithLease: options.forceWithLease,
            projectId,
            remoteName: options.remoteName,
            remoteRef: options.remoteRef,
            setUpstream: options.setUpstream,
            worktreeId,
        });
        applySnapshotState(set, projectId, snapshot);
        void get().refreshHistory(projectId, snapshot.currentWorktreeId);
        return snapshot;
    },

    loadMoreHistory: async (projectId, worktreeId = null) => {
        const contextKey = getContextKey(projectId, worktreeId);
        const nextLimit =
            (get().historyLimitsByContext[contextKey] ??
                DEFAULT_GIT_HISTORY_LIMIT) + GIT_HISTORY_LOAD_MORE_INCREMENT;

        set((state) => ({
            historyLimitsByContext: {
                ...state.historyLimitsByContext,
                [contextKey]: nextLimit,
            },
        }));

        return get().refreshHistory(projectId, worktreeId);
    },

    refreshHistory: async (projectId, worktreeId = null, options = {}) => {
        const contextKey = getContextKey(projectId, worktreeId);
        const currentSearch = get().historySearchesByContext[contextKey] ?? {
            caseSensitive: false,
            query: "",
        };
        const nextSearch = {
            caseSensitive:
                options.caseSensitive ?? currentSearch.caseSensitive,
            query: (options.query ?? currentSearch.query).trim(),
        };
        const limit =
            options.resetLimit === true
                ? DEFAULT_GIT_HISTORY_LIMIT
                : (get().historyLimitsByContext[contextKey] ??
                  DEFAULT_GIT_HISTORY_LIMIT);
        const requestKey = `${Date.now()}:${Math.random()}`;
        set((state) => ({
            errors: { ...state.errors, [contextKey]: null },
            historyLimitsByContext: {
                ...state.historyLimitsByContext,
                [contextKey]: limit,
            },
            historyRequestKeysByContext: {
                ...state.historyRequestKeysByContext,
                [contextKey]: requestKey,
            },
            historySearchesByContext: {
                ...state.historySearchesByContext,
                [contextKey]: nextSearch,
            },
            loadingHistoryContexts: {
                ...state.loadingHistoryContexts,
                [contextKey]: true,
            },
        }));

        try {
            const result = await getComandoApi().listGitHistory({
                caseSensitive: nextSearch.caseSensitive,
                includeAllRefs: true,
                limit,
                projectId,
                query: nextSearch.query || undefined,
                worktreeId,
            });
            const history = result.commits;

            set((state) => {
                if (
                    state.historyRequestKeysByContext[contextKey] !==
                    requestKey
                ) {
                    return {};
                }

                const previousSelectedSha =
                    state.selectedCommitShas[contextKey] ?? null;
                const nextSelectedSha =
                    previousSelectedSha &&
                    history.some((commit) => commit.sha === previousSelectedSha)
                        ? previousSelectedSha
                        : null;

                return {
                    errors: {
                        ...state.errors,
                        [contextKey]: null,
                    },
                    historyByContext: {
                        ...state.historyByContext,
                        [contextKey]: history,
                    },
                    historyMatchedCountsByContext: {
                        ...state.historyMatchedCountsByContext,
                        [contextKey]: result.matchedCount,
                    },
                    historyTotalsByContext: {
                        ...state.historyTotalsByContext,
                        [contextKey]: result.totalCount,
                    },
                    loadingHistoryContexts: {
                        ...state.loadingHistoryContexts,
                        [contextKey]: false,
                    },
                    selectedCommitShas: {
                        ...state.selectedCommitShas,
                        [contextKey]: nextSelectedSha,
                    },
                };
            });

            if (get().historyRequestKeysByContext[contextKey] !== requestKey) {
                return get().historyByContext[contextKey] ?? [];
            }

            const nextSelectedSha = get().selectedCommitShas[contextKey] ?? null;
            if (nextSelectedSha) {
                void get().ensureCommitDetail(
                    projectId,
                    nextSelectedSha,
                    worktreeId,
                );
            }

            return history;
        } catch (error) {
            set((state) => {
                if (
                    state.historyRequestKeysByContext[contextKey] !==
                    requestKey
                ) {
                    return {};
                }

                return {
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
                };
            });
            return [];
        }
    },

    refreshProject: async (projectId, preferredWorktreeId = null) => {
        const contextKey = getContextKey(projectId, preferredWorktreeId);
        const requestKey = `${Date.now()}:${Math.random()}`;
        set((state) => ({
            errors: { ...state.errors, [contextKey]: null },
            loadingContexts: { ...state.loadingContexts, [contextKey]: true },
            projectRefreshRequestKeysByContext: {
                ...state.projectRefreshRequestKeysByContext,
                [contextKey]: requestKey,
            },
        }));

        try {
            const snapshot = await getComandoApi().getGitRepositorySnapshot({
                projectId,
                worktreeId: preferredWorktreeId,
            });

            const resolvedWorktreeId =
                snapshot?.currentWorktreeId ??
                snapshot?.worktrees.find((worktree) => worktree.isCurrent)
                    ?.id ??
                snapshot?.worktrees.find((worktree) => worktree.isPrimary)
                    ?.id ??
                preferredWorktreeId ??
                null;
            const resolvedKey = getContextKey(projectId, resolvedWorktreeId);

            const currentState = get();
            if (
                currentState.projectRefreshRequestKeysByContext[contextKey] !==
                    requestKey ||
                (resolvedKey !== contextKey &&
                    currentState.loadingContexts[resolvedKey] === true &&
                    currentState.projectRefreshRequestKeysByContext[
                        resolvedKey
                    ] !== requestKey)
            ) {
                return currentState.snapshots[resolvedKey] ?? null;
            }

            if (snapshot) {
                applySnapshotState(set, projectId, snapshot);
            }

            set((state) => {
                const nextRequestKeys = {
                    ...state.projectRefreshRequestKeysByContext,
                };
                if (nextRequestKeys[contextKey] === requestKey) {
                    delete nextRequestKeys[contextKey];
                }
                if (nextRequestKeys[resolvedKey] === requestKey) {
                    delete nextRequestKeys[resolvedKey];
                }

                return {
                    branchesByProject: {
                        ...state.branchesByProject,
                        [projectId]: snapshot?.branches ?? [],
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
                    projectRefreshRequestKeysByContext: nextRequestKeys,
                };
            });

            return snapshot;
        } catch (error) {
            set((state) => {
                if (
                    state.projectRefreshRequestKeysByContext[contextKey] !==
                    requestKey
                ) {
                    return {};
                }

                const nextRequestKeys = {
                    ...state.projectRefreshRequestKeysByContext,
                };
                delete nextRequestKeys[contextKey];

                return {
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
                    projectRefreshRequestKeysByContext: nextRequestKeys,
                };
            });
            return null;
        }
    },

    refreshBranchDiff: async (projectId, worktreeId = null) => {
        const contextKey = getContextKey(projectId, worktreeId);
        const requestKey = `${Date.now()}:${Math.random()}`;

        set((state) => ({
            branchDiffErrorsByContext: {
                ...state.branchDiffErrorsByContext,
                [contextKey]: null,
            },
            branchDiffRequestKeysByContext: {
                ...state.branchDiffRequestKeysByContext,
                [contextKey]: requestKey,
            },
            failedBranchDiffContexts: {
                ...state.failedBranchDiffContexts,
                [contextKey]: false,
            },
            loadingBranchDiffContexts: {
                ...state.loadingBranchDiffContexts,
                [contextKey]: true,
            },
            // Preserve invalidations that arrive while this request is running.
            staleBranchDiffContexts: {
                ...state.staleBranchDiffContexts,
                [contextKey]: false,
            },
        }));

        try {
            const result = await getComandoApi().listGitBranchDiff({
                projectId,
                worktreeId,
            });
            set((state) => {
                if (state.branchDiffRequestKeysByContext[contextKey] !== requestKey) {
                    return {};
                }

                const nextFileIds = collectBranchDiffFileIds(result);
                const nextFileIdSet = new Set(nextFileIds);
                const previousSelectedFileId =
                    state.selectedBranchDiffFileIds[contextKey] ?? null;
                return {
                    branchDiffErrorsByContext: {
                        ...state.branchDiffErrorsByContext,
                        [contextKey]: null,
                    },
                    branchDiffsByContext: {
                        ...state.branchDiffsByContext,
                        [contextKey]: result,
                    },
                    collapsedBranchDiffFileIds: {
                        ...state.collapsedBranchDiffFileIds,
                        [contextKey]: (
                            state.collapsedBranchDiffFileIds[contextKey] ?? []
                        ).filter((fileId) => nextFileIdSet.has(fileId)),
                    },
                    loadingBranchDiffContexts: {
                        ...state.loadingBranchDiffContexts,
                        [contextKey]: false,
                    },
                    selectedBranchDiffFileIds: {
                        ...state.selectedBranchDiffFileIds,
                        [contextKey]:
                            previousSelectedFileId &&
                            nextFileIdSet.has(previousSelectedFileId)
                                ? previousSelectedFileId
                                : (nextFileIds[0] ?? null),
                    },
                };
            });
            return result;
        } catch (error) {
            set((state) => {
                if (state.branchDiffRequestKeysByContext[contextKey] !== requestKey) {
                    return {};
                }
                return {
                    branchDiffErrorsByContext: {
                        ...state.branchDiffErrorsByContext,
                        [contextKey]:
                            error instanceof Error
                                ? error.message
                                : "Could not load branch changes.",
                    },
                    failedBranchDiffContexts: {
                        ...state.failedBranchDiffContexts,
                        [contextKey]: true,
                    },
                    loadingBranchDiffContexts: {
                        ...state.loadingBranchDiffContexts,
                        [contextKey]: false,
                    },
                    staleBranchDiffContexts: {
                        ...state.staleBranchDiffContexts,
                        [contextKey]: true,
                    },
                };
            });
            return null;
        }
    },

    refreshWorktreeDiff: async (projectId, worktreeId = null) => {
        const contextKey = getContextKey(projectId, worktreeId);
        const requestKey = `${Date.now()}:${Math.random()}`;

        set((state) => ({
            errors: { ...state.errors, [contextKey]: null },
            failedWorktreeDiffContexts: {
                ...state.failedWorktreeDiffContexts,
                [contextKey]: false,
            },
            loadingWorktreeDiffContexts: {
                ...state.loadingWorktreeDiffContexts,
                [contextKey]: true,
            },
            // A newer snapshot can mark this stale again while the request runs.
            staleWorktreeDiffContexts: {
                ...state.staleWorktreeDiffContexts,
                [contextKey]: false,
            },
            worktreeDiffRequestKeysByContext: {
                ...state.worktreeDiffRequestKeysByContext,
                [contextKey]: requestKey,
            },
        }));

        try {
            const result = await getComandoApi().listGitWorktreeDiff({
                projectId,
                worktreeId,
            });

            set((state) => {
                if (
                    state.worktreeDiffRequestKeysByContext[contextKey] !==
                    requestKey
                ) {
                    return {};
                }

                const nextFileIds = collectWorktreeDiffFileIds(result);
                const nextFileIdSet = new Set(nextFileIds);
                const previousSelectedFileId =
                    state.selectedWorktreeDiffFileIds[contextKey] ?? null;
                const nextSelectedFileId =
                    previousSelectedFileId &&
                    nextFileIdSet.has(previousSelectedFileId)
                        ? previousSelectedFileId
                        : (nextFileIds[0] ?? null);

                return {
                    collapsedWorktreeDiffFileIds: {
                        ...state.collapsedWorktreeDiffFileIds,
                        [contextKey]: (
                            state.collapsedWorktreeDiffFileIds[contextKey] ?? []
                        ).filter((fileId) => nextFileIdSet.has(fileId)),
                    },
                    errors: {
                        ...state.errors,
                        [contextKey]: null,
                    },
                    loadingWorktreeDiffContexts: {
                        ...state.loadingWorktreeDiffContexts,
                        [contextKey]: false,
                    },
                    selectedWorktreeDiffFileIds: {
                        ...state.selectedWorktreeDiffFileIds,
                        [contextKey]: nextSelectedFileId,
                    },
                    worktreeDiffsByContext: {
                        ...state.worktreeDiffsByContext,
                        [contextKey]: result,
                    },
                };
            });

            return result;
        } catch (error) {
            set((state) => {
                if (
                    state.worktreeDiffRequestKeysByContext[contextKey] !==
                    requestKey
                ) {
                    return {};
                }

                return {
                    errors: {
                        ...state.errors,
                        [contextKey]:
                            error instanceof Error
                                ? error.message
                            : "Could not load the project diff.",
                    },
                    failedWorktreeDiffContexts: {
                        ...state.failedWorktreeDiffContexts,
                        [contextKey]: true,
                    },
                    loadingWorktreeDiffContexts: {
                        ...state.loadingWorktreeDiffContexts,
                        [contextKey]: false,
                    },
                    staleWorktreeDiffContexts: {
                        ...state.staleWorktreeDiffContexts,
                        [contextKey]: true,
                    },
                };
            });
            return null;
        }
    },

    deleteLocalBranch: async (
        projectId,
        branchName,
        worktreeId = null,
        options = {},
    ) => {
        const snapshot = await getComandoApi().deleteLocalGitBranch({
            branchName,
            force: options.force,
            projectId,
            worktreeId,
        });
        applySnapshotState(set, projectId, snapshot);
        void get().refreshHistory(projectId, snapshot.currentWorktreeId);
        return snapshot;
    },

    deleteRemoteBranch: async (
        projectId,
        remoteName,
        remoteRef,
        worktreeId = null,
    ) => {
        const snapshot = await getComandoApi().deleteRemoteGitBranch({
            projectId,
            remoteName,
            remoteRef,
            worktreeId,
        });
        applySnapshotState(set, projectId, snapshot);
        void get().refreshHistory(projectId, snapshot.currentWorktreeId);
        return snapshot;
    },

    removeWorktree: async (projectId, path, worktreeId = null) => {
        const snapshot = await getComandoApi().removeGitWorktree({
            path,
            projectId,
            worktreeId,
        });
        applySnapshotState(set, projectId, snapshot);
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

    selectBranchDiffFile: (projectId, fileId, worktreeId = null) =>
        set((state) => ({
            selectedBranchDiffFileIds: {
                ...state.selectedBranchDiffFileIds,
                [getContextKey(projectId, worktreeId)]: fileId,
            },
        })),

    selectWorktreeDiffFile: (projectId, fileId, worktreeId = null) =>
        set((state) => ({
            selectedWorktreeDiffFileIds: {
                ...state.selectedWorktreeDiffFileIds,
                [getContextKey(projectId, worktreeId)]: fileId,
            },
        })),

    setActiveDiffMode: (projectId, mode, worktreeId = null) =>
        set((state) => ({
            activeDiffModesByContext: {
                ...state.activeDiffModesByContext,
                [getContextKey(projectId, worktreeId)]: mode,
            },
        })),

    setActiveWorktree: (projectId, worktreeId) => {
        set((state) => ({
            activeWorktreeIds: {
                ...state.activeWorktreeIds,
                [projectId]: normalizeWorktreeIdForStorage(
                    projectId,
                    worktreeId,
                    state.snapshots,
                ),
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

    setBranchDiffCollapsedFileIds: (
        projectId,
        fileIds,
        worktreeId = null,
    ) =>
        set((state) => ({
            collapsedBranchDiffFileIds: {
                ...state.collapsedBranchDiffFileIds,
                [getContextKey(projectId, worktreeId)]: fileIds,
            },
        })),

    setWorktreeDiffCollapsedFileIds: (
        projectId,
        fileIds,
        worktreeId = null,
    ) =>
        set((state) => ({
            collapsedWorktreeDiffFileIds: {
                ...state.collapsedWorktreeDiffFileIds,
                [getContextKey(projectId, worktreeId)]: fileIds,
            },
        })),

    stagePaths: async (projectId, paths, worktreeId = null) => {
        const snapshot = await getComandoApi().stageGitPaths({
            paths,
            projectId,
            worktreeId,
        });
        applySnapshotState(set, projectId, snapshot);
        refreshCachedWorktreeDiff(
            get,
            projectId,
            snapshot.currentWorktreeId ?? worktreeId,
        );
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

    toggleBranchDiffFileCollapse: (projectId, fileId, worktreeId = null) =>
        set((state) => {
            const contextKey = getContextKey(projectId, worktreeId);
            const currentFileIds =
                state.collapsedBranchDiffFileIds[contextKey] ?? [];
            const isCollapsed = currentFileIds.includes(fileId);

            return {
                collapsedBranchDiffFileIds: {
                    ...state.collapsedBranchDiffFileIds,
                    [contextKey]: isCollapsed
                        ? currentFileIds.filter((entry) => entry !== fileId)
                        : [...currentFileIds, fileId],
                },
            };
        }),

    toggleWorktreeDiffFileCollapse: (projectId, fileId, worktreeId = null) =>
        set((state) => {
            const contextKey = getContextKey(projectId, worktreeId);
            const currentFileIds =
                state.collapsedWorktreeDiffFileIds[contextKey] ?? [];
            const isCollapsed = currentFileIds.includes(fileId);

            return {
                collapsedWorktreeDiffFileIds: {
                    ...state.collapsedWorktreeDiffFileIds,
                    [contextKey]: isCollapsed
                        ? currentFileIds.filter((entry) => entry !== fileId)
                        : [...currentFileIds, fileId],
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
        refreshCachedWorktreeDiff(
            get,
            projectId,
            snapshot.currentWorktreeId ?? worktreeId,
        );
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
    const hasWorktreeChanges = snapshot.changedPaths.length > 0;

    set((state) => {
        const shouldUpdateWorktreeInventory =
            isSnapshotNewerThanWorktreeInventory(
                snapshot,
                state.worktreeInventoryUpdatedAtByProject[projectId],
            );
        const nextWorktreeDiffState = hasWorktreeChanges
            ? markWorktreeDiffStaleState(state, contextKey)
            : clearCleanWorktreeDiffState(state, contextKey);

        return {
            activeWorktreeIds: {
                ...state.activeWorktreeIds,
                [projectId]: resolveSnapshotWorktreeId(
                    snapshot,
                    state.activeWorktreeIds[projectId] ?? null,
                ),
            },
            branchesByProject: {
                ...state.branchesByProject,
                [projectId]: snapshot.branches,
            },
            errors: {
                ...state.errors,
                [contextKey]: null,
            },
            expandedChangeGroups: {
                ...state.expandedChangeGroups,
                [contextKey]:
                    state.expandedChangeGroups[contextKey] ??
                    DEFAULT_CHANGE_GROUPS,
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
            ...(shouldUpdateWorktreeInventory
                ? {
                      worktreeInventoryUpdatedAtByProject: {
                          ...state.worktreeInventoryUpdatedAtByProject,
                          [projectId]: snapshot.updatedAt,
                      },
                      worktreesByProject: {
                          ...state.worktreesByProject,
                          [projectId]: snapshot.worktrees,
                      },
                  }
                : {}),
            ...nextWorktreeDiffState,
            ...markBranchDiffStaleState(state, contextKey),
        };
    });
}

function isSnapshotNewerThanWorktreeInventory(
    snapshot: GitRepositorySnapshot,
    currentUpdatedAt: string | undefined,
): boolean {
    if (!currentUpdatedAt) {
        return true;
    }

    const snapshotTimestamp = rfc3339TimestampToNanoseconds(snapshot.updatedAt);
    const currentTimestamp = rfc3339TimestampToNanoseconds(currentUpdatedAt);
    if (snapshotTimestamp === null || currentTimestamp === null) {
        return snapshot.updatedAt > currentUpdatedAt;
    }

    return snapshotTimestamp > currentTimestamp;
}

function rfc3339TimestampToNanoseconds(timestamp: string): bigint | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(
        timestamp,
    );
    if (!match) {
        return null;
    }

    const [
        ,
        year,
        month,
        day,
        hour,
        minute,
        second,
        fraction = "",
        timezone,
    ] = match;
    const timezoneOffsetMinutes =
        timezone === "Z"
            ? 0
            : (Number(timezone.slice(1, 3)) * 60 +
                  Number(timezone.slice(4, 6))) *
              (timezone.startsWith("+") ? 1 : -1);
    const milliseconds =
        Date.UTC(
            Number(year),
            Number(month) - 1,
            Number(day),
            Number(hour),
            Number(minute),
            Number(second),
        ) -
        timezoneOffsetMinutes * 60_000;
    if (!Number.isFinite(milliseconds)) {
        return null;
    }

    const nanoseconds = BigInt(`${fraction}000000000`.slice(0, 9));
    return BigInt(milliseconds) * 1_000_000n + nanoseconds;
}

function markBranchDiffStaleState(
    state: GitStoreState,
    contextKey: string,
): Pick<GitStoreState, "failedBranchDiffContexts" | "staleBranchDiffContexts"> {
    return {
        failedBranchDiffContexts: {
            ...state.failedBranchDiffContexts,
            [contextKey]: false,
        },
        staleBranchDiffContexts: {
            ...state.staleBranchDiffContexts,
            [contextKey]: hasOwn(state.branchDiffsByContext, contextKey),
        },
    };
}

function clearCleanWorktreeDiffState(
    state: GitStoreState,
    contextKey: string,
): Pick<
    GitStoreState,
    | "collapsedWorktreeDiffFileIds"
    | "diffsByContext"
    | "failedWorktreeDiffContexts"
    | "selectedWorktreeDiffFileIds"
    | "staleWorktreeDiffContexts"
    | "worktreeDiffsByContext"
> {
    return {
        collapsedWorktreeDiffFileIds: {
            ...state.collapsedWorktreeDiffFileIds,
            [contextKey]: [],
        },
        diffsByContext: {
            ...state.diffsByContext,
            [contextKey]: {},
        },
        failedWorktreeDiffContexts: {
            ...state.failedWorktreeDiffContexts,
            [contextKey]: false,
        },
        selectedWorktreeDiffFileIds: {
            ...state.selectedWorktreeDiffFileIds,
            [contextKey]: null,
        },
        staleWorktreeDiffContexts: {
            ...state.staleWorktreeDiffContexts,
            [contextKey]: false,
        },
        worktreeDiffsByContext: {
            ...state.worktreeDiffsByContext,
            [contextKey]: null,
        },
    };
}

function markWorktreeDiffStaleState(
    state: GitStoreState,
    contextKey: string,
): Pick<
    GitStoreState,
    "failedWorktreeDiffContexts" | "staleWorktreeDiffContexts"
> {
    return {
        failedWorktreeDiffContexts: {
            ...state.failedWorktreeDiffContexts,
            [contextKey]: false,
        },
        staleWorktreeDiffContexts: {
            ...state.staleWorktreeDiffContexts,
            [contextKey]: hasOwn(state.worktreeDiffsByContext, contextKey),
        },
    };
}

function resolveSnapshotWorktreeId(
    snapshot: GitRepositorySnapshot | null,
    preferredWorktreeId: string | null,
): string | null {
    if (!snapshot) {
        return preferredWorktreeId;
    }

    if (
        preferredWorktreeId &&
        snapshot.worktrees.some(
            (worktree) => worktree.id === preferredWorktreeId,
        )
    ) {
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

    return (
        snapshot.currentWorktreeId ??
        snapshot.worktrees.find((worktree) => worktree.isCurrent)?.id ??
        snapshot.worktrees.find((worktree) => worktree.isPrimary)?.id ??
        null
    );
}

function collectBranchDiffFileIds(
    result: GitBranchDiffResult | null,
): readonly string[] {
    return (
        result?.files.map((file) => buildGitDiffFileId("branch", file.path)) ?? []
    );
}

function collectWorktreeDiffFileIds(
    result: GitWorktreeDiffResult | null,
): readonly string[] {
    if (!result) {
        return [];
    }

    return result.sections.flatMap((section) =>
        section.files.map((file) => buildGitDiffFileId(file.scope, file.path)),
    );
}

function refreshCachedWorktreeDiff(
    get: () => GitStoreState,
    projectId: string,
    worktreeId: string | null,
): void {
    // Only the visible resource refreshes immediately; the other cache remains stale.
    const contextKey = getContextKey(projectId, worktreeId);
    if (
        get().activeDiffModesByContext[contextKey] === "worktree" &&
        hasOwn(get().worktreeDiffsByContext, contextKey)
    ) {
        void get().refreshWorktreeDiff(projectId, worktreeId);
    }
}

function hasOwn<T extends object>(
    value: T,
    key: PropertyKey,
): key is keyof T {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function getContextKey(projectId: string, worktreeId: string | null): string {
    return getGitContextKey(projectId, worktreeId);
}

function normalizeWorktreeIdForStorage(
    projectId: string,
    worktreeId: string | null,
    snapshots: Record<string, GitRepositorySnapshot | null>,
): string | null {
    if (worktreeId !== null) {
        return worktreeId;
    }

    return (
        Object.values(snapshots).find(
            (snapshot) => snapshot?.projectId === projectId,
        )?.worktrees.find((worktree) => worktree.isPrimary)?.id ??
        getPrimaryWorktreeId(projectId)
    );
}

function getComandoApi() {
    if (!("comando" in window)) {
        throw new Error("The renderer bridge is not available.");
    }

    return window.comando;
}
