import { describe, expect, it, vi } from "vitest";

import { TranscriptPayloadCache } from "./transcriptPayloadCache";

describe("TranscriptPayloadCache", () => {
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
});
