import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BrowserWindow, WebContents } from "electron";
import { IPC_EVENTS } from "@shared/ipc";
import type {
    WindowContextSnapshot,
    WorkspaceNavigationSnapshot,
    WorkspaceSurfaceActionRequest,
    WorkspaceSurfaceFileRevealRequest,
} from "@shared/ipc";

const electronMocks = vi.hoisted(() => {
    let nextWebContentsId = 100;
    const views: FakeView[] = [];

    class FakeWebContents {
        readonly id = nextWebContentsId++;
        readonly focus = vi.fn();
        readonly send = vi.fn();
        readonly setZoomFactor = vi.fn();
        destroyed = false;

        readonly close = vi.fn(() => {
            this.destroyed = true;
        });

        isDestroyed(): boolean {
            return this.destroyed;
        }

        on(): this {
            return this;
        }

        once(): this {
            return this;
        }
    }

    class FakeView {
        readonly setBounds = vi.fn();
        readonly setVisible = vi.fn();
        readonly webContents = new FakeWebContents();

        constructor() {
            views.push(this);
        }
    }

    return {
        FakeView,
        reset: () => {
            views.splice(0);
            nextWebContentsId = 100;
        },
        views,
    };
});

vi.mock("electron", () => ({
    BrowserWindow: class {},
    WebContentsView: electronMocks.FakeView,
}));

vi.mock("@main/window", () => ({
    DESKTOP_TITLE_BAR_HEIGHT: 52,
    getRendererPreloadPath: () => "/tmp/preload.js",
    loadRendererContents: vi.fn(),
}));

vi.mock("@main/windows/registry", () => ({
    windowRegistry: {
        registerEmbeddedRenderer: vi.fn(),
        unregisterEmbeddedRenderer: vi.fn(),
    },
}));

import { WorkspaceSurfaceManager } from "./surface-manager";

describe("WorkspaceSurfaceManager action routing", () => {
    beforeEach(() => {
        electronMocks.reset();
    });

    it("delivers only to the active surface and rejects stale scopes", () => {
        const manager = new WorkspaceSurfaceManager();
        const host = createHostWindow();
        const snapshot = createSnapshot();
        manager.syncHost(host.window, createHostContext(), snapshot);

        const [surfaceA, surfaceB] = electronMocks.views;
        expect(surfaceA).toBeDefined();
        expect(surfaceB).toBeDefined();

        const actionA = createFileAction("project-a::__primary__", "project-a");
        expect(manager.dispatchActiveSurfaceAction("host-1", actionA)).toEqual({
            delivered: true,
        });
        expect(surfaceA.webContents.send).not.toHaveBeenCalled();

        manager.notifySurfaceReady(asWebContents(surfaceA.webContents));
        expect(surfaceA.webContents.send).toHaveBeenCalledWith(
            IPC_EVENTS.workspaceSurfaceActionRequested,
            actionA,
        );
        expect(surfaceB.webContents.send).not.toHaveBeenCalled();

        manager.activate("host-1", "project-b::__primary__");
        expect(manager.dispatchActiveSurfaceAction("host-1", actionA)).toEqual({
            delivered: false,
            reason: "inactive-context",
        });
        expect(surfaceA.webContents.send).toHaveBeenCalledTimes(1);
        expect(surfaceB.webContents.send).not.toHaveBeenCalled();

        const actionB = createFileAction("project-b::__primary__", "project-b");
        manager.notifySurfaceReady(asWebContents(surfaceB.webContents));
        expect(manager.dispatchActiveSurfaceAction("host-1", actionB)).toEqual({
            delivered: true,
        });
        expect(surfaceB.webContents.send).toHaveBeenCalledWith(
            IPC_EVENTS.workspaceSurfaceActionRequested,
            actionB,
        );

        expect(
            manager.dispatchActiveSurfaceAction("host-1", {
                ...actionB,
                projectId: "project-a",
            }),
        ).toEqual({ delivered: false, reason: "invalid-context" });
        expect(surfaceB.webContents.send).toHaveBeenCalledTimes(1);

        surfaceB.webContents.destroyed = true;
        expect(manager.dispatchActiveSurfaceAction("host-1", actionB)).toEqual({
            delivered: false,
            reason: "missing-surface",
        });
        expect(surfaceB.webContents.send).toHaveBeenCalledTimes(1);
    });

    it("reveals a surface file only through its active host context", () => {
        const manager = new WorkspaceSurfaceManager();
        const host = createHostWindow();
        manager.syncHost(host.window, createHostContext(), createSnapshot());
        const [surfaceA, surfaceB] = electronMocks.views;
        const requestA = createFileRevealRequest(
            "project-a::__primary__",
            "project-a",
        );

        expect(
            manager.revealSurfaceFileInHostTree(
                asWebContents(surfaceA.webContents),
                requestA,
            ),
        ).toEqual({ delivered: true });
        expect(host.send).toHaveBeenCalledWith(
            IPC_EVENTS.workspaceSurfaceFileRevealRequested,
            requestA,
        );

        manager.activate("host-1", "project-b::__primary__");
        expect(
            manager.revealSurfaceFileInHostTree(
                asWebContents(surfaceA.webContents),
                requestA,
            ),
        ).toEqual({ delivered: false, reason: "inactive-context" });
        expect(
            manager.revealSurfaceFileInHostTree(
                asWebContents(surfaceB.webContents),
                {
                    ...requestA,
                    contextKey: "project-b::__primary__",
                    projectId: "project-a",
                },
            ),
        ).toEqual({ delivered: false, reason: "invalid-context" });
        expect(
            manager.revealSurfaceFileInHostTree(
                asWebContents(surfaceB.webContents),
                createFileRevealRequest(
                    "project-b::__primary__",
                    "project-b",
                ),
            ),
        ).toEqual({ delivered: true });
    });
});

function createHostWindow(): {
    readonly send: ReturnType<typeof vi.fn>;
    readonly window: BrowserWindow;
} {
    const send = vi.fn();
    const webContents = {
        getZoomFactor: () => 1,
        isDestroyed: () => false,
        send,
    };
    const window = {
        contentView: {
            addChildView: vi.fn(),
            removeChildView: vi.fn(),
        },
        getContentBounds: () => ({ height: 800, width: 1200, x: 0, y: 0 }),
        isDestroyed: () => false,
        on: vi.fn(),
        webContents,
    } as unknown as BrowserWindow;
    return { send, window };
}

function createHostContext(): WindowContextSnapshot {
    return {
        projectId: "project-a",
        windowId: "host-1",
        windowKind: "main",
        workspaceId: "workspace-1",
        workspaceSessionId: "workspace-session-1",
        worktreeId: null,
    };
}

function createSnapshot(): WorkspaceNavigationSnapshot {
    return {
        activeContextKey: "project-a::__primary__",
        contexts: [
            createPersistedContext("project-a::__primary__", "project-a"),
            createPersistedContext("project-b::__primary__", "project-b"),
        ],
        openContextKeys: [
            "project-a::__primary__",
            "project-b::__primary__",
        ],
        version: 3,
    };
}

function createPersistedContext(key: string, projectId: string) {
    return {
        key,
        lastActivatedAt: "2026-07-19T00:00:00.000Z",
        projectId,
        workspace: {
            activePaneId: `pane-${projectId}`,
            rootNode: {
                activeTabId: null,
                id: `pane-${projectId}`,
                tabIds: [],
                type: "pane" as const,
            },
            tabs: [],
        },
        worktreeId: null,
    };
}

function createFileAction(
    contextKey: string,
    projectId: string,
): WorkspaceSurfaceActionRequest {
    return {
        contextKey,
        kind: "file",
        origin: "tree",
        projectId,
        relativePath: "README.md",
        worktreeId: null,
    };
}

function createFileRevealRequest(
    contextKey: string,
    projectId: string,
): WorkspaceSurfaceFileRevealRequest {
    return {
        contextKey,
        projectId,
        relativePath: "README.md",
        worktreeId: null,
    };
}

function asWebContents(value: unknown): WebContents {
    return value as WebContents;
}
