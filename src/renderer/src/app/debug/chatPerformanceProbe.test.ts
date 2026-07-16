import { afterEach, describe, expect, it } from "vitest";

import {
    measureChatPerformance,
    recordChatPerformanceMetric,
    resetChatPerformanceProbeForTests,
    setChatPerformanceProbeEnabledForTests,
} from "./chatPerformanceProbe";

afterEach(() => {
    resetChatPerformanceProbeForTests();
});

describe("chatPerformanceProbe", () => {
    it("does not allocate a global store while disabled", () => {
        setChatPerformanceProbeEnabledForTests(false);
        recordChatPerformanceMetric("apply_event_ms", {
            sessionId: "session-with-sensitive-output",
            values: { payloadDepth: 3 },
        });

        expect(
            (globalThis as typeof globalThis & {
                __COMANDO_CHAT_PERFORMANCE_PROBE__?: unknown;
            }).__COMANDO_CHAT_PERFORMANCE_PROBE__,
        ).toBeUndefined();
    });

    it("stores only bounded numeric diagnostics and an anonymous session key", () => {
        setChatPerformanceProbeEnabledForTests(true);
        measureChatPerformance(
            "timeline_reconcile_ms",
            {
                sessionId: "session-with-sensitive-output",
                values: { liveTailChars: 42, transcriptRows: 6 },
            },
            () => undefined,
        );
        const root = globalThis as typeof globalThis & {
            __comandoChatPerformanceProbeDump?: () => readonly unknown[];
        };
        const dump = root.__comandoChatPerformanceProbeDump?.() ?? [];

        expect(dump).toHaveLength(1);
        expect(JSON.stringify(dump)).not.toContain("session-with-sensitive-output");
        expect(JSON.stringify(dump)).not.toContain("output");
        expect(JSON.stringify(dump)).toContain("liveTailChars");
    });

    it("caps the in-memory dump", () => {
        setChatPerformanceProbeEnabledForTests(true);
        for (let index = 0; index < 520; index += 1) {
            recordChatPerformanceMetric("markdown_parse_ms", {
                values: { contentChars: index },
            });
        }
        const root = globalThis as typeof globalThis & {
            __comandoChatPerformanceProbeDump?: () => readonly unknown[];
        };

        expect(root.__comandoChatPerformanceProbeDump?.()).toHaveLength(500);
    });
});
