export const WORKSPACE_PRIMARY_CONTEXT = "__primary__";

const NO_PROJECT_CONTEXT = "__none__";

export interface WorkspaceScope {
    readonly projectId: string;
    readonly worktreeId: string | null;
}

export type WorkspaceScopeKey = string;

export interface WorkspaceLocation extends WorkspaceScope {
    readonly contextKey: string;
    readonly hostWindowId: string;
}

export interface WorkspaceContextCollection {
    readonly contexts: readonly (WorkspaceScope & { readonly key: string })[];
    readonly openContextKeys: readonly string[];
}

export function normalizeWorkspaceWorktreeId(
    projectId: string,
    worktreeId: string | null | undefined,
): string | null {
    return worktreeId === null ||
        worktreeId === undefined ||
        worktreeId === `${projectId}:primary`
        ? null
        : worktreeId;
}

export function getWorkspaceContextKey(
    projectId: string | null,
    worktreeId: string | null | undefined,
): WorkspaceScopeKey {
    return getWorkspaceScopeKey(projectId, worktreeId);
}

export function getWorkspaceScopeKey(
    projectId: string | null,
    worktreeId: string | null | undefined,
): WorkspaceScopeKey {
    if (!projectId) {
        return `${NO_PROJECT_CONTEXT}::${worktreeId ?? WORKSPACE_PRIMARY_CONTEXT}`;
    }
    return `${projectId}::${normalizeWorkspaceWorktreeId(projectId, worktreeId) ?? WORKSPACE_PRIMARY_CONTEXT}`;
}

export function areWorkspaceWorktreeIdsEquivalent(
    projectId: string | null,
    left: string | null | undefined,
    right: string | null | undefined,
): boolean {
    if (!projectId) {
        return (left ?? null) === (right ?? null);
    }
    return (
        normalizeWorkspaceWorktreeId(projectId, left) ===
        normalizeWorkspaceWorktreeId(projectId, right)
    );
}

export function areWorkspaceScopesEquivalent(
    left: WorkspaceScope,
    right: WorkspaceScope,
): boolean {
    return (
        left.projectId === right.projectId &&
        areWorkspaceWorktreeIdsEquivalent(
            left.projectId,
            left.worktreeId,
            right.worktreeId,
        )
    );
}

export function hasOpenWorkspaceScope(
    collection: WorkspaceContextCollection,
    scope: WorkspaceScope,
): boolean {
    const openContextKeys = new Set(collection.openContextKeys);
    return collection.contexts.some(
        (context) =>
            openContextKeys.has(context.key) &&
            areWorkspaceScopesEquivalent(context, scope),
    );
}
