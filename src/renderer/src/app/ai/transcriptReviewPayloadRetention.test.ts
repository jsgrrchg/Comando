import { describe, expect, it } from "vitest";

import { TranscriptReviewPayloadRetention } from "./transcriptReviewPayloadRetention";

describe("TranscriptReviewPayloadRetention", () => {
    it("releases a review payload only after its last visible consumer", () => {
        const retention = new TranscriptReviewPayloadRetention();

        expect(retention.retain("payload:diff")).toBe(true);
        expect(retention.retain("payload:diff")).toBe(false);
        expect(retention.release("payload:diff")).toBe(false);
        expect(retention.release("payload:diff")).toBe(true);
    });
});
