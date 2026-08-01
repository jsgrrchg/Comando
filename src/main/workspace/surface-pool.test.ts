import { describe, expect, it, vi } from "vitest";

import type {
    WorkspaceSurfaceHardLease,
    WorkspaceSurfaceHardLeaseKind,
} from "@shared/ipc";

import { WorkspaceSurfacePool } from "./surface-pool";

describe("WorkspaceSurfacePool", () => {
    it("moves one generation through cold, warming, warm, active and cold", () => {
        let now = 1_000;
        const onChanged = vi.fn();
        const pool = new WorkspaceSurfacePool({
            now: () => now,
            onChanged,
        });

        pool.ensureCold("scope-a");
        pool.beginWarming("scope-a", "generation-a");
        now += 42;
        pool.markWarm("scope-a", "generation-a");
        pool.activate("scope-a", "generation-a");
        pool.beginHibernate("scope-a", "generation-a");
        pool.beginDisposing("scope-a", "generation-a");
        pool.commitCold("scope-a", "generation-a");

        expect(pool.get("scope-a")).toMatchObject({
            generation: null,
            lastReadyDurationMs: 42,
            scopeKey: "scope-a",
            state: "cold",
        });
        expect(onChanged).toHaveBeenCalled();
    });

    it("keeps only one active surface and orders lease-free warm eviction by recency", () => {
        let now = 1_000;
        const pool = new WorkspaceSurfacePool({ maxWarmSurfaces: 1, now: () => now });
        makeWarm(pool, "scope-a", "generation-a");
        pool.activate("scope-a", "generation-a");
        now += 10;
        makeWarm(pool, "scope-b", "generation-b");
        pool.activate("scope-b", "generation-b");
        now += 10;
        makeWarm(pool, "scope-c", "generation-c");
        pool.activate("scope-c", "generation-c");
        pool.setLeases("scope-b", "generation-b", [
            lease("dirty-file", "dirty-b"),
        ]);

        expect(pool.get("scope-a")?.state).toBe("warm");
        expect(pool.get("scope-b")?.state).toBe("warm");
        expect(pool.get("scope-c")?.state).toBe("active");
        expect(pool.getEvictionCandidates().map((entry) => entry.scopeKey)).toEqual([
            "scope-a",
        ]);
    });

    it.each(allHardLeaseKinds)(
        "excludes a warm surface with a %s hard lease from eviction",
        (kind) => {
            const pool = new WorkspaceSurfacePool({ maxWarmSurfaces: 0 });
            makeWarm(pool, "scope-a", "generation-a");
            pool.setLeases("scope-a", "generation-a", [lease(kind, kind)]);

            expect(pool.getEvictionCandidates()).toEqual([]);
            expect(pool.diagnostics().surfaces[0]?.leases).toMatchObject([
                { kind },
            ]);
        },
    );

    it("rejects stale generations without mutating the current surface", () => {
        const pool = new WorkspaceSurfacePool();
        makeWarm(pool, "scope-a", "generation-a");

        expect(() => pool.activate("scope-a", "old-generation")).toThrow(
            "generation is stale",
        );
        expect(pool.get("scope-a")?.state).toBe("warm");
    });
});

function makeWarm(
    pool: WorkspaceSurfacePool,
    scopeKey: string,
    generation: string,
): void {
    pool.ensureCold(scopeKey);
    pool.beginWarming(scopeKey, generation);
    pool.markWarm(scopeKey, generation);
}

function lease(
    kind: WorkspaceSurfaceHardLeaseKind,
    id: string,
): WorkspaceSurfaceHardLease {
    return {
        acquiredAt: "2026-08-01T00:00:00.000Z",
        id,
        kind,
        message: `Blocked by ${kind}`,
    };
}

const allHardLeaseKinds: readonly WorkspaceSurfaceHardLeaseKind[] = [
    "active-drag",
    "ai-critical",
    "critical-modal",
    "dirty-file",
    "external-file-conflict",
    "failed-checkpoint",
    "failed-flush",
    "failed-save",
    "non-durable-composer",
    "pending-host-action",
    "pending-review",
    "saving-file",
    "terminal-busy",
];
