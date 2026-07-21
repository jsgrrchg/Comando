import { describe, expect, it } from "vitest";

import type { TranscriptTimelineItem } from "./transcriptBlockVirtualization";
import { captureChatTimelineSemanticAnchor } from "./ChatTimelineHistoryRows";

describe("captureChatTimelineSemanticAnchor", () => {
    it("uses the virtualizer offset from the current viewport", () => {
        const rows = [
            { id: "message:one" },
            { id: "message:two" },
        ] as unknown as readonly TranscriptTimelineItem[];

        expect(
            captureChatTimelineSemanticAnchor({
                historyRows: rows,
                viewportAnchor: {
                    index: 1,
                    key: "message:two",
                    offset: 286,
                },
            }),
        ).toEqual({
            entryId: "message:two",
            offsetWithinEntry: 286,
        });
    });
});
