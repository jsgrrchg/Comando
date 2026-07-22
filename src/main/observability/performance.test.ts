import { describe, expect, it } from "vitest";

import { createMainProcessPerformanceMonitor } from "./performance";

describe("MainProcessPerformanceMonitor", () => {
    it("does not allocate traces while diagnostic tracing is disabled", () => {
        let now = 10;
        const monitor = createMainProcessPerformanceMonitor({
            clock: { now: () => now },
            enabled: false,
        });

        const result = monitor.measureSync("ai.review.apply", () => {
            now += 50;
            return "unchanged";
        });
        monitor.record("native-backend.stdout.parse", { bytes: 1_024 });

        expect(result).toBe("unchanged");
        expect(monitor.snapshot()).toEqual([]);
    });

    it("keeps the newest measurements in chronological order", () => {
        let now = 0;
        const monitor = createMainProcessPerformanceMonitor({
            capacity: 2,
            clock: { now: () => now },
            enabled: true,
        });

        monitor.record("native-backend.stdout.parse", { bytes: 10 });
        now += 1;
        monitor.record("ai.snapshot.apply", { sessionId: "session-a" });
        now += 1;
        monitor.record("ai.review.apply", { toolCallId: "tool-a" });

        expect(monitor.snapshot()).toEqual([
            {
                atMs: 1,
                metadata: { sessionId: "session-a" },
                name: "ai.snapshot.apply",
            },
            {
                atMs: 2,
                metadata: { toolCallId: "tool-a" },
                name: "ai.review.apply",
            },
        ]);
    });

    it("measures work without changing its result or exception", () => {
        let now = 100;
        const monitor = createMainProcessPerformanceMonitor({
            clock: { now: () => now },
            enabled: true,
        });

        const result = monitor.measureSync("ai.review.apply", () => {
            now += 7;
            return { accepted: true };
        });

        expect(result).toEqual({ accepted: true });
        expect(monitor.snapshot()).toEqual([
            {
                atMs: 107,
                durationMs: 7,
                name: "ai.review.apply",
            },
        ]);
    });
});
