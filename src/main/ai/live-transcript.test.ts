import { describe, expect, it } from "vitest";

import type {
    AiMessage,
    AiSessionDomainEventBase,
    AiSessionSnapshot,
    AiToolActivity,
    AiTranscriptBlockMetadata,
} from "@shared/ipc";

import { createEmptyAiSessionSnapshot } from "./persistence";
import { AiLiveTranscriptTailStore } from "./live-transcript";

const SESSION_ID = "session-1";
const TURN_STARTED_AT = "2026-07-18T00:01:00.000Z";

const eventBase: Omit<AiSessionDomainEventBase, "kind"> = {
    origin: "live",
    parentSessionId: null,
    runtimeId: "codex",
    runtimeSessionId: "runtime-1",
    sessionId: SESSION_ID,
    updatedAt: "2026-07-18T00:01:01.000Z",
};

describe("AiLiveTranscriptTailStore", () => {
    it("patches only the active tail while retaining 100k sealed entries as metadata", () => {
        const store = new AiLiveTranscriptTailStore();
        const stableBlocks = createStableBlocks(100_000);
        store.setStableBlocks(SESSION_ID, stableBlocks);
        store.applyEvent(messageStarted("assistant-1", "", TURN_STARTED_AT));

        const before = store.getSnapshot(SESSION_ID);
        const first = store.applyEvent(
            messageDelta("assistant-1", "streamed", "streamed"),
        );
        const replayed = store.applyEvent(
            messageDelta("assistant-1", "streamed", "streamed"),
        );

        expect(first.stableBlocks).toBe(before?.stableBlocks);
        expect(first.stableBlocks.reduce((sum, block) => sum + block.entryCount, 0)).toBe(
            100_000,
        );
        expect(first.entries).toHaveLength(1);
        expect(first.entries[0]?.envelope.sequence).toBe(100_001);
        expect(replayed.revision).toBe(first.revision);
        expect(replayed.entries).toHaveLength(1);
    });

    it("reconciles out-of-order events and makes exact replay idempotent", () => {
        const store = new AiLiveTranscriptTailStore();
        const delta = messageDelta(
            "assistant-1",
            "complete content",
            "complete content",
            "2026-07-18T00:01:02.000Z",
        );
        store.applyEvent(delta);
        store.applyEvent(
            messageStarted(
                "assistant-1",
                "",
                TURN_STARTED_AT,
                "2026-07-18T00:01:00.500Z",
            ),
        );
        store.applyEvent({
            ...eventBase,
            kind: "message-completed",
            messageId: "assistant-1",
            messageKind: "assistant",
            updatedAt: "2026-07-18T00:01:03.000Z",
        });
        const completed = store.getSnapshot(SESSION_ID);
        const replayed = store.applyEvent(delta);

        expect(completed?.entries[0]?.envelope.createdAt).toBe(TURN_STARTED_AT);
        expect(completed?.entries[0]?.envelope.summary).toMatchObject({
            preview: "complete content",
            status: "completed",
        });
        expect(replayed.revision).toBe(completed?.revision);
        expect(replayed.entries[0]?.envelope.summary.status).toBe("completed");
    });

    it("preserves the legacy visible order for messages, thinking and tools", () => {
        const store = new AiLiveTranscriptTailStore();
        store.applyEvent({
            ...eventBase,
            activeTurnStartedAt: TURN_STARTED_AT,
            kind: "status",
            lastError: null,
            status: "streaming",
        });
        store.applyEvent(
            messageStarted(
                "assistant-1",
                "answer",
                "2026-07-18T00:01:03.000Z",
            ),
        );
        store.applyEvent({
            ...eventBase,
            kind: "tool-activity",
            activity: toolActivity("tool-1", "2026-07-18T00:01:02.000Z"),
        });
        store.applyEvent({
            ...eventBase,
            kind: "thinking-started",
            message: message(
                "thinking-1",
                "thinking",
                "analysis",
                "2026-07-18T00:01:01.000Z",
            ),
        });

        expect(
            store
                .getSnapshot(SESSION_ID)
                ?.entries.filter(
                    (entry) => entry.envelope.kind !== "status",
                )
                .map((entry) => entry.envelope.id),
        ).toEqual([
            "message:thinking-1",
            "tool:session-1:tool-1",
            "message:assistant-1",
        ]);
    });

    it("derives a legacy snapshot only when requested", () => {
        const store = new AiLiveTranscriptTailStore();
        const snapshot = sessionSnapshot({
            messages: [
                message(
                    "sealed-1",
                    "assistant",
                    "sealed",
                    "2026-07-18T00:00:00.000Z",
                    "completed",
                ),
                message(
                    "assistant-1",
                    "assistant",
                    "stale",
                    TURN_STARTED_AT,
                ),
            ],
        });
        store.synchronizeSnapshot(snapshot);
        store.applyEvent(
            messageDelta(
                "assistant-1",
                "fresh live content",
                "fresh live content",
            ),
        );

        const projected = store.projectLegacySnapshot(snapshot);

        expect(snapshot.messages[1]?.content).toBe("stale");
        expect(projected.messages.map((entry) => entry.content)).toEqual([
            "sealed",
            "fresh live content",
        ]);
    });

    it("coalesces pending writes without acknowledging a newer patch", () => {
        const store = new AiLiveTranscriptTailStore();
        store.applyEvent(messageStarted("assistant-1", "", TURN_STARTED_AT));
        store.applyEvent(messageDelta("assistant-1", "one", "one"));
        const firstBatch = store.takePendingEntries(SESSION_ID);

        store.applyEvent(
            messageDelta(
                "assistant-1",
                "one two",
                " two",
                "2026-07-18T00:01:03.000Z",
            ),
        );
        store.acknowledgePendingEntries(SESSION_ID, firstBatch);
        const nextBatch = store.takePendingEntries(SESSION_ID);

        expect(firstBatch).toHaveLength(1);
        expect(nextBatch).toHaveLength(1);
        expect(nextBatch[0]?.envelope.summary.preview).toBe("one two");
        expect(nextBatch[0]?.entryRevision).toBeGreaterThan(
            firstBatch[0]?.entryRevision ?? 0,
        );
    });

    it("appends a delta when the runtime snapshot is stale", () => {
        const store = new AiLiveTranscriptTailStore();
        store.applyEvent(messageStarted("assistant-1", "", TURN_STARTED_AT));
        store.applyEvent(messageDelta("assistant-1", "one", "one"));
        store.applyEvent(
            messageDelta(
                "assistant-1",
                "one",
                " two",
                "2026-07-18T00:01:03.000Z",
            ),
        );

        expect(
            store.getSnapshot(SESSION_ID)?.entries[0]?.envelope.summary.preview,
        ).toBe("one two");
    });

    it("replaces content when a snapshot revises an equal-length prefix", () => {
        const store = new AiLiveTranscriptTailStore();
        store.applyEvent(messageStarted("assistant-1", "abc", TURN_STARTED_AT));
        store.applyEvent(
            messageDelta(
                "assistant-1",
                "abd",
                "abd",
                "2026-07-18T00:01:03.000Z",
            ),
        );

        expect(
            store.getSnapshot(SESSION_ID)?.entries[0]?.envelope.summary.preview,
        ).toBe("abd");
    });

    it("keeps payload lookup scoped to the owning session", () => {
        const store = new AiLiveTranscriptTailStore();
        store.applyEvent(messageStarted("assistant-1", "answer", TURN_STARTED_AT));
        const payloadRef = store.getSnapshot(SESSION_ID)?.entries[0]?.envelope.payloadRef;

        expect(payloadRef).toBeTruthy();
        expect(store.getPayload(SESSION_ID, payloadRef ?? "")).toMatchObject({
            kind: "message",
        });
        expect(store.getPayload("session-2", payloadRef ?? "")).toBeNull();
    });

    it("adds newly sealed blocks without dropping older stable metadata", () => {
        const store = new AiLiveTranscriptTailStore();
        const previousBlocks = createStableBlocks(256);
        store.setStableBlocks(SESSION_ID, previousBlocks);
        store.applyEvent(messageStarted("assistant-1", "answer", TURN_STARTED_AT));
        const tail = store.getSnapshot(SESSION_ID);
        const nextBlock = {
            ...previousBlocks[0],
            blockId: `${SESSION_ID}:1`,
            endSequence: 257,
            entryCount: 1,
            startSequence: 257,
        };

        expect(
            store.acknowledgeSealedTurn(
                SESSION_ID,
                TURN_STARTED_AT,
                [nextBlock],
                tail?.revision ?? 0,
            ),
        ).toBe(true);
        expect(
            store.getSnapshot(SESSION_ID)?.stableBlocks.map((block) => block.blockId),
        ).toEqual([`${SESSION_ID}:0`, `${SESSION_ID}:1`]);
    });

    it("scopes status and plan persistence identities to consecutive turns", () => {
        const store = new AiLiveTranscriptTailStore();
        store.applyEvent({
            ...eventBase,
            activeTurnStartedAt: TURN_STARTED_AT,
            kind: "status",
            lastError: null,
            status: "streaming",
        });
        store.applyEvent({
            ...eventBase,
            kind: "plan",
            plan: {
                entries: [
                    {
                        content: "Complete the first turn",
                        priority: "medium",
                        status: "in_progress",
                    },
                ],
                title: "First turn",
                updatedAt: "2026-07-18T00:01:02.000Z",
            },
        });
        const firstTurn = store.getSnapshot(SESSION_ID);
        const firstStatus = firstTurn?.entries.find(
            (entry) => entry.envelope.kind === "status",
        );
        const firstPlan = firstTurn?.entries.find(
            (entry) => entry.envelope.kind === "plan",
        );

        expect(
            store.acknowledgeSealedTurn(
                SESSION_ID,
                TURN_STARTED_AT,
                createStableBlocks(2),
                firstTurn?.revision ?? 0,
            ),
        ).toBe(true);

        const secondTurnStartedAt = "2026-07-18T00:02:00.000Z";
        store.applyEvent({
            ...eventBase,
            activeTurnStartedAt: secondTurnStartedAt,
            kind: "status",
            lastError: null,
            status: "streaming",
            updatedAt: "2026-07-18T00:02:01.000Z",
        });
        store.applyEvent({
            ...eventBase,
            kind: "plan",
            plan: {
                entries: [
                    {
                        content: "Complete the second turn",
                        priority: "medium",
                        status: "in_progress",
                    },
                ],
                title: "Second turn",
                updatedAt: "2026-07-18T00:02:02.000Z",
            },
            updatedAt: "2026-07-18T00:02:02.000Z",
        });
        const secondTurn = store.getSnapshot(SESSION_ID);
        const secondStatus = secondTurn?.entries.find(
            (entry) => entry.envelope.kind === "status",
        );
        const secondPlan = secondTurn?.entries.find(
            (entry) => entry.envelope.kind === "plan",
        );

        expect(firstStatus).toBeDefined();
        expect(firstPlan).toBeDefined();
        expect(secondStatus).toBeDefined();
        expect(secondPlan).toBeDefined();
        expect(secondStatus?.envelope.id).not.toBe(firstStatus?.envelope.id);
        expect(secondStatus?.envelope.payloadRef).not.toBe(
            firstStatus?.envelope.payloadRef,
        );
        expect(secondPlan?.envelope.id).not.toBe(firstPlan?.envelope.id);
        expect(secondPlan?.envelope.payloadRef).not.toBe(
            firstPlan?.envelope.payloadRef,
        );
    });
});

function messageStarted(
    id: string,
    content: string,
    createdAt: string,
    updatedAt = "2026-07-18T00:01:01.000Z",
) {
    return {
        ...eventBase,
        kind: "message-started" as const,
        message: message(id, "assistant", content, createdAt),
        messageKind: "assistant" as const,
        updatedAt,
    };
}

function messageDelta(
    id: string,
    content: string,
    delta: string,
    updatedAt = "2026-07-18T00:01:02.000Z",
) {
    return {
        ...eventBase,
        content,
        delta,
        kind: "message-delta" as const,
        messageId: id,
        messageKind: "assistant" as const,
        updatedAt,
    };
}

function message(
    id: string,
    kind: AiMessage["kind"],
    content: string,
    createdAt: string,
    status: AiMessage["status"] = "streaming",
): AiMessage {
    return {
        attachments: [],
        content,
        createdAt,
        id,
        kind,
        status,
    };
}

function toolActivity(id: string, createdAt: string): AiToolActivity {
    return {
        createdAt,
        diffs: [],
        exitCode: null,
        id,
        kind: "shell",
        locations: [],
        rawInputJson: null,
        rawOutputJson: null,
        sessionId: SESSION_ID,
        status: "in_progress",
        summary: "Running command",
        terminalOutput: null,
        title: "Shell",
        updatedAt: createdAt,
    };
}

function sessionSnapshot(
    overrides: Partial<AiSessionSnapshot> = {},
): AiSessionSnapshot {
    return {
        ...createEmptyAiSessionSnapshot({
            projectId: "project-1",
            runtimeId: "codex",
            sessionId: SESSION_ID,
            status: "streaming",
            title: "Chat",
            updatedAt: "2026-07-18T00:01:01.000Z",
        }),
        activeTurnStartedAt: TURN_STARTED_AT,
        ...overrides,
    };
}

function createStableBlocks(entryCount: number): AiTranscriptBlockMetadata[] {
    const blocks: AiTranscriptBlockMetadata[] = [];
    let startSequence = 1;
    let ordinal = 0;
    while (startSequence <= entryCount) {
        const endSequence = Math.min(startSequence + 255, entryCount);
        blocks.push({
            blockId: `${SESSION_ID}:${ordinal}`,
            endSequence,
            entryCount: endSequence - startSequence + 1,
            estimatedHeight: (endSequence - startSequence + 1) * 48,
            estimatedRowCount: endSequence - startSequence + 1,
            firstCreatedAt: "2026-07-17T00:00:00.000Z",
            lastCreatedAt: "2026-07-17T23:59:59.000Z",
            revision: 1,
            sessionId: SESSION_ID,
            startSequence,
        });
        startSequence = endSequence + 1;
        ordinal += 1;
    }
    return blocks;
}
