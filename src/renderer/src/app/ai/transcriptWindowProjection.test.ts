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
        });
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
        });
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

function createMessageDelta(content: string): AiSessionDomainEvent {
    return {
        content,
        delta: content,
        kind: "message-delta",
        messageId: "streaming-assistant",
        messageKind: "assistant",
        origin: "live",
        parentSessionId: null,
        runtimeId: "codex",
        runtimeSessionId: "runtime-session",
        sessionId: SESSION_ID,
        updatedAt: "2026-01-01T00:00:01.000Z",
    };
}

function createSealedBlocks(count: number): {
    readonly blocksById: ReadonlyMap<string, AiTranscriptBlock>;
    readonly metadata: readonly AiTranscriptBlockMetadata[];
} {
    const metadata = Array.from({ length: count }, (_, index) => {
        const sequence = index + 1;
        return {
            blockId: `block-${sequence}`,
            endSequence: sequence,
            entryCount: 1,
            estimatedHeight: 72,
            estimatedRowCount: 1,
            firstCreatedAt: `2025-12-31T23:59:0${sequence}.000Z`,
            lastCreatedAt: `2025-12-31T23:59:0${sequence}.000Z`,
            revision: 1,
            sessionId: SESSION_ID,
            startSequence: sequence,
        } satisfies AiTranscriptBlockMetadata;
    });
    const blocksById = new Map<string, AiTranscriptBlock>();
    for (const item of metadata) {
        blocksById.set(item.blockId, {
            ...item,
            capabilityVersion: 1,
            entries: [
                {
                    createdAt: item.firstCreatedAt,
                    id: `message:sealed-${item.startSequence}`,
                    kind: "message",
                    payloadRef: null,
                    sequence: item.startSequence,
                    sessionId: SESSION_ID,
                    summary: {
                        label: `Sealed ${item.startSequence}`,
                        preview: `Sealed ${item.startSequence}`,
                        status: "completed",
                    },
                    updatedAt: item.lastCreatedAt,
                },
            ],
            transcriptRevision: 1,
        });
    }
    return { blocksById, metadata };
}
