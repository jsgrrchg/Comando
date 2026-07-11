import { describe, expect, it, vi } from "vitest";

import type {
    AiPromptQueueSnapshot,
    AiSessionSnapshot,
    EnqueueAiPromptInput,
} from "@shared/ipc";

import { AiPromptQueue } from "./prompt-queue";

const SESSION_ID = "session-1";
const OWNER_WINDOW_ID = "window-1";

function createSnapshot(
    overrides: Partial<AiSessionSnapshot> = {},
): AiSessionSnapshot {
    return {
        activeTurnStartedAt: null,
        availableCommands: [],
        closedAt: null,
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
        sessionId: SESSION_ID,
        status: "idle",
        title: "Chat",
        tokenUsage: null,
        toolActivity: [],
        trackedFiles: [],
        updatedAt: "2026-07-09T00:00:00.000Z",
        worktreeId: null,
        ...overrides,
    };
}

function createPrompt(
    messageId: string,
    prompt = messageId,
): EnqueueAiPromptInput {
    return {
        attachments: [],
        composerParts: [{ text: prompt, type: "text" }],
        fileContextsSnapshot: [],
        messageId,
        projectId: "project-1",
        prompt,
        runtimeId: "codex",
        sessionId: SESSION_ID,
        title: "Chat",
        worktreeId: null,
    };
}

function createHarness(options: {
    readonly initialSnapshot?: AiSessionSnapshot;
    readonly restored?: readonly AiPromptQueueSnapshot[];
} = {}) {
    let liveSnapshot = options.initialSnapshot ?? createSnapshot();
    const cancelSession = vi.fn().mockResolvedValue(undefined);
    const dispatchPrompt = vi.fn().mockResolvedValue({ stopReason: "accepted" });
    const onSnapshot = vi.fn();
    const saveSnapshots = vi.fn();
    const queue = new AiPromptQueue({
        cancelSession,
        dispatchPrompt,
        getSessionSnapshot: () => liveSnapshot,
        loadSnapshots: () => options.restored ?? [],
        onSnapshot,
        saveSnapshots,
    });

    return {
        cancelSession,
        dispatchPrompt,
        onSnapshot,
        queue,
        saveSnapshots,
        setLiveSnapshot(snapshot: AiSessionSnapshot) {
            liveSnapshot = snapshot;
        },
    };
}

async function flushDispatch(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

describe("AiPromptQueue", () => {
    it("keeps the active item and the remaining FIFO queue until its correlated turn completes", async () => {
        const harness = createHarness();

        harness.queue.enqueue(createPrompt("turn-1"), OWNER_WINDOW_ID);
        harness.queue.enqueue(createPrompt("turn-2"), OWNER_WINDOW_ID);
        await flushDispatch();

        expect(harness.dispatchPrompt).toHaveBeenCalledTimes(1);
        expect(harness.dispatchPrompt).toHaveBeenCalledWith(
            expect.objectContaining({ messageId: "turn-1" }),
            OWNER_WINDOW_ID,
        );
        expect(harness.queue.getSnapshot(SESSION_ID)).toMatchObject({
            activeItem: { messageId: "turn-1", status: "running" },
            items: [{ messageId: "turn-2", status: "queued" }],
        });

        const duplicateIdleSnapshot = createSnapshot({
            updatedAt: "2026-07-09T00:00:00.500Z",
        });
        harness.setLiveSnapshot(duplicateIdleSnapshot);
        harness.queue.handleSessionSnapshot(duplicateIdleSnapshot);
        harness.queue.handleSessionEvent({
            activeTurnStartedAt: null,
            kind: "status",
            lastError: null,
            origin: "live",
            parentSessionId: null,
            runtimeId: "codex",
            runtimeSessionId: "runtime-session-1",
            sessionId: SESSION_ID,
            status: "idle",
            title: null,
            updatedAt: "2026-07-09T00:00:00.500Z",
        });
        expect(harness.queue.getSnapshot(SESSION_ID)).toMatchObject({
            activeItem: { messageId: "turn-1" },
            items: [{ messageId: "turn-2" }],
        });

        harness.queue.handleSessionEvent({
            error: null,
            kind: "turn-status",
            origin: "live",
            parentSessionId: null,
            runtimeId: "codex",
            runtimeSessionId: "runtime-session-1",
            sessionId: SESSION_ID,
            status: "completed",
            turnId: "some-other-turn",
            updatedAt: "2026-07-09T00:00:01.000Z",
        });
        expect(harness.dispatchPrompt).toHaveBeenCalledTimes(1);

        harness.setLiveSnapshot(createSnapshot());
        harness.queue.handleSessionEvent({
            error: null,
            kind: "turn-status",
            origin: "live",
            parentSessionId: null,
            runtimeId: "codex",
            runtimeSessionId: "runtime-session-1",
            sessionId: SESSION_ID,
            status: "completed",
            turnId: "turn-1",
            updatedAt: "2026-07-09T00:00:02.000Z",
        });
        await flushDispatch();

        expect(harness.dispatchPrompt).toHaveBeenCalledTimes(2);
        expect(harness.queue.getSnapshot(SESSION_ID)).toMatchObject({
            activeItem: { messageId: "turn-2", status: "running" },
            items: [],
        });
    });

    it("does not let a duplicate terminal event clear the next active turn", async () => {
        const harness = createHarness();
        harness.queue.enqueue(createPrompt("turn-1"), OWNER_WINDOW_ID);
        harness.queue.enqueue(createPrompt("turn-2"), OWNER_WINDOW_ID);
        await flushDispatch();

        const completion = {
            error: null,
            kind: "turn-status" as const,
            origin: "live" as const,
            parentSessionId: null,
            runtimeId: "codex" as const,
            runtimeSessionId: "runtime-session-1",
            sessionId: SESSION_ID,
            status: "completed" as const,
            turnId: "turn-1",
            updatedAt: "2026-07-09T00:00:02.000Z",
        };
        harness.queue.handleSessionEvent(completion);
        await flushDispatch();
        harness.queue.handleSessionEvent(completion);

        expect(harness.queue.getSnapshot(SESSION_ID).activeItem?.messageId).toBe(
            "turn-2",
        );
    });

    it("waits while the runtime is busy and drains after an idle snapshot", async () => {
        const harness = createHarness({
            initialSnapshot: createSnapshot({ status: "streaming" }),
        });
        harness.queue.enqueue(createPrompt("turn-1"), OWNER_WINDOW_ID);
        await flushDispatch();

        expect(harness.dispatchPrompt).not.toHaveBeenCalled();
        expect(harness.queue.getSnapshot(SESSION_ID).items).toHaveLength(1);

        const idleSnapshot = createSnapshot({
            updatedAt: "2026-07-09T00:00:01.000Z",
        });
        harness.setLiveSnapshot(idleSnapshot);
        harness.queue.handleSessionSnapshot(idleSnapshot);
        await flushDispatch();

        expect(harness.dispatchPrompt).toHaveBeenCalledTimes(1);
        expect(harness.queue.getSnapshot(SESSION_ID).activeItem?.messageId).toBe(
            "turn-1",
        );
    });

    it("resumes a steered prompt after an external busy turn settles", async () => {
        const harness = createHarness({
            initialSnapshot: createSnapshot({ status: "streaming" }),
        });
        harness.queue.enqueue(createPrompt("turn-1"), OWNER_WINDOW_ID);

        const steeredSnapshot = await harness.queue.steer(
            SESSION_ID,
            "turn-1",
            OWNER_WINDOW_ID,
        );

        expect(harness.cancelSession).toHaveBeenCalledWith(SESSION_ID);
        expect(steeredSnapshot).toMatchObject({
            activeItem: null,
            paused: true,
            items: [{ messageId: "turn-1" }],
        });

        const idleSnapshot = createSnapshot({
            updatedAt: "2026-07-09T00:00:01.000Z",
        });
        harness.setLiveSnapshot(idleSnapshot);
        harness.queue.handleSessionSnapshot(idleSnapshot);
        await flushDispatch();

        expect(harness.dispatchPrompt).toHaveBeenCalledTimes(1);
        expect(harness.queue.getSnapshot(SESSION_ID)).toMatchObject({
            activeItem: { messageId: "turn-1", status: "running" },
            paused: false,
            items: [],
        });
    });

    it("unpauses steering on an external terminal event before the idle snapshot", async () => {
        const harness = createHarness({
            initialSnapshot: createSnapshot({ status: "streaming" }),
        });
        harness.queue.enqueue(createPrompt("turn-1"), OWNER_WINDOW_ID);
        await harness.queue.steer(
            SESSION_ID,
            "turn-1",
            OWNER_WINDOW_ID,
        );

        harness.queue.handleSessionEvent({
            error: null,
            kind: "turn-status",
            origin: "live",
            parentSessionId: null,
            runtimeId: "codex",
            runtimeSessionId: "runtime-session-1",
            sessionId: SESSION_ID,
            status: "cancelled",
            turnId: "external-turn",
            updatedAt: "2026-07-09T00:00:01.000Z",
        });

        expect(harness.queue.getSnapshot(SESSION_ID).paused).toBe(false);
        expect(harness.dispatchPrompt).not.toHaveBeenCalled();

        const idleSnapshot = createSnapshot({
            updatedAt: "2026-07-09T00:00:02.000Z",
        });
        harness.setLiveSnapshot(idleSnapshot);
        harness.queue.handleSessionSnapshot(idleSnapshot);
        await flushDispatch();

        expect(harness.dispatchPrompt).toHaveBeenCalledTimes(1);
    });

    it("keeps a failed turn visible and does not skip ahead automatically", async () => {
        const harness = createHarness();
        harness.queue.enqueue(createPrompt("turn-1"), OWNER_WINDOW_ID);
        harness.queue.enqueue(createPrompt("turn-2"), OWNER_WINDOW_ID);
        await flushDispatch();

        harness.queue.handleSessionEvent({
            error: "Runtime failed",
            kind: "turn-status",
            origin: "live",
            parentSessionId: null,
            runtimeId: "codex",
            runtimeSessionId: "runtime-session-1",
            sessionId: SESSION_ID,
            status: "failed",
            turnId: "turn-1",
            updatedAt: "2026-07-09T00:00:01.000Z",
        });
        await flushDispatch();

        expect(harness.dispatchPrompt).toHaveBeenCalledTimes(1);
        expect(harness.queue.getSnapshot(SESSION_ID)).toMatchObject({
            activeItem: null,
            items: [
                { error: "Runtime failed", messageId: "turn-1", status: "failed" },
                { messageId: "turn-2", status: "queued" },
            ],
        });
    });

    it("terminalizes active and queued prompts when the session closes", async () => {
        const harness = createHarness();
        harness.queue.enqueue(createPrompt("turn-1"), OWNER_WINDOW_ID);
        harness.queue.enqueue(createPrompt("turn-2"), OWNER_WINDOW_ID);
        await flushDispatch();

        harness.queue.handleSessionEvent({
            closedAt: "2026-07-09T00:00:02.000Z",
            kind: "session-closed",
            origin: "live",
            parentSessionId: null,
            runtimeId: "codex",
            runtimeSessionId: "runtime-session-1",
            sessionId: SESSION_ID,
            updatedAt: "2026-07-09T00:00:02.000Z",
        });

        expect(harness.queue.getSnapshot(SESSION_ID)).toMatchObject({
            activeItem: null,
            items: [
                {
                    error: "The session was closed before this prompt could run.",
                    messageId: "turn-1",
                    status: "failed",
                },
                {
                    error: "The session was closed before this prompt could run.",
                    messageId: "turn-2",
                    status: "failed",
                },
            ],
            paused: true,
        });

        const afterBeginEdit = harness.queue.beginEdit(
            SESSION_ID,
            "turn-2",
            OWNER_WINDOW_ID,
        );
        expect(afterBeginEdit.editingItem).toBeNull();
        expect(afterBeginEdit.paused).toBe(true);
        expect(afterBeginEdit.items).toContainEqual(
            expect.objectContaining({
                messageId: "turn-2",
                status: "failed",
            }),
        );
        const afterUpdate = harness.queue.update(
            {
                ...createPrompt("turn-2", "Updated prompt"),
                promptId: "turn-2",
            },
            OWNER_WINDOW_ID,
        );
        expect(afterUpdate.paused).toBe(true);
        expect(afterUpdate.items).toContainEqual(
            expect.objectContaining({
                messageId: "turn-2",
                status: "failed",
            }),
        );
        await harness.queue.steer(SESSION_ID, "turn-2", OWNER_WINDOW_ID);
        expect(harness.cancelSession).not.toHaveBeenCalled();

        expect(harness.queue.clear(SESSION_ID, OWNER_WINDOW_ID)).toMatchObject({
            items: [],
            paused: true,
        });
        harness.queue.enqueue(createPrompt("turn-3"), OWNER_WINDOW_ID);
        await flushDispatch();

        expect(harness.dispatchPrompt).toHaveBeenCalledTimes(1);
        expect(harness.queue.getSnapshot(SESSION_ID).items).toContainEqual(
            expect.objectContaining({
                error: "The session was closed before this prompt could run.",
                messageId: "turn-3",
                status: "failed",
            }),
        );
        expect(harness.saveSnapshots).toHaveBeenCalled();
    });

    it("restores interrupted work as a paused queue", () => {
        const restoredItem = {
            ...createPrompt("turn-1"),
            additionalRoots: undefined,
            composerPartsSnapshot: [{ text: "turn-1", type: "text" as const }],
            createdAt: "2026-07-09T00:00:00.000Z",
            error: null,
            fileContextsSnapshot: [],
            id: "turn-1",
            messageId: "turn-1",
            optimisticMessageId: "turn-1",
            status: "running" as const,
            worktreeId: null,
        };
        const harness = createHarness({
            restored: [
                {
                    activeItem: restoredItem,
                    editingItem: null,
                    items: [],
                    paused: false,
                    revision: 4,
                    sessionId: SESSION_ID,
                },
            ],
        });

        expect(harness.queue.bindSession(SESSION_ID, OWNER_WINDOW_ID)).toMatchObject({
            activeItem: null,
            items: [{ messageId: "turn-1", status: "pending_dispatch" }],
            paused: true,
            revision: 5,
        });
    });

    it("keeps restored prompts terminal when their session was already closed", () => {
        const restoredItem = {
            ...createPrompt("turn-1"),
            additionalRoots: undefined,
            composerPartsSnapshot: [{ text: "turn-1", type: "text" as const }],
            createdAt: "2026-07-09T00:00:00.000Z",
            error: null,
            fileContextsSnapshot: [],
            id: "turn-1",
            messageId: "turn-1",
            optimisticMessageId: "turn-1",
            status: "queued" as const,
            worktreeId: null,
        };
        const harness = createHarness({
            initialSnapshot: createSnapshot({
                closedAt: "2026-07-09T00:00:01.000Z",
            }),
            restored: [
                {
                    activeItem: null,
                    editingItem: null,
                    items: [restoredItem],
                    paused: false,
                    revision: 4,
                    sessionId: SESSION_ID,
                },
            ],
        });

        expect(harness.queue.bindSession(SESSION_ID, OWNER_WINDOW_ID)).toMatchObject({
            activeItem: null,
            items: [
                {
                    error: "The session was closed before this prompt could run.",
                    messageId: "turn-1",
                    status: "failed",
                },
            ],
            paused: true,
        });
    });

    it("reopens a terminal queue when the historical session is prepared again", () => {
        const harness = createHarness({
            initialSnapshot: createSnapshot({
                closedAt: "2026-07-09T00:00:01.000Z",
            }),
        });

        harness.queue.enqueue(createPrompt("closed-turn"), OWNER_WINDOW_ID);
        harness.setLiveSnapshot(
            createSnapshot({
                closedAt: null,
                updatedAt: "2026-07-09T00:00:02.000Z",
            }),
        );
        harness.queue.handleSessionSnapshot(
            createSnapshot({
                closedAt: null,
                updatedAt: "2026-07-09T00:00:02.000Z",
            }),
        );

        harness.queue.enqueue(createPrompt("resumed-turn"), OWNER_WINDOW_ID);

        expect(harness.queue.getSnapshot(SESSION_ID)).toMatchObject({
            items: [],
            paused: false,
        });
        expect(harness.dispatchPrompt).toHaveBeenCalledWith(
            expect.objectContaining({ messageId: "resumed-turn" }),
            OWNER_WINDOW_ID,
        );
    });
});
