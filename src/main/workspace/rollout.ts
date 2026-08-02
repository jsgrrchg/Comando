import type {
    NativeWorkspaceMigrationDiagnostics,
    NativeWorkspaceRolloutStatus,
} from "@shared/native-backend";

export interface WorkspaceMigrationTelemetry {
    readonly applicationVersion: string;
    readonly candidateCount: number;
    readonly dualWriteEnabled: boolean;
    readonly migrationApplied: boolean;
    readonly migrationStatus: string;
    readonly normalizationDroppedContextCount: number;
    readonly normalizationRepairedWindowCount: number;
    readonly pendingRecoveryLayoutCount: number;
    readonly prunedLayoutsPossible: boolean;
    readonly rollbackPerformed: boolean;
    readonly rolloutStage: NativeWorkspaceRolloutStatus["stage"];
    readonly schemaVersion: 1;
    readonly sourceWindowCount: number;
    readonly workspaceCount: number;
}

export function createWorkspaceMigrationTelemetry(input: {
    readonly diagnostics: NativeWorkspaceMigrationDiagnostics;
    readonly migrationApplied: boolean;
    readonly rollout: NativeWorkspaceRolloutStatus;
}): WorkspaceMigrationTelemetry {
    const { diagnostics, rollout } = input;
    // Counts and coarse state are sufficient for rollout health without exposing user identity.
    return {
        applicationVersion: diagnostics.applicationVersion,
        candidateCount: diagnostics.candidateCount,
        dualWriteEnabled: rollout.dualWriteEnabled,
        migrationApplied: input.migrationApplied,
        migrationStatus: diagnostics.status,
        normalizationDroppedContextCount:
            diagnostics.normalizationDroppedContextCount,
        normalizationRepairedWindowCount:
            diagnostics.normalizationRepairedWindowCount,
        pendingRecoveryLayoutCount: rollout.pendingRecoveryLayoutCount,
        prunedLayoutsPossible: diagnostics.prunedLayoutsPossible,
        rollbackPerformed: diagnostics.rollbackAt !== null,
        rolloutStage: rollout.stage,
        schemaVersion: 1,
        sourceWindowCount: diagnostics.sourceWindowCount,
        workspaceCount: diagnostics.workspaceCount,
    };
}
