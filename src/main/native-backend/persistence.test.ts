import { describe, expect, it, vi } from "vitest";

import {
    NativePersistenceGateway,
    type NativeBackendRequester,
} from "./persistence";

describe("NativePersistenceGateway", () => {
    it("opens native storage with the expected command", async () => {
        const requestMock = vi.fn(
            (command: string, args?: Record<string, unknown>) => {
                void command;
                void args;
                return Promise.resolve({
                    metadataReady: true,
                    opened: true,
                    schemaVersion: "1",
                    storageMode: "sqlite-current",
                });
            },
        );
        const request: NativeBackendRequester["request"] = async (...args) =>
            (await requestMock(...args)) as never;
        const gateway = new NativePersistenceGateway({
            request,
        } satisfies NativeBackendRequester);

        await expect(
            gateway.openStore({
                appDataDir: "/tmp/app",
                databasePath: "/tmp/app/comando.sqlite3",
                mode: "shadow",
            }),
        ).resolves.toMatchObject({ opened: true });

        expect(requestMock).toHaveBeenCalledWith("persistence_open_store", {
            appDataDir: "/tmp/app",
            databasePath: "/tmp/app/comando.sqlite3",
            mode: "shadow",
        });
    });

    it("loads storage health", async () => {
        const requestMock = vi.fn(
            (command: string, args?: Record<string, unknown>) => {
                void command;
                void args;
                return Promise.resolve({
                    checkedAt: "2026-06-20T00:00:00.000Z",
                    databaseReachable: true,
                    metadataReady: true,
                    opened: true,
                    projectCount: 2,
                    schemaCompatible: true,
                    worktreeCount: 3,
                });
            },
        );
        const request: NativeBackendRequester["request"] = async (...args) =>
            (await requestMock(...args)) as never;
        const gateway = new NativePersistenceGateway({
            request,
        });

        await expect(gateway.getStorageHealth()).resolves.toMatchObject({
            projectCount: 2,
            worktreeCount: 3,
        });
    });

    it("routes and validates durable workspace repository commands", async () => {
        const workspace = durableWorkspaceFixture();
        const requestMock = vi.fn(
            (command: string, args?: Record<string, unknown>) => {
                void args;
                if (command === "durable_workspace_list") {
                    const summary = { ...workspace };
                    delete summary.layoutSnapshot;
                    return Promise.resolve({ workspaces: [summary] });
                }
                if (command === "durable_workspace_load") {
                    return Promise.resolve(workspace);
                }
                return Promise.resolve(workspace);
            },
        );
        const request: NativeBackendRequester["request"] = async (...args) =>
            (await requestMock(...args)) as never;
        const gateway = new NativePersistenceGateway({ request });

        await expect(gateway.listDurableWorkspaces()).resolves.toEqual([
            expect.objectContaining({
                revision: 3,
                scopeKey: "project-a::__primary__",
            }),
        ]);
        await expect(
            gateway.loadDurableWorkspace("project-a::__primary__"),
        ).resolves.toEqual(workspace);
        await expect(
            gateway.createDurableWorkspace({
                layoutSnapshot: { tabs: [] },
                lifecycle: "active",
                projectId: "project-a",
                scopeKey: "project-a::__primary__",
                worktreeId: null,
            }),
        ).resolves.toEqual(workspace);
        await gateway.saveDurableWorkspace({
            expectedRevision: 3,
            layoutSnapshot: { tabs: ["chat-b"] },
            scopeKey: "project-a::__primary__",
        });
        await gateway.archiveDurableWorkspace({
            expectedRevision: 3,
            scopeKey: "project-a::__primary__",
        });
        await gateway.resetDurableWorkspace({
            expectedRevision: 3,
            layoutSnapshot: { tabs: [] },
            scopeKey: "project-a::__primary__",
        });

        expect(requestMock).toHaveBeenCalledWith("durable_workspace_load", {
            scopeKey: "project-a::__primary__",
        });
        expect(requestMock).toHaveBeenCalledWith("durable_workspace_save", {
            expectedRevision: 3,
            layoutSnapshot: { tabs: ["chat-b"] },
            scopeKey: "project-a::__primary__",
        });
        expect(requestMock).toHaveBeenCalledWith("durable_workspace_archive", {
            expectedRevision: 3,
            scopeKey: "project-a::__primary__",
        });
    });

    it("routes singleton navigation and purge responses", async () => {
        const navigation = navigationFixture();
        const requestMock = vi.fn(
            (command: string, args?: Record<string, unknown>) => {
                void args;
                if (command === "durable_workspace_purge") {
                    return Promise.resolve({
                        navigation,
                        purgedScopeKey: "project-a::__primary__",
                    });
                }
                return Promise.resolve(navigation);
            },
        );
        const request: NativeBackendRequester["request"] = async (...args) =>
            (await requestMock(...args)) as never;
        const gateway = new NativePersistenceGateway({ request });

        await expect(gateway.getWorkspaceNavigation()).resolves.toEqual(
            navigation,
        );
        await gateway.setActiveWorkspace({
            activeScopeKey: "project-a::__primary__",
            expectedRevision: 4,
        });
        await gateway.saveWorkspaceShell({
            expectedRevision: 4,
            shellSnapshot: { leftCollapsed: true },
        });
        await expect(
            gateway.purgeDurableWorkspace({
                expectedRevision: 3,
                scopeKey: "project-a::__primary__",
            }),
        ).resolves.toEqual({
            navigation,
            purgedScopeKey: "project-a::__primary__",
        });

        expect(requestMock).toHaveBeenCalledWith(
            "workspace_navigation_set_active",
            {
                activeScopeKey: "project-a::__primary__",
                expectedRevision: 4,
            },
        );
        expect(requestMock).toHaveBeenCalledWith(
            "workspace_navigation_save_shell",
            {
                expectedRevision: 4,
                shellSnapshot: { leftCollapsed: true },
            },
        );
    });

    it("rejects malformed durable workspace revisions", async () => {
        const request: NativeBackendRequester["request"] = () =>
            Promise.resolve(
                durableWorkspaceFixture({ revision: -1 }) as never,
            );
        const gateway = new NativePersistenceGateway({ request });

        await expect(
            gateway.loadDurableWorkspace("project-a::__primary__"),
        ).rejects.toThrow("non-negative safe integer");
    });

    it("routes reassociation and deletion journal commands", async () => {
        const workspace = durableWorkspaceFixture();
        const operation = deletionOperationFixture();
        const requestMock = vi.fn(
            (command: string, args?: Record<string, unknown>) => {
                void args;
                if (command === "workspace_deletion_list_incomplete") {
                    return Promise.resolve({ operations: [operation] });
                }
                if (command === "workspace_forget_session") {
                    return Promise.resolve(2);
                }
                if (command.startsWith("workspace_deletion_")) {
                    return Promise.resolve(operation);
                }
                return Promise.resolve(workspace);
            },
        );
        const request: NativeBackendRequester["request"] = async (...args) =>
            (await requestMock(...args)) as never;
        const gateway = new NativePersistenceGateway({ request });

        await expect(
            gateway.reassociateWorkspace({
                expectedRevision: 2,
                projectId: "project-a",
                sourceScopeKey: "project-a::missing",
                targetScopeKey: "project-a::worktree-a",
                targetWorktreeId: "worktree-a",
            }),
        ).resolves.toEqual(workspace);
        await expect(
            gateway.forgetWorkspaceSessionReferences("session-a"),
        ).resolves.toBe(2);
        await expect(
            gateway.beginWorkspaceDeletion({
                checkoutPath: "/tmp/worktree-a",
                forceApproved: false,
                kind: "delete_worktree",
                operationId: "delete-a",
                projectId: "project-a",
                scopeKey: "project-a::worktree-a",
                sessionIds: ["session-a"],
                worktreeId: "worktree-a",
            }),
        ).resolves.toEqual(operation);
        await expect(gateway.listIncompleteWorkspaceDeletions()).resolves.toEqual([
            operation,
        ]);
        await expect(
            gateway.completeWorkspaceDeletion("delete-a"),
        ).resolves.toEqual(operation);
    });

});

function durableWorkspaceFixture(
    overrides: Record<string, unknown> = {},
): Record<string, unknown> {
    return {
        createdAt: "2026-07-31T00:00:00Z",
        lastActivatedAt: "2026-07-31T00:01:00Z",
        layoutSnapshot: { tabs: ["chat-a"] },
        lifecycle: "active",
        projectId: "project-a",
        revision: 3,
        runtimeOwnerId: "workspace-runtime-a",
        scopeKey: "project-a::__primary__",
        updatedAt: "2026-07-31T00:02:00Z",
        worktreeId: null,
        ...overrides,
    };
}

function navigationFixture(): Record<string, unknown> {
    return {
        activeScopeKey: "project-a::__primary__",
        recentScopeKeys: ["project-a::__primary__"],
        revision: 4,
        shellSnapshot: { leftCollapsed: false },
        updatedAt: "2026-07-31T00:02:00Z",
    };
}

function deletionOperationFixture(): Record<string, unknown> {
    return {
        checkoutPath: "/tmp/worktree-a",
        errorCode: null,
        forceApproved: false,
        kind: "delete_worktree",
        operationId: "delete-a",
        projectId: "project-a",
        scopeKey: "project-a::worktree-a",
        sessionIds: ["session-a"],
        startedAt: "2026-08-01T00:00:00Z",
        status: "checkout_deleted",
        updatedAt: "2026-08-01T00:01:00Z",
        worktreeId: "worktree-a",
    };
}
