import type { GitRepositoryInvalidation } from "@shared/ipc";

import { areGitWorktreeIdsEquivalent } from "./context-key";

export const GIT_INVALIDATION_REFRESH_DEBOUNCE_MS = 50;

type TimeoutHandle = ReturnType<typeof setTimeout>;

type GitProjectRefreshSchedulerOptions = {
    readonly delayMs?: number;
    readonly refreshHistory?: (
        projectId: string,
        worktreeId: string | null,
    ) => Promise<unknown>;
    readonly refreshProject: (
        projectId: string,
        worktreeId: string | null,
    ) => Promise<void>;
    readonly setTimeoutFn?: typeof setTimeout;
    readonly clearTimeoutFn?: typeof clearTimeout;
};

export type GitProjectRefreshScheduler = {
    readonly cancel: (projectId: string, worktreeId: string | null) => void;
    readonly clear: () => void;
    readonly schedule: (
        projectId: string,
        worktreeId: string | null,
        options?: GitProjectRefreshOptions,
    ) => void;
};

export type GitProjectRefreshOptions = {
    readonly refreshHistory?: boolean;
};

export function gitInvalidationAffectsHistory(
    reason: GitRepositoryInvalidation["reason"],
): boolean {
    return (
        reason === "branch" ||
        reason === "remote" ||
        reason === "worktree" ||
        reason === "unknown"
    );
}

export function gitInvalidationAffectsHistoryForScope(
    invalidation: GitRepositoryInvalidation,
    activeWorktreeId: string | null,
): boolean {
    return (
        gitInvalidationAffectsHistory(invalidation.reason) &&
        (invalidation.worktreeId === null ||
            areGitWorktreeIdsEquivalent(
                invalidation.projectId,
                invalidation.worktreeId,
                activeWorktreeId,
            ))
    );
}

export function createGitProjectRefreshScheduler({
    delayMs = GIT_INVALIDATION_REFRESH_DEBOUNCE_MS,
    refreshHistory,
    refreshProject,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
}: GitProjectRefreshSchedulerOptions): GitProjectRefreshScheduler {
    const pendingRefreshes = new Map<string, TimeoutHandle>();
    const activeRefreshes = new Map<string, Promise<void>>();
    const refreshAgain = new Set<string>();
    const historyRefreshes = new Set<string>();

    const run = (projectId: string, worktreeId: string | null): void => {
        const contextKey = getGitSchedulerContextKey(projectId, worktreeId);
        if (activeRefreshes.has(contextKey)) {
            // Keep only one catch-up pass while writes continue arriving.
            refreshAgain.add(contextKey);
            return;
        }

        const projectRefresh = refreshProject(projectId, worktreeId);
        const refresh =
            historyRefreshes.delete(contextKey) && refreshHistory
                ? Promise.all([
                      projectRefresh,
                      refreshHistory(projectId, worktreeId),
                  ]).then(() => undefined)
                : projectRefresh;
        const trackedRefresh = refresh.finally(() => {
            activeRefreshes.delete(contextKey);
            if (refreshAgain.delete(contextKey)) {
                run(projectId, worktreeId);
            }
        });
        activeRefreshes.set(contextKey, trackedRefresh);
    };

    const cancel = (projectId: string, worktreeId: string | null): void => {
        const contextKey = getGitSchedulerContextKey(projectId, worktreeId);
        const timeout = pendingRefreshes.get(contextKey);
        if (timeout !== undefined) {
            clearTimeoutFn(timeout);
            pendingRefreshes.delete(contextKey);
        }
        refreshAgain.delete(contextKey);
        historyRefreshes.delete(contextKey);
    };

    const clearPendingTimeout = (contextKey: string): void => {
        const timeout = pendingRefreshes.get(contextKey);
        if (timeout !== undefined) {
            clearTimeoutFn(timeout);
            pendingRefreshes.delete(contextKey);
        }
    };

    return {
        cancel,
        clear: () => {
            for (const timeout of pendingRefreshes.values()) {
                clearTimeoutFn(timeout);
            }
            pendingRefreshes.clear();
            refreshAgain.clear();
            historyRefreshes.clear();
        },
        schedule: (projectId, worktreeId, options = {}) => {
            const contextKey = getGitSchedulerContextKey(projectId, worktreeId);
            // Preserve a history request when a later status event extends the debounce.
            clearPendingTimeout(contextKey);
            if (options.refreshHistory) {
                historyRefreshes.add(contextKey);
            }
            const timeout = setTimeoutFn(() => {
                pendingRefreshes.delete(contextKey);
                run(projectId, worktreeId);
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
