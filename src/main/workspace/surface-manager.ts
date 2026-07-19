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
    WorkspaceSurfaceActionCompletion,
    WorkspaceSurfaceActionDeliveryFailureReason,
    WorkspaceSurfaceActionDeliveryResult,
    WorkspaceSurfaceActionDispatchResult,
    WorkspaceSurfaceActionEnvelope,
    WorkspaceSurfaceActionRequest,
    WorkspaceSurfaceActionStatus,
    WorkspaceSurfaceFileRevealRequest,
    WorkspaceSurfaceDragEvent,
} from "@shared/ipc";

import {
    DESKTOP_TITLE_BAR_HEIGHT,
    getRendererPreloadPath,
    loadRendererContents,
} from "@main/window";
import { windowRegistry } from "@main/windows/registry";
import {
    doesWorkspaceSurfaceContextMatchContext,
} from "./surface-actions";

interface WorkspaceSurfaceRecord {
    bounds: WorkspaceSurfaceBounds | null;
    readonly context: WindowContextSnapshot;
    readonly contextKey: string;
    readonly hostWindowId: string;
    readonly id: string;
    isVisible: boolean;
    isReady: boolean;
    readonly pendingActions: WorkspaceSurfaceActionEnvelope[];
    snapshot: WorkspaceNavigationSnapshot;
    readonly view: WebContentsView;
    readonly webContents: WebContents;
    readonly webContentsId: number;
}

interface WorkspaceSurfaceBounds {
    readonly height: number;
    readonly width: number;
    readonly x: number;
    readonly y: number;
}

interface WorkspaceSurfaceHostRecord {
    activeContextKey: string | null;
    contentInset: number;
    contentLeftInset: number;
    readonly hostWindow: BrowserWindow;
    readonly hostWindowId: string;
    pendingLayoutTimer: NodeJS.Timeout | null;
    snapshot: WorkspaceNavigationSnapshot;
    readonly surfaceIdsByContextKey: Map<string, string>;
}

interface DispatchedWorkspaceSurfaceAction {
    claimed: boolean;
    readonly envelope: WorkspaceSurfaceActionEnvelope;
    readonly hostWindowId: string;
    readonly surfaceId: string;
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
export class WorkspaceSurfaceManager {
    readonly #hostsByWindowId = new Map<string, WorkspaceSurfaceHostRecord>();
    readonly #surfaceIdsByWebContentsId = new Map<number, string>();
    readonly #surfacesById = new Map<string, WorkspaceSurfaceRecord>();
    readonly #actionsById = new Map<
        string,
        DispatchedWorkspaceSurfaceAction
    >();
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
                contentLeftInset: 0,
                hostWindow,
                hostWindowId: hostContext.windowId,
                pendingLayoutTimer: null,
                snapshot,
                surfaceIdsByContextKey: new Map(),
            };
            this.#hostsByWindowId.set(host.hostWindowId, host);
            const createdHost = host;
            hostWindow.on("resize", () => {
                this.#scheduleActiveSurfaceLayout(createdHost);
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

        const nextActiveContextKey =
            snapshot.activeContextKey && openContextKeys.has(snapshot.activeContextKey)
                ? snapshot.activeContextKey
                : (snapshot.openContextKeys[0] ?? null);
        const activeContextChanged =
            host.activeContextKey !== nextActiveContextKey;
        host.activeContextKey = nextActiveContextKey;
        host.snapshot = this.#mergeKnownSurfaceSnapshots(host, snapshot);
        this.#rejectInactiveActions(host);
        this.#applyVisibility(host, { focusActive: activeContextChanged });
        return host.snapshot;
    }

    activate(hostWindowId: string, contextKey: string): boolean {
        const host = this.#hostsByWindowId.get(hostWindowId);
        if (!host || !host.surfaceIdsByContextKey.has(contextKey)) {
            return false;
        }

        if (host.activeContextKey === contextKey) {
            return true;
        }

        host.activeContextKey = contextKey;
        host.snapshot = {
            ...host.snapshot,
            activeContextKey: contextKey,
        };
        this.#rejectInactiveActions(host);
        this.#applyVisibility(host, { focusActive: true });
        return true;
    }

    requestActiveGitScopeMenu(
        hostWindowId: string,
        anchor: { readonly width: number; readonly x: number },
    ): void {
        const host = this.#hostsByWindowId.get(hostWindowId);
        const surfaceId = host?.activeContextKey
            ? host.surfaceIdsByContextKey.get(host.activeContextKey)
            : null;
        const surface = surfaceId ? this.#surfacesById.get(surfaceId) : null;
        if (!surface || surface.webContents.isDestroyed()) {
            return;
        }

        surface.webContents.send(
            IPC_EVENTS.workspaceSurfaceGitScopeMenuRequested,
            anchor,
        );
    }

    requestActiveProjectMenu(hostWindowId: string): void {
        const host = this.#hostsByWindowId.get(hostWindowId);
        const surfaceId = host?.activeContextKey
            ? host.surfaceIdsByContextKey.get(host.activeContextKey)
            : null;
        const surface = surfaceId ? this.#surfacesById.get(surfaceId) : null;
        if (!surface || surface.webContents.isDestroyed()) {
            return;
        }

        surface.webContents.send(
            IPC_EVENTS.workspaceSurfaceProjectMenuRequested,
        );
    }

    dispatchActiveSurfaceAction(
        hostWindowId: string,
        request: WorkspaceSurfaceActionRequest,
    ): WorkspaceSurfaceActionDispatchResult {
        const host = this.#hostsByWindowId.get(hostWindowId);
        const surface = this.#getActiveSurface(hostWindowId);
        const failureReason = this.#getActionDeliveryFailure(
            host,
            surface,
            request,
        );
        if (failureReason || !host || !surface) {
            return {
                delivered: false,
                reason: failureReason ?? "missing-surface",
            };
        }
        const envelope: WorkspaceSurfaceActionEnvelope = {
            actionId: randomUUID(),
            request,
        };

        if (!surface.isReady) {
            surface.pendingActions.push(envelope);
            return { actionId: envelope.actionId, delivered: true, state: "queued" };
        }

        this.#sendAction(host, surface, envelope);
        return { actionId: envelope.actionId, delivered: true, state: "sent" };
    }

    notifySurfaceReady(webContents: WebContents): void {
        const surface = this.#getSurfaceByWebContents(webContents);
        if (!surface || surface.webContents.isDestroyed()) {
            return;
        }

        surface.isReady = true;
        const host = this.#hostsByWindowId.get(surface.hostWindowId);
        for (const envelope of surface.pendingActions.splice(0)) {
            const failureReason = this.#getActionDeliveryFailure(
                host,
                surface,
                envelope.request,
            );
            if (failureReason) {
                this.#notifyActionStatus(host, {
                    actionId: envelope.actionId,
                    message: getActionFailureMessage(failureReason),
                    status: "rejected",
                });
                continue;
            }
            this.#sendAction(host, surface, envelope);
        }
    }

    claimSurfaceAction(webContents: WebContents, actionId: string): boolean {
        const surface = this.#getSurfaceByWebContents(webContents);
        const action = this.#actionsById.get(actionId);
        if (!surface || !action || action.surfaceId !== surface.id || action.claimed) {
            return false;
        }
        const host = this.#hostsByWindowId.get(action.hostWindowId);
        const failureReason = this.#getActionDeliveryFailure(
            host,
            surface,
            action.envelope.request,
        );
        if (failureReason) {
            this.#actionsById.delete(actionId);
            this.#notifyActionStatus(host, {
                actionId,
                message: getActionFailureMessage(failureReason),
                status: "rejected",
            });
            return false;
        }
        action.claimed = true;
        return true;
    }

    completeSurfaceAction(
        webContents: WebContents,
        completion: WorkspaceSurfaceActionCompletion,
    ): void {
        const surface = this.#getSurfaceByWebContents(webContents);
        const action = this.#actionsById.get(completion.actionId);
        if (!surface || !action || action.surfaceId !== surface.id || !action.claimed) {
            return;
        }
        this.#actionsById.delete(completion.actionId);
        this.#notifyActionStatus(
            this.#hostsByWindowId.get(action.hostWindowId),
            completion.status === "completed"
                ? { actionId: completion.actionId, status: "completed" }
                : {
                      actionId: completion.actionId,
                      message: completion.error ?? "The workspace action failed.",
                      status: "failed",
                  },
        );
    }

    revealSurfaceFileInHostTree(
        webContents: WebContents,
        request: WorkspaceSurfaceFileRevealRequest,
    ): WorkspaceSurfaceActionDeliveryResult {
        const surface = this.#getSurfaceByWebContents(webContents);
        const host = surface
            ? this.#hostsByWindowId.get(surface.hostWindowId)
            : null;
        if (!surface || !host || surface.webContents.isDestroyed()) {
            return { delivered: false, reason: "missing-surface" };
        }
        if (host.activeContextKey !== request.contextKey) {
            return { delivered: false, reason: "inactive-context" };
        }
        const activeContext = host.snapshot.contexts.find(
            (context) => context.key === host.activeContextKey,
        );
        if (
            surface.contextKey !== request.contextKey ||
            !activeContext ||
            !doesWorkspaceSurfaceContextMatchContext(request, activeContext)
        ) {
            return { delivered: false, reason: "invalid-context" };
        }
        if (host.hostWindow.webContents.isDestroyed()) {
            return { delivered: false, reason: "missing-surface" };
        }

        host.hostWindow.webContents.send(
            IPC_EVENTS.workspaceSurfaceFileRevealRequested,
            request,
        );
        return { delivered: true };
    }

    dispatchActiveSurfaceDrag(
        hostWindowId: string,
        event: WorkspaceSurfaceDragEvent,
    ): void {
        const surface = this.#getActiveSurface(hostWindowId);
        if (!surface || surface.webContents.isDestroyed()) {
            return;
        }

        const bounds = surface.bounds;
        const detail = event.detail as Record<string, unknown>;
        const x = detail.x;
        const y = detail.y;
        const translatedDetail =
            bounds && typeof x === "number" && typeof y === "number"
                ? { ...detail, x: x - bounds.x, y: y - bounds.y }
                : detail;
        surface.webContents.send(IPC_EVENTS.workspaceSurfaceDrag, {
            ...event,
            detail: translatedDetail,
        } satisfies WorkspaceSurfaceDragEvent);
    }

    setContentInset(hostWindowId: string, height: number): void {
        const host = this.#hostsByWindowId.get(hostWindowId);
        if (!host || !Number.isFinite(height)) {
            return;
        }

        const nextContentInset = Math.max(0, Math.round(height));
        if (host.contentInset === nextContentInset) {
            return;
        }

        host.contentInset = nextContentInset;
        this.#scheduleActiveSurfaceLayout(host);
    }

    setContentLeftInset(hostWindowId: string, width: number): void {
        const host = this.#hostsByWindowId.get(hostWindowId);
        if (!host || !Number.isFinite(width)) {
            return;
        }

        const nextContentLeftInset = Math.max(0, Math.round(width));
        if (host.contentLeftInset === nextContentLeftInset) {
            return;
        }

        host.contentLeftInset = nextContentLeftInset;
        this.#scheduleActiveSurfaceLayout(host);
    }

    setZoomFactor(zoomFactor: number): void {
        for (const surface of this.#surfacesById.values()) {
            if (!surface.webContents.isDestroyed()) {
                surface.webContents.setZoomFactor(zoomFactor);
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

    getHostSnapshotForWindow(
        hostWindowId: string,
    ): WorkspaceNavigationSnapshot | null {
        return this.#hostsByWindowId.get(hostWindowId)?.snapshot ?? null;
    }

    getSurfaceWebContents(
        hostWindowId: string,
        contextKey: string,
    ): WebContents | null {
        const host = this.#hostsByWindowId.get(hostWindowId);
        const surfaceId = host?.surfaceIdsByContextKey.get(contextKey);
        const surface = surfaceId ? this.#surfacesById.get(surfaceId) : null;
        return surface && !surface.webContents.isDestroyed()
            ? surface.webContents
            : null;
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
        const surface = this.#getActiveSurface(hostWindowId);
        return surface && !surface.webContents.isDestroyed()
            ? surface.webContents
            : null;
    }

    getWebContentsForHost(hostWindowId: string): readonly WebContents[] {
        const host = this.#hostsByWindowId.get(hostWindowId);
        if (!host) {
            return [];
        }
        return [...host.surfaceIdsByContextKey.values()].flatMap((surfaceId) => {
            const surface = this.#surfacesById.get(surfaceId);
            return surface && !surface.webContents.isDestroyed()
                ? [surface.webContents]
                : [];
        });
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
        if (host.pendingLayoutTimer) {
            clearTimeout(host.pendingLayoutTimer);
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
        const webContents = view.webContents;
        const webContentsId = webContents.id;
        view.setVisible(false);
        webContents.setZoomFactor(
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
            bounds: null,
            context,
            contextKey,
            hostWindowId: host.hostWindowId,
            id,
            isVisible: false,
            isReady: false,
            pendingActions: [],
            snapshot: toSurfaceSnapshot(hostSnapshot, contextKey),
            view,
            webContents,
            webContentsId,
        };
        this.#surfacesById.set(id, surface);
        this.#surfaceIdsByWebContentsId.set(webContentsId, id);
        host.surfaceIdsByContextKey.set(contextKey, id);
        windowRegistry.registerEmbeddedRenderer(webContents, context);
        webContents.on("did-start-loading", () => {
            surface.isReady = false;
        });
        webContents.on("before-input-event", (event, input) => {
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
        webContents.once("did-finish-load", () => {
            if (!webContents.isDestroyed()) {
                this.#lifecycleHandlers.onSurfaceCreated?.(webContents, id);
                this.#applyVisibility(host);
            }
        });
        webContents.once("destroyed", () => {
            windowRegistry.unregisterEmbeddedRenderer(webContents);
            this.#surfaceIdsByWebContentsId.delete(webContentsId);
        });
        loadRendererContents(webContents, `window=workspace-surface&surface=${id}`);
    }

    #getActiveSurface(hostWindowId: string): WorkspaceSurfaceRecord | null {
        const host = this.#hostsByWindowId.get(hostWindowId);
        const surfaceId = host?.activeContextKey
            ? host.surfaceIdsByContextKey.get(host.activeContextKey)
            : null;
        return surfaceId ? (this.#surfacesById.get(surfaceId) ?? null) : null;
    }

    #destroySurface(host: WorkspaceSurfaceHostRecord, surfaceId: string): void {
        const surface = this.#surfacesById.get(surfaceId);
        if (!surface) {
            return;
        }

        for (const envelope of surface.pendingActions) {
            this.#notifyActionStatus(host, {
                actionId: envelope.actionId,
                message: "The workspace surface closed before the action could run.",
                status: "rejected",
            });
        }
        for (const [actionId, action] of this.#actionsById) {
            if (action.surfaceId !== surfaceId) {
                continue;
            }
            this.#actionsById.delete(actionId);
            this.#notifyActionStatus(host, {
                actionId,
                message: "The workspace surface closed before the action completed.",
                status: action.claimed ? "failed" : "rejected",
            });
        }

        host.surfaceIdsByContextKey.delete(surface.contextKey);
        this.#surfacesById.delete(surface.id);
        this.#surfaceIdsByWebContentsId.delete(surface.webContentsId);
        windowRegistry.unregisterEmbeddedRenderer(surface.webContents);
        this.#lifecycleHandlers.onSurfaceDestroyed?.(surface.id);
        if (!host.hostWindow.isDestroyed()) {
            host.hostWindow.contentView.removeChildView(surface.view);
        }
        if (!surface.webContents.isDestroyed()) {
            surface.webContents.close();
        }
    }

    #getActionDeliveryFailure(
        host: WorkspaceSurfaceHostRecord | undefined,
        surface: WorkspaceSurfaceRecord | null,
        request: WorkspaceSurfaceActionRequest,
    ): WorkspaceSurfaceActionDeliveryFailureReason | null {
        if (!host || !surface || surface.webContents.isDestroyed()) {
            return "missing-surface";
        }
        if (host.activeContextKey !== request.contextKey) {
            return "inactive-context";
        }
        const activeContext = host.snapshot.contexts.find(
            (context) => context.key === host.activeContextKey,
        );
        if (
            surface.contextKey !== request.contextKey ||
            !activeContext ||
            !doesWorkspaceSurfaceContextMatchContext(request, activeContext)
        ) {
            return "invalid-context";
        }
        return null;
    }

    #sendAction(
        host: WorkspaceSurfaceHostRecord | undefined,
        surface: WorkspaceSurfaceRecord,
        envelope: WorkspaceSurfaceActionEnvelope,
    ): void {
        if (!host || surface.webContents.isDestroyed()) {
            return;
        }
        this.#actionsById.set(envelope.actionId, {
            claimed: false,
            envelope,
            hostWindowId: host.hostWindowId,
            surfaceId: surface.id,
        });
        surface.webContents.send(
            IPC_EVENTS.workspaceSurfaceActionRequested,
            envelope,
        );
    }

    #rejectInactiveActions(host: WorkspaceSurfaceHostRecord): void {
        for (const surfaceId of host.surfaceIdsByContextKey.values()) {
            const surface = this.#surfacesById.get(surfaceId);
            if (!surface) {
                continue;
            }
            const activePendingActions = surface.pendingActions.filter(
                (envelope) => {
                    const failureReason = this.#getActionDeliveryFailure(
                        host,
                        surface,
                        envelope.request,
                    );
                    if (!failureReason) {
                        return true;
                    }
                    this.#notifyActionStatus(host, {
                        actionId: envelope.actionId,
                        message: getActionFailureMessage(failureReason),
                        status: "rejected",
                    });
                    return false;
                },
            );
            surface.pendingActions.splice(
                0,
                surface.pendingActions.length,
                ...activePendingActions,
            );
        }
        for (const [actionId, action] of this.#actionsById) {
            if (action.hostWindowId !== host.hostWindowId || action.claimed) {
                continue;
            }
            const surface = this.#surfacesById.get(action.surfaceId) ?? null;
            const failureReason = this.#getActionDeliveryFailure(
                host,
                surface,
                action.envelope.request,
            );
            if (!failureReason) {
                continue;
            }
            this.#actionsById.delete(actionId);
            this.#notifyActionStatus(host, {
                actionId,
                message: getActionFailureMessage(failureReason),
                status: "rejected",
            });
        }
    }

    #notifyActionStatus(
        host: WorkspaceSurfaceHostRecord | undefined,
        status: WorkspaceSurfaceActionStatus,
    ): void {
        if (!host || host.hostWindow.webContents.isDestroyed()) {
            return;
        }
        host.hostWindow.webContents.send(
            IPC_EVENTS.workspaceSurfaceActionStatus,
            status,
        );
    }

    #applyVisibility(
        host: WorkspaceSurfaceHostRecord,
        options: { readonly focusActive?: boolean } = {},
    ): void {
        if (host.hostWindow.isDestroyed()) {
            return;
        }
        const activeSurfaceId = host.activeContextKey
            ? host.surfaceIdsByContextKey.get(host.activeContextKey)
            : null;

        for (const [, surfaceId] of host.surfaceIdsByContextKey) {
            if (surfaceId === activeSurfaceId) {
                continue;
            }
            const surface = this.#surfacesById.get(surfaceId);
            if (!surface || surface.webContents.isDestroyed()) {
                continue;
            }
            if (surface.isVisible) {
                surface.view.setVisible(false);
                surface.isVisible = false;
            }
        }

        const activeSurface = activeSurfaceId
            ? this.#surfacesById.get(activeSurfaceId)
            : null;
        if (!activeSurface || activeSurface.webContents.isDestroyed()) {
            return;
        }

        const nextBounds = this.#getActiveSurfaceBounds(host);
        if (!areWorkspaceSurfaceBoundsEqual(activeSurface.bounds, nextBounds)) {
            activeSurface.view.setBounds(nextBounds);
            activeSurface.bounds = nextBounds;
        }
        if (!activeSurface.isVisible) {
            activeSurface.view.setVisible(true);
            activeSurface.isVisible = true;
        }
        if (options.focusActive) {
            activeSurface.webContents.focus();
        }
    }

    #getActiveSurfaceBounds(
        host: WorkspaceSurfaceHostRecord,
    ): WorkspaceSurfaceBounds {
        const bounds = host.hostWindow.getContentBounds();
        return {
            height: Math.max(0, bounds.height - host.contentInset),
            width: Math.max(0, bounds.width - host.contentLeftInset),
            x: host.contentLeftInset,
            y: host.contentInset,
        };
    }

    #scheduleActiveSurfaceLayout(host: WorkspaceSurfaceHostRecord): void {
        if (host.pendingLayoutTimer || host.hostWindow.isDestroyed()) {
            return;
        }
        host.pendingLayoutTimer = setTimeout(() => {
            host.pendingLayoutTimer = null;
            this.#applyVisibility(host);
        }, 16);
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

function areWorkspaceSurfaceBoundsEqual(
    left: WorkspaceSurfaceBounds | null,
    right: WorkspaceSurfaceBounds,
): boolean {
    return (
        left?.height === right.height &&
        left.width === right.width &&
        left.x === right.x &&
        left.y === right.y
    );
}

function getActionFailureMessage(
    reason: WorkspaceSurfaceActionDeliveryFailureReason,
): string {
    switch (reason) {
        case "inactive-context":
            return "The active workspace changed before the action could run.";
        case "invalid-context":
            return "The workspace action no longer matches the active project.";
        case "missing-surface":
            return "The active workspace surface is no longer available.";
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
