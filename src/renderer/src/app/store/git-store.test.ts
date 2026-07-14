import { afterEach, describe, expect, it, vi } from "vitest";

import type {
    GitRepositorySnapshot,
    GitWorktreeDiffResult,
} from "@shared/ipc";

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

    it("refreshes a cached worktree diff after a Git snapshot refresh", async () => {
        const listGitWorktreeDiff = vi.fn().mockResolvedValue({
            projectId: "project-1",
            sections: [],
            updatedAt: "2026-07-14T12:00:00.000Z",
            worktreeId: "worktree-1",
        } satisfies GitWorktreeDiffResult);
        stubComando({
            getGitRepositorySnapshot: vi.fn().mockResolvedValue(
                createSnapshot(),
            ),
            listGitWorktreeDiff,
        });
        useGitStore.setState({
            worktreeDiffsByContext: {
                "project-1::worktree-1": {
                    projectId: "project-1",
                    sections: [],
                    updatedAt: "2026-07-14T11:00:00.000Z",
                    worktreeId: "worktree-1",
                },
            },
        });

        await useGitStore
            .getState()
            .refreshProject("project-1", "worktree-1");
        await Promise.resolve();

        expect(listGitWorktreeDiff).toHaveBeenCalledWith({
            projectId: "project-1",
            worktreeId: "worktree-1",
        });
    });
});

function createSnapshot(): GitRepositorySnapshot {
    return {
        aheadBy: 0,
        behindBy: 0,
        branch: null,
        branches: [],
        canonicalRootPath: "/tmp/project",
        changedPaths: ["src/file.ts"],
        changes: [],
        currentWorktreeId: "worktree-1",
        defaultTreeViewMode: "tree",
        headSha: null,
        projectId: "project-1",
        remotes: [],
        repositoryState: "ready",
        rootPath: "/tmp/project-worktree",
        selectedRemoteName: null,
        status: {
            changedCount: 1,
            conflictedCount: 0,
            stagedCount: 0,
            unstagedCount: 1,
            untrackedCount: 0,
        },
        syncStatus: "in_sync",
        updatedAt: "2026-07-14T12:00:00.000Z",
        worktrees: [],
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
        worktreeDiffRequestKeysByContext: {},
        worktreeDiffsByContext: {},
        collapsedWorktreeDiffFileIds: {},
    });
}
