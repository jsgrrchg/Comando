import { describe, expect, it } from "vitest";

import type {
    NativeWorkspaceMigrationDiagnostics,
    NativeWorkspaceRolloutStatus,
} from "@shared/native-backend";

import { createWorkspaceMigrationTelemetry } from "./rollout";

describe("workspace rollout telemetry", () => {
    it("exports only coarse local migration health without identifiers or content", () => {
        const telemetry = createWorkspaceMigrationTelemetry({
            diagnostics: diagnosticsFixture(),
            migrationApplied: true,
            rollout: rolloutFixture(),
        });
        const serialized = JSON.stringify(telemetry);

        expect(telemetry).toMatchObject({
            migrationApplied: true,
            pendingRecoveryLayoutCount: 2,
            rolloutStage: "stable_dual_write",
            workspaceCount: 4,
        });
        for (const sensitive of [
            "project-private",
            "window-private",
            "backup-private",
            "checksum-private",
            "draft-private",
        ]) {
            expect(serialized).not.toContain(sensitive);
        }
    });
});

function diagnosticsFixture(): NativeWorkspaceMigrationDiagnostics {
    return {
        activeScopeKey: "project-private::__primary__",
        activeSourceWindowId: "window-private",
        applicationVersion: "0.2.1",
        candidateCount: 5,
        completedAt: "2026-08-01T00:00:01Z",
        historicalLayoutCap: 30,
        layoutSources: [
            {
                scopeKey: "project-private::__primary__",
                sourceWindowId: "window-private",
            },
        ],
        limitation: "draft-private",
        migrationId: "migration-private",
        normalizationDroppedContextCount: 1,
        normalizationRepairedWindowCount: 1,
        prunedLayoutsPossible: true,
        recoveryLayoutCount: 2,
        recoverySources: [
            {
                scopeKey: "project-private::__primary__",
                snapshotHash: "checksum-private",
                sourceWindowId: "window-private",
            },
        ],
        rollbackAt: null,
        sourceBackupRef: "backup-private",
        sourceChecksum: "checksum-private",
        sourceWindowCount: 3,
        startedAt: "2026-08-01T00:00:00Z",
        status: "complete",
        workspaceCount: 4,
    };
}

function rolloutFixture(): NativeWorkspaceRolloutStatus {
    return {
        dualWriteEnabled: true,
        legacyCleanupCompletedAt: null,
        legacyRetentionUntil: "2026-11-01T00:00:00Z",
        pendingRecoveryLayoutCount: 2,
        rollbackAvailable: true,
        sourceBackupRetained: true,
        stableReleaseVerifiedAt: "2026-08-01T00:00:02Z",
        stableReleaseVersion: "0.2.1",
        stage: "stable_dual_write",
        v4OnlySince: null,
    };
}
