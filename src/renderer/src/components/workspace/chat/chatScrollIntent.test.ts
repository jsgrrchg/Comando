import { describe, expect, it } from "vitest";

import {
    anchorNewChatTurn,
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

    it("invalidates a queued follow when a new turn is anchored", () => {
        const following = createChatScrollIntent();
        const anchored = anchorNewChatTurn(following);

        expect(anchored).toEqual({
            mode: "new-turn-anchor",
            navigationGeneration: 1,
        });
        expect(
            canApplyChatScrollOperation(
                anchored,
                following.navigationGeneration,
            ),
        ).toBe(false);
    });
});
