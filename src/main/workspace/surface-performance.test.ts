import { describe, expect, it } from "vitest";

import {
    resolveWorkspaceSurfaceEnvironment,
    WorkspaceSurfacePerformanceMonitor,
} from "./surface-performance";

describe("workspace surface performance", () => {
    it.each([
        ["darwin", false, 32],
        ["win32", true, 8],
        ["linux", false, 4],
    ] as const)(
        "reports %s with battery=%s and %s GiB",
        (platform, isOnBatteryPower, memoryGiB) => {
            expect(
                resolveWorkspaceSurfaceEnvironment({
                    isOnBatteryPower,
                    platform,
                    totalMemoryBytes: memoryGiB * 1024 ** 3,
                }),
            ).toMatchObject({
                energySource: isOnBatteryPower ? "battery" : "external-power",
                platform,
                totalMemoryMb: memoryGiB * 1024,
            });
        },
    );

    it("keeps counters and only the latest memory sample during a long soak", () => {
        const monitor = new WorkspaceSurfacePerformanceMonitor();
        monitor.recordCatalogSync(500, 12);
        for (let index = 0; index < 10_000; index += 1) {
            monitor.recordOperation({
                durationMs: 1,
                finishedAt: "2026-08-01T00:00:00.000Z",
                kind: "activation",
                outcome: index % 2 === 0 ? "warm" : "cold",
                scopeKey: `project-${index % 8}::__primary__`,
            });
            monitor.recordMemorySample([
                {
                    privateKb: index,
                    residentSetKb: index,
                    scopeKey: `project-${index % 8}::__primary__`,
                    sharedKb: 0,
                },
            ]);
        }

        expect(monitor.snapshot()).toMatchObject({
            cacheHits: 5_000,
            cacheMisses: 5_000,
            catalogPeakScopeCount: 500,
            catalogScopeCount: 500,
            catalogSyncs: 1,
            memorySamples: [expect.objectContaining({ privateKb: 9_999 })],
        });
    });

    it("counts blocked hibernation, leases, failures, resync, bounds, and lifecycle", () => {
        const monitor = new WorkspaceSurfacePerformanceMonitor();
        monitor.recordBoundsUpdate();
        monitor.recordFailure();
        monitor.recordLeaseReport();
        monitor.recordLifecycleTransition();
        monitor.recordRendererCreated();
        monitor.recordRendererDestroyed();
        monitor.recordResync(true);
        monitor.recordResync(false);
        monitor.recordOperation({
            durationMs: 2,
            finishedAt: "2026-08-01T00:00:00.000Z",
            kind: "hibernate",
            outcome: "blocked",
            scopeKey: "project-a::__primary__",
        });

        expect(monitor.snapshot()).toMatchObject({
            boundsUpdates: 1,
            failures: 2,
            hibernationsAvoided: 1,
            leaseReports: 1,
            lifecycleTransitions: 1,
            rendererCreates: 1,
            rendererDestroys: 1,
            resyncFailures: 1,
            resyncs: 2,
        });
    });
});
