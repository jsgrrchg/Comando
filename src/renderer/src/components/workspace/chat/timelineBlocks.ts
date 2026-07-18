import type {
    AiTranscriptBlock,
    AiTranscriptEntryEnvelope,
} from "@shared/ipc";

import { incrementChatPerformanceCounter } from "@renderer/app/debug/chatPerformanceCounters";

export interface TimelineBlockRow {
    readonly entry: AiTranscriptEntryEnvelope;
    readonly estimatedHeight: number;
    readonly id: string;
}

export interface TimelineBlock {
    readonly blockId: string;
    readonly estimatedHeight: number;
    readonly key: string;
    readonly revision: number;
    readonly rows: readonly TimelineBlockRow[];
}

export interface TimelineBlockPreferences {
    readonly activityVisible: boolean;
    readonly fontKey: string;
}

export class TimelineBlockCache {
    private readonly blocks = new Map<string, TimelineBlock>();

    derive(
        transcriptBlock: AiTranscriptBlock,
        preferences: TimelineBlockPreferences,
    ): TimelineBlock {
        const key = timelineBlockKey(transcriptBlock, preferences);
        const cached = this.blocks.get(key);
        if (cached) return cached;
        const rows = transcriptBlock.entries
            .filter((entry) => preferences.activityVisible || entry.kind !== "tool")
            .map((entry) => ({
                entry,
                estimatedHeight: estimateEnvelopeHeight(entry),
                id: entry.id,
            }));
        const block = {
            blockId: transcriptBlock.blockId,
            estimatedHeight: rows.reduce(
                (height, row) => height + row.estimatedHeight,
                0,
            ),
            key,
            revision: transcriptBlock.revision,
            rows,
        };
        this.blocks.set(key, block);
        incrementChatPerformanceCounter("timeline_blocks_built");
        return block;
    }

    evict(blockId: string): void {
        for (const [key, block] of this.blocks) {
            if (block.blockId === blockId) this.blocks.delete(key);
        }
    }
}

function timelineBlockKey(
    block: AiTranscriptBlock,
    preferences: TimelineBlockPreferences,
): string {
    return [
        block.blockId,
        block.revision,
        preferences.activityVisible ? "activity" : "messages",
        preferences.fontKey,
    ].join(":");
}

function estimateEnvelopeHeight(entry: AiTranscriptEntryEnvelope): number {
    const previewLines = entry.summary.preview?.split("\n").length ?? 1;
    return Math.min(320, 48 + previewLines * 18);
}
