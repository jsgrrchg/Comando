import { describe, expect, it } from "vitest";

import type {
    GitBranchSummary,
    GitRemoteSummary,
    GitRepositorySnapshot,
    GitWorktreeSummary,
} from "@shared/ipc";

import {
    getGitHubRepositorySnapshot,
    getProjectSnapshot,
} from "./SidebarGitHubPanel";

function createBranch(
    overrides: Partial<GitBranchSummary> = {},
): GitBranchSummary {
    return {
        aheadBy: 0,
        behindBy: 0,
        commitSha: "abc1234567890",
        isCurrent: true,
        isDetached: false,
        isRemote: false,
        kind: "branch",
        name: "main",
        upstreamName: "origin/main",
        ...overrides,
    };
}

function createRemote(
    overrides: Partial<GitRemoteSummary> = {},
): GitRemoteSummary {
    return {
        aheadBy: 0,
        behindBy: 0,
        fetchUrl: "https://github.com/example/comando.git",
        isDefault: true,
        name: "origin",
        pushUrl: "https://github.com/example/comando.git",
        refName: "origin/main",
        ...overrides,
    };
}

function createWorktree(
    overrides: Partial<GitWorktreeSummary> = {},
): GitWorktreeSummary {
    return {
        branchName: "main",
        commitSha: "abc1234567890",
        id: "project-1:primary",
        isBare: false,
        isCurrent: true,
        isLocked: false,
        isPrimary: true,
        lockedReason: null,
        projectId: "project-1",
        rootPath: "/tmp/Comando",
        updatedAt: "2026-04-19T00:00:00.000Z",
        ...overrides,
    };
}

function createSnapshot(
    overrides: Partial<GitRepositorySnapshot> = {},
): GitRepositorySnapshot {
    return {
        aheadBy: 0,
        behindBy: 0,
        branch: createBranch(),
        canonicalRootPath: "/tmp/Comando",
        changedPaths: [],
        changes: [],
        currentWorktreeId: null,
        defaultTreeViewMode: "tree",
        headSha: "abc1234567890",
        projectId: "project-1",
        remotes: [createRemote()],
        repositoryState: "ready",
        rootPath: "/tmp/Comando",
        selectedRemoteName: "origin",
        status: {
            changedCount: 0,
            conflictedCount: 0,
            stagedCount: 0,
            unstagedCount: 0,
            untrackedCount: 0,
        },
        syncStatus: "in_sync",
        updatedAt: "2026-04-19T00:00:00.000Z",
        worktrees: [createWorktree()],
        ...overrides,
    };
}

describe("SidebarGitHubPanel snapshot helpers", () => {
    it("does not use a project fallback for the branch snapshot of a missing worktree", () => {
        const primarySnapshot = createSnapshot({
            branch: createBranch({ name: "main" }),
            worktrees: [
                createWorktree(),
                createWorktree({
                    branchName: "feature/github-panel",
                    id: "worktree-feature",
                    isCurrent: false,
                    isPrimary: false,
                    rootPath: "/tmp/Comando-feature",
                }),
            ],
        });

        const snapshots = {
            "project-1::primary": primarySnapshot,
        };

        expect(
            getProjectSnapshot(snapshots, "project-1", "worktree-feature"),
        ).toBeNull();
    });

    it("uses a project snapshot fallback for GitHub repository identity", () => {
        const primarySnapshot = createSnapshot({
            remotes: [
                createRemote({
                    fetchUrl: "git@github.com:example/comando.git",
                    pushUrl: "git@github.com:example/comando.git",
                }),
            ],
            worktrees: [
                createWorktree(),
                createWorktree({
                    branchName: "feature/github-panel",
                    id: "worktree-feature",
                    isCurrent: false,
                    isPrimary: false,
                    rootPath: "/tmp/Comando-feature",
                }),
            ],
        });

        const snapshots = {
            "project-1::primary": primarySnapshot,
        };

        expect(
            getGitHubRepositorySnapshot(
                snapshots,
                "project-1",
                "worktree-feature",
            ),
        ).toBe(primarySnapshot);
    });

    it("prefers the direct worktree snapshot for GitHub repository identity", () => {
        const primarySnapshot = createSnapshot({
            branch: createBranch({ name: "main" }),
        });
        const worktreeSnapshot = createSnapshot({
            branch: createBranch({ name: "feature/github-panel" }),
            currentWorktreeId: "worktree-feature",
            rootPath: "/tmp/Comando-feature",
            worktrees: [
                createWorktree({
                    branchName: "feature/github-panel",
                    id: "worktree-feature",
                    rootPath: "/tmp/Comando-feature",
                }),
            ],
        });

        const snapshots = {
            "project-1::primary": primarySnapshot,
            "project-1::worktree-feature": worktreeSnapshot,
        };

        expect(
            getGitHubRepositorySnapshot(
                snapshots,
                "project-1",
                "worktree-feature",
            ),
        ).toBe(worktreeSnapshot);
    });
});
