import { describe, expect, it, vi } from "vitest";

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

    it("keeps previously activated surfaces warm until an explicit close", () => {
        let now = 1_000;
        const pool = new WorkspaceSurfacePool({ now: () => now });
        makeWarm(pool, "scope-a", "generation-a");
        pool.activate("scope-a", "generation-a");
        now += 10;
        makeWarm(pool, "scope-b", "generation-b");
        pool.activate("scope-b", "generation-b");
        now += 10;
        makeWarm(pool, "scope-c", "generation-c");
        pool.activate("scope-c", "generation-c");

        expect(pool.get("scope-a")?.state).toBe("warm");
        expect(pool.get("scope-b")?.state).toBe("warm");
        expect(pool.get("scope-c")?.state).toBe("active");
    });

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
