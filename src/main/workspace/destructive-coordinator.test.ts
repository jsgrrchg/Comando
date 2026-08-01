import { describe, expect, it, vi } from "vitest";

import type { AiService } from "@main/ai/service";
import type { GitGateway } from "@main/git/service";
import type { NativePersistenceGateway } from "@main/native-backend/persistence";
import type { ProjectService } from "@main/projects/service";
import type { TerminalGateway } from "@main/terminals/service";
import type {
    NativeWorkspaceDeletionJournalEntry,
    NativeWorkspaceDeletionUpdateInput,
} from "@shared/native-backend";
import type { WorkspaceSurfaceManager } from "./surface-manager";
import { WorkspaceDestructiveCoordinator } from "./destructive-coordinator";

describe("WorkspaceDestructiveCoordinator", () => {
    it("allows deleting a registry-only worktree with no saved layout", async () => {
        const coordinator = createCoordinator({
            persistence: {
                listDurableWorkspaces: vi.fn().mockResolvedValue([]),
            },
        });

        await expect(
            coordinator.preflightDeleteWorktree("window-a", deleteInput()),
        ).resolves.toMatchObject({
            blockers: [],
            inventory: { workspaceLayoutCount: 0 },
        });
    });

    it("converts an interrupted pre-checkout journal into a safe retry", async () => {
        const operation = deletionOperation({
            checkoutPath: process.cwd(),
            status: "pending",
        });
        const updateWorkspaceDeletion = vi.fn().mockResolvedValue({
            ...operation,
            errorCode: "pre_checkout:interrupted before checkout deletion",
            status: "failed",
        });
        const completeWorkspaceDeletion = vi.fn();
        const coordinator = createCoordinator({
            persistence: {
                completeWorkspaceDeletion,
                listIncompleteWorkspaceDeletions: vi
                    .fn()
                    .mockResolvedValue([operation]),
                updateWorkspaceDeletion,
            },
        });

        await coordinator.resumePendingOperations();

        expect(updateWorkspaceDeletion).toHaveBeenCalledWith({
            errorCode:
                "pre_checkout:interrupted before checkout deletion",
            operationId: "delete-a",
            status: "failed",
        });
        expect(completeWorkspaceDeletion).not.toHaveBeenCalled();
    });

    it("resumes a post-checkout purge from journaled session ids", async () => {
        const operation = deletionOperation({
            errorCode: "post_checkout:interrupted",
            status: "failed",
        });
        const deleteSession = vi.fn().mockResolvedValue(undefined);
        const listSessionHistory = vi.fn().mockResolvedValue([
            { parentSessionId: null, sessionId: "session-a" },
            { parentSessionId: "session-a", sessionId: "session-child" },
            { parentSessionId: null, sessionId: "sibling" },
        ]);
        const updateWorkspaceDeletion = vi.fn().mockResolvedValue(operation);
        const completeWorkspaceDeletion = vi.fn().mockResolvedValue({
            ...operation,
            status: "completed",
        });
        const coordinator = createCoordinator({
            aiService: { deleteSession, listSessionHistory },
            persistence: {
                completeWorkspaceDeletion,
                listIncompleteWorkspaceDeletions: vi
                    .fn()
                    .mockResolvedValue([operation]),
                updateWorkspaceDeletion,
            },
        });

        await expect(
            coordinator.deleteWorktree("window-a", deleteInput()),
        ).resolves.toEqual({ operationId: "delete-a", status: "completed" });

        expect(listSessionHistory).toHaveBeenCalledWith({
            limit: null,
            projectId: "project-a",
        });
        expect(deleteSession).toHaveBeenCalledTimes(1);
        expect(deleteSession).toHaveBeenCalledWith("session-a");
        expect(updateWorkspaceDeletion).toHaveBeenCalledWith({
            errorCode: null,
            operationId: "delete-a",
            status: "purging",
        });
        expect(completeWorkspaceDeletion).toHaveBeenCalledWith("delete-a");
    });

    it("records a pre-checkout failure without starting app-data purge", async () => {
        const operation = deletionOperation({ status: "pending" });
        const removeWorktree = vi
            .fn()
            .mockRejectedValue(new Error("git remove failed"));
        const updateWorkspaceDeletion = vi
            .fn<
                (
                    input: NativeWorkspaceDeletionUpdateInput,
                ) => Promise<NativeWorkspaceDeletionJournalEntry>
            >()
            .mockResolvedValue({
                ...operation,
                errorCode: "pre_checkout:git remove failed",
                status: "failed",
            });
        const completeWorkspaceDeletion = vi.fn();
        const coordinator = createCoordinator({
            gitService: {
                listWorktrees: vi.fn().mockResolvedValue([
                    {
                        canonicalPath: process.cwd(),
                        locked: false,
                        lockReason: null,
                    },
                ]),
                removeWorktree,
            },
            persistence: {
                beginWorkspaceDeletion: vi.fn().mockResolvedValue(operation),
                completeWorkspaceDeletion,
                listDurableWorkspaces: vi.fn().mockResolvedValue([
                    durableWorkspace(),
                ]),
                listIncompleteWorkspaceDeletions: vi.fn().mockResolvedValue([]),
                listWorkspaceRecoveryLayouts: vi.fn().mockResolvedValue([]),
                updateWorkspaceDeletion,
            },
            projectService: {
                listProjectWorktrees: vi.fn().mockReturnValue([
                    {
                        id: "worktree-a",
                        isPrimary: false,
                        projectId: "project-a",
                        rootPath: process.cwd(),
                    },
                ]),
            },
        });

        await expect(
            coordinator.deleteWorktree("window-a", deleteInput()),
        ).rejects.toThrow("git remove failed");

        const operationId = updateWorkspaceDeletion.mock.calls.at(-1)?.[0]
            .operationId;
        expect(operationId).toEqual(expect.any(String));
        expect(updateWorkspaceDeletion).toHaveBeenLastCalledWith({
            errorCode: "pre_checkout:git remove failed",
            operationId,
            status: "failed",
        });
        expect(completeWorkspaceDeletion).not.toHaveBeenCalled();
    });
});

function createCoordinator(overrides: {
    readonly aiService?: Record<string, unknown>;
    readonly gitService?: Record<string, unknown>;
    readonly persistence?: Record<string, unknown>;
    readonly projectService?: Record<string, unknown>;
}) {
    const aiService = {
        closeSession: vi.fn().mockResolvedValue(undefined),
        deleteSession: vi.fn().mockResolvedValue(undefined),
        listSessionHistory: vi.fn().mockResolvedValue([]),
        ...overrides.aiService,
    } as unknown as AiService;
    const gitService = {
        getStatus: vi.fn().mockResolvedValue({ entries: [], isClean: true }),
        listWorktrees: vi.fn().mockResolvedValue([
            {
                canonicalPath: "/tmp/project-feature",
                locked: false,
                lockReason: null,
            },
        ]),
        removeWorktree: vi.fn(),
        resolveRepository: vi.fn().mockResolvedValue({ gitDirPath: null }),
        ...overrides.gitService,
    } as unknown as GitGateway;
    const durableWorkspaceRepository = {
        beginWorkspaceDeletion: vi.fn(),
        completeWorkspaceDeletion: vi.fn(),
        listDurableWorkspaces: vi.fn().mockResolvedValue([durableWorkspace()]),
        listIncompleteWorkspaceDeletions: vi.fn().mockResolvedValue([]),
        listWorkspaceRecoveryLayouts: vi.fn().mockResolvedValue([]),
        updateWorkspaceDeletion: vi.fn(),
        ...overrides.persistence,
    } as unknown as NativePersistenceGateway;
    const projectService = {
        clearProjectAppData: vi.fn().mockResolvedValue(undefined),
        getProjectRootPath: vi.fn().mockReturnValue("/tmp/project"),
        listProjectWorktrees: vi.fn().mockReturnValue([
            {
                id: "worktree-a",
                isPrimary: false,
                projectId: "project-a",
                rootPath: "/tmp/project-feature",
            },
        ]),
        syncProjectWorktrees: vi.fn().mockResolvedValue([]),
        ...overrides.projectService,
    } as unknown as ProjectService;
    const surfaceManager = {
        closeWorkspaceSurface: vi
            .fn()
            .mockResolvedValue({ status: "not-resident" }),
        getSurfaceDiagnostics: vi.fn().mockReturnValue({ surfaces: [] }),
    } as unknown as WorkspaceSurfaceManager;
    const terminalService = {
        closeOwnedByWindow: vi.fn(),
    } as unknown as TerminalGateway;
    return new WorkspaceDestructiveCoordinator({
        aiService,
        durableWorkspaceRepository,
        gitService,
        projectService,
        surfaceManager,
        terminalService,
    });
}

function deleteInput() {
    return {
        forceApproved: false,
        projectId: "project-a",
        scopeKey: "project-a::worktree-a",
        worktreeId: "worktree-a",
    };
}

function deletionOperation(
    overrides: Partial<NativeWorkspaceDeletionJournalEntry> = {},
): NativeWorkspaceDeletionJournalEntry {
    return { ...deletionOperationFixture(), ...overrides };
}

function deletionOperationFixture(): NativeWorkspaceDeletionJournalEntry {
    return {
        checkoutPath: "/tmp/project-feature",
        errorCode: null as string | null,
        forceApproved: false,
        kind: "delete_worktree" as const,
        operationId: "delete-a",
        projectId: "project-a",
        scopeKey: "project-a::worktree-a",
        sessionIds: ["session-a", "session-child"],
        startedAt: "2026-08-01T00:00:00Z",
        status: "checkout_deleted",
        updatedAt: "2026-08-01T00:01:00Z",
        worktreeId: "worktree-a",
    };
}

function durableWorkspace() {
    return {
        lifecycle: "active" as const,
        projectId: "project-a",
        revision: 2,
        runtimeOwnerId: "owner-a",
        scopeKey: "project-a::worktree-a",
        worktreeId: "worktree-a",
    };
}
