import { describe, expect, it, vi } from "vitest";

import type { WorkspaceNavigationSnapshot } from "@shared/ipc";

import { LegacyV3WorkspaceLayoutAdapter } from "./legacy-v3-workspace-layout-adapter";

const targetLayout = {
    activePaneId: "pane-target",
    rootNode: {
        activeTabId: null,
        id: "pane-target",
        pinnedTabIds: [],
        tabIds: [],
        type: "pane" as const,
    },
    tabs: [],
};

describe("LegacyV3WorkspaceLayoutAdapter", () => {
    it("hydrates and writes only the surface-bound context", async () => {
        const source: WorkspaceNavigationSnapshot = {
            activeContextKey: "project-2::__primary__",
            contexts: [
                {
                    key: "project-1::__primary__",
                    lastActivatedAt: "2026-07-31T11:00:00.000Z",
                    projectId: "project-1",
                    workspace: targetLayout,
                    worktreeId: null,
                },
                {
                    key: "project-2::__primary__",
                    lastActivatedAt: "2026-07-31T12:00:00.000Z",
                    projectId: "project-2",
                    workspace: {
                        ...targetLayout,
                        activePaneId: "pane-other",
                    },
                    worktreeId: null,
                },
            ],
            openContextKeys: [
                "project-1::__primary__",
                "project-2::__primary__",
            ],
            version: 3,
        };
        const saveWorkspaceSnapshot = vi.fn(() => Promise.resolve());
        const adapter = new LegacyV3WorkspaceLayoutAdapter({
            getWorkspaceSnapshot: () => Promise.resolve(source),
            saveWorkspaceSnapshot,
        });
        const binding = {
            generation: "surface-1",
            projectId: "project-1",
            revision: 0,
            scopeKey: "project-1::__primary__",
            worktreeId: null,
        };

        const record = await adapter.load(binding);
        expect(record.layout).toEqual(targetLayout);
        await adapter.save(binding, targetLayout, record.lastActivatedAt);

        expect(saveWorkspaceSnapshot).toHaveBeenCalledWith({
            activeContextKey: "project-1::__primary__",
            contexts: [
                {
                    key: "project-1::__primary__",
                    lastActivatedAt: "2026-07-31T11:00:00.000Z",
                    projectId: "project-1",
                    workspace: targetLayout,
                    worktreeId: null,
                },
            ],
            openContextKeys: ["project-1::__primary__"],
            version: 3,
        });
    });
});
