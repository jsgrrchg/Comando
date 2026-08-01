import type {
    WorkspaceNavigationSnapshot,
    WorkspaceSurfaceActivationResult,
} from "@shared/ipc";
import type { ActivateWorkspaceLocationInput } from "@shared/ipc";
import { areWorkspaceScopesEquivalent } from "@shared/workspace-context";
import type { WorkspaceLocation } from "@shared/workspace-context";

interface WorkspaceLocationNavigationManager {
    activate(
        hostWindowId: string,
        contextKey: string,
    ): Promise<WorkspaceSurfaceActivationResult>;
    getHostSnapshotForWindow(
        hostWindowId: string,
    ): WorkspaceNavigationSnapshot | null;
    getHostWebContents(
        hostWindowId: string,
    ): { send(channel: string, snapshot: WorkspaceNavigationSnapshot): void } | null;
    listOpenWorkspaceLocations(): readonly WorkspaceLocation[];
}

export async function activateOpenWorkspaceLocation(input: {
    readonly focusWindow: (hostWindowId: string) => void;
    readonly location: ActivateWorkspaceLocationInput;
    readonly manager: WorkspaceLocationNavigationManager;
    readonly notifyChannel: string;
    readonly onActivated: (
        location: WorkspaceLocation,
        snapshot: WorkspaceNavigationSnapshot,
    ) => Promise<void> | void;
}): Promise<boolean> {
    const location = input.manager
        .listOpenWorkspaceLocations()
        .find(
            (candidate) =>
                candidate.hostWindowId === input.location.hostWindowId &&
                candidate.contextKey === input.location.contextKey,
        );
    if (!location || !areWorkspaceScopesEquivalent(location, input.location)) {
        return false;
    }
    const activation = await input.manager.activate(
        location.hostWindowId,
        location.contextKey,
    );
    if (activation.status !== "activated") {
        return false;
    }
    const snapshot = input.manager.getHostSnapshotForWindow(
        location.hostWindowId,
    );
    if (!snapshot) {
        return false;
    }

    input.manager
        .getHostWebContents(location.hostWindowId)
        ?.send(input.notifyChannel, snapshot);
    input.focusWindow(location.hostWindowId);
    await input.onActivated(location, snapshot);
    return true;
}
