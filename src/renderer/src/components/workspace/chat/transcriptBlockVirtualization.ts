import type {
    AiTranscriptBlock,
    AiTranscriptBlockMetadata,
} from "@shared/ipc";

import type {
    ActivitySegmentItem,
    ChatTimelineActivitySegmentRow,
    ChatTimelineAtomicRow,
    ChatTimelineRow,
} from "./chatTimelineModel";
import type { LongContentChunkRow } from "./longContentVirtualization";
import { incrementChatPerformanceCounter } from "@renderer/app/debug/chatPerformanceCounters";

export const ACTIVITY_GROUP_WINDOW_SIZE = 200;

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

export interface TranscriptActivitySummaryItem {
    readonly expanded: boolean;
    readonly groupId: string;
    readonly id: string;
    readonly kind: "activity-summary";
    readonly segment: ChatTimelineActivitySegmentRow;
}

export interface TranscriptActivityRangeItem {
    readonly end: number;
    readonly expanded: boolean;
    readonly groupId: string;
    readonly id: string;
    readonly kind: "activity-range";
    readonly segment: ChatTimelineActivitySegmentRow;
    readonly start: number;
}

export interface TranscriptActivityEntryItem {
    readonly groupId: string;
    readonly id: string;
    readonly item: ActivitySegmentItem;
    readonly kind: "activity-entry";
}

export type TranscriptTimelineVirtualRow =
    | ChatTimelineAtomicRow
    | ChatTimelineActivitySegmentRow
    | LongContentChunkRow
    | TranscriptActivitySummaryItem
    | TranscriptActivityRangeItem
    | TranscriptActivityEntryItem;

export interface TranscriptActivityGroupExpansionState {
    readonly collapsedRangeStarts?: readonly number[];
    readonly expanded?: boolean;
    readonly expandedRangeStarts?: readonly number[];
}

export type TranscriptActivityGroupExpansionById = Readonly<
    Record<string, TranscriptActivityGroupExpansionState | undefined>
>;

export interface FlattenTranscriptTimelineItemsOptions {
    readonly activeGroupId?: string | null;
    readonly defaultExpanded: boolean;
    readonly expansionByGroupId: TranscriptActivityGroupExpansionById;
}

export type TranscriptTimelineSourceItem =
    | ChatTimelineRow
    | TranscriptBlockSpacerItem
    | TranscriptStreamingIndicatorItem;

// This is the presentation boundary between paged transcript data and the
// virtual list. Future timeline-only items can join it without materializing
// unloaded transcript blocks.
export type TranscriptTimelineItem =
    | TranscriptTimelineVirtualRow
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
): readonly TranscriptTimelineSourceItem[] {
    incrementChatPerformanceCounter(
        "presentation_items_visited",
        metadata.length + timelineRows.length,
    );
    if (metadata.length === 0) {
        return timelineRows;
    }

    const rowsByBlockId = new Map<string, ChatTimelineRow[]>();
    const unassignedRows: ChatTimelineRow[] = [];
    for (const row of timelineRows) {
        const blockId = row.blockId;
        if (!blockId) {
            unassignedRows.push(row);
            continue;
        }
        const rows = rowsByBlockId.get(blockId) ?? [];
        rows.push(row);
        rowsByBlockId.set(blockId, rows);
    }

    const timelineItems: TranscriptTimelineSourceItem[] = [];
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
): item is TranscriptTimelineVirtualRow {
    return !isTranscriptBlockSpacerItem(item) &&
        !isTranscriptStreamingIndicatorItem(item);
}

export function isTranscriptActivitySummaryItem(
    item: TranscriptTimelineItem,
): item is TranscriptActivitySummaryItem {
    return item.kind === "activity-summary";
}

export function isTranscriptActivityRangeItem(
    item: TranscriptTimelineItem,
): item is TranscriptActivityRangeItem {
    return item.kind === "activity-range";
}

export function isTranscriptActivityEntryItem(
    item: TranscriptTimelineItem,
): item is TranscriptActivityEntryItem {
    return item.kind === "activity-entry";
}

export function flattenTranscriptTimelineItems(
    sourceItems: readonly TranscriptTimelineSourceItem[],
    options: FlattenTranscriptTimelineItemsOptions,
): readonly TranscriptTimelineItem[] {
    incrementChatPerformanceCounter(
        "presentation_items_visited",
        sourceItems.length,
    );
    const timelineItems: TranscriptTimelineItem[] = [];

    for (const sourceItem of sourceItems) {
        if (
            !isChatTimelineSourceRow(sourceItem) ||
            sourceItem.kind !== "activity-segment"
        ) {
            timelineItems.push(sourceItem);
            continue;
        }

        const groupId = sourceItem.id;
        const expansion = options.expansionByGroupId[groupId];
        const isActiveGroup = options.activeGroupId === groupId;
        // Streaming must not override the user's default expansion preference.
        const expanded = expansion?.expanded ?? options.defaultExpanded;
        timelineItems.push({
            expanded,
            groupId,
            id: `activity-summary:${groupId}`,
            kind: "activity-summary",
            segment: sourceItem,
        });

        if (!expanded) {
            continue;
        }

        if (sourceItem.items.length <= ACTIVITY_GROUP_WINDOW_SIZE) {
            timelineItems.push(
                ...sourceItem.items.map((item) =>
                    createTranscriptActivityEntryItem(groupId, item),
                ),
            );
            continue;
        }

        const expandedRangeStarts = new Set(expansion?.expandedRangeStarts);
        const collapsedRangeStarts = new Set(expansion?.collapsedRangeStarts);
        const activeRangeStart =
            Math.floor(
                (sourceItem.items.length - 1) / ACTIVITY_GROUP_WINDOW_SIZE,
            ) * ACTIVITY_GROUP_WINDOW_SIZE;
        if (isActiveGroup && !collapsedRangeStarts.has(activeRangeStart)) {
            // Keep the newest active work materialized even after older ranges
            // have been opened, unless the user explicitly collapsed this range.
            expandedRangeStarts.add(activeRangeStart);
        }

        for (
            let start = 0;
            start < sourceItem.items.length;
            start += ACTIVITY_GROUP_WINDOW_SIZE
        ) {
            const end = Math.min(
                sourceItem.items.length,
                start + ACTIVITY_GROUP_WINDOW_SIZE,
            );
            const rangeExpanded = expandedRangeStarts.has(start);
            timelineItems.push({
                end,
                expanded: rangeExpanded,
                groupId,
                id: `activity-range:${groupId}:${start}-${end}`,
                kind: "activity-range",
                segment: sourceItem,
                start,
            });
            if (rangeExpanded) {
                timelineItems.push(
                    ...sourceItem.items
                        .slice(start, end)
                        .map((item) =>
                            createTranscriptActivityEntryItem(groupId, item),
                        ),
                );
            }
        }
    }

    return timelineItems;
}

export function getTranscriptTimelineItemAnchorEntryId(
    item: TranscriptTimelineItem,
): string | null {
    if (!isChatTimelineRowItem(item)) {
        return null;
    }
    if (item.kind === "content-chunk") {
        return item.sourceRowId;
    }
    if (item.kind === "activity-entry") {
        return getActivitySegmentItemId(item.item);
    }
    if (item.kind === "activity-summary") {
        const firstItem = item.segment.items[0];
        return firstItem ? getActivitySegmentItemId(firstItem) : null;
    }
    if (item.kind === "activity-range") {
        const firstItem = item.segment.items[item.start];
        return firstItem ? getActivitySegmentItemId(firstItem) : null;
    }
    return item.id;
}

function isChatTimelineSourceRow(
    item: TranscriptTimelineSourceItem,
): item is ChatTimelineRow {
    return item.kind !== "transcript-block-spacer" &&
        item.kind !== "streaming-indicator";
}

function createTranscriptActivityEntryItem(
    groupId: string,
    item: ActivitySegmentItem,
): TranscriptActivityEntryItem {
    return {
        groupId,
        id: getActivitySegmentItemId(item),
        item,
        kind: "activity-entry",
    };
}

function getActivitySegmentItemId(item: ActivitySegmentItem): string {
    return item.kind === "thinking"
        ? `message:${item.message.id}`
        : `tool:${item.entry.reviewEntry.activity.sessionId}:${item.entry.reviewEntry.activity.id}`;
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

export function resolveTranscriptEntryBlockId(
    blocksById: ReadonlyMap<string, AiTranscriptBlock>,
    entryId: string,
): string | null {
    for (const [blockId, block] of blocksById) {
        if (block.entries.some((entry) => entry.id === entryId)) {
            return blockId;
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
