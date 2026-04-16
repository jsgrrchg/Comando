import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    AiFileContextAttachment,
    AiImageAttachment,
    AiSessionSnapshot,
    AiSessionUpdate,
    WorkspaceChatTab,
} from "@shared/ipc";

import { getSessionReviewPreferencesStorageKey } from "@renderer/app/ai/sessionReviewPreferences";
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
        const storage = new Map<string, string>();

        vi.stubGlobal("localStorage", {
            clear: () => storage.clear(),
            getItem: (key: string) => storage.get(key) ?? null,
            key: (index: number) => Array.from(storage.keys())[index] ?? null,
            get length() {
                return storage.size;
            },
            removeItem: (key: string) => {
                storage.delete(key);
            },
            setItem: (key: string, value: string) => {
                storage.set(key, value);
            },
        });
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

    it("sends composer parts to main when dispatching immediately", async () => {
        const sendAiPrompt = vi.fn().mockResolvedValueOnce(undefined);

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

        const composerPartsSnapshot = [
            { text: "", type: "text" as const },
            {
                endLine: 88,
                label: "(85:88) - elimina",
                path: ".personal/pruebas/untitled.cpp",
                selectedText: "elimina",
                startLine: 85,
                type: "selection_mention" as const,
            },
            { text: " ", type: "text" as const },
        ];

        await useAiStore
            .getState()
            .sendPrompt(TAB, ".personal/pruebas/untitled.cpp:85-88", {
                composerPartsSnapshot,
            });

        expect(sendAiPrompt).toHaveBeenCalledWith(
            expect.objectContaining({
                composerParts: composerPartsSnapshot,
            }),
        );
    });

    it("stores the dismissed plan revision per session", () => {
        useAiStore.getState().registerSessionTab(TAB);

        useAiStore
            .getState()
            .dismissSessionPlan(TAB.sessionId, "2026-04-15T12:00:00.000Z");

        expect(
            useAiStore.getState().sessions[TAB.sessionId]
                ?.dismissedPlanUpdatedAt,
        ).toBe("2026-04-15T12:00:00.000Z");
    });

    it("merges incremental session patches without replacing the whole snapshot", () => {
        useAiStore.getState().registerSessionTab(TAB);
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                availableCommands: [
                    {
                        description: "Plan",
                        id: "plan",
                        insertText: "/plan ",
                        label: "/plan",
                    },
                ],
                messages: [
                    {
                        attachments: [],
                        content: "hello",
                        createdAt: "2026-04-14T00:00:00.000Z",
                        id: "msg-1",
                        kind: "assistant",
                        status: "completed",
                    },
                ],
            }),
        );

        const update: AiSessionUpdate = {
            kind: "patch",
            patch: {
                changes: {
                    messages: [
                        {
                            attachments: [],
                            content: "hello world",
                            createdAt: "2026-04-14T00:00:00.000Z",
                            id: "msg-1",
                            kind: "assistant",
                            status: "streaming",
                        },
                    ],
                    status: "streaming",
                    updatedAt: "2026-04-14T00:00:01.000Z",
                },
                runtimeId: TAB.runtimeId,
                sessionId: TAB.sessionId,
            },
        };

        useAiStore.getState().applySessionUpdate(update);

        expect(useAiStore.getState().sessions[TAB.sessionId]?.snapshot).toEqual(
            expect.objectContaining({
                availableCommands: [
                    expect.objectContaining({
                        id: "plan",
                    }),
                ],
                messages: [
                    expect.objectContaining({
                        content: "hello world",
                        status: "streaming",
                    }),
                ],
                status: "streaming",
                updatedAt: "2026-04-14T00:00:01.000Z",
            }),
        );
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

    it("stores and persists session review presentation preferences", () => {
        useAiStore.getState().registerSessionTab(TAB);

        expect(useAiStore.getState().sessions[TAB.sessionId]?.diffZoom).toBe(
            null,
        );

        useAiStore.getState().setSessionDiffZoom(TAB.sessionId, 0.823);

        expect(useAiStore.getState().sessions[TAB.sessionId]?.diffZoom).toBe(
            0.82,
        );

        expect(
            globalThis.localStorage.getItem(
                getSessionReviewPreferencesStorageKey(
                    TAB.projectId,
                    TAB.worktreeId,
                    TAB.sessionId,
                ),
            ),
        ).toContain('"diffZoom":0.82');
    });

    it("hydrates persisted session review presentation preferences on register", () => {
        globalThis.localStorage.setItem(
            getSessionReviewPreferencesStorageKey(
                TAB.projectId,
                TAB.worktreeId,
                TAB.sessionId,
            ),
            JSON.stringify({
                diffZoom: 0.84,
                updatedAt: Date.now(),
                version: 1,
            }),
        );

        useAiStore.getState().registerSessionTab(TAB);

        expect(useAiStore.getState().sessions[TAB.sessionId]?.diffZoom).toBe(
            0.84,
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
                label: "(12:18) - const value = 1;",
                path: "src/app.ts",
                selectedText: "const value = 1;",
                startLine: 12,
            },
            { type: "text", text: " " },
        ]);
    });

    it("pauses the queue on cancelSession so the next idle snapshot does not auto-drain", async () => {
        const sendAiPrompt = vi.fn().mockResolvedValue(undefined);
        const cancelAiSession = vi.fn().mockResolvedValue(undefined);

        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    cancelAiSession,
                    sendAiPrompt,
                },
            },
            writable: true,
        });

        useAiStore.getState().registerSessionTab(TAB);
        useAiStore
            .getState()
            .applySessionSnapshot(createSnapshot({ status: "streaming" }));

        // Two prompts typed while the agent is streaming.
        await useAiStore.getState().sendPrompt(TAB, "first");
        await useAiStore.getState().sendPrompt(TAB, "second");

        expect(
            useAiStore
                .getState()
                .sessions[TAB.sessionId]?.queue.map((item) => item.prompt),
        ).toEqual(["first", "second"]);
        expect(sendAiPrompt).not.toHaveBeenCalled();

        await useAiStore.getState().cancelSession(TAB.sessionId);
        expect(cancelAiSession).toHaveBeenCalledWith(TAB.sessionId);
        expect(useAiStore.getState().sessions[TAB.sessionId]?.queuePaused).toBe(
            true,
        );

        // The main process sends an idle snapshot right after the cancel.
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                status: "idle",
                updatedAt: "2026-04-14T00:00:01.000Z",
            }),
        );

        // Give any stray microtasks a chance to run; nothing should dispatch.
        await Promise.resolve();
        await Promise.resolve();

        expect(sendAiPrompt).not.toHaveBeenCalled();
        const pausedSession = useAiStore.getState().sessions[TAB.sessionId];
        expect(pausedSession?.queuePaused).toBe(true);
        expect(pausedSession?.queue.map((item) => item.prompt)).toEqual([
            "first",
            "second",
        ]);
    });

    it("resumes the paused queue after the next manual sendPrompt turn completes", async () => {
        const manualDispatch = createDeferred<void>();
        const sendAiPrompt = vi
            .fn()
            .mockImplementationOnce(() => manualDispatch.promise)
            .mockResolvedValue(undefined);
        const cancelAiSession = vi.fn().mockResolvedValue(undefined);

        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    cancelAiSession,
                    sendAiPrompt,
                },
            },
            writable: true,
        });

        useAiStore.getState().registerSessionTab(TAB);
        useAiStore
            .getState()
            .applySessionSnapshot(createSnapshot({ status: "streaming" }));

        await useAiStore.getState().sendPrompt(TAB, "queued-one");
        await useAiStore.getState().sendPrompt(TAB, "queued-two");

        await useAiStore.getState().cancelSession(TAB.sessionId);
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                status: "idle",
                updatedAt: "2026-04-14T00:00:01.000Z",
            }),
        );

        // Nothing drained yet — queue is paused.
        expect(sendAiPrompt).not.toHaveBeenCalled();

        // User manually sends a new prompt with the agent idle. This lifts
        // the pause and dispatches directly; the dispatch stays pending
        // while manualDispatch is unresolved so we can observe the
        // intermediate state.
        const resumePromise = useAiStore
            .getState()
            .sendPrompt(TAB, "manual-resume");

        await vi.waitFor(() => {
            expect(
                useAiStore.getState().sessions[TAB.sessionId]?.isDispatching,
            ).toBe(true);
        });

        expect(sendAiPrompt).toHaveBeenCalledTimes(1);
        expect(sendAiPrompt.mock.calls[0][0]).toMatchObject({
            prompt: "manual-resume",
        });

        const resumedSession = useAiStore.getState().sessions[TAB.sessionId];
        expect(resumedSession?.queuePaused).toBe(false);
        // The previously paused prompts are still queued, waiting for this
        // turn to finish.
        expect(resumedSession?.queue.map((item) => item.prompt)).toEqual([
            "queued-one",
            "queued-two",
        ]);

        // Simulate the manual turn finishing.
        manualDispatch.resolve(undefined);
        await resumePromise;

        // The drain kicked off by sendPrompt after dispatch picks up the
        // paused prompts in order. They resolve instantly via the default
        // mock so both run back to back.
        await vi.waitFor(() => {
            expect(sendAiPrompt).toHaveBeenCalledTimes(3);
        });
        expect(sendAiPrompt.mock.calls[1][0]).toMatchObject({
            prompt: "queued-one",
        });
        expect(sendAiPrompt.mock.calls[2][0]).toMatchObject({
            prompt: "queued-two",
        });
        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.queue,
        ).toHaveLength(0);
    });

    it("resumes the paused queue when the user forces Send Now on a queued prompt", async () => {
        const sendAiPrompt = vi.fn().mockResolvedValue(undefined);
        const cancelAiSession = vi.fn().mockResolvedValue(undefined);

        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    cancelAiSession,
                    sendAiPrompt,
                },
            },
            writable: true,
        });

        useAiStore.getState().registerSessionTab(TAB);
        useAiStore
            .getState()
            .applySessionSnapshot(createSnapshot({ status: "streaming" }));

        await useAiStore.getState().sendPrompt(TAB, "alpha");
        await useAiStore.getState().sendPrompt(TAB, "beta");

        await useAiStore.getState().cancelSession(TAB.sessionId);
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                status: "idle",
                updatedAt: "2026-04-14T00:00:01.000Z",
            }),
        );

        expect(sendAiPrompt).not.toHaveBeenCalled();

        const betaPromptId =
            useAiStore.getState().sessions[TAB.sessionId]?.queue[1]?.id ?? "";
        await useAiStore
            .getState()
            .sendQueuedPromptNow(TAB.sessionId, betaPromptId);

        await vi.waitFor(() => {
            expect(sendAiPrompt).toHaveBeenCalledTimes(2);
        });
        expect(useAiStore.getState().sessions[TAB.sessionId]?.queuePaused).toBe(
            false,
        );
    });

    it("clearQueuedPrompts resets the paused flag", async () => {
        const sendAiPrompt = vi.fn().mockResolvedValue(undefined);
        const cancelAiSession = vi.fn().mockResolvedValue(undefined);

        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    cancelAiSession,
                    sendAiPrompt,
                },
            },
            writable: true,
        });

        useAiStore.getState().registerSessionTab(TAB);
        useAiStore
            .getState()
            .applySessionSnapshot(createSnapshot({ status: "streaming" }));

        await useAiStore.getState().sendPrompt(TAB, "only");
        await useAiStore.getState().cancelSession(TAB.sessionId);

        expect(useAiStore.getState().sessions[TAB.sessionId]?.queuePaused).toBe(
            true,
        );

        useAiStore.getState().clearQueuedPrompts(TAB.sessionId);

        const clearedSession = useAiStore.getState().sessions[TAB.sessionId];
        expect(clearedSession?.queuePaused).toBe(false);
        expect(clearedSession?.queue).toEqual([]);
    });

    it("clears the harmless pause flag when the user sends again after a cancel with an empty queue", async () => {
        const sendAiPrompt = vi.fn().mockResolvedValue(undefined);
        const cancelAiSession = vi.fn().mockResolvedValue(undefined);

        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    cancelAiSession,
                    sendAiPrompt,
                },
            },
            writable: true,
        });

        useAiStore.getState().registerSessionTab(TAB);
        useAiStore
            .getState()
            .applySessionSnapshot(createSnapshot({ status: "streaming" }));

        await useAiStore.getState().cancelSession(TAB.sessionId);

        // Main reports idle after the cancel completes.
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                status: "idle",
                updatedAt: "2026-04-14T00:00:01.000Z",
            }),
        );

        // Empty queue still gets the pause flag, but since there is nothing
        // to hold back it stays harmless — the next sendPrompt dispatches
        // directly and clears it via resumeQueue.
        await useAiStore.getState().sendPrompt(TAB, "post-cancel");

        await vi.waitFor(() => {
            expect(sendAiPrompt).toHaveBeenCalledTimes(1);
        });
        expect(useAiStore.getState().sessions[TAB.sessionId]?.queuePaused).toBe(
            false,
        );
    });
});
