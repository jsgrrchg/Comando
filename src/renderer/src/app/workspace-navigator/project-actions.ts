import type {
    GitRepositorySnapshot,
    GitWorktreeSummary,
} from "@shared/ipc";

export function findProjectGitSnapshot(
    snapshots: Record<string, GitRepositorySnapshot | null>,
    projectId: string,
): GitRepositorySnapshot | null {
    return (
        Object.values(snapshots).find(
            (snapshot) => snapshot?.projectId === projectId,
        ) ?? null
    );
}

export function resolveWorktreeBaseBranch(
    snapshot: GitRepositorySnapshot | null,
): string | null {
    const primaryWorktree = snapshot?.worktrees.find(
        (worktree) => worktree.isPrimary,
    );
    return primaryWorktree?.branchName ?? snapshot?.branch?.name ?? null;
}

export function buildSuggestedWorktreePath(
    rootPath: string,
    branchName: string,
    worktrees: readonly GitWorktreeSummary[],
): string {
    const normalizedRoot = rootPath.replace(/[\\/]+$/, "");
    const suffix =
        branchName
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9._/-]+/g, "-")
            .replace(/[\\/]+/g, "-")
            .replace(/^-+|-+$/g, "") || "worktree";
    const existingPaths = new Set(
        worktrees.map((worktree) =>
            worktree.rootPath.replace(/[\\/]+$/, ""),
        ),
    );
    let candidate = `${normalizedRoot}-${suffix}`;
    let index = 2;

    while (existingPaths.has(candidate)) {
        candidate = `${normalizedRoot}-${suffix}-${index}`;
        index += 1;
    }

    return candidate;
}
