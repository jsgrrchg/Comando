import { describe, expect, it } from "vitest";

import type { AiTranscriptBlock, AiTranscriptEntryEnvelope } from "@shared/ipc";

import { TimelineBlockCache } from "./timelineBlocks";

const entry: AiTranscriptEntryEnvelope = {
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "message-1",
    kind: "message",
    payloadRef: null,
    sequence: 1,
    sessionId: "session-1",
    summary: { label: null, preview: "hello", status: "completed" },
    updatedAt: "2026-01-01T00:00:00.000Z",
};
const block: AiTranscriptBlock = {
    blockId: "block-1",
    capabilityVersion: 1,
    endSequence: 1,
    entries: [entry],
    entryCount: 1,
    estimatedHeight: 72,
    estimatedRowCount: 1,
    firstCreatedAt: entry.createdAt,
    lastCreatedAt: entry.createdAt,
    revision: 1,
    sessionId: entry.sessionId,
    startSequence: 1,
    transcriptRevision: 1,
};

describe("TimelineBlockCache", () => {
    it("reuses exact block and presentation revisions", () => {
        const cache = new TimelineBlockCache();
        const preferences = { activityVisible: true, fontKey: "default" };
        expect(cache.derive(block, preferences)).toBe(
            cache.derive(block, preferences),
        );
        expect(cache.derive(block, { ...preferences, activityVisible: false })).not.toBe(
            cache.derive(block, preferences),
        );
    });
});
