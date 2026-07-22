import { describe, expect, it } from "vitest";

import { formatChatElapsedDuration } from "./chatElapsedDuration";

describe("formatChatElapsedDuration", () => {
    it.each([
        [0, "0s"],
        [59, "59s"],
        [60, "1m 00s"],
        [61, "1m 01s"],
        [3599, "59m 59s"],
        [3600, "1h 00m 00s"],
        [3728, "1h 02m 08s"],
        [36_000, "10h 00m 00s"],
    ])("formats %i seconds as %s", (totalSeconds, expected) => {
        expect(formatChatElapsedDuration(totalSeconds)).toBe(expected);
    });

    it("normalizes invalid or negative durations", () => {
        expect(formatChatElapsedDuration(-1)).toBe("0s");
        expect(formatChatElapsedDuration(Number.NaN)).toBe("0s");
    });
});
