import { randomUUID } from "node:crypto";

import {
    BrowserWindow,
    WebContentsView,
    type WebContents,
} from "electron";

import { IPC_EVENTS } from "@shared/ipc";
import {
    areWorkspaceScopesEquivalent,
    areWorkspaceWorktreeIdsEquivalent,
    hasOpenWorkspaceScope,
    type WorkspaceLocation,
    type WorkspaceScope,
} from "@shared/workspace-context";
import type {
    WindowContextSnapshot,
    WorkspaceNavigationSnapshot,
    WindowWorkspaceRestoreRecord,
    WorkspaceSurfaceActionCompletion,
    WorkspaceSurfaceActionDeliveryFailureReason,
    WorkspaceSurfaceActionDeliveryResult,
    WorkspaceSurfaceActionDispatchResult,
    WorkspaceSurfaceActionEnvelope,
    WorkspaceSurfaceActionRequest,
    WorkspaceSurfaceActionStatus,
    WorkspaceSurfaceFileRevealRequest,
    WorkspaceSurfaceDragEvent,
    WorkspaceSurfaceLifecycleState,
    WorkspaceSurfaceRuntimeBinding,
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
    context: WindowContextSnapshot;
    readonly contextKey: string;
    hostWindowId: string;
    readonly id: string;
    isRuntimeAttached: boolean;
    isRuntimeDetached: boolean;
    isVisible: boolean;
    isReady: boolean;
    lifecycle: WorkspaceSurfaceLifecycleState;
    readonly pendingActions: WorkspaceSurfaceActionEnvelope[];
    runtimeOwnerId: string | null;
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
    disposalScheduled: boolean;
    readonly hostWindow: BrowserWindow;
    readonly hostWindowId: string;
    context: WindowContextSnapshot;
    isClosing: boolean;
    pendingLayoutTimer: NodeJS.Timeout | null;
    snapshot: WorkspaceNavigationSnapshot;
    readonly surfaceIdsByContextKey: Map<string, string>;
}

interface DispatchedWorkspaceSurfaceAction {
    claimed: boolean;
    readonly envelope: WorkspaceSurfaceActionEnvelope;
    hostWindowId: string;
    readonly surfaceId: string;
}

export interface WorkspaceSurfaceRuntimeResolution {
    readonly revision: number;
    readonly runtimeOwnerId: string;
}

export interface WorkspaceSurfaceRuntimeResolutionInput {
    readonly layoutSnapshot: Readonly<Record<string, unknown>>;
    readonly projectId: string;
    readonly scopeKey: string;
    readonly worktreeId: string | null;
}

export interface WorkspaceSurfaceRuntimeSubscriber
    extends WorkspaceSurfaceRuntimeBinding {
    readonly webContents: WebContents;
}

interface WorkspaceSurfaceLifecycleHandlers {
    readonly onSurfaceCreated?: (
        subscriber: WorkspaceSurfaceRuntimeSubscriber,
    ) => void;
    readonly onSurfaceDestroyed?: (
        subscriber: WorkspaceSurfaceRuntimeSubscriber,
    ) => void;
    readonly onSurfaceLifecycleChanged?: (
        subscriber: WorkspaceSurfaceRuntimeSubscriber,
        lifecycle: WorkspaceSurfaceLifecycleState,
    ) => void;
    readonly resolveRuntimeOwner?: (
        input: WorkspaceSurfaceRuntimeResolutionInput,
    ) => WorkspaceSurfaceRuntimeResolution | Promise<WorkspaceSurfaceRuntimeResolution>;
}

export interface OpenWorkspaceSurfaceLocation extends WorkspaceLocation {
    readonly isActive: boolean;
    readonly lastActivatedAt: string;
}

export interface WorkspaceSurfaceTransferResult {
    readonly sourceSnapshot: WorkspaceNavigationSnapshot;
    readonly surfaceId: string;
    readonly targetSnapshot: WorkspaceNavigationSnapshot;
}

/**
 * Keeps project workspaces alive in isolated WebContents while the host renderer
 * owns the visible title bar and project switcher.
 */
export class WorkspaceSurfaceManager {
    readonly #hostsByWindowId = new Map<string, WorkspaceSurfaceHostRecord>();
    readonly #hostReadyWaitersByWindowId = new Map<
        string,
        Set<(ready: boolean) => void>
    >();
    readonly #pendingTransfersByHost = new Map<
        WorkspaceSurfaceHostRecord,
        Set<Promise<void>>
    >();
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
        if (host && host.hostWindow !== hostWindow) {
            // Stable window ids can be reused by a newly opened BrowserWindow.
            this.#scheduleHostDisposal(host);
            host = undefined;
        }
        if (!host) {
            host = {
                activeContextKey: null,
                contentInset: DESKTOP_TITLE_BAR_HEIGHT,
                contentLeftInset: 0,
                disposalScheduled: false,
                hostWindow,
                hostWindowId: hostContext.windowId,
                context: hostContext,
                isClosing: false,
                pendingLayoutTimer: null,
                snapshot,
                surfaceIdsByContextKey: new Map(),
            };
            this.#hostsByWindowId.set(host.hostWindowId, host);
            this.#resolveHostReadyWaiters(host.hostWindowId, true);
            const createdHost = host;
            hostWindow.on("resize", () => {
                this.#scheduleActiveSurfaceLayout(createdHost);
            });
        }
        host.context = hostContext;

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

    waitForHost(hostWindowId: string, timeoutMs = 10_000): Promise<boolean> {
        if (this.#hostsByWindowId.has(hostWindowId)) {
            return Promise.resolve(true);
        }
        return new Promise<boolean>((resolve) => {
            const finish = (ready: boolean) => {
                clearTimeout(timer);
                const waiters = this.#hostReadyWaitersByWindowId.get(hostWindowId);
                waiters?.delete(finish);
                if (waiters?.size === 0) {
                    this.#hostReadyWaitersByWindowId.delete(hostWindowId);
                }
                resolve(ready);
            };
            const timer = setTimeout(() => {
                finish(false);
            }, timeoutMs);
            const waiters =
                this.#hostReadyWaitersByWindowId.get(hostWindowId) ?? new Set();
            waiters.add(finish);
            this.#hostReadyWaitersByWindowId.set(hostWindowId, waiters);
        });
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

    notifySurfaceReady(
        webContents: WebContents,
        binding: WorkspaceSurfaceRuntimeBinding,
    ): void {
        const surface = this.#getSurfaceByWebContents(webContents);
        if (
            !surface ||
            surface.webContents.isDestroyed() ||
            !this.#doesRuntimeBindingMatch(surface, binding)
        ) {
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

    getSurfaceRuntimeSubscriber(
        webContents: WebContents,
    ): WorkspaceSurfaceRuntimeSubscriber | null {
        const surface = this.#getSurfaceByWebContents(webContents);
        return surface?.runtimeOwnerId
            ? this.#toRuntimeSubscriber(surface)
            : null;
    }

    getRuntimeOwnerId(webContents: WebContents): string | null {
        return this.#getSurfaceByWebContents(webContents)?.runtimeOwnerId ?? null;
    }

    matchesSurfaceRuntimeBinding(
        webContents: WebContents,
        binding: WorkspaceSurfaceRuntimeBinding,
    ): boolean {
        const surface = this.#getSurfaceByWebContents(webContents);
        return Boolean(surface && this.#doesRuntimeBindingMatch(surface, binding));
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

    listOpenWorkspaceLocations(): readonly OpenWorkspaceSurfaceLocation[] {
        return [...this.#hostsByWindowId.values()].flatMap((host) =>
            host.snapshot.openContextKeys.flatMap((contextKey) => {
                const context = host.snapshot.contexts.find(
                    (candidate) => candidate.key === contextKey,
                );
                if (!context || !host.surfaceIdsByContextKey.has(contextKey)) {
                    return [];
                }
                return [
                    {
                        contextKey,
                        hostWindowId: host.hostWindowId,
                        isActive: host.activeContextKey === contextKey,
                        lastActivatedAt: context.lastActivatedAt,
                        projectId: context.projectId,
                        worktreeId: context.worktreeId,
                    },
                ];
            }),
        );
    }

    findWorkspaceLocations(
        scope: WorkspaceScope,
    ): readonly OpenWorkspaceSurfaceLocation[] {
        return this.listOpenWorkspaceLocations().filter((location) =>
            areWorkspaceScopesEquivalent(location, scope),
        );
    }

    findPreferredWorkspaceLocation(
        scope: WorkspaceScope,
        preferredHostWindowId = windowRegistry.getLastFocusedMainWindowId(),
    ): OpenWorkspaceSurfaceLocation | null {
        return (
            [...this.findWorkspaceLocations(scope)].sort((left, right) => {
                if (left.isActive !== right.isActive) {
                    return left.isActive ? -1 : 1;
                }
                const leftIsPreferred =
                    left.hostWindowId === preferredHostWindowId;
                const rightIsPreferred =
                    right.hostWindowId === preferredHostWindowId;
                if (leftIsPreferred !== rightIsPreferred) {
                    return leftIsPreferred ? -1 : 1;
                }
                const activationOrder =
                    Date.parse(right.lastActivatedAt) -
                    Date.parse(left.lastActivatedAt);
                return activationOrder ||
                    left.hostWindowId.localeCompare(right.hostWindowId);
            })[0] ?? null
        );
    }

    async transferSurface(input: {
        readonly commit: () => Promise<{
            readonly source: WindowWorkspaceRestoreRecord;
            readonly target: WindowWorkspaceRestoreRecord;
        }>;
        readonly contextKey: string;
        readonly onCommitted?: (
            transfer: WorkspaceSurfaceTransferResult,
        ) => void;
        readonly sourceHostWindowId: string;
        readonly targetHostWindowId: string;
    }): Promise<WorkspaceSurfaceTransferResult> {
        if (input.sourceHostWindowId === input.targetHostWindowId) {
            throw new Error("The workspace is already in the target window.");
        }
        const reservation = this.#reserveTransfer(
            input.sourceHostWindowId,
            input.targetHostWindowId,
        );
        try {
            return await this.#transferSurfaceNow(
                input,
                reservation.sourceHost,
                reservation.targetHost,
            );
        } finally {
            reservation.release();
        }
    }

    async #transferSurfaceNow(
        input: {
            readonly commit: () => Promise<{
                readonly source: WindowWorkspaceRestoreRecord;
                readonly target: WindowWorkspaceRestoreRecord;
            }>;
            readonly contextKey: string;
            readonly onCommitted?: (
                transfer: WorkspaceSurfaceTransferResult,
            ) => void;
            readonly sourceHostWindowId: string;
            readonly targetHostWindowId: string;
        },
        sourceHost: WorkspaceSurfaceHostRecord,
        targetHost: WorkspaceSurfaceHostRecord,
    ): Promise<WorkspaceSurfaceTransferResult> {
        const surfaceId = sourceHost.surfaceIdsByContextKey.get(
            input.contextKey,
        );
        const surface = surfaceId ? this.#surfacesById.get(surfaceId) : null;
        if (!surface) {
            throw new Error("The workspace surface is no longer available.");
        }
        if (
            sourceHost.hostWindow.isDestroyed() ||
            targetHost.hostWindow.isDestroyed()
        ) {
            throw new Error("A workspace transfer window is no longer available.");
        }
        const movingContext = sourceHost.snapshot.contexts.find(
            (context) => context.key === input.contextKey,
        );
        if (!movingContext) {
            throw new Error("The workspace context is no longer available.");
        }
        if (
            hasOpenWorkspaceScope(targetHost.snapshot, movingContext) ||
            targetHost.surfaceIdsByContextKey.has(input.contextKey)
        ) {
            throw new Error("The destination already contains this workspace.");
        }

        const previousContext = surface.context;
        const previousActionHostIds = new Map<string, string>();
        let attachedToTarget = false;
        let committed:
            | {
                  readonly source: WindowWorkspaceRestoreRecord;
                  readonly target: WindowWorkspaceRestoreRecord;
              }
            | undefined;
        surface.view.setVisible(false);
        surface.isVisible = false;
        surface.bounds = null;
        this.#publishLifecycle(surface, "suspended");
        try {
            sourceHost.hostWindow.contentView.removeChildView(surface.view);
            targetHost.hostWindow.contentView.addChildView(surface.view);
            attachedToTarget = true;
            sourceHost.surfaceIdsByContextKey.delete(input.contextKey);
            targetHost.surfaceIdsByContextKey.set(input.contextKey, surface.id);
            surface.hostWindowId = targetHost.hostWindowId;
            surface.context = {
                ...surface.context,
                hostWindowId: targetHost.hostWindowId,
                workspaceId: targetHost.context.workspaceId,
                workspaceSessionId: targetHost.context.workspaceSessionId,
            };
            windowRegistry.registerEmbeddedRenderer(
                surface.webContents,
                surface.context,
            );
            for (const [actionId, action] of this.#actionsById) {
                if (action.surfaceId !== surface.id) {
                    continue;
                }
                previousActionHostIds.set(actionId, action.hostWindowId);
                action.hostWindowId = targetHost.hostWindowId;
            }

            committed = await input.commit();
        } catch (error) {
            if (attachedToTarget && !targetHost.hostWindow.isDestroyed()) {
                targetHost.hostWindow.contentView.removeChildView(surface.view);
            }
            if (!sourceHost.hostWindow.isDestroyed()) {
                sourceHost.hostWindow.contentView.addChildView(surface.view);
            }
            targetHost.surfaceIdsByContextKey.delete(input.contextKey);
            sourceHost.surfaceIdsByContextKey.set(input.contextKey, surface.id);
            surface.hostWindowId = sourceHost.hostWindowId;
            surface.context = previousContext;
            windowRegistry.registerEmbeddedRenderer(
                surface.webContents,
                previousContext,
            );
            for (const [actionId, previousHostWindowId] of previousActionHostIds) {
                const action = this.#actionsById.get(actionId);
                if (action) {
                    action.hostWindowId = previousHostWindowId;
                }
            }
            this.#applyVisibility(sourceHost, {
                focusActive:
                    sourceHost.activeContextKey === input.contextKey,
            });
            throw error;
        }

        // Persistence is now canonical. Never visually roll back beyond this point.
        sourceHost.snapshot = committed.source.snapshot;
        sourceHost.activeContextKey = committed.source.snapshot.activeContextKey;
        targetHost.snapshot = committed.target.snapshot;
        targetHost.activeContextKey = committed.target.snapshot.activeContextKey;
        surface.snapshot = toSurfaceSnapshot(
            committed.target.snapshot,
            input.contextKey,
        );
        const result = {
            sourceSnapshot: sourceHost.snapshot,
            surfaceId: surface.id,
            targetSnapshot: targetHost.snapshot,
        };
        try {
            // Notify host renderers before a waiting window close can flush them.
            input.onCommitted?.(result);
        } catch (error) {
            console.error(
                "[workspace] Failed to notify hosts after a committed transfer",
                error,
            );
        }
        try {
            this.#rejectInactiveActions(sourceHost);
            this.#rejectInactiveActions(targetHost);
            this.#applyVisibility(sourceHost);
            this.#applyVisibility(targetHost, { focusActive: true });
        } catch (error) {
            // A later host sync can repair presentation; ownership must remain committed.
            console.error(
                "[workspace] Failed to refresh surfaces after a committed transfer",
                error,
            );
        }
        return result;
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
                        areWorkspaceWorktreeIdsEquivalent(
                            projectId,
                            candidate.worktreeId,
                            worktreeId,
                        )),
            );
            if (!context) {
                continue;
            }
            this.activate(host.hostWindowId, context.key);
            return host.hostWindow.isDestroyed() ? null : host.hostWindow;
        }
        return null;
    }

    async prepareHostForClose(
        hostWindowId: string,
        hostWindow?: BrowserWindow,
    ): Promise<void> {
        const host = this.#hostsByWindowId.get(hostWindowId);
        if (!host || (hostWindow && host.hostWindow !== hostWindow)) {
            return;
        }
        // Mark this host generation before existing transfers drain.
        host.isClosing = true;
        const pendingTransfers = this.#pendingTransfersByHost.get(host);
        if (pendingTransfers) {
            await Promise.allSettled([...pendingTransfers]);
        }
    }

    disposeHost(hostWindowId: string, hostWindow?: BrowserWindow): void {
        const host = this.#hostsByWindowId.get(hostWindowId);
        if (!host) {
            this.#resolveHostReadyWaiters(hostWindowId, false);
            return;
        }
        if (hostWindow && host.hostWindow !== hostWindow) {
            return;
        }
        this.#scheduleHostDisposal(host);
    }

    #scheduleHostDisposal(host: WorkspaceSurfaceHostRecord): void {
        host.isClosing = true;
        if (host.disposalScheduled) {
            return;
        }
        host.disposalScheduled = true;
        const pendingTransfers = this.#pendingTransfersByHost.get(host);
        if (pendingTransfers?.size) {
            // Forced window destruction still waits for the atomic move boundary.
            void Promise.allSettled([...pendingTransfers]).then(() => {
                this.#disposeHostNow(host);
            });
            return;
        }
        this.#disposeHostNow(host);
    }

    #disposeHostNow(host: WorkspaceSurfaceHostRecord): void {
        const isCurrentHost =
            this.#hostsByWindowId.get(host.hostWindowId) === host;
        if (isCurrentHost) {
            this.#resolveHostReadyWaiters(host.hostWindowId, false);
        }
        if (host.pendingLayoutTimer) {
            clearTimeout(host.pendingLayoutTimer);
        }
        for (const surfaceId of [...host.surfaceIdsByContextKey.values()]) {
            this.#destroySurface(host, surfaceId);
        }
        this.#pendingTransfersByHost.delete(host);
        if (isCurrentHost) {
            this.#hostsByWindowId.delete(host.hostWindowId);
        }
    }

    #reserveTransfer(
        sourceHostWindowId: string,
        targetHostWindowId: string,
    ): {
        readonly release: () => void;
        readonly sourceHost: WorkspaceSurfaceHostRecord;
        readonly targetHost: WorkspaceSurfaceHostRecord;
    } {
        const sourceHost = this.#hostsByWindowId.get(sourceHostWindowId);
        const targetHost = this.#hostsByWindowId.get(targetHostWindowId);
        if (!sourceHost || !targetHost) {
            throw new Error("The workspace surface is no longer available.");
        }
        if (sourceHost.isClosing || targetHost.isClosing) {
            throw new Error("A workspace transfer window is closing.");
        }

        let resolveTransfer: (() => void) | undefined;
        const transfer = new Promise<void>((resolve) => {
            resolveTransfer = resolve;
        });
        const hosts = [sourceHost, targetHost];
        for (const host of hosts) {
            const pendingTransfers =
                this.#pendingTransfersByHost.get(host) ??
                new Set<Promise<void>>();
            pendingTransfers.add(transfer);
            this.#pendingTransfersByHost.set(host, pendingTransfers);
        }

        let released = false;
        return {
            release: () => {
                if (released) {
                    return;
                }
                released = true;
                for (const host of hosts) {
                    const pendingTransfers =
                        this.#pendingTransfersByHost.get(host);
                    pendingTransfers?.delete(transfer);
                    if (pendingTransfers?.size === 0) {
                        this.#pendingTransfersByHost.delete(host);
                    }
                }
                resolveTransfer?.();
            },
            sourceHost,
            targetHost,
        };
    }

    #resolveHostReadyWaiters(hostWindowId: string, ready: boolean): void {
        const waiters = this.#hostReadyWaitersByWindowId.get(hostWindowId);
        if (!waiters) {
            return;
        }
        this.#hostReadyWaitersByWindowId.delete(hostWindowId);
        for (const resolve of waiters) {
            resolve(ready);
        }
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
            isRuntimeAttached: false,
            isRuntimeDetached: false,
            isVisible: false,
            isReady: false,
            lifecycle: "suspended",
            pendingActions: [],
            runtimeOwnerId: null,
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

            const currentHost = this.#hostsByWindowId.get(
                surface.hostWindowId,
            );
            if (!currentHost) {
                return;
            }
            const nextContextKey = getAdjacentContextKey(
                currentHost.snapshot.openContextKeys,
                currentHost.activeContextKey,
                direction,
            );
            if (!nextContextKey) {
                return;
            }

            event.preventDefault();
            this.activate(currentHost.hostWindowId, nextContextKey);
            currentHost.hostWindow.webContents.send(
                IPC_EVENTS.workspaceSurfaceSnapshotUpdated,
                currentHost.snapshot,
            );
        });
        webContents.once("did-finish-load", () => {
            if (!webContents.isDestroyed() && surface.runtimeOwnerId) {
                surface.isRuntimeAttached = true;
                this.#lifecycleHandlers.onSurfaceCreated?.(
                    this.#toRuntimeSubscriber(surface),
                );
                this.#publishLifecycle(surface, surface.lifecycle, true);
                const currentHost = this.#hostsByWindowId.get(
                    surface.hostWindowId,
                );
                if (currentHost) {
                    this.#applyVisibility(currentHost);
                }
            }
        });
        webContents.once("destroyed", () => {
            this.#detachSurfaceRuntime(surface);
            windowRegistry.unregisterEmbeddedRenderer(webContents);
            this.#surfaceIdsByWebContentsId.delete(webContentsId);
        });
        const resolution = this.#lifecycleHandlers.resolveRuntimeOwner?.({
            layoutSnapshot: workspaceContext.workspace as unknown as Readonly<
                Record<string, unknown>
            >,
            projectId: workspaceContext.projectId,
            scopeKey: contextKey,
            worktreeId: workspaceContext.worktreeId ?? null,
        }) ?? {
            revision: 0,
            runtimeOwnerId: `workspace-runtime:${contextKey}`,
        };
        if (isPromiseLike(resolution)) {
            void resolution
                .then((resolved) => {
                    this.#loadResolvedSurface(surface, workspaceContext, resolved);
                })
                .catch((error: unknown) => {
                    this.#handleRuntimeResolutionFailure(surface, error);
                });
        } else {
            try {
                this.#loadResolvedSurface(surface, workspaceContext, resolution);
            } catch (error) {
                this.#handleRuntimeResolutionFailure(surface, error);
            }
        }
    }

    #handleRuntimeResolutionFailure(
        surface: WorkspaceSurfaceRecord,
        error: unknown,
    ): void {
        console.error(
            "[workspace] Failed to resolve the durable runtime owner",
            error,
        );
        const currentHost = this.#hostsByWindowId.get(surface.hostWindowId);
        if (currentHost) {
            this.#destroySurface(currentHost, surface.id);
        }
    }

    #loadResolvedSurface(
        surface: WorkspaceSurfaceRecord,
        workspaceContext: WorkspaceNavigationSnapshot["contexts"][number],
        resolution: WorkspaceSurfaceRuntimeResolution,
    ): void {
        if (
            this.#surfacesById.get(surface.id) !== surface ||
            surface.webContents.isDestroyed()
        ) {
            return;
        }
        if (!resolution.runtimeOwnerId || resolution.revision < 0) {
            throw new Error("The workspace runtime owner resolution is invalid.");
        }

        surface.runtimeOwnerId = resolution.runtimeOwnerId;
        const rendererSearch = new URLSearchParams({
            project: workspaceContext.projectId,
            revision: `${resolution.revision}`,
            "runtime-owner": resolution.runtimeOwnerId,
            scope: surface.contextKey,
            surface: surface.id,
            window: "workspace-surface",
        });
        if (workspaceContext.worktreeId) {
            rendererSearch.set("worktree", workspaceContext.worktreeId);
        }
        // Runtime owner and scope are immutable before renderer bootstrap.
        loadRendererContents(surface.webContents, rendererSearch.toString());
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
        this.#detachSurfaceRuntime(surface);
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
            this.#publishLifecycle(surface, "suspended");
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
        this.#publishLifecycle(activeSurface, "visible");
        if (options.focusActive) {
            activeSurface.webContents.focus();
        }
    }

    #publishLifecycle(
        surface: WorkspaceSurfaceRecord,
        lifecycle: WorkspaceSurfaceLifecycleState,
        force = false,
    ): void {
        if (!force && surface.lifecycle === lifecycle) {
            return;
        }
        surface.lifecycle = lifecycle;
        if (
            !surface.isRuntimeAttached ||
            !surface.runtimeOwnerId ||
            surface.webContents.isDestroyed()
        ) {
            return;
        }

        const subscriber = this.#toRuntimeSubscriber(surface);
        this.#lifecycleHandlers.onSurfaceLifecycleChanged?.(
            subscriber,
            lifecycle,
        );
        surface.webContents.send(IPC_EVENTS.workspaceSurfaceLifecycleChanged, {
            generation: subscriber.generation,
            runtimeOwnerId: subscriber.runtimeOwnerId,
            scopeKey: subscriber.scopeKey,
            state: lifecycle,
        });
    }

    #detachSurfaceRuntime(surface: WorkspaceSurfaceRecord): void {
        if (
            surface.isRuntimeDetached ||
            !surface.isRuntimeAttached ||
            !surface.runtimeOwnerId
        ) {
            return;
        }
        this.#publishLifecycle(surface, "disposing", true);
        surface.isRuntimeDetached = true;
        this.#lifecycleHandlers.onSurfaceDestroyed?.(
            this.#toRuntimeSubscriber(surface),
        );
    }

    #toRuntimeSubscriber(
        surface: WorkspaceSurfaceRecord,
    ): WorkspaceSurfaceRuntimeSubscriber {
        if (!surface.runtimeOwnerId) {
            throw new Error("The workspace surface has no runtime owner.");
        }
        return {
            generation: surface.id,
            runtimeOwnerId: surface.runtimeOwnerId,
            scopeKey: surface.contextKey,
            webContents: surface.webContents,
        };
    }

    #doesRuntimeBindingMatch(
        surface: WorkspaceSurfaceRecord,
        binding: WorkspaceSurfaceRuntimeBinding,
    ): boolean {
        return (
            surface.id === binding.generation &&
            surface.contextKey === binding.scopeKey &&
            surface.runtimeOwnerId === binding.runtimeOwnerId
        );
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

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
    return (
        typeof value === "object" &&
        value !== null &&
        "then" in value &&
        typeof value.then === "function"
    );
}

export const workspaceSurfaceManager = new WorkspaceSurfaceManager();
