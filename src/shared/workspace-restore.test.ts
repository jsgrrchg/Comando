import { describe, expect, it } from "vitest";

import {
    normalizeWindowWorkspaceRestoreRecord,
    normalizeWorkspaceNavigationSnapshot,
} from "./workspace-restore";

describe("workspace restore normalization", () => {
    it("migrates a legacy layout into the supplied window scope", () => {
        const result = normalizeWorkspaceNavigationSnapshot(
            {
                activePaneId: "pane-root",
                rootNode: {
                    activeTabId: "file-1",
                    id: "pane-root",
                    tabIds: ["file-1"],
                    type: "pane",
                },
                tabs: [
                    {
                        createdAt: "2026-01-01T00:00:00.000Z",
                        id: "file-1",
                        kind: "file",
                        projectId: "project-1",
                        relativePath: "README.md",
                        title: "README.md",
                    },
                ],
            },
            { projectId: "project-1", worktreeId: "worktree-1" },
        );

        expect(result.snapshot.activeContextKey).toBe(
            "project-1::worktree-1",
        );
        expect(result.snapshot.contexts).toHaveLength(1);
    });

    it("drops only an invalid context and repairs pane references", () => {
        const result = normalizeWorkspaceNavigationSnapshot({
            activeContextKey: "missing",
            contexts: [
                {
                    key: "wrong-key",
                    lastActivatedAt: "2026-01-01T00:00:00.000Z",
                    projectId: "project-1",
                    workspace: {
                        activePaneId: "missing-pane",
                        rootNode: {
                            activeTabId: "missing-tab",
                            id: "pane-root",
                            pinnedTabIds: ["missing-tab"],
                            tabIds: ["missing-tab"],
                            type: "pane",
                        },
                        tabs: [],
                    },
                    worktreeId: null,
                },
                { key: "broken", projectId: "project-2" },
            ],
            openContextKeys: ["missing", "wrong-key"],
            version: 2,
        });

        expect(result.droppedContextCount).toBe(1);
        expect(result.snapshot.openContextKeys).toEqual([
            "project-1::__primary__",
        ]);
        expect(result.snapshot.contexts[0]?.workspace).toMatchObject({
            activePaneId: "pane-root",
            rootNode: { activeTabId: null, pinnedTabIds: [], tabIds: [] },
        });
    });

    it("preserves and normalizes restore revisions", () => {
        const record = normalizeWindowWorkspaceRestoreRecord({
            revision: 4.9,
            schemaVersion: 1,
            snapshot: {
                activeContextKey: null,
                contexts: [],
                openContextKeys: [],
                version: 2,
            },
            updatedAt: "2026-01-01T00:00:00.000Z",
        });

        expect(record.revision).toBe(4);
        expect(record.schemaVersion).toBe(1);
    });
});
