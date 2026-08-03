import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BrowserWindow, WebContents } from "electron";
import { IPC_EVENTS } from "@shared/ipc";
import type {
    WindowContextSnapshot,
    WorkspaceLayoutSnapshot,
    WorkspaceSurfaceEnvironmentDiagnostic,
    WorkspaceSurfaceRegistrySnapshot,
    WorkspaceSurfaceActionRequest,
    WorkspaceSurfaceActiveFileState,
    WorkspaceSurfaceDragEvent,
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
        readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
        destroyed = false;

        readonly close = vi.fn(() => {
            this.destroyed = true;
            this.emit("destroyed");
        });

        isDestroyed(): boolean {
            return this.destroyed;
        }

        getOSProcessId(): number {
            return this.id + 1_000;
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
    app: {
        getAppMetrics: () =>
            electronMocks.views.map((view) => ({
                cpu: { idleWakeupsPerSecond: 0, percentCPUUsage: 0 },
                creationTime: 0,
                memory: {
                    peakWorkingSetSize: 96_000,
                    privateBytes: 64_000,
                    workingSetSize: 80_000,
                },
                pid: view.webContents.getOSProcessId(),
                type: "Tab",
            })),
    },
    BrowserWindow: class {},
    powerMonitor: {
        isOnBatteryPower: () => false,
    },
    WebContentsView: electronMocks.FakeView,
}));

vi.mock("@main/window", () => ({
    DESKTOP_TITLE_BAR_HEIGHT: 52,
    getRendererPreloadPath: () => "/tmp/preload.js",
    installWindowOpenHandler: vi.fn(),
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
        const manager = createTestManager();
        manager.syncWorkspaceRegistry(
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

    it("temporarily hides the active surface while the host palette is visible", () => {
        const manager = createTestManager();
        manager.syncWorkspaceRegistry(
            createHostWindow().window,
            createHostContext(),
            createSnapshot(),
        );
        const surface = electronMocks.views[0];
        if (!surface) {
            throw new Error("Expected an active surface.");
        }

        manager.setHostOverlayVisible("host-1", true);
        expect(surface.setVisible).toHaveBeenLastCalledWith(false);

        manager.setHostOverlayVisible("host-1", false);
        expect(surface.setVisible).toHaveBeenLastCalledWith(true);
        expect(surface.webContents.close).not.toHaveBeenCalled();
        expect(electronMocks.views).toHaveLength(1);
    });

    it("keeps an opened background workspace runtime-active after switching", async () => {
        const manager = createTestManager();
        const onSurfaceLifecycleChanged = vi.fn();
        manager.setLifecycleHandlers({ onSurfaceLifecycleChanged });
        manager.syncWorkspaceRegistry(
            createHostWindow().window,
            createHostContext(),
            createSnapshot(),
        );
        await finishActiveSurface(manager, "host-1", "project-a::__primary__");
        onSurfaceLifecycleChanged.mockClear();

        const activation = manager.activate("host-1", "project-b::__primary__");
        await finishActiveSurface(manager, "host-1", "project-b::__primary__");
        await activation;

        expect(onSurfaceLifecycleChanged).not.toHaveBeenCalledWith(
            expect.objectContaining({ scopeKey: "project-a::__primary__" }),
            "suspended",
        );
    });

    it("delegates workspace shortcuts from the surface to singleton navigation", () => {
        const manager = createTestManager();
        const host = createHostWindow();
        manager.syncWorkspaceRegistry(host.window, createHostContext(), createSnapshot());
        const surface = electronMocks.views[0];
        if (!surface) {
            throw new Error("Expected an active surface.");
        }
        const preventDefault = vi.fn();

        surface.webContents.emit(
            "before-input-event",
            { preventDefault },
            {
                alt: true,
                code: "BracketRight",
                control: process.platform !== "darwin",
                key: "]",
                meta: process.platform === "darwin",
                shift: false,
                type: "keyDown",
            },
        );

        expect(preventDefault).toHaveBeenCalledOnce();
        expect(host.send).toHaveBeenCalledWith(
            IPC_EVENTS.workspaceNavigationRequested,
            "next",
        );
    });

    it("recreates a surface with the same runtime owner and a new subscriber", async () => {
        const manager = createTestManager();
        const onSurfaceCreated = vi.fn();
        const onSurfaceDestroyed = vi.fn();
        manager.setLifecycleHandlers({
            onSurfaceCreated,
            onSurfaceDestroyed,
            prepareSurfaceHibernate: () => Promise.resolve(),
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
        manager.syncWorkspaceRegistry(host.window, createHostContext(), activeSnapshot);
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
        manager.syncWorkspaceRegistry(host.window, createHostContext(), activeSnapshot);
        const recreation = manager.activate(
            "host-1",
            "project-a::__primary__",
        );
        const secondSurface = electronMocks.views[1];
        if (!secondSurface) {
            throw new Error("Expected the recreated surface.");
        }
        secondSurface.webContents.emit("did-finish-load");
        notifySurfaceReady(manager, secondSurface.webContents);
        await recreation;
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
        const manager = createTestManager();
        const workspaces = Array.from({ length: 250 }, (_, index) =>
            createRegistryEntry(
                `project-${index}::__primary__`,
                `project-${index}`,
            ),
        );
        manager.syncWorkspaceRegistry(createHostWindow().window, createHostContext(), {
            activeScopeKey: workspaces[0]?.scopeKey ?? null,
            workspaces,
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

    it("indexes hundreds of dense layouts while restoring only the active renderer", async () => {
        const manager = createTestManager();
        const workspaces = Array.from({ length: 500 }, (_, index) =>
            createDenseRegistryEntry(
                `project-${index}::__primary__`,
                `project-${index}`,
                96,
            ),
        );
        manager.syncWorkspaceRegistry(createHostWindow().window, createHostContext(), {
            activeScopeKey: workspaces[0]?.scopeKey ?? null,
            workspaces,
        });

        expect(electronMocks.views).toHaveLength(1);
        expect(manager.getSurfaceDiagnostics("host-1").performance).toMatchObject({
            catalogScopeCount: 500,
            catalogSyncs: 1,
            rendererCreates: 1,
        });
        await finishActiveSurface(manager, "host-1", workspaces[0].scopeKey);
        expect(
            manager
                .getSurfaceDiagnostics("host-1")
                .surfaces.filter((surface) => surface.generation !== null),
        ).toHaveLength(1);
    });

    it("keeps eight selected workspaces resident after their explicit leases end", async () => {
        const manager = new WorkspaceSurfaceManager({
            resolveEnvironment: createEnvironment,
        });
        manager.setLifecycleHandlers({
            prepareSurfaceHibernate: vi.fn(() => Promise.resolve()),
        });
        const workspaces = Array.from({ length: 8 }, (_, index) =>
            createDenseRegistryEntry(
                `project-${index}::__primary__`,
                `project-${index}`,
                120,
            ),
        );
        manager.syncWorkspaceRegistry(createHostWindow().window, createHostContext(), {
            activeScopeKey: workspaces[0].scopeKey,
            workspaces,
        });
        await finishActiveSurface(manager, "host-1", workspaces[0].scopeKey);
        const leaseKinds = [
            "ai-critical",
            "critical-modal",
            "terminal-busy",
            "dirty-file",
        ] as const;

        for (let index = 0; index < workspaces.length; index += 1) {
            const workspace = workspaces[index];
            if (index > 0) {
                const activation = manager.activate("host-1", workspace.scopeKey);
                notifySurfaceReady(
                    manager,
                    manager.getSurfaceWebContents("host-1", workspace.scopeKey),
                );
                await activation;
            }
            const webContents = manager.getSurfaceWebContents(
                "host-1",
                workspace.scopeKey,
            )!;
            const binding = manager.getSurfaceRuntimeSubscriber(webContents)!;
            expect(
                manager.reportSurfaceLeases(webContents, {
                    ...binding,
                    leases: [
                        {
                            acquiredAt: "2026-08-01T00:00:00.000Z",
                            id: `lease-${index}`,
                            kind: leaseKinds[index % leaseKinds.length],
                            message: "Explicit activity keeps this renderer resident.",
                        },
                    ],
                }),
            ).toBe(true);
        }

        expect(
            manager
                .getSurfaceDiagnostics("host-1")
                .surfaces.filter((surface) => surface.generation !== null),
        ).toHaveLength(8);

        for (const workspace of workspaces) {
            const webContents = manager.getSurfaceWebContents(
                "host-1",
                workspace.scopeKey,
            )!;
            const binding = manager.getSurfaceRuntimeSubscriber(webContents)!;
            manager.reportSurfaceLeases(webContents, { ...binding, leases: [] });
        }
        const activation = manager.activate("host-1", workspaces[0].scopeKey);
        await activation;

        const diagnostics = manager.getSurfaceDiagnostics("host-1");
        expect(
            diagnostics.surfaces.filter((surface) => surface.generation !== null),
        ).toHaveLength(8);
        expect(diagnostics.performance).toMatchObject({
            hibernations: 0,
            leaseReports: 16,
            rendererCreates: 8,
            rendererDestroys: 0,
        });
    });

    it("recovers the same durable scope after a renderer crash", async () => {
        const manager = createTestManager();
        manager.syncWorkspaceRegistry(
            createHostWindow().window,
            createHostContext(),
            createSnapshot(),
        );
        await finishActiveSurface(manager, "host-1", "project-a::__primary__");
        const crashed = electronMocks.views[0].webContents;
        crashed.send.mockImplementation(() => {
            throw new Error("Render frame was disposed.");
        });
        crashed.emit("render-process-gone");

        expect(
            manager
                .getSurfaceDiagnostics("host-1")
                .surfaces.find(
                    (surface) => surface.scopeKey === "project-a::__primary__",
                ),
        ).toMatchObject({ generation: null, state: "cold" });
        const restored = manager.activate("host-1", "project-a::__primary__");
        const replacement = manager.getSurfaceWebContents(
            "host-1",
            "project-a::__primary__",
        );
        notifySurfaceReady(manager, replacement);

        await expect(restored).resolves.toMatchObject({
            scopeKey: "project-a::__primary__",
            status: "activated",
            warm: false,
        });
        expect(manager.getSurfaceDiagnostics("host-1").performance).toMatchObject({
            failures: 1,
            rendererCreates: 2,
            rendererDestroys: 1,
        });
    });

    it("blocks an immediate close while restore is in flight and records it", async () => {
        const manager = createTestManager();
        manager.syncWorkspaceRegistry(
            createHostWindow().window,
            createHostContext(),
            createSnapshot(),
        );
        await finishActiveSurface(manager, "host-1", "project-a::__primary__");

        const activation = manager.activate("host-1", "project-b::__primary__");
        await expect(
            manager.closeWorkspaceSurface(
                "host-1",
                "project-b::__primary__",
            ),
        ).resolves.toMatchObject({ status: "blocked" });
        notifySurfaceReady(
            manager,
            manager.getSurfaceWebContents("host-1", "project-b::__primary__"),
        );
        await expect(activation).resolves.toMatchObject({ status: "activated" });

        const diagnostics = manager.getSurfaceDiagnostics("host-1");
        expect(diagnostics.performance.hibernationsAvoided).toBe(1);
        expect(
            diagnostics.surfaces.find(
                (surface) => surface.scopeKey === "project-b::__primary__",
            ),
        ).toMatchObject({ state: "active" });
    });

    it("samples renderer memory on demand without a recurring observer", async () => {
        const manager = createTestManager();
        manager.syncWorkspaceRegistry(
            createHostWindow().window,
            createHostContext(),
            createSnapshot(),
        );
        await finishActiveSurface(manager, "host-1", "project-a::__primary__");
        const webContents = manager.getSurfaceWebContents(
            "host-1",
            "project-a::__primary__",
        )!;
        manager.recordRuntimeResync(webContents, true);
        manager.recordRuntimeResync(webContents, false);

        const diagnostics = manager.sampleSurfaceMemory("host-1");

        expect(diagnostics.performance.memorySamples).toEqual([
            {
                privateKb: 64_000,
                residentSetKb: 80_000,
                scopeKey: "project-a::__primary__",
                sharedKb: null,
            },
        ]);
        expect(diagnostics.performance.memorySampledAt).not.toBeNull();
        expect(diagnostics.performance).toMatchObject({
            resyncFailures: 1,
            resyncs: 2,
        });
    });

    it("reuses renderers through rapid switches and resize bursts", async () => {
        const manager = createTestManager();
        const host = createHostWindow();
        manager.syncWorkspaceRegistry(
            host.window,
            createHostContext(),
            createSnapshot(),
        );
        await finishActiveSurface(manager, "host-1", "project-a::__primary__");
        const coldActivation = manager.activate(
            "host-1",
            "project-b::__primary__",
        );
        notifySurfaceReady(
            manager,
            manager.getSurfaceWebContents("host-1", "project-b::__primary__"),
        );
        await coldActivation;

        for (let index = 0; index < 100; index += 1) {
            const scopeKey =
                index % 2 === 0
                    ? "project-a::__primary__"
                    : "project-b::__primary__";
            await manager.activate("host-1", scopeKey);
            host.emit("resize");
        }
        host.getContentBounds.mockReturnValue({
            height: 820,
            width: 1_300,
            x: 0,
            y: 0,
        });
        host.emit("resize");
        await vi.waitFor(() =>
            expect(
                manager.getSurfaceDiagnostics("host-1").performance.boundsUpdates,
            ).toBeGreaterThan(2),
        );

        expect(manager.getSurfaceDiagnostics("host-1").performance).toMatchObject({
            cacheHits: 100,
            cacheMisses: 2,
            rendererCreates: 2,
            rendererDestroys: 0,
        });
        expect(electronMocks.views).toHaveLength(2);
    });

    it("does not let a delayed host registry sync revert committed navigation", async () => {
        const manager = createTestManager();
        const host = createHostWindow();
        manager.syncWorkspaceRegistry(
            host.window,
            createHostContext(),
            createSnapshot(),
        );
        await finishActiveSurface(manager, "host-1", "project-a::__primary__");
        const activation = manager.activate(
            "host-1",
            "project-b::__primary__",
        );
        notifySurfaceReady(
            manager,
            manager.getSurfaceWebContents("host-1", "project-b::__primary__"),
        );
        await activation;

        manager.syncWorkspaceRegistry(
            host.window,
            createHostContext(),
            createSnapshot(),
        );
        await Promise.resolve();

        expect(manager.getActiveContext("host-1")?.scopeKey).toBe(
            "project-b::__primary__",
        );
        expect(
            manager.getSurfaceDiagnostics("host-1").activeScopeKey,
        ).toBe("project-b::__primary__");
    });

    it("publishes the committed worktree context for host inspector focus", async () => {
        const manager = createTestManager();
        const host = createHostWindow();
        const worktreeScope = "project-a::worktree-feature";
        const snapshot = createSnapshot();
        manager.syncWorkspaceRegistry(host.window, createHostContext(), {
            ...snapshot,
            workspaces: [
                ...snapshot.workspaces,
                {
                    ...createRegistryEntry(worktreeScope, "project-a"),
                    worktreeId: "worktree-feature",
                },
            ],
        });
        await finishActiveSurface(
            manager,
            "host-1",
            "project-a::__primary__",
        );
        host.send.mockClear();

        const activation = manager.activate("host-1", worktreeScope);
        notifySurfaceReady(
            manager,
            manager.getSurfaceWebContents("host-1", worktreeScope),
        );
        await activation;

        expect(host.send).toHaveBeenCalledWith(
            IPC_EVENTS.workspaceSurfaceNavigationChanged,
            {
                activeScopeKey: worktreeScope,
                projectId: "project-a",
                worktreeId: "worktree-feature",
            },
        );
    });

    it("keeps the committed surface visible when a cold restore fails", async () => {
        const manager = createTestManager();
        const host = createHostWindow();
        manager.syncWorkspaceRegistry(host.window, createHostContext(), createSnapshot());
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
        expect(manager.getActiveContext("host-1")?.scopeKey).toBe(
            "project-a::__primary__",
        );
        expect(firstSurface.setVisible).toHaveBeenLastCalledWith(true);
        expect(failedSurface.webContents.close).toHaveBeenCalledOnce();
    });

    it("blocks close on renderer leases and preserves the durable row", async () => {
        const manager = createTestManager();
        manager.setLifecycleHandlers({
            prepareSurfaceHibernate: () => Promise.resolve(),
        });
        const host = createHostWindow();
        manager.syncWorkspaceRegistry(host.window, createHostContext(), createSnapshot());
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
        expect(manager.getSurfaceWebContents("host-1", binding.scopeKey)).toBe(
            surface,
        );
    });

    it("recreates one host from active, warm and cold metadata without eager restore", async () => {
        const manager = createTestManager();
        const firstHost = createHostWindow();
        const snapshot = createSnapshot();
        manager.syncWorkspaceRegistry(firstHost.window, createHostContext(), snapshot);
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
        manager.syncWorkspaceRegistry(secondHost.window, createHostContext(), {
            ...snapshot,
            activeScopeKey: "project-b::__primary__",
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

    it("applies top, left and right insets atomically only to the active surface", async () => {
        const manager = createTestManager();
        const host = createHostWindow();
        manager.syncWorkspaceRegistry(host.window, createHostContext(), createSnapshot());
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
        const activeSurface = electronMocks.views[1];
        notifySurfaceReady(manager, activeSurface?.webContents);
        await activation;
        firstSurface?.setBounds.mockClear();
        activeSurface?.setBounds.mockClear();

        manager.setContentInsets("host-1", {
            left: 281,
            right: 341,
            top: 52,
        });

        await vi.waitFor(() =>
            expect(activeSurface?.setBounds).toHaveBeenLastCalledWith({
                height: 748,
                width: 578,
                x: 281,
                y: 52,
            }),
        );
        expect(firstSurface?.setBounds).not.toHaveBeenCalled();
        expect(activeSurface?.setBounds).toHaveBeenCalledOnce();
    });

    it("keeps bounds aligned through drawer, zoom and fullscreen changes", async () => {
        const manager = createTestManager();
        const host = createHostWindow();
        manager.syncWorkspaceRegistry(host.window, createHostContext(), createSnapshot());
        await finishActiveSurface(
            manager,
            "host-1",
            "project-a::__primary__",
        );
        const surface = electronMocks.views[0];
        surface?.setBounds.mockClear();

        // Insets arrive already scaled by the host renderer's zoom factor.
        manager.setContentInsets("host-1", {
            left: 351.25,
            right: 426.25,
            top: 65,
        });
        await vi.waitFor(() =>
            expect(surface?.setBounds).toHaveBeenLastCalledWith({
                height: 735,
                width: 423,
                x: 351,
                y: 65,
            }),
        );

        manager.setContentInsets("host-1", { left: 0, right: 0, top: 65 });
        await vi.waitFor(() =>
            expect(surface?.setBounds).toHaveBeenLastCalledWith({
                height: 735,
                width: 1_200,
                x: 0,
                y: 65,
            }),
        );

        host.getContentBounds.mockReturnValue({
            height: 900,
            width: 1_480,
            x: 0,
            y: 0,
        });
        host.emit("enter-full-screen");
        await vi.waitFor(() =>
            expect(surface?.setBounds).toHaveBeenLastCalledWith({
                height: 835,
                width: 1_480,
                x: 0,
                y: 65,
            }),
        );

        host.getContentBounds.mockReturnValue({
            height: 820,
            width: 1_360,
            x: 2_100,
            y: 80,
        });
        host.emit("move");
        await vi.waitFor(() =>
            expect(surface?.setBounds).toHaveBeenLastCalledWith({
                height: 755,
                width: 1_360,
                x: 0,
                y: 65,
            }),
        );
    });

    it("waits until a new host renderer registers its surface container", async () => {
        const manager = createTestManager();
        const ready = manager.waitForHost("host-1", 100);

        manager.syncWorkspaceRegistry(
            createHostWindow().window,
            createHostContext(),
            createSnapshot(),
        );

        await expect(ready).resolves.toBe(true);
        await expect(manager.waitForHost("host-1", 100)).resolves.toBe(true);
    });

    it("delivers only to the active surface and rejects stale scopes", async () => {
        const manager = createTestManager();
        const host = createHostWindow();
        const snapshot = createSnapshot();
        manager.syncWorkspaceRegistry(host.window, createHostContext(), snapshot);

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
        const manager = createTestManager();
        const host = createHostWindow();
        manager.syncWorkspaceRegistry(host.window, createHostContext(), createSnapshot());
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

    it("delivers inspector drags only to the committed contextual surface", async () => {
        const manager = createTestManager();
        manager.syncWorkspaceRegistry(
            createHostWindow().window,
            createHostContext(),
            createSnapshot(),
        );
        const surfaceA = electronMocks.views[0];
        if (!surfaceA) {
            throw new Error("Expected the active surface.");
        }
        const dragA = {
            contextKey: "project-a::__primary__",
            detail: { phase: "move", x: 320, y: 180 },
            kind: "agent" as const,
            projectId: "project-a",
            worktreeId: null,
        };

        expect(manager.dispatchActiveSurfaceDrag("host-1", dragA)).toEqual({
            delivered: true,
        });
        expect(surfaceA.webContents.send).toHaveBeenCalledWith(
            IPC_EVENTS.workspaceSurfaceDrag,
            expect.objectContaining({
                contextKey: "project-a::__primary__",
                projectId: "project-a",
            }),
        );

        const activationB = manager.activate(
            "host-1",
            "project-b::__primary__",
        );
        const surfaceB = electronMocks.views[1];
        if (!surfaceB) {
            throw new Error("Expected the next surface.");
        }
        notifySurfaceReady(manager, surfaceB.webContents);
        await activationB;

        expect(manager.dispatchActiveSurfaceDrag("host-1", dragA)).toEqual({
            delivered: false,
            reason: "inactive-context",
        });
        expect(
            manager.dispatchActiveSurfaceDrag("host-1", {
                ...dragA,
                contextKey: "project-b::__primary__",
                projectId: "project-a",
            }),
        ).toEqual({ delivered: false, reason: "invalid-context" });
        expect(surfaceB.webContents.send).not.toHaveBeenCalledWith(
            IPC_EVENTS.workspaceSurfaceDrag,
            expect.anything(),
        );
    });

    it("translates drags from either sidebar across persistent panels and drawers", async () => {
        const manager = createTestManager();
        manager.syncWorkspaceRegistry(
            createHostWindow().window,
            createHostContext(),
            createSnapshot(),
        );
        const surface = electronMocks.views[0];
        if (!surface) {
            throw new Error("Expected the active surface.");
        }
        manager.setContentInsets("host-1", {
            left: 281,
            right: 341,
            top: 52,
        });
        await vi.waitFor(() =>
            expect(surface.setBounds).toHaveBeenLastCalledWith({
                height: 748,
                width: 578,
                x: 281,
                y: 52,
            }),
        );

        const drag = {
            contextKey: "project-a::__primary__",
            detail: { phase: "move", x: 700, y: 180 },
            kind: "agent" as const,
            projectId: "project-a",
            worktreeId: null,
        };
        expect(manager.dispatchActiveSurfaceDrag("host-1", drag)).toEqual({
            delivered: true,
        });
        const persistentPanelDrag = surface.webContents.send.mock.calls.at(
            -1,
        )?.[1] as WorkspaceSurfaceDragEvent | undefined;
        expect(persistentPanelDrag).toMatchObject({
            detail: { x: 419, y: 128 },
        });

        manager.setContentInsets("host-1", { left: 0, right: 0, top: 52 });
        await vi.waitFor(() =>
            expect(surface.setBounds).toHaveBeenLastCalledWith({
                height: 748,
                width: 1_200,
                x: 0,
                y: 52,
            }),
        );
        manager.setHostOverlayVisible("host-1", true);
        expect(
            manager.dispatchActiveSurfaceDrag("host-1", {
                ...drag,
                detail: { phase: "end", x: 700, y: 180 },
                kind: "github",
            }),
        ).toEqual({ delivered: true });
        const drawerDrag = surface.webContents.send.mock.calls.at(-1)?.[1] as
            | WorkspaceSurfaceDragEvent
            | undefined;
        expect(drawerDrag).toMatchObject({
            detail: { x: 700, y: 128 },
            kind: "github",
        });
    });

    it("translates drag coordinates between zoomed host and surface CSS pixels", async () => {
        const manager = createTestManager();
        manager.syncWorkspaceRegistry(
            createHostWindow(2).window,
            createHostContext(),
            createSnapshot(),
        );
        const surface = electronMocks.views[0];
        manager.setContentInsets("host-1", { left: 200, right: 0, top: 100 });
        await vi.waitFor(() =>
            expect(surface?.setBounds).toHaveBeenLastCalledWith(
                expect.objectContaining({ x: 200, y: 100 }),
            ),
        );

        manager.dispatchActiveSurfaceDrag("host-1", {
            contextKey: "project-a::__primary__",
            detail: { phase: "move", x: 300, y: 150 },
            kind: "agent",
            projectId: "project-a",
            worktreeId: null,
        });

        expect(surface?.webContents.send).toHaveBeenLastCalledWith(
            IPC_EVENTS.workspaceSurfaceDrag,
            expect.objectContaining({ detail: { phase: "move", x: 200, y: 100 } }),
        );
    });

    it("reveals a surface file only through its active host context", async () => {
        const manager = createTestManager();
        const host = createHostWindow();
        manager.syncWorkspaceRegistry(host.window, createHostContext(), createSnapshot());
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

    it("publishes and clears the active file through the current host context", () => {
        const manager = createTestManager();
        const host = createHostWindow();
        manager.syncWorkspaceRegistry(host.window, createHostContext(), createSnapshot());
        const [surfaceA] = electronMocks.views;
        const activeFile = createActiveFileState(
            "project-a::__primary__",
            "project-a",
            "src/index.ts",
        );

        expect(
            manager.publishSurfaceActiveFile(
                asWebContents(surfaceA.webContents),
                activeFile,
            ),
        ).toEqual({ delivered: true });
        expect(host.send).toHaveBeenCalledWith(
            IPC_EVENTS.workspaceSurfaceActiveFileChanged,
            activeFile,
        );

        const clearedFile = { ...activeFile, relativePath: null };
        expect(
            manager.publishSurfaceActiveFile(
                asWebContents(surfaceA.webContents),
                clearedFile,
            ),
        ).toEqual({ delivered: true });
        expect(host.send).toHaveBeenLastCalledWith(
            IPC_EVENTS.workspaceSurfaceActiveFileChanged,
            clearedFile,
        );
    });


});

function createTestManager(): WorkspaceSurfaceManager {
    return new WorkspaceSurfaceManager({
        resolveEnvironment: createEnvironment,
    });
}

function createHostWindow(zoomFactor = 1): {
    readonly emit: (event: string) => void;
    readonly getContentBounds: ReturnType<typeof vi.fn>;
    readonly send: ReturnType<typeof vi.fn>;
    readonly window: BrowserWindow;
} {
    const listeners = new Map<string, Set<() => void>>();
    const send = vi.fn();
    const getContentBounds = vi.fn(() => ({
        height: 800,
        width: 1200,
        x: 0,
        y: 0,
    }));
    const webContents = {
        getZoomFactor: () => zoomFactor,
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
        on: vi.fn((event: string, listener: () => void) => {
            const eventListeners = listeners.get(event) ?? new Set();
            eventListeners.add(listener);
            listeners.set(event, eventListeners);
        }),
        webContents,
    } as unknown as BrowserWindow;
    return {
        emit: (event) => {
            for (const listener of listeners.get(event) ?? []) {
                listener();
            }
        },
        getContentBounds,
        send,
        window,
    };
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

function createSnapshot(): WorkspaceSurfaceRegistrySnapshot {
    return {
        activeScopeKey: "project-a::__primary__",
        workspaces: [
            createRegistryEntry("project-a::__primary__", "project-a"),
            createRegistryEntry("project-b::__primary__", "project-b"),
        ],
    };
}

function singleContextSnapshot(
    contextKey: string,
    projectId: string,
): WorkspaceSurfaceRegistrySnapshot {
    return {
        activeScopeKey: contextKey,
        workspaces: [createRegistryEntry(contextKey, projectId)],
    };
}

function createRegistryEntry(scopeKey: string, projectId: string) {
    return {
        initialLayout: {
            activePaneId: `pane-${projectId}`,
            rootNode: {
                activeTabId: null,
                id: `pane-${projectId}`,
                tabIds: [],
                type: "pane" as const,
            },
            tabs: [],
        },
        lastActivatedAt: "2026-07-19T00:00:00.000Z",
        projectId,
        scopeKey,
        worktreeId: null,
    };
}

function createDenseRegistryEntry(
    scopeKey: string,
    projectId: string,
    tabCount: number,
): WorkspaceSurfaceRegistrySnapshot["workspaces"][number] {
    const tabs: WorkspaceLayoutSnapshot["tabs"][number][] = Array.from(
        { length: tabCount },
        (_, index) => {
            const common = {
                createdAt: "2026-08-01T00:00:00.000Z",
                id: `${scopeKey}:tab-${index}`,
                projectId,
                title: `Heavy tab ${index}`,
                worktreeId: null,
            };
            switch (index % 5) {
                case 0:
                    return {
                        ...common,
                        draft: "x".repeat(4_096),
                        kind: "chat",
                        runtimeId: "codex",
                        sessionId: `${scopeKey}:chat-${index}`,
                    };
                case 1:
                    return {
                        ...common,
                        kind: "git_worktree_diff",
                    };
                case 2:
                    return {
                        ...common,
                        kind: "git",
                    };
                case 3:
                    return {
                        ...common,
                        kind: "terminal",
                        sessionId: `${scopeKey}:terminal-${index}`,
                    };
                default:
                    return {
                        ...common,
                        kind: "file",
                        relativePath: `fixtures/tree-${index}/file-${index}.ts`,
                    };
            }
        },
    );
    return {
        initialLayout: {
            activePaneId: `pane-${projectId}`,
            rootNode: {
                activeTabId: tabs[0]?.id ?? null,
                id: `pane-${projectId}`,
                tabIds: tabs.map((tab) => tab.id),
                type: "pane",
            },
            tabs,
        },
        lastActivatedAt: "2026-07-19T00:00:00.000Z",
        projectId,
        scopeKey,
        worktreeId: null,
    };
}

function createEnvironment(): WorkspaceSurfaceEnvironmentDiagnostic {
    return {
        energySource: "external-power",
        platform: "darwin",
        totalMemoryMb: 32_768,
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

function createActiveFileState(
    contextKey: string,
    projectId: string,
    relativePath: string | null,
): WorkspaceSurfaceActiveFileState {
    return {
        contextKey,
        projectId,
        relativePath,
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
