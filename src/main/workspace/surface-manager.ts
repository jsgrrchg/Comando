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
    WorkspaceSurfaceActionContext,
    WorkspaceSurfaceActionDeliveryFailureReason,
    WorkspaceSurfaceActionDeliveryResult,
    WorkspaceSurfaceActionDispatchResult,
    WorkspaceSurfaceActionEnvelope,
    WorkspaceSurfaceActionRequest,
    WorkspaceSurfaceActionStatus,
    WorkspaceSurfaceActivationResult,
    WorkspaceSurfaceCloseResult,
    WorkspaceSurfaceContentInsets,
    WorkspaceSurfaceHardLease,
    WorkspaceSurfaceFileRevealRequest,
    WorkspaceSurfaceDragEvent,
    WorkspaceSurfaceLifecycleState,
    WorkspaceSurfaceLeaseReport,
    WorkspaceSurfaceOperationDiagnostic,
    WorkspaceSurfacePoolDiagnostics,
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
import {
    WorkspaceActivationCoordinator,
    type WorkspaceSurfaceHibernateReason,
} from "./activation-coordinator";
import { WorkspaceSurfacePool } from "./surface-pool";

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
    readonly readyWaiters: Set<{
        readonly reject: (error: Error) => void;
        readonly resolve: () => void;
    }>;
    restoreError: Error | null;
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
    readonly activationCoordinator: WorkspaceActivationCoordinator;
    activeContextKey: string | null;
    contentInsets: WorkspaceSurfaceContentInsets;
    disposalScheduled: boolean;
    readonly hostWindow: BrowserWindow;
    readonly hostWindowId: string;
    context: WindowContextSnapshot;
    isClosing: boolean;
    hostOverlayVisible: boolean;
    pendingLayoutTimer: NodeJS.Timeout | null;
    pendingPreheatTimer: NodeJS.Timeout | null;
    readonly recentOperations: WorkspaceSurfaceOperationDiagnostic[];
    readonly surfacePool: WorkspaceSurfacePool;
    snapshot: WorkspaceNavigationSnapshot;
    readonly surfaceIdsByContextKey: Map<string, string>;
    warmingContextKey: string | null;
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
    readonly commitActiveScope?: (
        hostWindowId: string,
        scopeKey: string | null,
    ) => Promise<void>;
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
    readonly persistHostSnapshot?: (
        hostContext: WindowContextSnapshot,
        snapshot: WorkspaceNavigationSnapshot,
    ) => Promise<void>;
    readonly prepareSurfaceHibernate?: (
        subscriber: WorkspaceSurfaceRuntimeSubscriber,
        reason: WorkspaceSurfaceHibernateReason,
    ) => Promise<WorkspaceNavigationSnapshot>;
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
            host = this.#createHostRecord(hostWindow, hostContext, snapshot);
            this.#hostsByWindowId.set(host.hostWindowId, host);
            this.#resolveHostReadyWaiters(host.hostWindowId, true);
            const createdHost = host;
            const scheduleLayout = () => {
                this.#scheduleActiveSurfaceLayout(createdHost);
            };
            hostWindow.on("resize", scheduleLayout);
            hostWindow.on("enter-full-screen", scheduleLayout);
            hostWindow.on("leave-full-screen", scheduleLayout);
            hostWindow.on("maximize", scheduleLayout);
            hostWindow.on("unmaximize", scheduleLayout);
        }
        host.context = hostContext;
        const isInitialSync = host.snapshot.contexts.length === 0;
        const openContextKeys = new Set(snapshot.openContextKeys);
        const nextActiveContextKey =
            snapshot.activeContextKey && openContextKeys.has(snapshot.activeContextKey)
                ? snapshot.activeContextKey
                : null;
        if (isInitialSync) {
            // Restored navigation is already durable, even while its renderer is cold.
            host.activeContextKey = nextActiveContextKey;
            host.activationCoordinator.setCommittedScopeForRestore(
                nextActiveContextKey,
            );
        }
        host.snapshot = {
            ...this.#mergeKnownSurfaceSnapshots(host, snapshot),
            activeContextKey: host.activeContextKey,
        };
        for (const context of snapshot.contexts) {
            host.surfacePool.ensureCold(context.key);
        }

        if (nextActiveContextKey) {
            void this.activate(host.hostWindowId, nextActiveContextKey);
        } else if (host.activeContextKey) {
            void host.activationCoordinator.closeWorkspace(host.activeContextKey);
        }

        for (const contextKey of host.surfaceIdsByContextKey.keys()) {
            if (openContextKeys.has(contextKey) || contextKey === nextActiveContextKey) {
                continue;
            }
            void host.activationCoordinator.closeWorkspace(contextKey);
        }
        this.#scheduleRecentSurfacePreheat(host);
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

    async activate(
        hostWindowId: string,
        contextKey: string,
    ): Promise<WorkspaceSurfaceActivationResult> {
        const host = this.#hostsByWindowId.get(hostWindowId);
        if (
            !host ||
            !host.snapshot.contexts.some((context) => context.key === contextKey)
        ) {
            return {
                message: "The workspace is not available in this host.",
                scopeKey: contextKey,
                status: "failed",
            };
        }
        const operationStartedAt = Date.now();
        const result = await host.activationCoordinator.activate(contextKey);
        this.#recordSurfaceOperation(host, {
            durationMs: Date.now() - operationStartedAt,
            finishedAt: new Date().toISOString(),
            kind: "activation",
            outcome:
                result.status === "activated"
                    ? result.warm
                        ? "warm"
                        : "cold"
                    : result.status,
            scopeKey: contextKey,
        });
        if (result.status === "activated") {
            this.#publishHostSnapshot(host);
            this.#scheduleRecentSurfacePreheat(host);
        }
        return result;
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
            surface.restoreError ||
            !this.#doesRuntimeBindingMatch(surface, binding)
        ) {
            return;
        }

        surface.isReady = true;
        surface.restoreError = null;
        for (const waiter of surface.readyWaiters) {
            waiter.resolve();
        }
        surface.readyWaiters.clear();
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

    notifySurfaceRestoreFailed(
        webContents: WebContents,
        binding: WorkspaceSurfaceRuntimeBinding,
        message: string,
    ): void {
        const surface = this.#getSurfaceByWebContents(webContents);
        if (!surface || !this.#doesRuntimeBindingMatch(surface, binding)) {
            return;
        }
        this.#failSurfaceRestore(
            surface,
            new Error(message || "Could not restore the workspace surface."),
        );
    }

    reportSurfaceLeases(
        webContents: WebContents,
        report: WorkspaceSurfaceLeaseReport,
    ): boolean {
        const surface = this.#getSurfaceByWebContents(webContents);
        const host = surface
            ? this.#hostsByWindowId.get(surface.hostWindowId)
            : null;
        if (
            !surface ||
            !host ||
            !this.#doesRuntimeBindingMatch(surface, report)
        ) {
            return false;
        }
        return host.surfacePool.setLeases(
            surface.contextKey,
            surface.id,
            report.leases,
        );
    }

    async closeWorkspaceSurface(
        hostWindowId: string,
        contextKey: string,
    ): Promise<WorkspaceSurfaceCloseResult> {
        const host = this.#hostsByWindowId.get(hostWindowId);
        if (!host) {
            return { scopeKey: contextKey, status: "not-resident" };
        }
        const operationStartedAt = Date.now();
        const result = await host.activationCoordinator.closeWorkspace(contextKey);
        this.#recordSurfaceOperation(host, {
            durationMs: Date.now() - operationStartedAt,
            finishedAt: new Date().toISOString(),
            kind: "hibernate",
            outcome:
                result.status === "closed"
                    ? "cold"
                    : result.status === "not-resident"
                      ? "cold"
                      : result.status,
            scopeKey: contextKey,
        });
        this.#publishHostSnapshot(host);
        return result;
    }

    getSurfaceDiagnostics(hostWindowId: string): WorkspaceSurfacePoolDiagnostics {
        const host = this.#hostsByWindowId.get(hostWindowId);
        if (!host) {
            return {
                activeScopeKey: null,
                maxWarmSurfaces: 4,
                recentOperations: [],
                surfaces: [],
                updatedAt: new Date().toISOString(),
            };
        }
        return {
            ...host.surfacePool.diagnostics(),
            recentOperations: [...host.recentOperations],
        };
    }

    setHostOverlayVisible(hostWindowId: string, visible: boolean): void {
        const host = this.#hostsByWindowId.get(hostWindowId);
        if (!host || host.hostOverlayVisible === visible) {
            return;
        }
        host.hostOverlayVisible = visible;
        this.#applyVisibility(host, { focusActive: !visible });
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
    ): WorkspaceSurfaceActionDeliveryResult {
        const host = this.#hostsByWindowId.get(hostWindowId);
        const surface = this.#getActiveSurface(hostWindowId);
        const failureReason = this.#getActionDeliveryFailure(
            host,
            surface,
            event,
        );
        if (failureReason || !surface) {
            return {
                delivered: false,
                reason: failureReason ?? "missing-surface",
            };
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
        return { delivered: true };
    }

    setContentInset(hostWindowId: string, height: number): void {
        const host = this.#hostsByWindowId.get(hostWindowId);
        if (!host) {
            return;
        }
        this.setContentInsets(hostWindowId, {
            ...host.contentInsets,
            top: height,
        });
    }

    setContentLeftInset(hostWindowId: string, width: number): void {
        const host = this.#hostsByWindowId.get(hostWindowId);
        if (!host) {
            return;
        }
        this.setContentInsets(hostWindowId, {
            ...host.contentInsets,
            left: width,
        });
    }

    setContentInsets(
        hostWindowId: string,
        insets: WorkspaceSurfaceContentInsets | null | undefined,
    ): void {
        const host = this.#hostsByWindowId.get(hostWindowId);
        if (
            !host ||
            !insets ||
            !Number.isFinite(insets.top) ||
            !Number.isFinite(insets.left) ||
            !Number.isFinite(insets.right)
        ) {
            return;
        }

        const nextInsets = {
            left: Math.max(0, Math.round(insets.left)),
            right: Math.max(0, Math.round(insets.right)),
            top: Math.max(0, Math.round(insets.top)),
        };
        if (areWorkspaceSurfaceInsetsEqual(host.contentInsets, nextInsets)) {
            return;
        }

        host.contentInsets = nextInsets;
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
                if (!context) {
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
            void this.activate(host.hostWindowId, context.key);
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
        if (host.pendingPreheatTimer) {
            clearTimeout(host.pendingPreheatTimer);
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

    #createHostRecord(
        hostWindow: BrowserWindow,
        hostContext: WindowContextSnapshot,
        snapshot: WorkspaceNavigationSnapshot,
    ): WorkspaceSurfaceHostRecord {
        // The adapters capture this stable object before its fields are assigned.
        const host = {} as WorkspaceSurfaceHostRecord;
        const surfacePool = new WorkspaceSurfacePool({
            onChanged: () => {
                this.#publishSurfacePoolDiagnostics(host);
            },
        });
        const activationCoordinator = new WorkspaceActivationCoordinator({
            adapter: {
                acquire: (scopeKey) => {
                    const existingId = host.surfaceIdsByContextKey.get(scopeKey);
                    const existing = existingId
                        ? this.#surfacesById.get(existingId)
                        : null;
                    if (existing && !existing.webContents.isDestroyed()) {
                        return Promise.resolve({
                            generation: existing.id,
                            ready: existing.isReady,
                            reused: true,
                        });
                    }
                    const surface = this.#createSurface(
                        host,
                        host.context,
                        scopeKey,
                        host.snapshot,
                    );
                    if (!surface) {
                        throw new Error("Could not create the workspace surface.");
                    }
                    if (
                        !host.activeContextKey ||
                        !host.surfaceIdsByContextKey.has(host.activeContextKey)
                    ) {
                        host.warmingContextKey = scopeKey;
                        this.#applyVisibility(host);
                    }
                    return Promise.resolve({
                        generation: surface.id,
                        ready: surface.isReady,
                        reused: false,
                    });
                },
                commitActiveScope: async (scopeKey, generation) => {
                    if (host.isClosing) {
                        throw new Error("The workspace host is closing.");
                    }
                    await this.#lifecycleHandlers.commitActiveScope?.(
                        host.hostWindowId,
                        scopeKey,
                    );
                    if (
                        scopeKey &&
                        (!generation ||
                            host.surfaceIdsByContextKey.get(scopeKey) !== generation)
                    ) {
                        throw new Error(
                            "The workspace surface changed before activation committed.",
                        );
                    }
                    const activatedAt = new Date().toISOString();
                    host.activeContextKey = scopeKey;
                    host.warmingContextKey = null;
                    host.snapshot = {
                        ...host.snapshot,
                        activeContextKey: scopeKey,
                        contexts: host.snapshot.contexts.map((context) =>
                            context.key === scopeKey
                                ? { ...context, lastActivatedAt: activatedAt }
                                : context,
                        ),
                    };
                    this.#rejectInactiveActions(host);
                    this.#applyVisibility(host, { focusActive: Boolean(scopeKey) });
                },
                destroy: (scopeKey, generation) => {
                    if (host.surfaceIdsByContextKey.get(scopeKey) === generation) {
                        this.#destroySurface(host, generation);
                    }
                },
                prepareHibernate: async (scopeKey, generation, reason) => {
                    const surface = this.#surfacesById.get(generation);
                    if (
                        !surface ||
                        surface.contextKey !== scopeKey ||
                        surface.webContents.isDestroyed()
                    ) {
                        throw new Error("The workspace surface is no longer available.");
                    }
                    try {
                        const preparedSnapshot =
                            await this.#lifecycleHandlers.prepareSurfaceHibernate?.(
                                this.#toRuntimeSubscriber(surface),
                                reason,
                            );
                        if (!preparedSnapshot) {
                            throw new Error(
                                "The workspace surface did not return a checkpoint.",
                            );
                        }
                        const merged = this.mergeSurfaceSnapshot(
                            surface.webContents,
                            preparedSnapshot,
                        );
                        if (!merged) {
                            throw new Error(
                                "The workspace checkpoint no longer matches its scope.",
                            );
                        }
                        await this.#lifecycleHandlers.persistHostSnapshot?.(
                            host.context,
                            merged.snapshot,
                        );
                        return {
                            checkpointSucceeded: true,
                            flushSucceeded: true,
                            leases: this.#collectSurfaceActionLeases(surface),
                        };
                    } catch (error) {
                        console.error(
                            "[workspace] Failed to prepare a surface for hibernation",
                            error,
                        );
                        return {
                            checkpointSucceeded: false,
                            flushSucceeded: false,
                            leases: this.#collectSurfaceActionLeases(surface),
                        };
                    }
                },
                waitUntilReady: (scopeKey, generation) =>
                    this.#waitUntilSurfaceReady(host, scopeKey, generation),
            },
            pool: surfacePool,
        });
        Object.assign(host, {
            activationCoordinator,
            activeContextKey: null,
            contentInsets: {
                left: 0,
                right: 0,
                top: DESKTOP_TITLE_BAR_HEIGHT,
            },
            disposalScheduled: false,
            hostWindow,
            hostWindowId: hostContext.windowId,
            hostOverlayVisible: false,
            context: hostContext,
            isClosing: false,
            pendingLayoutTimer: null,
            pendingPreheatTimer: null,
            recentOperations: [],
            snapshot: {
                activeContextKey: null,
                contexts: [],
                openContextKeys: [],
                version: snapshot.version,
            },
            surfaceIdsByContextKey: new Map(),
            surfacePool,
            warmingContextKey: null,
        });
        return host;
    }

    #waitUntilSurfaceReady(
        host: WorkspaceSurfaceHostRecord,
        scopeKey: string,
        generation: string,
    ): Promise<void> {
        const surface = this.#surfacesById.get(generation);
        if (
            !surface ||
            surface.contextKey !== scopeKey ||
            host.surfaceIdsByContextKey.get(scopeKey) !== generation
        ) {
            return Promise.reject(
                new Error("The workspace surface is no longer available."),
            );
        }
        if (surface.isReady) {
            return Promise.resolve();
        }
        if (surface.restoreError) {
            return Promise.reject(surface.restoreError);
        }
        return new Promise<void>((resolve, reject) => {
            const waiter = {
                reject: (error: Error) => {
                    clearTimeout(timer);
                    surface.readyWaiters.delete(waiter);
                    reject(error);
                },
                resolve: () => {
                    clearTimeout(timer);
                    surface.readyWaiters.delete(waiter);
                    resolve();
                },
            };
            const timer = setTimeout(() => {
                waiter.reject(
                    new Error("The workspace surface did not become ready in time."),
                );
            }, 15_000);
            surface.readyWaiters.add(waiter);
        });
    }

    #failSurfaceRestore(surface: WorkspaceSurfaceRecord, error: Error): void {
        if (surface.restoreError) {
            return;
        }
        surface.restoreError = error;
        for (const waiter of surface.readyWaiters) {
            waiter.reject(error);
        }
        surface.readyWaiters.clear();
    }

    #collectSurfaceActionLeases(
        surface: WorkspaceSurfaceRecord,
    ): readonly WorkspaceSurfaceHardLease[] {
        const acquiredAt = new Date().toISOString();
        const leases: WorkspaceSurfaceHardLease[] = surface.pendingActions.map(
            (action) => ({
                acquiredAt,
                id: `pending:${action.actionId}`,
                kind: "pending-host-action",
                message: "A workspace action is waiting for the renderer.",
            }),
        );
        for (const [actionId, action] of this.#actionsById) {
            if (action.surfaceId !== surface.id) {
                continue;
            }
            leases.push({
                acquiredAt,
                id: `${action.claimed ? "claimed" : "sent"}:${actionId}`,
                kind: "pending-host-action",
                message: action.claimed
                    ? "A workspace action is still running."
                    : "A workspace action has not been claimed yet.",
            });
        }
        return leases;
    }

    #publishHostSnapshot(host: WorkspaceSurfaceHostRecord): void {
        if (!host.hostWindow.webContents.isDestroyed()) {
            host.hostWindow.webContents.send(
                IPC_EVENTS.workspaceSurfaceSnapshotUpdated,
                host.snapshot,
            );
        }
    }

    #publishSurfacePoolDiagnostics(host: WorkspaceSurfaceHostRecord): void {
        if (!host.hostWindow.webContents.isDestroyed()) {
            host.hostWindow.webContents.send(
                IPC_EVENTS.workspaceSurfacePoolChanged,
                this.getSurfaceDiagnostics(host.hostWindowId),
            );
        }
    }

    #recordSurfaceOperation(
        host: WorkspaceSurfaceHostRecord,
        operation: WorkspaceSurfaceOperationDiagnostic,
    ): void {
        host.recentOperations.push(operation);
        if (host.recentOperations.length > 100) {
            host.recentOperations.splice(0, host.recentOperations.length - 100);
        }
        this.#publishSurfacePoolDiagnostics(host);
    }

    #scheduleRecentSurfacePreheat(host: WorkspaceSurfaceHostRecord): void {
        if (host.pendingPreheatTimer) {
            clearTimeout(host.pendingPreheatTimer);
        }
        host.pendingPreheatTimer = setTimeout(() => {
            host.pendingPreheatTimer = null;
            void this.#preheatRecentSurfaces(host);
        }, 1_000);
        host.pendingPreheatTimer.unref();
    }

    async #preheatRecentSurfaces(host: WorkspaceSurfaceHostRecord): Promise<void> {
        if (host.isClosing || host.hostWindow.isDestroyed()) {
            return;
        }
        const candidates = host.snapshot.contexts
            .filter(
                (context) =>
                    context.key !== host.activeContextKey &&
                    host.snapshot.openContextKeys.includes(context.key),
            )
            .sort(
                (left, right) =>
                    Date.parse(right.lastActivatedAt) -
                        Date.parse(left.lastActivatedAt) ||
                    left.key.localeCompare(right.key),
            )
            .slice(0, host.surfacePool.maxWarmSurfaces);
        for (const context of candidates) {
            if (!host.surfacePool.canPreheat()) {
                break;
            }
            const operationStartedAt = Date.now();
            const warmed = await host.activationCoordinator.preheat(context.key);
            this.#recordSurfaceOperation(host, {
                durationMs: Date.now() - operationStartedAt,
                finishedAt: new Date().toISOString(),
                kind: "preheat",
                outcome: warmed ? "warm" : "failed",
                scopeKey: context.key,
            });
        }
        await host.activationCoordinator.enforceBudget();
    }

    #createSurface(
        host: WorkspaceSurfaceHostRecord,
        hostContext: WindowContextSnapshot,
        contextKey: string,
        hostSnapshot: WorkspaceNavigationSnapshot,
    ): WorkspaceSurfaceRecord | null {
        const workspaceContext = hostSnapshot.contexts.find(
            (context) => context.key === contextKey,
        );
        if (!workspaceContext) {
            return null;
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
            readyWaiters: new Set(),
            restoreError: null,
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
            surface.restoreError = null;
        });
        webContents.on(
            "did-fail-load",
            (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
                if (isMainFrame === false || errorCode === -3) {
                    return;
                }
                this.#failSurfaceRestore(
                    surface,
                    new Error(
                        errorDescription ||
                            `The workspace renderer failed to load (${errorCode}).`,
                    ),
                );
            },
        );
        webContents.on("render-process-gone", () => {
            this.#failSurfaceRestore(
                surface,
                new Error("The workspace renderer stopped before it became ready."),
            );
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
            void this.activate(currentHost.hostWindowId, nextContextKey);
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
            this.#failSurfaceRestore(
                surface,
                new Error("The workspace surface was destroyed before it became ready."),
            );
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
        return surface;
    }

    #handleRuntimeResolutionFailure(
        surface: WorkspaceSurfaceRecord,
        error: unknown,
    ): void {
        console.error(
            "[workspace] Failed to resolve the durable runtime owner",
            error,
        );
        this.#failSurfaceRestore(
            surface,
            error instanceof Error
                ? error
                : new Error("Could not resolve the durable workspace runtime."),
        );
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

        this.#failSurfaceRestore(
            surface,
            new Error("The workspace surface was disposed before restore completed."),
        );

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
        if (host.warmingContextKey === surface.contextKey) {
            host.warmingContextKey = null;
        }
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
        request: WorkspaceSurfaceActionContext,
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
        if (host.hostOverlayVisible) {
            for (const surfaceId of host.surfaceIdsByContextKey.values()) {
                const surface = this.#surfacesById.get(surfaceId);
                if (
                    surface &&
                    !surface.webContents.isDestroyed() &&
                    surface.isVisible
                ) {
                    surface.view.setVisible(false);
                    surface.isVisible = false;
                }
            }
            return;
        }
        const activeSurfaceId =
            (host.activeContextKey
                ? host.surfaceIdsByContextKey.get(host.activeContextKey)
                : null) ??
            (host.warmingContextKey
                ? host.surfaceIdsByContextKey.get(host.warmingContextKey)
                : null);

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
            height: Math.max(0, bounds.height - host.contentInsets.top),
            width: Math.max(
                0,
                bounds.width -
                    host.contentInsets.left -
                    host.contentInsets.right,
            ),
            x: host.contentInsets.left,
            y: host.contentInsets.top,
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

function areWorkspaceSurfaceInsetsEqual(
    left: WorkspaceSurfaceContentInsets,
    right: WorkspaceSurfaceContentInsets,
): boolean {
    return (
        left.left === right.left &&
        left.right === right.right &&
        left.top === right.top
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
