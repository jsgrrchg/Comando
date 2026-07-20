export function getSessionStorage(): Storage | null {
    try {
        return globalThis.localStorage ?? null;
    } catch {
        // Embedded renderers can deny storage access before the app is ready.
        return null;
    }
}

export function getProjectStorageScope(projectId: string | null): string {
    return projectId?.trim() || "global";
}

export function getWorktreeStorageScope(
    worktreeId: string | null | undefined,
): string {
    return worktreeId?.trim() || "root";
}
