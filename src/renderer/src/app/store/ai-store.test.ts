import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    AiFileContextAttachment,
    AiImageAttachment,
    AiRuntimeStatus,
    AiSessionDomainEvent,
    AiSessionSnapshot,
    AiSessionUpdate,
    AiToolActivity,
    AiTrackedFile,
    AppBootstrapSnapshot,
    SendAiPromptInput,
    WorkspaceChatTab,
} from "@shared/ipc";

import { AI_SESSION_BUSY_MESSAGE } from "@shared/ai-errors";

import { getSessionReviewPreferencesStorageKey } from "@renderer/app/ai/sessionReviewPreferences";
import { useAppStore } from "./app-store";
import { resetAiStoreRuntimeBuffersForTests, useAiStore } from "./ai-store";

// Electron's ipcRenderer.invoke wraps handler errors with a prefix before
// they reach the renderer. Tests build busy errors via this helper so they
// exercise the same shape production code sees.
function createIpcBusyError(): Error {
    return new Error(
        `Error invoking remote method 'ai:send-prompt': Error: ${AI_SESSION_BUSY_MESSAGE}`,
    );
}

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
        tokenUsage: null,
        toolActivity: [],
        trackedFiles: [],
        updatedAt: "2026-04-14T00:00:00.000Z",
        worktreeId: TAB.worktreeId ?? null,
        ...overrides,
    };
}

function createTrackedFile(
    overrides: Partial<AiTrackedFile> = {},
): AiTrackedFile {
    return {
        hunks: [
            {
                id: "hunk-1",
                lines: [
                    { id: "line-1", text: "before", type: "remove" },
                    { id: "line-2", text: "after", type: "add" },
                ],
                newCount: 1,
                newStart: 1,
                oldCount: 1,
                oldStart: 1,
            },
        ],
        identityKey: "tracked-1",
        isText: true,
        kind: "update",
        newText: "after\n",
        oldText: "before\n",
        path: "src/app.ts",
        previousPath: null,
        reviewState: "pending",
        reversible: true,
        sessionId: TAB.sessionId,
        toolCallId: "tool-1",
        updatedAt: "2026-04-14T00:00:00.000Z",
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
        runtimeId: TAB.runtimeId,
        runtimeSessionId: "runtime-session-1",
        sessionId: TAB.sessionId,
        updatedAt: "2026-04-14T00:00:00.000Z",
        activeTurnStartedAt: null,
        lastError: null,
        status: "idle",
        ...rest,
        kind,
    } as AiSessionDomainEvent;
}

function createRuntimeStatus(
    overrides: Partial<AiRuntimeStatus> = {},
): AiRuntimeStatus {
    return {
        authMethod: null,
        authMethods: [],
        authReady: true,
        checkedAt: "2026-04-14T00:00:00.000Z",
        command: "codex",
        hasCustomBinaryPath: false,
        hasGatewayConfig: false,
        hasGatewayUrl: false,
        message: null,
        onboardingRequired: false,
        runtimeId: TAB.runtimeId,
        source: null,
        state: "ready",
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

function createToolActivity(
    overrides: Partial<AiToolActivity> = {},
): AiToolActivity {
    return {
        createdAt: "2026-04-14T00:00:00.000Z",
        diffs: [],
        exitCode: null,
        id: "tool-1",
        kind: "shell",
        locations: [],
        rawInputJson: null,
        rawOutputJson: null,
        sessionId: TAB.sessionId,
        status: "in_progress",
        summary: null,
        terminalOutput: null,
        title: "Run command",
        updatedAt: "2026-04-14T00:00:00.000Z",
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

function setRendererPlatform(platform: string): void {
    useAppStore.setState({
        bootstrap: { platform } as AppBootstrapSnapshot,
        error: null,
        status: "ready",
    });
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
            runtimeCatalogById: {},
            runtimeStatusById: {},
            sessions: {},
        }));
        resetAiStoreRuntimeBuffersForTests();
        useAppStore.setState({
            bootstrap: null,
            error: null,
            status: "idle",
        });
        vi.restoreAllMocks();
    });

    it("keeps a command-only runtime catalog from status updates", () => {
        const availableCommands = [
            {
                description: "Review changes",
                id: "review",
                insertText: "/review ",
                label: "/review",
            },
        ];

        useAiStore.getState().applyRuntimeStatus(
            createRuntimeStatus({
                availableCommands,
            }),
        );

        expect(
            useAiStore.getState().runtimeCatalogById.codex?.availableCommands,
        ).toEqual(availableCommands);
    });

    it("applies a prepared runtime session snapshot from the backend", async () => {
        const prepareAiSession = vi.fn().mockResolvedValue(createSnapshot());
        const sendAiPrompt = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    getAiRuntimeStatus: vi
                        .fn()
                        .mockResolvedValue(createRuntimeStatus()),
                    prepareAiSession,
                    sendAiPrompt,
                },
            },
            writable: true,
        });

        await useAiStore.getState().ensureSession(TAB);

        expect(prepareAiSession).toHaveBeenCalledWith({
            projectId: TAB.projectId,
            runtimeId: TAB.runtimeId,
            sessionId: TAB.sessionId,
            title: TAB.title,
            worktreeId: TAB.worktreeId,
        });
        expect(sendAiPrompt).not.toHaveBeenCalled();
        expect(useAiStore.getState().sessions[TAB.sessionId]?.snapshot).toEqual(
            createSnapshot(),
        );
    });

    it("dispatches a prompt immediately when the backend snapshot is idle", async () => {
        const sendAiPrompt = vi.fn().mockResolvedValue(undefined);
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

        await vi.waitFor(() => {
            expect(sendAiPrompt).toHaveBeenCalledTimes(1);
        });
        expect(sendAiPrompt.mock.calls[0]?.[0]).toMatchObject({
            prompt: "hello",
        });
    });

    it("lets the backend handle concurrent ensureSession calls", async () => {
        const getAiRuntimeStatus = vi.fn().mockResolvedValue(createRuntimeStatus());
        const prepareAiSession = vi.fn().mockResolvedValue(createSnapshot());
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    getAiRuntimeStatus,
                    prepareAiSession,
                },
            },
            writable: true,
        });

        const firstEnsure = useAiStore.getState().ensureSession(TAB);
        const secondEnsure = useAiStore.getState().ensureSession(TAB);

        await Promise.all([firstEnsure, secondEnsure]);

        expect(getAiRuntimeStatus).toHaveBeenCalledTimes(2);
        expect(prepareAiSession).toHaveBeenCalledTimes(2);
        expect(useAiStore.getState().sessions[TAB.sessionId]?.snapshot).toEqual(
            createSnapshot(),
        );
    });

    it("queues prompts while the backend snapshot is busy", async () => {
        const sendAiPrompt = vi.fn().mockResolvedValue(undefined);
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
        useAiStore
            .getState()
            .applySessionSnapshot(createSnapshot({ status: "streaming" }));

        await useAiStore.getState().sendPrompt(TAB, "hello while busy");

        expect(sendAiPrompt).not.toHaveBeenCalled();
        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.queue[0]?.status,
        ).toBe("queued");
        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.queue[0]?.prompt,
        ).toBe("hello while busy");
    });

    it("pauses queued prompts after canceling so an idle snapshot does not dispatch the next item", async () => {
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

        await useAiStore.getState().sendPrompt(TAB, "do not send late");
        await useAiStore.getState().cancelSession(TAB.sessionId);
        useAiStore.getState().applySessionSnapshot(createSnapshot());

        const session = useAiStore.getState().sessions[TAB.sessionId];
        expect(cancelAiSession).toHaveBeenCalledWith(TAB.sessionId);
        expect(sendAiPrompt).not.toHaveBeenCalled();
        expect(session?.queuePaused).toBe(true);
        expect(session?.queue[0]).toEqual(
            expect.objectContaining({
                prompt: "do not send late",
                status: "queued",
            }),
        );
    });

    it("runs review mutations for a cold registered session without preparing runtime", async () => {
        const keepAllAiTrackedFiles = vi.fn().mockResolvedValue(undefined);
        const prepareAiSession = vi.fn().mockResolvedValue(createSnapshot());
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    keepAllAiTrackedFiles,
                    prepareAiSession,
                },
            },
            writable: true,
        });

        useAiStore.getState().registerSessionTab(TAB);

        await useAiStore.getState().keepAllTrackedFiles(TAB.sessionId);

        expect(keepAllAiTrackedFiles).toHaveBeenCalledWith(TAB.sessionId);
        expect(prepareAiSession).not.toHaveBeenCalled();
    });

    it("preserves runtime commands when session hydration returns an empty snapshot catalog", async () => {
        const availableCommands = [
            {
                description: "Review changes",
                id: "review",
                insertText: "/review ",
                label: "/review",
            },
            {
                description: "Summarize conversation",
                id: "compact",
                insertText: "/compact ",
                label: "/compact",
            },
        ];
        const getAiRuntimeStatus = vi.fn().mockResolvedValue(
            createRuntimeStatus({
                availableCommands,
            }),
        );
        const prepareAiSession = vi.fn().mockResolvedValue(createSnapshot());

        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    getAiRuntimeStatus,
                    prepareAiSession,
                },
            },
            writable: true,
        });

        await useAiStore.getState().ensureSession(TAB);

        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot
                ?.availableCommands,
        ).toEqual(availableCommands);
    });

    it("applies typed message events without duplicating the following snapshot", () => {
        useAiStore.getState().applySessionEvent(
            createSessionEvent({
                kind: "message-started",
                message: {
                    attachments: [],
                    content: "",
                    createdAt: "2026-04-14T00:00:00.000Z",
                    id: "msg-1",
                    kind: "assistant",
                    status: "streaming",
                },
                messageKind: "assistant",
            }),
        );
        useAiStore.getState().applySessionEvent(
            createSessionEvent({
                content: "Hello",
                delta: "Hello",
                kind: "message-delta",
                messageId: "msg-1",
                messageKind: "assistant",
            }),
        );
        useAiStore.getState().applySessionEvent(
            createSessionEvent({
                kind: "message-completed",
                messageId: "msg-1",
                messageKind: "assistant",
            }),
        );
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                messages: [
                    {
                        attachments: [],
                        content: "Hello",
                        createdAt: "2026-04-14T00:00:00.000Z",
                        id: "msg-1",
                        kind: "assistant",
                        status: "completed",
                    },
                ],
            }),
        );

        const messages =
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot?.messages ??
            [];
        const transcript =
            useAiStore.getState().sessions[TAB.sessionId]?.transcript;
        expect(messages).toHaveLength(1);
        expect(messages[0]).toEqual(
            expect.objectContaining({
                content: "Hello",
                id: "msg-1",
                status: "completed",
            }),
        );
        expect(transcript?.messageOrder).toEqual(["message:msg-1"]);
        expect(transcript?.messagesById["message:msg-1"]).toEqual(
            expect.objectContaining({
                kind: "message",
            }),
        );
    });

    it("flushes buffered deltas before completing a message", () => {
        useAiStore.getState().applySessionEvent(
            createSessionEvent({
                kind: "message-started",
                message: {
                    attachments: [],
                    content: "",
                    createdAt: "2026-04-14T00:00:00.000Z",
                    id: "msg-1",
                    kind: "assistant",
                    status: "streaming",
                },
                messageKind: "assistant",
            }),
        );
        useAiStore.getState().applySessionEvent(
            createSessionEvent({
                content: "Hel",
                delta: "Hel",
                kind: "message-delta",
                messageId: "msg-1",
                messageKind: "assistant",
            }),
        );
        useAiStore.getState().applySessionEvent(
            createSessionEvent({
                content: "Hello",
                delta: "lo",
                kind: "message-delta",
                messageId: "msg-1",
                messageKind: "assistant",
            }),
        );

        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot?.messages[0]
                ?.content,
        ).toBe("");

        useAiStore.getState().applySessionEvent(
            createSessionEvent({
                kind: "message-completed",
                messageId: "msg-1",
                messageKind: "assistant",
            }),
        );

        const message =
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot?.messages[0];
        expect(message).toEqual(
            expect.objectContaining({
                content: "Hello",
                status: "completed",
            }),
        );
    });

    it("preserves closed subagent status from incoming snapshots", () => {
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                closedAt: "2026-04-14T00:00:01.000Z",
                parentSessionId: "parent-session-1",
                status: "streaming",
            }),
        );

        expect(useAiStore.getState().sessions[TAB.sessionId]?.snapshot).toEqual(
            expect.objectContaining({
                closedAt: "2026-04-14T00:00:01.000Z",
                parentSessionId: "parent-session-1",
                status: "streaming",
            }),
        );
    });

    it("upserts typed tool activity events by tool id", () => {
        useAiStore.getState().applySessionSnapshot(createSnapshot());

        useAiStore.getState().applySessionEvent(
            createSessionEvent({
                activity: createToolActivity({
                    status: "in_progress",
                    summary: "Running",
                }),
                kind: "tool-activity",
            }),
        );
        useAiStore.getState().applySessionEvent(
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

        const toolActivity =
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot
                ?.toolActivity ?? [];
        expect(toolActivity).toHaveLength(1);
        expect(toolActivity[0]).toEqual(
            expect.objectContaining({
                createdAt: "2026-04-14T00:00:00.000Z",
                id: "tool-1",
                status: "completed",
                summary: "Done",
            }),
        );
        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.transcript
                .messageOrder,
        ).toEqual(["tool:tool-1"]);
    });

    it("does not let a stale snapshot revive old tool activity", () => {
        useAiStore.getState().registerSessionTab(TAB);
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                status: "streaming",
                toolActivity: [],
                updatedAt: "2026-04-14T00:00:02.000Z",
            }),
        );

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                status: "idle",
                toolActivity: [
                    createToolActivity({
                        id: "tool-stale",
                    }),
                ],
                updatedAt: "2026-04-14T00:00:01.000Z",
            }),
        );

        const session = useAiStore.getState().sessions[TAB.sessionId];
        expect(session?.snapshot?.toolActivity).toEqual([]);
        expect(session?.transcript.messageOrder).toEqual([]);
        expect(session?.snapshot?.status).toBe("streaming");
    });

    it("does not let stale session hydration overwrite a newer snapshot", async () => {
        const prepareDeferred = createDeferred<AiSessionSnapshot>();
        const getAiRuntimeStatus = vi
            .fn()
            .mockResolvedValue(createRuntimeStatus());
        const prepareAiSession = vi.fn(() => prepareDeferred.promise);

        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    getAiRuntimeStatus,
                    prepareAiSession,
                },
            },
            writable: true,
        });

        const ensurePromise = useAiStore.getState().ensureSession(TAB);

        await vi.waitFor(() => {
            expect(prepareAiSession).toHaveBeenCalledTimes(1);
        });

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                messages: [
                    {
                        attachments: [],
                        content: "hello from backend",
                        createdAt: "2026-04-14T00:00:02.000Z",
                        id: "msg-1",
                        kind: "user",
                        status: "completed",
                    },
                ],
                status: "streaming",
                updatedAt: "2026-04-14T00:00:02.000Z",
            }),
        );
        prepareDeferred.resolve(
            createSnapshot({
                messages: [],
                status: "idle",
                updatedAt: "2026-04-14T00:00:01.000Z",
            }),
        );

        await ensurePromise;

        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot,
        ).toEqual(
            expect.objectContaining({
                messages: [
                    expect.objectContaining({
                        content: "hello from backend",
                        id: "msg-1",
                    }),
                ],
                status: "streaming",
                updatedAt: "2026-04-14T00:00:02.000Z",
            }),
        );
    });

    it("does not let a stale full snapshot overwrite a newer transcript", () => {
        useAiStore.getState().registerSessionTab(TAB);
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                messages: [
                    {
                        attachments: [],
                        content: "newer message",
                        createdAt: "2026-04-14T00:00:02.000Z",
                        id: "msg-newer",
                        kind: "assistant",
                        status: "completed",
                    },
                ],
                status: "streaming",
                updatedAt: "2026-04-14T00:00:02.000Z",
            }),
        );

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                messages: [],
                status: "idle",
                updatedAt: "2026-04-14T00:00:01.000Z",
            }),
        );

        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot,
        ).toEqual(
            expect.objectContaining({
                messages: [
                    expect.objectContaining({
                        content: "newer message",
                        id: "msg-newer",
                    }),
                ],
                status: "streaming",
                updatedAt: "2026-04-14T00:00:02.000Z",
            }),
        );
    });

    it("does not let a stale patch overwrite a newer transcript", () => {
        useAiStore.getState().registerSessionTab(TAB);
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                messages: [
                    {
                        attachments: [],
                        content: "newer patch message",
                        createdAt: "2026-04-14T00:00:02.000Z",
                        id: "msg-newer-patch",
                        kind: "assistant",
                        status: "completed",
                    },
                ],
                status: "streaming",
                updatedAt: "2026-04-14T00:00:02.000Z",
            }),
        );

        useAiStore.getState().applySessionUpdate({
            kind: "patch",
            patch: {
                changes: {
                    messages: [],
                    status: "idle",
                    updatedAt: "2026-04-14T00:00:01.000Z",
                },
                runtimeId: TAB.runtimeId,
                sessionId: TAB.sessionId,
            },
        });

        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot,
        ).toEqual(
            expect.objectContaining({
                messages: [
                    expect.objectContaining({
                        content: "newer patch message",
                        id: "msg-newer-patch",
                    }),
                ],
                status: "streaming",
                updatedAt: "2026-04-14T00:00:02.000Z",
            }),
        );
    });

    it("applies explicit cleanup fields while preserving a newer transcript", () => {
        useAiStore.getState().registerSessionTab(TAB);
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                messages: [
                    {
                        attachments: [],
                        content: "newer patch message",
                        createdAt: "2026-04-14T00:00:02.000Z",
                        id: "msg-newer-patch",
                        kind: "assistant",
                        status: "completed",
                    },
                ],
                status: "streaming",
                toolActivity: [
                    createToolActivity({
                        id: "tool-cleanup",
                    }),
                ],
                trackedFiles: [
                    {
                        hunks: [],
                        identityKey: "src/app.ts",
                        isText: true,
                        kind: "update",
                        newText: "changed",
                        oldText: "old",
                        path: "src/app.ts",
                        previousPath: null,
                        reviewState: "pending",
                        reversible: true,
                        sessionId: TAB.sessionId,
                        toolCallId: "tool-1",
                        updatedAt: "2026-04-14T00:00:02.000Z",
                    },
                ],
                updatedAt: "2026-04-14T00:00:02.000Z",
            }),
        );

        useAiStore.getState().applySessionUpdate({
            kind: "patch",
            patch: {
                changes: {
                    messages: [],
                    pendingPermission: null,
                    status: "idle",
                    toolActivity: [],
                    trackedFiles: [],
                    updatedAt: "2026-04-14T00:00:03.000Z",
                },
                runtimeId: TAB.runtimeId,
                sessionId: TAB.sessionId,
            },
        });

        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot,
        ).toEqual(
            expect.objectContaining({
                messages: [
                    expect.objectContaining({
                        content: "newer patch message",
                        id: "msg-newer-patch",
                    }),
                ],
                status: "idle",
                toolActivity: [],
                trackedFiles: [],
                updatedAt: "2026-04-14T00:00:03.000Z",
            }),
        );
    });

    it("optimistically removes tracked files through normalized path aliases", async () => {
        const keepAiTrackedFile = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    keepAiTrackedFile,
                },
            },
        });

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                trackedFiles: [
                    createTrackedFile({
                        path: "src\\app.ts",
                    }),
                ],
            }),
        );

        await useAiStore.getState().keepTrackedFile({
            path: "src/app.ts",
            sessionId: TAB.sessionId,
        });

        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot
                ?.trackedFiles,
        ).toEqual([]);
        expect(keepAiTrackedFile).toHaveBeenCalledWith({
            path: "src/app.ts",
            sessionId: TAB.sessionId,
        });
    });

    it("optimistically removes tracked files through relative Windows casing aliases", async () => {
        setRendererPlatform("win32");

        const rejectAiTrackedFile = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    rejectAiTrackedFile,
                },
            },
        });

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                trackedFiles: [
                    createTrackedFile({
                        path: "src/App.ts",
                    }),
                ],
            }),
        );

        await useAiStore.getState().rejectTrackedFile({
            path: "src/app.ts",
            sessionId: TAB.sessionId,
        });

        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot
                ?.trackedFiles,
        ).toEqual([]);
        expect(rejectAiTrackedFile).toHaveBeenCalledWith({
            path: "src/app.ts",
            sessionId: TAB.sessionId,
        });
    });

    it("optimistically updates tracked file hunks through Windows casing aliases", async () => {
        const keepAiTrackedFileHunks = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    keepAiTrackedFileHunks,
                },
            },
        });

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                trackedFiles: [
                    createTrackedFile({
                        path: "C:\\Repo\\src\\App.ts",
                    }),
                ],
            }),
        );
        const hunkId = "C:\\Repo\\src\\App.ts:1:1:0";

        await useAiStore.getState().keepTrackedFileHunks({
            hunkIds: [hunkId],
            path: "c:\\repo\\src\\app.ts",
            sessionId: TAB.sessionId,
        });

        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot
                ?.trackedFiles,
        ).toEqual([]);
        expect(keepAiTrackedFileHunks).toHaveBeenCalledWith({
            hunkIds: [hunkId],
            path: "c:\\repo\\src\\app.ts",
            sessionId: TAB.sessionId,
        });
    });

    it("creates a minimal session for orphan patches with runtime metadata", () => {
        useAiStore.getState().applySessionUpdate({
            kind: "patch",
            patch: {
                changes: {
                    parentSessionId: "session-parent",
                    runtimeSessionId: "runtime-child",
                    title: "Child Agent",
                    updatedAt: "2026-04-14T00:00:03.000Z",
                },
                runtimeId: TAB.runtimeId,
                sessionId: "session-child",
            },
        });

        expect(useAiStore.getState().sessions["session-child"]?.snapshot).toEqual(
            expect.objectContaining({
                parentSessionId: "session-parent",
                runtimeId: TAB.runtimeId,
                runtimeSessionId: "runtime-child",
                sessionId: "session-child",
                title: "Child Agent",
            }),
        );
    });

    it("keeps commands from an early catalog patch even before the session is registered", () => {
        const availableCommands = [
            {
                description: "Review changes",
                id: "review",
                insertText: "/review ",
                label: "/review",
            },
        ];

        useAiStore.getState().applySessionUpdate({
            kind: "patch",
            patch: {
                changes: {
                    availableCommands,
                },
                runtimeId: TAB.runtimeId,
                sessionId: TAB.sessionId,
            },
        });

        expect(
            useAiStore.getState().runtimeCatalogById.codex?.availableCommands,
        ).toEqual(availableCommands);
    });

    it("preserves catalog commands when later config patches arrive for an empty session snapshot", () => {
        const availableCommands = [
            {
                description: "Review changes",
                id: "review",
                insertText: "/review ",
                label: "/review",
            },
        ];
        const configOptions = [
            {
                category: "reasoning" as const,
                description: null,
                id: "reasoning_effort",
                label: "Reasoning",
                options: [
                    {
                        description: null,
                        groupLabel: null,
                        label: "High",
                        value: "high",
                    },
                ],
                type: "select" as const,
                value: "high",
            },
        ];

        useAiStore.getState().applyRuntimeStatus(
            createRuntimeStatus({
                availableCommands,
            }),
        );
        useAiStore.getState().registerSessionTab(TAB);
        useAiStore.getState().applySessionSnapshot(createSnapshot());
        useAiStore.getState().applySessionUpdate({
            kind: "patch",
            patch: {
                changes: {
                    configOptions,
                },
                runtimeId: TAB.runtimeId,
                sessionId: TAB.sessionId,
            },
        });

        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot
                ?.availableCommands,
        ).toEqual(availableCommands);
        expect(
            useAiStore.getState().runtimeCatalogById.codex?.availableCommands,
        ).toEqual(availableCommands);
    });

    it("requeues the prompt when main still reports the session as busy", async () => {
        const sendAiPrompt = vi
            .fn()
            .mockRejectedValueOnce(createIpcBusyError())
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
        expect(deferredSession?.queue[0]?.status).toBe("pending_dispatch");
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

    it("shows a local user message before the prompt IPC resolves", async () => {
        const firstDispatch = createDeferred<void>();
        const sendAiPrompt = vi
            .fn()
            .mockImplementationOnce(() => firstDispatch.promise);

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

        const sendPromise = useAiStore.getState().sendPrompt(TAB, "hello");

        await vi.waitFor(() => {
            expect(sendAiPrompt).toHaveBeenCalledTimes(1);
        });

        const firstSendInput = sendAiPrompt.mock.calls[0]?.[0] as
            | SendAiPromptInput
            | undefined;
        const messageId = firstSendInput?.messageId ?? "";
        const pendingSession = useAiStore.getState().sessions[TAB.sessionId];

        expect(typeof messageId).toBe("string");
        expect(pendingSession?.snapshot?.status).toBe("starting");
        expect(pendingSession?.snapshot?.messages).toContainEqual(
            expect.objectContaining({
                content: "hello",
                id: messageId,
                kind: "user",
                status: "completed",
            }),
        );
        expect(pendingSession?.activeQueuedPrompt?.queuedPrompt.id).toBe(
            messageId,
        );

        firstDispatch.resolve(undefined);
        await sendPromise;
    });

    it("uses the local message id for backend dispatch and deduplicates the runtime echo", async () => {
        const firstDispatch = createDeferred<void>();
        const sendAiPrompt = vi
            .fn()
            .mockImplementationOnce(() => firstDispatch.promise);

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

        const sendPromise = useAiStore.getState().sendPrompt(TAB, "hello");

        await vi.waitFor(() => {
            expect(sendAiPrompt).toHaveBeenCalledTimes(1);
        });

        const firstSendInput = sendAiPrompt.mock.calls[0]?.[0] as
            | SendAiPromptInput
            | undefined;
        const messageId = firstSendInput?.messageId ?? "";
        expect(messageId).toBeTruthy();

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                activeTurnStartedAt: "2026-04-14T00:00:01.000Z",
                messages: [
                    {
                        attachments: [],
                        content: "hello",
                        createdAt: "2026-04-14T00:00:01.000Z",
                        id: messageId,
                        kind: "user",
                        status: "completed",
                    },
                ],
                status: "starting",
                updatedAt: "2026-04-14T00:00:01.000Z",
            }),
        );

        const echoedSession = useAiStore.getState().sessions[TAB.sessionId];
        expect(
            echoedSession?.snapshot?.messages.filter(
                (message) => message.id === messageId,
            ),
        ).toHaveLength(1);

        firstDispatch.resolve(undefined);
        await sendPromise;
    });

    it("marks an immediately accepted prompt as failed when dispatch hard-fails", async () => {
        const sendAiPrompt = vi
            .fn()
            .mockRejectedValueOnce(new Error("Spawn failed"));

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

        const failedSession = useAiStore.getState().sessions[TAB.sessionId];
        const failedPrompt = failedSession?.queue[0];
        expect(failedPrompt?.prompt).toBe("hello");
        expect(failedPrompt?.status).toBe("failed");
        expect(failedSession?.localError).toBe("Spawn failed");
        expect(failedSession?.snapshot?.messages).toContainEqual(
            expect.objectContaining({
                content: "hello",
                id: failedPrompt?.id,
                kind: "user",
            }),
        );
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
                path: "fixtures/sample-project/untitled.cpp",
                selectedText: "elimina",
                startLine: 85,
                type: "selection_mention" as const,
            },
            { text: " ", type: "text" as const },
        ];

        await useAiStore
            .getState()
            .sendPrompt(TAB, "fixtures/sample-project/untitled.cpp:85-88", {
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
            .mockRejectedValueOnce(createIpcBusyError())
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
            .mockRejectedValueOnce(createIpcBusyError());

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
            .mockRejectedValueOnce(createIpcBusyError());

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
            .mockRejectedValueOnce(createIpcBusyError());

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
            .mockRejectedValueOnce(createIpcBusyError())
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

        // The agent finishes the first turn; the idle snapshot drives the
        // queue drain so the next prompt can dispatch.
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                status: "idle",
                updatedAt: "2026-04-14T00:00:01.000Z",
            }),
        );

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

    it("does not let a stale manual dispatch finally clear a newer queued dispatch", async () => {
        const firstDispatch = createDeferred<void>();
        const secondDispatch = createDeferred<void>();
        const sendAiPrompt = vi
            .fn()
            .mockImplementationOnce(() => firstDispatch.promise)
            .mockImplementationOnce(() => secondDispatch.promise)
            .mockResolvedValue(undefined);

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

        const firstSendPromise = useAiStore
            .getState()
            .sendPrompt(TAB, "first");

        await vi.waitFor(() => {
            expect(sendAiPrompt).toHaveBeenCalledTimes(1);
        });
        expect(sendAiPrompt.mock.calls[0][0]).toMatchObject({
            prompt: "first",
        });

        await useAiStore.getState().sendPrompt(TAB, "second");
        await useAiStore.getState().sendPrompt(TAB, "third");
        await useAiStore.getState().sendPrompt(TAB, "fourth");

        expect(
            useAiStore
                .getState()
                .sessions[TAB.sessionId]?.queue.map((item) => item.prompt),
        ).toEqual(["second", "third", "fourth"]);

        // The backend reports idle before the first IPC promise resolves, so
        // the queue is allowed to dispatch the next prompt.
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                status: "idle",
                updatedAt: "2026-04-14T00:00:01.000Z",
            }),
        );

        await vi.waitFor(() => {
            expect(sendAiPrompt).toHaveBeenCalledTimes(2);
        });
        expect(sendAiPrompt.mock.calls[1][0]).toMatchObject({
            prompt: "second",
        });

        firstDispatch.resolve(undefined);
        await firstSendPromise;
        await Promise.resolve();

        const sessionAfterStaleFinally =
            useAiStore.getState().sessions[TAB.sessionId];
        expect(sendAiPrompt).toHaveBeenCalledTimes(2);
        expect(sessionAfterStaleFinally?.isDispatching).toBe(true);
        expect(
            sessionAfterStaleFinally?.queue.map((item) => item.prompt),
        ).toEqual(["third", "fourth"]);

        secondDispatch.resolve(undefined);
        await vi.waitFor(() => {
            expect(
                useAiStore.getState().sessions[TAB.sessionId]?.isDispatching,
            ).toBe(false);
        });

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                status: "idle",
                updatedAt: "2026-04-14T00:00:02.000Z",
            }),
        );

        await vi.waitFor(() => {
            expect(sendAiPrompt).toHaveBeenCalledTimes(3);
        });
        expect(sendAiPrompt.mock.calls[2][0]).toMatchObject({
            prompt: "third",
        });
        expect(
            useAiStore
                .getState()
                .sessions[TAB.sessionId]?.queue.map((item) => item.prompt),
        ).toEqual(["fourth"]);
    });

    it("does not treat local snapshot mutations as queued dispatch completion", async () => {
        const firstDispatch = createDeferred<void>();
        const sendAiPrompt = vi
            .fn()
            .mockImplementationOnce(() => firstDispatch.promise)
            .mockResolvedValue(undefined);
        const setAiSessionModel = vi.fn().mockResolvedValue(undefined);

        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    sendAiPrompt,
                    setAiSessionModel,
                },
            },
            writable: true,
        });

        useAiStore.getState().registerSessionTab(TAB);
        useAiStore
            .getState()
            .applySessionSnapshot(createSnapshot({ status: "streaming" }));

        await useAiStore.getState().sendPrompt(TAB, "first");
        await useAiStore.getState().sendPrompt(TAB, "second");

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                status: "idle",
                updatedAt: "2026-04-14T00:00:01.000Z",
            }),
        );

        await vi.waitFor(() => {
            expect(sendAiPrompt).toHaveBeenCalledTimes(1);
        });
        expect(sendAiPrompt.mock.calls[0][0]).toMatchObject({
            prompt: "first",
        });

        await useAiStore.getState().setSessionModel({
            modelId: "gpt-5",
            sessionId: TAB.sessionId,
        });

        firstDispatch.resolve(undefined);

        await vi.waitFor(() => {
            expect(
                useAiStore.getState().sessions[TAB.sessionId]?.isDispatching,
            ).toBe(false);
        });
        expect(setAiSessionModel).toHaveBeenCalledTimes(1);
        expect(sendAiPrompt).toHaveBeenCalledTimes(1);
        expect(
            useAiStore
                .getState()
                .sessions[TAB.sessionId]?.queue.map((item) => item.prompt),
        ).toEqual(["second"]);

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                status: "idle",
                updatedAt: "2026-04-14T00:00:02.000Z",
            }),
        );

        await vi.waitFor(() => {
            expect(sendAiPrompt).toHaveBeenCalledTimes(2);
        });
        expect(sendAiPrompt.mock.calls[1][0]).toMatchObject({
            prompt: "second",
        });
    });

    it("keeps the latest incoming snapshot marker when stale snapshots arrive during a queued dispatch", async () => {
        const firstDispatch = createDeferred<void>();
        const sendAiPrompt = vi
            .fn()
            .mockImplementationOnce(() => firstDispatch.promise)
            .mockResolvedValue(undefined);

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
        useAiStore
            .getState()
            .applySessionSnapshot(createSnapshot({ status: "streaming" }));

        await useAiStore.getState().sendPrompt(TAB, "first");
        await useAiStore.getState().sendPrompt(TAB, "second");

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                status: "idle",
                updatedAt: "2026-04-14T00:00:01.000Z",
            }),
        );

        await vi.waitFor(() => {
            expect(sendAiPrompt).toHaveBeenCalledTimes(1);
        });
        expect(sendAiPrompt.mock.calls[0][0]).toMatchObject({
            prompt: "first",
        });

        // The completion snapshot for the active queued prompt arrives before
        // its IPC promise resolves, then an older snapshot arrives out of order.
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                status: "idle",
                updatedAt: "2026-04-14T00:00:02.000Z",
            }),
        );
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                status: "idle",
                updatedAt: "2026-04-14T00:00:00.500Z",
            }),
        );

        firstDispatch.resolve(undefined);

        await vi.waitFor(() => {
            expect(sendAiPrompt).toHaveBeenCalledTimes(2);
        });
        expect(sendAiPrompt.mock.calls[1][0]).toMatchObject({
            prompt: "second",
        });
        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.queue,
        ).toHaveLength(0);
    });

    it("completes an active queued dispatch when a new incoming snapshot reuses the same timestamp", async () => {
        const firstDispatch = createDeferred<void>();
        const sendAiPrompt = vi
            .fn()
            .mockImplementationOnce(() => firstDispatch.promise)
            .mockResolvedValue(undefined);

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
        useAiStore
            .getState()
            .applySessionSnapshot(createSnapshot({ status: "streaming" }));

        await useAiStore.getState().sendPrompt(TAB, "first");
        await useAiStore.getState().sendPrompt(TAB, "second");

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                status: "idle",
                updatedAt: "2026-04-14T00:00:01.000Z",
            }),
        );

        await vi.waitFor(() => {
            expect(sendAiPrompt).toHaveBeenCalledTimes(1);
        });
        expect(sendAiPrompt.mock.calls[0][0]).toMatchObject({
            prompt: "first",
        });

        // The backend can emit multiple snapshots within the same millisecond.
        // The second incoming snapshot still proves something arrived after the
        // queued prompt became active, even though updatedAt is unchanged.
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                status: "idle",
                updatedAt: "2026-04-14T00:00:01.000Z",
            }),
        );

        firstDispatch.resolve(undefined);

        await vi.waitFor(() => {
            expect(sendAiPrompt).toHaveBeenCalledTimes(2);
        });
        expect(sendAiPrompt.mock.calls[1][0]).toMatchObject({
            prompt: "second",
        });
        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.queue,
        ).toHaveLength(0);
    });

    it("drains several queued prompts in FIFO order on successive idle snapshots", async () => {
        const sendAiPrompt = vi.fn().mockResolvedValue(undefined);

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
        useAiStore
            .getState()
            .applySessionSnapshot(createSnapshot({ status: "streaming" }));

        await useAiStore.getState().sendPrompt(TAB, "first");
        await useAiStore.getState().sendPrompt(TAB, "second");
        await useAiStore.getState().sendPrompt(TAB, "third");

        for (const [index, prompt] of ["first", "second", "third"].entries()) {
            useAiStore.getState().applySessionSnapshot(
                createSnapshot({
                    status: "idle",
                    updatedAt: `2026-04-14T00:00:0${index + 1}.000Z`,
                }),
            );

            await vi.waitFor(() => {
                expect(sendAiPrompt).toHaveBeenCalledTimes(index + 1);
            });
            expect(sendAiPrompt.mock.calls[index][0]).toMatchObject({
                prompt,
            });
            await vi.waitFor(() => {
                expect(
                    useAiStore.getState().sessions[TAB.sessionId]
                    ?.isDispatching,
                ).toBe(false);
            });
        }

        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.queue,
        ).toHaveLength(0);
    });

    it("restores a busy automatic dispatch to its original queued position", async () => {
        const sendAiPrompt = vi
            .fn()
            .mockRejectedValueOnce(createIpcBusyError());

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
        useAiStore
            .getState()
            .applySessionSnapshot(createSnapshot({ status: "streaming" }));

        await useAiStore.getState().sendPrompt(TAB, "first");
        await useAiStore.getState().sendPrompt(TAB, "second");
        await useAiStore.getState().sendPrompt(TAB, "third");

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                status: "idle",
                updatedAt: "2026-04-14T00:00:01.000Z",
            }),
        );

        await vi.waitFor(() => {
            expect(sendAiPrompt).toHaveBeenCalledTimes(1);
        });
        await vi.waitFor(() => {
            const queuedSession = useAiStore.getState().sessions[TAB.sessionId];
            expect(
                queuedSession?.queue.map((item) => ({
                    prompt: item.prompt,
                    status: item.status,
                })),
            ).toEqual([
                { prompt: "first", status: "pending_dispatch" },
                { prompt: "second", status: "queued" },
                { prompt: "third", status: "queued" },
            ]);
            expect(queuedSession?.isDispatching).toBe(false);
        });
    });

    it("allows retrying a failed queued prompt with sendQueuedPromptNow", async () => {
        const sendAiPrompt = vi
            .fn()
            .mockRejectedValueOnce(createIpcBusyError())
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

        // The paused prompts drain one per idle snapshot (the backend only
        // reports idle when it is actually ready for the next dispatch).
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                status: "idle",
                updatedAt: "2026-04-14T00:00:02.000Z",
            }),
        );
        await vi.waitFor(() => {
            expect(sendAiPrompt).toHaveBeenCalledTimes(2);
        });
        expect(sendAiPrompt.mock.calls[1][0]).toMatchObject({
            prompt: "queued-one",
        });

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                status: "idle",
                updatedAt: "2026-04-14T00:00:03.000Z",
            }),
        );
        await vi.waitFor(() => {
            expect(sendAiPrompt).toHaveBeenCalledTimes(3);
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

        const betaComposerParts = [
            { text: "beta ", type: "text" as const },
            {
                label: "app.ts",
                languageId: "typescript",
                path: "/tmp/project/src/app.ts",
                relativePath: "src/app.ts",
                type: "file_mention" as const,
            },
        ];

        await useAiStore.getState().sendPrompt(TAB, "alpha");
        await useAiStore.getState().sendPrompt(TAB, "beta", {
            composerPartsSnapshot: betaComposerParts,
        });

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
            expect(sendAiPrompt).toHaveBeenCalledTimes(1);
        });
        expect(sendAiPrompt.mock.calls[0][0]).toMatchObject({ prompt: "beta" });
        expect(sendAiPrompt.mock.calls[0][0]).toMatchObject({
            composerParts: betaComposerParts,
        });
        expect(useAiStore.getState().sessions[TAB.sessionId]?.queuePaused).toBe(
            false,
        );

        // When the beta turn finishes and the session reports idle, the
        // remaining prompt (alpha) drains.
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                status: "idle",
                updatedAt: "2026-04-14T00:00:02.000Z",
            }),
        );
        await vi.waitFor(() => {
            expect(sendAiPrompt).toHaveBeenCalledTimes(2);
        });
        expect(sendAiPrompt.mock.calls[1][0]).toMatchObject({
            prompt: "alpha",
        });
    });

    it("cancels the active inference before steering a queued prompt", async () => {
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

        const betaPromptId =
            useAiStore.getState().sessions[TAB.sessionId]?.queue[1]?.id ?? "";
        await useAiStore
            .getState()
            .sendQueuedPromptNow(TAB.sessionId, betaPromptId);

        expect(cancelAiSession).toHaveBeenCalledWith(TAB.sessionId);
        expect(sendAiPrompt).not.toHaveBeenCalled();
        expect(
            useAiStore
                .getState()
                .sessions[TAB.sessionId]?.queue.map((item) => item.prompt),
        ).toEqual(["beta", "alpha"]);
        expect(useAiStore.getState().sessions[TAB.sessionId]?.queuePaused).toBe(
            false,
        );

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                status: "idle",
                updatedAt: "2026-04-14T00:00:01.000Z",
            }),
        );

        await vi.waitFor(() => {
            expect(sendAiPrompt).toHaveBeenCalledTimes(1);
        });
        expect(sendAiPrompt.mock.calls[0][0]).toMatchObject({ prompt: "beta" });
        expect(
            useAiStore
                .getState()
                .sessions[TAB.sessionId]?.queue.map((item) => item.prompt),
        ).toEqual(["alpha"]);
    });

    it("keeps the steered prompt queued when cancelling the active inference fails", async () => {
        const sendAiPrompt = vi.fn().mockResolvedValue(undefined);
        const cancelAiSession = vi
            .fn()
            .mockResolvedValueOnce(undefined)
            .mockRejectedValue(new Error("Cancel failed"));

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

        const betaPromptId =
            useAiStore.getState().sessions[TAB.sessionId]?.queue[1]?.id ?? "";
        await useAiStore
            .getState()
            .sendQueuedPromptNow(TAB.sessionId, betaPromptId);

        const session = useAiStore.getState().sessions[TAB.sessionId];
        expect(cancelAiSession).toHaveBeenCalledTimes(2);
        expect(cancelAiSession).toHaveBeenLastCalledWith(TAB.sessionId);
        expect(sendAiPrompt).not.toHaveBeenCalled();
        expect(session?.localError).toBe("Cancel failed");
        expect(session?.queuePaused).toBe(true);
        expect(session?.queue.map((item) => item.prompt)).toEqual([
            "beta",
            "alpha",
        ]);
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

    it("drains multiple queued prompts one per idle snapshot without marking them failed", async () => {
        const sendAiPrompt = vi.fn().mockResolvedValue(undefined);

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
        useAiStore
            .getState()
            .applySessionSnapshot(createSnapshot({ status: "streaming" }));

        // Two prompts enqueue while the agent is busy.
        await useAiStore.getState().sendPrompt(TAB, "first");
        await useAiStore.getState().sendPrompt(TAB, "second");

        const busyQueue =
            useAiStore.getState().sessions[TAB.sessionId]?.queue ?? [];
        expect(busyQueue.map((item) => item.prompt)).toEqual([
            "first",
            "second",
        ]);
        expect(busyQueue.every((item) => item.status === "queued")).toBe(true);
        expect(sendAiPrompt).not.toHaveBeenCalled();

        // Agent becomes idle → the first queued prompt drains.
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                status: "idle",
                updatedAt: "2026-04-14T00:00:01.000Z",
            }),
        );

        await vi.waitFor(() => {
            expect(sendAiPrompt).toHaveBeenCalledTimes(1);
        });
        expect(sendAiPrompt).toHaveBeenLastCalledWith(
            expect.objectContaining({ prompt: "first" }),
        );

        // After the first dispatch resolves the second prompt must stay
        // queued — it cannot be marked "failed" and it cannot be eagerly
        // re-dispatched while the backend is still processing the first one.
        await vi.waitFor(() => {
            const midDrainQueue =
                useAiStore.getState().sessions[TAB.sessionId]?.queue ?? [];
            expect(midDrainQueue.map((item) => item.prompt)).toEqual([
                "second",
            ]);
            expect(midDrainQueue[0]?.status).toBe("queued");
        });
        expect(sendAiPrompt).toHaveBeenCalledTimes(1);

        // Backend confirms busy for the first prompt; no drain should fire.
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                status: "streaming",
                updatedAt: "2026-04-14T00:00:02.000Z",
            }),
        );
        expect(sendAiPrompt).toHaveBeenCalledTimes(1);

        // Idle again → the second prompt drains.
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                status: "idle",
                updatedAt: "2026-04-14T00:00:03.000Z",
            }),
        );

        await vi.waitFor(() => {
            expect(sendAiPrompt).toHaveBeenCalledTimes(2);
        });
        expect(sendAiPrompt).toHaveBeenLastCalledWith(
            expect.objectContaining({ prompt: "second" }),
        );
        await vi.waitFor(() => {
            const finalSession =
                useAiStore.getState().sessions[TAB.sessionId];
            expect(finalSession?.queue).toEqual([]);
            expect(finalSession?.localError).toBeNull();
        });
    });
});
