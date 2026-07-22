import { describe, expect, it } from "vitest";

import type { TranscriptTimelineItem } from "./transcriptBlockVirtualization";
import { captureChatTimelineSemanticAnchor } from "./ChatTimelineHistoryRows";

describe("captureChatTimelineSemanticAnchor", () => {
    it("uses the virtualizer offset from the current viewport", () => {
        const rows = [
            {
                id: "message:long:chunk:0",
                kind: "content-chunk",
                sourceRowId: "message:long",
            },
            {
                id: "message:long:chunk:4",
                kind: "content-chunk",
                sourceRowId: "message:long",
            },
        ] as unknown as readonly TranscriptTimelineItem[];

        expect(
            captureChatTimelineSemanticAnchor({
                historyRows: rows,
                viewportAnchor: {
                    index: 1,
                    key: "message:long:chunk:4",
                    offset: 286,
                },
            }),
        ).toEqual({
            entryId: "message:long",
            offsetWithinEntry: 286,
            timelineItemId: "message:long:chunk:4",
        });
    });
});
