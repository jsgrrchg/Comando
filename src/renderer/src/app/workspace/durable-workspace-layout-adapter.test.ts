import { describe, expect, it, vi } from "vitest";

import type {
    ComandoApi,
    WorkspaceLayoutSnapshot,
} from "@shared/ipc";

import type { WorkspaceLayoutBinding } from "../store/workspace-layout-store";
import { DurableWorkspaceLayoutAdapter } from "./durable-workspace-layout-adapter";

const binding: WorkspaceLayoutBinding = {
    generation: "surface-1",
    projectId: "project-1",
    revision: 7,
    runtimeOwnerId: "runtime-1",
    scopeKey: "project-1::__primary__",
    worktreeId: null,
};

const layout: WorkspaceLayoutSnapshot = {
    activePaneId: "pane-root",
    rootNode: {
        activeTabId: null,
        id: "pane-root",
        tabIds: [],
        type: "pane",
    },
    tabs: [],
};

describe("DurableWorkspaceLayoutAdapter", () => {
    it("loads only through the immutable surface binding", async () => {
        const loadWorkspaceSurfaceLayout = vi.fn<
            ComandoApi["loadWorkspaceSurfaceLayout"]
        >(() =>
            Promise.resolve({
                ...binding,
                lastActivatedAt: "2026-08-01T00:00:00.000Z",
                layout,
            }),
        );
        const adapter = new DurableWorkspaceLayoutAdapter({
            loadWorkspaceSurfaceLayout,
            saveWorkspaceSurfaceLayout: vi.fn(),
        });

        await expect(adapter.load(binding)).resolves.toMatchObject({
            layout,
            revision: 7,
            scopeKey: binding.scopeKey,
        });
        expect(loadWorkspaceSurfaceLayout).toHaveBeenCalledWith(binding);
    });

    it("persists with CAS instead of writing a v3 navigation snapshot", async () => {
        const saveWorkspaceSurfaceLayout = vi.fn<
            ComandoApi["saveWorkspaceSurfaceLayout"]
        >((input) =>
            Promise.resolve({
                ...binding,
                lastActivatedAt: input.lastActivatedAt,
                layout: input.layout,
                revision: 8,
            }),
        );
        const adapter = new DurableWorkspaceLayoutAdapter({
            loadWorkspaceSurfaceLayout: vi.fn(),
            saveWorkspaceSurfaceLayout,
        });

        await adapter.save(binding, layout, "2026-08-01T00:00:00.000Z");

        expect(saveWorkspaceSurfaceLayout).toHaveBeenCalledWith({
            expectedRevision: 7,
            generation: "surface-1",
            lastActivatedAt: "2026-08-01T00:00:00.000Z",
            layout,
            runtimeOwnerId: "runtime-1",
            scopeKey: "project-1::__primary__",
        });
    });
});
