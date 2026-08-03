import { describe, expect, it } from "vitest";

import type {
    AiToolActivity,
    AiTranscriptBlock,
    AiTranscriptBlockMetadata,
} from "@shared/ipc";
import { resolveTranscriptPrefetchBlockId } from "@renderer/app/ai/transcriptWindowNavigation";
import {
    getChatTimelineRowIdentityKey,
    getChatTimelineRowMeasurementKey,
} from "./chatTimelineVirtualization";

import {
    buildTranscriptTimelineItems,
    buildTranscriptVirtualBlocks,
    captureTranscriptSemanticAnchor,
    createTranscriptStreamingIndicatorItem,
    flattenTranscriptTimelineItems,
    isChatTimelineRowItem,
    isTranscriptStreamingIndicatorItem,
    resolveAnchorBlockId,
    resolveTranscriptBlockIdsInRange,
    resolveTranscriptEntryBlockId,
    resolveUnloadedTranscriptBlockIdsInRange,
    transcriptBlockEstimate,
} from "./transcriptBlockVirtualization";
import type {
    ActivitySegmentItem,
    ChatTimelineActivitySegmentRow,
    ToolActivitySegmentEntry,
} from "./chatTimelineModel";

const metadata: AiTranscriptBlockMetadata = {
    blockId: "block-1",
    endSequence: 1,
    entryCount: 1,
    estimatedHeight: 72,
    estimatedRowCount: 1,
    firstCreatedAt: "2026-01-01T00:00:00.000Z",
    lastCreatedAt: "2026-01-01T00:00:00.000Z",
    revision: 1,
    sessionId: "session-1",
    startSequence: 1,
};

describe("transcriptBlockVirtualization", () => {
    it("keeps unloaded history as estimated spacers", () => {
        const blocks = buildTranscriptVirtualBlocks([metadata], new Map());
        expect(blocks[0]?.kind).toBe("spacer");
        expect(blocks[0] && transcriptBlockEstimate(blocks[0])).toBe(72);
    });

    it("models the streaming indicator as a stable virtual timeline item", () => {
        const indicator = createTranscriptStreamingIndicatorItem("12s");

        expect(indicator).toEqual({
            elapsed: "12s",
            id: "streaming-indicator",
            kind: "streaming-indicator",
        });
        expect(isTranscriptStreamingIndicatorItem(indicator)).toBe(true);
        expect(isChatTimelineRowItem(indicator)).toBe(false);
    });

    it("flattens expanded activity into individually virtualizable entries", () => {
        const segment = createActivitySegment(3);
        const items = flattenTranscriptTimelineItems([segment], {
            defaultExpanded: false,
            expansionByGroupId: {
                [segment.id]: { expanded: true },
            },
        });

        expect(items.map((item) => item.kind)).toEqual([
            "activity-summary",
            "activity-entry",
            "activity-entry",
            "activity-entry",
        ]);
        expect(items.map((item) => item.id)).toEqual([
            `activity-summary:${segment.id}`,
            "message:thinking-0",
            "message:thinking-1",
            "message:thinking-2",
        ]);
    });

    it("keeps active activity collapsed when the default is collapsed", () => {
        const segment = createActivitySegment(3);
        const items = flattenTranscriptTimelineItems([segment], {
            activeGroupId: segment.id,
            defaultExpanded: false,
            expansionByGroupId: {},
        });

        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
            expanded: false,
            id: `activity-summary:${segment.id}`,
            kind: "activity-summary",
        });
    });

    it("uses collapsed windows instead of materializing a huge activity group", () => {
        const segment = createActivitySegment(401);
        const collapsedWindows = flattenTranscriptTimelineItems([segment], {
            defaultExpanded: false,
            expansionByGroupId: {
                [segment.id]: { expanded: true },
            },
        });

        expect(collapsedWindows).toHaveLength(4);
        expect(
            collapsedWindows.filter((item) => item.kind === "activity-entry"),
        ).toHaveLength(0);

        const expandedFirstWindow = flattenTranscriptTimelineItems([segment], {
            defaultExpanded: false,
            expansionByGroupId: {
                [segment.id]: {
                    expanded: true,
                    expandedRangeStarts: [0],
                },
            },
        });

        expect(
            expandedFirstWindow.filter((item) => item.kind === "activity-entry"),
        ).toHaveLength(200);
        expect(expandedFirstWindow).toHaveLength(204);
    });

    it("keeps measurement keys stable when flat wrappers are rebuilt", () => {
        const segment = createActivitySegment(3);
        const options = {
            defaultExpanded: false,
            expansionByGroupId: {
                [segment.id]: { expanded: true },
            },
        };
        const first = flattenTranscriptTimelineItems([segment], options);
        const second = flattenTranscriptTimelineItems([segment], options);
        const firstEntry = first.find((item) => item.kind === "activity-entry");
        const secondEntry = second.find(
            (item) => item.kind === "activity-entry",
        );

        if (!firstEntry || !secondEntry) {
            throw new Error("expected flattened activity entries");
        }

        const context = { width: 720 };
        expect(
            getChatTimelineRowMeasurementKey(firstEntry, context),
        ).toBe(getChatTimelineRowMeasurementKey(secondEntry, context));
        expect(getChatTimelineRowIdentityKey(firstEntry, context)).toBe(
            getChatTimelineRowIdentityKey(secondEntry, context),
        );
    });

    it("keeps the latest active range materialized after older ranges expand", () => {
        const segment = createActivitySegment(601);
        const items = flattenTranscriptTimelineItems([segment], {
            activeGroupId: segment.id,
            defaultExpanded: false,
            expansionByGroupId: {
                [segment.id]: {
                    expanded: true,
                    expandedRangeStarts: [0],
                },
            },
        });

        expect(
            items.filter((item) => item.kind === "activity-entry"),
        ).toHaveLength(201);
        expect(items.at(-1)?.id).toBe("message:thinking-600");
    });

    it("windows real tools without exposing payloads outside expanded ranges", () => {
        const collapsedSegment = createToolActivitySegment(401);
        const collapsed = flattenTranscriptTimelineItems([collapsedSegment], {
            defaultExpanded: false,
            expansionByGroupId: {},
        });
        expect(collapsed).toEqual([
            expect.objectContaining({
                id: `activity-summary:${collapsedSegment.id}`,
                kind: "activity-summary",
            }),
        ]);

        const expandedHistorical = flattenTranscriptTimelineItems(
            [collapsedSegment],
            {
                defaultExpanded: false,
                expansionByGroupId: {
                    [collapsedSegment.id]: {
                        expanded: true,
                        expandedRangeStarts: [0],
                    },
                },
            },
        );
        const historicalEntries = expandedHistorical.filter(
            (item) => item.kind === "activity-entry",
        );
        expect(historicalEntries).toHaveLength(200);
        expect(visibleToolIds(historicalEntries)).toEqual(
            Array.from({ length: 200 }, (_, index) => `tool-${index + 1}`),
        );

        const activeSegment = createToolActivitySegment(601);
        const withHistoricalAndActive = flattenTranscriptTimelineItems(
            [activeSegment],
            {
                activeGroupId: activeSegment.id,
                defaultExpanded: false,
                expansionByGroupId: {
                    [activeSegment.id]: {
                        expanded: true,
                        expandedRangeStarts: [0],
                    },
                },
            },
        );
        const visibleEntries = withHistoricalAndActive.filter(
            (item) => item.kind === "activity-entry",
        );
        const visibleIds = visibleToolIds(visibleEntries);

        expect(visibleEntries).toHaveLength(201);
        expect(new Set(visibleIds).size).toBe(201);
        expect(visibleIds).toEqual([
            ...Array.from({ length: 200 }, (_, index) => `tool-${index + 1}`),
            "tool-601",
        ]);
        expect(
            activeSegment.entries
                .map((entry) => entry.reviewEntry.activity.toolActivityDetailId)
                .filter(
                    (detailId): detailId is string => detailId !== undefined,
                ),
        ).toHaveLength(601);
        expect(visibleIds).not.toContain("tool-201");
    });

    it("keeps block positions stable while resident blocks are loaded and evicted", () => {
        const blockMetadata = ["block-0", "block-1", "block-2"].map(
            (blockId, index) => ({
                ...metadata,
                blockId,
                endSequence: index + 1,
                startSequence: index + 1,
            }),
        );
        const loadedBlock: AiTranscriptBlock = {
            ...blockMetadata[1],
            capabilityVersion: 1,
            entries: [
                {
                    createdAt: metadata.firstCreatedAt,
                    id: "message:message-1",
                    kind: "message",
                    payloadRef: "payload:message-1",
                    sequence: 2,
                    sessionId: metadata.sessionId,
                    summary: {
                        label: "assistant",
                        preview: "Loaded message",
                        status: "completed",
                    },
                    updatedAt: metadata.lastCreatedAt,
                },
            ],
            transcriptRevision: 1,
        };
        const message = {
            attachments: [],
            content: "Loaded message",
            createdAt: metadata.firstCreatedAt,
            id: "message-1",
            kind: "assistant" as const,
            status: "completed" as const,
        };
        const loadedRows = buildTranscriptTimelineItems(
            blockMetadata,
            new Map([["block-1", loadedBlock]]),
            [
                {
                    blockId: "block-1",
                    id: "message:message-1",
                    kind: "message",
                    message,
                },
            ],
        );

        expect(loadedRows.map((row) => row.id)).toEqual([
            "transcript-block:block-0",
            "transcript-block:block-1",
            "message:message-1",
            "transcript-block:block-2",
        ]);
        expect(loadedRows[0]).toMatchObject({
            estimatedHeight: 72,
            isLoaded: false,
            kind: "transcript-block-spacer",
        });
        expect(loadedRows[1]).toMatchObject({
            estimatedHeight: 1,
            isLoaded: true,
            kind: "transcript-block-spacer",
        });
        expect(resolveTranscriptBlockIdsInRange(loadedRows, 2, 3)).toEqual([
            "block-1",
            "block-2",
        ]);
        expect(
            resolveUnloadedTranscriptBlockIdsInRange(loadedRows, 0, 3),
        ).toEqual(["block-0", "block-2"]);

        const evictedRows = buildTranscriptTimelineItems(
            blockMetadata,
            new Map(),
            [],
        );
        expect(evictedRows).toHaveLength(3);
        expect(
            evictedRows.reduce(
                (height, row) =>
                    height +
                    (row.kind === "transcript-block-spacer"
                        ? row.estimatedHeight
                        : 0),
                0,
            ),
        ).toBe(216);
    });

    it("resolves semantic anchors independently from scrollTop", () => {
        const block: AiTranscriptBlock = {
            ...metadata,
            capabilityVersion: 1,
            entries: [
                {
                    createdAt: metadata.firstCreatedAt,
                    id: "entry-1",
                    kind: "message",
                    payloadRef: null,
                    sequence: 1,
                    sessionId: metadata.sessionId,
                    summary: { label: null, preview: null, status: null },
                    updatedAt: metadata.lastCreatedAt,
                },
            ],
            transcriptRevision: 1,
        };
        const blocks = buildTranscriptVirtualBlocks(
            [metadata],
            new Map([[metadata.blockId, block]]),
        );
        expect(
            resolveAnchorBlockId(
                { alignment: "start", entryId: "entry-1", offsetWithinEntry: 8 },
                blocks,
            ),
        ).toBe("block-1");
        expect(
            resolveTranscriptEntryBlockId(
                new Map([[block.blockId, block]]),
                "entry-1",
            ),
        ).toBe("block-1");
    });

    it("captures a recoverable anchor and prefetches toward history", () => {
        const blocks = buildTranscriptVirtualBlocks(
            [
                { ...metadata, blockId: "block-0" },
                metadata,
                { ...metadata, blockId: "block-2" },
            ],
            new Map(),
        );
        expect(
            captureTranscriptSemanticAnchor({
                entryId: "entry-1",
                offsetWithinEntry: -4,
            }),
        ).toEqual({
            alignment: "start",
            entryId: "entry-1",
            offsetWithinEntry: 0,
            timelineItemId: null,
        });
        expect(
            resolveTranscriptPrefetchBlockId(
                blocks.map((block) => block.id),
                new Set(["block-2"]),
                "backward",
            ),
        ).toBe("block-1");
    });
});

function createActivitySegment(
    count: number,
): ChatTimelineActivitySegmentRow {
    const items = Array.from({ length: count }, (_, index) =>
        ({
            kind: "thinking",
            message: {
                attachments: [],
                content: `Thought ${index}`,
                createdAt: metadata.firstCreatedAt,
                id: `thinking-${index}`,
                kind: "thinking",
                status: "completed",
            },
        }) satisfies ActivitySegmentItem,
    );

    return {
        blockId: null,
        changeStats: {
            additions: 0,
            approximate: false,
            deletions: 0,
        },
        entries: [],
        id: "activity-segment:thinking:thinking-0",
        items,
        kind: "activity-segment",
        summary: {
            actionCount: 0,
            changeCount: 0,
            changedFileCount: 0,
            commandCount: 0,
            failureCount: 0,
            fileCount: 0,
            hiddenActivityCount: count,
            isInProgress: false,
            latestActivityId: "thinking-0",
            latestTitle: "Thought",
            searchCount: 0,
            startedAt: metadata.firstCreatedAt,
            updatedAt: metadata.lastCreatedAt,
        },
    };
}

function createToolActivitySegment(
    count: number,
): ChatTimelineActivitySegmentRow {
    const entries = Array.from({ length: count }, (_, index) => {
        const toolNumber = index + 1;
        const activity: AiToolActivity = {
            changeStats: null,
            createdAt: `2026-07-26T12:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
            diffs: [],
            exitCode: null,
            id: `tool-${toolNumber}`,
            kind: toolNumber % 5 === 0 ? "search" : "read",
            locations: [],
            rawInputJson: JSON.stringify({
                path: `src/generated/file-${toolNumber}.ts`,
            }),
            rawOutputJson: JSON.stringify({ result: toolNumber }),
            sessionId: "session-tools",
            status: "completed",
            summary: `Synthetic tool ${toolNumber}`,
            terminalOutput: null,
            title: `Read src/generated/file-${toolNumber}.ts`,
            toolActivityDetailId: `tool-detail:${toolNumber}`,
            updatedAt: `2026-07-26T12:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
        };
        return {
            policy: "groupable",
            reviewEntry: {
                activity,
                hasPendingTrackedFiles: false,
                pendingTrackedFiles: [],
                trackedFiles: [],
            },
        } satisfies ToolActivitySegmentEntry;
    });
    const items = entries.map(
        (entry) => ({ entry, kind: "tool" }) satisfies ActivitySegmentItem,
    );

    return {
        blockId: null,
        changeStats: {
            additions: 0,
            approximate: false,
            deletions: 0,
        },
        entries,
        id: "activity-segment:session-tools:tool-1",
        items,
        kind: "activity-segment",
        summary: {
            actionCount: count,
            changeCount: 0,
            changedFileCount: 0,
            commandCount: 0,
            failureCount: 0,
            fileCount: count,
            hiddenActivityCount: count,
            isInProgress: false,
            latestActivityId: `tool-${count}`,
            latestTitle: `Read src/generated/file-${count}.ts`,
            searchCount: Math.floor(count / 5),
            startedAt: entries[0]?.reviewEntry.activity.createdAt ?? metadata.firstCreatedAt,
            updatedAt:
                entries.at(-1)?.reviewEntry.activity.updatedAt ??
                metadata.lastCreatedAt,
        },
    };
}

function visibleToolIds(
    entries: readonly {
        readonly item: ActivitySegmentItem;
        readonly kind: "activity-entry";
    }[],
): string[] {
    return entries.flatMap((entry) =>
        entry.item.kind === "tool" ? [entry.item.entry.reviewEntry.activity.id] : [],
    );
}
