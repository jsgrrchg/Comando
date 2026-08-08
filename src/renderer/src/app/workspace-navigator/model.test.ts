import { describe, expect, it } from "vitest";

import type {
    GitWorktreeSummary,
    ProjectSummary,
    WorkspaceSurfacePoolDiagnostics,
} from "@shared/ipc";

import type { WorkspaceCatalogEntry } from "../store/workspace-catalog-store";
import { buildWorkspaceNavigatorModel } from "./model";

describe("workspace navigator model", () => {
    it("applies the persisted project order and appends unknown projects", () => {
        const first = projectFixture("project-a", "Comando");
        const second = projectFixture("project-b", "Testing");
        const addedLater = projectFixture("project-c", "Later");
        const model = buildWorkspaceNavigatorModel({
            catalogEntries: {},
            diagnostics: null,
            projectOrder: [second.id, first.id],
            projects: [first, second, addedLater],
            worktreesByProject: {},
        });

        expect(model.projects.map((project) => project.id)).toEqual([
            "project-b",
            "project-a",
            "project-c",
        ]);
    });

    it("builds primary and worktree rows from registry, inventory, and durable tombstones", () => {
        const project = projectFixture("project-a", "Comando");
        const durableMissing = catalogFixture(
            "project-a",
            "worktree-missing",
            "orphaned",
        );
        const durableFeature = catalogFixture(
            "project-a",
            "worktree-feature",
        );
        const model = buildWorkspaceNavigatorModel({
            catalogEntries: {
                [durableFeature.scopeKey]: durableFeature,
                [durableMissing.scopeKey]: durableMissing,
            },
            diagnostics: null,
            projects: [project],
            worktreesByProject: {
                [project.id]: [
                    worktreeFixture(project.id, null, true, "main"),
                    worktreeFixture(
                        project.id,
                        "worktree-feature",
                        false,
                        "feature/navigation",
                    ),
                ],
            },
        });

        expect(model.projects).toHaveLength(1);
        expect(model.projects[0]?.workspaces.map((workspace) => workspace.label)).toEqual([
            "main",
            "feature/navigation",
            "worktree-missing",
        ]);
        expect(model.projects[0]?.workspaces[2]).toMatchObject({
            isMissing: true,
            isPrimary: false,
        });
    });

    it("projects committed, warming, activity, and failed surface state without exposing residency jargon", () => {
        const project = projectFixture("project-a", "Comando");
        const worktrees = [
            worktreeFixture(project.id, null, true, "main"),
            worktreeFixture(project.id, "warming", false, "warming"),
            worktreeFixture(project.id, "activity", false, "activity"),
            worktreeFixture(project.id, "failed", false, "failed"),
        ];
        const diagnostics: WorkspaceSurfacePoolDiagnostics = {
            ...diagnosticMetadata(),
            activeScopeKey: "project-a::__primary__",
            recentOperations: [],
            surfaces: [
                diagnostic("project-a::__primary__", "active"),
                diagnostic("project-a::warming", "warming"),
                {
                    ...diagnostic("project-a::activity", "warm"),
                    leases: [
                        {
                            acquiredAt: "2026-08-01T00:00:00.000Z",
                            id: "lease-a",
                            kind: "terminal-busy",
                            message: "A terminal is still running.",
                        },
                    ],
                },
                {
                    ...diagnostic("project-a::failed", "error"),
                    error: "Restore failed",
                },
            ],
            updatedAt: "2026-08-01T00:00:00.000Z",
        };
        const model = buildWorkspaceNavigatorModel({
            catalogEntries: {},
            diagnostics,
            projects: [project],
            worktreesByProject: { [project.id]: worktrees },
        });

        expect(model.activeScopeKey).toBe("project-a::__primary__");
        expect(
            model.projects[0]?.workspaces.map((workspace) => workspace.status),
        ).toEqual(["active", "warming", "activity", "error"]);
    });

    it("keeps an inventory error isolated while retaining the primary row", () => {
        const left = projectFixture("project-a", "Comando");
        const right = projectFixture("project-b", "Sandbox");
        const model = buildWorkspaceNavigatorModel({
            catalogEntries: {},
            diagnostics: null,
            inventoryErrorsByProject: {
                [left.id]: "Git inventory failed",
                [right.id]: null,
            },
            projects: [left, right],
            worktreesByProject: {},
        });

        expect(model.projects[0]).toMatchObject({
            inventoryError: "Git inventory failed",
            workspaces: [expect.objectContaining({ isPrimary: true })],
        });
        expect(model.projects[1]?.inventoryError).toBeNull();
    });

    it("falls back to Primary when the original checkout has no branch", () => {
        const project = projectFixture("project-a", "Comando");
        const model = buildWorkspaceNavigatorModel({
            catalogEntries: {},
            diagnostics: null,
            projects: [project],
            worktreesByProject: {
                [project.id]: [
                    worktreeFixture(project.id, null, true, null),
                ],
            },
        });

        expect(model.projects[0]?.workspaces[0]?.label).toBe("Primary");
    });

    it("hides archived projects and exposes resumable deletion tombstones", () => {
        const archived = catalogFixture("project-hidden", null, "archived");
        const project = projectFixture("project-a", "Comando");
        const deleting = catalogFixture("project-a", "worktree-delete");
        const model = buildWorkspaceNavigatorModel({
            catalogEntries: {
                [archived.scopeKey]: archived,
                [deleting.scopeKey]: deleting,
            },
            diagnostics: null,
            pendingDeletionByScopeKey: {
                [deleting.scopeKey]: {
                    checkoutPath: "/projects/project-a-delete",
                    errorCode: "post_checkout:interrupted",
                    forceApproved: true,
                    kind: "delete_worktree",
                    operationId: "delete-a",
                    projectId: project.id,
                    scopeKey: deleting.scopeKey,
                    sessionIds: ["session-a"],
                    startedAt: "2026-08-01T00:00:00.000Z",
                    status: "failed",
                    updatedAt: "2026-08-01T00:01:00.000Z",
                    worktreeId: "worktree-delete",
                },
            },
            projects: [project],
            worktreesByProject: {
                [project.id]: [
                    worktreeFixture(project.id, null, true, "main"),
                    worktreeFixture(
                        project.id,
                        "worktree-delete",
                        false,
                        "feature/delete",
                    ),
                ],
            },
        });

        expect(model.projects.map((candidate) => candidate.id)).toEqual([
            "project-a",
        ]);
        expect(model.projects[0]?.workspaces[1]).toMatchObject({
            deletionOperation: { operationId: "delete-a" },
            status: "deletion-pending",
        });
    });

    it("models a large catalog without creating surface diagnostics", () => {
        const projects = Array.from({ length: 500 }, (_, index) =>
            projectFixture(`project-${index}`, `Project ${index}`),
        );
        const model = buildWorkspaceNavigatorModel({
            catalogEntries: {},
            diagnostics: {
                ...diagnosticMetadata(),
                activeScopeKey: null,
                recentOperations: [],
                surfaces: [],
                updatedAt: "2026-08-01T00:00:00.000Z",
            },
            projects,
            worktreesByProject: {},
        });

        expect(model.projects).toHaveLength(500);
        expect(model.workspaceCount).toBe(500);
        expect(
            model.projects.every(
                (project) => project.workspaces[0]?.isResident === false,
            ),
        ).toBe(true);
    });
});

function projectFixture(id: string, name: string): ProjectSummary {
    return {
        createdAt: "2026-08-01T00:00:00.000Z",
        id,
        lastOpenedAt: null,
        name,
        rootPath: `/projects/${id}`,
        updatedAt: "2026-08-01T00:00:00.000Z",
    };
}

function worktreeFixture(
    projectId: string,
    id: string | null,
    isPrimary: boolean,
    branchName: string | null,
): GitWorktreeSummary {
    return {
        branchName,
        commitSha: "abc123",
        id: id ?? `${projectId}:primary`,
        isBare: false,
        isCurrent: isPrimary,
        isLocked: false,
        isPrimary,
        lockedReason: null,
        projectId,
        rootPath: isPrimary
            ? `/projects/${projectId}`
            : `/projects/${projectId}-${id}`,
        updatedAt: "2026-08-01T00:00:00.000Z",
    };
}

function catalogFixture(
    projectId: string,
    worktreeId: string | null,
    lifecycle: WorkspaceCatalogEntry["lifecycle"] = "active",
): WorkspaceCatalogEntry {
    const scopeKey = `${projectId}::${worktreeId ?? "__primary__"}`;
    return {
        lastActivatedAt: null,
        lifecycle,
        projectId,
        revision: 2,
        runtimeOwnerId: `owner:${scopeKey}`,
        scopeKey,
        source: "durable",
        worktreeId,
    };
}

function diagnostic(
    scopeKey: string,
    state: WorkspaceSurfacePoolDiagnostics["surfaces"][number]["state"],
): WorkspaceSurfacePoolDiagnostics["surfaces"][number] {
    return {
        error: null,
        generation: state === "cold" ? null : `generation:${scopeKey}`,
        lastActivatedAt: null,
        lastReadyDurationMs: null,
        lastTransitionAt: "2026-08-01T00:00:00.000Z",
        leases: [],
        scopeKey,
        state,
    };
}

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
