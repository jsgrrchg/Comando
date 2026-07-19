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
            append: vi.fn((_sessionId: string, entries: readonly AiTranscriptEntryEnvelope[]) => {
                for (const entry of entries) appended.set(entry.id, entry);
                return Promise.resolve();
            }),
            loadCheckpoint: vi.fn(() => Promise.resolve(checkpoint)),
            loadLegacyPage: vi.fn((_sessionId: string, offset: number, limit: number) => Promise.resolve({
                messages: messages.slice(offset, offset + limit),
                total: messages.length,
            })),
            saveCheckpoint: vi.fn((_sessionId: string, offset: number) => {
                checkpoint = offset;
                return Promise.resolve();
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

    it("keeps legacy fallback when verification fails", async () => {
        const states: unknown[] = [];
        const adapter = {
            append: vi.fn().mockResolvedValue(undefined),
            loadCheckpoint: vi.fn().mockResolvedValue(0),
            loadLegacyPage: vi.fn().mockResolvedValue({
                messages: [message("1")],
                total: 1,
            }),
            saveCheckpoint: vi.fn().mockResolvedValue(undefined),
            saveMigrationState: vi.fn((state: unknown) => {
                states.push(state);
                return Promise.resolve();
            }),
            verify: vi.fn().mockResolvedValue(false),
        };

        const result = await backfillLegacyTranscript(
            adapter,
            "session-1",
            new AbortController().signal,
        );

        expect(result.completed).toBe(false);
        expect(states).toContainEqual(
            expect.objectContaining({ status: "legacy", verified: false }),
        );
    });

    it("resumes from the durable checkpoint after an interrupted page", async () => {
        const messages = [message("1"), message("2"), message("3")];
        let checkpoint = 0;
        const controller = new AbortController();
        const adapter = {
            append: vi.fn(() => Promise.resolve()),
            loadCheckpoint: vi.fn(() => Promise.resolve(checkpoint)),
            loadLegacyPage: vi.fn((_sessionId: string, offset: number, limit: number) =>
                Promise.resolve({ messages: messages.slice(offset, offset + limit), total: 3 }),
            ),
            saveCheckpoint: vi.fn((_sessionId: string, offset: number) => {
                checkpoint = offset;
                if (offset === 2) controller.abort();
                return Promise.resolve();
            }),
        };
        await backfillLegacyTranscript(adapter, "session-1", controller.signal, 2);
        expect(checkpoint).toBe(2);

        const resumed = await backfillLegacyTranscript(
            adapter,
            "session-1",
            new AbortController().signal,
            2,
        );
        expect(resumed.completed).toBe(true);
        expect(checkpoint).toBe(3);
    });
});
