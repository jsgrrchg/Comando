import { describe, expect, it } from "vitest";

import type {
    AiSessionDomainEvent,
    AiMessage,
    AiSessionPatchChanges,
    AiSessionSnapshot,
    AiSessionStreamPayload,
    AiSessionUpdate,
    AiToolActivity,
} from "@shared/ipc";

import {
    buildAiSessionStreamRecoveryDiagnostic,
    buildAiSessionStreamRecoveryFallbackPayloads,
    getAiSessionStreamPayloadKind,
    getAiSessionStreamPreservationKey,
    isAiSessionStreamAckStale,
    isAiSessionUpdate,
    isCriticalAiSessionStreamPayload,
    isPreservableAiSessionStreamPayload,
    rememberAiSessionStreamPayloadForRecovery,
    type AiSessionStreamPreservationQueue,
} from "./session-stream";

const BASE_EVENT = {
    origin: "live",
    parentSessionId: null,
    runtimeId: "codex",
    runtimeSessionId: "runtime-session-1",
    sessionId: "session-1",
    updatedAt: "2026-04-14T00:00:00.000Z",
} satisfies Omit<AiSessionDomainEvent, "kind">;

function createStatusEvent(
    status: "error" | "idle" | "starting" | "streaming",
): AiSessionStreamPayload {
    return {
        ...BASE_EVENT,
        activeTurnStartedAt: null,
        kind: "status",
        lastError: status === "error" ? "Boom" : null,
        status,
    };
}

function createCompletedEvent(
    kind: "message-completed" | "thinking-completed",
): AiSessionStreamPayload {
    return {
        ...BASE_EVENT,
        kind,
        messageId: "message-1",
        ...(kind === "message-completed" ? { messageKind: "assistant" } : {}),
    } as AiSessionStreamPayload;
}

function createMessage(id: string, content = ""): AiMessage {
    return {
        attachments: [],
        content,
        createdAt: "2026-04-14T00:00:00.000Z",
        id,
        kind: "assistant",
        status: "streaming",
    };
}

function createVisibleTranscriptEvent(
    kind:
        | "message-delta"
        | "message-started"
        | "thinking-delta"
        | "thinking-started",
    messageId = "message-1",
    content = "Hello",
): AiSessionStreamPayload {
    if (kind === "message-started") {
        return {
            ...BASE_EVENT,
            kind,
            message: createMessage(messageId),
            messageKind: "assistant",
        };
    }
    if (kind === "thinking-started") {
        return {
            ...BASE_EVENT,
            kind,
            message: {
                ...createMessage(messageId),
                kind: "thinking",
            },
        };
    }
    if (kind === "message-delta") {
        return {
            ...BASE_EVENT,
            content,
            delta: content,
            kind,
            messageId,
            messageKind: "assistant",
        };
    }
    return {
        ...BASE_EVENT,
        content,
        delta: content,
        kind,
        messageId,
    };
}

function createToolActivity(): AiToolActivity {
    return {
        createdAt: "2026-04-14T00:00:00.000Z",
        diffs: [],
        exitCode: null,
        id: "tool-1",
        kind: "shell",
        locations: [],
        rawInputJson: null,
        rawOutputJson: null,
        sessionId: "session-1",
        status: "in_progress",
        summary: null,
        terminalOutput: null,
        title: "Run command",
        updatedAt: "2026-04-14T00:00:00.000Z",
    };
}

function createSnapshot(status: AiSessionSnapshot["status"]): AiSessionSnapshot {
    return {
        activeTurnStartedAt: null,
        availableCommands: [],
        configOptions: [],
        lastError: status === "error" ? "Boom" : null,
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
        status,
        title: "Chat",
        tokenUsage: null,
        toolActivity: [],
        trackedFiles: [],
        updatedAt: "2026-04-14T00:00:00.000Z",
        worktreeId: null,
    };
}

function createSnapshotUpdate(
    status: AiSessionSnapshot["status"],
): AiSessionUpdate {
    return {
        kind: "snapshot",
        snapshot: createSnapshot(status),
    };
}

function createPatchUpdate(
    status: AiSessionSnapshot["status"],
): AiSessionUpdate {
    return {
        kind: "patch",
        patch: {
            changes: {
                status,
            },
            runtimeId: "codex",
            sessionId: "session-1",
        },
    };
}

function createPatchUpdateWithChanges(
    changes: AiSessionPatchChanges,
): AiSessionUpdate {
    return {
        kind: "patch",
        patch: {
            changes,
            runtimeId: "codex",
            sessionId: "session-1",
        },
    };
}

describe("AI session stream helpers", () => {
    it("classifies session update payloads", () => {
        const update = createSnapshotUpdate("streaming");
        const event = createStatusEvent("streaming");

        expect(isAiSessionUpdate(update)).toBe(true);
        expect(isAiSessionUpdate(event)).toBe(false);
        expect(getAiSessionStreamPayloadKind(update)).toBe("snapshot");
        expect(getAiSessionStreamPayloadKind(event)).toBe("status");
    });

    it("marks completed message events as critical", () => {
        expect(
            isCriticalAiSessionStreamPayload(
                createCompletedEvent("message-completed"),
            ),
        ).toBe(true);
        expect(
            isCriticalAiSessionStreamPayload(
                createCompletedEvent("thinking-completed"),
            ),
        ).toBe(true);
    });

    it("marks terminal status events as critical", () => {
        expect(isCriticalAiSessionStreamPayload(createStatusEvent("idle"))).toBe(
            true,
        );
        expect(
            isCriticalAiSessionStreamPayload(createStatusEvent("error")),
        ).toBe(true);
    });

    it("does not mark streaming status events as terminal-critical", () => {
        expect(
            isCriticalAiSessionStreamPayload(createStatusEvent("streaming")),
        ).toBe(false);
    });

    it("marks idle or error snapshots and patches as critical", () => {
        expect(
            isCriticalAiSessionStreamPayload(createSnapshotUpdate("idle")),
        ).toBe(true);
        expect(
            isCriticalAiSessionStreamPayload(createSnapshotUpdate("error")),
        ).toBe(true);
        expect(isCriticalAiSessionStreamPayload(createPatchUpdate("idle"))).toBe(
            true,
        );
        expect(
            isCriticalAiSessionStreamPayload(createPatchUpdate("error")),
        ).toBe(true);
    });

    it("does not mark active snapshots and patches as critical", () => {
        expect(
            isCriticalAiSessionStreamPayload(createSnapshotUpdate("streaming")),
        ).toBe(false);
        expect(
            isCriticalAiSessionStreamPayload(createPatchUpdate("starting")),
        ).toBe(false);
    });

    it("marks visible transcript payloads as preservable", () => {
        expect(
            isPreservableAiSessionStreamPayload(
                createVisibleTranscriptEvent("message-started"),
            ),
        ).toBe(true);
        expect(
            isPreservableAiSessionStreamPayload(
                createVisibleTranscriptEvent("thinking-started"),
            ),
        ).toBe(true);
        expect(
            isPreservableAiSessionStreamPayload(
                createVisibleTranscriptEvent("message-delta"),
            ),
        ).toBe(true);
        expect(
            isPreservableAiSessionStreamPayload(
                createVisibleTranscriptEvent("thinking-delta"),
            ),
        ).toBe(true);
    });

    it("marks patches with visible messages or tool activity as preservable", () => {
        expect(
            isPreservableAiSessionStreamPayload(
                createPatchUpdateWithChanges({
                    messages: [createMessage("message-1", "Hello")],
                }),
            ),
        ).toBe(true);
        expect(
            isPreservableAiSessionStreamPayload(
                createPatchUpdateWithChanges({
                    toolActivity: [createToolActivity()],
                }),
            ),
        ).toBe(true);
    });

    it("does not preserve patches without visible transcript changes", () => {
        const queue: AiSessionStreamPreservationQueue = new Map();
        const patch = createPatchUpdateWithChanges({
            title: "Renamed chat",
        });

        expect(isPreservableAiSessionStreamPayload(patch)).toBe(false);
        expect(
            rememberAiSessionStreamPayloadForRecovery({
                maxPayloads: 10,
                payload: patch,
                queue,
                seq: 1,
            }),
        ).toEqual({
            droppedOldest: false,
            pendingCount: 0,
            preserved: false,
        });
        expect(queue.size).toBe(0);
    });

    it("merges preserved patch changes for the same session", () => {
        const queue: AiSessionStreamPreservationQueue = new Map();
        const toolActivity = createToolActivity();
        const message = createMessage("message-1", "Hello");
        const toolPatch = createPatchUpdateWithChanges({
            toolActivity: [toolActivity],
            updatedAt: "2026-04-14T00:00:01.000Z",
        });
        const terminalPatch = createPatchUpdateWithChanges({
            messages: [message],
            status: "idle",
            updatedAt: "2026-04-14T00:00:02.000Z",
        });

        rememberAiSessionStreamPayloadForRecovery({
            maxPayloads: 10,
            payload: toolPatch,
            queue,
            seq: 1,
        });
        rememberAiSessionStreamPayloadForRecovery({
            maxPayloads: 10,
            payload: terminalPatch,
            queue,
            seq: 2,
        });

        expect(queue.size).toBe(1);
        expect(
            queue.get(getAiSessionStreamPreservationKey(terminalPatch) ?? ""),
        ).toEqual({
            payload: {
                kind: "patch",
                patch: {
                    changes: {
                        messages: [message],
                        status: "idle",
                        toolActivity: [toolActivity],
                        updatedAt: "2026-04-14T00:00:02.000Z",
                    },
                    runtimeId: "codex",
                    sessionId: "session-1",
                },
            },
            seq: 2,
        });
    });

    it("coalesces multiple deltas for the same message and keeps accumulated content", () => {
        const queue: AiSessionStreamPreservationQueue = new Map();
        const firstDelta = createVisibleTranscriptEvent(
            "message-delta",
            "message-1",
            "Hel",
        );
        const latestDelta = createVisibleTranscriptEvent(
            "message-delta",
            "message-1",
            "Hello",
        );

        rememberAiSessionStreamPayloadForRecovery({
            maxPayloads: 10,
            payload: firstDelta,
            queue,
            seq: 1,
        });
        rememberAiSessionStreamPayloadForRecovery({
            maxPayloads: 10,
            payload: latestDelta,
            queue,
            seq: 2,
        });

        const key = getAiSessionStreamPreservationKey(latestDelta);
        expect(queue.size).toBe(1);
        expect(key).not.toBeNull();
        expect(queue.get(key ?? "")).toEqual({
            payload: latestDelta,
            seq: 2,
        });
    });

    it("drops the oldest preserved payload when the queue exceeds its limit", () => {
        const queue: AiSessionStreamPreservationQueue = new Map();
        const firstDelta = createVisibleTranscriptEvent(
            "message-delta",
            "message-1",
            "First",
        );
        const secondDelta = createVisibleTranscriptEvent(
            "message-delta",
            "message-2",
            "Second",
        );

        rememberAiSessionStreamPayloadForRecovery({
            maxPayloads: 1,
            payload: firstDelta,
            queue,
            seq: 1,
        });
        expect(
            rememberAiSessionStreamPayloadForRecovery({
                maxPayloads: 1,
                payload: secondDelta,
                queue,
                seq: 2,
            }),
        ).toEqual({
            droppedOldest: true,
            pendingCount: 1,
            preserved: true,
        });

        expect(queue.has(getAiSessionStreamPreservationKey(firstDelta) ?? "")).toBe(
            false,
        );
        expect(
            queue.get(getAiSessionStreamPreservationKey(secondDelta) ?? ""),
        ).toEqual({
            payload: secondDelta,
            seq: 2,
        });
    });

    it("only marks ack state stale when an unacked message exceeds the timeout", () => {
        const timeoutMs = 2_000;

        expect(
            isAiSessionStreamAckStale(
                {
                    lastAckSeq: 4,
                    lastSentAt: 1_000,
                    lastSentSeq: 4,
                    pendingAckSentAtBySeq: new Map(),
                },
                5_000,
                timeoutMs,
            ),
        ).toBe(false);
        expect(
            isAiSessionStreamAckStale(
                {
                    lastAckSeq: 3,
                    lastSentAt: 1_000,
                    lastSentSeq: 4,
                    pendingAckSentAtBySeq: new Map([[4, 1_000]]),
                },
                2_999,
                timeoutMs,
            ),
        ).toBe(false);
        expect(
            isAiSessionStreamAckStale(
                {
                    lastAckSeq: 3,
                    lastSentAt: 1_000,
                    lastSentSeq: 4,
                    pendingAckSentAtBySeq: new Map([[4, 1_000]]),
                },
                3_000,
                timeoutMs,
            ),
        ).toBe(true);
    });

    it("keeps an older unacked message stale after newer heartbeats", () => {
        expect(
            isAiSessionStreamAckStale(
                {
                    lastAckSeq: 3,
                    lastSentAt: 2_900,
                    lastSentSeq: 6,
                    pendingAckSentAtBySeq: new Map([
                        [4, 1_000],
                        [5, 2_000],
                        [6, 2_900],
                    ]),
                },
                3_000,
                2_000,
            ),
        ).toBe(true);
    });

    it("builds recovery diagnostics from ack state", () => {
        expect(
            buildAiSessionStreamRecoveryDiagnostic({
                nowMs: 4_500,
                pendingPreservedPayloadCount: 2,
                reason: "ack-timeout",
                resyncSnapshotCount: 1,
                state: {
                    lastAckSeq: 7,
                    lastSentAt: 4_000,
                    lastSentSeq: 9,
                    pendingAckSentAtBySeq: new Map([
                        [8, 2_000],
                        [9, 4_000],
                    ]),
                },
            }),
        ).toEqual({
            ackLagMs: 2_500,
            lastAckSeq: 7,
            lastSentSeq: 9,
            pendingPreservedPayloadCount: 2,
            reason: "ack-timeout",
            resyncSnapshotCount: 1,
        });
    });

    it("builds recovery fallback payloads with critical entries before resync snapshots", () => {
        const laterCritical = createStatusEvent("idle");
        const earlierCritical = createCompletedEvent("message-completed");
        const snapshot = createSnapshot("streaming");

        expect(
            buildAiSessionStreamRecoveryFallbackPayloads({
                pendingPreservedPayloads: [
                    {
                        payload: laterCritical,
                        seq: 20,
                    },
                    {
                        payload: earlierCritical,
                        seq: 10,
                    },
                ],
                resyncSnapshots: [snapshot],
            }),
        ).toEqual([
            earlierCritical,
            laterCritical,
            {
                kind: "snapshot",
                snapshot,
            },
        ]);
    });

    it("builds recovery fallback payloads with visible transcript payloads before authoritative snapshots", () => {
        const started = createVisibleTranscriptEvent("message-started");
        const delta = createVisibleTranscriptEvent(
            "message-delta",
            "message-1",
            "Partial",
        );
        const snapshot = {
            ...createSnapshot("idle"),
            messages: [
                {
                    attachments: [],
                    content: "Partial response complete",
                    createdAt: "2026-04-14T00:00:00.000Z",
                    id: "message-1",
                    kind: "assistant",
                    status: "completed",
                },
            ],
        } satisfies AiSessionSnapshot;

        expect(
            buildAiSessionStreamRecoveryFallbackPayloads({
                pendingPreservedPayloads: [
                    {
                        payload: delta,
                        seq: 12,
                    },
                    {
                        payload: started,
                        seq: 10,
                    },
                ],
                resyncSnapshots: [snapshot],
            }),
        ).toEqual([
            started,
            delta,
            {
                kind: "snapshot",
                snapshot,
            },
        ]);
    });

    it("does not add resync snapshots when none are available", () => {
        const critical = createCompletedEvent("thinking-completed");

        expect(
            buildAiSessionStreamRecoveryFallbackPayloads({
                pendingPreservedPayloads: [
                    {
                        payload: critical,
                        seq: 1,
                    },
                ],
                resyncSnapshots: [],
            }),
        ).toEqual([critical]);
    });
});
