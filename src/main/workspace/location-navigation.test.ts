import { describe, expect, it, vi } from "vitest";

import { IPC_EVENTS } from "@shared/ipc";
import type {
    OpenWorkspaceLocationSummary,
    WorkspaceNavigationSnapshot,
} from "@shared/ipc";

import { activateOpenWorkspaceLocation } from "./location-navigation";

describe("activateOpenWorkspaceLocation", () => {
    it("activates and focuses only the exact target host", async () => {
        const snapshot = createSnapshot("project-b::__primary__");
        const targetSend = vi.fn();
        const sourceSend = vi.fn();
        const manager = {
            activate: vi.fn(() =>
                Promise.resolve({
                    generation: "surface-b",
                    scopeKey: "project-b::__primary__",
                    status: "activated" as const,
                    warm: true,
                }),
            ),
            getHostSnapshotForWindow: vi.fn(() => snapshot),
            getHostWebContents: vi.fn((hostWindowId: string) => ({
                send: hostWindowId === "window-2" ? targetSend : sourceSend,
            })),
            listOpenWorkspaceLocations: vi.fn(() => createLocations()),
        };
        const focusWindow = vi.fn();
        const onActivated = vi.fn();

        await expect(
            activateOpenWorkspaceLocation({
                focusWindow,
                location: {
                    contextKey: "project-b::__primary__",
                    hostWindowId: "window-2",
                    projectId: "project-b",
                    worktreeId: null,
                },
                manager,
                notifyChannel: IPC_EVENTS.workspaceSurfaceSnapshotUpdated,
                onActivated,
            }),
        ).resolves.toBe(true);

        expect(manager.activate).toHaveBeenCalledWith(
            "window-2",
            "project-b::__primary__",
        );
        expect(targetSend).toHaveBeenCalledWith(
            IPC_EVENTS.workspaceSurfaceSnapshotUpdated,
            snapshot,
        );
        expect(sourceSend).not.toHaveBeenCalled();
        expect(focusWindow).toHaveBeenCalledWith("window-2");
        expect(onActivated).toHaveBeenCalledWith(
            expect.objectContaining({ hostWindowId: "window-2" }),
            snapshot,
        );
    });

    it("rejects a stale location without changing any host", async () => {
        const manager = {
            activate: vi.fn(() =>
                Promise.resolve({
                    generation: "surface-b",
                    scopeKey: "project-b::__primary__",
                    status: "activated" as const,
                    warm: true,
                }),
            ),
            getHostSnapshotForWindow: vi.fn(),
            getHostWebContents: vi.fn(),
            listOpenWorkspaceLocations: vi.fn(() => createLocations()),
        };
        const focusWindow = vi.fn();

        await expect(
            activateOpenWorkspaceLocation({
                focusWindow,
                location: {
                    contextKey: "project-b::__primary__",
                    hostWindowId: "window-2",
                    projectId: "project-b",
                    worktreeId: "stale-worktree",
                },
                manager,
                notifyChannel: IPC_EVENTS.workspaceSurfaceSnapshotUpdated,
                onActivated: vi.fn(),
            }),
        ).resolves.toBe(false);

        expect(manager.activate).not.toHaveBeenCalled();
        expect(focusWindow).not.toHaveBeenCalled();
    });
});

function createLocations(): OpenWorkspaceLocationSummary[] {
    return [
        {
            contextKey: "project-a::__primary__",
            hostWindowId: "window-1",
            isActive: true,
            isCurrentWindow: true,
            lastActivatedAt: "2026-07-20T00:00:00.000Z",
            projectId: "project-a",
            windowTitle: "Comando · project-a",
            worktreeId: null,
        },
        {
            contextKey: "project-b::__primary__",
            hostWindowId: "window-2",
            isActive: true,
            isCurrentWindow: false,
            lastActivatedAt: "2026-07-21T00:00:00.000Z",
            projectId: "project-b",
            windowTitle: "Comando · project-b",
            worktreeId: null,
        },
    ];
}

function createSnapshot(activeContextKey: string): WorkspaceNavigationSnapshot {
    return {
        activeContextKey,
        contexts: [],
        openContextKeys: [],
        version: 3,
    };
}
