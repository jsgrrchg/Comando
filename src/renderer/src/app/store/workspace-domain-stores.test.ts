import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceNavigationSnapshot } from "@shared/ipc";

import {
    appNavigationStore,
    resetAppNavigationStoreForTests,
} from "./app-navigation-store";
import {
    refreshDurableWorkspaceCatalog,
    resetWorkspaceCatalogStoreForTests,
    workspaceCatalogStore,
} from "./workspace-catalog-store";

const snapshot: WorkspaceNavigationSnapshot = {
    activeContextKey: "project-1::__primary__",
    contexts: [
        {
            key: "project-1::__primary__",
            lastActivatedAt: "2026-07-31T12:00:00.000Z",
            projectId: "project-1",
            workspace: {
                activePaneId: "pane-root",
                rootNode: {
                    activeTabId: "chat-1",
                    id: "pane-root",
                    tabIds: ["chat-1"],
                    type: "pane",
                },
                tabs: [
                    {
                        createdAt: "2026-07-31T12:00:00.000Z",
                        draft: "preserved in layout storage only",
                        id: "chat-1",
                        kind: "chat",
                        projectId: "project-1",
                        runtimeId: "codex",
                        sessionId: "session-1",
                        title: "Chat",
                        worktreeId: null,
                    },
                ],
            },
            worktreeId: "project-1:primary",
        },
    ],
    openContextKeys: ["project-1::__primary__"],
    version: 3,
};

describe("workspace host domain stores", () => {
    beforeEach(() => {
        resetWorkspaceCatalogStoreForTests();
        resetAppNavigationStoreForTests();
    });

    it("projects v3 metadata without materializing layouts or runtime tabs", () => {
        workspaceCatalogStore.getState().replaceLegacy(snapshot);

        const entry =
            workspaceCatalogStore.getState().entriesByScopeKey[
                "project-1::__primary__"
            ];
        expect(entry).toMatchObject({
            projectId: "project-1",
            source: "legacy-v3",
            worktreeId: null,
        });
        expect(entry).not.toHaveProperty("layout");
        expect(entry).not.toHaveProperty("tabsById");
        expect(entry).not.toHaveProperty("resident");
    });

    it("keeps singleton navigation independent from catalog and layout", () => {
        appNavigationStore.getState().replaceLegacy(snapshot);

        expect(appNavigationStore.getState()).toMatchObject({
            activeScopeKey: "project-1::__primary__",
            recentScopeKeys: ["project-1::__primary__"],
            source: "legacy-v3",
            status: "ready",
        });
        expect(appNavigationStore.getState()).not.toHaveProperty("contexts");
        expect(appNavigationStore.getState()).not.toHaveProperty("layout");
    });

    it("adds registered primary and worktree scopes without eager layouts", () => {
        workspaceCatalogStore.getState().replaceLegacy(snapshot);
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

    it("stores durable catalog, recovery, and residency independently", () => {
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
        workspaceCatalogStore.getState().setRecoveryLayouts([
            {
                scopeKey: "project-1::__primary__",
                snapshotHash: "hash-a",
                sourceWindowId: "legacy-window",
            },
        ]);
        workspaceCatalogStore.getState().setSurfaceDiagnostics({
            activeScopeKey: "project-1::__primary__",
            maxWarmSurfaces: 4,
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
            workspaceCatalogStore.getState().recoveryByScopeKey[
                "project-1::__primary__"
            ],
        ).toHaveLength(1);
        expect(
            workspaceCatalogStore.getState().surfaceDiagnostics,
        ).toMatchObject({ activeScopeKey: "project-1::__primary__" });
    });

    it("refreshes the durable catalog and singleton navigation as one host operation", async () => {
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
                    recoveryLayouts: [],
                    workspaces: [],
                }),
            ),
            getWorkspaceSurfaceDiagnostics: vi.fn(() =>
                Promise.resolve({
                    activeScopeKey: null,
                    maxWarmSurfaces: 4,
                    recentOperations: [],
                    surfaces: [],
                    updatedAt: "2026-08-01T00:00:00.000Z",
                }),
            ),
        });

        expect(workspaceCatalogStore.getState().status).toBe("ready");
        expect(appNavigationStore.getState()).toMatchObject({
            revision: 8,
            source: "durable",
        });
    });
});
