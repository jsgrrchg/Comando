import { describe, expect, it } from "vitest";

import { resolveTranscriptPrefetchBlockId } from "./transcriptWindowNavigation";

describe("resolveTranscriptPrefetchBlockId", () => {
    const blockIds = ["block-1", "block-2", "block-3", "block-4"];

    it("selects the block immediately before the loaded range", () => {
        expect(
            resolveTranscriptPrefetchBlockId(
                blockIds,
                new Set(["block-2", "block-3"]),
                "backward",
            ),
        ).toBe("block-1");
    });

    it("selects the block immediately after the loaded range", () => {
        expect(
            resolveTranscriptPrefetchBlockId(
                blockIds,
                new Set(["block-2", "block-3"]),
                "forward",
            ),
        ).toBe("block-4");
    });

    it("does not prefetch beyond either boundary", () => {
        expect(
            resolveTranscriptPrefetchBlockId(
                blockIds,
                new Set(["block-1"]),
                "backward",
            ),
        ).toBeNull();
        expect(
            resolveTranscriptPrefetchBlockId(
                blockIds,
                new Set(["block-4"]),
                "forward",
            ),
        ).toBeNull();
    });
});
