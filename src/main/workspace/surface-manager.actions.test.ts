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
        readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
        destroyed = false;

        readonly close = vi.fn(() => {
            this.destroyed = true;
            this.emit("destroyed");
        });

        isDestroyed(): boolean {
            return this.destroyed;
        }

        on(event: string, listener: (...args: unknown[]) => void): this {
            const listeners = this.listeners.get(event) ?? new Set();
            listeners.add(listener);
            this.listeners.set(event, listeners);
            return this;
        }

        once(event: string, listener: (...args: unknown[]) => void): this {
            const onceListener = (...args: unknown[]) => {
                this.listeners.get(event)?.delete(onceListener);
                listener(...args);
            };
            this.on(event, onceListener);
            return this;
        }

        emit(event: string, ...args: unknown[]): void {
            for (const listener of [...(this.listeners.get(event) ?? [])]) {
                listener(...args);
            }
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
import { loadRendererContents } from "@main/window";

describe("WorkspaceSurfaceManager action routing", () => {
    beforeEach(() => {
        electronMocks.reset();
        vi.mocked(loadRendererContents).mockClear();
    });

    it("binds only the cold-restored active renderer to one scope and generation", () => {
        const manager = new WorkspaceSurfaceManager();
        manager.syncHost(
            createHostWindow().window,
            createHostContext(),
            createSnapshot(),
        );

        const searches = vi
            .mocked(loadRendererContents)
            .mock.calls.map(([, search]) => new URLSearchParams(search));
        expect(searches).toHaveLength(1);
        expect(searches[0]?.get("window")).toBe("workspace-surface");
        expect(searches[0]?.get("scope")).toBe(
            "project-a::__primary__",
        );
        expect(searches[0]?.get("project")).toBe("project-a");
        expect(searches[0]?.get("surface")).toBeTruthy();
        expect(searches[0]?.get("runtime-owner")).toBe(
            "workspace-runtime:project-a::__primary__",
        );
    });

    it("recreates a surface with the same runtime owner and a new subscriber", async () => {
        const manager = new WorkspaceSurfaceManager();
        const onSurfaceCreated = vi.fn();
        const onSurfaceDestroyed = vi.fn();
        manager.setLifecycleHandlers({
            onSurfaceCreated,
            onSurfaceDestroyed,
            persistHostSnapshot: () => Promise.resolve(),
            prepareSurfaceHibernate: (subscriber) =>
                Promise.resolve(
                    manager.getSurfaceSnapshot(subscriber.webContents)!,
                ),
            resolveRuntimeOwner: () => ({
                revision: 7,
                runtimeOwnerId: "durable-runtime-owner",
            }),
        });
        const host = createHostWindow();
        const activeSnapshot = singleContextSnapshot(
            "project-a::__primary__",
            "project-a",
        );
        manager.syncHost(host.window, createHostContext(), activeSnapshot);
        const firstSurface = electronMocks.views[0];
        if (!firstSurface) {
            throw new Error("Expected the first surface.");
        }
        firstSurface.webContents.emit("did-finish-load");
        notifySurfaceReady(manager, firstSurface.webContents);
        await vi.waitFor(() =>
            expect(
                manager
                    .getSurfaceDiagnostics("host-1")
                    .surfaces.find(
                        (surface) =>
                            surface.scopeKey === "project-a::__primary__",
                    )?.state,
            ).toBe("active"),
        );
        const firstBinding = manager.getSurfaceRuntimeSubscriber(
            asWebContents(firstSurface.webContents),
        );

        await expect(
            manager.closeWorkspaceSurface(
                "host-1",
                "project-a::__primary__",
            ),
        ).resolves.toMatchObject({ status: "closed" });
        manager.syncHost(host.window, createHostContext(), activeSnapshot);
        const secondSurface = electronMocks.views[1];
        if (!secondSurface) {
            throw new Error("Expected the recreated surface.");
        }
        secondSurface.webContents.emit("did-finish-load");
        const secondBinding = manager.getSurfaceRuntimeSubscriber(
            asWebContents(secondSurface.webContents),
        );

        expect(firstBinding?.runtimeOwnerId).toBe("durable-runtime-owner");
        expect(secondBinding?.runtimeOwnerId).toBe("durable-runtime-owner");
        expect(secondBinding?.generation).not.toBe(firstBinding?.generation);
        expect(onSurfaceDestroyed).toHaveBeenCalledWith(
            expect.objectContaining({
                generation: firstBinding?.generation,
                runtimeOwnerId: "durable-runtime-owner",
            }),
        );
        expect(onSurfaceCreated).toHaveBeenLastCalledWith(
            expect.objectContaining({
                generation: secondBinding?.generation,
                runtimeOwnerId: "durable-runtime-owner",
            }),
        );
        expect(
            vi.mocked(loadRendererContents).mock.calls.at(-1)?.[1],
        ).toContain("revision=7");
    });

    it("does not create one renderer per catalog row", async () => {
        const manager = new WorkspaceSurfaceManager();
        const contexts = Array.from({ length: 250 }, (_, index) =>
            createPersistedContext(
                `project-${index}::__primary__`,
                `project-${index}`,
            ),
        );
        manager.syncHost(createHostWindow().window, createHostContext(), {
            activeContextKey: contexts[0]?.key ?? null,
            contexts,
            openContextKeys: contexts.map((context) => context.key),
            version: 3,
        });

        expect(electronMocks.views).toHaveLength(1);
        expect(manager.getSurfaceDiagnostics("host-1").surfaces).toHaveLength(250);
        await vi.waitFor(() =>
            expect(
                manager
                    .getSurfaceDiagnostics("host-1")
                    .surfaces.filter((surface) => surface.generation !== null),
            ).toHaveLength(1),
        );
    });

    it("keeps the committed surface visible when a cold restore fails", async () => {
        const manager = new WorkspaceSurfaceManager();
        const host = createHostWindow();
        manager.syncHost(host.window, createHostContext(), createSnapshot());
        await finishActiveSurface(
            manager,
            "host-1",
            "project-a::__primary__",
        );
        const firstSurface = electronMocks.views[0];

        const activation = manager.activate(
            "host-1",
            "project-b::__primary__",
        );
        const failedSurface = electronMocks.views[1];
        const binding = manager.getSurfaceRuntimeSubscriber(
            asWebContents(failedSurface.webContents),
        );
        if (!binding) {
            throw new Error("Expected a bound cold surface.");
        }
        manager.notifySurfaceRestoreFailed(
            asWebContents(failedSurface.webContents),
            binding,
            "restore failed",
        );

        await expect(activation).resolves.toEqual({
            message: "restore failed",
            scopeKey: "project-b::__primary__",
            status: "failed",
        });
        expect(manager.getActiveContext("host-1")?.key).toBe(
            "project-a::__primary__",
        );
        expect(firstSurface.setVisible).toHaveBeenLastCalledWith(true);
        expect(failedSurface.webContents.close).toHaveBeenCalledOnce();
    });

    it("blocks close on renderer leases and preserves the durable row", async () => {
        const manager = new WorkspaceSurfaceManager();
        manager.setLifecycleHandlers({
            persistHostSnapshot: () => Promise.resolve(),
            prepareSurfaceHibernate: (subscriber) =>
                Promise.resolve(
                    manager.getSurfaceSnapshot(subscriber.webContents)!,
                ),
        });
        const host = createHostWindow();
        manager.syncHost(host.window, createHostContext(), createSnapshot());
        await finishActiveSurface(
            manager,
            "host-1",
            "project-a::__primary__",
        );
        const surface = manager.getSurfaceWebContents(
            "host-1",
            "project-a::__primary__",
        );
        const binding = surface
            ? manager.getSurfaceRuntimeSubscriber(surface)
            : null;
        if (!surface || !binding) {
            throw new Error("Expected an active surface binding.");
        }
        manager.reportSurfaceLeases(surface, {
            ...binding,
            leases: [
                {
                    acquiredAt: "2026-08-01T00:00:00.000Z",
                    id: "dirty:file-a",
                    kind: "dirty-file",
                    message: "A file has unsaved changes.",
                },
            ],
        });

        await expect(
            manager.closeWorkspaceSurface(
                "host-1",
                "project-a::__primary__",
            ),
        ).resolves.toMatchObject({
            leases: [expect.objectContaining({ kind: "dirty-file" })],
            status: "blocked",
        });
        expect(manager.getSurfaceWebContents("host-1", binding.scopeKey)).toBe(
            surface,
        );
        expect(
            manager
                .getHostSnapshotForWindow("host-1")
                ?.contexts.some((context) => context.key === binding.scopeKey),
        ).toBe(true);
    });

    it("recreates one host from active, warm and cold metadata without eager restore", async () => {
        const manager = new WorkspaceSurfaceManager();
        const firstHost = createHostWindow();
        const snapshot = createSnapshot();
        manager.syncHost(firstHost.window, createHostContext(), snapshot);
        await finishActiveSurface(
            manager,
            "host-1",
            "project-a::__primary__",
        );
        const activation = manager.activate(
            "host-1",
            "project-b::__primary__",
        );
        notifySurfaceReady(
            manager,
            manager.getSurfaceWebContents(
                "host-1",
                "project-b::__primary__",
            ),
        );
        await activation;
        expect(electronMocks.views).toHaveLength(2);

        manager.disposeHost("host-1", firstHost.window);
        const secondHost = createHostWindow();
        manager.syncHost(secondHost.window, createHostContext(), {
            ...snapshot,
            activeContextKey: "project-b::__primary__",
        });

        expect(electronMocks.views).toHaveLength(3);
        const recreatedSearch = new URLSearchParams(
            vi.mocked(loadRendererContents).mock.calls.at(-1)?.[1],
        );
        expect(recreatedSearch.get("scope")).toBe("project-b::__primary__");
        expect(recreatedSearch.get("runtime-owner")).toBe(
            "workspace-runtime:project-b::__primary__",
        );
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

    it("delivers only to the active surface and rejects stale scopes", async () => {
        const manager = new WorkspaceSurfaceManager();
        const host = createHostWindow();
        const snapshot = createSnapshot();
        manager.syncHost(host.window, createHostContext(), snapshot);

        const [surfaceA] = electronMocks.views;
        expect(surfaceA).toBeDefined();

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

        notifySurfaceReady(manager, surfaceA.webContents);
        expect(surfaceA.webContents.send).toHaveBeenCalledWith(
            IPC_EVENTS.workspaceSurfaceActionRequested,
            {
                actionId: queuedActionA.actionId,
                request: actionA,
            },
        );
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

        await manager.activate("host-1", "project-a::__primary__");
        const activationB = manager.activate(
            "host-1",
            "project-b::__primary__",
        );
        const surfaceB = electronMocks.views[1];
        expect(surfaceB).toBeDefined();
        notifySurfaceReady(manager, surfaceB.webContents);
        await activationB;
        expect(manager.dispatchActiveSurfaceAction("host-1", actionA)).toEqual({
            delivered: false,
            reason: "inactive-context",
        });
        expect(surfaceA.webContents.send).toHaveBeenCalledTimes(1);
        expect(surfaceB.webContents.send).not.toHaveBeenCalled();

        const actionB = createFileAction("project-b::__primary__", "project-b");
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

    it("rejects a queued action when its context becomes inactive", async () => {
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

        const activationB = manager.activate(
            "host-1",
            "project-b::__primary__",
        );
        const surfaceB = electronMocks.views[1];
        notifySurfaceReady(manager, surfaceB.webContents);
        await activationB;
        notifySurfaceReady(manager, surfaceA.webContents);
        await Promise.resolve();

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

    it("reveals a surface file only through its active host context", async () => {
        const manager = new WorkspaceSurfaceManager();
        const host = createHostWindow();
        manager.syncHost(host.window, createHostContext(), createSnapshot());
        const [surfaceA] = electronMocks.views;
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

        const activationB = manager.activate(
            "host-1",
            "project-b::__primary__",
        );
        const surfaceB = electronMocks.views[1];
        notifySurfaceReady(manager, surfaceB.webContents);
        await activationB;
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

    it("resolves historical duplicates deterministically", async () => {
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

        const activationB = manager.activate(
            "host-1",
            "project-b::__primary__",
        );
        notifySurfaceReady(manager, electronMocks.views.at(-1)?.webContents);
        await activationB;
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
        await finishActiveSurface(
            manager,
            "host-1",
            "project-a::__primary__",
        );
        await finishActiveSurface(
            manager,
            "host-2",
            "project-c::__primary__",
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

function notifySurfaceReady(
    manager: WorkspaceSurfaceManager,
    value: unknown,
): void {
    const webContents = asWebContents(value);
    const binding = manager.getSurfaceRuntimeSubscriber(webContents);
    if (!binding) {
        throw new Error("Expected a bound workspace surface.");
    }
    manager.notifySurfaceReady(webContents, binding);
}

async function finishActiveSurface(
    manager: WorkspaceSurfaceManager,
    hostWindowId: string,
    scopeKey: string,
): Promise<void> {
    const webContents = manager.getSurfaceWebContents(hostWindowId, scopeKey);
    if (!webContents) {
        throw new Error(`Expected a resident surface for ${scopeKey}.`);
    }
    (webContents as unknown as { emit(event: string): void }).emit(
        "did-finish-load",
    );
    notifySurfaceReady(manager, webContents);
    await vi.waitFor(() =>
        expect(
            manager
                .getSurfaceDiagnostics(hostWindowId)
                .surfaces.find((surface) => surface.scopeKey === scopeKey)?.state,
        ).toBe("active"),
    );
}
