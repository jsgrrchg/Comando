import { afterEach, describe, expect, it } from "vitest";

import type { AiSessionSnapshot } from "@shared/ipc";
import { createEmptyAiSessionTranscriptModel } from "@renderer/app/ai/transcriptModel";

import type { ChatTimelineModel } from "./chatTimelineModel";
import {
    cacheChatTimeline,
    getCachedChatTimeline,
    resetCachedChatTimelinesForTests,
} from "./chatTimelineCache";

const transcript = createEmptyAiSessionTranscriptModel();
const trackedFiles: AiSessionSnapshot["trackedFiles"] = [];
const attentionToolCallIds = new Set<string>();
const model = {} as ChatTimelineModel;

afterEach(() => {
    resetCachedChatTimelinesForTests();
});

describe("chatTimelineCache", () => {
    it("reuses a timeline only while its render inputs are unchanged", () => {
        const input = {
            activeTurnStartedAt: null,
            attentionToolCallIds,
            model,
            sessionId: "session-1",
            status: "idle" as const,
            trackedFiles,
            transcript,
        };

        cacheChatTimeline(input);

        expect(getCachedChatTimeline(input)).toBe(model);
        expect(
            getCachedChatTimeline({
                ...input,
                attentionToolCallIds: new Set<string>(),
            }),
        ).toBeNull();
    });
});
