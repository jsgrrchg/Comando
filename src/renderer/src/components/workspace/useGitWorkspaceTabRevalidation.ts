import { useEffect, useRef } from "react";

type GitWorkspaceTabRevalidationOptions = {
    readonly isLoading: boolean;
    readonly projectId: string | null;
    readonly revalidate: (
        projectId: string,
        worktreeId: string | null,
    ) => Promise<unknown>;
    readonly worktreeId: string | null;
};

export function useGitWorkspaceTabRevalidation({
    isLoading,
    projectId,
    revalidate,
    worktreeId,
}: GitWorkspaceTabRevalidationOptions): void {
    const revalidatedContextRef = useRef<string | null>(null);

    useEffect(() => {
        if (!projectId) {
            return;
        }

        const contextKey = `${projectId}::${worktreeId ?? "__primary__"}`;
        if (revalidatedContextRef.current === contextKey) {
            return;
        }

        revalidatedContextRef.current = contextKey;
        if (!isLoading) {
            void revalidate(projectId, worktreeId);
        }
    }, [isLoading, projectId, revalidate, worktreeId]);
}
