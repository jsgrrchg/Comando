import type {
    WorkspaceSurfaceDiagnostic,
    WorkspaceSurfaceHardLease,
    WorkspaceSurfacePoolDiagnostics,
    WorkspaceSurfacePoolState,
} from "@shared/ipc";

interface MutableSurfacePoolEntry {
    error: string | null;
    generation: string | null;
    lastActivatedAt: number | null;
    lastReadyDurationMs: number | null;
    lastTransitionAt: number;
    leases: WorkspaceSurfaceHardLease[];
    readyStartedAt: number | null;
    readonly scopeKey: string;
    state: WorkspaceSurfacePoolState;
    stateBeforeSuspending: "active" | "warm" | null;
}

export interface WorkspaceSurfacePoolOptions {
    readonly now?: () => number;
    readonly onChanged?: () => void;
}

/**
 * Tracks renderer residency independently from the durable workspace catalog.
 * Cold entries are cheap metadata and never imply a live WebContents.
 */
export class WorkspaceSurfacePool {
    readonly #entries = new Map<string, MutableSurfacePoolEntry>();
    readonly #now: () => number;
    readonly #onChanged: () => void;

    constructor(options: WorkspaceSurfacePoolOptions = {}) {
        this.#now = options.now ?? Date.now;
        this.#onChanged = options.onChanged ?? (() => undefined);
    }

    ensureCold(scopeKey: string): void {
        if (this.#entries.has(scopeKey)) {
            return;
        }
        const now = this.#now();
        this.#entries.set(scopeKey, {
            error: null,
            generation: null,
            lastActivatedAt: null,
            lastReadyDurationMs: null,
            lastTransitionAt: now,
            leases: [],
            readyStartedAt: null,
            scopeKey,
            state: "cold",
            stateBeforeSuspending: null,
        });
        this.#onChanged();
    }

    beginWarming(scopeKey: string, generation: string): void {
        const entry = this.#entry(scopeKey);
        if (
            entry.generation === generation &&
            (entry.state === "warming" || entry.state === "warm")
        ) {
            return;
        }
        if (entry.generation && entry.generation !== generation) {
            throw new Error(`Workspace ${scopeKey} already has a resident surface.`);
        }
        this.#transition(entry, "warming", {
            error: null,
            generation,
            leases: [],
            readyStartedAt: this.#now(),
            stateBeforeSuspending: null,
        });
    }

    markWarm(scopeKey: string, generation: string): void {
        const entry = this.#matchingEntry(scopeKey, generation);
        if (entry.state === "active" || entry.state === "warm") {
            return;
        }
        this.#assertState(entry, ["warming"]);
        const now = this.#now();
        this.#transition(entry, "warm", {
            lastReadyDurationMs:
                entry.readyStartedAt === null
                    ? null
                    : Math.max(0, now - entry.readyStartedAt),
            readyStartedAt: null,
        });
    }

    activate(scopeKey: string, generation: string): void {
        const target = this.#matchingEntry(scopeKey, generation);
        this.#assertState(target, ["active", "warm", "warming"]);
        const now = this.#now();

        for (const entry of this.#entries.values()) {
            if (entry === target || entry.state !== "active") {
                continue;
            }
            this.#transition(entry, "warm", {
                stateBeforeSuspending: null,
            });
        }

        this.#transition(target, "active", {
            error: null,
            lastActivatedAt: now,
            lastReadyDurationMs:
                target.readyStartedAt === null
                    ? target.lastReadyDurationMs
                    : Math.max(0, now - target.readyStartedAt),
            readyStartedAt: null,
            stateBeforeSuspending: null,
        });
    }

    setLeases(
        scopeKey: string,
        generation: string,
        leases: readonly WorkspaceSurfaceHardLease[],
    ): boolean {
        const entry = this.#entries.get(scopeKey);
        if (!entry || entry.generation !== generation || entry.state === "cold") {
            return false;
        }
        entry.leases = deduplicateLeases(leases);
        entry.lastTransitionAt = this.#now();
        this.#onChanged();
        return true;
    }

    beginHibernate(scopeKey: string, generation: string): void {
        const entry = this.#matchingEntry(scopeKey, generation);
        this.#assertState(entry, ["active", "warm"]);
        const stateBeforeSuspending = entry.state as "active" | "warm";
        this.#transition(entry, "suspending", { stateBeforeSuspending });
    }

    abortHibernate(
        scopeKey: string,
        generation: string,
        error?: string,
        state?: "active" | "warm",
    ): void {
        const entry = this.#matchingEntry(scopeKey, generation);
        this.#assertState(entry, ["suspending"]);
        this.#transition(entry, state ?? entry.stateBeforeSuspending ?? "warm", {
            error: error ?? entry.error,
            stateBeforeSuspending: null,
        });
    }

    beginDisposing(scopeKey: string, generation: string): void {
        const entry = this.#matchingEntry(scopeKey, generation);
        this.#assertState(entry, ["active", "error", "suspending", "warm", "warming"]);
        this.#transition(entry, "disposing", { stateBeforeSuspending: null });
    }

    restoreAfterFailedDisposal(
        scopeKey: string,
        generation: string,
        state: "active" | "warm",
        error: string,
    ): void {
        const entry = this.#matchingEntry(scopeKey, generation);
        this.#assertState(entry, ["disposing"]);
        this.#transition(entry, state, {
            error,
            stateBeforeSuspending: null,
        });
    }

    commitCold(scopeKey: string, generation: string): void {
        const entry = this.#matchingEntry(scopeKey, generation);
        this.#assertState(entry, ["disposing", "error", "suspending", "warming"]);
        this.#transition(entry, "cold", {
            generation: null,
            leases: [],
            readyStartedAt: null,
            stateBeforeSuspending: null,
        });
    }

    markError(scopeKey: string, generation: string, error: string): void {
        const entry = this.#matchingEntry(scopeKey, generation);
        this.#transition(entry, "error", {
            error,
            readyStartedAt: null,
            stateBeforeSuspending: null,
        });
    }

    get(scopeKey: string): WorkspaceSurfaceDiagnostic | null {
        const entry = this.#entries.get(scopeKey);
        return entry ? this.#toDiagnostic(entry) : null;
    }

    getActiveScopeKey(): string | null {
        for (const entry of this.#entries.values()) {
            if (entry.state === "active") {
                return entry.scopeKey;
            }
        }
        return null;
    }

    getWarmCount(): number {
        let count = 0;
        for (const entry of this.#entries.values()) {
            if (entry.state === "warm") {
                count += 1;
            }
        }
        return count;
    }

    diagnostics(): Omit<
        WorkspaceSurfacePoolDiagnostics,
        "environment" | "performance"
    > {
        return {
            activeScopeKey: this.getActiveScopeKey(),
            recentOperations: [],
            surfaces: [...this.#entries.values()]
                .sort((left, right) => left.scopeKey.localeCompare(right.scopeKey))
                .map((entry) => this.#toDiagnostic(entry)),
            updatedAt: new Date(this.#now()).toISOString(),
        };
    }

    #entry(scopeKey: string): MutableSurfacePoolEntry {
        this.ensureCold(scopeKey);
        return this.#entries.get(scopeKey)!;
    }

    #matchingEntry(
        scopeKey: string,
        generation: string,
    ): MutableSurfacePoolEntry {
        const entry = this.#entry(scopeKey);
        if (entry.generation !== generation) {
            throw new Error(`Workspace ${scopeKey} surface generation is stale.`);
        }
        return entry;
    }

    #assertState(
        entry: MutableSurfacePoolEntry,
        allowed: readonly WorkspaceSurfacePoolState[],
    ): void {
        if (!allowed.includes(entry.state)) {
            throw new Error(
                `Workspace ${entry.scopeKey} cannot transition from ${entry.state}.`,
            );
        }
    }

    #transition(
        entry: MutableSurfacePoolEntry,
        state: WorkspaceSurfacePoolState,
        patch: Partial<MutableSurfacePoolEntry>,
    ): void {
        Object.assign(entry, patch, {
            lastTransitionAt: this.#now(),
            state,
        });
        this.#onChanged();
    }

    #toDiagnostic(entry: MutableSurfacePoolEntry): WorkspaceSurfaceDiagnostic {
        return {
            error: entry.error,
            generation: entry.generation,
            lastActivatedAt:
                entry.lastActivatedAt === null
                    ? null
                    : new Date(entry.lastActivatedAt).toISOString(),
            lastReadyDurationMs: entry.lastReadyDurationMs,
            lastTransitionAt: new Date(entry.lastTransitionAt).toISOString(),
            leases: [...entry.leases],
            scopeKey: entry.scopeKey,
            state: entry.state,
        };
    }
}

export function deduplicateLeases(
    leases: readonly WorkspaceSurfaceHardLease[],
): WorkspaceSurfaceHardLease[] {
    const byId = new Map<string, WorkspaceSurfaceHardLease>();
    for (const lease of leases) {
        if (!lease.id || !lease.message) {
            continue;
        }
        byId.set(lease.id, lease);
    }
    return [...byId.values()].sort(
        (left, right) =>
            left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id),
    );
}
