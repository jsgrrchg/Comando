import type { NativeProjectId, NativeWorkspaceId, NativeWorktreeId } from "./ids";

export type NativePersistenceMode = "shadow" | "write";

export type NativePersistenceOpenStoreInput = {
    readonly appDataDir: string;
    readonly databasePath: string;
    readonly mode: NativePersistenceMode;
};

export type NativePersistenceOpenStoreOutput = {
    readonly opened: boolean;
    readonly schemaVersion: string;
    readonly storageMode: string;
    readonly metadataReady: boolean;
};

export type NativePersistenceStorageHealth = {
    readonly opened: boolean;
    readonly databaseReachable: boolean;
    readonly schemaCompatible: boolean;
    readonly metadataReady: boolean;
    readonly projectCount: number;
    readonly worktreeCount: number;
    readonly checkedAt: string;
};

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
