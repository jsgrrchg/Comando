import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    AiFileContextAttachment,
    AiImageAttachment,
    AiSessionSnapshot,
    WorkspaceChatTab,
} from "@shared/ipc";

import { DEFAULT_AI_DIFF_ZOOM } from "@renderer/app/ai/sessionReviewContracts";
import { useAiStore } from "./ai-store";

const TAB: WorkspaceChatTab = {
    createdAt: "2026-04-14T00:00:00.000Z",
    draft: "",
    id: "tab-1",
    kind: "chat",
    projectId: "project-1",
    runtimeId: "codex",
    sessionId: "session-1",
    title: "Chat",
    worktreeId: null,
};

function createSnapshot(
    overrides: Partial<AiSessionSnapshot> = {},
): AiSessionSnapshot {
    return {
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
        projectId: TAB.projectId,
        runtimeId: TAB.runtimeId,
        runtimeSessionId: "runtime-session-1",
        sessionId: TAB.sessionId,
        status: "idle",
        title: TAB.title,
        toolActivity: [],
        trackedFiles: [],
        updatedAt: "2026-04-14T00:00:00.000Z",
        worktreeId: TAB.worktreeId ?? null,
        ...overrides,
    };
}

function createImageAttachment(
    overrides: Partial<AiImageAttachment> = {},
): AiImageAttachment {
    return {
        dataBase64: "ZmFrZQ==",
        id: "img-1",
        mimeType: "image/png",
        name: "mock.png",
        sizeBytes: 128,
        ...overrides,
    };
}

function createFileContext(
    overrides: Partial<AiFileContextAttachment> = {},
): AiFileContextAttachment {
    return {
        extension: "ts",
        id: "ctx-1",
        languageId: "typescript",
        name: "app.ts",
        projectId: TAB.projectId ?? "project-1",
        relativePath: "src/app.ts",
        ...overrides,
    };
}

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });

    return { promise, resolve };
}

describe("ai-store queue", () => {
    beforeEach(() => {
        useAiStore.setState((state) => ({
            ...state,
            runtimeStatusById: {},
            sessions: {},
        }));
        vi.restoreAllMocks();
    });

    it("requeues the prompt when main still reports the session as busy", async () => {
        const sendAiPrompt = vi
            .fn()
            .mockRejectedValueOnce(new Error("The session is still busy."))
            .mockResolvedValueOnce(undefined);

        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    sendAiPrompt,
                },
            },
            writable: true,
        });

        useAiStore.getState().registerSessionTab(TAB);
        useAiStore.getState().applySessionSnapshot(createSnapshot());

        await useAiStore.getState().sendPrompt(TAB, "hello");

        const deferredSession = useAiStore.getState().sessions[TAB.sessionId];
        expect(sendAiPrompt).toHaveBeenCalledTimes(1);
        expect(deferredSession?.localError).toBeNull();
        expect(deferredSession?.queue).toHaveLength(1);
        expect(deferredSession?.queue[0]?.prompt).toBe("hello");
        expect(deferredSession?.queue[0]?.status).toBe("queued");
        expect(deferredSession?.snapshot?.status).toBe("starting");

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                updatedAt: "2026-04-14T00:00:01.000Z",
            }),
        );

        await vi.waitFor(() => {
            expect(sendAiPrompt).toHaveBeenCalledTimes(2);
        });
        await vi.waitFor(() => {
            const drainedSession =
                useAiStore.getState().sessions[TAB.sessionId];
            expect(drainedSession?.queue).toHaveLength(0);
            expect(drainedSession?.localError).toBeNull();
        });
    });

    it("removes queued prompts from the queue while they are dispatching", async () => {
        const deferredDispatch = createDeferred<void>();
        const sendAiPrompt = vi
            .fn()
            .mockRejectedValueOnce(new Error("The session is still busy."))
            .mockImplementationOnce(() => deferredDispatch.promise);

        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    sendAiPrompt,
                },
            },
            writable: true,
        });

        useAiStore.getState().registerSessionTab(TAB);
        useAiStore.getState().applySessionSnapshot(createSnapshot());

        await useAiStore.getState().sendPrompt(TAB, "hello");

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                updatedAt: "2026-04-14T00:00:01.000Z",
            }),
        );

        await vi.waitFor(() => {
            expect(sendAiPrompt).toHaveBeenCalledTimes(2);
        });
        await vi.waitFor(() => {
            const drainingSession =
                useAiStore.getState().sessions[TAB.sessionId];
            expect(drainingSession?.isDispatching).toBe(true);
            expect(drainingSession?.queue).toHaveLength(0);
        });

        deferredDispatch.resolve(undefined);

        await vi.waitFor(() => {
            const drainedSession =
                useAiStore.getState().sessions[TAB.sessionId];
            expect(drainedSession?.isDispatching).toBe(false);
            expect(drainedSession?.queue).toHaveLength(0);
        });
    });

    it("stores complete composer snapshots in queue and allows restoring them", async () => {
        const sendAiPrompt = vi
            .fn()
            .mockRejectedValueOnce(new Error("The session is still busy."));

        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    sendAiPrompt,
                },
            },
            writable: true,
        });

        useAiStore.getState().registerSessionTab(TAB);
        useAiStore.getState().applySessionSnapshot(createSnapshot());

        const attachment = createImageAttachment();
        const fileContext = createFileContext();

        await useAiStore.getState().sendPrompt(TAB, "hello", {
            attachments: [attachment],
            composerPartsSnapshot: [
                { text: "hello ", type: "text" },
                {
                    label: "app.ts",
                    languageId: "typescript",
                    path: "/tmp/project/src/app.ts",
                    relativePath: "src/app.ts",
                    type: "file_mention",
                },
            ],
            fileContextsSnapshot: [fileContext],
        });

        const queuedPrompt =
            useAiStore.getState().sessions[TAB.sessionId]?.queue[0];
        expect(queuedPrompt?.attachments).toEqual([attachment]);
        expect(queuedPrompt?.composerPartsSnapshot).toHaveLength(2);
        expect(queuedPrompt?.fileContextsSnapshot).toEqual([fileContext]);

        const restoredParts = useAiStore
            .getState()
            .editQueuedPrompt(TAB.sessionId, queuedPrompt?.id ?? "");

        const restoredSession = useAiStore.getState().sessions[TAB.sessionId];
        expect(restoredParts).toEqual(queuedPrompt?.composerPartsSnapshot);
        expect(restoredSession?.draftAttachments).toEqual([attachment]);
        expect(restoredSession?.draftFileContexts).toEqual([fileContext]);
        expect(restoredSession?.queue).toHaveLength(0);
        expect(restoredSession?.editingQueuedPrompt?.id).toBe(queuedPrompt?.id);
    });

    it("restores previous draft when canceling a queued prompt edit", async () => {
        const sendAiPrompt = vi
            .fn()
            .mockRejectedValueOnce(new Error("The session is still busy."));

        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    sendAiPrompt,
                },
            },
            writable: true,
        });

        useAiStore.getState().registerSessionTab(TAB);
        useAiStore.getState().applySessionSnapshot(createSnapshot());

        const previousAttachment = createImageAttachment({
            id: "img-prev",
            name: "previous.png",
        });
        const previousFileContext = createFileContext({
            id: "ctx-prev",
            relativePath: "src/previous.ts",
        });
        const previousComposerParts = [
            { text: "previous draft", type: "text" as const },
        ];

        await useAiStore.getState().sendPrompt(TAB, "hello", {
            attachments: [createImageAttachment()],
            composerPartsSnapshot: [{ text: "hello", type: "text" }],
            fileContextsSnapshot: [createFileContext()],
        });

        const queuedPrompt =
            useAiStore.getState().sessions[TAB.sessionId]?.queue[0];
        useAiStore
            .getState()
            .setDraftAttachments(TAB.sessionId, [previousAttachment]);
        useAiStore
            .getState()
            .addDraftFileContext(TAB.sessionId, previousFileContext);
        useAiStore
            .getState()
            .editQueuedPrompt(
                TAB.sessionId,
                queuedPrompt?.id ?? "",
                previousComposerParts,
            );

        const restoredParts = useAiStore
            .getState()
            .cancelQueuedPromptEdit(TAB.sessionId);

        const restoredSession = useAiStore.getState().sessions[TAB.sessionId];
        expect(restoredParts).toEqual(previousComposerParts);
        expect(restoredSession?.editingQueuedPrompt).toBeNull();
        expect(restoredSession?.draftAttachments).toEqual([previousAttachment]);
        expect(restoredSession?.draftFileContexts).toEqual([
            previousFileContext,
        ]);
        expect(restoredSession?.queue).toHaveLength(1);
        expect(restoredSession?.queue[0]?.id).toBe(queuedPrompt?.id);
    });

    it("preserves id and original position when saving an edited queued prompt", async () => {
        const sendAiPrompt = vi.fn();

        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    sendAiPrompt,
                },
            },
            writable: true,
        });

        useAiStore.getState().registerSessionTab(TAB);
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                status: "starting",
            }),
        );

        await useAiStore.getState().sendPrompt(TAB, "first", {
            composerPartsSnapshot: [{ text: "first", type: "text" }],
        });
        await useAiStore.getState().sendPrompt(TAB, "second", {
            composerPartsSnapshot: [{ text: "second", type: "text" }],
        });

        const queuedSession = useAiStore.getState().sessions[TAB.sessionId];
        const firstPrompt = queuedSession?.queue[0];
        const secondPrompt = queuedSession?.queue[1];

        useAiStore
            .getState()
            .editQueuedPrompt(TAB.sessionId, secondPrompt?.id ?? "", [
                { text: "local draft", type: "text" },
            ]);

        await useAiStore.getState().sendPrompt(TAB, "second edited", {
            composerPartsSnapshot: [{ text: "second edited", type: "text" }],
        });

        const nextSession = useAiStore.getState().sessions[TAB.sessionId];
        expect(sendAiPrompt).not.toHaveBeenCalled();
        expect(nextSession?.editingQueuedPrompt).toBeNull();
        expect(nextSession?.queue.map((item) => item.id)).toEqual([
            firstPrompt?.id,
            secondPrompt?.id,
        ]);
        expect(nextSession?.queue[1]?.prompt).toBe("second edited");
        expect(nextSession?.queue[1]?.createdAt).toBe(secondPrompt?.createdAt);
    });

    it("allows clearing the full queue even if a message is being edited", async () => {
        const sendAiPrompt = vi
            .fn()
            .mockRejectedValueOnce(new Error("The session is still busy."));

        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    sendAiPrompt,
                },
            },
            writable: true,
        });

        useAiStore.getState().registerSessionTab(TAB);
        useAiStore.getState().applySessionSnapshot(createSnapshot());

        await useAiStore.getState().sendPrompt(TAB, "hello");

        const queuedPrompt =
            useAiStore.getState().sessions[TAB.sessionId]?.queue[0];
        useAiStore
            .getState()
            .editQueuedPrompt(TAB.sessionId, queuedPrompt?.id ?? "");

        useAiStore.getState().clearQueuedPrompts(TAB.sessionId);

        const sessionAfterClear = useAiStore.getState().sessions[TAB.sessionId];
        expect(sessionAfterClear?.editingQueuedPrompt).toBeNull();
        expect(sessionAfterClear?.queue).toEqual([]);
    });

    it("marks queued prompts as failed when automatic dispatch fails", async () => {
        const sendAiPrompt = vi
            .fn()
            .mockRejectedValueOnce(new Error("The session is still busy."))
            .mockRejectedValueOnce(new Error("Boom"));

        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    sendAiPrompt,
                },
            },
            writable: true,
        });

        useAiStore.getState().registerSessionTab(TAB);
        useAiStore.getState().applySessionSnapshot(createSnapshot());

        await useAiStore.getState().sendPrompt(TAB, "hello");

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                updatedAt: "2026-04-14T00:00:01.000Z",
            }),
        );

        await vi.waitFor(() => {
            expect(sendAiPrompt).toHaveBeenCalledTimes(2);
        });
        await vi.waitFor(() => {
            const failedQueuedPrompt =
                useAiStore.getState().sessions[TAB.sessionId]?.queue[0];
            expect(failedQueuedPrompt?.status).toBe("failed");
        });
    });

    it("keeps failed and pending queued prompts visible after a rapid-send failure", async () => {
        const firstDispatch = createDeferred<void>();
        const sendAiPrompt = vi
            .fn()
            .mockImplementationOnce(() => firstDispatch.promise)
            .mockRejectedValueOnce(new Error("Boom"));

        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    sendAiPrompt,
                },
            },
            writable: true,
        });

        useAiStore.getState().registerSessionTab(TAB);
        useAiStore.getState().applySessionSnapshot(createSnapshot());

        const firstSendPromise = useAiStore.getState().sendPrompt(TAB, "first");

        await vi.waitFor(() => {
            const activeSession = useAiStore.getState().sessions[TAB.sessionId];
            expect(activeSession?.isDispatching).toBe(true);
        });

        await useAiStore.getState().sendPrompt(TAB, "second");
        await useAiStore.getState().sendPrompt(TAB, "third");

        expect(
            useAiStore
                .getState()
                .sessions[TAB.sessionId]?.queue.map((item) => item.prompt),
        ).toEqual(["second", "third"]);

        firstDispatch.resolve(undefined);
        await firstSendPromise;

        await vi.waitFor(() => {
            expect(sendAiPrompt).toHaveBeenCalledTimes(2);
        });
        await vi.waitFor(() => {
            const queuedSession = useAiStore.getState().sessions[TAB.sessionId];
            expect(
                queuedSession?.queue.map((item) => ({
                    prompt: item.prompt,
                    status: item.status,
                })),
            ).toEqual([
                { prompt: "second", status: "failed" },
                { prompt: "third", status: "queued" },
            ]);
            expect(queuedSession?.isDispatching).toBe(false);
        });
    });

    it("allows retrying a failed queued prompt with sendQueuedPromptNow", async () => {
        const sendAiPrompt = vi
            .fn()
            .mockRejectedValueOnce(new Error("The session is still busy."))
            .mockRejectedValueOnce(new Error("Boom"))
            .mockResolvedValueOnce(undefined);

        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    sendAiPrompt,
                },
            },
            writable: true,
        });

        useAiStore.getState().registerSessionTab(TAB);
        useAiStore.getState().applySessionSnapshot(createSnapshot());

        await useAiStore.getState().sendPrompt(TAB, "hello");

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                updatedAt: "2026-04-14T00:00:01.000Z",
            }),
        );

        await vi.waitFor(() => {
            const failedQueuedPrompt =
                useAiStore.getState().sessions[TAB.sessionId]?.queue[0];
            expect(failedQueuedPrompt?.status).toBe("failed");
        });

        const failedQueuedPrompt =
            useAiStore.getState().sessions[TAB.sessionId]?.queue[0];

        await useAiStore
            .getState()
            .sendQueuedPromptNow(TAB.sessionId, failedQueuedPrompt?.id ?? "");

        await vi.waitFor(() => {
            expect(sendAiPrompt).toHaveBeenCalledTimes(3);
        });
        await vi.waitFor(() => {
            const drainedSession =
                useAiStore.getState().sessions[TAB.sessionId];
            expect(drainedSession?.queue).toHaveLength(0);
        });
    });

    it("stores session-shared diff zoom in the store", () => {
        useAiStore.getState().registerSessionTab(TAB);

        expect(useAiStore.getState().sessions[TAB.sessionId]?.diffZoom).toBe(
            DEFAULT_AI_DIFF_ZOOM,
        );

        useAiStore.getState().setSessionDiffZoom(TAB.sessionId, 0.823);

        expect(useAiStore.getState().sessions[TAB.sessionId]?.diffZoom).toBe(
            0.82,
        );
    });

    it("allows full context and line fragments from same file without duplicating the same range", () => {
        useAiStore.getState().registerSessionTab(TAB);

        const fullFileContext = createFileContext();
        const lineFragmentContext = createFileContext({
            endLine: 18,
            id: "ctx-2",
            selectedText: "const value = 1;",
            startLine: 12,
        });
        const duplicateLineFragmentContext = createFileContext({
            endLine: 18,
            id: "ctx-3",
            selectedText: "const value = 1;",
            startLine: 12,
        });

        useAiStore
            .getState()
            .addDraftFileContext(TAB.sessionId, fullFileContext);
        useAiStore
            .getState()
            .addDraftFileContext(TAB.sessionId, lineFragmentContext);
        useAiStore
            .getState()
            .addDraftFileContext(TAB.sessionId, duplicateLineFragmentContext);

        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.draftFileContexts,
        ).toEqual([fullFileContext, lineFragmentContext]);
    });

    it("inserts editor selection as selection_mention and avoids duplicates", () => {
        useAiStore.getState().registerSessionTab(TAB);

        useAiStore.getState().attachSelectionMention(TAB.sessionId, {
            endLine: 18,
            path: "src/app.ts",
            selectedText: "const value = 1;",
            startLine: 12,
        });
        useAiStore.getState().attachSelectionMention(TAB.sessionId, {
            endLine: 18,
            path: "src/app.ts",
            selectedText: "const value = 1;",
            startLine: 12,
        });

        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.draftComposerParts,
        ).toEqual([
            { type: "text", text: "" },
            {
                type: "selection_mention",
                endLine: 18,
                label: "(12:18) const value = 1;",
                path: "src/app.ts",
                selectedText: "const value = 1;",
                startLine: 12,
            },
            { type: "text", text: " " },
        ]);
    });
});
