import { describe, expect, it, vi } from "vitest";

import type {
    WorkspaceSurfaceHardLease,
    WorkspaceSurfaceHardLeaseKind,
} from "@shared/ipc";

import {
    WorkspaceActivationCoordinator,
    type WorkspaceActivationAdapter,
    type WorkspaceSurfaceHibernatePreparation,
} from "./activation-coordinator";
import { WorkspaceSurfacePool } from "./surface-pool";

describe("WorkspaceActivationCoordinator", () => {
    it("switches to a warm surface without waiting for another restore", async () => {
        const harness = createHarness();
        await expect(harness.coordinator.activate("scope-a")).resolves.toMatchObject({
            status: "activated",
            warm: false,
        });
        await harness.coordinator.activate("scope-b");
        const waitCount = harness.adapter.waitUntilReady.mock.calls.length;

        await expect(harness.coordinator.activate("scope-a")).resolves.toMatchObject({
            status: "activated",
            warm: true,
        });

        expect(harness.adapter.waitUntilReady).toHaveBeenCalledTimes(waitCount);
        expect(harness.pool.get("scope-a")?.state).toBe("active");
        expect(harness.pool.get("scope-b")?.state).toBe("warm");
    });

    it("keeps the committed scope visible until a cold restore reports ready", async () => {
        const harness = createHarness();
        await harness.coordinator.activate("scope-a");
        harness.blockRestore("scope-b");

        const activation = harness.coordinator.activate("scope-b");
        await vi.waitFor(() =>
            expect(harness.adapter.waitUntilReady).toHaveBeenCalledWith(
                "scope-b",
                expect.any(String),
            ),
        );
        expect(harness.coordinator.committedScopeKey).toBe("scope-a");
        expect(harness.pool.get("scope-a")?.state).toBe("active");

        harness.finishRestore("scope-b");
        await expect(activation).resolves.toMatchObject({ status: "activated" });
        expect(harness.coordinator.committedScopeKey).toBe("scope-b");
    });

    it("rolls back create, ready and navigation failures without replacing the committed scope", async () => {
        const harness = createHarness();
        await harness.coordinator.activate("scope-a");

        harness.adapter.acquire.mockRejectedValueOnce(new Error("create failed"));
        await expect(harness.coordinator.activate("scope-create")).resolves.toEqual({
            message: "create failed",
            scopeKey: "scope-create",
            status: "failed",
        });

        harness.failRestore("scope-ready", "ready failed");
        await expect(harness.coordinator.activate("scope-ready")).resolves.toEqual({
            message: "ready failed",
            scopeKey: "scope-ready",
            status: "failed",
        });

        harness.failCommit("scope-commit", "navigation failed");
        await expect(harness.coordinator.activate("scope-commit")).resolves.toEqual({
            message: "navigation failed",
            scopeKey: "scope-commit",
            status: "failed",
        });

        expect(harness.coordinator.committedScopeKey).toBe("scope-a");
        expect(harness.pool.get("scope-a")?.state).toBe("active");
        expect(harness.pool.get("scope-ready")?.state).toBe("cold");
        expect(harness.pool.get("scope-commit")?.state).toBe("cold");
    });

    it("finalizes a successful commit when a newer activation fails", async () => {
        const harness = createHarness();
        await harness.coordinator.activate("scope-original");
        const commit = deferred();
        harness.blockCommit("scope-a", commit);

        const activationA = harness.coordinator.activate("scope-a");
        await vi.waitFor(() =>
            expect(harness.adapter.commitActiveScope).toHaveBeenCalledWith(
                "scope-a",
                expect.any(String),
            ),
        );
        harness.adapter.acquire.mockRejectedValueOnce(new Error("newer failed"));
        const activationB = harness.coordinator.activate("scope-b");
        commit.resolve();

        await expect(activationA).resolves.toEqual({
            scopeKey: "scope-a",
            status: "stale",
        });
        await expect(activationB).resolves.toMatchObject({ status: "failed" });
        expect(harness.coordinator.committedScopeKey).toBe("scope-a");
        expect(harness.pool.get("scope-a")?.state).toBe("active");
    });

    it("does not clear a newer activation that wins during close preparation", async () => {
        const preparation = deferred();
        const harness = createHarness({ preparationPromise: preparation.promise });
        await harness.coordinator.activate("scope-a");

        const close = harness.coordinator.closeWorkspace("scope-a");
        await vi.waitFor(() =>
            expect(harness.adapter.prepareHibernate).toHaveBeenCalled(),
        );
        await harness.coordinator.activate("scope-b");
        preparation.resolve();

        await expect(close).resolves.toMatchObject({ status: "failed" });
        expect(harness.coordinator.committedScopeKey).toBe("scope-b");
        expect(harness.pool.get("scope-b")?.state).toBe("active");
        expect(harness.pool.get("scope-a")?.state).toBe("warm");
        expect(harness.committedScopes.at(-1)).toBe("scope-b");
    });

    it("does not clear a newer activation that commits during disposal", async () => {
        const harness = createHarness();
        await harness.coordinator.activate("scope-a");
        const disposal = harness.blockDestroy("scope-a");

        const close = harness.coordinator.closeWorkspace("scope-a");
        await vi.waitFor(() =>
            expect(harness.adapter.destroy).toHaveBeenCalledWith(
                "scope-a",
                expect.any(String),
            ),
        );
        await harness.coordinator.activate("scope-b");
        disposal.resolve();

        await expect(close).resolves.toMatchObject({ status: "closed" });
        expect(harness.coordinator.committedScopeKey).toBe("scope-b");
        expect(harness.pool.get("scope-b")?.state).toBe("active");
        expect(harness.committedScopes.at(-1)).toBe("scope-b");
    });

    it("closes active and warm surfaces without deleting their cold pool entries", async () => {
        const harness = createHarness();
        await harness.coordinator.activate("scope-a");
        await harness.coordinator.activate("scope-b");

        await expect(harness.coordinator.closeWorkspace("scope-a")).resolves.toEqual({
            scopeKey: "scope-a",
            status: "closed",
        });
        expect(harness.pool.get("scope-a")).toMatchObject({
            generation: null,
            scopeKey: "scope-a",
            state: "cold",
        });
        expect(harness.committedScopes).not.toContain(null);

        await expect(harness.coordinator.closeWorkspace("scope-b")).resolves.toEqual({
            scopeKey: "scope-b",
            status: "closed",
        });
        expect(harness.committedScopes.at(-1)).toBe(null);
        expect(harness.coordinator.committedScopeKey).toBeNull();
    });

    it("waits for background preheating before closing a workspace", async () => {
        const harness = createHarness();
        harness.blockRestore("scope-a");

        const preheat = harness.coordinator.preheat("scope-a");
        await vi.waitFor(() =>
            expect(harness.adapter.waitUntilReady).toHaveBeenCalledWith(
                "scope-a",
                expect.any(String),
            ),
        );

        const close = harness.coordinator.closeWorkspace("scope-a");
        expect(harness.adapter.prepareHibernate).not.toHaveBeenCalled();

        harness.finishRestore("scope-a");

        await expect(preheat).resolves.toBe(true);
        await expect(close).resolves.toEqual({
            scopeKey: "scope-a",
            status: "closed",
        });
        expect(harness.pool.get("scope-a")?.state).toBe("cold");
    });

    it("coalesces concurrent close requests for the same workspace", async () => {
        const preparation = deferred();
        const harness = createHarness({ preparationPromise: preparation.promise });
        await harness.coordinator.activate("scope-a");

        const firstClose = harness.coordinator.closeWorkspace("scope-a");
        await vi.waitFor(() =>
            expect(harness.adapter.prepareHibernate).toHaveBeenCalledTimes(1),
        );
        const secondClose = harness.coordinator.closeWorkspace("scope-a");
        preparation.resolve();

        await expect(firstClose).resolves.toEqual({
            scopeKey: "scope-a",
            status: "closed",
        });
        await expect(secondClose).resolves.toEqual({
            scopeKey: "scope-a",
            status: "closed",
        });
        expect(harness.adapter.prepareHibernate).toHaveBeenCalledTimes(1);
        expect(harness.adapter.destroy).toHaveBeenCalledTimes(1);
    });

    it("disposes a failed resident surface when it has no hard leases", async () => {
        const harness = createHarness();
        await harness.coordinator.activate("scope-a");
        await harness.coordinator.activate("scope-b");
        harness.failCommit("scope-a", "navigation failed");
        await expect(
            harness.coordinator.activate("scope-a"),
        ).resolves.toMatchObject({ status: "failed" });
        expect(harness.pool.get("scope-a")?.state).toBe("error");

        await expect(
            harness.coordinator.closeWorkspace("scope-a"),
        ).resolves.toEqual({
            scopeKey: "scope-a",
            status: "closed",
        });
        expect(harness.pool.get("scope-a")?.state).toBe("cold");
    });

    it("keeps a failed resident surface when it still has a hard lease", async () => {
        const harness = createHarness();
        const activation = await harness.coordinator.activate("scope-a");
        if (activation.status !== "activated") {
            throw new Error("Expected activation to succeed.");
        }
        await harness.coordinator.activate("scope-b");
        harness.pool.setLeases("scope-a", activation.generation, [
            lease("dirty-file", "dirty-a"),
        ]);
        harness.failCommit("scope-a", "navigation failed");
        await harness.coordinator.activate("scope-a");

        await expect(
            harness.coordinator.closeWorkspace("scope-a"),
        ).resolves.toMatchObject({
            leases: [expect.objectContaining({ kind: "dirty-file" })],
            status: "blocked",
        });
        expect(harness.pool.get("scope-a")?.state).toBe("error");
        expect(harness.adapter.destroy).not.toHaveBeenCalled();
    });

    it("keeps a surface resident when flush or checkpoint fails", async () => {
        const harness = createHarness({
            preparation: {
                checkpointSucceeded: false,
                flushSucceeded: false,
                leases: [],
            },
        });
        await harness.coordinator.activate("scope-a");

        const result = await harness.coordinator.closeWorkspace("scope-a");

        expect(result.status).toBe("blocked");
        if (result.status !== "blocked") {
            throw new Error("Expected the failed flush to block close.");
        }
        expect(result.leases.map((lease) => lease.kind)).toEqual([
            "failed-checkpoint",
            "failed-flush",
        ]);
        expect(harness.pool.get("scope-a")?.state).toBe("active");
        expect(harness.adapter.destroy).not.toHaveBeenCalled();
    });

    it.each(["active", "warm"] as const)(
        "restores a %s surface when renderer disposal fails",
        async (state) => {
            const harness = createHarness();
            await harness.coordinator.activate("scope-a");
            if (state === "warm") {
                await harness.coordinator.activate("scope-b");
            }
            harness.adapter.destroy.mockRejectedValueOnce(
                new Error("destroy failed"),
            );

            await expect(
                harness.coordinator.closeWorkspace("scope-a"),
            ).resolves.toMatchObject({
                message: "destroy failed",
                status: "failed",
            });
            expect(harness.pool.get("scope-a")?.state).toBe(state);
            if (state === "active") {
                expect(harness.coordinator.committedScopeKey).toBe("scope-a");
                expect(harness.committedScopes.slice(-2)).toEqual([
                    null,
                    "scope-a",
                ]);
            }
        },
    );

    it.each(allHardLeaseKinds)(
        "blocks explicit close for the %s hard lease",
        async (kind) => {
            const harness = createHarness();
            const activation = await harness.coordinator.activate("scope-a");
            if (activation.status !== "activated") {
                throw new Error("Expected activation to succeed.");
            }
            harness.pool.setLeases("scope-a", activation.generation, [
                lease(kind, kind),
            ]);

            await expect(
                harness.coordinator.closeWorkspace("scope-a"),
            ).resolves.toMatchObject({
                leases: [expect.objectContaining({ kind })],
                status: "blocked",
            });
            expect(harness.pool.get("scope-a")?.state).toBe("active");
        },
    );

    it("keeps a leased workspace resident after another workspace is activated", async () => {
        const harness = createHarness({ maxWarmSurfaces: 0 });
        const activation = await harness.coordinator.activate("scope-a");
        if (activation.status !== "activated") {
            throw new Error("Expected activation to succeed.");
        }
        harness.pool.setLeases("scope-a", activation.generation, [
            lease("terminal-busy", "terminal-a"),
        ]);

        await harness.coordinator.activate("scope-b");

        expect(harness.pool.getWarmCount()).toBe(1);
        expect(harness.pool.get("scope-a")?.state).toBe("warm");
        expect(harness.liveSurfaces.has("scope-a")).toBe(true);
    });

    it("keeps every activated workspace resident until it is explicitly closed", async () => {
        const harness = createHarness({ maxWarmSurfaces: 1 });
        await harness.coordinator.activate("scope-a");
        await harness.coordinator.activate("scope-b");
        await harness.coordinator.activate("scope-c");

        expect(harness.pool.get("scope-a")?.state).toBe("warm");
        expect(harness.pool.get("scope-b")?.state).toBe("warm");
        expect(harness.pool.get("scope-c")?.state).toBe("active");
        expect(harness.liveSurfaces.has("scope-a")).toBe(true);
    });
});

function createHarness(options: {
    readonly maxWarmSurfaces?: number;
    readonly preparation?: WorkspaceSurfaceHibernatePreparation;
    readonly preparationPromise?: Promise<void>;
} = {}) {
    let nextGeneration = 0;
    const liveSurfaces = new Map<
        string,
        { readonly generation: string; ready: boolean }
    >();
    const blockedRestores = new Map<string, ReturnType<typeof deferred>>();
    const failedRestores = new Map<string, Error>();
    const failedCommits = new Map<string, Error>();
    const blockedCommits = new Map<string, ReturnType<typeof deferred>>();
    const blockedDestroys = new Map<string, ReturnType<typeof deferred>>();
    const committedScopes: Array<string | null> = [];
    const pool = new WorkspaceSurfacePool({
        maxWarmSurfaces: options.maxWarmSurfaces,
    });
    const adapter = {
        acquire: vi.fn((scopeKey: string) => {
            const existing = liveSurfaces.get(scopeKey);
            if (existing) {
                return Promise.resolve({
                    generation: existing.generation,
                    ready: existing.ready,
                    reused: true,
                });
            }
            const surface = {
                generation: `generation-${++nextGeneration}`,
                ready:
                    !blockedRestores.has(scopeKey) &&
                    !failedRestores.has(scopeKey),
            };
            liveSurfaces.set(scopeKey, surface);
            return Promise.resolve({
                generation: surface.generation,
                ready: surface.ready,
                reused: false,
            });
        }),
        commitActiveScope: vi.fn(async (scopeKey: string | null) => {
            const failure = scopeKey ? failedCommits.get(scopeKey) : null;
            if (failure) {
                throw failure;
            }
            const blocked = scopeKey ? blockedCommits.get(scopeKey) : null;
            if (blocked) {
                await blocked.promise;
            }
            committedScopes.push(scopeKey);
        }),
        destroy: vi.fn(async (scopeKey: string) => {
            await blockedDestroys.get(scopeKey)?.promise;
            liveSurfaces.delete(scopeKey);
        }),
        prepareHibernate: vi.fn(async () => {
            await options.preparationPromise;
            return options.preparation ?? {
                checkpointSucceeded: true,
                flushSucceeded: true,
                leases: [],
            };
        }),
        waitUntilReady: vi.fn(async (scopeKey: string) => {
            const failed = failedRestores.get(scopeKey);
            if (failed) {
                throw failed;
            }
            const blocked = blockedRestores.get(scopeKey);
            if (blocked) {
                await blocked.promise;
            }
            const surface = liveSurfaces.get(scopeKey);
            if (surface) {
                surface.ready = true;
            }
        }),
    } satisfies WorkspaceActivationAdapter;
    const coordinator = new WorkspaceActivationCoordinator({ adapter, pool });

    return {
        adapter,
        blockDestroy: (scopeKey: string) => {
            const disposal = deferred();
            blockedDestroys.set(scopeKey, disposal);
            return disposal;
        },
        blockRestore: (scopeKey: string) => {
            blockedRestores.set(scopeKey, deferred());
        },
        blockCommit: (
            scopeKey: string,
            commit: ReturnType<typeof deferred>,
        ) => {
            blockedCommits.set(scopeKey, commit);
        },
        committedScopes,
        coordinator,
        failCommit: (scopeKey: string, message: string) => {
            failedCommits.set(scopeKey, new Error(message));
        },
        failRestore: (scopeKey: string, message: string) => {
            failedRestores.set(scopeKey, new Error(message));
        },
        finishRestore: (scopeKey: string) => {
            blockedRestores.get(scopeKey)?.resolve();
        },
        liveSurfaces,
        pool,
    };
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((promiseResolve) => {
        resolve = promiseResolve;
    });
    return { promise, resolve };
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
