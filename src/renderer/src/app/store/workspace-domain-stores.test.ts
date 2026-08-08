import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceSurfacePoolDiagnostics } from "@shared/ipc";

import {
    refreshDurableWorkspaceCatalog,
    resetWorkspaceCatalogStoreForTests,
    workspaceCatalogStore,
} from "./workspace-catalog-store";

describe("workspace host domain stores", () => {
    beforeEach(() => {
        resetWorkspaceCatalogStoreForTests();
    });

    it("adds registered primary and worktree scopes without eager layouts", () => {
        workspaceCatalogStore.getState().mergeRegistry(
            [
                {
                    createdAt: "2026-07-31T10:00:00.000Z",
                    id: "project-2",
                    lastOpenedAt: null,
                    name: "Project 2",
                    rootPath: "/tmp/project-2",
                    updatedAt: "2026-07-31T10:00:00.000Z",
                },
            ],
            {
                "project-2": [
                    {
                        branchName: "feature/catalog",
                        commitSha: "abc123",
                        id: "worktree-2",
                        isBare: false,
                        isCurrent: false,
                        isLocked: false,
                        isPrimary: false,
                        lockedReason: null,
                        projectId: "project-2",
                        rootPath: "/tmp/project-2-feature",
                        updatedAt: "2026-07-31T10:00:00.000Z",
                    },
                ],
            },
        );

        const entries = workspaceCatalogStore.getState().entriesByScopeKey;
        expect(entries["project-2::__primary__"]).toBeDefined();
        expect(entries["project-2::worktree-2"]).toBeDefined();
        expect(entries["project-2::worktree-2"]).not.toHaveProperty("layout");
    });

    it("stores durable catalog and residency independently", () => {
        workspaceCatalogStore.getState().replaceDurable([
            {
                createdAt: "2026-08-01T00:00:00.000Z",
                lastActivatedAt: "2026-08-01T00:00:00.000Z",
                lifecycle: "active",
                projectId: "project-1",
                revision: 3,
                runtimeOwnerId: "owner-1",
                scopeKey: "project-1::__primary__",
                updatedAt: "2026-08-01T00:00:00.000Z",
                worktreeId: null,
            },
        ]);
        workspaceCatalogStore.getState().setSurfaceDiagnostics({
            ...diagnosticMetadata(),
            activeScopeKey: "project-1::__primary__",
            recentOperations: [],
            surfaces: [],
            updatedAt: "2026-08-01T00:00:00.000Z",
        });

        expect(
            workspaceCatalogStore.getState().entriesByScopeKey[
                "project-1::__primary__"
            ],
        ).toMatchObject({ revision: 3, source: "durable" });
        expect(
            workspaceCatalogStore.getState().surfaceDiagnostics,
        ).toMatchObject({ activeScopeKey: "project-1::__primary__" });
    });

    it("refreshes the durable catalog as one host operation", async () => {
        await refreshDurableWorkspaceCatalog({
            getWorkspaceCatalog: vi.fn(() =>
                Promise.resolve({
                    navigation: {
                        activeScopeKey: null,
                        recentScopeKeys: [],
                        revision: 8,
                        shellSnapshot: {},
                        updatedAt: "2026-08-01T00:00:00.000Z",
                    },
                    pendingDeletions: [],
                    workspaces: [],
                }),
            ),
            getWorkspaceSurfaceDiagnostics: vi.fn(() =>
                Promise.resolve({
                    ...diagnosticMetadata(),
                    activeScopeKey: null,
                    recentOperations: [],
                    surfaces: [],
                    updatedAt: "2026-08-01T00:00:00.000Z",
                }),
            ),
        });

        expect(workspaceCatalogStore.getState().status).toBe("ready");
    });

    it("shows only post-checkout deletion journals as cleanup tombstones", () => {
        const base = {
            checkoutPath: "/tmp/worktree",
            forceApproved: false,
            kind: "delete_worktree" as const,
            projectId: "project-1",
            sessionIds: [] as readonly string[],
            startedAt: "2026-08-01T00:00:00.000Z",
            status: "failed" as const,
            updatedAt: "2026-08-01T00:01:00.000Z",
            worktreeId: "worktree-1",
        };
        workspaceCatalogStore.getState().setPendingDeletions([
            {
                ...base,
                errorCode: "pre_checkout:git failed",
                operationId: "before-checkout",
                scopeKey: "project-1::before",
            },
            {
                ...base,
                errorCode: "post_checkout:filesystem failed",
                operationId: "after-checkout",
                scopeKey: "project-1::after",
            },
        ]);

        expect(
            Object.keys(
                workspaceCatalogStore.getState().pendingDeletionByScopeKey,
            ),
        ).toEqual(["project-1::after"]);
    });
});

function diagnosticMetadata(): Pick<
    WorkspaceSurfacePoolDiagnostics,
    "environment" | "performance"
> {
    return {
        environment: {
            energySource: "external-power",
            platform: "darwin",
            totalMemoryMb: 16_384,
        },
        performance: {
            boundsUpdates: 0,
            cacheHits: 0,
            cacheMisses: 0,
            catalogMaxSyncDurationMs: 0,
            catalogPeakScopeCount: 0,
            catalogScopeCount: 0,
            catalogSyncDurationMs: 0,
            catalogSyncs: 0,
            failures: 0,
            hibernations: 0,
            hibernationsAvoided: 0,
            leaseReports: 0,
            lifecycleTransitions: 0,
            memorySampledAt: null,
            memorySamples: [],
            rendererCreates: 0,
            rendererDestroys: 0,
            resyncFailures: 0,
            resyncs: 0,
        },
    };
}
