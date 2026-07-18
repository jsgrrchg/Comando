import { beforeEach, describe, expect, it } from "vitest";

import {
    incrementChatPerformanceCounter,
    readChatPerformanceCounters,
    resetChatPerformanceCounters,
} from "./chatPerformanceCounters";

describe("chatPerformanceCounters", () => {
    beforeEach(resetChatPerformanceCounters);

    it("records only bounded numeric diagnostics", () => {
        incrementChatPerformanceCounter("timeline_blocks_built", 2);
        incrementChatPerformanceCounter("timeline_full_rebuilds");

        expect(readChatPerformanceCounters()).toMatchObject({
            timeline_blocks_built: 2,
            timeline_full_rebuilds: 1,
        });
    });
});
