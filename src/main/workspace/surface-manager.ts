import { randomUUID } from "node:crypto";

import {
    BrowserWindow,
    WebContentsView,
    type WebContents,
} from "electron";

import { IPC_EVENTS } from "@shared/ipc";
import type {
    WindowContextSnapshot,
    WorkspaceNavigationSnapshot,
} from "@shared/ipc";

import {
    DESKTOP_TITLE_BAR_HEIGHT,
    getRendererPreloadPath,
    loadRendererContents,
} from "@main/window";
import { windowRegistry } from "@main/windows/registry";

interface WorkspaceSurfaceRecord {
    readonly context: WindowContextSnapshot;
    readonly contextKey: string;
    readonly hostWindowId: string;
    readonly id: string;
    snapshot: WorkspaceNavigationSnapshot;
    readonly view: WebContentsView;
}

interface WorkspaceSurfaceHostRecord {
    activeContextKey: string | null;
    contentInset: number;
    readonly hostWindow: BrowserWindow;
    readonly hostWindowId: string;
    snapshot: WorkspaceNavigationSnapshot;
    readonly surfaceIdsByContextKey: Map<string, string>;
}

interface WorkspaceSurfaceLifecycleHandlers {
    readonly onSurfaceCreated?: (
        webContents: WebContents,
        ownerId: string,
    ) => void;
    readonly onSurfaceDestroyed?: (ownerId: string) => void;
}

/**
 * Keeps project workspaces alive in isolated WebContents while the host renderer
 * owns the visible title bar and project switcher.
 */
class WorkspaceSurfaceManager {
    readonly #hostsByWindowId = new Map<string, WorkspaceSurfaceHostRecord>();
    readonly #surfaceIdsByWebContentsId = new Map<number, string>();
    readonly #surfacesById = new Map<string, WorkspaceSurfaceRecord>();
    #lifecycleHandlers: WorkspaceSurfaceLifecycleHandlers = {};

    setLifecycleHandlers(handlers: WorkspaceSurfaceLifecycleHandlers): void {
        this.#lifecycleHandlers = handlers;
    }

    syncHost(
        hostWindow: BrowserWindow,
        hostContext: WindowContextSnapshot,
        snapshot: WorkspaceNavigationSnapshot,
    ): WorkspaceNavigationSnapshot {
        let host = this.#hostsByWindowId.get(hostContext.windowId);
        if (!host) {
            host = {
                activeContextKey: null,
                contentInset: DESKTOP_TITLE_BAR_HEIGHT,
                hostWindow,
                hostWindowId: hostContext.windowId,
                snapshot,
                surfaceIdsByContextKey: new Map(),
            };
            this.#hostsByWindowId.set(host.hostWindowId, host);
            const createdHost = host;
            hostWindow.on("resize", () => {
                this.#applyVisibility(createdHost);
            });
        }

        const openContextKeys = new Set(snapshot.openContextKeys);
        for (const [contextKey, surfaceId] of host.surfaceIdsByContextKey) {
            if (!openContextKeys.has(contextKey)) {
                this.#destroySurface(host, surfaceId);
            }
        }

        for (const contextKey of snapshot.openContextKeys) {
            const context = snapshot.contexts.find(
                (candidate) => candidate.key === contextKey,
            );
            if (!context) {
                continue;
            }

            const surfaceId = host.surfaceIdsByContextKey.get(contextKey);
            if (!surfaceId) {
                this.#createSurface(host, hostContext, contextKey, snapshot);
            }
        }

        host.activeContextKey =
            snapshot.activeContextKey && openContextKeys.has(snapshot.activeContextKey)
                ? snapshot.activeContextKey
                : (snapshot.openContextKeys[0] ?? null);
        host.snapshot = this.#mergeKnownSurfaceSnapshots(host, snapshot);
        this.#applyVisibility(host);
        return host.snapshot;
    }

    activate(hostWindowId: string, contextKey: string): boolean {
        const host = this.#hostsByWindowId.get(hostWindowId);
        if (!host || !host.surfaceIdsByContextKey.has(contextKey)) {
            return false;
        }

        host.activeContextKey = contextKey;
        host.snapshot = {
            ...host.snapshot,
            activeContextKey: contextKey,
        };
        this.#applyVisibility(host);
        return true;
    }

    setContentInset(hostWindowId: string, height: number): void {
        const host = this.#hostsByWindowId.get(hostWindowId);
        if (!host || !Number.isFinite(height)) {
            return;
        }

        host.contentInset = Math.max(0, Math.round(height));
        this.#applyVisibility(host);
    }

    setZoomFactor(zoomFactor: number): void {
        for (const surface of this.#surfacesById.values()) {
            if (!surface.view.webContents.isDestroyed()) {
                surface.view.webContents.setZoomFactor(zoomFactor);
            }
        }
    }

    getSurfaceSnapshot(
        webContents: WebContents,
    ): WorkspaceNavigationSnapshot | null {
        return this.#getSurfaceByWebContents(webContents)?.snapshot ?? null;
    }

    getSurfaceContext(webContents: WebContents): WindowContextSnapshot | null {
        return this.#getSurfaceByWebContents(webContents)?.context ?? null;
    }

    getHostSnapshot(webContents: WebContents): WorkspaceNavigationSnapshot | null {
        const surface = this.#getSurfaceByWebContents(webContents);
        if (!surface) {
            return null;
        }
        return this.#hostsByWindowId.get(surface.hostWindowId)?.snapshot ?? null;
    }

    mergeSurfaceSnapshot(
        webContents: WebContents,
        snapshot: WorkspaceNavigationSnapshot,
    ): {
        readonly hostWindowId: string;
        readonly snapshot: WorkspaceNavigationSnapshot;
    } | null {
        const surface = this.#getSurfaceByWebContents(webContents);
        if (!surface) {
            return null;
        }
        const host = this.#hostsByWindowId.get(surface.hostWindowId);
        if (!host) {
            return null;
        }

        const context = snapshot.contexts.find(
            (candidate) => candidate.key === surface.contextKey,
        );
        if (!context) {
            return null;
        }

        surface.snapshot = toSurfaceSnapshot(snapshot, surface.contextKey);
        host.snapshot = {
            ...host.snapshot,
            contexts: host.snapshot.contexts.map((candidate) =>
                candidate.key === surface.contextKey ? context : candidate,
            ),
        };
        return { hostWindowId: host.hostWindowId, snapshot: host.snapshot };
    }

    isSurface(webContents: WebContents): boolean {
        return this.#surfaceIdsByWebContentsId.has(webContents.id);
    }

    getActiveContext(
        hostWindowId: string,
    ): WorkspaceNavigationSnapshot["contexts"][number] | null {
        const host = this.#hostsByWindowId.get(hostWindowId);
        if (!host?.activeContextKey) {
            return null;
        }
        return (
            host.snapshot.contexts.find(
                (context) => context.key === host.activeContextKey,
            ) ?? null
        );
    }

    getActiveWebContents(hostWindowId: string): WebContents | null {
        const host = this.#hostsByWindowId.get(hostWindowId);
        const surfaceId = host?.activeContextKey
            ? host.surfaceIdsByContextKey.get(host.activeContextKey)
            : null;
        const surface = surfaceId ? this.#surfacesById.get(surfaceId) : null;
        return surface && !surface.view.webContents.isDestroyed()
            ? surface.view.webContents
            : null;
    }

    getWebContentsForHost(hostWindowId: string): readonly WebContents[] {
        const host = this.#hostsByWindowId.get(hostWindowId);
        if (!host) {
            return [];
        }
        return [...host.surfaceIdsByContextKey.values()].flatMap((surfaceId) => {
            const surface = this.#surfacesById.get(surfaceId);
            return surface && !surface.view.webContents.isDestroyed()
                ? [surface.view.webContents]
                : [];
        });
    }

    toggleSidebar(hostWindowId: string): void {
        for (const webContents of this.getWebContentsForHost(hostWindowId)) {
            webContents.send(IPC_EVENTS.workspaceSurfaceToggleSidebar);
        }
    }

    getHostWebContents(hostWindowId: string): WebContents | null {
        const host = this.#hostsByWindowId.get(hostWindowId);
        return host && !host.hostWindow.webContents.isDestroyed()
            ? host.hostWindow.webContents
            : null;
    }

    getHostWebContentsForOwner(ownerId: string): WebContents | null {
        const surface = this.#surfacesById.get(ownerId);
        return surface
            ? this.getHostWebContents(surface.hostWindowId)
            : null;
    }

    activateProject(
        projectId: string,
        worktreeId: string | null | undefined,
    ): BrowserWindow | null {
        for (const host of this.#hostsByWindowId.values()) {
            const context = host.snapshot.contexts.find(
                (candidate) =>
                    candidate.projectId === projectId &&
                    (worktreeId === undefined ||
                        candidate.worktreeId === worktreeId),
            );
            if (!context) {
                continue;
            }
            this.activate(host.hostWindowId, context.key);
            return host.hostWindow.isDestroyed() ? null : host.hostWindow;
        }
        return null;
    }

    disposeHost(hostWindowId: string): void {
        const host = this.#hostsByWindowId.get(hostWindowId);
        if (!host) {
            return;
        }
        for (const surfaceId of [...host.surfaceIdsByContextKey.values()]) {
            this.#destroySurface(host, surfaceId);
        }
        this.#hostsByWindowId.delete(hostWindowId);
    }

    #createSurface(
        host: WorkspaceSurfaceHostRecord,
        hostContext: WindowContextSnapshot,
        contextKey: string,
        hostSnapshot: WorkspaceNavigationSnapshot,
    ): void {
        const workspaceContext = hostSnapshot.contexts.find(
            (context) => context.key === contextKey,
        );
        if (!workspaceContext) {
            return;
        }

        const id = randomUUID();
        const view = new WebContentsView({
            webPreferences: {
                contextIsolation: true,
                nodeIntegration: false,
                preload: getRendererPreloadPath(),
            },
        });
        view.setVisible(false);
        view.webContents.setZoomFactor(
            host.hostWindow.webContents.getZoomFactor(),
        );
        host.hostWindow.contentView.addChildView(view);

        const context: WindowContextSnapshot = {
            hostWindowId: host.hostWindowId,
            projectId: workspaceContext.projectId,
            windowId: id,
            windowKind: "main",
            workspaceId: hostContext.workspaceId,
            workspaceSessionId: hostContext.workspaceSessionId,
            worktreeId: workspaceContext.worktreeId,
        };
        const surface: WorkspaceSurfaceRecord = {
            context,
            contextKey,
            hostWindowId: host.hostWindowId,
            id,
            snapshot: toSurfaceSnapshot(hostSnapshot, contextKey),
            view,
        };
        this.#surfacesById.set(id, surface);
        this.#surfaceIdsByWebContentsId.set(view.webContents.id, id);
        host.surfaceIdsByContextKey.set(contextKey, id);
        windowRegistry.registerEmbeddedRenderer(view.webContents, context);
        view.webContents.on("before-input-event", (event, input) => {
            const direction = resolveWorkspaceSurfaceSwitchDirection(input);
            if (!direction) {
                return;
            }

            const nextContextKey = getAdjacentContextKey(
                host.snapshot.openContextKeys,
                host.activeContextKey,
                direction,
            );
            if (!nextContextKey) {
                return;
            }

            event.preventDefault();
            this.activate(host.hostWindowId, nextContextKey);
            host.hostWindow.webContents.send(
                IPC_EVENTS.workspaceSurfaceSnapshotUpdated,
                host.snapshot,
            );
        });
        view.webContents.once("did-finish-load", () => {
            if (!view.webContents.isDestroyed()) {
                this.#lifecycleHandlers.onSurfaceCreated?.(view.webContents, id);
                this.#applyVisibility(host);
            }
        });
        view.webContents.once("destroyed", () => {
            windowRegistry.unregisterEmbeddedRenderer(view.webContents);
            this.#surfaceIdsByWebContentsId.delete(view.webContents.id);
        });
        loadRendererContents(view.webContents, `window=workspace-surface&surface=${id}`);
    }

    #destroySurface(host: WorkspaceSurfaceHostRecord, surfaceId: string): void {
        const surface = this.#surfacesById.get(surfaceId);
        if (!surface) {
            return;
        }

        host.surfaceIdsByContextKey.delete(surface.contextKey);
        this.#surfacesById.delete(surface.id);
        this.#surfaceIdsByWebContentsId.delete(surface.view.webContents.id);
        windowRegistry.unregisterEmbeddedRenderer(surface.view.webContents);
        this.#lifecycleHandlers.onSurfaceDestroyed?.(surface.id);
        if (!host.hostWindow.isDestroyed()) {
            host.hostWindow.contentView.removeChildView(surface.view);
        }
        if (!surface.view.webContents.isDestroyed()) {
            surface.view.webContents.close();
        }
    }

    #applyVisibility(host: WorkspaceSurfaceHostRecord): void {
        if (host.hostWindow.isDestroyed()) {
            return;
        }
        const bounds = host.hostWindow.getContentBounds();
        for (const [contextKey, surfaceId] of host.surfaceIdsByContextKey) {
            const surface = this.#surfacesById.get(surfaceId);
            if (!surface || surface.view.webContents.isDestroyed()) {
                continue;
            }
            const isActive = contextKey === host.activeContextKey;
            surface.view.setBounds({
                height: Math.max(0, bounds.height - host.contentInset),
                width: bounds.width,
                x: 0,
                y: host.contentInset,
            });
            surface.view.setVisible(isActive);
            if (isActive) {
                surface.view.webContents.focus();
            }
        }
    }

    #mergeKnownSurfaceSnapshots(
        host: WorkspaceSurfaceHostRecord,
        snapshot: WorkspaceNavigationSnapshot,
    ): WorkspaceNavigationSnapshot {
        return {
            ...snapshot,
            contexts: snapshot.contexts.map((context) => {
                const surfaceId = host.surfaceIdsByContextKey.get(context.key);
                const surface = surfaceId
                    ? this.#surfacesById.get(surfaceId)
                    : null;
                const latest = surface?.snapshot.contexts.find(
                    (candidate) => candidate.key === context.key,
                );
                return latest ?? context;
            }),
        };
    }

    #getSurfaceByWebContents(
        webContents: WebContents,
    ): WorkspaceSurfaceRecord | null {
        const surfaceId = this.#surfaceIdsByWebContentsId.get(webContents.id);
        return surfaceId ? (this.#surfacesById.get(surfaceId) ?? null) : null;
    }
}

function resolveWorkspaceSurfaceSwitchDirection(
    input: Electron.Input,
): "next" | "previous" | null {
    if (
        input.type !== "keyDown" ||
        input.shift ||
        !input.alt ||
        (process.platform === "darwin"
            ? !input.meta || input.control
            : !input.control || input.meta)
    ) {
        return null;
    }

    if (input.code === "BracketRight" || input.key === "]") {
        return "next";
    }
    if (input.code === "BracketLeft" || input.key === "[") {
        return "previous";
    }
    return null;
}

function getAdjacentContextKey(
    contextKeys: readonly string[],
    activeContextKey: string | null,
    direction: "next" | "previous",
): string | null {
    if (contextKeys.length < 2 || !activeContextKey) {
        return null;
    }
    const activeIndex = contextKeys.indexOf(activeContextKey);
    if (activeIndex < 0) {
        return null;
    }
    const targetIndex =
        direction === "next"
            ? (activeIndex + 1) % contextKeys.length
            : (activeIndex - 1 + contextKeys.length) % contextKeys.length;
    return contextKeys[targetIndex] ?? null;
}

function toSurfaceSnapshot(
    snapshot: WorkspaceNavigationSnapshot,
    contextKey: string,
): WorkspaceNavigationSnapshot {
    const context = snapshot.contexts.find(
        (candidate) => candidate.key === contextKey,
    );
    if (!context) {
        return {
            activeContextKey: null,
            contexts: [],
            openContextKeys: [],
            version: snapshot.version,
        };
    }
    return {
        activeContextKey: context.key,
        contexts: [context],
        openContextKeys: [context.key],
        version: snapshot.version,
    };
}

export const workspaceSurfaceManager = new WorkspaceSurfaceManager();
