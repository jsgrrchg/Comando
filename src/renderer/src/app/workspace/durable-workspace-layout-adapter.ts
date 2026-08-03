import type { ComandoApi, WorkspaceLayoutSnapshot } from "@shared/ipc";

import type { WorkspaceLayoutBinding } from "../store/workspace-layout-store";
import type { WorkspaceLayoutAdapter } from "./workspace-layout-coordinator";

export class DurableWorkspaceLayoutAdapter implements WorkspaceLayoutAdapter {
    readonly #api: Pick<
        ComandoApi,
        "loadWorkspaceSurfaceLayout" | "saveWorkspaceSurfaceLayout"
    >;

    constructor(
        api: Pick<
            ComandoApi,
            "loadWorkspaceSurfaceLayout" | "saveWorkspaceSurfaceLayout"
        >,
    ) {
        this.#api = api;
    }

    async load(binding: WorkspaceLayoutBinding) {
        return this.#api.loadWorkspaceSurfaceLayout(binding);
    }

    async save(
        binding: WorkspaceLayoutBinding,
        layout: WorkspaceLayoutSnapshot,
        lastActivatedAt: string,
    ) {
        return this.#api.saveWorkspaceSurfaceLayout({
            expectedRevision: binding.revision,
            generation: binding.generation,
            lastActivatedAt,
            layout,
            runtimeOwnerId: binding.runtimeOwnerId,
            scopeKey: binding.scopeKey,
        });
    }
}
