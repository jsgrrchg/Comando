import { describe, expect, it, vi } from "vitest";

import type {
    AiRuntimeStatus,
    AiTrackedFile,
    PrepareAiSessionInput,
    SendAiPromptInput,
} from "@shared/ipc";
import type {
    NativeAiPrepareSessionInput,
    NativeBackendEvent,
} from "@shared/native-backend";

import { createEmptyAiSessionSnapshot } from "@main/ai/persistence";
import type { AiSessionLaunchInput } from "@main/ai/contracts";

import {
    NativeAiGateway,
    type NativeAiGatewayOptions,
} from "./ai";
import { NativeBackendError } from "./client";

describe("NativeAiGateway", () => {
    it("prepares native sessions with launch context and returns a live snapshot", async () => {
        const client = createClient();
        const gateway = createGateway(client);
        const launch = createLaunch();

        await expect(
            gateway.prepareSession({
                input: createPrepareInput(),
                launch,
            }),
        ).resolves.toMatchObject({
            modeId: "build",
            modelId: "gpt-5",
            runtimeId: "opencode",
            runtimeSessionId: "runtime-session-1",
            sessionId: "session-1",
            status: "idle",
            title: "Native session",
        });

        const prepareCall = client.request.mock.calls.find(
            ([command]) => command === "ai_prepare_session",
        );
        const payload = prepareCall?.[1] as NativeAiPrepareSessionInput;
        expect(payload).toMatchObject({
            configOptions: { model: "gpt-5" },
            cwd: "/workspace/project",
            modeId: "build",
            modelId: "gpt-5",
            runtimeId: "opencode",
            sessionId: "session-1",
            windowId: "window-1",
        });
        expect(payload.launch).toBeNull();
    });

    it("imports persisted review files when native review state is missing during prepare", async () => {
        const client = createClient();
        const gateway = createGateway(client);
        const legacyFile = createNativeTrackedFile({
            path: "src/legacy.ts",
        }) as unknown as AiTrackedFile;
        const launch = {
            ...createLaunch(),
            persistedSnapshot: {
                ...createLaunch().persistedSnapshot,
                trackedFiles: [legacyFile],
            },
        };

        await expect(
            gateway.prepareSession({
                input: createPrepareInput(),
                launch,
            }),
        ).resolves.toMatchObject({
            sessionId: "session-1",
            trackedFiles: [{ path: "src/legacy.ts" }],
        });

        expect(client.request).toHaveBeenCalledWith("ai_import_review_state", {
            sessionId: "session-1",
            trackedFiles: [legacyFile],
        });
    });

    it("passes persisted history links when Rust owns runtime launch resolution", async () => {
        const client = createClient();
        const gateway = createGateway(client);
        const launch = {
            ...createLaunch(),
            persistedSnapshot: {
                ...createLaunch().persistedSnapshot,
                runtimeSessionId: "runtime-session-previous",
            },
            persistedSubagentSessionMappings: [
                {
                    appSessionId: "session-child",
                    parentAppSessionId: "session-1",
                    parentRuntimeSessionId: "runtime-session-previous",
                    runtimeSessionId: "runtime-child",
                },
            ],
        };

        await gateway.prepareSession({
            input: createPrepareInput(),
            launch,
        });

        expect(client.request).toHaveBeenCalledWith(
            "ai_prepare_session",
            expect.objectContaining({
                launch: null,
                persistedRuntimeSessionId: "runtime-session-previous",
                persistedSubagentSessionMappings: [
                    {
                        appSessionId: "session-child",
                        parentAppSessionId: "session-1",
                        parentRuntimeSessionId: "runtime-session-previous",
                        runtimeSessionId: "runtime-child",
                    },
                ],
            }),
        );
    });

    it("starts a fresh runtime session when the persisted runtime session is stale", async () => {
        const client = createClient();
        const gateway = createGateway(client, {
            onDiagnostic: vi.fn(),
        });
        const launch = {
            ...createLaunch(),
            persistedSnapshot: {
                ...createLaunch().persistedSnapshot,
                runtimeSessionId: "runtime-session-stale",
            },
        };

        client.request.mockImplementationOnce(() =>
            Promise.reject(
                new NativeBackendError({
                    code: "ai_runtime_exited",
                    details: null,
                    message: "AI runtime process exited: Resource not found: stale",
                    retryable: false,
                }),
            ),
        );

        await expect(
            gateway.prepareSession({
                input: createPrepareInput(),
                launch,
            }),
        ).resolves.toMatchObject({
            runtimeSessionId: "runtime-session-1",
            sessionId: "session-1",
        });

        const prepareCalls = client.request.mock.calls.filter(
            ([command]) => command === "ai_prepare_session",
        );
        expect(prepareCalls).toHaveLength(2);
        expect(prepareCalls[0]?.[1]).toMatchObject({
            persistedRuntimeSessionId: "runtime-session-stale",
        });
        expect(prepareCalls[1]?.[1]).toMatchObject({
            persistedRuntimeSessionId: null,
        });
    });

    it("routes native AI events through the owning window", async () => {
        const client = createClient();
        const onSessionEvent = vi.fn();
        const gateway = createGateway(client, { onSessionEvent });

        await gateway.prepareSession({
            input: createPrepareInput(),
            launch: createLaunch(),
        });
        client.emit({
            eventName: "ai://message-delta",
            payload: {
                content: "Hello",
                delta: "Hello",
                messageId: "assistant-1",
                messageKind: "assistant",
                runtimeId: "opencode",
                runtimeSessionId: "runtime-session-1",
                sessionId: "session-1",
                updatedAt: "2026-06-20T00:00:01.000Z",
            },
            type: "event",
        });

        expect(onSessionEvent).toHaveBeenCalledWith(
            "window-1",
            expect.objectContaining({
                content: "Hello",
                kind: "message-delta",
                messageId: "assistant-1",
                sessionId: "session-1",
            }),
        );
    });

    it("projects native catalog updates through the owning window", async () => {
        const client = createClient();
        const onSessionCatalogPatch = vi.fn();
        const gateway = createGateway(client, { onSessionCatalogPatch });

        await gateway.prepareSession({
            input: createPrepareInput(),
            launch: createLaunch(),
        });
        client.emit({
            eventName: "ai://session-catalog-updated",
            payload: {
                availableCommands: [
                    {
                        description: "Create a plan",
                        name: "plan",
                    },
                ],
                configOptions: [
                    {
                        category: "mode",
                        currentValue: "build",
                        description: null,
                        id: "mode",
                        name: "Mode",
                        options: [
                            {
                                description: "Implementation mode",
                                groupLabel: null,
                                name: "Build",
                                value: "build",
                            },
                        ],
                        type: "select",
                    },
                ],
                modeId: "build",
                runtimeId: "opencode",
                runtimeSessionId: "runtime-session-1",
                sessionId: "session-1",
                updatedAt: "2026-06-20T00:00:01.000Z",
            },
            type: "event",
        });

        expect(onSessionCatalogPatch).toHaveBeenCalledWith(
            "window-1",
            "session-1",
            {
                availableCommands: [
                    {
                        description: "Create a plan",
                        id: "plan",
                        insertText: "/plan ",
                        label: "/plan",
                    },
                ],
                configOptions: [
                    {
                        category: "mode",
                        description: null,
                        id: "mode",
                        label: "Mode",
                        options: [
                            {
                                description: "Implementation mode",
                                groupLabel: null,
                                label: "Build",
                                value: "build",
                            },
                        ],
                        type: "select",
                        value: "build",
                    },
                ],
                modeId: "build",
            },
            "2026-06-20T00:00:01.000Z",
        );
    });

    it("routes native subagent events by parent ownership and remembers the child", async () => {
        const client = createClient();
        const onSessionEvent = vi.fn();
        const gateway = createGateway(client, { onSessionEvent });

        await gateway.prepareSession({
            input: createPrepareInput(),
            launch: createLaunch(),
        });
        client.emit({
            eventName: "ai://subagent-created",
            payload: {
                childRuntimeSessionId: "runtime-child-1",
                childSessionId: "session-1:subagent:runtime-child-1",
                parentRuntimeSessionId: "runtime-session-1",
                parentSessionId: "session-1",
                runtimeId: "opencode",
                runtimeSessionId: "runtime-child-1",
                sessionId: "session-1:subagent:runtime-child-1",
                title: "Galileo",
                updatedAt: "2026-06-20T00:00:01.000Z",
            },
            type: "event",
        });
        client.emit({
            eventName: "ai://message-delta",
            payload: {
                content: "Child output",
                delta: "Child output",
                messageId: "assistant-child-1",
                messageKind: "assistant",
                runtimeId: "opencode",
                runtimeSessionId: "runtime-child-1",
                sessionId: "session-1:subagent:runtime-child-1",
                updatedAt: "2026-06-20T00:00:02.000Z",
            },
            type: "event",
        });

        expect(onSessionEvent).toHaveBeenCalledWith(
            "window-1",
            expect.objectContaining({
                childSessionId: "session-1:subagent:runtime-child-1",
                kind: "subagent-created",
                parentSessionId: "session-1",
                sessionId: "session-1:subagent:runtime-child-1",
                title: "Galileo",
            }),
        );
        expect(onSessionEvent).toHaveBeenCalledWith(
            "window-1",
            expect.objectContaining({
                content: "Child output",
                kind: "message-delta",
                sessionId: "session-1:subagent:runtime-child-1",
            }),
        );

        client.request.mockClear();
        await gateway.cancelSession("session-1:subagent:runtime-child-1");
        expect(client.request).toHaveBeenCalledWith("ai_cancel_session", {
            runtimeSessionId: "runtime-child-1",
            sessionId: "session-1",
            targetSessionId: "session-1:subagent:runtime-child-1",
        });

        client.request.mockClear();
        await gateway.sendPrompt({
            input: {
                ...createPromptInput(),
                messageId: "user-message-child-1",
                sessionId: "session-1:subagent:runtime-child-1",
            },
            launch: createLaunch(),
        });
        expect(client.request).toHaveBeenCalledWith("ai_send_prompt", {
            messageId: "user-message-child-1",
            prompt: {
                attachments: [],
                displayText: "Implement the feature.",
                text: "Implement the feature.",
            },
            runtimeSessionId: "runtime-child-1",
            sessionId: "session-1",
            targetSessionId: "session-1:subagent:runtime-child-1",
        });

        client.request.mockClear();
        await gateway.closeSession("session-1:subagent:runtime-child-1");
        expect(client.request).not.toHaveBeenCalled();
    });

    it("hydrates persisted subagent mappings before child events arrive", async () => {
        const client = createClient();
        const onSessionEvent = vi.fn();
        const gateway = createGateway(client, { onSessionEvent });
        const childSessionId = "session-1:subagent:runtime-child-1";
        const launch = {
            ...createLaunch(),
            persistedSubagentSessionMappings: [
                {
                    appSessionId: childSessionId,
                    parentAppSessionId: "session-1",
                    parentRuntimeSessionId: "runtime-session-1",
                    runtimeSessionId: "runtime-child-1",
                },
            ],
        };

        await gateway.prepareSession({
            input: createPrepareInput(),
            launch,
        });
        client.emit({
            eventName: "ai://message-delta",
            payload: {
                content: "Persisted child output",
                delta: "Persisted child output",
                messageId: "assistant-child-1",
                messageKind: "assistant",
                runtimeId: "opencode",
                runtimeSessionId: "runtime-child-1",
                sessionId: childSessionId,
                updatedAt: "2026-06-20T00:00:02.000Z",
            },
            type: "event",
        });

        expect(onSessionEvent).toHaveBeenCalledWith(
            "window-1",
            expect.objectContaining({
                content: "Persisted child output",
                kind: "message-delta",
                sessionId: childSessionId,
            }),
        );

        const childLaunch = {
            ...createLaunch(),
            input: {
                ...createLaunch().input,
                sessionId: childSessionId,
                title: "Galileo",
            },
            persistedSnapshot: {
                ...createEmptyAiSessionSnapshot({
                    projectId: "project-1",
                    runtimeId: "opencode",
                    sessionId: childSessionId,
                    title: "Galileo",
                    worktreeId: "worktree-1",
                }),
                parentSessionId: "session-1",
                runtimeSessionId: "runtime-child-1",
            },
        };

        client.request.mockClear();
        await gateway.sendPrompt({
            input: {
                ...createPromptInput(),
                messageId: "user-message-child-1",
                sessionId: childSessionId,
            },
            launch: childLaunch,
        });
        expect(client.request).toHaveBeenCalledWith("ai_send_prompt", {
            messageId: "user-message-child-1",
            prompt: {
                attachments: [],
                displayText: "Implement the feature.",
                text: "Implement the feature.",
            },
            runtimeSessionId: "runtime-child-1",
            sessionId: "session-1",
            targetSessionId: childSessionId,
        });
    });

    it("requests and adapts native history payloads when history is enabled", async () => {
        const client = createClient();
        client.request.mockImplementation(
            <T = unknown>(command: string): Promise<T> => {
                if (command === "ai_list_session_history") {
                    return Promise.resolve([
                        {
                            createdAt: "2026-06-20T00:00:00.000Z",
                            messageCount: 1,
                            parentSessionId: null,
                            pinnedAt: null,
                            preview: "Hello",
                            projectId: "project-1",
                            runtimeId: "opencode",
                            runtimeSessionId: "runtime-session-1",
                            sessionId: "session-1",
                            title: "Native session",
                            updatedAt: "2026-06-20T00:00:01.000Z",
                            worktreeId: "worktree-1",
                        },
                    ] as T);
                }
                if (command === "ai_load_session_transcript_page") {
                    return Promise.resolve({
                        messages: [
                            {
                                attachments: [],
                                content: "Hello",
                                createdAt: "2026-06-20T00:00:00.000Z",
                                id: "message-1",
                                kind: "assistant",
                                status: "completed",
                            },
                        ],
                        offset: 0,
                        sessionId: "session-1",
                        totalMessages: 1,
                    } as T);
                }
                if (command === "ai_load_session_snapshot") {
                    return Promise.resolve({
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
                        parentSessionId: null,
                        pendingPermission: null,
                        pendingUserInput: null,
                        plan: null,
                        projectId: "project-1",
                        runtimeId: "opencode",
                        runtimeSessionId: "runtime-session-1",
                        sessionId: "session-1",
                        status: "idle",
                        title: "Native session",
                        tokenUsage: null,
                        toolActivity: [],
                        trackedFiles: [],
                        updatedAt: "2026-06-20T00:00:01.000Z",
                        worktreeId: "worktree-1",
                    } as T);
                }
                if (command === "ai_load_review_state") {
                    return Promise.resolve({
                        changedFiles: [],
                        conflicts: [],
                        sessionId: "session-1",
                        trackedFiles: [
                            {
                                currentText: "new\n",
                                diffBase: "old\n",
                                hunks: [],
                                identityKey: "native:session-1::src/main.rs",
                                isText: true,
                                kind: "update",
                                newText: "new\n",
                                oldText: "old\n",
                                path: "src/main.rs",
                                previousPath: null,
                                reviewState: "pending",
                                reversible: true,
                                sessionId: "session-1",
                                toolCallId: null,
                                updatedAt: "2026-06-20T00:00:02.000Z",
                                version: 2,
                            },
                        ],
                        updatedAt: "2026-06-20T00:00:02.000Z",
                    } as T);
                }
                if (command === "ai_list_session_runtime_mappings") {
                    return Promise.resolve([
                        {
                            appSessionId: "session-child",
                            parentAppSessionId: "session-1",
                            parentRuntimeSessionId: "runtime-session-1",
                            runtimeSessionId: "runtime-child",
                        },
                    ] as T);
                }
                return Promise.resolve({ ok: true } as T);
            },
        );
        const gateway = createGateway(client);

        await expect(
            gateway.listSessionHistory({
                projectId: "project-1",
                worktreeId: "worktree-1",
            }),
        ).resolves.toMatchObject([{ sessionId: "session-1" }]);
        await expect(
            gateway.loadSessionTranscriptPage({
                limit: 50,
                offset: 0,
                sessionId: "session-1",
            }),
        ).resolves.toMatchObject({ totalMessages: 1 });
        await expect(gateway.loadSessionSnapshot("session-1")).resolves.toMatchObject({
            runtimeId: "opencode",
            sessionId: "session-1",
            trackedFiles: [{ path: "src/main.rs", version: 2 }],
        });
        await expect(
            gateway.listSessionRuntimeMappingsForParent("session-1"),
        ).resolves.toEqual([
            {
                appSessionId: "session-child",
                parentAppSessionId: "session-1",
                parentRuntimeSessionId: "runtime-session-1",
                runtimeSessionId: "runtime-child",
            },
        ]);
        await gateway.setSessionPinned({ pinned: true, sessionId: "session-1" });
        await gateway.renameSession({ sessionId: "session-1", title: "Renamed" });
        await gateway.deleteSession("session-1");

        expect(client.request).toHaveBeenCalledWith("ai_set_session_pinned", {
            pinned: true,
            sessionId: "session-1",
        });
        expect(client.request).toHaveBeenCalledWith("ai_rename_session", {
            sessionId: "session-1",
            title: "Renamed",
        });
        expect(client.request).toHaveBeenCalledWith("ai_delete_session", {
            sessionId: "session-1",
        });
    });

    it("imports historical tracked files when no native review state exists", async () => {
        const client = createClient();
        const legacyFile = createNativeTrackedFile({
            path: "src/legacy.ts",
        });
        client.request.mockImplementation(
            <T = unknown>(command: string, _args?: unknown): Promise<T> => {
                if (command === "ai_load_session_snapshot") {
                    return Promise.resolve(
                        createNativeSnapshotOutput({
                            trackedFiles: [legacyFile],
                        }) as T,
                    );
                }
                if (command === "ai_load_review_state") {
                    return Promise.resolve({
                        changedFiles: [],
                        conflicts: [],
                        sessionId: "session-1",
                        stateFound: false,
                        trackedFiles: [],
                        updatedAt: "2026-06-20T00:00:03.000Z",
                    } as T);
                }
                if (command === "ai_import_review_state") {
                    const args = _args as {
                        sessionId: string;
                        trackedFiles: readonly unknown[];
                    };
                    return Promise.resolve({
                        changedFiles: [],
                        conflicts: [],
                        sessionId: args.sessionId,
                        stateFound: true,
                        trackedFiles: args.trackedFiles,
                        updatedAt: "2026-06-20T00:00:04.000Z",
                    } as T);
                }
                return Promise.resolve({ ok: true } as T);
            },
        );
        const gateway = createGateway(client);

        await expect(gateway.loadSessionSnapshot("session-1")).resolves.toMatchObject({
            sessionId: "session-1",
            trackedFiles: [{ path: "src/legacy.ts" }],
        });
        expect(client.request).toHaveBeenCalledWith("ai_import_review_state", {
            sessionId: "session-1",
            trackedFiles: [legacyFile],
        });
    });

    it("clears tracked files when native review state is explicitly empty", async () => {
        const client = createClient();
        client.request.mockImplementation(
            <T = unknown>(command: string, _args?: unknown): Promise<T> => {
                void _args;
                if (command === "ai_load_session_snapshot") {
                    return Promise.resolve(
                        createNativeSnapshotOutput({
                            trackedFiles: [
                                createNativeTrackedFile({
                                    path: "src/stale.ts",
                                }),
                            ],
                        }) as T,
                    );
                }
                if (command === "ai_load_review_state") {
                    return Promise.resolve({
                        changedFiles: [],
                        conflicts: [],
                        sessionId: "session-1",
                        stateFound: true,
                        trackedFiles: [],
                        updatedAt: "2026-06-20T00:00:03.000Z",
                    } as T);
                }
                return Promise.resolve({ ok: true } as T);
            },
        );
        const gateway = createGateway(client);

        await expect(gateway.loadSessionSnapshot("session-1")).resolves.toMatchObject({
            sessionId: "session-1",
            trackedFiles: [],
        });
    });

    it("surfaces review conflicts over stale tracked files", async () => {
        const client = createClient();
        client.request.mockImplementation(
            <T = unknown>(command: string, _args?: unknown): Promise<T> => {
                void _args;
                if (command === "ai_reconcile_tracked_files") {
                    return Promise.resolve({
                        changedFiles: [],
                        conflicts: [
                            {
                                externalChangeHash: "hash-1",
                                path: "binary.bin",
                                reason: "binary_file",
                            },
                        ],
                        sessionId: "session-1",
                        trackedFiles: [
                            {
                                currentText: "old pending\n",
                                diffBase: "base\n",
                                hunks: [],
                                identityKey: "native:session-1::binary.bin",
                                isText: true,
                                kind: "update",
                                newText: "old pending\n",
                                oldText: "base\n",
                                path: "binary.bin",
                                previousPath: null,
                                reviewState: "pending",
                                reversible: true,
                                sessionId: "session-1",
                                toolCallId: null,
                                updatedAt: "2026-06-20T00:00:01.000Z",
                                version: 2,
                            },
                        ],
                        updatedAt: "2026-06-20T00:00:02.000Z",
                    } as T);
                }

                return Promise.resolve({ ok: true } as T);
            },
        );
        const gateway = createGateway(client);

        await expect(gateway.reconcileTrackedFiles("session-1")).resolves.toEqual([
            expect.objectContaining({
                conflict: "binary_file",
                currentText: "",
                diffBase: "",
                isText: false,
                path: "binary.bin",
                reviewState: "conflict",
                reversible: false,
            }),
        ]);
    });

    it("reports runtime connection events as diagnostics", () => {
        const client = createClient();
        const onDiagnostic = vi.fn();
        createGateway(client, { onDiagnostic });

        client.emit({
            eventName: "ai://runtime-connection",
            payload: {
                message: null,
                runtimeId: "opencode",
                status: "ready",
                updatedAt: "2026-06-20T00:00:01.000Z",
            },
            type: "event",
        });

        expect(onDiagnostic).toHaveBeenCalledWith(
            "Native AI opencode connection: ready",
        );
    });

    it("emits the local user message and sends prompts to the native backend", async () => {
        const client = createClient();
        const onSessionEvent = vi.fn();
        const gateway = createGateway(client, { onSessionEvent });
        const launch = createLaunch();

        await gateway.prepareSession({
            input: createPrepareInput(),
            launch,
        });
        const promptInput = {
            ...createPromptInput(),
            composerParts: [
                { text: "Review ", type: "text" as const },
                {
                    label: "new-note.md",
                    languageId: "markdown",
                    path: "/workspace/new-note.md",
                    relativePath: "new-note.md",
                    type: "file_mention" as const,
                },
            ],
        };

        await expect(
            gateway.sendPrompt({
                input: promptInput,
                launch,
            }),
        ).resolves.toEqual({
            sessionId: "session-1",
            stopReason: "accepted",
        });

        expect(onSessionEvent).toHaveBeenCalledWith(
            "window-1",
            expect.objectContaining({
                kind: "message-delta",
                content: "Review \u200B«@new-note.md»\u200B",
                delta: "Review \u200B«@new-note.md»\u200B",
                messageId: "user-message-1",
                messageKind: "user",
            }),
        );
        expect(client.request).toHaveBeenCalledWith("ai_send_prompt", {
            messageId: "user-message-1",
            prompt: {
                attachments: [],
                displayText: "Review \u200B«@new-note.md»\u200B",
                text: "Implement the feature.",
            },
            runtimeSessionId: null,
            sessionId: "session-1",
            targetSessionId: null,
        });
    });

    it("does not emit a local user message when the native backend rejects the prompt", async () => {
        const client = createClient();
        client.request.mockRejectedValueOnce(new Error("session busy"));
        const onSessionEvent = vi.fn();
        const gateway = createGateway(client, { onSessionEvent });

        await expect(
            gateway.sendPrompt({
                input: createPromptInput(),
                launch: createLaunch(),
            }),
        ).rejects.toThrow("session busy");

        expect(onSessionEvent).not.toHaveBeenCalled();
    });
});

function createGateway(
    client: ReturnType<typeof createClient>,
    options: Partial<
        Pick<
            NativeAiGatewayOptions,
            | "onDiagnostic"
            | "onRuntimeStatus"
            | "onSessionCatalogPatch"
            | "onSessionEvent"
        >
    > = {},
) {
    return new NativeAiGateway({
        client,
        onDiagnostic: options.onDiagnostic,
        onRuntimeStatus: options.onRuntimeStatus ?? vi.fn(),
        onSessionCatalogPatch: options.onSessionCatalogPatch,
        onSessionEvent: options.onSessionEvent ?? vi.fn(),
    });
}

function createClient() {
    let listener: ((event: NativeBackendEvent) => void) | null = null;
    const request = vi.fn(
        <T = unknown>(command: string, _args?: unknown): Promise<T> => {
            if (command === "ai_prepare_session") {
                return Promise.resolve({
                    projectId: "project-1",
                    runtimeId: "opencode",
                    runtimeSessionId: "runtime-session-1",
                    sessionId: "session-1",
                    status: "idle",
                    title: "Native session",
                    updatedAt: "2026-06-20T00:00:00.000Z",
                    worktreeId: "worktree-1",
                } as T);
            }

            if (command === "ai_load_review_state") {
                const args = _args as { sessionId?: string } | undefined;
                return Promise.resolve({
                    changedFiles: [],
                    conflicts: [],
                    sessionId: args?.sessionId ?? "session-1",
                    stateFound: false,
                    trackedFiles: [],
                    updatedAt: "2026-06-20T00:00:00.000Z",
                } as T);
            }

            if (command === "ai_import_review_state") {
                const args = _args as
                    | { sessionId?: string; trackedFiles?: readonly unknown[] }
                    | undefined;
                return Promise.resolve({
                    changedFiles: [],
                    conflicts: [],
                    sessionId: args?.sessionId ?? "session-1",
                    stateFound: true,
                    trackedFiles: args?.trackedFiles ?? [],
                    updatedAt: "2026-06-20T00:00:00.000Z",
                } as T);
            }

            if (command === "ai_send_prompt") {
                return Promise.resolve({
                    accepted: true,
                    sessionId: "session-1",
                } as T);
            }

            return Promise.resolve({ ok: true } as T);
        },
    );

    return {
        emit(event: NativeBackendEvent) {
            listener?.(event);
        },
        onEvent(callback: (event: NativeBackendEvent) => void) {
            listener = callback;
            return () => {
                listener = null;
            };
        },
        request,
    } as NativeAiGatewayOptions["client"] & {
        readonly emit: (event: NativeBackendEvent) => void;
        readonly request: typeof request;
    };
}

function createNativeSnapshotOutput(
    overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
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
        parentSessionId: null,
        pendingPermission: null,
        pendingUserInput: null,
        plan: null,
        projectId: "project-1",
        runtimeId: "opencode",
        runtimeSessionId: "runtime-session-1",
        sessionId: "session-1",
        status: "idle",
        title: "Native session",
        tokenUsage: null,
        toolActivity: [],
        trackedFiles: [],
        updatedAt: "2026-06-20T00:00:01.000Z",
        worktreeId: "worktree-1",
        ...overrides,
    };
}

function createNativeTrackedFile(
    overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
    const path = typeof overrides.path === "string" ? overrides.path : "src/main.rs";
    return {
        currentText: "new\n",
        diffBase: "old\n",
        hunks: [],
        identityKey: `native:session-1::${path}`,
        isText: true,
        kind: "update",
        newText: "new\n",
        oldText: "old\n",
        path,
        previousPath: null,
        reviewState: "pending",
        reversible: true,
        sessionId: "session-1",
        toolCallId: null,
        updatedAt: "2026-06-20T00:00:02.000Z",
        version: 1,
        ...overrides,
    };
}

function createPrepareInput(): PrepareAiSessionInput {
    return {
        projectId: "project-1",
        runtimeId: "opencode",
        sessionId: "session-1",
        title: "Native session",
        worktreeId: "worktree-1",
    };
}

function createPromptInput(): SendAiPromptInput {
    return {
        additionalRoots: ["/workspace/other"],
        attachments: [],
        messageId: "user-message-1",
        projectId: "project-1",
        prompt: "Implement the feature.",
        runtimeId: "opencode",
        sessionId: "session-1",
        title: "Native session",
        worktreeId: "worktree-1",
    };
}

function createLaunch(): AiSessionLaunchInput {
    const status: AiRuntimeStatus = {
        authMethod: "opencode-login",
        authMethods: [],
        authReady: true,
        authCredentialSource: "external-runtime",
        checkedAt: "2026-06-20T00:00:00.000Z",
        command: "opencode acp",
        hasCustomBinaryPath: false,
        hasGatewayConfig: false,
        hasGatewayUrl: false,
        message: null,
        onboardingRequired: false,
        runtimeId: "opencode",
        source: "path",
        state: "ready",
    };

    return {
        additionalRoots: ["/workspace/other"],
        cwd: "/workspace/project",
        desiredSelections: {
            configOptions: [
                {
                    category: "model",
                    description: null,
                    id: "model",
                    label: "Model",
                    options: [],
                    type: "select",
                    value: "gpt-5",
                },
            ],
            modeId: "build",
            modelId: "gpt-5",
            preferredConfigOptions: {},
        },
        input: {
            additionalRoots: ["/workspace/other"],
            projectId: "project-1",
            runtimeId: "opencode",
            sessionId: "session-1",
            title: "Native session",
            worktreeId: "worktree-1",
        },
        ownerWindowId: "window-1",
        persistedSnapshot: createEmptyAiSessionSnapshot({
            projectId: "project-1",
            runtimeId: "opencode",
            sessionId: "session-1",
            title: "Native session",
            worktreeId: "worktree-1",
        }),
        projectRoot: "/workspace/project",
        resolvedRuntime: {
            args: ["acp"],
            command: "opencode acp",
            env: {
                PATH: "/bin",
                TOKEN: "secret",
                UNDEFINED_VALUE: undefined,
            },
            executable: "opencode",
            status,
        },
    };
}
