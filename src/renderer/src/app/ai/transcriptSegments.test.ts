import { describe, expect, it } from "vitest";

import type { AiSessionSnapshot } from "@shared/ipc";

import {
    applyAiSessionDomainEventToSegments,
    sealAiSessionLiveTail,
    segmentAiSessionTranscript,
} from "./transcriptSegments";

const snapshot: Pick<
    AiSessionSnapshot,
    "activeTurnStartedAt" | "messages" | "plan" | "status" | "toolActivity" | "updatedAt"
> = {
    activeTurnStartedAt: "2026-01-01T00:01:00.000Z",
    messages: [
        {
            attachments: [],
            content: "sealed",
            createdAt: "2026-01-01T00:00:00.000Z",
            id: "old",
            kind: "assistant",
            status: "completed",
        },
        {
            attachments: [],
            content: "live",
            createdAt: "2026-01-01T00:01:00.000Z",
            id: "live",
            kind: "assistant",
            status: "streaming",
        },
    ],
    plan: null,
    status: "streaming",
    toolActivity: [],
    updatedAt: "2026-01-01T00:01:01.000Z",
};

describe("transcriptSegments", () => {
    it("keeps stable history identity while patching the live tail", () => {
        const segmented = segmentAiSessionTranscript(snapshot);
        const next = applyAiSessionDomainEventToSegments(segmented, {
            content: "live tail",
            delta: " tail",
            kind: "message-delta",
            messageId: "live",
            messageKind: "assistant",
            origin: "live",
            parentSessionId: null,
            runtimeId: "codex",
            runtimeSessionId: null,
            sessionId: "session-1",
            updatedAt: "2026-01-01T00:01:02.000Z",
        });

        expect(next.stableHistory).toBe(segmented.stableHistory);
        expect(next.liveTail.transcript.messages[0]?.content).toBe("live tail");
    });

    it("promotes the tail only when a turn is sealed", () => {
        const segmented = segmentAiSessionTranscript(snapshot);
        const sealed = sealAiSessionLiveTail(segmented);

        expect(sealed.stableHistory.transcript.messages).toHaveLength(2);
        expect(sealed.liveTail.transcript.orderedEntryIds).toHaveLength(0);
    });
});
