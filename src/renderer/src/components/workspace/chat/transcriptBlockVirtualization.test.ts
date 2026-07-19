import { describe, expect, it } from "vitest";

import type { AiTranscriptBlock, AiTranscriptBlockMetadata } from "@shared/ipc";
import { resolveTranscriptPrefetchBlockId } from "@renderer/app/ai/transcriptWindowNavigation";

import {
    buildTranscriptTimelineItems,
    buildTranscriptVirtualBlocks,
    captureTranscriptSemanticAnchor,
    resolveAnchorBlockId,
    resolveTranscriptBlockIdsInRange,
    resolveUnloadedTranscriptBlockIdsInRange,
    transcriptBlockEstimate,
} from "./transcriptBlockVirtualization";

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
            [{ id: "message:message-1", kind: "message", message }],
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
