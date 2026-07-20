import { describe, expect, it, vi } from "vitest";

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
    writeAiSessionTranscriptToSnapshot,
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
            "tool:session-1:tool-1",
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

    it("keeps repeated tool ids distinct across sessions", () => {
        const transcript = buildAiSessionTranscriptModel({
            messages: [],
            toolActivity: [
                createToolActivity(),
                createToolActivity({
                    createdAt: "2026-04-14T00:00:02.000Z",
                    sessionId: "session-2",
                    updatedAt: "2026-04-14T00:00:02.000Z",
                }),
            ],
        });

        expect(transcript.messageOrder).toEqual([
            "tool:session-1:tool-1",
            "tool:session-2:tool-1",
        ]);
        expect(
            getAiSessionTranscriptToolActivity(transcript).map(
                (activity) => activity.sessionId,
            ),
        ).toEqual(["session-1", "session-2"]);
    });

    it("hides persisted encrypted inter-agent transport payloads", () => {
        const encryptedPayload =
            "gAAAAABqUCwGM4iUSPpzoPf1Tn5y6lh72L_8dnVbmdOR42YZ9KRaUwUBCY14DMmdBOIOmjd2HW3l6SSCckLSjJ6KebNzsXzG9m8pajAOwQ2UxYazsFGhYP6jzx7KqOsnwWhMaOxcXDla5KQQwB66JlYo6rFxvUoIfpBeLEJY6ErSJ_KAjNlUkoU=";
        const transcript = buildAiSessionTranscriptModel({
            messages: [
                createMessage({
                    content: encryptedPayload,
                    id: "acp:user:2",
                    kind: "user",
                }),
                createMessage({
                    content: "Visible plaintext task",
                    id: "acp:user:3",
                    kind: "user",
                }),
                createMessage({
                    content: encryptedPayload,
                    id: "local-user-message",
                    kind: "user",
                }),
            ],
            toolActivity: [],
        });

        expect(getAiSessionTranscriptMessages(transcript)).toEqual([
            expect.objectContaining({
                content: "Visible plaintext task",
                id: "acp:user:3",
            }),
            expect.objectContaining({
                content: encryptedPayload,
                id: "local-user-message",
            }),
        ]);
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

    it("patches a long transcript tail without rebuilding order or untouched projections", () => {
        const messages = Array.from({ length: 10_000 }, (_, index) =>
            createMessage({
                content: `Message ${index}`,
                createdAt: new Date(
                    Date.UTC(2026, 3, 14, 0, 0, index),
                ).toISOString(),
                id: `message-${index}`,
                status: index === 9_999 ? "streaming" : "completed",
            }),
        );
        const transcript = buildAiSessionTranscriptModel({
            messages,
            toolActivity: [createToolActivity()],
        });
        const sort = vi.spyOn(Array.prototype, "sort");

        const updated = applyAiSessionDomainEventToTranscript(
            transcript,
            createSessionEvent({
                content: "Message 9999 with streamed tail",
                delta: " with streamed tail",
                kind: "message-delta",
                messageId: "message-9999",
                messageKind: "assistant",
                updatedAt: "2026-04-14T02:46:39.000Z",
            }),
        );

        expect(sort).not.toHaveBeenCalled();
        expect(updated.orderedEntryIds).toBe(transcript.orderedEntryIds);
        expect(updated.messageIndexById).toBe(transcript.messageIndexById);
        expect(updated.toolActivity).toBe(transcript.toolActivity);
        expect(updated.messages).not.toBe(transcript.messages);
        expect(updated.messages[0]).toBe(transcript.messages[0]);
        expect(updated.messages[9_999]?.content).toBe(
            "Message 9999 with streamed tail",
        );
        sort.mockRestore();
    });

    it("inserts delayed entries with binary ordering while preserving existing entry references", () => {
        const transcript = buildAiSessionTranscriptModel({
            messages: [
                createMessage({
                    createdAt: "2026-04-14T00:00:01.000Z",
                    id: "assistant-1",
                }),
                createMessage({
                    createdAt: "2026-04-14T00:00:03.000Z",
                    id: "assistant-3",
                }),
            ],
            toolActivity: [],
        });
        const originalFirstEntry = transcript.entriesById["message:assistant-1"];

        const updated = applyAiSessionDomainEventToTranscript(
            transcript,
            createSessionEvent({
                kind: "message-started",
                message: createMessage({
                    createdAt: "2026-04-14T00:00:02.000Z",
                    id: "assistant-2",
                    status: "streaming",
                }),
                messageKind: "assistant",
            }),
        );

        expect(updated.messageOrder).toEqual([
            "message:assistant-1",
            "message:assistant-2",
            "message:assistant-3",
        ]);
        expect(updated.entriesById["message:assistant-1"]).toBe(
            originalFirstEntry,
        );
    });

    it("matches the full builder after incremental message, tool, status, and plan events", () => {
        const assistant = createMessage({
            content: "",
            createdAt: "2026-04-14T00:00:00.000Z",
            id: "assistant-1",
            status: "streaming",
        });
        const thinking = createMessage({
            content: "Considering options",
            createdAt: "2026-04-14T00:00:01.000Z",
            id: "thinking-1",
            kind: "thinking",
            status: "streaming",
        });
        const tool = createToolActivity({
            createdAt: "2026-04-14T00:00:02.000Z",
        });
        const plan = createPlan({
            updatedAt: "2026-04-14T00:00:03.000Z",
        });
        let incremental = createEmptyAiSessionTranscriptModel();

        incremental = applyAiSessionDomainEventToTranscript(
            incremental,
            createSessionEvent({
                kind: "message-started",
                message: assistant,
                messageKind: "assistant",
            }),
        );
        incremental = applyAiSessionDomainEventToTranscript(
            incremental,
            createSessionEvent({
                kind: "thinking-started",
                message: thinking,
            }),
        );
        incremental = applyAiSessionDomainEventToTranscript(
            incremental,
            createSessionEvent({
                activity: tool,
                kind: "tool-activity",
            }),
        );
        incremental = applyAiSessionDomainEventToTranscript(
            incremental,
            createSessionEvent({
                activeTurnStartedAt: "2026-04-14T00:00:04.000Z",
                kind: "status",
                status: "streaming",
            }),
        );
        incremental = applyAiSessionDomainEventToTranscript(
            incremental,
            createSessionEvent({
                kind: "plan",
                plan,
            }),
        );
        incremental = applyAiSessionDomainEventToTranscript(
            incremental,
            createSessionEvent({
                content: "Final answer",
                delta: "Final answer",
                kind: "message-delta",
                messageId: assistant.id,
                messageKind: "assistant",
                updatedAt: "2026-04-14T00:00:05.000Z",
            }),
        );
        incremental = applyAiSessionDomainEventToTranscript(
            incremental,
            createSessionEvent({
                kind: "message-completed",
                messageId: assistant.id,
                messageKind: "assistant",
                updatedAt: "2026-04-14T00:00:06.000Z",
            }),
        );

        const expected = buildAiSessionTranscriptModel({
            activeTurnStartedAt: "2026-04-14T00:00:04.000Z",
            messages: [
                { ...assistant, content: "Final answer", status: "completed" },
                thinking,
            ],
            plan,
            status: "streaming",
            toolActivity: [tool],
        });

        expect(incremental.messageOrder).toEqual(expected.messageOrder);
        expect(getAiSessionTranscriptMessages(incremental)).toEqual(
            getAiSessionTranscriptMessages(expected),
        );
        expect(getAiSessionTranscriptToolActivity(incremental)).toEqual(
            getAiSessionTranscriptToolActivity(expected),
        );
        expect(incremental.activePlanMessageId).toBe(
            expected.activePlanMessageId,
        );
        expect(incremental.lastThinkingMessageId).toBe(
            expected.lastThinkingMessageId,
        );
        expect(incremental.lastTurnStartedMessageId).toBe(
            expected.lastTurnStartedMessageId,
        );
    });

    it("writes the transcript's persistent projections directly to snapshots", () => {
        const transcript = buildAiSessionTranscriptModel({
            messages: [createMessage()],
            toolActivity: [createToolActivity()],
        });
        const snapshot = writeAiSessionTranscriptToSnapshot(
            {
                availableCommands: [],
                configOptions: [],
                lastError: null,
                messages: [],
                modeId: null,
                modes: [],
                modelId: null,
                models: [],
                pendingPermission: null,
                pendingUserInput: null,
                plan: null,
                projectId: "project-1",
                runtimeId: "codex",
                runtimeSessionId: "runtime-session-1",
                sessionId: "session-1",
                status: "streaming",
                title: "Chat",
                tokenUsage: null,
                toolActivity: [],
                trackedFiles: [],
                updatedAt: "2026-04-14T00:00:00.000Z",
                worktreeId: null,
            },
            transcript,
        );

        expect(snapshot.messages).toBe(transcript.messages);
        expect(snapshot.toolActivity).toBe(transcript.toolActivity);
    });

    it("upserts tool activity while preserving the original createdAt", () => {
        let transcript = createEmptyAiSessionTranscriptModel();

        transcript = applyAiSessionDomainEventToTranscript(
            transcript,
            createSessionEvent({
                activity: createToolActivity({
                    createdAt: "2026-04-14T00:00:01.000Z",
                    exitCode: 0,
                    status: "in_progress",
                    summary: "Running",
                    terminalOutput: "hello world",
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

        expect(transcript.messageOrder).toEqual(["tool:session-1:tool-1"]);
        expect(getAiSessionTranscriptToolActivity(transcript)).toEqual([
            expect.objectContaining({
                createdAt: "2026-04-14T00:00:01.000Z",
                exitCode: 0,
                status: "completed",
                summary: "Done",
                terminalOutput: "hello world",
            }),
        ]);
    });

    it("attaches subagent breadcrumbs and preserves them across tool updates", () => {
        let transcript = buildAiSessionTranscriptModel({
            messages: [],
            toolActivity: [createToolActivity()],
        });
        const breadcrumb = createSessionEvent({
            childSessionId: "session-1:subagent:child-1",
            kind: "subagent-breadcrumb",
            toolCallId: "tool-1",
            updatedAt: "2026-04-14T00:00:02.000Z",
        });

        transcript = applyAiSessionDomainEventToTranscript(
            transcript,
            breadcrumb,
        );
        expect(getAiSessionTranscriptToolActivity(transcript)).toEqual([
            expect.objectContaining({
                action: {
                    kind: "open_session",
                    sessionId: "session-1:subagent:child-1",
                },
            }),
        ]);

        transcript = applyAiSessionDomainEventToTranscript(
            transcript,
            createSessionEvent({
                activity: createToolActivity({
                    status: "completed",
                    updatedAt: "2026-04-14T00:00:03.000Z",
                }),
                kind: "tool-activity",
                updatedAt: "2026-04-14T00:00:03.000Z",
            }),
        );
        const replayed = applyAiSessionDomainEventToTranscript(
            transcript,
            breadcrumb,
        );

        expect(getAiSessionTranscriptToolActivity(transcript)).toEqual([
            expect.objectContaining({
                action: {
                    kind: "open_session",
                    sessionId: "session-1:subagent:child-1",
                },
                status: "completed",
            }),
        ]);
        expect(replayed).toBe(transcript);
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

    it("anchors existing tool activity while applying incoming content updates", () => {
        const current = buildAiSessionTranscriptModel({
            messages: [],
            toolActivity: [
                createToolActivity({
                    createdAt: "2026-04-14T00:00:01.000Z",
                    status: "in_progress",
                    summary: "Running",
                    terminalOutput: "running",
                    updatedAt: "2026-04-14T00:00:01.000Z",
                }),
            ],
        });
        const incoming = buildAiSessionTranscriptModel({
            messages: [],
            toolActivity: [
                createToolActivity({
                    createdAt: "2026-04-14T00:00:05.000Z",
                    exitCode: 0,
                    status: "completed",
                    summary: "Done",
                    terminalOutput: "done",
                    updatedAt: "2026-04-14T00:00:05.000Z",
                }),
            ],
        });

        const merged = mergeAiSessionTranscriptSources(current, incoming, {
            includeMessages: false,
            includePlan: false,
            includeStatus: false,
            includeTools: true,
        });

        expect(getAiSessionTranscriptToolActivity(merged)).toEqual([
            expect.objectContaining({
                createdAt: "2026-04-14T00:00:01.000Z",
                exitCode: 0,
                status: "completed",
                summary: "Done",
                terminalOutput: "done",
                updatedAt: "2026-04-14T00:00:05.000Z",
            }),
        ]);
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
