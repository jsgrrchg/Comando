import type {
    GitBranchSummary,
    GitHistoryCommitSummary,
} from "@shared/ipc";

export interface GitScopeBranchTopology {
    readonly branchName: string;
    readonly connected: boolean;
    readonly historyIndex: number | null;
}

export interface GitScopeBranchTopologyResult {
    readonly byBranchName: ReadonlyMap<string, GitScopeBranchTopology>;
    readonly orderedBranchNames: readonly string[];
}

export function buildGitScopeBranchTopologyRequestKey(
    contextKey: string | null,
    branches: readonly GitBranchSummary[],
): string | null {
    if (!contextKey) {
        return null;
    }

    const localTips = branches
        .filter((branch) => !branch.isRemote)
        .map((branch) => `${branch.name}:${branch.commitSha ?? ""}`)
        .toSorted();

    return `${contextKey}:${localTips.join("|")}`;
}

/**
 * Orders local branches by where their tip commit falls in `history` (most
 * recent first), so the branch list reads like a commit timeline rather than
 * an alphabetical list. Branches whose tip isn't in the loaded history window
 * are marked `connected: false` and sorted after every connected branch.
 */
export function buildGitScopeBranchTopology(
    branches: readonly GitBranchSummary[],
    history: readonly GitHistoryCommitSummary[],
    currentBranchName: string | null =
        branches.find((branch) => !branch.isRemote && branch.isCurrent)?.name ??
        null,
): GitScopeBranchTopologyResult {
    const localBranches = branches.filter((branch) => !branch.isRemote);
    const historyIndexBySha = new Map(
        history.map((commit, index) => [commit.sha, index]),
    );

    const orderedBranches = localBranches.toSorted((left, right) => {
        const leftIndex = left.commitSha
            ? (historyIndexBySha.get(left.commitSha) ?? null)
            : null;
        const rightIndex = right.commitSha
            ? (historyIndexBySha.get(right.commitSha) ?? null)
            : null;

        if (leftIndex !== null && rightIndex !== null && leftIndex !== rightIndex) {
            return leftIndex - rightIndex;
        }
        if (leftIndex !== null && rightIndex === null) {
            return -1;
        }
        if (leftIndex === null && rightIndex !== null) {
            return 1;
        }
        const leftIsCurrent = left.name === currentBranchName;
        const rightIsCurrent = right.name === currentBranchName;
        if (leftIsCurrent !== rightIsCurrent) {
            return leftIsCurrent ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
    });

    const byBranchName = new Map<string, GitScopeBranchTopology>(
        orderedBranches.map((branch) => {
            const historyIndex = branch.commitSha
                ? (historyIndexBySha.get(branch.commitSha) ?? null)
                : null;
            return [
                branch.name,
                {
                    branchName: branch.name,
                    connected: historyIndex !== null,
                    historyIndex,
                },
            ];
        }),
    );

    return {
        byBranchName,
        orderedBranchNames: orderedBranches.map((branch) => branch.name),
    };
}
