import type {
    WorkspaceSurfaceActivationResult,
    WorkspaceSurfaceCloseResult,
    WorkspaceSurfaceHardLease,
} from "@shared/ipc";

import { deduplicateLeases, WorkspaceSurfacePool } from "./surface-pool";

export type WorkspaceSurfaceHibernateReason =
    | "budget"
    | "close-workspace"
    | "host-close";

export interface WorkspaceSurfaceAcquireResult {
    readonly generation: string;
    readonly ready: boolean;
    readonly reused: boolean;
}

export interface WorkspaceSurfaceHibernatePreparation {
    readonly checkpointSucceeded: boolean;
    readonly flushSucceeded: boolean;
    readonly leases: readonly WorkspaceSurfaceHardLease[];
}

export interface WorkspaceActivationAdapter {
    readonly acquire: (
        scopeKey: string,
    ) => Promise<WorkspaceSurfaceAcquireResult>;
    readonly commitActiveScope: (
        scopeKey: string | null,
        generation: string | null,
    ) => Promise<void>;
    readonly destroy: (scopeKey: string, generation: string) => Promise<void> | void;
    readonly prepareHibernate: (
        scopeKey: string,
        generation: string,
        reason: WorkspaceSurfaceHibernateReason,
    ) => Promise<WorkspaceSurfaceHibernatePreparation>;
    readonly waitUntilReady: (
        scopeKey: string,
        generation: string,
    ) => Promise<void>;
}

export interface WorkspaceActivationCoordinatorOptions {
    readonly adapter: WorkspaceActivationAdapter;
    readonly pool: WorkspaceSurfacePool;
}

/**
 * Owns the transactional boundary between a renderer becoming ready and the
 * host committing navigation. The previously committed surface stays visible
 * until both steps succeed.
 */
export class WorkspaceActivationCoordinator {
    readonly #adapter: WorkspaceActivationAdapter;
    readonly #pool: WorkspaceSurfacePool;
    #committedScopeKey: string | null = null;
    #operation = 0;

    constructor(options: WorkspaceActivationCoordinatorOptions) {
        this.#adapter = options.adapter;
        this.#pool = options.pool;
    }

    get committedScopeKey(): string | null {
        return this.#committedScopeKey;
    }

    setCommittedScopeForRestore(scopeKey: string | null): void {
        this.#committedScopeKey = scopeKey;
    }

    async activate(scopeKey: string): Promise<WorkspaceSurfaceActivationResult> {
        const existing = this.#pool.get(scopeKey);
        if (
            this.#committedScopeKey === scopeKey &&
            existing?.state === "active" &&
            existing.generation
        ) {
            return {
                generation: existing.generation,
                scopeKey,
                status: "activated",
                warm: true,
            };
        }

        const operation = ++this.#operation;
        let acquired: WorkspaceSurfaceAcquireResult | null = null;
        try {
            acquired = await this.#adapter.acquire(scopeKey);
            const previousEntry = this.#pool.get(scopeKey);
            const wasWarm =
                acquired.reused &&
                (previousEntry?.state === "warm" ||
                    previousEntry?.state === "active");
            if (!acquired.reused || previousEntry?.state === "error") {
                this.#pool.beginWarming(scopeKey, acquired.generation);
            }
            if (!acquired.ready) {
                await this.#adapter.waitUntilReady(scopeKey, acquired.generation);
            }
            if (operation !== this.#operation) {
                await this.#rollbackUncommitted(scopeKey, acquired);
                return { scopeKey, status: "stale" };
            }

            this.#pool.markWarm(scopeKey, acquired.generation);
            await this.#adapter.commitActiveScope(scopeKey, acquired.generation);
            if (operation !== this.#operation) {
                // A newer activation owns the visual commit and will repair the
                // durable active scope without flashing this stale destination.
                return { scopeKey, status: "stale" };
            }
            this.#pool.activate(scopeKey, acquired.generation);
            this.#committedScopeKey = scopeKey;
            await this.enforceBudget();
            return {
                generation: acquired.generation,
                scopeKey,
                status: "activated",
                warm: wasWarm,
            };
        } catch (error) {
            const message = formatError(error);
            if (acquired) {
                try {
                    this.#pool.markError(scopeKey, acquired.generation, message);
                    if (!acquired.reused) {
                        await this.#adapter.destroy(scopeKey, acquired.generation);
                        this.#pool.commitCold(scopeKey, acquired.generation);
                    }
                } catch {
                    // Preserve the original activation error for diagnostics.
                }
            }
            return { message, scopeKey, status: "failed" };
        }
    }

    async preheat(scopeKey: string): Promise<boolean> {
        const existing = this.#pool.get(scopeKey);
        if (
            existing &&
            (existing.state === "active" ||
                existing.state === "warm" ||
                existing.state === "warming")
        ) {
            return true;
        }
        if (!this.#pool.canPreheat()) {
            return false;
        }

        let acquired: WorkspaceSurfaceAcquireResult | null = null;
        try {
            acquired = await this.#adapter.acquire(scopeKey);
            if (!acquired.reused || existing?.state === "error") {
                this.#pool.beginWarming(scopeKey, acquired.generation);
            }
            if (!acquired.ready) {
                await this.#adapter.waitUntilReady(scopeKey, acquired.generation);
            }
            const current = this.#pool.get(scopeKey);
            if (current?.state === "warming") {
                this.#pool.markWarm(scopeKey, acquired.generation);
            }
            return true;
        } catch (error) {
            if (acquired) {
                const message = formatError(error);
                try {
                    this.#pool.markError(scopeKey, acquired.generation, message);
                    if (!acquired.reused) {
                        await this.#adapter.destroy(scopeKey, acquired.generation);
                        this.#pool.commitCold(scopeKey, acquired.generation);
                    }
                } catch {
                    // The surface may already have been replaced by activation.
                }
            }
            return false;
        }
    }

    async closeWorkspace(scopeKey: string): Promise<WorkspaceSurfaceCloseResult> {
        return this.#hibernate(scopeKey, "close-workspace");
    }

    async enforceBudget(): Promise<void> {
        const attempted = new Set<string>();
        while (this.#pool.getWarmCount() > this.#pool.maxWarmSurfaces) {
            const candidate = this.#pool
                .getEvictionCandidates()
                .find((entry) => !attempted.has(entry.scopeKey));
            if (!candidate) {
                return;
            }
            attempted.add(candidate.scopeKey);
            await this.#hibernate(candidate.scopeKey, "budget");
        }
    }

    async hibernateForHostClose(
        scopeKey: string,
    ): Promise<WorkspaceSurfaceCloseResult> {
        return this.#hibernate(scopeKey, "host-close");
    }

    async #hibernate(
        scopeKey: string,
        reason: WorkspaceSurfaceHibernateReason,
    ): Promise<WorkspaceSurfaceCloseResult> {
        const entry = this.#pool.get(scopeKey);
        if (!entry?.generation || entry.state === "cold") {
            return { scopeKey, status: "not-resident" };
        }
        if (entry.state !== "active" && entry.state !== "warm") {
            return {
                leases: [
                    createSyntheticLease(
                        "pending-host-action",
                        `surface:${scopeKey}`,
                        "The workspace renderer is already changing state.",
                    ),
                ],
                scopeKey,
                status: "blocked",
            };
        }

        const generation = entry.generation;
        const wasActive = entry.state === "active";
        if (wasActive) {
            ++this.#operation;
        }
        this.#pool.beginHibernate(scopeKey, generation);
        try {
            const preparation = await this.#adapter.prepareHibernate(
                scopeKey,
                generation,
                reason,
            );
            const currentLeases = this.#pool.get(scopeKey)?.leases ?? [];
            const leases = deduplicateLeases([
                ...currentLeases,
                ...preparation.leases,
                ...(preparation.flushSucceeded
                    ? []
                    : [
                          createSyntheticLease(
                              "failed-flush",
                              `flush:${scopeKey}`,
                              "The workspace layout could not be saved.",
                          ),
                      ]),
                ...(preparation.checkpointSucceeded
                    ? []
                    : [
                          createSyntheticLease(
                              "failed-checkpoint",
                              `checkpoint:${scopeKey}`,
                              "The workspace runtime checkpoint failed.",
                          ),
                      ]),
            ]);
            if (leases.length > 0) {
                this.#pool.abortHibernate(scopeKey, generation);
                return { leases, scopeKey, status: "blocked" };
            }

            if (wasActive) {
                await this.#adapter.commitActiveScope(null, null);
            }
            this.#pool.beginDisposing(scopeKey, generation);
            await this.#adapter.destroy(scopeKey, generation);
            this.#pool.commitCold(scopeKey, generation);
            if (wasActive) {
                this.#committedScopeKey = null;
            }
            return { scopeKey, status: "closed" };
        } catch (error) {
            const message = formatError(error);
            const current = this.#pool.get(scopeKey);
            if (current?.state === "suspending") {
                this.#pool.abortHibernate(scopeKey, generation, message);
            }
            return { message, scopeKey, status: "failed" };
        }
    }

    async #rollbackUncommitted(
        scopeKey: string,
        acquired: WorkspaceSurfaceAcquireResult,
    ): Promise<void> {
        if (acquired.reused) {
            const entry = this.#pool.get(scopeKey);
            if (entry?.state === "warming") {
                this.#pool.markWarm(scopeKey, acquired.generation);
            }
            return;
        }
        this.#pool.beginDisposing(scopeKey, acquired.generation);
        await this.#adapter.destroy(scopeKey, acquired.generation);
        this.#pool.commitCold(scopeKey, acquired.generation);
    }
}

function createSyntheticLease(
    kind: WorkspaceSurfaceHardLease["kind"],
    id: string,
    message: string,
): WorkspaceSurfaceHardLease {
    return {
        acquiredAt: new Date().toISOString(),
        id,
        kind,
        message,
    };
}

function formatError(error: unknown): string {
    return error instanceof Error && error.message
        ? error.message
        : "The workspace surface operation failed.";
}
