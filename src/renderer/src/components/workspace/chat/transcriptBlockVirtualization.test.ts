import { describe, expect, it } from "vitest";

import type { AiTranscriptBlock, AiTranscriptBlockMetadata } from "@shared/ipc";

import {
    buildTranscriptVirtualBlocks,
    captureTranscriptSemanticAnchor,
    resolveAnchorBlockId,
    resolveTranscriptPrefetchBlockId,
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
                blocks,
                new Set(["block-2"]),
                "backward",
            ),
        ).toBe("block-1");
    });
});
