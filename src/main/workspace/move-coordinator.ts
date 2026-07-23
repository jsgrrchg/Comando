import type {
    MoveWorkspaceContextInput,
    WindowContextSnapshot,
    WorkspaceNavigationSnapshot,
} from "@shared/ipc";
import {
    areWorkspaceScopesEquivalent,
    hasOpenWorkspaceScope,
} from "@shared/workspace-context";

import type { WorkspaceGateway } from "./service";
import type {
    OpenWorkspaceSurfaceLocation,
    WorkspaceSurfaceManager,
    WorkspaceSurfaceTransferResult,
} from "./surface-manager";

interface WorkspaceMoveManager {
    getHostSnapshotForWindow(
        hostWindowId: string,
    ): WorkspaceNavigationSnapshot | null;
    listOpenWorkspaceLocations(): readonly OpenWorkspaceSurfaceLocation[];
    transferSurface(
        input: Parameters<WorkspaceSurfaceManager["transferSurface"]>[0],
    ): Promise<WorkspaceSurfaceTransferResult>;
}

export interface WorkspaceMoveCoordinatorDependencies {
    readonly captureContext: (
        hostWindowId: string,
        contextKey: string,
    ) => Promise<WorkspaceNavigationSnapshot | null>;
    readonly createEmptyTarget: () => Promise<WindowContextSnapshot>;
    readonly flushHost: (hostWindowId: string) => Promise<void>;
    readonly getWindowContext: (
        hostWindowId: string,
    ) => WindowContextSnapshot | null;
    readonly isWindowAvailable: (hostWindowId: string) => boolean;
    readonly manager: WorkspaceMoveManager;
    readonly onTransferred: (
        sourceWindowId: string,
        targetWindowId: string,
        transfer: WorkspaceSurfaceTransferResult,
    ) => void;
    readonly workspaceService: WorkspaceGateway;
}

export async function moveWorkspaceBetweenWindows(
    sourceWindowId: string,
    input: MoveWorkspaceContextInput,
    dependencies: WorkspaceMoveCoordinatorDependencies,
): Promise<void> {
    // Global identity is the project/worktree scope plus its current host;
    // uniqueness applies to the scope, never to every worktree in a project.
    const sourceLocation = dependencies.manager
        .listOpenWorkspaceLocations()
        .find(
            (location) =>
                location.hostWindowId === sourceWindowId &&
                location.contextKey === input.contextKey,
        );
    if (
        !sourceLocation ||
        !areWorkspaceScopesEquivalent(sourceLocation, input)
    ) {
        throw new Error("The workspace is no longer open in this window.");
    }

    const sourceContext = dependencies.getWindowContext(sourceWindowId);
    if (
        !sourceContext?.workspaceId ||
        !dependencies.isWindowAvailable(sourceWindowId)
    ) {
        throw new Error("The source window is no longer available.");
    }

    const createdTarget = input.targetWindowId === null;
    const targetContext = createdTarget
        ? await dependencies.createEmptyTarget()
        : dependencies.getWindowContext(input.targetWindowId);
    if (
        !targetContext?.workspaceId ||
        targetContext.windowKind !== "main" ||
        !dependencies.isWindowAvailable(targetContext.windowId)
    ) {
        throw new Error("The destination window is no longer available.");
    }
    if (targetContext.windowId === sourceWindowId) {
        throw new Error("The workspace is already in this window.");
    }

    const targetSnapshot = dependencies.manager.getHostSnapshotForWindow(
        targetContext.windowId,
    );
    if (!targetSnapshot) {
        throw new Error("The destination window is still starting.");
    }
    if (hasOpenWorkspaceScope(targetSnapshot, input)) {
        throw new Error("The destination already contains this workspace.");
    }

    await Promise.all([
        dependencies.flushHost(sourceWindowId),
        ...(createdTarget
            ? []
            : [dependencies.flushHost(targetContext.windowId)]),
    ]);
    const capturedSourceSnapshot = await dependencies.captureContext(
        sourceWindowId,
        input.contextKey,
    );
    const latestTargetSnapshot =
        dependencies.manager.getHostSnapshotForWindow(targetContext.windowId);
    if (!capturedSourceSnapshot || !latestTargetSnapshot) {
        throw new Error("Could not capture the workspace before moving it.");
    }

    await dependencies.workspaceService.saveSnapshot(
        sourceContext.workspaceId,
        capturedSourceSnapshot,
    );
    await dependencies.workspaceService.saveSnapshot(
        targetContext.workspaceId,
        latestTargetSnapshot,
    );
    const [sourceRestore, targetRestore] = await Promise.all([
        dependencies.workspaceService.loadSnapshot(sourceContext.workspaceId),
        dependencies.workspaceService.loadSnapshot(targetContext.workspaceId),
    ]);
    const transfer = await dependencies.manager.transferSurface({
        commit: () =>
            Promise.resolve(
                dependencies.workspaceService.transferContext({
                    contextKey: input.contextKey,
                    sourceRevision: sourceRestore.revision,
                    sourceWorkspaceId: sourceContext.workspaceId!,
                    targetRevision: targetRestore.revision,
                    targetWorkspaceId: targetContext.workspaceId!,
                }),
            ),
        contextKey: input.contextKey,
        sourceHostWindowId: sourceWindowId,
        targetHostWindowId: targetContext.windowId,
    });
    dependencies.onTransferred(
        sourceWindowId,
        targetContext.windowId,
        transfer,
    );
}
