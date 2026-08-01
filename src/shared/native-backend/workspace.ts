import type {
    NativeProjectId,
    NativeWorkspaceId,
    NativeWorkspaceRuntimeOwnerId,
    NativeWorkspaceScopeKey,
    NativeWorktreeId,
} from "./ids";

export type NativeWorkspaceLayoutSnapshot = {
    readonly workspaceId: NativeWorkspaceId | null;
    readonly activePaneId: string;
    readonly rootNode: unknown;
    readonly tabs: readonly unknown[];
    readonly projectId: NativeProjectId | null;
    readonly worktreeId: NativeWorktreeId | null;
};

export type NativeDurableWorkspaceLifecycle =
    | "active"
    | "archived"
    | "orphaned";

export type NativeDurableWorkspaceSummary = {
    readonly scopeKey: NativeWorkspaceScopeKey;
    readonly projectId: NativeProjectId;
    readonly worktreeId: NativeWorktreeId | null;
    readonly runtimeOwnerId: NativeWorkspaceRuntimeOwnerId;
    readonly revision: number;
    readonly lifecycle: NativeDurableWorkspaceLifecycle;
    readonly lastActivatedAt: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
};

export type NativeDurableWorkspace = NativeDurableWorkspaceSummary & {
    readonly layoutSnapshot: Readonly<Record<string, unknown>>;
};

export type NativeDurableWorkspaceCreateInput = {
    readonly scopeKey: NativeWorkspaceScopeKey;
    readonly projectId: NativeProjectId;
    readonly worktreeId: NativeWorktreeId | null;
    readonly layoutSnapshot: Readonly<Record<string, unknown>>;
    readonly lifecycle: NativeDurableWorkspaceLifecycle;
};

export type NativeDurableWorkspaceSaveInput = {
    readonly scopeKey: NativeWorkspaceScopeKey;
    readonly expectedRevision: number;
    readonly layoutSnapshot: Readonly<Record<string, unknown>>;
};

export type NativeDurableWorkspaceRevisionInput = {
    readonly scopeKey: NativeWorkspaceScopeKey;
    readonly expectedRevision: number;
};

export type NativeDurableWorkspaceResetInput =
    NativeDurableWorkspaceSaveInput;

export type NativeAppWorkspaceNavigation = {
    readonly activeScopeKey: NativeWorkspaceScopeKey | null;
    readonly recentScopeKeys: readonly NativeWorkspaceScopeKey[];
    readonly shellSnapshot: Readonly<Record<string, unknown>>;
    readonly revision: number;
    readonly updatedAt: string;
};

export type NativeAppWorkspaceSetActiveInput = {
    readonly activeScopeKey: NativeWorkspaceScopeKey | null;
    readonly expectedRevision: number;
};

export type NativeAppWorkspaceSaveShellInput = {
    readonly expectedRevision: number;
    readonly shellSnapshot: Readonly<Record<string, unknown>>;
};

export type NativeDurableWorkspacePurgeOutput = {
    readonly navigation: NativeAppWorkspaceNavigation;
    readonly purgedScopeKey: NativeWorkspaceScopeKey;
};
