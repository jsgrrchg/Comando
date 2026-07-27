import { beforeEach, describe, expect, it } from "vitest";
import type {
    AiSessionDomainEvent,
    AiTranscriptBlock,
    AiTranscriptBlockMetadata,
} from "@shared/ipc";

import {
    applyAiSessionDomainEventToTranscript,
    buildAiSessionTranscriptModel,
    isAiSessionTranscriptMutationFrom,
} from "./transcriptModel";
import { buildBlockNativeTranscriptProjection } from "./transcriptWindowProjection";
import {
    readChatPerformanceCounters,
    resetChatPerformanceCounters,
} from "@renderer/app/debug/chatPerformanceCounters";

const SESSION_ID = "projection-session";
const STARTED_AT = "2026-01-01T00:00:00.000Z";

describe("transcriptWindowProjection", () => {
    beforeEach(() => {
        resetChatPerformanceCounters();
    });

    it("preserves the hot transcript mutation chain without revisiting sealed entries", () => {
        const { blocksById, metadata } = createSealedBlocks(2);
        const live = createLiveTranscript("", true);
        const payloadsByRef = new Map();
        const projection = buildBlockNativeTranscriptProjection(
            live,
            blocksById,
            metadata,
            payloadsByRef,
        );
        resetChatPerformanceCounters();

        const intermediateLive = applyAiSessionDomainEventToTranscript(
            live,
            createMessageDelta("hello"),
        );
        const nextLive = applyAiSessionDomainEventToTranscript(
            intermediateLive,
            createMessageDelta("hello world"),
        );
        const nextProjection = buildBlockNativeTranscriptProjection(
            nextLive,
            blocksById,
            metadata,
            payloadsByRef,
            projection,
        );

        expect(nextProjection.sealed).toBe(projection.sealed);
        expect(nextProjection.hot.parent).toBe(projection.hot);
        expect(nextProjection.hot.mutation).toEqual({
            entryId: "message:streaming-assistant",
            kind: "patch",
        });
        expect(
            isAiSessionTranscriptMutationFrom(
                nextProjection.hot.transcript,
                projection.hot.transcript,
            ),
        ).toBe(true);
        expect(nextProjection.hot.transcript.messages.at(-1)?.content).toBe(
            "hello world",
        );
        expect(nextProjection.hot.transcript.messages).toHaveLength(1);
        expect(readChatPerformanceCounters()).toMatchObject({
            stable_history_entries_visited: 0,
            timeline_blocks_built: 0,
            transcript_blocks_projected: 0,
            transcript_entries_visited: 0,
        });
    });

    it("keeps 100k sealed entries untouched across ten thousand live deltas", () => {
        const { blocksById, metadata } = createSealedBlocks(100, 1_000);
        const payloadsByRef = new Map();
        let live = createLiveTranscript("");
        let projection = buildBlockNativeTranscriptProjection(
            live,
            blocksById,
            metadata,
            payloadsByRef,
        );
        const sealed = projection.sealed;
        const tailEntryId = "message:streaming-assistant";

        resetChatPerformanceCounters();
        for (let index = 1; index <= 10_000; index += 1) {
            live = applyAiSessionDomainEventToTranscript(
                live,
                createMessageDelta(`delta ${index}`, ` ${index}`, index),
            );
            const previousProjection = projection;
            projection = buildBlockNativeTranscriptProjection(
                live,
                blocksById,
                metadata,
                payloadsByRef,
                projection,
            );

            expect(projection.sealed).toBe(sealed);
            expect(projection.hot.parent).toBe(previousProjection.hot);
            expect(projection.hot.mutation).toEqual({
                entryId: tailEntryId,
                kind: "patch",
            });
            expect(projection.hot.transcript.orderedEntryIds).toEqual([
                tailEntryId,
            ]);
        }

        expect(projection.hot.transcript.messages).toEqual([
            expect.objectContaining({
                content: "delta 10000",
                id: "streaming-assistant",
            }),
        ]);
        expect(readChatPerformanceCounters()).toMatchObject({
            stable_history_entries_visited: 0,
            timeline_blocks_built: 0,
            transcript_blocks_projected: 0,
            transcript_entries_visited: 0,
        });

        const replay = createMessageDelta("delta 10000", " 10000", 10_000);
        const replayedLive = applyAiSessionDomainEventToTranscript(live, replay);
        expect(replayedLive).toBe(live);
        expect(
            buildBlockNativeTranscriptProjection(
                replayedLive,
                blocksById,
                metadata,
                payloadsByRef,
                projection,
            ),
        ).toBe(projection);
    });

    it("reuses unchanged block projections and carries entry ownership", () => {
        const { blocksById, metadata } = createSealedBlocks(2);
        const payloadsByRef = new Map();
        const projection = buildBlockNativeTranscriptProjection(
            createLiveTranscript(""),
            blocksById,
            metadata,
            payloadsByRef,
        );
        const changedBlock = {
            ...blocksById.get("block-2")!,
            revision: 2,
        };
        const nextBlocksById = new Map(blocksById);
        nextBlocksById.set(changedBlock.blockId, changedBlock);
        const nextMetadata = metadata.map((item) =>
            item.blockId === changedBlock.blockId
                ? { ...item, revision: 2 }
                : item,
        );
        resetChatPerformanceCounters();

        const nextProjection = buildBlockNativeTranscriptProjection(
            projection.hot.source,
            nextBlocksById,
            nextMetadata,
            payloadsByRef,
            projection,
        );

        expect(nextProjection.sealed.blocks[0]).toBe(
            projection.sealed.blocks[0],
        );
        expect(nextProjection.sealed.blocks[1]).not.toBe(
            projection.sealed.blocks[1],
        );
        expect(
            nextProjection.sealed.blockIdByEntryId.get("message:sealed-1"),
        ).toBe("block-1");
        expect(readChatPerformanceCounters()).toMatchObject({
            stable_history_entries_visited: 1,
            timeline_blocks_built: 1,
            transcript_blocks_projected: 1,
            transcript_entries_visited: 1,
        });
    });

    it("keeps an editable tool identifiable before its payload is loaded", () => {
        const metadata: AiTranscriptBlockMetadata = {
            blockId: "block-edit",
            endSequence: 1,
            entryCount: 1,
            estimatedHeight: 72,
            estimatedRowCount: 1,
            firstCreatedAt: STARTED_AT,
            lastCreatedAt: STARTED_AT,
            revision: 1,
            sessionId: SESSION_ID,
            startSequence: 1,
        };
        const block: AiTranscriptBlock = {
            ...metadata,
            capabilityVersion: 1,
            entries: [
                {
                    createdAt: STARTED_AT,
                    id: "tool:projection-session:edit-1",
                    kind: "tool",
                    payloadRef: "payload:edit-1",
                    sequence: 1,
                    sessionId: SESSION_ID,
                    summary: {
                        label: "Edit src/app.ts",
                        preview: "Updated src/app.ts",
                        status: "completed",
                        toolActivityDetailId: "tool-detail:edit-1",
                        toolChangeStats: {
                            additions: 4,
                            approximate: false,
                            deletions: 1,
                            fileCount: 1,
                        },
                        toolKind: "edit",
                    },
                    updatedAt: STARTED_AT,
                },
            ],
            transcriptRevision: 1,
        };

        const projection = buildBlockNativeTranscriptProjection(
            buildAiSessionTranscriptModel({ messages: [], toolActivity: [] }),
            new Map([[metadata.blockId, block]]),
            [metadata],
            new Map(),
        );

        expect(projection.sealed.transcript.toolActivity).toEqual([
            expect.objectContaining({
                diffs: [],
                id: "edit-1",
                kind: "edit",
                changeStats: {
                    additions: 4,
                    approximate: false,
                    deletions: 1,
                    fileCount: 1,
                },
                toolActivityDetailId: "tool-detail:edit-1",
            }),
        ]);
    });

    it("derives the persisted detail key for a block written before tool summaries", () => {
        const metadata: AiTranscriptBlockMetadata = {
            blockId: "block-legacy-tool",
            endSequence: 1,
            entryCount: 1,
            estimatedHeight: 72,
            estimatedRowCount: 1,
            firstCreatedAt: STARTED_AT,
            lastCreatedAt: STARTED_AT,
            revision: 1,
            sessionId: SESSION_ID,
            startSequence: 1,
        };
        const block: AiTranscriptBlock = {
            ...metadata,
            capabilityVersion: 1,
            entries: [
                {
                    createdAt: STARTED_AT,
                    id: "tool:projection-session:legacy-edit",
                    kind: "tool",
                    payloadRef: "payload:legacy-edit",
                    sequence: 1,
                    sessionId: SESSION_ID,
                    summary: {
                        label: "Edit src/app.ts",
                        preview: "Updated src/app.ts",
                        status: "completed",
                    },
                    updatedAt: STARTED_AT,
                },
            ],
            transcriptRevision: 1,
        };

        const projection = buildBlockNativeTranscriptProjection(
            buildAiSessionTranscriptModel({ messages: [], toolActivity: [] }),
            new Map([[metadata.blockId, block]]),
            [metadata],
            new Map(),
        );

        expect(projection.sealed.transcript.toolActivity).toEqual([
            expect.objectContaining({
                id: "legacy-edit",
                toolActivityDetailId:
                    "tool-detail:projection-session:legacy-edit",
            }),
        ]);
    });
});

function createLiveTranscript(
    content: string,
    includeSealedDuplicate = false,
) {
    return buildAiSessionTranscriptModel({
        messages: [
            ...(includeSealedDuplicate
                ? [
                      {
                          attachments: [],
                          content: "Duplicate sealed message",
                          createdAt: "2025-12-31T23:59:01.000Z",
                          id: "sealed-1",
                          kind: "assistant" as const,
                          status: "completed" as const,
                      },
                  ]
                : []),
            {
                attachments: [],
                content,
                createdAt: STARTED_AT,
                id: "streaming-assistant",
                kind: "assistant",
                status: "streaming",
            },
        ],
        toolActivity: [],
    });
}

function createMessageDelta(
    content: string,
    delta = content,
    sequence = 1,
): AiSessionDomainEvent {
    return {
        content,
        delta,
        kind: "message-delta",
        messageId: "streaming-assistant",
        messageKind: "assistant",
        origin: "live",
        parentSessionId: null,
        runtimeId: "codex",
        runtimeSessionId: "runtime-session",
        sessionId: SESSION_ID,
        updatedAt: `2026-01-01T00:00:${String(sequence % 60).padStart(2, "0")}.000Z`,
    };
}

function createSealedBlocks(count: number, entriesPerBlock = 1): {
    readonly blocksById: ReadonlyMap<string, AiTranscriptBlock>;
    readonly metadata: readonly AiTranscriptBlockMetadata[];
} {
    const metadata = Array.from({ length: count }, (_, index) => {
        const startSequence = index * entriesPerBlock + 1;
        const endSequence = startSequence + entriesPerBlock - 1;
        return {
            blockId: `block-${index + 1}`,
            endSequence,
            entryCount: entriesPerBlock,
            estimatedHeight: entriesPerBlock * 72,
            estimatedRowCount: entriesPerBlock,
            firstCreatedAt: "2025-12-31T23:59:00.000Z",
            lastCreatedAt: "2025-12-31T23:59:00.000Z",
            revision: 1,
            sessionId: SESSION_ID,
            startSequence,
        } satisfies AiTranscriptBlockMetadata;
    });
    const blocksById = new Map<string, AiTranscriptBlock>();
    for (const item of metadata) {
        blocksById.set(item.blockId, {
            ...item,
            capabilityVersion: 1,
            entries: Array.from({ length: item.entryCount }, (_, index) => {
                const sequence = item.startSequence + index;
                return {
                    createdAt: item.firstCreatedAt,
                    id: `message:sealed-${sequence}`,
                    kind: "message" as const,
                    payloadRef: null,
                    sequence,
                    sessionId: SESSION_ID,
                    summary: {
                        label: `Sealed ${sequence}`,
                        preview: `Sealed ${sequence}`,
                        status: "completed" as const,
                    },
                    updatedAt: item.lastCreatedAt,
                };
            }),
            transcriptRevision: 1,
        });
    }
    return { blocksById, metadata };
}
