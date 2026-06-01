import { describe, expect, it } from "vitest";

import { buildAiSessionDomainEvents } from "./ai-session-events";
import type { AiSessionSnapshot, AiToolActivity } from "./ipc";

function createSnapshot(
    overrides: Partial<AiSessionSnapshot> = {},
): AiSessionSnapshot {
    return {
        activeTurnStartedAt: null,
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
        status: "idle",
        title: "Chat",
        tokenUsage: null,
        toolActivity: [],
        trackedFiles: [],
        updatedAt: "2026-05-31T00:00:00.000Z",
        worktreeId: null,
        ...overrides,
    };
}

function createToolActivity(
    overrides: Partial<AiToolActivity> = {},
): AiToolActivity {
    return {
        createdAt: "2026-05-31T00:00:00.000Z",
        diffs: [],
        exitCode: null,
        id: "tool-1",
        kind: "task",
        locations: [],
        rawInputJson: null,
        rawOutputJson: null,
        sessionId: "session-1",
        status: "in_progress",
        summary: null,
        terminalOutput: null,
        title: "Run task",
        updatedAt: "2026-05-31T00:00:00.000Z",
        ...overrides,
    };
}

describe("buildAiSessionDomainEvents", () => {
    it("emits message deltas and completion from stable message ids", () => {
        const previous = createSnapshot({
            messages: [
                {
                    attachments: [],
                    content: "Hel",
                    createdAt: "2026-05-31T00:00:00.000Z",
                    id: "msg-1",
                    kind: "assistant",
                    status: "streaming",
                },
            ],
            status: "streaming",
        });
        const next = createSnapshot({
            messages: [
                {
                    attachments: [],
                    content: "Hello",
                    createdAt: "2026-05-31T00:00:00.000Z",
                    id: "msg-1",
                    kind: "assistant",
                    status: "completed",
                },
            ],
            status: "idle",
            updatedAt: "2026-05-31T00:00:01.000Z",
        });

        const events = buildAiSessionDomainEvents(previous, next, {
            origin: "live",
        });

        expect(events).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    content: "Hello",
                    delta: "lo",
                    kind: "message-delta",
                    messageId: "msg-1",
                }),
                expect.objectContaining({
                    kind: "message-completed",
                    messageId: "msg-1",
                }),
                expect.objectContaining({
                    kind: "status",
                    status: "idle",
                }),
            ]),
        );
    });

    it("does not replay transcript events for the initial snapshot by default", () => {
        const next = createSnapshot({
            messages: [
                {
                    attachments: [],
                    content: "Historical answer",
                    createdAt: "2026-05-31T00:00:00.000Z",
                    id: "msg-1",
                    kind: "assistant",
                    status: "completed",
                },
            ],
        });

        const events = buildAiSessionDomainEvents(null, next, {
            origin: "restore",
        });

        expect(events.some((event) => event.kind === "message-delta")).toBe(
            false,
        );
        expect(events).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ kind: "session-info" }),
                expect.objectContaining({ kind: "status" }),
            ]),
        );
    });

    it("emits subagent identity and breadcrumb events", () => {
        const child = createSnapshot({
            parentSessionId: "parent-session",
            sessionId: "child-session",
            title: "Inspect",
        });
        const parentPrevious = createSnapshot({
            toolActivity: [createToolActivity()],
        });
        const parentNext = createSnapshot({
            toolActivity: [
                createToolActivity({
                    action: {
                        kind: "open_session",
                        sessionId: "child-session",
                    },
                }),
            ],
        });

        const childEvents = buildAiSessionDomainEvents(null, child, {
            origin: "live",
        });
        const parentEvents = buildAiSessionDomainEvents(
            parentPrevious,
            parentNext,
            {
                origin: "live",
            },
        );

        expect(childEvents).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    childSessionId: "child-session",
                    kind: "subagent-created",
                    parentSessionId: "parent-session",
                }),
            ]),
        );
        expect(parentEvents).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    childSessionId: "child-session",
                    kind: "subagent-breadcrumb",
                    toolCallId: "tool-1",
                }),
            ]),
        );
    });
});
