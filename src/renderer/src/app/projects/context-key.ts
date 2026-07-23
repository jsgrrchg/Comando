import {
    getWorkspaceContextKey,
    WORKSPACE_PRIMARY_CONTEXT,
} from "@shared/workspace-context";

export const PROJECT_TREE_PRIMARY_CONTEXT = WORKSPACE_PRIMARY_CONTEXT;

export function getProjectContextKey(
    projectId: string | null,
    worktreeId: string | null,
): string {
    return getWorkspaceContextKey(projectId, worktreeId);
}
