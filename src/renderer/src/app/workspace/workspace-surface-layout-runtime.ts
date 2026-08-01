import type { ComandoApi, WorkspaceLayoutSnapshot } from "@shared/ipc";

import {
    createWorkspaceLayoutStore,
    type WorkspaceLayoutBinding,
    type WorkspaceLayoutRecord,
} from "../store/workspace-layout-store";
import { LegacyV3WorkspaceLayoutAdapter } from "./legacy-v3-workspace-layout-adapter";
import { WorkspaceLayoutCoordinator } from "./workspace-layout-coordinator";

interface ActiveWorkspaceSurfaceLayoutRuntime {
    readonly binding: WorkspaceLayoutBinding;
    readonly coordinator: WorkspaceLayoutCoordinator;
}

let activeRuntime: ActiveWorkspaceSurfaceLayoutRuntime | null = null;

export function activateWorkspaceSurfaceLayoutRuntime(
    binding: WorkspaceLayoutBinding,
    api: Pick<
        ComandoApi,
        "getWorkspaceSnapshot" | "saveWorkspaceSnapshot"
    >,
): {
    readonly dispose: () => void;
    readonly hydrate: () => Promise<WorkspaceLayoutRecord | null>;
} {
    activeRuntime?.coordinator.dispose();
    const store = createWorkspaceLayoutStore(binding);
    const runtime: ActiveWorkspaceSurfaceLayoutRuntime = {
        binding,
        coordinator: new WorkspaceLayoutCoordinator(
            store,
            new LegacyV3WorkspaceLayoutAdapter(api),
        ),
    };
    activeRuntime = runtime;

    return {
        dispose: () => {
            runtime.coordinator.dispose();
            if (activeRuntime === runtime) {
                activeRuntime = null;
            }
        },
        hydrate: async () => {
            const record = await runtime.coordinator.hydrate();
            return activeRuntime === runtime ? record : null;
        },
    };
}

export async function persistActiveWorkspaceSurfaceLayout(input: {
    readonly layout: WorkspaceLayoutSnapshot;
    readonly scopeKey: string;
}): Promise<boolean> {
    const runtime = activeRuntime;
    if (!runtime) {
        return false;
    }
    if (runtime.binding.scopeKey !== input.scopeKey) {
        // A late mutation from a previous scope must never escape this surface.
        return true;
    }
    await runtime.coordinator.persist(input.layout);
    return true;
}

export function resetWorkspaceSurfaceLayoutRuntimeForTests(): void {
    activeRuntime?.coordinator.dispose();
    activeRuntime = null;
}
