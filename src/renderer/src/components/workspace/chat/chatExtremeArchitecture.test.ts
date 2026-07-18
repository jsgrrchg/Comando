import { describe, expect, it, vi } from "vitest";

import type {
    AiTranscriptBlock,
    AiTranscriptBlockMetadata,
} from "@shared/ipc";
import { TranscriptWindowStore } from "@renderer/app/ai/transcriptWindowStore";
import { ChatActivationScheduler } from "@renderer/app/workspace/chatActivationScheduler";

const BLOCK_SIZE = 256;

function metadata(index: number): AiTranscriptBlockMetadata {
    const start = index * BLOCK_SIZE + 1;
    return {
        blockId: `session-1:${index}`,
        endSequence: start + BLOCK_SIZE - 1,
        entryCount: BLOCK_SIZE,
        estimatedHeight: BLOCK_SIZE * 72,
        estimatedRowCount: BLOCK_SIZE,
        firstCreatedAt: "2026-01-01T00:00:00.000Z",
        lastCreatedAt: "2026-01-01T00:00:00.000Z",
        revision: 1,
        sessionId: "session-1",
        startSequence: start,
    };
}

describe("extreme chat architecture", () => {
    it("keeps a 100k transcript represented as metadata plus a bounded window", async () => {
        const allMetadata = Array.from({ length: 391 }, (_, index) => metadata(index));
        const loadBlock = vi.fn((_sessionId: string, blockId: string) => {
            const item = allMetadata.find((candidate) => candidate.blockId === blockId)!;
            return Promise.resolve({ ...item, entries: [] } satisfies AiTranscriptBlock);
        });
        const windowStore = new TranscriptWindowStore({ loadBlock }, BLOCK_SIZE * 3);
        windowStore.setMetadata("session-1", allMetadata);
        windowStore.protect("session-1", new Set(["session-1:390"]));
        await Promise.all([
            windowStore.load("session-1", "session-1:388"),
            windowStore.load("session-1", "session-1:389"),
            windowStore.load("session-1", "session-1:390"),
        ]);

        const snapshot = windowStore.snapshot("session-1");
        expect(snapshot.metadata).toHaveLength(391);
        expect(snapshot.residentEntries).toBeLessThanOrEqual(BLOCK_SIZE * 3);
        expect(loadBlock).toHaveBeenCalledTimes(3);
    });

    it("cancels tab churn before payload and prefetch phases accumulate", async () => {
        const scheduler = new ChatActivationScheduler();
        const phases: string[] = [];
        const gate: { release: () => void } = { release: () => undefined };
        const cancel = scheduler.activate("tab-a", async (phase) => {
            phases.push(phase);
            if (phase === "shell") {
                await new Promise<void>((resolve) => {
                    gate.release = resolve;
                });
            }
        });
        cancel();
        gate.release();
        await Promise.resolve();
        await Promise.resolve();
        expect(phases).toEqual(["shell"]);
    });
});
