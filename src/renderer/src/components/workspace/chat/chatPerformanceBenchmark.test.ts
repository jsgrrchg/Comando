import { describe, expect, it } from "vitest";

import {
    createChatPerformanceCounter,
    measureChatPerformanceWork,
} from "./chatPerformanceBenchmark";

describe("chatPerformanceBenchmark", () => {
    it("counts named work deterministically", () => {
        const counter = createChatPerformanceCounter();

        counter.count("transcript-entry");
        counter.count("transcript-entry", 2);
        counter.count("timeline-row", 4);

        expect(counter.snapshot()).toEqual({
            "timeline-row": 4,
            "transcript-entry": 3,
        });
    });

    it("uses an injected clock instead of asserting wall-clock timing", () => {
        const timestamps = [100, 107.5];
        const measurement = measureChatPerformanceWork(
            "tail-delta",
            (counter) => {
                counter.count("transcript-patch");
                counter.count("timeline-tail");
                return "complete";
            },
            {
                now: () => timestamps.shift() ?? 107.5,
            },
        );

        expect(measurement).toEqual({
            durationMs: 7.5,
            name: "tail-delta",
            result: "complete",
            work: {
                "timeline-tail": 1,
                "transcript-patch": 1,
            },
        });
    });
});
