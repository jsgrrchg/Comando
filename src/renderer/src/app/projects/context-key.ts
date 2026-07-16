// Shared helpers for building the per-(project, worktree) cache key used by the
// project tree, the file index, and any other context-scoped renderer caches.
// Centralizing this keeps the key format identical across every consumer.

export const PROJECT_TREE_PRIMARY_CONTEXT = "__primary__";

const NO_PROJECT_CONTEXT = "__none__";

export function getProjectContextKey(
    projectId: string | null,
    worktreeId: string | null,
): string {
    const normalizedWorktreeId =
        projectId && worktreeId === `${projectId}:primary`
            ? PROJECT_TREE_PRIMARY_CONTEXT
            : (worktreeId ?? PROJECT_TREE_PRIMARY_CONTEXT);
    return `${projectId ?? NO_PROJECT_CONTEXT}::${
        normalizedWorktreeId
    }`;
}
