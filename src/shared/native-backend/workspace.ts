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

export type NativeWorkspaceDeletionKind =
    | "clear_project_data"
    | "delete_worktree";

export type NativeWorkspaceDeletionStatus =
    | "checkout_deleted"
    | "completed"
    | "failed"
    | "pending"
    | "purging";

export type NativeWorkspaceDeletionJournalEntry = {
    readonly operationId: string;
    readonly kind: NativeWorkspaceDeletionKind;
    readonly scopeKey: NativeWorkspaceScopeKey;
    readonly projectId: NativeProjectId;
    readonly worktreeId: NativeWorktreeId | null;
    readonly checkoutPath: string | null;
    readonly status: NativeWorkspaceDeletionStatus;
    readonly forceApproved: boolean;
    readonly sessionIds: readonly string[];
    readonly errorCode: string | null;
    readonly startedAt: string;
    readonly updatedAt: string;
};

export type NativeWorkspaceDeletionBeginInput = {
    readonly operationId: string;
    readonly kind: NativeWorkspaceDeletionKind;
    readonly scopeKey: NativeWorkspaceScopeKey;
    readonly projectId: NativeProjectId;
    readonly worktreeId: NativeWorktreeId | null;
    readonly checkoutPath: string | null;
    readonly forceApproved: boolean;
    readonly sessionIds: readonly string[];
};

export type NativeWorkspaceDeletionUpdateInput = {
    readonly operationId: string;
    readonly status: NativeWorkspaceDeletionStatus;
    readonly errorCode: string | null;
};

export type NativeWorkspaceRecoveryLayoutSummary = {
    readonly id: string;
    readonly scopeKey: NativeWorkspaceScopeKey;
    readonly sourceWindowId: string | null;
    readonly sourceWorkspaceId: string | null;
    readonly sourceRevision: number;
    readonly sourceUpdatedAt: string;
    readonly snapshotHash: string;
    readonly createdAt: string;
};

export type NativeWorkspaceRecoveryApplyInput = {
    readonly recoveryId: string;
    readonly scopeKey: NativeWorkspaceScopeKey;
    readonly expectedRevision: number;
};

export type NativeWorkspaceRecoveryDiscardInput = {
    readonly recoveryId: string;
    readonly scopeKey: NativeWorkspaceScopeKey;
};

export type NativeWorkspaceReassociateInput = {
    readonly sourceScopeKey: NativeWorkspaceScopeKey;
    readonly targetScopeKey: NativeWorkspaceScopeKey;
    readonly projectId: NativeProjectId;
    readonly targetWorktreeId: NativeWorktreeId;
    readonly expectedRevision: number;
};

export type NativeLegacyWorkspaceContext = {
    readonly scopeKey: NativeWorkspaceScopeKey;
    readonly projectId: NativeProjectId;
    readonly worktreeId: NativeWorktreeId | null;
    readonly lastActivatedAt: string;
    readonly layoutSnapshot: {
        readonly activePaneId: string;
        readonly rootNode: unknown;
        readonly tabs: readonly unknown[];
    };
};

export type NativeLegacyWorkspaceWindow = {
    readonly windowId: string;
    readonly workspaceId: NativeWorkspaceId | null;
    readonly isOpen: boolean;
    readonly restoreRevision: number;
    readonly restoreUpdatedAt: string;
    readonly activeContextKey: NativeWorkspaceScopeKey | null;
    readonly openContextKeys: readonly NativeWorkspaceScopeKey[];
    readonly contexts: readonly NativeLegacyWorkspaceContext[];
    readonly shellSnapshot: Readonly<Record<string, unknown>>;
    readonly projectionTemplate: Readonly<object>;
};

export type NativeWorkspaceMigrationRunInput = {
    readonly applicationVersion: string;
    readonly historicalLayoutCap: number;
    readonly normalizationDroppedContextCount: number;
    readonly normalizationRepairedWindowCount: number;
    readonly sourceBackup: Readonly<object>;
    readonly windows: readonly NativeLegacyWorkspaceWindow[];
};

export type NativeWorkspaceMigrationLayoutSource = {
    readonly scopeKey: NativeWorkspaceScopeKey;
    readonly sourceWindowId: string;
};

export type NativeWorkspaceMigrationRecoverySource = {
    readonly scopeKey: NativeWorkspaceScopeKey;
    readonly sourceWindowId: string;
    readonly snapshotHash: string;
};

export type NativeWorkspaceMigrationDiagnostics = {
    readonly migrationId: string;
    readonly status: string;
    readonly sourceChecksum: string;
    readonly sourceBackupRef: string;
    readonly applicationVersion: string;
    readonly sourceWindowCount: number;
    readonly candidateCount: number;
    readonly workspaceCount: number;
    readonly recoveryLayoutCount: number;
    readonly normalizationDroppedContextCount: number;
    readonly normalizationRepairedWindowCount: number;
    readonly activeScopeKey: NativeWorkspaceScopeKey | null;
    readonly activeSourceWindowId: string | null;
    readonly layoutSources: readonly NativeWorkspaceMigrationLayoutSource[];
    readonly recoverySources: readonly NativeWorkspaceMigrationRecoverySource[];
    readonly historicalLayoutCap: number;
    readonly prunedLayoutsPossible: boolean;
    readonly limitation: string;
    readonly startedAt: string;
    readonly completedAt: string | null;
    readonly rollbackAt: string | null;
};

export type NativeWorkspaceMigrationRunOutput = {
    readonly applied: boolean;
    readonly diagnostics: NativeWorkspaceMigrationDiagnostics;
    readonly navigation: NativeAppWorkspaceNavigation;
};

export type NativeWorkspaceMigrationExportOutput = {
    readonly diagnostics: NativeWorkspaceMigrationDiagnostics;
    readonly recoveryLayouts: readonly NativeWorkspaceMigrationRecoverySource[];
    readonly v3Projection: readonly unknown[];
};

export type NativeWorkspaceMigrationRollbackOutput = {
    readonly diagnostics: NativeWorkspaceMigrationDiagnostics;
    readonly v3Projection: readonly unknown[];
};

export type NativeWorkspaceRolloutStage =
    | "internal"
    | "stable_dual_write"
    | "v4_only"
    | "legacy_retired";

export type NativeWorkspaceRolloutStatus = {
    readonly stage: NativeWorkspaceRolloutStage;
    readonly dualWriteEnabled: boolean;
    readonly stableReleaseVersion: string | null;
    readonly stableReleaseVerifiedAt: string | null;
    readonly legacyRetentionUntil: string | null;
    readonly v4OnlySince: string | null;
    readonly legacyCleanupCompletedAt: string | null;
    readonly pendingRecoveryLayoutCount: number;
    readonly rollbackAvailable: boolean;
    readonly sourceBackupRetained: boolean;
};

export type NativeWorkspaceMarkStableInput = {
    readonly applicationVersion: string;
    readonly retentionDays: number;
};

export type NativeWorkspaceDisableLegacyWritesInput = {
    readonly applicationVersion: string;
};

export type NativeWorkspaceCleanupLegacyInput = {
    readonly consent: boolean;
};
