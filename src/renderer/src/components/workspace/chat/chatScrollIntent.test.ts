import { describe, expect, it } from "vitest";

import {
    canApplyChatScrollOperation,
    createChatScrollIntent,
    followChatScrollEnd,
    readChatScroll,
} from "./chatScrollIntent";

describe("chat scroll intent", () => {
    it("invalidates a queued follow after user navigation", () => {
        const following = createChatScrollIntent();
        const reading = readChatScroll(following);

        expect(
            canApplyChatScrollOperation(
                reading,
                following.navigationGeneration,
            ),
        ).toBe(false);
    });

    it("creates a new generation when the user returns to the end", () => {
        const reading = readChatScroll(createChatScrollIntent());
        const following = followChatScrollEnd(reading);

        expect(following).toEqual({ mode: "follow-end", navigationGeneration: 2 });
        expect(canApplyChatScrollOperation(following, 2)).toBe(true);
    });
});
