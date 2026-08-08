import { describe, expect, it } from "vitest";

import {
    CHAT_HISTORY_RETENTION_DAYS,
    isMoreRestrictiveHistoryRetention,
    normalizeChatHistoryRetentionDays,
} from "./chat-history-retention";

describe("chat history retention", () => {
    it.each(CHAT_HISTORY_RETENTION_DAYS)("preserves supported value %s", (value) => {
        expect(normalizeChatHistoryRetentionDays(value)).toBe(value);
    });

    it.each([-1, 2, 7.5, 366, "7", null, undefined, Number.NaN])(
        "falls back to Forever for unsupported value %s",
        (value) => {
            expect(normalizeChatHistoryRetentionDays(value)).toBe(0);
        },
    );

    it("detects only changes that can delete history sooner", () => {
        expect(isMoreRestrictiveHistoryRetention(0, 30)).toBe(true);
        expect(isMoreRestrictiveHistoryRetention(30, 7)).toBe(true);
        expect(isMoreRestrictiveHistoryRetention(7, 30)).toBe(false);
        expect(isMoreRestrictiveHistoryRetention(7, 0)).toBe(false);
        expect(isMoreRestrictiveHistoryRetention(7, 7)).toBe(false);
    });
});
