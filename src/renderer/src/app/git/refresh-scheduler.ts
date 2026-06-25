export const GIT_INVALIDATION_REFRESH_DEBOUNCE_MS = 50;

type TimeoutHandle = ReturnType<typeof setTimeout>;

type GitProjectRefreshSchedulerOptions = {
    readonly delayMs?: number;
    readonly refreshProject: (
        projectId: string,
        worktreeId: string | null,
    ) => void;
    readonly setTimeoutFn?: typeof setTimeout;
    readonly clearTimeoutFn?: typeof clearTimeout;
};

export type GitProjectRefreshScheduler = {
    readonly cancel: (projectId: string, worktreeId: string | null) => void;
    readonly clear: () => void;
    readonly schedule: (projectId: string, worktreeId: string | null) => void;
};

export function createGitProjectRefreshScheduler({
    delayMs = GIT_INVALIDATION_REFRESH_DEBOUNCE_MS,
    refreshProject,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
}: GitProjectRefreshSchedulerOptions): GitProjectRefreshScheduler {
    const pendingRefreshes = new Map<string, TimeoutHandle>();

    const cancel = (projectId: string, worktreeId: string | null): void => {
        const contextKey = getGitSchedulerContextKey(projectId, worktreeId);
        const timeout = pendingRefreshes.get(contextKey);
        if (timeout === undefined) {
            return;
        }

        clearTimeoutFn(timeout);
        pendingRefreshes.delete(contextKey);
    };

    return {
        cancel,
        clear: () => {
            for (const timeout of pendingRefreshes.values()) {
                clearTimeoutFn(timeout);
            }
            pendingRefreshes.clear();
        },
        schedule: (projectId, worktreeId) => {
            const contextKey = getGitSchedulerContextKey(projectId, worktreeId);
            cancel(projectId, worktreeId);
            const timeout = setTimeoutFn(() => {
                pendingRefreshes.delete(contextKey);
                refreshProject(projectId, worktreeId);
            }, delayMs);
            pendingRefreshes.set(contextKey, timeout);
        },
    };
}

function getGitSchedulerContextKey(
    projectId: string,
    worktreeId: string | null,
): string {
    return `${projectId}::${worktreeId ?? "__primary__"}`;
}
