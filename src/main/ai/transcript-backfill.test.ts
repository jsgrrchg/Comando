import { describe, expect, it, vi } from "vitest";

import type { AiMessage, AiTranscriptEntryEnvelope } from "@shared/ipc";

import { backfillLegacyTranscript } from "./transcript-backfill";

function message(id: string): AiMessage {
    return {
        attachments: [],
        content: `content ${id}`,
        createdAt: "2026-01-01T00:00:00.000Z",
        id,
        kind: "assistant",
        status: "completed",
    };
}

describe("backfillLegacyTranscript", () => {
    it("checkpoints each page and can resume idempotently", async () => {
        const messages = [message("1"), message("2"), message("3")];
        let checkpoint = 0;
        const appended = new Map<string, AiTranscriptEntryEnvelope>();
        const adapter = {
            append: vi.fn(async (_sessionId: string, entries: readonly AiTranscriptEntryEnvelope[]) => {
                for (const entry of entries) appended.set(entry.id, entry);
            }),
            loadCheckpoint: vi.fn(async () => checkpoint),
            loadLegacyPage: vi.fn(async (_sessionId: string, offset: number, limit: number) => ({
                messages: messages.slice(offset, offset + limit),
                total: messages.length,
            })),
            saveCheckpoint: vi.fn(async (_sessionId: string, offset: number) => {
                checkpoint = offset;
            }),
        };

        const result = await backfillLegacyTranscript(
            adapter,
            "session-1",
            new AbortController().signal,
            2,
        );
        expect(result.completed).toBe(true);
        expect(checkpoint).toBe(3);
        expect(appended.size).toBe(3);
    });
});
