import { areGitWorktreeIdsEquivalent } from "./context-key";
import { collectPaneNodes, type WorkspaceTreeState } from "../workspace/tree";

import type { GitDiffMode } from "../store/git-store";

type VisibleGitDiffRevalidationOptions = {
    readonly ensureBranchDiff: (
        projectId: string,
        worktreeId: string | null,
    ) => Promise<unknown>;
    readonly ensureWorktreeDiff: (
        projectId: string,
        worktreeId: string | null,
    ) => Promise<unknown>;
    readonly getDiffMode: (
        projectId: string,
        worktreeId: string | null,
    ) => GitDiffMode;
    readonly projectId: string;
    readonly worktreeId: string | null;
    readonly workspace: WorkspaceTreeState & {
        readonly deferredPaneIds?: ReadonlySet<string>;
    };
};

/**
 * Revalidates only Git diff surfaces that are currently visible for one scope.
 * Inactive tabs retain their stale cache and load only when the user returns.
 */
export async function revalidateVisibleGitDiffs({
    ensureBranchDiff,
    ensureWorktreeDiff,
    getDiffMode,
    projectId,
    worktreeId,
    workspace,
}: VisibleGitDiffRevalidationOptions): Promise<void> {
    const pendingModes = new Set<GitDiffMode>();

    for (const pane of collectPaneNodes(workspace.rootNode)) {
        if (workspace.deferredPaneIds?.has(pane.id)) {
            continue;
        }
        const tab = pane.activeTabId
            ? workspace.tabsById[pane.activeTabId]
            : null;
        if (
            tab?.kind !== "git_worktree_diff" ||
            tab.projectId !== projectId ||
            !areGitWorktreeIdsEquivalent(
                projectId,
                tab.worktreeId ?? null,
                worktreeId,
            )
        ) {
            continue;
        }

        pendingModes.add(getDiffMode(projectId, worktreeId));
    }

    await Promise.all(
        [...pendingModes].map((mode) =>
            mode === "branch"
                ? ensureBranchDiff(projectId, worktreeId)
                : ensureWorktreeDiff(projectId, worktreeId),
        ),
    );
}
