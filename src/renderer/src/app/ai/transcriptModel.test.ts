import { describe, expect, it } from "vitest";

import type {
    AiMessage,
    AiPlan,
    AiSessionDomainEvent,
    AiToolActivity,
} from "@shared/ipc";

import {
    applyAiSessionDomainEventToTranscript,
    buildAiSessionTranscriptModel,
    createEmptyAiSessionTranscriptModel,
    getAiSessionTranscriptMessages,
    getAiSessionTranscriptToolActivity,
    mergeAiSessionTranscriptSources,
} from "./transcriptModel";

function createMessage(overrides: Partial<AiMessage> = {}): AiMessage {
    return {
        attachments: [],
        content: "Hello",
        createdAt: "2026-04-14T00:00:00.000Z",
        id: "msg-1",
        kind: "assistant",
        status: "completed",
        ...overrides,
    };
}

function createToolActivity(
    overrides: Partial<AiToolActivity> = {},
): AiToolActivity {
    return {
        createdAt: "2026-04-14T00:00:01.000Z",
        diffs: [],
        exitCode: null,
        id: "tool-1",
        kind: "shell",
        locations: [],
        rawInputJson: null,
        rawOutputJson: null,
        sessionId: "session-1",
        status: "in_progress",
        summary: "Running",
        terminalOutput: null,
        title: "Run command",
        updatedAt: "2026-04-14T00:00:01.000Z",
        ...overrides,
    };
}

function createPlan(overrides: Partial<AiPlan> = {}): AiPlan {
    return {
        entries: [
            {
                content: "Ship transcript model",
                priority: "medium",
                status: "in_progress",
            },
        ],
        title: null,
        updatedAt: "2026-04-14T00:00:02.000Z",
        ...overrides,
    };
}

function createSessionEvent(
    overrides: Partial<AiSessionDomainEvent> & {
        readonly kind: AiSessionDomainEvent["kind"];
    },
): AiSessionDomainEvent {
    const { kind, ...rest } = overrides;
    return {
        origin: "live",
        parentSessionId: null,
        runtimeId: "codex",
        runtimeSessionId: "runtime-session-1",
        sessionId: "session-1",
        updatedAt: "2026-04-14T00:00:00.000Z",
        ...rest,
        kind,
    } as AiSessionDomainEvent;
}

describe("transcriptModel", () => {
    it("builds stable ids and selectors from snapshot transcript data", () => {
        const transcript = buildAiSessionTranscriptModel({
            activeTurnStartedAt: "2026-04-14T00:00:03.000Z",
            messages: [
                createMessage({
                    content: "Prompt",
                    createdAt: "2026-04-14T00:00:00.000Z",
                    id: "user-1",
                    kind: "user",
                }),
                createMessage({
                    content: "Thinking",
                    createdAt: "2026-04-14T00:00:01.000Z",
                    id: "thinking-1",
                    kind: "thinking",
                    status: "streaming",
                }),
                createMessage({
                    content: "Answer",
                    createdAt: "2026-04-14T00:00:02.000Z",
                    id: "assistant-1",
                    kind: "assistant",
                }),
            ],
            plan: createPlan(),
            status: "streaming",
            toolActivity: [createToolActivity()],
            updatedAt: "2026-04-14T00:00:03.000Z",
        });

        expect(transcript.messageOrder).toEqual([
            "message:user-1",
            "message:thinking-1",
            "tool:tool-1",
            "message:assistant-1",
            "plan:active",
            "status:active-turn",
        ]);
        expect(transcript.messagesById["message:assistant-1"]).toEqual(
            expect.objectContaining({
                kind: "message",
            }),
        );
        expect(transcript.messageIndexById["plan:active"]).toBe(4);
        expect(transcript.lastAssistantMessageId).toBe("message:assistant-1");
        expect(transcript.lastThinkingMessageId).toBe("message:thinking-1");
        expect(transcript.activePlanMessageId).toBe("plan:active");
        expect(transcript.lastTurnStartedMessageId).toBe("status:active-turn");
    });

    it("upserts streamed message deltas by message id", () => {
        let transcript = createEmptyAiSessionTranscriptModel();

        transcript = applyAiSessionDomainEventToTranscript(
            transcript,
            createSessionEvent({
                kind: "message-started",
                message: createMessage({
                    content: "",
                    id: "assistant-1",
                    status: "streaming",
                }),
                messageKind: "assistant",
            }),
        );
        transcript = applyAiSessionDomainEventToTranscript(
            transcript,
            createSessionEvent({
                content: "Hello",
                delta: "Hello",
                kind: "message-delta",
                messageId: "assistant-1",
                messageKind: "assistant",
            }),
        );
        transcript = applyAiSessionDomainEventToTranscript(
            transcript,
            createSessionEvent({
                content: "Hello",
                delta: "",
                kind: "message-delta",
                messageId: "assistant-1",
                messageKind: "assistant",
            }),
        );

        expect(transcript.messageOrder).toEqual(["message:assistant-1"]);
        expect(getAiSessionTranscriptMessages(transcript)).toEqual([
            expect.objectContaining({
                content: "Hello",
                id: "assistant-1",
            }),
        ]);
    });

    it("upserts tool activity while preserving the original createdAt", () => {
        let transcript = createEmptyAiSessionTranscriptModel();

        transcript = applyAiSessionDomainEventToTranscript(
            transcript,
            createSessionEvent({
                activity: createToolActivity({
                    createdAt: "2026-04-14T00:00:01.000Z",
                    status: "in_progress",
                    summary: "Running",
                }),
                kind: "tool-activity",
            }),
        );
        transcript = applyAiSessionDomainEventToTranscript(
            transcript,
            createSessionEvent({
                activity: createToolActivity({
                    createdAt: "2026-04-14T00:00:05.000Z",
                    status: "completed",
                    summary: "Done",
                    updatedAt: "2026-04-14T00:00:05.000Z",
                }),
                kind: "tool-activity",
            }),
        );

        expect(transcript.messageOrder).toEqual(["tool:tool-1"]);
        expect(getAiSessionTranscriptToolActivity(transcript)).toEqual([
            expect.objectContaining({
                createdAt: "2026-04-14T00:00:01.000Z",
                status: "completed",
                summary: "Done",
            }),
        ]);
    });

    it("merges selected incoming sources without replacing the whole transcript", () => {
        const current = buildAiSessionTranscriptModel({
            activeTurnStartedAt: "2026-04-14T00:00:03.000Z",
            messages: [
                createMessage({
                    content: "Newer answer",
                    id: "assistant-1",
                }),
            ],
            plan: createPlan(),
            status: "streaming",
            toolActivity: [
                createToolActivity({
                    status: "completed",
                    summary: "Existing tool",
                }),
            ],
        });
        const incoming = buildAiSessionTranscriptModel({
            messages: [
                createMessage({
                    content: "Old answer",
                    id: "assistant-1",
                }),
            ],
            plan: null,
            status: "idle",
            toolActivity: [
                createToolActivity({
                    status: "completed",
                    summary: "Fresh tool metadata",
                    updatedAt: "2026-04-14T00:00:04.000Z",
                }),
            ],
        });

        const merged = mergeAiSessionTranscriptSources(current, incoming, {
            includeMessages: false,
            includePlan: true,
            includeStatus: true,
            includeTools: true,
        });

        expect(getAiSessionTranscriptMessages(merged)[0]?.content).toBe(
            "Newer answer",
        );
        expect(getAiSessionTranscriptToolActivity(merged)[0]?.summary).toBe(
            "Fresh tool metadata",
        );
        expect(merged.activePlanMessageId).toBeNull();
        expect(merged.lastTurnStartedMessageId).toBeNull();
    });

    it("replaces tool entries when incoming tool activity is explicit", () => {
        const current = buildAiSessionTranscriptModel({
            messages: [
                createMessage({
                    content: "Keep me",
                    id: "assistant-1",
                }),
            ],
            toolActivity: [createToolActivity()],
        });
        const incoming = buildAiSessionTranscriptModel({
            messages: [],
            toolActivity: [],
        });

        const merged = mergeAiSessionTranscriptSources(current, incoming, {
            includeMessages: false,
            includePlan: false,
            includeStatus: false,
            includeTools: true,
        });

        expect(getAiSessionTranscriptMessages(merged)).toHaveLength(1);
        expect(getAiSessionTranscriptToolActivity(merged)).toHaveLength(0);
        expect(merged.messageOrder).toEqual(["message:assistant-1"]);
    });
});
