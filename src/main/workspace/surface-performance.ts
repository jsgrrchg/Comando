import type {
    WorkspaceSurfaceEnvironmentDiagnostic,
    WorkspaceSurfaceMemorySampleDiagnostic,
    WorkspaceSurfaceOperationDiagnostic,
    WorkspaceSurfacePerformanceDiagnostic,
} from "@shared/ipc";

const MIB = 1024 * 1024;

export interface WorkspaceSurfaceEnvironmentInput {
    readonly isOnBatteryPower: boolean;
    readonly platform: NodeJS.Platform;
    readonly totalMemoryBytes: number;
}

export function resolveWorkspaceSurfaceEnvironment(
    input: WorkspaceSurfaceEnvironmentInput,
): WorkspaceSurfaceEnvironmentDiagnostic {
    const totalMemoryMb = Math.max(0, Math.round(input.totalMemoryBytes / MIB));

    return {
        energySource: input.isOnBatteryPower ? "battery" : "external-power",
        platform: input.platform,
        totalMemoryMb,
    };
}

interface MutableWorkspaceSurfacePerformance {
    boundsUpdates: number;
    cacheHits: number;
    cacheMisses: number;
    catalogMaxSyncDurationMs: number;
    catalogPeakScopeCount: number;
    catalogScopeCount: number;
    catalogSyncDurationMs: number;
    catalogSyncs: number;
    failures: number;
    hibernations: number;
    hibernationsAvoided: number;
    leaseReports: number;
    lifecycleTransitions: number;
    memorySampledAt: string | null;
    memorySamples: WorkspaceSurfaceMemorySampleDiagnostic[];
    rendererCreates: number;
    rendererDestroys: number;
    resyncFailures: number;
    resyncs: number;
}

export class WorkspaceSurfacePerformanceMonitor {
    readonly #metrics: MutableWorkspaceSurfacePerformance = {
        boundsUpdates: 0,
        cacheHits: 0,
        cacheMisses: 0,
        catalogMaxSyncDurationMs: 0,
        catalogPeakScopeCount: 0,
        catalogScopeCount: 0,
        catalogSyncDurationMs: 0,
        catalogSyncs: 0,
        failures: 0,
        hibernations: 0,
        hibernationsAvoided: 0,
        leaseReports: 0,
        lifecycleTransitions: 0,
        memorySampledAt: null,
        memorySamples: [],
        rendererCreates: 0,
        rendererDestroys: 0,
        resyncFailures: 0,
        resyncs: 0,
    };

    recordBoundsUpdate(): void {
        this.#metrics.boundsUpdates += 1;
    }

    recordCatalogSync(scopeCount: number, durationMs: number): void {
        this.#metrics.catalogScopeCount = Math.max(0, scopeCount);
        this.#metrics.catalogSyncDurationMs = Math.max(0, durationMs);
        this.#metrics.catalogPeakScopeCount = Math.max(
            this.#metrics.catalogPeakScopeCount,
            this.#metrics.catalogScopeCount,
        );
        this.#metrics.catalogMaxSyncDurationMs = Math.max(
            this.#metrics.catalogMaxSyncDurationMs,
            this.#metrics.catalogSyncDurationMs,
        );
        this.#metrics.catalogSyncs += 1;
    }

    recordFailure(): void {
        this.#metrics.failures += 1;
    }

    recordLeaseReport(): void {
        this.#metrics.leaseReports += 1;
    }

    recordLifecycleTransition(): void {
        this.#metrics.lifecycleTransitions += 1;
    }

    recordMemorySample(
        samples: readonly WorkspaceSurfaceMemorySampleDiagnostic[],
        sampledAt = new Date().toISOString(),
    ): void {
        // Only the latest sample is retained so observability cannot grow with soak time.
        this.#metrics.memorySamples = [...samples].sort((left, right) =>
            left.scopeKey.localeCompare(right.scopeKey),
        );
        this.#metrics.memorySampledAt = sampledAt;
    }

    recordOperation(operation: WorkspaceSurfaceOperationDiagnostic): void {
        if (operation.kind === "activation") {
            if (operation.outcome === "warm") {
                this.#metrics.cacheHits += 1;
            } else if (operation.outcome === "cold") {
                this.#metrics.cacheMisses += 1;
            }
        }
        if (operation.kind === "hibernate") {
            if (operation.outcome === "cold") {
                this.#metrics.hibernations += 1;
            } else if (operation.outcome === "blocked") {
                this.#metrics.hibernationsAvoided += 1;
            }
        }
        if (operation.outcome === "failed") {
            this.#metrics.failures += 1;
        }
    }

    recordRendererCreated(): void {
        this.#metrics.rendererCreates += 1;
    }

    recordRendererDestroyed(): void {
        this.#metrics.rendererDestroys += 1;
    }

    recordResync(succeeded: boolean): void {
        this.#metrics.resyncs += 1;
        if (!succeeded) {
            this.#metrics.resyncFailures += 1;
            this.#metrics.failures += 1;
        }
    }

    snapshot(): WorkspaceSurfacePerformanceDiagnostic {
        return {
            ...this.#metrics,
            memorySamples: [...this.#metrics.memorySamples],
        };
    }
}
