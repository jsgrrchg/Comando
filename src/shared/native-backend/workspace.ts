import type { NativeProjectId, NativeWorkspaceId, NativeWorktreeId } from "./ids";

export type NativeWorkspaceLayoutSnapshot = {
    readonly workspaceId: NativeWorkspaceId | null;
    readonly activePaneId: string;
    readonly rootNode: unknown;
    readonly tabs: readonly unknown[];
    readonly projectId: NativeProjectId | null;
    readonly worktreeId: NativeWorktreeId | null;
};
