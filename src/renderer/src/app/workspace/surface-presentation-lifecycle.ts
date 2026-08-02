import type {
    WorkspaceSurfaceLifecycleEvent,
    WorkspaceSurfaceRuntimeBinding,
} from "@shared/ipc";

export function isWorkspaceSurfaceLifecycleCurrent(
    binding: WorkspaceSurfaceRuntimeBinding,
    event: WorkspaceSurfaceLifecycleEvent,
): boolean {
    return (
        event.generation === binding.generation &&
        event.runtimeOwnerId === binding.runtimeOwnerId &&
        event.scopeKey === binding.scopeKey
    );
}
