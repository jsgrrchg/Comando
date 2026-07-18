import { describe, expect, it } from "vitest";

import {
    AI_TRANSCRIPT_BLOCK_CAPABILITY_VERSION,
    AI_TRANSCRIPT_CURSOR_LIMIT_MAX,
    normalizeAiTranscriptLimit,
} from "./ipc";

describe("AI transcript block contracts", () => {
    it("bounds cursor requests independently from mutable offsets", () => {
        expect(AI_TRANSCRIPT_BLOCK_CAPABILITY_VERSION).toBe(1);
        expect(normalizeAiTranscriptLimit(-1)).toBe(1);
        expect(normalizeAiTranscriptLimit(Number.POSITIVE_INFINITY)).toBe(1);
        expect(normalizeAiTranscriptLimit(10_000)).toBe(
            AI_TRANSCRIPT_CURSOR_LIMIT_MAX,
        );
    });
});
