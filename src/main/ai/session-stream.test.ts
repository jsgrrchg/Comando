import { describe, expect, it } from "vitest";

import type {
    AiSessionDomainEvent,
    AiSessionSnapshot,
    AiSessionStreamPayload,
    AiSessionUpdate,
} from "@shared/ipc";

import {
    buildAiSessionStreamRecoveryDiagnostic,
    buildAiSessionStreamRecoveryFallbackPayloads,
    getAiSessionStreamPayloadKind,
    isAiSessionStreamAckStale,
    isAiSessionUpdate,
    isCriticalAiSessionStreamPayload,
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

    it("only marks ack state stale when an unacked message exceeds the timeout", () => {
        const timeoutMs = 2_000;

        expect(
            isAiSessionStreamAckStale(
                {
                    lastAckSeq: 4,
                    lastSentAt: 1_000,
                    lastSentSeq: 4,
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
                },
                3_000,
                timeoutMs,
            ),
        ).toBe(true);
    });

    it("builds recovery diagnostics from ack state", () => {
        expect(
            buildAiSessionStreamRecoveryDiagnostic({
                nowMs: 4_500,
                pendingCriticalPayloadCount: 2,
                reason: "ack-timeout",
                resyncSnapshotCount: 1,
                state: {
                    lastAckSeq: 7,
                    lastSentAt: 2_000,
                    lastSentSeq: 9,
                },
            }),
        ).toEqual({
            ackLagMs: 2_500,
            lastAckSeq: 7,
            lastSentSeq: 9,
            pendingCriticalPayloadCount: 2,
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
                pendingCriticalPayloads: [
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

    it("does not add resync snapshots when none are available", () => {
        const critical = createCompletedEvent("thinking-completed");

        expect(
            buildAiSessionStreamRecoveryFallbackPayloads({
                pendingCriticalPayloads: [
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
