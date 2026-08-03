import { createStore, type StoreApi } from "zustand/vanilla";

import type { WorkspaceLayoutSnapshot } from "@shared/ipc";

export interface WorkspaceLayoutBinding {
    readonly generation: string;
    readonly projectId: string;
    readonly revision: number;
    readonly runtimeOwnerId: string;
    readonly scopeKey: string;
    readonly worktreeId: string | null;
}

export interface WorkspaceLayoutRecord extends WorkspaceLayoutBinding {
    readonly lastActivatedAt: string;
    readonly layout: WorkspaceLayoutSnapshot;
}

export interface WorkspaceLayoutState {
    readonly binding: WorkspaceLayoutBinding;
    readonly error: string | null;
    readonly lastActivatedAt: string | null;
    readonly layout: WorkspaceLayoutSnapshot | null;
    readonly status: "idle" | "loading" | "ready" | "saving" | "error";
}

export type WorkspaceLayoutStore = StoreApi<WorkspaceLayoutState>;

export function createWorkspaceLayoutStore(
    binding: WorkspaceLayoutBinding,
): WorkspaceLayoutStore {
    return createStore<WorkspaceLayoutState>(() => ({
        binding,
        error: null,
        lastActivatedAt: null,
        layout: null,
        status: "idle",
    }));
}
