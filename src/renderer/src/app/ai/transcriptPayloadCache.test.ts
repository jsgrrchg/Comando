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
});
