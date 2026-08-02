export interface GitWorktreeIdentity {
    readonly id: string;
    readonly isPrimary?: boolean;
}

export function getPrimaryWorktreeId(projectId: string): string {
    return `${projectId}:primary`;
}

export function resolveProjectContextWorktreeId(
    projectId: string,
    contextWorktreeId: string | null,
    activeGitWorktreeId: string | null,
): string {
    return (
        contextWorktreeId ??
        activeGitWorktreeId ??
        getPrimaryWorktreeId(projectId)
    );
}

export function resolveCommittedProjectWorktreeId(
    projectId: string,
    contextWorktreeId: string | null,
): string {
    return contextWorktreeId ?? getPrimaryWorktreeId(projectId);
}

export function normalizeGitWorktreeIdForContext(
    projectId: string,
    worktreeId: string | null,
    isPrimary = false,
): string {
    if (
        worktreeId === null ||
        isPrimary ||
        worktreeId === getPrimaryWorktreeId(projectId)
    ) {
        return "primary";
    }

    return worktreeId;
}

export function getGitContextKey(
    projectId: string,
    worktreeId: string | null,
): string {
    return `${projectId}::${normalizeGitWorktreeIdForContext(
        projectId,
        worktreeId,
    )}`;
}

export function areGitWorktreeIdsEquivalent(
    projectId: string,
    leftWorktreeId: string | null,
    rightWorktreeId: string | null,
): boolean {
    return (
        normalizeGitWorktreeIdForContext(projectId, leftWorktreeId) ===
        normalizeGitWorktreeIdForContext(projectId, rightWorktreeId)
    );
}

export function isGitWorktreeActive(
    projectId: string,
    activeWorktreeId: string | null,
    worktree: GitWorktreeIdentity,
): boolean {
    return (
        normalizeGitWorktreeIdForContext(projectId, activeWorktreeId) ===
        normalizeGitWorktreeIdForContext(
            projectId,
            worktree.id,
            worktree.isPrimary ?? false,
        )
    );
}
