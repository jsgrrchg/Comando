import type {
    AiTranscriptBlock,
    AiTranscriptBlockMetadata,
} from "@shared/ipc";

import type { ChatTimelineRow } from "./chatTimelineModel";

export interface TranscriptSemanticAnchor {
    readonly alignment: "start" | "center" | "end";
    readonly entryId: string;
    readonly offsetWithinEntry: number;
}

export type TranscriptVirtualBlock =
    | {
          readonly block: AiTranscriptBlock;
          readonly id: string;
          readonly kind: "loaded";
          readonly metadata: AiTranscriptBlockMetadata;
      }
    | {
          readonly estimatedHeight: number;
          readonly id: string;
          readonly kind: "spacer";
          readonly metadata: AiTranscriptBlockMetadata;
      };

export interface TranscriptBlockSpacerItem {
    readonly blockId: string;
    readonly estimatedHeight: number;
    readonly id: string;
    readonly isLoaded: boolean;
    readonly kind: "transcript-block-spacer";
    readonly metadata: AiTranscriptBlockMetadata;
}

export interface TranscriptStreamingIndicatorItem {
    readonly elapsed: string;
    readonly id: "streaming-indicator";
    readonly kind: "streaming-indicator";
}

// This is the presentation boundary between paged transcript data and the
// virtual list. Future timeline-only items can join it without materializing
// unloaded transcript blocks.
export type TranscriptTimelineItem =
    | ChatTimelineRow
    | TranscriptBlockSpacerItem
    | TranscriptStreamingIndicatorItem;

export function createTranscriptStreamingIndicatorItem(
    elapsed: string,
): TranscriptStreamingIndicatorItem {
    return {
        elapsed,
        id: "streaming-indicator",
        kind: "streaming-indicator",
    };
}

export function buildTranscriptVirtualBlocks(
    metadata: readonly AiTranscriptBlockMetadata[],
    loaded: ReadonlyMap<string, AiTranscriptBlock>,
): readonly TranscriptVirtualBlock[] {
    return metadata.map((item) => {
        const block = loaded.get(item.blockId);
        return block
            ? { block, id: item.blockId, kind: "loaded", metadata: item }
            : {
                  estimatedHeight: item.estimatedHeight,
                  id: item.blockId,
                  kind: "spacer",
                  metadata: item,
              };
    });
}

export function buildTranscriptTimelineItems(
    metadata: readonly AiTranscriptBlockMetadata[],
    loaded: ReadonlyMap<string, AiTranscriptBlock>,
    timelineRows: readonly ChatTimelineRow[],
): readonly TranscriptTimelineItem[] {
    if (metadata.length === 0) {
        return timelineRows;
    }

    const blockIdByEntryId = new Map<string, string>();
    for (const item of metadata) {
        const block = loaded.get(item.blockId);
        if (!block) continue;
        for (const entry of block.entries) {
            blockIdByEntryId.set(entry.id, item.blockId);
        }
    }

    const rowsByBlockId = new Map<string, ChatTimelineRow[]>();
    const unassignedRows: ChatTimelineRow[] = [];
    for (const row of timelineRows) {
        const blockId = timelineEntryIds(row)
            .map((entryId) => blockIdByEntryId.get(entryId) ?? null)
            .find((candidate): candidate is string => candidate !== null);
        if (!blockId) {
            unassignedRows.push(row);
            continue;
        }
        const rows = rowsByBlockId.get(blockId) ?? [];
        rows.push(row);
        rowsByBlockId.set(blockId, rows);
    }

    const timelineItems: TranscriptTimelineItem[] = [];
    for (const item of metadata) {
        const isLoaded = loaded.has(item.blockId);
        timelineItems.push({
            blockId: item.blockId,
            estimatedHeight: isLoaded ? 1 : Math.max(1, item.estimatedHeight),
            id: `transcript-block:${item.blockId}`,
            isLoaded,
            kind: "transcript-block-spacer",
            metadata: item,
        });
        if (isLoaded) {
            timelineItems.push(...(rowsByBlockId.get(item.blockId) ?? []));
        }
    }
    timelineItems.push(...unassignedRows);
    return timelineItems;
}

export function isTranscriptBlockSpacerItem(
    item: TranscriptTimelineItem,
): item is TranscriptBlockSpacerItem {
    return item.kind === "transcript-block-spacer";
}

export function isTranscriptStreamingIndicatorItem(
    item: TranscriptTimelineItem,
): item is TranscriptStreamingIndicatorItem {
    return item.kind === "streaming-indicator";
}

export function isChatTimelineRowItem(
    item: TranscriptTimelineItem,
): item is ChatTimelineRow {
    return !isTranscriptBlockSpacerItem(item) &&
        !isTranscriptStreamingIndicatorItem(item);
}

export function resolveTranscriptBlockIdsInRange(
    items: readonly TranscriptTimelineItem[],
    startIndex: number,
    endIndex: number,
): readonly string[] {
    if (items.length === 0 || endIndex < startIndex) return [];
    const normalizedStart = Math.max(0, Math.min(startIndex, items.length - 1));
    const normalizedEnd = Math.max(
        normalizedStart,
        Math.min(endIndex, items.length - 1),
    );
    let currentBlockId: string | null = null;
    for (let index = normalizedStart; index >= 0; index -= 1) {
        const item = items[index];
        if (item && isTranscriptBlockSpacerItem(item)) {
            currentBlockId = item.blockId;
            break;
        }
    }
    const blockIds = new Set<string>();
    for (let index = normalizedStart; index <= normalizedEnd; index += 1) {
        const item = items[index];
        if (!item) continue;
        if (isTranscriptBlockSpacerItem(item)) {
            currentBlockId = item.blockId;
        }
        if (currentBlockId) blockIds.add(currentBlockId);
    }
    return [...blockIds];
}

export function resolveUnloadedTranscriptBlockIdsInRange(
    items: readonly TranscriptTimelineItem[],
    startIndex: number,
    endIndex: number,
): readonly string[] {
    if (items.length === 0 || endIndex < startIndex) return [];
    return [
        ...new Set(
            items
                .slice(
                    Math.max(0, startIndex),
                    Math.min(items.length, endIndex + 1),
                )
                .filter(isTranscriptBlockSpacerItem)
                .filter((item) => !item.isLoaded)
                .map((item) => item.blockId),
        ),
    ];
}

export function resolveAnchorBlockId(
    anchor: TranscriptSemanticAnchor,
    blocks: readonly TranscriptVirtualBlock[],
): string | null {
    for (const block of blocks) {
        if (
            block.kind === "loaded" &&
            block.block.entries.some((entry) => entry.id === anchor.entryId)
        ) {
            return block.id;
        }
    }
    return null;
}

export function transcriptBlockEstimate(block: TranscriptVirtualBlock): number {
    return block.kind === "loaded"
        ? block.block.estimatedHeight
        : block.estimatedHeight;
}

export function captureTranscriptSemanticAnchor(input: {
    readonly alignment?: TranscriptSemanticAnchor["alignment"];
    readonly entryId: string | null;
    readonly offsetWithinEntry?: number;
}): TranscriptSemanticAnchor | null {
    if (!input.entryId) return null;
    return {
        alignment: input.alignment ?? "start",
        entryId: input.entryId,
        offsetWithinEntry: Math.max(0, input.offsetWithinEntry ?? 0),
    };
}

function timelineEntryIds(row: ChatTimelineRow): readonly string[] {
    if (row.kind === "message") {
        return [messageTranscriptEntryId(row.message.id)];
    }
    if (row.kind === "tool") {
        return [row.id];
    }
    return row.items.map((item) =>
        item.kind === "thinking"
            ? messageTranscriptEntryId(item.message.id)
            : `tool:${item.entry.reviewEntry.activity.sessionId}:${item.entry.reviewEntry.activity.id}`,
    );
}

function messageTranscriptEntryId(messageId: string): string {
    return messageId.startsWith("summary:")
        ? messageId.slice("summary:".length)
        : `message:${messageId}`;
}
