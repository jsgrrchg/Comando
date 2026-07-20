import type { WebContents } from "electron";

import { IPC_EVENTS } from "@shared/ipc";
import type { WorkspaceNavigationSnapshot } from "@shared/ipc";

interface WorkspaceSurfaceHostSnapshotManager {
    getHostSnapshotForWindow: (
        hostWindowId: string,
    ) => WorkspaceNavigationSnapshot | null;
    getHostWebContents: (
        hostWindowId: string,
    ) => Pick<WebContents, "send"> | null;
}

interface WorkspaceSurfaceSnapshotManager
    extends WorkspaceSurfaceHostSnapshotManager {
    mergeSurfaceSnapshot: (
        webContents: WebContents,
        snapshot: WorkspaceNavigationSnapshot,
    ) => {
        readonly hostWindowId: string;
        readonly snapshot: WorkspaceNavigationSnapshot;
    } | null;
}

export function activateWorkspaceSurfaceAndNotifyHost({
    contextKey,
    hostWindowId,
    manager,
}: {
    readonly contextKey: string;
    readonly hostWindowId: string;
    readonly manager: WorkspaceSurfaceHostSnapshotManager & {
        activate: (hostWindowId: string, contextKey: string) => boolean;
    };
}): boolean {
    if (!manager.activate(hostWindowId, contextKey)) {
        return false;
    }

    const hostSnapshot = manager.getHostSnapshotForWindow(hostWindowId);
    if (hostSnapshot) {
        manager
            .getHostWebContents(hostWindowId)
            ?.send(IPC_EVENTS.workspaceSurfaceSnapshotUpdated, hostSnapshot);
    }
    return true;
}

export async function persistWorkspaceSurfaceSnapshot({
    manager,
    saveSnapshot,
    sender,
    snapshot,
    workspaceId,
}: {
    readonly manager: WorkspaceSurfaceSnapshotManager;
    readonly saveSnapshot: (
        workspaceId: string,
        snapshot: WorkspaceNavigationSnapshot,
    ) => Promise<void>;
    readonly sender: WebContents;
    readonly snapshot: WorkspaceNavigationSnapshot;
    readonly workspaceId: string;
}): Promise<boolean> {
    const surfaceUpdate = manager.mergeSurfaceSnapshot(sender, snapshot);
    if (!surfaceUpdate) {
        return false;
    }

    await saveSnapshot(workspaceId, surfaceUpdate.snapshot);
    // Persistence may resolve after navigation has advanced to another context.
    // Publish the manager's current snapshot so an older save cannot navigate back.
    const latestSnapshot =
        manager.getHostSnapshotForWindow(surfaceUpdate.hostWindowId) ??
        surfaceUpdate.snapshot;
    manager
        .getHostWebContents(surfaceUpdate.hostWindowId)
        ?.send(IPC_EVENTS.workspaceSurfaceSnapshotUpdated, latestSnapshot);
    return true;
}
