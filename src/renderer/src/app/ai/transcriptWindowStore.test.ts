import { describe, expect, it, vi } from "vitest";

import type { AiTranscriptBlock } from "@shared/ipc";

import { TranscriptWindowStore } from "./transcriptWindowStore";

function block(blockId: string, count: number): AiTranscriptBlock {
    return {
        blockId,
        capabilityVersion: 1,
        endSequence: count,
        entries: [],
        entryCount: count,
        estimatedHeight: count * 72,
        estimatedRowCount: count,
        firstCreatedAt: "2026-01-01T00:00:00.000Z",
        lastCreatedAt: "2026-01-01T00:00:00.000Z",
        revision: 1,
        sessionId: "session-1",
        startSequence: 1,
        transcriptRevision: 1,
    };
}

describe("TranscriptWindowStore", () => {
    it("deduplicates loads and evicts only recoverable blocks", async () => {
        const loadBlock = vi.fn((_sessionId: string, blockId: string) =>
            Promise.resolve(block(blockId, 256)),
        );
        const store = new TranscriptWindowStore({ loadBlock }, 512);

        const first = store.load("session-1", "block-1");
        const duplicate = store.load("session-1", "block-1");
        await Promise.all([first, duplicate]);
        store.protect("session-1", new Set(["block-1"]));
        await store.load("session-1", "block-2");
        await store.load("session-1", "block-3");

        expect(loadBlock).toHaveBeenCalledTimes(3);
        expect(store.snapshot("session-1").blocksById.has("block-1")).toBe(true);
        expect(store.snapshot("session-1").residentEntries).toBeLessThanOrEqual(512);
    });

    it("retains a protected scroll window while newer blocks are loaded", async () => {
        const loadBlock = vi.fn((_sessionId: string, blockId: string) =>
            Promise.resolve(block(blockId, 256)),
        );
        const store = new TranscriptWindowStore({ loadBlock }, 512);

        await store.load("session-1", "block-1");
        await store.load("session-1", "block-2");
        store.protect("session-1", new Set(["block-1", "block-2"]));
        await store.load("session-1", "block-3");

        const snapshot = store.snapshot("session-1");
        expect(snapshot.blocksById.has("block-1")).toBe(true);
        expect(snapshot.blocksById.has("block-2")).toBe(true);
        expect(snapshot.blocksById.has("block-3")).toBe(false);
    });

    it("shares the resident-entry budget across cold sessions", async () => {
        const loadBlock = vi.fn((_sessionId: string, blockId: string) =>
            Promise.resolve(block(blockId, 256)),
        );
        const store = new TranscriptWindowStore({ loadBlock }, 512);

        await store.load("session-1", "block-1");
        await store.load("session-2", "block-2");
        await store.load("session-3", "block-3");

        const residentEntries = ["session-1", "session-2", "session-3"]
            .map((sessionId) => store.snapshot(sessionId).residentEntries)
            .reduce((total, count) => total + count, 0);
        expect(residentEntries).toBeLessThanOrEqual(512);
        expect(store.takeEvictedSessionIds()).toEqual(["session-1"]);
        expect(store.takeEvictedSessionIds()).toEqual([]);
    });

    it("invalidates a cached block when metadata advances its revision", async () => {
        const initial = block("block-1", 256);
        const revised = { ...initial, revision: 2 };
        const loadBlock = vi
            .fn()
            .mockResolvedValueOnce(initial)
            .mockResolvedValueOnce(revised);
        const store = new TranscriptWindowStore({ loadBlock }, 512);

        store.setMetadata("session-1", [initial]);
        await store.load("session-1", initial.blockId);
        store.setMetadata("session-1", [revised]);

        expect(store.snapshot("session-1").blocksById.has(initial.blockId)).toBe(false);
        await store.load("session-1", initial.blockId);
        expect(loadBlock).toHaveBeenCalledTimes(2);
    });

    it("enforces the hard budget when stale tabs still protect blocks", async () => {
        const loadBlock = vi.fn((_sessionId: string, blockId: string) =>
            Promise.resolve(block(blockId, 256)),
        );
        const store = new TranscriptWindowStore({ loadBlock }, 256);

        await store.load("session-1", "block-1");
        store.protect("session-1", new Set(["block-1"]));
        await store.load("session-2", "block-2");
        store.protect("session-2", new Set(["block-2"]));

        const residentEntries = ["session-1", "session-2"]
            .map((sessionId) => store.snapshot(sessionId).residentEntries)
            .reduce((total, count) => total + count, 0);
        expect(residentEntries).toBeLessThanOrEqual(256);
    });
});
