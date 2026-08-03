import { describe, expect, it, vi } from "vitest";

import { TranscriptPayloadCache } from "./transcriptPayloadCache";

describe("TranscriptPayloadCache", () => {
    it("enforces byte eviction for 100 KB, 1 MB, and 5 MB payloads", async () => {
        const kibibyte = 1024;
        const mebibyte = 1024 * kibibyte;
        const payloads = new Map([
            ["100kb", new Uint8Array(100 * kibibyte)],
            ["1mb", new Uint8Array(mebibyte)],
            ["5mb", new Uint8Array(5 * mebibyte)],
        ]);
        const cache = new TranscriptPayloadCache(
            {
                load: (payloadRef) =>
                    Promise.resolve(payloads.get(payloadRef)!),
            },
            6 * mebibyte,
            (payload) => payload.byteLength,
        );

        await cache.load("100kb");
        await cache.load("1mb");
        await cache.load("5mb");

        expect(cache.residentBytes).toBe(6 * mebibyte);
        expect(cache.has("100kb")).toBe(false);
        expect(cache.has("1mb")).toBe(true);
        expect(cache.has("5mb")).toBe(true);
        expect(cache.takeEvictedPayloadRefs()).toEqual(["100kb"]);

        cache.protect("1mb");
        cache.protect("5mb");
        cache.applyMemoryPressure(0);

        expect(cache.residentBytes).toBe(0);
        expect(cache.has("1mb")).toBe(false);
        expect(cache.has("5mb")).toBe(false);
        expect(cache.takeEvictedPayloadRefs()).toEqual(
            expect.arrayContaining(["1mb", "5mb"]),
        );
    });

    it("loads heavy payloads only on demand and enforces its byte budget", async () => {
        const load = vi.fn((payloadRef: string) =>
            Promise.resolve(payloadRef.repeat(10)),
        );
        const cache = new TranscriptPayloadCache({ load }, 100, (value) => value.length * 2);

        expect(load).not.toHaveBeenCalled();
        await cache.load("first");
        await cache.load("second");

        expect(load).toHaveBeenCalledTimes(2);
        expect(cache.residentBytes).toBeLessThanOrEqual(100);
    });

    it("allows retry after a rejected payload request", async () => {
        const load = vi
            .fn<(payloadRef: string) => Promise<string>>()
            .mockRejectedValueOnce(new Error("temporary"))
            .mockResolvedValueOnce("recovered");
        const cache = new TranscriptPayloadCache({ load }, 100, (value) => value.length);

        await expect(cache.load("payload-1")).rejects.toThrow("temporary");
        await expect(cache.load("payload-1")).resolves.toBe("recovered");
        expect(load).toHaveBeenCalledTimes(2);
    });

    it("protects a cached payload when it becomes visible again", async () => {
        const cache = new TranscriptPayloadCache(
            { load: (payloadRef: string) => Promise.resolve(payloadRef) },
            20,
            (value) => value.length,
        );
        await cache.load("visible");
        await cache.load("visible", { protect: true });
        await cache.load("recoverable");

        cache.applyMemoryPressure(0.5);

        expect(cache.has("visible")).toBe(true);
        expect(cache.has("recoverable")).toBe(false);
    });

    it("retains the most recently touched recoverable payload", async () => {
        const cache = new TranscriptPayloadCache(
            { load: (payloadRef: string) => Promise.resolve(payloadRef) },
            2,
            () => 1,
        );
        await cache.load("first");
        await cache.load("second");
        await cache.load("first");
        await cache.load("third");

        expect(cache.has("first")).toBe(true);
        expect(cache.has("second")).toBe(false);
        expect(cache.has("third")).toBe(true);
        expect(cache.residentBytes).toBe(2);
    });

    it("enforces memory pressure even when all payloads are protected", async () => {
        const cache = new TranscriptPayloadCache(
            { load: (payloadRef: string) => Promise.resolve(payloadRef.repeat(8)) },
            256,
            (value) => value.length,
        );
        await cache.load("protected");
        cache.protect("protected");
        await cache.load("recoverable");

        cache.applyMemoryPressure(0);

        expect(cache.residentBytes).toBe(0);
        expect(cache.takeEvictedPayloadRefs()).toEqual(
            expect.arrayContaining(["protected", "recoverable"]),
        );
    });

    it("coalesces uncached payloads into one batch request", async () => {
        const loadMany = vi.fn((payloadRefs: readonly string[]) =>
            Promise.resolve(
                new Map(payloadRefs.map((payloadRef) => [payloadRef, payloadRef])),
            ),
        );
        const cache = new TranscriptPayloadCache(
            { load: vi.fn(), loadMany },
            100,
            (value: string) => value.length,
        );

        await expect(cache.loadMany(["payload-1", "payload-2"])).resolves.toEqual(
            new Map([
                ["payload-1", "payload-1"],
                ["payload-2", "payload-2"],
            ]),
        );
        expect(loadMany).toHaveBeenCalledOnce();
        expect(loadMany).toHaveBeenCalledWith(["payload-1", "payload-2"]);
    });

    it("joins concurrent batch loads without double-counting cached payloads", async () => {
        let resolveBatch!: (payloads: ReadonlyMap<string, string>) => void;
        const loadMany = vi.fn(() =>
            new Promise<ReadonlyMap<string, string>>((resolve) => {
                resolveBatch = resolve;
            }),
        );
        const cache = new TranscriptPayloadCache(
            { load: vi.fn(), loadMany },
            100,
            (value: string) => value.length,
        );

        const first = cache.loadMany(["payload-1", "payload-2"]);
        const second = cache.loadMany(["payload-1", "payload-2"]);

        expect(loadMany).toHaveBeenCalledOnce();
        resolveBatch(new Map([
            ["payload-1", "a".repeat(40)],
            ["payload-2", "b".repeat(40)],
        ]));

        await expect(Promise.all([first, second])).resolves.toEqual([
            new Map([
                ["payload-1", "a".repeat(40)],
                ["payload-2", "b".repeat(40)],
            ]),
            new Map([
                ["payload-1", "a".repeat(40)],
                ["payload-2", "b".repeat(40)],
            ]),
        ]);
        expect(cache.residentBytes).toBe(80);
        expect(cache.has("payload-1")).toBe(true);
        expect(cache.has("payload-2")).toBe(true);
    });

    it("coalesces concurrent 1 MB single-payload loads", async () => {
        let resolvePayload!: (payload: Uint8Array) => void;
        const load = vi.fn(
            () =>
                new Promise<Uint8Array>((resolve) => {
                    resolvePayload = resolve;
                }),
        );
        const cache = new TranscriptPayloadCache(
            { load },
            2 * 1024 * 1024,
            (payload) => payload.byteLength,
        );

        const first = cache.load("1mb");
        const second = cache.load("1mb");

        expect(load).toHaveBeenCalledOnce();
        resolvePayload(new Uint8Array(1024 * 1024));

        await expect(Promise.all([first, second])).resolves.toEqual([
            expect.any(Uint8Array),
            expect.any(Uint8Array),
        ]);
        expect(cache.residentBytes).toBe(1024 * 1024);
        expect(cache.has("1mb")).toBe(true);
    });
});
