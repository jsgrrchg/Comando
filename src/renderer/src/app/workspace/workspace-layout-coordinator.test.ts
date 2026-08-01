import { describe, expect, it, vi } from "vitest";

import type { WorkspaceLayoutSnapshot } from "@shared/ipc";

import {
    createWorkspaceLayoutStore,
    type WorkspaceLayoutBinding,
    type WorkspaceLayoutRecord,
} from "../store/workspace-layout-store";
import {
    WorkspaceLayoutCoordinator,
    type WorkspaceLayoutAdapter,
} from "./workspace-layout-coordinator";

const binding = {
    generation: "surface-1",
    projectId: "project-1",
    revision: 4,
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

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((nextResolve) => {
        resolve = nextResolve;
    });
    return { promise, resolve };
}

describe("WorkspaceLayoutCoordinator", () => {
    it("hydrates exactly the bound surface scope", async () => {
        const load = vi.fn(
            (
                requestedBinding: WorkspaceLayoutBinding,
            ): Promise<WorkspaceLayoutRecord> =>
                Promise.resolve({
                    ...requestedBinding,
                    lastActivatedAt: "2026-07-31T12:00:00.000Z",
                    layout,
                }),
        );
        const adapter: WorkspaceLayoutAdapter = {
            load,
            save: vi.fn(),
        };
        const store = createWorkspaceLayoutStore(binding);
        const coordinator = new WorkspaceLayoutCoordinator(store, adapter);

        await coordinator.hydrate();

        expect(load).toHaveBeenCalledWith(binding);
        expect(store.getState()).toMatchObject({
            binding,
            layout,
            status: "ready",
        });
        expect(store.getState()).not.toHaveProperty("contextsByKey");
    });

    it("discards a hydration result after its generation is disposed", async () => {
        const pending = deferred<{
            generation: string;
            lastActivatedAt: string;
            layout: WorkspaceLayoutSnapshot;
            projectId: string;
            revision: number;
            runtimeOwnerId: string;
            scopeKey: string;
            worktreeId: null;
        }>();
        const adapter: WorkspaceLayoutAdapter = {
            load: vi.fn(() => pending.promise),
            save: vi.fn(),
        };
        const store = createWorkspaceLayoutStore(binding);
        const coordinator = new WorkspaceLayoutCoordinator(store, adapter);
        const hydration = coordinator.hydrate();

        coordinator.dispose();
        pending.resolve({
            ...binding,
            lastActivatedAt: "2026-07-31T12:00:00.000Z",
            layout,
        });

        await expect(hydration).resolves.toBeNull();
        expect(store.getState().layout).toBeNull();
    });

    it("rejects a response for a different scope", async () => {
        const load = vi.fn(
            (
                requestedBinding: WorkspaceLayoutBinding,
            ): Promise<WorkspaceLayoutRecord> =>
                Promise.resolve({
                    ...requestedBinding,
                    lastActivatedAt: "2026-07-31T12:00:00.000Z",
                    layout,
                    scopeKey: "project-2::__primary__",
                }),
        );
        const adapter: WorkspaceLayoutAdapter = {
            load,
            save: vi.fn(),
        };
        const store = createWorkspaceLayoutStore(binding);
        const coordinator = new WorkspaceLayoutCoordinator(store, adapter);

        await expect(coordinator.hydrate()).rejects.toThrow(
            "does not match this surface",
        );
        expect(store.getState().status).toBe("error");
    });

    it("serializes with the bound revision and advances only after save", async () => {
        const save = vi.fn(
            (
                requestedBinding: WorkspaceLayoutBinding,
                requestedLayout: WorkspaceLayoutSnapshot,
                lastActivatedAt: string,
            ): Promise<WorkspaceLayoutRecord> =>
                Promise.resolve({
                    ...requestedBinding,
                    lastActivatedAt,
                    layout: requestedLayout,
                    revision: requestedBinding.revision + 1,
                }),
        );
        const adapter: WorkspaceLayoutAdapter = {
            load: vi.fn(),
            save,
        };
        const store = createWorkspaceLayoutStore(binding);
        store.setState({
            lastActivatedAt: "2026-07-31T12:00:00.000Z",
            layout,
            status: "ready",
        });
        const coordinator = new WorkspaceLayoutCoordinator(store, adapter);

        await expect(coordinator.persist(layout)).resolves.toBe(true);

        expect(save).toHaveBeenCalledWith(
            binding,
            layout,
            "2026-07-31T12:00:00.000Z",
        );
        expect(store.getState().binding.revision).toBe(5);
    });
});
