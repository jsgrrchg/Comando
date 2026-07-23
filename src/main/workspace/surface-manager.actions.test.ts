import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BrowserWindow, WebContents } from "electron";
import { IPC_EVENTS } from "@shared/ipc";
import type {
    WindowContextSnapshot,
    WorkspaceNavigationSnapshot,
    WorkspaceSurfaceActionRequest,
    WorkspaceSurfaceFileRevealRequest,
} from "@shared/ipc";
import { createWindowWorkspaceRestoreRecord } from "@shared/workspace-restore";

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

    it("waits until a new host renderer registers its surface container", async () => {
        const manager = new WorkspaceSurfaceManager();
        const ready = manager.waitForHost("host-1", 100);

        manager.syncHost(
            createHostWindow().window,
            createHostContext(),
            createSnapshot(),
        );

        await expect(ready).resolves.toBe(true);
        await expect(manager.waitForHost("host-1", 100)).resolves.toBe(true);
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
        const queuedActionA = manager.dispatchActiveSurfaceAction(
            "host-1",
            actionA,
        );
        expect(queuedActionA).toMatchObject({
            delivered: true,
            state: "queued",
        });
        if (!queuedActionA.delivered) {
            throw new Error("Expected the action to queue.");
        }
        expect(surfaceA.webContents.send).not.toHaveBeenCalled();

        manager.notifySurfaceReady(asWebContents(surfaceA.webContents));
        expect(surfaceA.webContents.send).toHaveBeenCalledWith(
            IPC_EVENTS.workspaceSurfaceActionRequested,
            {
                actionId: queuedActionA.actionId,
                request: actionA,
            },
        );
        expect(surfaceB.webContents.send).not.toHaveBeenCalled();
        expect(
            manager.claimSurfaceAction(
                asWebContents(surfaceA.webContents),
                queuedActionA.actionId,
            ),
        ).toBe(true);
        manager.completeSurfaceAction(asWebContents(surfaceA.webContents), {
            actionId: queuedActionA.actionId,
            status: "completed",
        });
        expect(host.send).toHaveBeenCalledWith(
            IPC_EVENTS.workspaceSurfaceActionStatus,
            { actionId: queuedActionA.actionId, status: "completed" },
        );

        manager.activate("host-1", "project-b::__primary__");
        expect(manager.dispatchActiveSurfaceAction("host-1", actionA)).toEqual({
            delivered: false,
            reason: "inactive-context",
        });
        expect(surfaceA.webContents.send).toHaveBeenCalledTimes(1);
        expect(surfaceB.webContents.send).not.toHaveBeenCalled();

        const actionB = createFileAction("project-b::__primary__", "project-b");
        manager.notifySurfaceReady(asWebContents(surfaceB.webContents));
        const sentActionB = manager.dispatchActiveSurfaceAction("host-1", actionB);
        expect(sentActionB).toMatchObject({
            delivered: true,
            state: "sent",
        });
        if (!sentActionB.delivered) {
            throw new Error("Expected the action to send.");
        }
        expect(surfaceB.webContents.send).toHaveBeenCalledWith(
            IPC_EVENTS.workspaceSurfaceActionRequested,
            {
                actionId: sentActionB.actionId,
                request: actionB,
            },
        );
        expect(
            manager.claimSurfaceAction(
                asWebContents(surfaceB.webContents),
                sentActionB.actionId,
            ),
        ).toBe(true);
        manager.completeSurfaceAction(asWebContents(surfaceB.webContents), {
            actionId: sentActionB.actionId,
            error: "Could not open the tab.",
            status: "failed",
        });
        expect(host.send).toHaveBeenCalledWith(
            IPC_EVENTS.workspaceSurfaceActionStatus,
            {
                actionId: sentActionB.actionId,
                message: "Could not open the tab.",
                status: "failed",
            },
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

    it("rejects a queued action when its context becomes inactive", () => {
        const manager = new WorkspaceSurfaceManager();
        const host = createHostWindow();
        manager.syncHost(host.window, createHostContext(), createSnapshot());
        const [surfaceA] = electronMocks.views;
        const actionA = createFileAction("project-a::__primary__", "project-a");
        const queuedActionA = manager.dispatchActiveSurfaceAction(
            "host-1",
            actionA,
        );
        if (!queuedActionA.delivered) {
            throw new Error("Expected the action to queue.");
        }

        manager.activate("host-1", "project-b::__primary__");
        manager.notifySurfaceReady(asWebContents(surfaceA.webContents));

        expect(surfaceA.webContents.send).not.toHaveBeenCalled();
        expect(
            manager.claimSurfaceAction(
                asWebContents(surfaceA.webContents),
                queuedActionA.actionId,
            ),
        ).toBe(false);
        expect(host.send).toHaveBeenCalledWith(
            IPC_EVENTS.workspaceSurfaceActionStatus,
            expect.objectContaining({
                actionId: queuedActionA.actionId,
                status: "rejected",
            }),
        );
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

    it("indexes open workspaces without changing host activation", () => {
        const manager = new WorkspaceSurfaceManager();
        const firstHost = createHostWindow();
        const secondHost = createHostWindow();
        const firstSnapshot = createSnapshot();
        const secondSnapshot: WorkspaceNavigationSnapshot = {
            activeContextKey: "project-a::worktree-feature",
            contexts: [
                {
                    ...createPersistedContext(
                        "project-a::worktree-feature",
                        "project-a",
                    ),
                    lastActivatedAt: "2026-07-20T00:00:00.000Z",
                    worktreeId: "worktree-feature",
                },
            ],
            openContextKeys: ["project-a::worktree-feature"],
            version: 3,
        };
        manager.syncHost(firstHost.window, createHostContext(), firstSnapshot);
        manager.syncHost(
            secondHost.window,
            {
                ...createHostContext(),
                windowId: "host-2",
                workspaceId: "workspace-2",
                workspaceSessionId: "workspace-session-2",
            },
            secondSnapshot,
        );

        expect(manager.listOpenWorkspaceLocations()).toEqual([
            expect.objectContaining({
                contextKey: "project-a::__primary__",
                hostWindowId: "host-1",
                isActive: true,
            }),
            expect.objectContaining({
                contextKey: "project-b::__primary__",
                hostWindowId: "host-1",
                isActive: false,
            }),
            expect.objectContaining({
                contextKey: "project-a::worktree-feature",
                hostWindowId: "host-2",
                isActive: true,
            }),
        ]);
        expect(manager.getActiveContext("host-1")?.key).toBe(
            "project-a::__primary__",
        );
        expect(manager.getActiveContext("host-2")?.key).toBe(
            "project-a::worktree-feature",
        );
    });

    it("resolves historical duplicates deterministically", () => {
        const manager = new WorkspaceSurfaceManager();
        const firstHost = createHostWindow();
        const secondHost = createHostWindow();
        const firstSnapshot = createSnapshot();
        const duplicateContext = {
            ...createPersistedContext(
                "project-a::project-a:primary",
                "project-a",
            ),
            lastActivatedAt: "2026-07-21T00:00:00.000Z",
            worktreeId: "project-a:primary",
        };
        manager.syncHost(firstHost.window, createHostContext(), firstSnapshot);
        manager.syncHost(
            secondHost.window,
            {
                ...createHostContext(),
                windowId: "host-2",
                workspaceId: "workspace-2",
                workspaceSessionId: "workspace-session-2",
            },
            {
                activeContextKey: duplicateContext.key,
                contexts: [duplicateContext],
                openContextKeys: [duplicateContext.key],
                version: 3,
            },
        );

        const locations = manager.findWorkspaceLocations({
            projectId: "project-a",
            worktreeId: null,
        });
        expect(locations).toHaveLength(2);
        expect(
            manager.findPreferredWorkspaceLocation(
                { projectId: "project-a", worktreeId: null },
                "host-2",
            )?.hostWindowId,
        ).toBe("host-2");

        manager.activate("host-1", "project-b::__primary__");
        expect(
            manager.findPreferredWorkspaceLocation(
                { projectId: "project-a", worktreeId: null },
                "host-1",
            )?.hostWindowId,
        ).toBe("host-2");
    });

    it("moves a live surface without changing its owner identity", async () => {
        const manager = new WorkspaceSurfaceManager();
        const onSurfaceDestroyed = vi.fn();
        manager.setLifecycleHandlers({ onSurfaceDestroyed });
        const sourceHost = createHostWindow();
        const targetHost = createHostWindow();
        const sourceSnapshot = createSnapshot();
        const targetOpenSnapshot = singleContextSnapshot(
            "project-c::__primary__",
            "project-c",
        );
        const retainedClosedContext = sourceSnapshot.contexts[0];
        if (!retainedClosedContext) {
            throw new Error("Expected a retained source context.");
        }
        const targetSnapshot: WorkspaceNavigationSnapshot = {
            ...targetOpenSnapshot,
            contexts: [
                ...targetOpenSnapshot.contexts,
                retainedClosedContext,
            ],
        };
        manager.syncHost(
            sourceHost.window,
            createHostContext(),
            sourceSnapshot,
        );
        manager.syncHost(
            targetHost.window,
            {
                ...createHostContext(),
                projectId: "project-c",
                windowId: "host-2",
                workspaceId: "workspace-2",
                workspaceSessionId: "workspace-session-2",
            },
            targetSnapshot,
        );
        const originalWebContents = manager.getSurfaceWebContents(
            "host-1",
            "project-a::__primary__",
        );
        const committedSource = singleContextSnapshot(
            "project-b::__primary__",
            "project-b",
        );
        const movedContext = sourceSnapshot.contexts[0];
        if (!originalWebContents || !movedContext) {
            throw new Error("Expected a live source surface.");
        }
        const committedTarget: WorkspaceNavigationSnapshot = {
            activeContextKey: movedContext.key,
            contexts: [
                ...targetSnapshot.contexts.filter(
                    (context) => context.key !== movedContext.key,
                ),
                movedContext,
            ],
            openContextKeys: [
                ...targetSnapshot.openContextKeys,
                movedContext.key,
            ],
            version: 3,
        };

        const result = await manager.transferSurface({
            commit: vi.fn(() =>
                Promise.resolve({
                    source: createWindowWorkspaceRestoreRecord(
                        committedSource,
                        2,
                    ),
                    target: createWindowWorkspaceRestoreRecord(
                        committedTarget,
                        2,
                    ),
                }),
            ),
            contextKey: movedContext.key,
            sourceHostWindowId: "host-1",
            targetHostWindowId: "host-2",
        });

        expect(
            manager.getSurfaceWebContents("host-1", movedContext.key),
        ).toBeNull();
        expect(
            manager.getSurfaceWebContents("host-2", movedContext.key),
        ).toBe(originalWebContents);
        expect(manager.getSurfaceContext(originalWebContents)).toMatchObject({
            hostWindowId: "host-2",
            windowId: result.surfaceId,
            workspaceId: "workspace-2",
            workspaceSessionId: "workspace-session-2",
        });
        expect(result.sourceSnapshot.activeContextKey).toBe(
            "project-b::__primary__",
        );
        expect(result.targetSnapshot.activeContextKey).toBe(movedContext.key);
        expect(
            result.targetSnapshot.contexts.filter(
                (context) => context.key === movedContext.key,
            ),
        ).toHaveLength(1);
        expect(onSurfaceDestroyed).not.toHaveBeenCalled();
    });

    it("rolls a live surface back when persistence fails", async () => {
        const manager = new WorkspaceSurfaceManager();
        const sourceHost = createHostWindow();
        const targetHost = createHostWindow();
        manager.syncHost(sourceHost.window, createHostContext(), createSnapshot());
        manager.syncHost(
            targetHost.window,
            {
                ...createHostContext(),
                projectId: "project-c",
                windowId: "host-2",
                workspaceId: "workspace-2",
                workspaceSessionId: "workspace-session-2",
            },
            singleContextSnapshot("project-c::__primary__", "project-c"),
        );
        const originalWebContents = manager.getSurfaceWebContents(
            "host-1",
            "project-a::__primary__",
        );

        await expect(
            manager.transferSurface({
                commit: vi.fn(() => Promise.reject(new Error("write failed"))),
                contextKey: "project-a::__primary__",
                sourceHostWindowId: "host-1",
                targetHostWindowId: "host-2",
            }),
        ).rejects.toThrow("write failed");

        expect(
            manager.getSurfaceWebContents(
                "host-1",
                "project-a::__primary__",
            ),
        ).toBe(originalWebContents);
        expect(
            manager.getSurfaceWebContents(
                "host-2",
                "project-a::__primary__",
            ),
        ).toBeNull();
        expect(
            originalWebContents
                ? manager.getSurfaceContext(originalWebContents)
                : null,
        ).toMatchObject({ hostWindowId: "host-1", workspaceId: "workspace-1" });
    });

    it("rejects transfers before a destination starts closing", async () => {
        const manager = new WorkspaceSurfaceManager();
        const sourceHost = createHostWindow();
        const targetHost = createHostWindow();
        manager.syncHost(sourceHost.window, createHostContext(), createSnapshot());
        manager.syncHost(
            targetHost.window,
            {
                ...createHostContext(),
                projectId: "project-c",
                windowId: "host-2",
                workspaceId: "workspace-2",
                workspaceSessionId: "workspace-session-2",
            },
            singleContextSnapshot("project-c::__primary__", "project-c"),
        );
        const commit = vi.fn();

        await manager.prepareHostForClose("host-2");

        await expect(
            manager.transferSurface({
                commit,
                contextKey: "project-a::__primary__",
                sourceHostWindowId: "host-1",
                targetHostWindowId: "host-2",
            }),
        ).rejects.toThrow("window is closing");
        expect(commit).not.toHaveBeenCalled();
    });

    it("waits for an in-flight transfer before allowing a host to close", async () => {
        const manager = new WorkspaceSurfaceManager();
        const sourceHost = createHostWindow();
        const targetHost = createHostWindow();
        const sourceSnapshot = createSnapshot();
        const targetSnapshot = singleContextSnapshot(
            "project-c::__primary__",
            "project-c",
        );
        manager.syncHost(sourceHost.window, createHostContext(), sourceSnapshot);
        manager.syncHost(
            targetHost.window,
            {
                ...createHostContext(),
                projectId: "project-c",
                windowId: "host-2",
                workspaceId: "workspace-2",
                workspaceSessionId: "workspace-session-2",
            },
            targetSnapshot,
        );
        const movingContext = sourceSnapshot.contexts[0];
        if (!movingContext) {
            throw new Error("Expected a moving context.");
        }
        const committedSource = singleContextSnapshot(
            "project-b::__primary__",
            "project-b",
        );
        const committedTarget: WorkspaceNavigationSnapshot = {
            activeContextKey: movingContext.key,
            contexts: [...targetSnapshot.contexts, movingContext],
            openContextKeys: [
                ...targetSnapshot.openContextKeys,
                movingContext.key,
            ],
            version: 3,
        };
        const deferredCommit = createDeferred(
            {
                source: createWindowWorkspaceRestoreRecord(
                    committedSource,
                    2,
                ),
                target: createWindowWorkspaceRestoreRecord(
                    committedTarget,
                    2,
                ),
            },
        );
        let hostsNotified = false;
        const transfer = manager.transferSurface({
            commit: () => deferredCommit.promise,
            contextKey: movingContext.key,
            onCommitted: () => {
                hostsNotified = true;
            },
            sourceHostWindowId: "host-1",
            targetHostWindowId: "host-2",
        });
        let closePrepared = false;
        const closePreparation = manager
            .prepareHostForClose("host-2")
            .then(() => {
                closePrepared = true;
            });

        await Promise.resolve();
        expect(closePrepared).toBe(false);

        deferredCommit.resolve();
        await transfer;
        await closePreparation;

        expect(closePrepared).toBe(true);
        expect(hostsNotified).toBe(true);
        expect(
            manager.getSurfaceWebContents("host-2", movingContext.key),
        ).not.toBeNull();
        await expect(
            manager.transferSurface({
                commit: vi.fn(),
                contextKey: "project-b::__primary__",
                sourceHostWindowId: "host-1",
                targetHostWindowId: "host-2",
            }),
        ).rejects.toThrow("window is closing");
    });

    it("allows transfers after reopening a host with the same stable id", async () => {
        const manager = new WorkspaceSurfaceManager();
        const sourceHost = createHostWindow();
        const closedTargetHost = createHostWindow();
        const sourceSnapshot = createSnapshot();
        const targetSnapshot = singleContextSnapshot(
            "project-c::__primary__",
            "project-c",
        );
        const targetContext = {
            ...createHostContext(),
            projectId: "project-c",
            windowId: "host-2",
            workspaceId: "workspace-2",
            workspaceSessionId: "workspace-session-2",
        };
        manager.syncHost(sourceHost.window, createHostContext(), sourceSnapshot);
        manager.syncHost(
            closedTargetHost.window,
            targetContext,
            targetSnapshot,
        );

        await manager.prepareHostForClose("host-2");
        manager.disposeHost("host-2");

        const reopenedTargetHost = createHostWindow();
        manager.syncHost(
            reopenedTargetHost.window,
            targetContext,
            targetSnapshot,
        );
        const movingContext = sourceSnapshot.contexts[0];
        if (!movingContext) {
            throw new Error("Expected a moving context.");
        }
        const committedTarget: WorkspaceNavigationSnapshot = {
            activeContextKey: movingContext.key,
            contexts: [...targetSnapshot.contexts, movingContext],
            openContextKeys: [
                ...targetSnapshot.openContextKeys,
                movingContext.key,
            ],
            version: 3,
        };

        await expect(
            manager.transferSurface({
                commit: () =>
                    Promise.resolve({
                        source: createWindowWorkspaceRestoreRecord(
                            singleContextSnapshot(
                                "project-b::__primary__",
                                "project-b",
                            ),
                            2,
                        ),
                        target: createWindowWorkspaceRestoreRecord(
                            committedTarget,
                            2,
                        ),
                    }),
                contextKey: movingContext.key,
                sourceHostWindowId: "host-1",
                targetHostWindowId: "host-2",
            }),
        ).resolves.toMatchObject({
            targetSnapshot: committedTarget,
        });
        expect(
            manager.getSurfaceWebContents("host-2", movingContext.key),
        ).not.toBeNull();
    });

    it("does not let delayed disposal remove a replacement host generation", async () => {
        const manager = new WorkspaceSurfaceManager();
        const sourceHost = createHostWindow();
        const oldTargetHost = createHostWindow();
        const sourceSnapshot = createSnapshot();
        const oldTargetSnapshot = singleContextSnapshot(
            "project-c::__primary__",
            "project-c",
        );
        const targetContext = {
            ...createHostContext(),
            projectId: "project-c",
            windowId: "host-2",
            workspaceId: "workspace-2",
            workspaceSessionId: "workspace-session-2",
        };
        manager.syncHost(sourceHost.window, createHostContext(), sourceSnapshot);
        manager.syncHost(
            oldTargetHost.window,
            targetContext,
            oldTargetSnapshot,
        );
        const movingContext = sourceSnapshot.contexts[0];
        if (!movingContext) {
            throw new Error("Expected a moving context.");
        }
        const committedTarget: WorkspaceNavigationSnapshot = {
            activeContextKey: movingContext.key,
            contexts: [...oldTargetSnapshot.contexts, movingContext],
            openContextKeys: [
                ...oldTargetSnapshot.openContextKeys,
                movingContext.key,
            ],
            version: 3,
        };
        const deferredCommit = createDeferred({
            source: createWindowWorkspaceRestoreRecord(
                singleContextSnapshot(
                    "project-b::__primary__",
                    "project-b",
                ),
                2,
            ),
            target: createWindowWorkspaceRestoreRecord(committedTarget, 2),
        });
        const transfer = manager.transferSurface({
            commit: () => deferredCommit.promise,
            contextKey: movingContext.key,
            sourceHostWindowId: "host-1",
            targetHostWindowId: "host-2",
        });

        manager.disposeHost("host-2");
        const replacementHost = createHostWindow();
        const replacementSnapshot = singleContextSnapshot(
            "project-d::__primary__",
            "project-d",
        );
        manager.syncHost(
            replacementHost.window,
            {
                ...targetContext,
                projectId: "project-d",
                workspaceSessionId: "workspace-session-2-reopened",
            },
            replacementSnapshot,
        );
        await manager.prepareHostForClose(
            "host-2",
            oldTargetHost.window,
        );
        manager.disposeHost("host-2", oldTargetHost.window);

        deferredCommit.resolve();
        await transfer;
        await Promise.resolve();

        expect(manager.getHostSnapshotForWindow("host-2")).toEqual(
            replacementSnapshot,
        );
        expect(
            manager.getSurfaceWebContents(
                "host-2",
                "project-d::__primary__",
            ),
        ).not.toBeNull();
    });

    it("keeps committed ownership when presentation refresh fails", async () => {
        const manager = new WorkspaceSurfaceManager();
        const sourceHost = createHostWindow();
        const targetHost = createHostWindow();
        const sourceSnapshot = createSnapshot();
        const targetSnapshot = singleContextSnapshot(
            "project-c::__primary__",
            "project-c",
        );
        manager.syncHost(sourceHost.window, createHostContext(), sourceSnapshot);
        manager.syncHost(
            targetHost.window,
            {
                ...createHostContext(),
                projectId: "project-c",
                windowId: "host-2",
                workspaceId: "workspace-2",
                workspaceSessionId: "workspace-session-2",
            },
            targetSnapshot,
        );
        const movingContext = sourceSnapshot.contexts[0];
        if (!movingContext) {
            throw new Error("Expected a moving context.");
        }
        const committedTarget: WorkspaceNavigationSnapshot = {
            activeContextKey: movingContext.key,
            contexts: [...targetSnapshot.contexts, movingContext],
            openContextKeys: [
                ...targetSnapshot.openContextKeys,
                movingContext.key,
            ],
            version: 3,
        };
        targetHost.getContentBounds.mockImplementation(() => {
            throw new Error("layout failed");
        });
        const consoleError = vi
            .spyOn(console, "error")
            .mockImplementation(() => undefined);

        const result = await manager.transferSurface({
            commit: () =>
                Promise.resolve({
                    source: createWindowWorkspaceRestoreRecord(
                        singleContextSnapshot(
                            "project-b::__primary__",
                            "project-b",
                        ),
                        2,
                    ),
                    target: createWindowWorkspaceRestoreRecord(
                        committedTarget,
                        2,
                    ),
                }),
            contextKey: movingContext.key,
            sourceHostWindowId: "host-1",
            targetHostWindowId: "host-2",
        });

        expect(typeof result.surfaceId).toBe("string");
        expect(
            manager.getSurfaceWebContents("host-1", movingContext.key),
        ).toBeNull();
        expect(
            manager.getSurfaceWebContents("host-2", movingContext.key),
        ).not.toBeNull();
        expect(consoleError).toHaveBeenCalledWith(
            "[workspace] Failed to refresh surfaces after a committed transfer",
            expect.any(Error),
        );
        consoleError.mockRestore();
    });
});

function createHostWindow(): {
    readonly getContentBounds: ReturnType<typeof vi.fn>;
    readonly send: ReturnType<typeof vi.fn>;
    readonly window: BrowserWindow;
} {
    const send = vi.fn();
    const getContentBounds = vi.fn(() => ({
        height: 800,
        width: 1200,
        x: 0,
        y: 0,
    }));
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
        getContentBounds,
        isDestroyed: () => false,
        on: vi.fn(),
        webContents,
    } as unknown as BrowserWindow;
    return { getContentBounds, send, window };
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

function singleContextSnapshot(
    contextKey: string,
    projectId: string,
): WorkspaceNavigationSnapshot {
    return {
        activeContextKey: contextKey,
        contexts: [createPersistedContext(contextKey, projectId)],
        openContextKeys: [contextKey],
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

function createDeferred<T>(value: T): {
    readonly promise: Promise<T>;
    readonly resolve: () => void;
} {
    let resolvePromise: ((value: T) => void) | null = null;
    const promise = new Promise<T>((resolve) => {
        resolvePromise = resolve;
    });
    return {
        promise,
        resolve: () => {
            if (!resolvePromise) {
                throw new Error("Deferred promise was not initialized.");
            }
            resolvePromise(value);
        },
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
