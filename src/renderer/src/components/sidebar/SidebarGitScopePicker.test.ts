import { describe, expect, it } from "vitest";

import type { GitBranchSummary, GitWorktreeSummary } from "@shared/ipc";

import {
    buildSuggestedWorktreePath,
    buildUniqueLocalBranchName,
    isGitScopeWorktreeActive,
    parseRemoteBranchReference,
    resolveRemoteBranchResolution,
    stripRemotePrefix,
} from "./SidebarGitScopePicker";

function createBranch(
    overrides: Partial<GitBranchSummary> = {},
): GitBranchSummary {
    return {
        aheadBy: 0,
        behindBy: 0,
        commitSha: "abc1234567890",
        isCurrent: false,
        isDetached: false,
        isRemote: false,
        kind: "branch",
        name: "feature/test-branch",
        upstreamName: null,
        ...overrides,
    };
}

function createWorktree(
    overrides: Partial<GitWorktreeSummary> = {},
): GitWorktreeSummary {
    return {
        branchName: "feature/test-branch",
        commitSha: "abc1234567890",
        id: "worktree-1",
        isBare: false,
        isCurrent: false,
        isLocked: false,
        isPrimary: false,
        lockedReason: null,
        projectId: "project-1",
        rootPath: "/tmp/Comando-feature-test-branch",
        updatedAt: "2026-04-19T00:00:00.000Z",
        ...overrides,
    };
}

describe("SidebarGitScopePicker helpers", () => {
    it("resolves a remote branch to its tracking local branch and worktree", () => {
        const remoteBranch = createBranch({
            isRemote: true,
            kind: "remote",
            name: "origin/feature/test-branch",
        });
        const localBranch = createBranch({
            name: "feature/test-branch",
            upstreamName: remoteBranch.name,
        });
        const worktree = createWorktree({
            branchName: localBranch.name,
            id: "worktree-feature",
        });

        const resolution = resolveRemoteBranchResolution(
            remoteBranch,
            [remoteBranch, localBranch],
            [worktree],
        );

        expect(resolution.localBranch?.name).toBe(localBranch.name);
        expect(resolution.linkedWorktree?.id).toBe(worktree.id);
        expect(resolution.hasSuggestedNameConflict).toBe(false);
        expect(resolution.suggestedLocalBranchName).toBe(localBranch.name);
    });

    it("flags a name conflict when the short local name already exists without tracking the remote", () => {
        const remoteBranch = createBranch({
            isRemote: true,
            kind: "remote",
            name: "origin/feature/test-branch",
        });
        const conflictingLocalBranch = createBranch({
            name: "feature/test-branch",
            upstreamName: "origin/something-else",
        });

        const resolution = resolveRemoteBranchResolution(
            remoteBranch,
            [remoteBranch, conflictingLocalBranch],
            [],
        );

        expect(resolution.localBranch).toBeNull();
        expect(resolution.hasSuggestedNameConflict).toBe(true);
        expect(resolution.suggestedLocalBranchName).toBe(
            "feature/test-branch",
        );
    });

    it("builds unique local branch names when the preferred one is already taken", () => {
        const branches = [
            createBranch({ name: "feature/test-branch" }),
            createBranch({ name: "feature/test-branch-2" }),
        ];

        expect(
            buildUniqueLocalBranchName("feature/test-branch", branches),
        ).toBe("feature/test-branch-3");
    });

    it("suggests unique worktree sibling paths for repeated branch names", () => {
        const worktrees = [
            createWorktree({
                id: "worktree-1",
                rootPath: "/Users/test/Comando-feature-test-branch",
            }),
            createWorktree({
                id: "worktree-2",
                rootPath: "/Users/test/Comando-feature-test-branch-2",
            }),
        ];

        expect(
            buildSuggestedWorktreePath(
                "/Users/test/Comando",
                "feature/test-branch",
                worktrees,
            ),
        ).toBe("/Users/test/Comando-feature-test-branch-3");
    });

    it("strips the remote prefix while preserving nested branch paths", () => {
        expect(stripRemotePrefix("origin/feature/hardening/ui")).toBe(
            "feature/hardening/ui",
        );
    });

    it("parses remote branch references from both origin/* and remotes/origin/* forms", () => {
        expect(parseRemoteBranchReference("origin/feature/hardening/ui")).toEqual(
            {
                remoteName: "origin",
                remoteRef: "feature/hardening/ui",
            },
        );
        expect(
            parseRemoteBranchReference("remotes/origin/feature/hardening/ui"),
        ).toEqual({
            remoteName: "origin",
            remoteRef: "feature/hardening/ui",
        });
    });

    it("treats null and the persisted primary worktree id as the same active scope", () => {
        const primaryWorktree = createWorktree({
            id: "project-1:primary",
            isPrimary: true,
        });

        expect(
            isGitScopeWorktreeActive("project-1", null, primaryWorktree),
        ).toBe(true);
        expect(
            isGitScopeWorktreeActive(
                "project-1",
                "project-1:primary",
                primaryWorktree,
            ),
        ).toBe(true);
        expect(
            isGitScopeWorktreeActive(
                "project-1",
                "worktree-2",
                primaryWorktree,
            ),
        ).toBe(false);
    });
});
