import { describe, expect, it, vi } from "vitest";

import type {
    AiMessage,
    AiOpenTranscriptTail,
    AiSessionDomainEventBase,
    AiSessionSnapshot,
    AiTranscriptBlockMetadata,
} from "@shared/ipc";

import { AiLiveTranscriptTailStore } from "./live-transcript";
import {
    AiTranscriptPersistenceCoordinator,
    type AiTranscriptPersistenceAdapter,
} from "./transcript-persistence";

type CheckpointInput = Parameters<
    AiTranscriptPersistenceAdapter["checkpoint"]
>[0];
type SealInput = Parameters<AiTranscriptPersistenceAdapter["seal"]>[0];

const SESSION_ID = "session-1";
const TURN_ID = "2026-07-18T00:01:00.000Z";
const eventBase: Omit<AiSessionDomainEventBase, "kind"> = {
    origin: "live",
    parentSessionId: null,
    runtimeId: "codex",
    runtimeSessionId: "runtime-1",
    sessionId: SESSION_ID,
    updatedAt: "2026-07-18T00:01:01.000Z",
};

describe("AiTranscriptPersistenceCoordinator", () => {
    it("coalesces streaming deltas until the durable byte budget is reached", async () => {
        const store = liveStore();
        const checkpoint = vi.fn((input: CheckpointInput) => {
            void input;
            return Promise.resolve();
        });
        const coordinator = new AiTranscriptPersistenceCoordinator(
            store,
            adapterStub({ checkpoint }),
            () => undefined,
            { checkpointByteBudget: 10, checkpointMaxDelayMs: 60_000 },
        );

        store.applyEvent(messageStarted(""));
        coordinator.scheduleCheckpoint(SESSION_ID);
        await expect(coordinator.waitForIdle(SESSION_ID)).resolves.toBeUndefined();
        expect(checkpoint).toHaveBeenCalledTimes(1);

        store.applyEvent(messageDelta("four", "four"));
        coordinator.scheduleCheckpoint(SESSION_ID, 4);
        store.applyEvent(messageDelta("eight", "eight"));
        coordinator.scheduleCheckpoint(SESSION_ID, 4);
        await Promise.resolve();
        expect(checkpoint).toHaveBeenCalledTimes(1);

        store.applyEvent(messageDelta("twelve", "twelve"));
        coordinator.scheduleCheckpoint(SESSION_ID, 4);
        await expect(coordinator.waitForIdle(SESSION_ID)).resolves.toBeUndefined();
        expect(checkpoint).toHaveBeenCalledTimes(2);
        expect(checkpoint.mock.calls[1]?.[0]?.payloads[0]?.value).toMatchObject({
            message: { content: "twelve" },
        });
    });

    it("keeps streaming visible while an ordered checkpoint is in flight", async () => {
        const store = liveStore();
        const firstWrite = deferred<void>();
        const checkpoints: CheckpointInput[] = [];
        const checkpoint = vi.fn(async (input: CheckpointInput) => {
            checkpoints.push(input);
            if (checkpoints.length === 1) {
                await firstWrite.promise;
            }
        });
        const adapter = adapterStub({
            checkpoint,
        });
        const coordinator = new AiTranscriptPersistenceCoordinator(store, adapter);

        store.applyEvent(messageStarted(""));
        coordinator.scheduleCheckpoint(SESSION_ID);
        await vi.waitFor(() => expect(checkpoints).toHaveLength(1));

        store.applyEvent(messageDelta("complete", "complete"));
        coordinator.scheduleCheckpoint(SESSION_ID);
        expect(store.getSnapshot(SESSION_ID)?.entries[0]?.payload).toMatchObject({
            message: { content: "complete" },
        });

        firstWrite.resolve();
        await expect(coordinator.flushSession(SESSION_ID, 500)).resolves.toBe(true);

        expect(checkpoints).toHaveLength(2);
        expect(checkpoints[0]?.entries[0]?.sequence).toBe(1);
        expect(checkpoints[1]?.entries[0]?.sequence).toBe(1);
        expect(checkpoints[1]?.entries.map((entry) => entry.id)).toEqual([
            "message:assistant-1",
        ]);
        expect(checkpoints[1]?.payloads[0]?.value).toMatchObject({
            message: { content: "complete" },
        });
    });

    it("seals a terminal turn before checkpointing its successor", async () => {
        const store = liveStore();
        const firstCheckpoint = deferred<void>();
        const checkpoints: CheckpointInput[] = [];
        const seals: SealInput[] = [];
        const coordinator = new AiTranscriptPersistenceCoordinator(
            store,
            adapterStub({
                checkpoint: vi.fn(async (input: CheckpointInput) => {
                    checkpoints.push(input);
                    if (checkpoints.length === 1) {
                        await firstCheckpoint.promise;
                    }
                }),
                seal: vi.fn((input: SealInput) => {
                    seals.push(input);
                    return Promise.resolve([]);
                }),
            }),
        );

        store.applyEvent(messageStarted("first answer"));
        store.applyEvent({
            ...eventBase,
            error: null,
            kind: "turn-status",
            status: "completed",
            turnId: "turn-a",
        });
        coordinator.requestSeal(SESSION_ID, "completed");
        await vi.waitFor(() => expect(checkpoints).toHaveLength(1));

        const successorStartedAt = "2026-07-18T00:02:00.000Z";
        store.applyEvent({
            ...eventBase,
            activeTurnStartedAt: successorStartedAt,
            kind: "status",
            lastError: null,
            status: "streaming",
            updatedAt: successorStartedAt,
        });
        store.applyEvent({
            ...eventBase,
            kind: "message-started",
            message: message("assistant-2", "second answer", successorStartedAt),
            messageKind: "assistant",
            updatedAt: successorStartedAt,
        });
        coordinator.scheduleCheckpoint(SESSION_ID);

        firstCheckpoint.resolve();
        await expect(coordinator.flushSession(SESSION_ID, 500)).resolves.toBe(true);

        expect(seals).toHaveLength(1);
        expect(seals[0]).toMatchObject({ turnId: "turn-a" });
        expect(seals[0]?.entries.map((entry) => entry.id)).toEqual([
            "message:assistant-1",
            "status:active-turn:2026-07-18T00:01:00.000Z",
        ]);
        expect(checkpoints.at(-1)?.turnId).toBe(successorStartedAt);
        expect(store.getSnapshot(SESSION_ID)).toMatchObject({
            turnId: successorStartedAt,
        });
    });

    it("retries a transient failure without changing sequences or losing payloads", async () => {
        const store = liveStore();
        const checkpoints: CheckpointInput[] = [];
        const checkpoint = vi.fn((input: CheckpointInput): Promise<void> => {
            checkpoints.push(input);
            return checkpoints.length === 1
                ? Promise.reject(new Error("disk temporarily unavailable"))
                : Promise.resolve();
        });
        const adapter = adapterStub({
            checkpoint,
        });
        const coordinator = new AiTranscriptPersistenceCoordinator(
            store,
            adapter,
            () => undefined,
            { retryBaseDelayMs: 1, retryMaxDelayMs: 2 },
        );

        store.applyEvent(messageStarted("answer"));
        coordinator.scheduleCheckpoint(SESSION_ID);

        await expect(coordinator.flushSession(SESSION_ID, 500)).resolves.toBe(true);
        expect(checkpoints).toHaveLength(2);
        expect(checkpoints[0]?.entries[0]?.id).toBe("message:assistant-1");
        expect(checkpoints[1]?.entries[0]?.id).toBe("message:assistant-1");
        expect(checkpoints[1]?.entries[0]?.sequence).toBe(
            checkpoints[0]?.entries[0]?.sequence,
        );
        expect(checkpoints[1]?.payloads).toEqual(checkpoints[0]?.payloads);
        expect(coordinator.getStatus(SESSION_ID)).toMatchObject({
            attempt: 0,
            lastError: null,
            phase: "idle",
            recoverable: true,
        });
    });

    it("checkpoints only the ordering delta after prior entries are durable", async () => {
        const store = liveStore();
        const checkpoints: CheckpointInput[] = [];
        const coordinator = new AiTranscriptPersistenceCoordinator(
            store,
            adapterStub({
                checkpoint: vi.fn((input: CheckpointInput) => {
                    checkpoints.push(input);
                    return Promise.resolve();
                }),
            }),
        );

        store.applyEvent(messageStarted("first"));
        coordinator.scheduleCheckpoint(SESSION_ID);
        await expect(coordinator.flushSession(SESSION_ID, 500)).resolves.toBe(true);

        store.applyEvent({
            ...eventBase,
            kind: "message-started",
            message: message(
                "assistant-2",
                "second",
                "2026-07-18T00:01:02.000Z",
            ),
            messageKind: "assistant",
            updatedAt: "2026-07-18T00:01:02.000Z",
        });
        coordinator.scheduleCheckpoint(SESSION_ID);
        await expect(coordinator.flushSession(SESSION_ID, 500)).resolves.toBe(true);

        expect(checkpoints).toHaveLength(2);
        expect(checkpoints[1]?.entries.map((entry) => entry.id)).toEqual([
            "message:assistant-2",
        ]);
        expect(checkpoints[1]?.entryOrder).toEqual([
            { entryId: "message:assistant-2", entryRevision: 2, ordinal: 2 },
        ]);
        expect(checkpoints[1]?.removedEntryIds).toEqual([]);
    });

    it("restores an open tail in its persisted order after restart", async () => {
        const store = new AiLiveTranscriptTailStore();
        const recovered = recoveredTail();
        const checkpoint = vi.fn((input: CheckpointInput) => {
            void input;
            return Promise.resolve();
        });
        const adapter = adapterStub({
            checkpoint,
            load: vi.fn(() => Promise.resolve(recovered)),
        });
        const coordinator = new AiTranscriptPersistenceCoordinator(store, adapter);

        await coordinator.recover(SESSION_ID);
        await expect(coordinator.flushSession(SESSION_ID, 500)).resolves.toBe(true);

        const snapshot = store.getSnapshot(SESSION_ID);
        expect(snapshot?.entries.map((entry) => entry.envelope.id)).toEqual([
            "message:first",
            "message:second",
        ]);
        expect(snapshot?.entries.map((entry) => entry.envelope.sequence)).toEqual([
            1, 2,
        ]);
        expect(checkpoint).toHaveBeenCalledOnce();
        expect(checkpoint.mock.calls[0]?.[0].entryOrder).toEqual([
            { entryId: "message:first", entryRevision: 2, ordinal: 0 },
            { entryId: "message:second", entryRevision: 4, ordinal: 1 },
        ]);
    });

    it("preserves live entries received while an open tail is recovering", async () => {
        const store = new AiLiveTranscriptTailStore();
        const load = deferred<AiOpenTranscriptTail | null>();
        const loadOpenTail = vi.fn(() => load.promise);
        const adapter = adapterStub({
            load: loadOpenTail,
        });
        const coordinator = new AiTranscriptPersistenceCoordinator(store, adapter);

        const recovery = coordinator.recover(SESSION_ID);
        await vi.waitFor(() => expect(loadOpenTail).toHaveBeenCalledWith(SESSION_ID));

        store.applyEvent(messageStarted("arrived while recovering"));
        load.resolve(recoveredTail());
        await recovery;

        const entries = store.getSnapshot(SESSION_ID)?.entries ?? [];
        expect(entries.map((entry) => entry.envelope.id)).toEqual(
            expect.arrayContaining([
                "message:assistant-1",
                "message:first",
                "message:second",
            ]),
        );
        expect(
            entries.find(
                (entry) => entry.envelope.id === "message:assistant-1",
            )?.payload,
        ).toMatchObject({
            message: { content: "arrived while recovering" },
        });
    });

    it("seals an interrupted tail recovered without a live runtime", async () => {
        const store = new AiLiveTranscriptTailStore();
        const seal = vi.fn(() => Promise.resolve([sealedMetadata()]));
        const coordinator = new AiTranscriptPersistenceCoordinator(
            store,
            adapterStub({
                load: vi.fn(() => Promise.resolve(recoveredTail())),
                seal,
            }),
        );

        await coordinator.recover(SESSION_ID, { sealInterruptedTail: true });

        expect(seal).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: SESSION_ID,
            turnId: TURN_ID,
        }));
        expect(store.getSnapshot(SESSION_ID)?.stableBlocks).toEqual([
            sealedMetadata(),
        ]);
    });

    it("reconciles a completed recovered tail despite a delayed streaming snapshot", async () => {
        const store = new AiLiveTranscriptTailStore();
        const recovered = {
            ...recoveredTail(),
            terminalStatus: "completed" as const,
        };
        const reconcile = vi.fn(() => Promise.resolve([sealedMetadata()]));
        const coordinator = new AiTranscriptPersistenceCoordinator(
            store,
            adapterStub({
                load: vi.fn(() => Promise.resolve(recovered)),
                reconcile,
            }),
        );

        await coordinator.recover(SESSION_ID);

        expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
            turnId: recovered.turnId,
        }));
        expect(store.getSnapshot(SESSION_ID)).toMatchObject({
            entries: [],
            stableBlocks: [sealedMetadata()],
            turnId: null,
        });
    });

    it("seals a displaced nonterminal tail before checkpointing the newer turn", async () => {
        const store = liveStore();
        store.applyEvent(messageStarted("new turn output"));
        const recovered = {
            ...recoveredTail(),
            turnId: "previous-turn",
        };
        const seal = vi.fn(() => Promise.resolve([sealedMetadata()]));
        const checkpoint = vi.fn((input: CheckpointInput) => {
            void input;
            return Promise.resolve();
        });
        const coordinator = new AiTranscriptPersistenceCoordinator(
            store,
            adapterStub({
                checkpoint,
                load: vi.fn(() => Promise.resolve(recovered)),
                seal,
            }),
        );

        await coordinator.recover(SESSION_ID);
        await expect(coordinator.flushSession(SESSION_ID, 500)).resolves.toBe(true);

        expect(seal).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: SESSION_ID,
            turnId: recovered.turnId,
        }));
        expect(checkpoint).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: SESSION_ID,
            turnId: TURN_ID,
        }));
        expect(store.getSnapshot(SESSION_ID)).toMatchObject({
            stableBlocks: [sealedMetadata()],
            turnId: TURN_ID,
        });
    });

    it("reconciles a completed tail when a streaming snapshot creates a newer turn", async () => {
        const store = new AiLiveTranscriptTailStore();
        const load = deferred<AiOpenTranscriptTail | null>();
        const checkpoint = vi.fn((input: CheckpointInput) => {
            void input;
            return Promise.resolve();
        });
        const reconcile = vi.fn((input: { sessionId: string; turnId: string }) => {
            void input;
            return Promise.resolve([sealedMetadata()]);
        });
        const recovered = {
            ...recoveredTail(),
            terminalStatus: "completed" as const,
            turnId: "2026-07-18T00:00:00.000Z",
        };
        const coordinator = new AiTranscriptPersistenceCoordinator(
            store,
            adapterStub({
                checkpoint,
                load: vi.fn(() => load.promise),
                reconcile,
            }),
        );

        const recovery = coordinator.recover(SESSION_ID);
        store.synchronizeSnapshot(streamingSnapshot(TURN_ID));
        coordinator.scheduleCheckpoint(SESSION_ID);
        await Promise.resolve();
        expect(checkpoint).not.toHaveBeenCalled();

        load.resolve(recovered);
        await recovery;
        await expect(coordinator.flushSession(SESSION_ID, 500)).resolves.toBe(true);

        expect(reconcile).toHaveBeenCalledOnce();
        expect(reconcile).toHaveBeenCalledWith(
            expect.objectContaining({ turnId: recovered.turnId }),
        );
        expect(checkpoint).toHaveBeenCalledWith(
            expect.objectContaining({
                terminalStatus: null,
                turnId: TURN_ID,
            }),
        );
        expect(store.getSnapshot(SESSION_ID)).toMatchObject({
            turnId: TURN_ID,
        });
    });

    it("preserves a terminal seal requested while loading a nonterminal tail", async () => {
        const store = new AiLiveTranscriptTailStore();
        const load = deferred<AiOpenTranscriptTail | null>();
        const checkpoints: CheckpointInput[] = [];
        const seal = vi.fn((input: SealInput) => {
            void input;
            return Promise.resolve([sealedMetadata()]);
        });
        const coordinator = new AiTranscriptPersistenceCoordinator(
            store,
            adapterStub({
                checkpoint: vi.fn((input: CheckpointInput) => {
                    checkpoints.push(input);
                    return Promise.resolve();
                }),
                load: vi.fn(() => load.promise),
                seal,
            }),
        );

        const recovery = coordinator.recover(SESSION_ID);
        store.applyEvent({
            ...eventBase,
            error: null,
            kind: "turn-status",
            status: "completed",
            turnId: TURN_ID,
        });
        coordinator.requestSeal(SESSION_ID, "completed");

        load.resolve(recoveredTail());
        await recovery;
        await expect(coordinator.flushSession(SESSION_ID, 500)).resolves.toBe(true);

        expect(checkpoints).toHaveLength(1);
        expect(checkpoints[0]).toMatchObject({
            terminalStatus: "completed",
            turnId: TURN_ID,
        });
        expect(seal).toHaveBeenCalledOnce();
        expect(seal).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: SESSION_ID,
            turnId: TURN_ID,
        }));
    });

    it("checkpoints terminal state before sealing and clears the live tail", async () => {
        const store = liveStore();
        const metadata = sealedMetadata();
        const checkpoint = vi.fn((input: CheckpointInput) => {
            void input;
            return Promise.resolve();
        });
        const seal = vi.fn((input: SealInput) => {
            void input;
            return Promise.resolve([metadata]);
        });
        const adapter = adapterStub({ checkpoint, seal });
        const coordinator = new AiTranscriptPersistenceCoordinator(store, adapter);
        store.applyEvent(messageStarted("final answer"));

        coordinator.requestSeal(SESSION_ID, "cancelled");
        await expect(coordinator.flushSession(SESSION_ID, 500)).resolves.toBe(true);

        expect(checkpoint).toHaveBeenCalledOnce();
        expect(checkpoint.mock.calls[0]?.[0].terminalStatus).toBe(
            "cancelled",
        );
        expect(seal).toHaveBeenCalledOnce();
        expect(seal.mock.calls[0]?.[0]).toMatchObject({
            sessionId: SESSION_ID,
            turnId: TURN_ID,
        });
        expect(store.getSnapshot(SESSION_ID)).toMatchObject({
            entries: [],
            stableBlocks: [metadata],
            turnId: null,
        });
    });

    it("seals a terminal update after its entries were checkpointed", async () => {
        const store = liveStore();
        const checkpoints: CheckpointInput[] = [];
        const seal = vi.fn((input: SealInput) => {
            void input;
            return Promise.resolve([sealedMetadata()]);
        });
        const coordinator = new AiTranscriptPersistenceCoordinator(
            store,
            adapterStub({
                checkpoint: vi.fn((input: CheckpointInput) => {
                    checkpoints.push(input);
                    return Promise.resolve();
                }),
                seal,
            }),
        );

        store.applyEvent(messageStarted("final answer"));
        coordinator.scheduleCheckpoint(SESSION_ID);
        await expect(coordinator.flushSession(SESSION_ID, 500)).resolves.toBe(true);

        store.applyEvent({
            ...eventBase,
            error: null,
            kind: "turn-status",
            status: "completed",
            turnId: "turn-1",
        });
        coordinator.requestSeal(SESSION_ID, "completed");
        await expect(coordinator.flushSession(SESSION_ID, 500)).resolves.toBe(true);

        expect(checkpoints).toHaveLength(2);
        expect(checkpoints[1]).toMatchObject({
            entries: [],
            entryOrder: [],
            payloads: [],
            terminalStatus: "completed",
            turnId: "turn-1",
        });
        expect(seal).toHaveBeenCalledOnce();
    });

    it("bounds shutdown flush when durable storage does not respond", async () => {
        const store = liveStore();
        const blocked = deferred<void>();
        const adapter = adapterStub({
            checkpoint: vi.fn(async () => await blocked.promise),
        });
        const coordinator = new AiTranscriptPersistenceCoordinator(store, adapter);
        store.applyEvent(messageStarted("answer"));
        coordinator.scheduleCheckpoint(SESSION_ID);

        await expect(coordinator.flushSession(SESSION_ID, 10)).resolves.toBe(false);
        blocked.resolve();
        await expect(coordinator.flushSession(SESSION_ID, 500)).resolves.toBe(true);
    });

    it("keeps waiting for durable idle after a bounded flush times out", async () => {
        const store = liveStore();
        const blocked = deferred<void>();
        const adapter = adapterStub({
            checkpoint: vi.fn(async () => await blocked.promise),
        });
        const coordinator = new AiTranscriptPersistenceCoordinator(store, adapter);
        store.applyEvent(messageStarted("answer"));
        coordinator.scheduleCheckpoint(SESSION_ID);

        await expect(coordinator.flushSession(SESSION_ID, 10)).resolves.toBe(false);
        let idle = false;
        const waitForIdle = coordinator.waitForIdle(SESSION_ID).then(() => {
            idle = true;
        });
        await Promise.resolve();
        expect(idle).toBe(false);

        blocked.resolve();
        await waitForIdle;
        expect(idle).toBe(true);
    });
});

function adapterStub(
    overrides: Partial<AiTranscriptPersistenceAdapter> = {},
): AiTranscriptPersistenceAdapter {
    return {
        checkpoint: vi.fn(() => Promise.resolve()),
        load: vi.fn(() => Promise.resolve(null)),
        reconcile: vi.fn(() => Promise.resolve([])),
        seal: vi.fn(() => Promise.resolve([])),
        ...overrides,
    };
}

function liveStore(): AiLiveTranscriptTailStore {
    const store = new AiLiveTranscriptTailStore();
    store.applyEvent({
        ...eventBase,
        activeTurnStartedAt: TURN_ID,
        kind: "status",
        lastError: null,
        status: "streaming",
    });
    return store;
}

function messageStarted(content: string) {
    return {
        ...eventBase,
        kind: "message-started" as const,
        message: message("assistant-1", content, TURN_ID),
        messageKind: "assistant" as const,
    };
}

function messageDelta(content: string, delta: string) {
    return {
        ...eventBase,
        content,
        delta,
        kind: "message-delta" as const,
        messageId: "assistant-1",
        messageKind: "assistant" as const,
        updatedAt: "2026-07-18T00:01:02.000Z",
    };
}

function message(id: string, content: string, createdAt: string): AiMessage {
    return {
        attachments: [],
        content,
        createdAt,
        id,
        kind: "assistant",
        status: "streaming",
    };
}

function streamingSnapshot(activeTurnStartedAt: string): AiSessionSnapshot {
    return {
        activeTurnStartedAt,
        availableCommands: [],
        configOptions: [],
        lastError: null,
        messages: [message("assistant-1", "new turn output", activeTurnStartedAt)],
        modeId: null,
        modes: [],
        modelId: null,
        models: [],
        pendingPermission: null,
        pendingUserInput: null,
        plan: null,
        projectId: null,
        runtimeId: "codex",
        runtimeSessionId: "runtime-1",
        sessionId: SESSION_ID,
        status: "streaming",
        title: "Streaming recovery",
        tokenUsage: null,
        toolActivity: [],
        trackedFiles: [],
        updatedAt: activeTurnStartedAt,
    };
}

function recoveredTail(): AiOpenTranscriptTail {
    const values = [
        ["message:first", "first", 1],
        ["message:second", "second", 2],
    ] as const;
    return {
        entries: values.map(([id, content, sequence]) => ({
            createdAt: TURN_ID,
            id,
            kind: "message",
            payloadRef: `tail:${id}`,
            sequence,
            sessionId: SESSION_ID,
            summary: { label: "Assistant", preview: content, status: "streaming" },
            updatedAt: eventBase.updatedAt,
        })),
        entryRevisions: [
            { entryId: "message:first", entryRevision: 2, ordinal: 0 },
            { entryId: "message:second", entryRevision: 4, ordinal: 1 },
        ],
        payloads: values.map(([id, content]) => ({
            payloadRef: `tail:${id}`,
            value: { kind: "message", message: message(id.slice(8), content, TURN_ID) },
        })),
        revision: 7,
        sessionId: SESSION_ID,
        terminalStatus: null,
        turnId: TURN_ID,
        updatedAt: eventBase.updatedAt,
    };
}

function sealedMetadata(): AiTranscriptBlockMetadata {
    return {
        blockId: `${SESSION_ID}:0`,
        endSequence: 2,
        entryCount: 2,
        estimatedHeight: 144,
        estimatedRowCount: 2,
        firstCreatedAt: TURN_ID,
        lastCreatedAt: eventBase.updatedAt,
        revision: 2,
        sessionId: SESSION_ID,
        startSequence: 1,
    };
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, reject, resolve };
}
