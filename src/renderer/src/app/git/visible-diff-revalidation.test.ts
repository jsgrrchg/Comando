import { describe, expect, it, vi } from "vitest";

import type { WorkspaceTreeState } from "../workspace/tree";
import { revalidateVisibleGitDiffs } from "./visible-diff-revalidation";

describe("revalidateVisibleGitDiffs", () => {
    it("refreshes the visible worktree diff for the primary context", async () => {
        const ensureBranchDiff = vi.fn().mockResolvedValue(null);
        const ensureWorktreeDiff = vi.fn().mockResolvedValue(null);

        await revalidateVisibleGitDiffs({
            ensureBranchDiff,
            ensureWorktreeDiff,
            getDiffMode: () => "worktree",
            projectId: "project-1",
            worktreeId: "project-1:primary",
            workspace: createWorkspace("project-1", null),
        });

        expect(ensureWorktreeDiff).toHaveBeenCalledWith(
            "project-1",
            "project-1:primary",
        );
        expect(ensureBranchDiff).not.toHaveBeenCalled();
    });

    it("refreshes Branch Changes for the matching linked worktree", async () => {
        const ensureBranchDiff = vi.fn().mockResolvedValue(null);
        const ensureWorktreeDiff = vi.fn().mockResolvedValue(null);

        await revalidateVisibleGitDiffs({
            ensureBranchDiff,
            ensureWorktreeDiff,
            getDiffMode: () => "branch",
            projectId: "project-1",
            worktreeId: "worktree-2",
            workspace: createWorkspace("project-1", "worktree-2"),
        });

        expect(ensureBranchDiff).toHaveBeenCalledWith(
            "project-1",
            "worktree-2",
        );
        expect(ensureWorktreeDiff).not.toHaveBeenCalled();
    });

    it("leaves diffs for inactive or unrelated contexts stale", async () => {
        const ensureBranchDiff = vi.fn().mockResolvedValue(null);
        const ensureWorktreeDiff = vi.fn().mockResolvedValue(null);

        await revalidateVisibleGitDiffs({
            ensureBranchDiff,
            ensureWorktreeDiff,
            getDiffMode: () => "worktree",
            projectId: "project-1",
            worktreeId: "worktree-2",
            workspace: createWorkspace("project-1", "worktree-1"),
        });

        expect(ensureBranchDiff).not.toHaveBeenCalled();
        expect(ensureWorktreeDiff).not.toHaveBeenCalled();
    });

    it("does not load a deferred pane until it becomes visible", async () => {
        const ensureBranchDiff = vi.fn().mockResolvedValue(null);
        const ensureWorktreeDiff = vi.fn().mockResolvedValue(null);
        const workspace = createWorkspace("project-1", "worktree-2");

        await revalidateVisibleGitDiffs({
            ensureBranchDiff,
            ensureWorktreeDiff,
            getDiffMode: () => "worktree",
            projectId: "project-1",
            worktreeId: "worktree-2",
            workspace: {
                ...workspace,
                deferredPaneIds: new Set(["pane-1"]),
            },
        });

        expect(ensureBranchDiff).not.toHaveBeenCalled();
        expect(ensureWorktreeDiff).not.toHaveBeenCalled();
    });
});

function createWorkspace(
    projectId: string,
    worktreeId: string | null,
): WorkspaceTreeState {
    return {
        activePaneId: "pane-1",
        rootNode: {
            activeTabId: "git-diff",
            id: "pane-1",
            tabIds: ["git-diff"],
            type: "pane",
        },
        tabsById: {
            "git-diff": {
                createdAt: "2026-08-01T00:00:00.000Z",
                id: "git-diff",
                kind: "git_worktree_diff",
                projectId,
                title: "Uncommitted Changes",
                worktreeId,
            },
        },
    };
}
