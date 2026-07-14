import { afterEach, describe, expect, it, vi } from "vitest";

import type { GitRepositorySnapshot, GitWorktreeSummary } from "@shared/ipc";

import { useGitStore } from "./git-store";

describe("git-store history", () => {
    afterEach(() => {
        resetGitStoreForTests();
        vi.unstubAllGlobals();
    });

    it("requests history across all refs from the renderer bridge", async () => {
        const listGitHistory = vi.fn().mockResolvedValue({
            commits: [],
            matchedCount: 0,
            totalCount: 0,
        });
        stubComando({ listGitHistory });

        await useGitStore.getState().refreshHistory("project-1", null);

        expect(listGitHistory).toHaveBeenCalledWith(
            expect.objectContaining({
                includeAllRefs: true,
                projectId: "project-1",
                worktreeId: null,
            }),
        );
    });

    it("keeps the newest submillisecond worktree inventory across cached contexts", () => {
        useGitStore.getState().ingestSnapshot(
            createSnapshot({
                currentWorktreeId: "worktree-1",
                updatedAt: "2026-07-14T12:01:00.123456700Z",
                worktrees: [
                    createWorktree("project-1:primary", "main", true),
                    createWorktree("worktree-1", "feature/current"),
                ],
            }),
        );
        useGitStore.getState().ingestSnapshot(
            createSnapshot({
                currentWorktreeId: "worktree-2",
                updatedAt: "2026-07-14T12:01:00.123789900Z",
                worktrees: [
                    createWorktree("project-1:primary", "main", true),
                    createWorktree("worktree-2", "feature/new"),
                ],
            }),
        );
        useGitStore.getState().ingestSnapshot(
            createSnapshot({
                currentWorktreeId: "worktree-1",
                updatedAt: "2026-07-14T12:01:00.123456700Z",
                worktrees: [
                    createWorktree("project-1:primary", "main", true),
                    createWorktree("worktree-1", "feature/stale"),
                ],
            }),
        );

        expect(useGitStore.getState().worktreesByProject["project-1"])
            .toEqual([
                createWorktree("project-1:primary", "main", true),
                createWorktree("worktree-2", "feature/new"),
            ]);
    });
});

function createSnapshot(
    overrides: Partial<GitRepositorySnapshot> = {},
): GitRepositorySnapshot {
    return {
        aheadBy: 0,
        behindBy: 0,
        branch: null,
        branches: [],
        canonicalRootPath: "/tmp/project",
        changedPaths: [],
        changes: [],
        currentWorktreeId: null,
        defaultTreeViewMode: "tree",
        headSha: null,
        projectId: "project-1",
        remotes: [],
        repositoryState: "ready",
        rootPath: "/tmp/project",
        selectedRemoteName: null,
        status: {
            changedCount: 0,
            conflictedCount: 0,
            stagedCount: 0,
            unstagedCount: 0,
            untrackedCount: 0,
        },
        syncStatus: "in_sync",
        updatedAt: "2026-07-14T12:00:00.000Z",
        worktrees: [],
        ...overrides,
    };
}

function createWorktree(
    id: string,
    branchName: string,
    isPrimary = false,
): GitWorktreeSummary {
    return {
        branchName,
        commitSha: null,
        id,
        isBare: false,
        isCurrent: false,
        isLocked: false,
        isPrimary,
        lockedReason: null,
        projectId: "project-1",
        rootPath: `/tmp/${id}`,
        updatedAt: "2026-07-14T12:00:00.000Z",
    };
}

function stubComando(api: Record<string, unknown>): void {
    vi.stubGlobal("window", {
        comando: api,
    });
}

function resetGitStoreForTests(): void {
    useGitStore.setState({
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
        worktreeInventoryUpdatedAtByProject: {},
        worktreesByProject: {},
        worktreeDiffRequestKeysByContext: {},
        worktreeDiffsByContext: {},
        collapsedWorktreeDiffFileIds: {},
    });
}
