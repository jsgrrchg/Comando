import { describe, expect, it } from "vitest";

import type { AiSessionSnapshot } from "@shared/ipc";

import { isActiveChatTurnStatus, isChatStreamingStatus } from "./chatTurnStatus";

type AiSessionStatus = AiSessionSnapshot["status"];

describe("chatTurnStatus", () => {
    it.each<AiSessionStatus>(["starting", "streaming"])(
        "treats %s as a visible streaming status",
        (status) => {
            expect(isChatStreamingStatus(status)).toBe(true);
        },
    );

    it.each<AiSessionStatus>([
        "error",
        "idle",
        "waiting_permission",
        "waiting_user_input",
    ])("does not treat %s as a visible streaming status", (status) => {
        expect(isChatStreamingStatus(status)).toBe(false);
    });

    it.each<AiSessionStatus>([
        "starting",
        "streaming",
        "waiting_permission",
        "waiting_user_input",
    ])("keeps the turn timer active for %s", (status) => {
        expect(isActiveChatTurnStatus(status)).toBe(true);
    });

    it.each<AiSessionStatus>(["error", "idle"])(
        "stops the turn timer for %s",
        (status) => {
            expect(isActiveChatTurnStatus(status)).toBe(false);
        },
    );
});
