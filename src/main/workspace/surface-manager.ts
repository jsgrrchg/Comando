import { randomUUID } from "node:crypto";

import {
    BrowserWindow,
    WebContentsView,
    type WebContents,
} from "electron";

import { IPC_EVENTS } from "@shared/ipc";
import type {
    WindowContextSnapshot,
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
    WorkspaceSurfaceRegistrySnapshot,
} from "@shared/ipc";

import {
    DESKTOP_TITLE_BAR_HEIGHT,
    getRendererPreloadPath,
    installWindowOpenHandler,
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
    activeScopeKey: string | null;
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
    registry: WorkspaceSurfaceRegistrySnapshot;
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
    readonly prepareSurfaceHibernate?: (
        subscriber: WorkspaceSurfaceRuntimeSubscriber,
        reason: WorkspaceSurfaceHibernateReason,
    ) => Promise<void>;
    readonly resolveRuntimeOwner?: (
        input: WorkspaceSurfaceRuntimeResolutionInput,
    ) => WorkspaceSurfaceRuntimeResolution | Promise<WorkspaceSurfaceRuntimeResolution>;
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
    readonly #surfaceIdsByWebContentsId = new Map<number, string>();
    readonly #surfacesById = new Map<string, WorkspaceSurfaceRecord>();
    readonly #actionsById = new Map<
        string,
        DispatchedWorkspaceSurfaceAction
    >();
    #lifecycleHandlers: WorkspaceSurfaceLifecycleHandlers = {};

    syncWorkspaceRegistry(
        hostWindow: BrowserWindow,
        hostContext: WindowContextSnapshot,
        registry: WorkspaceSurfaceRegistrySnapshot,
    ): WorkspaceSurfaceRegistrySnapshot {
        let host = this.#hostsByWindowId.get(hostContext.windowId);
        if (host && host.hostWindow !== hostWindow) {
            // Stable window ids can be reused by a newly opened BrowserWindow.
            this.#scheduleHostDisposal(host);
            host = undefined;
        }
        if (!host) {
            host = this.#createHostRecord(hostWindow, hostContext);
            this.#hostsByWindowId.set(host.hostWindowId, host);
            this.#resolveHostReadyWaiters(host.hostWindowId, true);
            const createdHost = host;
            const scheduleLayout = () => {
                this.#scheduleActiveSurfaceLayout(createdHost);
            };
            hostWindow.on("resize", scheduleLayout);
            // Moving between displays can change scale and usable content bounds
            // without a regular resize event on every desktop environment.
            hostWindow.on("move", scheduleLayout);
            hostWindow.on("show", scheduleLayout);
            hostWindow.on("restore", scheduleLayout);
            hostWindow.on("enter-full-screen", scheduleLayout);
            hostWindow.on("leave-full-screen", scheduleLayout);
            hostWindow.on("maximize", scheduleLayout);
            hostWindow.on("unmaximize", scheduleLayout);
        }
        host.context = hostContext;
        const isInitialSync = host.registry.workspaces.length === 0;
        const knownScopeKeys = new Set(
            registry.workspaces.map((workspace) => workspace.scopeKey),
        );
        const nextActiveScopeKey =
            registry.activeScopeKey && knownScopeKeys.has(registry.activeScopeKey)
                ? registry.activeScopeKey
                : null;
        if (isInitialSync) {
            // Restored navigation is already durable, even while its renderer is cold.
            host.activeScopeKey = nextActiveScopeKey;
            host.activationCoordinator.setCommittedScopeForRestore(
                nextActiveScopeKey,
            );
        }
        host.registry = {
            ...registry,
            activeScopeKey: host.activeScopeKey,
        };
        for (const workspace of registry.workspaces) {
            host.surfacePool.ensureCold(workspace.scopeKey);
        }

        if (nextActiveScopeKey) {
            void this.activate(host.hostWindowId, nextActiveScopeKey);
        } else if (host.activeScopeKey) {
            void host.activationCoordinator.closeWorkspace(host.activeScopeKey);
        }

        for (const scopeKey of host.surfaceIdsByContextKey.keys()) {
            if (knownScopeKeys.has(scopeKey)) {
                continue;
            }
            void host.activationCoordinator.closeWorkspace(scopeKey);
        }
        this.#scheduleRecentSurfacePreheat(host);
        return host.registry;
    }

    setLifecycleHandlers(handlers: WorkspaceSurfaceLifecycleHandlers): void {
        this.#lifecycleHandlers = handlers;
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
            !host.registry.workspaces.some(
                (workspace) => workspace.scopeKey === contextKey,
            )
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
            this.#publishSurfaceNavigation(host);
            this.#scheduleRecentSurfacePreheat(host);
        }
        return result;
    }

    requestActiveGitScopeMenu(
        hostWindowId: string,
        anchor: { readonly width: number; readonly x: number },
    ): void {
        const host = this.#hostsByWindowId.get(hostWindowId);
        const surfaceId = host?.activeScopeKey
            ? host.surfaceIdsByContextKey.get(host.activeScopeKey)
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
        this.#publishSurfaceNavigation(host);
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
        if (host.activeScopeKey !== request.contextKey) {
            return { delivered: false, reason: "inactive-context" };
        }
        const activeWorkspace = host.registry.workspaces.find(
            (workspace) => workspace.scopeKey === host.activeScopeKey,
        );
        if (
            surface.contextKey !== request.contextKey ||
            !activeWorkspace ||
            !doesWorkspaceSurfaceContextMatchContext(request, {
                key: activeWorkspace.scopeKey,
                projectId: activeWorkspace.projectId,
                worktreeId: activeWorkspace.worktreeId,
            })
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

    isSurface(webContents: WebContents): boolean {
        return this.#surfaceIdsByWebContentsId.has(webContents.id);
    }

    getActiveContext(
        hostWindowId: string,
    ): WorkspaceSurfaceRegistrySnapshot["workspaces"][number] | null {
        const host = this.#hostsByWindowId.get(hostWindowId);
        if (!host?.activeScopeKey) {
            return null;
        }
        return (
            host.registry.workspaces.find(
                (workspace) => workspace.scopeKey === host.activeScopeKey,
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
    prepareHostForClose(
        hostWindowId: string,
        hostWindow?: BrowserWindow,
    ): Promise<void> {
        const host = this.#hostsByWindowId.get(hostWindowId);
        if (!host || (hostWindow && host.hostWindow !== hostWindow)) {
            return Promise.resolve();
        }
        host.isClosing = true;
        return Promise.resolve();
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
        if (isCurrentHost) {
            this.#hostsByWindowId.delete(host.hostWindowId);
        }
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
                        host.registry,
                    );
                    if (!surface) {
                        throw new Error("Could not create the workspace surface.");
                    }
                    if (
                        !host.activeScopeKey ||
                        !host.surfaceIdsByContextKey.has(host.activeScopeKey)
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
                    host.activeScopeKey = scopeKey;
                    host.warmingContextKey = null;
                    host.registry = {
                        ...host.registry,
                        activeScopeKey: scopeKey,
                        workspaces: host.registry.workspaces.map((workspace) =>
                            workspace.scopeKey === scopeKey
                                ? { ...workspace, lastActivatedAt: activatedAt }
                                : workspace,
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
                        if (!this.#lifecycleHandlers.prepareSurfaceHibernate) {
                            throw new Error(
                                "Workspace surface checkpointing is unavailable.",
                            );
                        }
                        await this.#lifecycleHandlers.prepareSurfaceHibernate(
                            this.#toRuntimeSubscriber(surface),
                            reason,
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
            activeScopeKey: null,
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
            registry: {
                activeScopeKey: null,
                workspaces: [],
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

    #publishSurfaceNavigation(host: WorkspaceSurfaceHostRecord): void {
        if (!host.hostWindow.webContents.isDestroyed()) {
            host.hostWindow.webContents.send(
                IPC_EVENTS.workspaceSurfaceNavigationChanged,
                { activeScopeKey: host.activeScopeKey },
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
        const candidates = host.registry.workspaces
            .filter(
                (workspace) =>
                    workspace.scopeKey !== host.activeScopeKey,
            )
            .sort(
                (left, right) =>
                    Date.parse(right.lastActivatedAt) -
                        Date.parse(left.lastActivatedAt) ||
                    left.scopeKey.localeCompare(right.scopeKey),
            )
            .slice(0, host.surfacePool.maxWarmSurfaces);
        for (const workspace of candidates) {
            if (!host.surfacePool.canPreheat()) {
                break;
            }
            const operationStartedAt = Date.now();
            const warmed = await host.activationCoordinator.preheat(
                workspace.scopeKey,
            );
            this.#recordSurfaceOperation(host, {
                durationMs: Date.now() - operationStartedAt,
                finishedAt: new Date().toISOString(),
                kind: "preheat",
                outcome: warmed ? "warm" : "failed",
                scopeKey: workspace.scopeKey,
            });
        }
        await host.activationCoordinator.enforceBudget();
    }

    #createSurface(
        host: WorkspaceSurfaceHostRecord,
        hostContext: WindowContextSnapshot,
        contextKey: string,
        registry: WorkspaceSurfaceRegistrySnapshot,
    ): WorkspaceSurfaceRecord | null {
        const workspace = registry.workspaces.find(
            (candidate) => candidate.scopeKey === contextKey,
        );
        if (!workspace) {
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
        installWindowOpenHandler(webContents, (url) => {
            if (!host.hostWindow.webContents.isDestroyed()) {
                host.hostWindow.webContents.send(
                    IPC_EVENTS.internalNavigationRequested,
                    url,
                );
            }
        });
        view.setVisible(false);
        webContents.setZoomFactor(
            host.hostWindow.webContents.getZoomFactor(),
        );
        host.hostWindow.contentView.addChildView(view);

        const context: WindowContextSnapshot = {
            hostWindowId: host.hostWindowId,
            projectId: workspace.projectId,
            windowId: id,
            windowKind: "main",
            workspaceId: hostContext.workspaceId,
            workspaceSessionId: hostContext.workspaceSessionId,
            worktreeId: workspace.worktreeId,
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
            event.preventDefault();
            currentHost.hostWindow.webContents.send(
                IPC_EVENTS.workspaceNavigationRequested,
                direction,
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
            this.#failSurfaceRestore(
                surface,
                new Error("The workspace surface was destroyed before it became ready."),
            );
            this.#detachSurfaceRuntime(surface);
            windowRegistry.unregisterEmbeddedRenderer(webContents);
            this.#surfaceIdsByWebContentsId.delete(webContentsId);
        });
        const resolution = this.#lifecycleHandlers.resolveRuntimeOwner?.({
            layoutSnapshot: workspace.initialLayout as unknown as Readonly<
                Record<string, unknown>
            >,
            projectId: workspace.projectId,
            scopeKey: contextKey,
            worktreeId: workspace.worktreeId ?? null,
        }) ?? {
            revision: 0,
            runtimeOwnerId: `workspace-runtime:${contextKey}`,
        };
        if (isPromiseLike(resolution)) {
            void resolution
                .then((resolved) => {
                    this.#loadResolvedSurface(surface, workspace, resolved);
                })
                .catch((error: unknown) => {
                    this.#handleRuntimeResolutionFailure(surface, error);
                });
        } else {
            try {
                this.#loadResolvedSurface(surface, workspace, resolution);
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
        workspace: WorkspaceSurfaceRegistrySnapshot["workspaces"][number],
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
            project: workspace.projectId,
            revision: `${resolution.revision}`,
            "runtime-owner": resolution.runtimeOwnerId,
            scope: surface.contextKey,
            surface: surface.id,
            window: "workspace-surface",
        });
        if (workspace.worktreeId) {
            rendererSearch.set("worktree", workspace.worktreeId);
        }
        // Runtime owner and scope are immutable before renderer bootstrap.
        loadRendererContents(surface.webContents, rendererSearch.toString());
    }

    #getActiveSurface(hostWindowId: string): WorkspaceSurfaceRecord | null {
        const host = this.#hostsByWindowId.get(hostWindowId);
        const surfaceId = host?.activeScopeKey
            ? host.surfaceIdsByContextKey.get(host.activeScopeKey)
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
        if (host.activeScopeKey !== request.contextKey) {
            return "inactive-context";
        }
        const activeWorkspace = host.registry.workspaces.find(
            (workspace) => workspace.scopeKey === host.activeScopeKey,
        );
        if (
            surface.contextKey !== request.contextKey ||
            !activeWorkspace ||
            !doesWorkspaceSurfaceContextMatchContext(request, {
                key: activeWorkspace.scopeKey,
                projectId: activeWorkspace.projectId,
                worktreeId: activeWorkspace.worktreeId,
            })
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
            (host.activeScopeKey
                ? host.surfaceIdsByContextKey.get(host.activeScopeKey)
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

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
    return (
        typeof value === "object" &&
        value !== null &&
        "then" in value &&
        typeof value.then === "function"
    );
}

export const workspaceSurfaceManager = new WorkspaceSurfaceManager();
