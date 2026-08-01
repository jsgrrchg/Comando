import { beforeEach, describe, expect, it } from "vitest";

import type { WorkspaceNavigationSnapshot } from "@shared/ipc";

import {
    appNavigationStore,
    resetAppNavigationStoreForTests,
} from "./app-navigation-store";
import {
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
});
