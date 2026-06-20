import type { NativeProjectId, NativeWorkspaceId, NativeWorktreeId } from "./ids";

export type NativeWorkspaceSnapshotRef = {
    readonly workspaceId: NativeWorkspaceId | null;
    readonly projectId: NativeProjectId | null;
    readonly worktreeId: NativeWorktreeId | null;
    readonly updatedAt: string;
    readonly storageKey: string;
};

export type NativePersistenceSnapshot = {
    readonly activeProjectId: NativeProjectId | null;
    readonly activeWorktreeId: NativeWorktreeId | null;
    readonly workspace: NativeWorkspaceSnapshotRef | null;
    readonly updatedAt: string;
};

export type NativeProjectRecord = {
    readonly projectId: NativeProjectId;
    readonly rootPath: string;
    readonly createdAt: string;
    readonly updatedAt: string;
};

export type NativeMigrationState =
    | "complete"
    | "failed"
    | "not_started"
    | "running";

export type NativeStorageHealth = "error" | "healthy" | "needs_recovery" | "read_only";

export type NativeCrashRecoveryState = {
    readonly hasPendingRecovery: boolean;
    readonly lastCrashAt: string | null;
};
