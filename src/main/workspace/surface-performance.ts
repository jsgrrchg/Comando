import type {
    WorkspaceSurfaceBudgetDiagnostic,
    WorkspaceSurfaceMemorySampleDiagnostic,
    WorkspaceSurfaceOperationDiagnostic,
    WorkspaceSurfacePerformanceDiagnostic,
} from "@shared/ipc";

const MIB = 1024 * 1024;

export interface WorkspaceSurfaceBudgetInput {
    readonly isOnBatteryPower: boolean;
    readonly platform: NodeJS.Platform;
    readonly totalMemoryBytes: number;
}

export function resolveWorkspaceSurfaceBudget(
    input: WorkspaceSurfaceBudgetInput,
): WorkspaceSurfaceBudgetDiagnostic {
    const totalMemoryMb = Math.max(0, Math.round(input.totalMemoryBytes / MIB));
    const memoryLimited = totalMemoryMb > 0 && totalMemoryMb <= 8 * 1024;
    const severelyMemoryLimited = totalMemoryMb > 0 && totalMemoryMb <= 4 * 1024;
    const platformWarmBudget =
        input.platform === "darwin" ? 4 : input.platform === "win32" ? 3 : 2;
    const platformPreheatDelayMs =
        input.platform === "darwin" ? 750 : input.platform === "win32" ? 1_000 : 1_250;
    const maxWarmSurfaces = severelyMemoryLimited
        ? 0
        : input.isOnBatteryPower || memoryLimited
          ? 1
          : platformWarmBudget;

    return {
        energySource: input.isOnBatteryPower ? "battery" : "external-power",
        maxWarmSurfaces,
        platform: input.platform,
        preheatDelayMs: input.isOnBatteryPower
            ? Math.max(2_500, platformPreheatDelayMs)
            : platformPreheatDelayMs,
        preheatEnabled: maxWarmSurfaces > 0,
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
    preheatFailures: number;
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
        preheatFailures: 0,
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
        if (operation.kind === "preheat" && operation.outcome === "failed") {
            this.#metrics.preheatFailures += 1;
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
