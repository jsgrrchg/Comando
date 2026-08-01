import type { WebContents } from "electron";

import type {
    WorkspaceSurfaceLifecycleState,
    WorkspaceSurfaceRuntimeBinding,
} from "@shared/ipc";

export interface WorkspaceRuntimeSubscriber
    extends WorkspaceSurfaceRuntimeBinding {
    readonly webContents: WebContents;
    readonly webContentsId: number;
    lifecycle: WorkspaceSurfaceLifecycleState;
    needsResync: boolean;
}

export interface AttachWorkspaceRuntimeSubscriberInput
    extends WorkspaceSurfaceRuntimeBinding {
    readonly webContents: WebContents;
}

/**
 * Keeps durable runtime ownership separate from replaceable renderer subscribers.
 */
export class WorkspaceRuntimeOwnershipCoordinator {
    readonly #subscribersByOwner = new Map<string, WorkspaceRuntimeSubscriber>();
    readonly #ownersByWebContentsId = new Map<number, string>();

    attach(
        input: AttachWorkspaceRuntimeSubscriberInput,
    ): WorkspaceRuntimeSubscriber | null {
        const previous = this.#subscribersByOwner.get(input.runtimeOwnerId) ?? null;
        if (previous) {
            this.#ownersByWebContentsId.delete(previous.webContentsId);
        }

        const subscriber: WorkspaceRuntimeSubscriber = {
            generation: input.generation,
            lifecycle: "suspended",
            needsResync: true,
            runtimeOwnerId: input.runtimeOwnerId,
            scopeKey: input.scopeKey,
            webContents: input.webContents,
            webContentsId: input.webContents.id,
        };
        this.#subscribersByOwner.set(input.runtimeOwnerId, subscriber);
        this.#ownersByWebContentsId.set(input.webContents.id, input.runtimeOwnerId);
        return previous;
    }

    detach(input: AttachWorkspaceRuntimeSubscriberInput): boolean {
        const current = this.#subscribersByOwner.get(input.runtimeOwnerId);
        if (!current || !matchesSubscriber(current, input)) {
            return false;
        }

        this.#subscribersByOwner.delete(input.runtimeOwnerId);
        this.#ownersByWebContentsId.delete(input.webContents.id);
        return true;
    }

    setLifecycle(
        input: AttachWorkspaceRuntimeSubscriberInput,
        lifecycle: WorkspaceSurfaceLifecycleState,
    ): boolean {
        const current = this.#subscribersByOwner.get(input.runtimeOwnerId);
        if (!current || !matchesSubscriber(current, input)) {
            return false;
        }

        current.lifecycle = lifecycle;
        if (lifecycle === "visible") {
            current.needsResync = true;
        }
        return true;
    }

    markRuntimeChanged(runtimeOwnerId: string): void {
        const subscriber = this.#subscribersByOwner.get(runtimeOwnerId);
        if (subscriber && subscriber.lifecycle !== "visible") {
            subscriber.needsResync = true;
        }
    }

    consumeResyncRequirement(
        input: AttachWorkspaceRuntimeSubscriberInput,
    ): boolean {
        const current = this.#subscribersByOwner.get(input.runtimeOwnerId);
        if (!current || !matchesSubscriber(current, input)) {
            return false;
        }
        const needsResync = current.needsResync;
        current.needsResync = false;
        return needsResync;
    }

    getCurrentSubscriber(
        runtimeOwnerId: string,
    ): WorkspaceRuntimeSubscriber | null {
        const subscriber = this.#subscribersByOwner.get(runtimeOwnerId) ?? null;
        return subscriber && !subscriber.webContents.isDestroyed()
            ? subscriber
            : null;
    }

    getVisibleSubscriber(
        runtimeOwnerId: string,
    ): WorkspaceRuntimeSubscriber | null {
        const subscriber = this.getCurrentSubscriber(runtimeOwnerId);
        return subscriber?.lifecycle === "visible" ? subscriber : null;
    }

    getRuntimeOwnerId(webContents: WebContents): string | null {
        const runtimeOwnerId = this.#ownersByWebContentsId.get(webContents.id);
        const subscriber = runtimeOwnerId
            ? this.#subscribersByOwner.get(runtimeOwnerId)
            : null;
        return subscriber && subscriber.webContents === webContents
            ? (runtimeOwnerId ?? null)
            : null;
    }

    isCurrent(input: AttachWorkspaceRuntimeSubscriberInput): boolean {
        const current = this.#subscribersByOwner.get(input.runtimeOwnerId);
        return Boolean(current && matchesSubscriber(current, input));
    }

    clear(): void {
        this.#subscribersByOwner.clear();
        this.#ownersByWebContentsId.clear();
    }
}

function matchesSubscriber(
    current: WorkspaceRuntimeSubscriber,
    input: AttachWorkspaceRuntimeSubscriberInput,
): boolean {
    return (
        current.generation === input.generation &&
        current.scopeKey === input.scopeKey &&
        current.webContents === input.webContents
    );
}

export const workspaceRuntimeOwnership =
    new WorkspaceRuntimeOwnershipCoordinator();
