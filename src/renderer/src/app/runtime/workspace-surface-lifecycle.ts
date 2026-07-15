import { create } from "zustand";

import type {
    WorkspaceSurfaceLifecycleEvent,
    WorkspaceSurfaceLifecycleState,
} from "@shared/ipc";

interface WorkspaceSurfaceLifecycleStore {
    readonly generation: number;
    readonly needsReconcile: boolean;
    readonly state: WorkspaceSurfaceLifecycleState;
    apply: (event: WorkspaceSurfaceLifecycleEvent) => void;
    markReconciled: (generation: number) => void;
}

export const useWorkspaceSurfaceLifecycleStore =
    create<WorkspaceSurfaceLifecycleStore>((set) => ({
        generation: 0,
        needsReconcile: false,
        state: "visible",
        apply: (event) =>
            set((current) => {
                if (event.generation <= current.generation) {
                    return current;
                }
                return {
                    generation: event.generation,
                    needsReconcile: event.state === "visible",
                    state: event.state,
                };
            }),
        markReconciled: (generation) =>
            set((current) =>
                current.generation === generation
                    ? { ...current, needsReconcile: false }
                    : current,
            ),
    }));
