import { describe, expect, it, vi } from "vitest";

import type { AiTranscriptEntryEnvelope } from "@shared/ipc";

import { TranscriptPersistenceQueue } from "./transcriptPersistenceQueue";

const entry: AiTranscriptEntryEnvelope = {
    createdAt: "2026-07-18T00:00:00.000Z",
    id: "entry-1",
    kind: "message",
    payloadRef: null,
    sequence: 1,
    sessionId: "session-1",
    summary: { label: null, preview: "fixture", status: "streaming" },
    updatedAt: "2026-07-18T00:00:00.000Z",
};

describe("TranscriptPersistenceQueue", () => {
    it("coalesces visual updates without blocking the caller", async () => {
        const append = vi.fn().mockResolvedValue(undefined);
        const queue = new TranscriptPersistenceQueue({
            append,
            seal: vi.fn().mockResolvedValue(undefined),
        });

        queue.enqueue(entry);
        queue.enqueue({ ...entry, updatedAt: "2026-07-18T00:00:01.000Z" });
        await queue.flushNow(entry.sessionId);

        expect(append).toHaveBeenCalledTimes(1);
        expect(append.mock.calls[0]?.[1]).toHaveLength(1);
    });
});
