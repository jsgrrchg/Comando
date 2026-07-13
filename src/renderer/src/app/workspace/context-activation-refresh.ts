export type WorkspaceContextSidebarView =
    | "files"
    | "git"
    | "agents"
    | "issues"
    | "pull_requests";

export interface WorkspaceContextRefreshPlan {
    readonly gitSnapshot: boolean;
    readonly projectTree: boolean;
}

export function resolveWorkspaceContextRefreshPlan(input: {
    readonly hasGitSnapshot: boolean;
    readonly hasProjectTree: boolean;
    readonly sidebarView: WorkspaceContextSidebarView;
    readonly sidebarVisible: boolean;
}): WorkspaceContextRefreshPlan {
    if (!input.sidebarVisible) {
        return { gitSnapshot: false, projectTree: false };
    }

    return {
        gitSnapshot: input.sidebarView === "git" && !input.hasGitSnapshot,
        projectTree: input.sidebarView === "files" && !input.hasProjectTree,
    };
}

export function runDeduplicatedContextRefresh<T>(
    pendingByContext: Map<string, Promise<T>>,
    contextKey: string,
    refresh: () => Promise<T>,
): Promise<T> {
    const pending = pendingByContext.get(contextKey);
    if (pending) {
        return pending;
    }

    const nextRefresh = Promise.resolve().then(refresh);
    pendingByContext.set(contextKey, nextRefresh);
    void nextRefresh.then(
        () => {
            if (pendingByContext.get(contextKey) === nextRefresh) {
                pendingByContext.delete(contextKey);
            }
        },
        () => {
            if (pendingByContext.get(contextKey) === nextRefresh) {
                pendingByContext.delete(contextKey);
            }
        },
    );

    return nextRefresh;
}
