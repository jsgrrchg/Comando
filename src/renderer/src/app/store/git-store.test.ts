import { afterEach, describe, expect, it, vi } from "vitest";

import type {
    GitRepositorySnapshot,
    GitWorktreeDiffResult,
    GitWorktreeSummary,
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

describe("git-store worktree diff cache", () => {
    afterEach(() => {
        resetGitStoreForTests();
        vi.unstubAllGlobals();
    });

    it("defers a cached diff refresh until an active surface requests it", async () => {
        const listGitWorktreeDiff = vi
            .fn()
            .mockResolvedValue(createWorktreeDiffResult({
                updatedAt: "2026-07-14T12:02:00.000Z",
            }));
        const getGitRepositorySnapshot = vi.fn().mockResolvedValue(
            createSnapshot({ changedPaths: ["src/changed.ts"] }),
        );
        stubComando({ getGitRepositorySnapshot, listGitWorktreeDiff });

        const contextKey = "project-1::primary";
        const cachedResult = createWorktreeDiffResult();
        useGitStore.setState({
            worktreeDiffsByContext: { [contextKey]: cachedResult },
        });

        await useGitStore.getState().refreshProject("project-1", null);

        expect(listGitWorktreeDiff).not.toHaveBeenCalled();
        expect(
            useGitStore.getState().worktreeDiffsByContext[contextKey],
        ).toBe(cachedResult);
        expect(
            useGitStore.getState().staleWorktreeDiffContexts[contextKey],
        ).toBe(true);

        await useGitStore.getState().ensureWorktreeDiff("project-1", null);

        expect(listGitWorktreeDiff).toHaveBeenCalledWith({
            projectId: "project-1",
            worktreeId: null,
        });
        expect(
            useGitStore.getState().staleWorktreeDiffContexts[contextKey],
        ).toBe(false);
    });

    it("keeps a diff stale when a newer snapshot arrives during its refresh", async () => {
        let resolveDiff: (result: GitWorktreeDiffResult | null) => void;
        const listGitWorktreeDiff = vi.fn(
            () =>
                new Promise<GitWorktreeDiffResult | null>((resolve) => {
                    resolveDiff = resolve;
                }),
        );
        stubComando({ listGitWorktreeDiff });

        const contextKey = "project-1::primary";
        useGitStore.setState({
            staleWorktreeDiffContexts: { [contextKey]: true },
            worktreeDiffsByContext: {
                [contextKey]: createWorktreeDiffResult(),
            },
        });

        const refresh = useGitStore
            .getState()
            .ensureWorktreeDiff("project-1", null);
        expect(
            useGitStore.getState().loadingWorktreeDiffContexts[contextKey],
        ).toBe(true);
        expect(
            useGitStore.getState().staleWorktreeDiffContexts[contextKey],
        ).toBe(false);

        useGitStore.getState().ingestSnapshot(
            createSnapshot({
                changedPaths: ["src/changed.ts"],
                updatedAt: "2026-07-14T12:01:00.000Z",
            }),
        );
        expect(
            useGitStore.getState().staleWorktreeDiffContexts[contextKey],
        ).toBe(true);

        resolveDiff!(createWorktreeDiffResult());
        await refresh;

        expect(
            useGitStore.getState().loadingWorktreeDiffContexts[contextKey],
        ).toBe(false);
        expect(
            useGitStore.getState().staleWorktreeDiffContexts[contextKey],
        ).toBe(true);
    });

    it("waits for a new snapshot before retrying a failed cached diff", async () => {
        const listGitWorktreeDiff = vi
            .fn()
            .mockRejectedValueOnce(new Error("Temporary Git failure"))
            .mockResolvedValueOnce(createWorktreeDiffResult());
        stubComando({ listGitWorktreeDiff });

        const contextKey = "project-1::primary";
        const cachedResult = createWorktreeDiffResult();
        useGitStore.setState({
            staleWorktreeDiffContexts: { [contextKey]: true },
            worktreeDiffsByContext: { [contextKey]: cachedResult },
        });

        await useGitStore.getState().ensureWorktreeDiff("project-1", null);
        await useGitStore.getState().ensureWorktreeDiff("project-1", null);

        expect(listGitWorktreeDiff).toHaveBeenCalledTimes(1);
        expect(
            useGitStore.getState().failedWorktreeDiffContexts[contextKey],
        ).toBe(true);
        expect(
            useGitStore.getState().worktreeDiffsByContext[contextKey],
        ).toBe(cachedResult);

        useGitStore.getState().ingestSnapshot(
            createSnapshot({
                changedPaths: ["src/changed.ts"],
                updatedAt: "2026-07-14T12:01:00.000Z",
            }),
        );
        await useGitStore.getState().ensureWorktreeDiff("project-1", null);

        expect(listGitWorktreeDiff).toHaveBeenCalledTimes(2);
        expect(
            useGitStore.getState().failedWorktreeDiffContexts[contextKey],
        ).toBe(false);
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

function createWorktreeDiffResult(
    overrides: Partial<GitWorktreeDiffResult> = {},
): GitWorktreeDiffResult {
    return {
        projectId: "project-1",
        sections: [],
        updatedAt: "2026-07-14T12:00:00.000Z",
        worktreeId: null,
        ...overrides,
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
    });
}
