import { describe, expect, it, vi } from "vitest";

import type {
    AiOpenTranscriptTail,
    AiSessionSnapshot,
    AiTrackedFile,
    AiRuntimeStatus,
    PrepareAiSessionInput,
    SendAiPromptInput,
} from "@shared/ipc";
import type {
    NativeAiPrepareSessionInput,
    NativeBackendEvent,
} from "@shared/native-backend";

import { createEmptyAiSessionSnapshot } from "@main/ai/persistence";
import type { AiSessionLaunchInput } from "@main/ai/contracts";
import { AI_SESSION_BUSY_MESSAGE } from "@shared/ai-errors";

import {
    NativeAiGateway,
    type NativeAiGatewayOptions,
} from "./ai";
import { NativeBackendError } from "./client";

const TURN_STARTED_AT = "2026-07-18T00:01:00.000Z";

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

    it("attaches an immutable custom launch only to prepare requests", async () => {
        const client = createClient();
        const runtimeId =
            "custom:550e8400-e29b-41d4-a716-446655440000" as const;
        client.request.mockResolvedValueOnce({
            projectId: null,
            runtimeId,
            runtimeSessionId: "runtime-custom-1",
            sessionId: "session-custom-1",
            status: "idle",
            title: "Pi 1",
            updatedAt: "2026-07-24T00:00:00.000Z",
            worktreeId: null,
        });
        const gateway = createGateway(client);
        const baseLaunch = createLaunch();
        const customAcpLaunch = {
            args: [] as const,
            authMode: "external" as const,
            command: "pi-acp",
            configuredEnv: {},
            displayName: "Pi",
            env: { HOME: "/Users/example", PATH: "/usr/bin:/bin" },
            executable: "/opt/homebrew/bin/pi-acp",
            launchFingerprint: "a".repeat(64),
            productProfile: "conservative" as const,
            protocolVersion: "acp-current14" as const,
            revision: 1,
            runtimeId,
            state: "ready" as const,
        };
        const launch: AiSessionLaunchInput = {
            ...baseLaunch,
            input: {
                ...baseLaunch.input,
                projectId: null,
                runtimeId,
                sessionId: "session-custom-1",
                title: "Pi 1",
                worktreeId: null,
            },
            persistedSnapshot: createEmptyAiSessionSnapshot({
                projectId: null,
                runtimeId,
                runtimeSessionId: "runtime-custom-previous",
                sessionId: "session-custom-1",
                title: "Pi 1",
                worktreeId: null,
            }),
            resolvedRuntime: {
                args: [],
                command: "pi-acp",
                customAcpLaunch,
                env: customAcpLaunch.env,
                executable: customAcpLaunch.executable,
                status: {
                    ...baseLaunch.resolvedRuntime.status,
                    authMethod: "external",
                    runtimeId,
                },
            },
        };

        await gateway.prepareSession({
            input: launch.input,
            launch,
        });

        const prepareCall = client.request.mock.calls.find(
            ([command]) => command === "ai_prepare_session",
        );
        expect(prepareCall?.[1]).toMatchObject({
            customAcpContinuationStrategy: null,
            customAcpLaunch,
            persistedRuntimeSessionId: null,
            runtimeId,
            sessionId: "session-custom-1",
        });
    });

    it("preserves the active turn start when a streaming session is prepared again", async () => {
        const client = createClient();
        client.request.mockResolvedValueOnce({
            projectId: "project-1",
            runtimeId: "opencode",
            runtimeSessionId: "runtime-session-1",
            sessionId: "session-1",
            status: "streaming",
            title: "Renamed session",
            updatedAt: "2026-07-09T20:05:00.000Z",
            worktreeId: "worktree-1",
        });
        const gateway = createGateway(client);
        const launch = createLaunch();
        const activeTurnStartedAt = "2026-07-09T20:00:00.000Z";
        const streamingLaunch = {
            ...launch,
            persistedSnapshot: {
                ...launch.persistedSnapshot,
                activeTurnStartedAt,
                status: "streaming" as const,
                updatedAt: "2026-07-09T20:04:00.000Z",
            },
        };

        await expect(
            gateway.prepareSession({
                input: createPrepareInput(),
                launch: streamingLaunch,
            }),
        ).resolves.toMatchObject({
            activeTurnStartedAt,
            status: "streaming",
            updatedAt: "2026-07-09T20:05:00.000Z",
        });
    });

    it("clears a historical closed marker when preparing a live session", async () => {
        const client = createClient();
        const gateway = createGateway(client);
        const launch = {
            ...createLaunch(),
            persistedSnapshot: {
                ...createLaunch().persistedSnapshot,
                closedAt: "2026-07-09T20:00:00.000Z",
            },
        };

        await expect(
            gateway.prepareSession({
                input: createPrepareInput(),
                launch,
            }),
        ).resolves.toMatchObject({
            closedAt: null,
            status: "idle",
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
                    message: "AI runtime process exited: Resource not found",
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
        const onSessionEvent = vi.fn<NativeAiGatewayOptions["onSessionEvent"]>();
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

    it("ignores a stale close without forgetting the reopened session owner", async () => {
        const client = createClient();
        const onSessionEvent = vi.fn<NativeAiGatewayOptions["onSessionEvent"]>();
        const gateway = createGateway(client, { onSessionEvent });
        const launch = createLaunch();

        await gateway.prepareSession({
            input: createPrepareInput(),
            launch,
        });
        client.request.mockResolvedValueOnce({
            projectId: "project-1",
            runtimeId: "opencode",
            runtimeSessionId: "runtime-session-2",
            sessionId: "session-1",
            status: "streaming",
            title: "Native session",
            updatedAt: "2026-06-20T00:00:02.000Z",
            worktreeId: "worktree-1",
        });
        await gateway.prepareSession({
            input: createPrepareInput(),
            launch,
        });
        onSessionEvent.mockClear();

        client.emit({
            eventName: "ai://session-closed",
            payload: {
                runtimeId: "opencode",
                runtimeSessionId: "runtime-session-1",
                sessionId: "session-1",
                updatedAt: "2026-06-20T00:00:03.000Z",
            },
            type: "event",
        });
        client.emit({
            eventName: "ai://message-delta",
            payload: {
                content: "Still streaming",
                delta: "Still streaming",
                messageId: "assistant-1",
                messageKind: "assistant",
                runtimeId: "opencode",
                runtimeSessionId: "runtime-session-2",
                sessionId: "session-1",
                updatedAt: "2026-06-20T00:00:04.000Z",
            },
            type: "event",
        });

        expect(onSessionEvent).toHaveBeenCalledTimes(1);
        expect(onSessionEvent).toHaveBeenCalledWith(
            "window-1",
            expect.objectContaining({
                content: "Still streaming",
                kind: "message-delta",
                runtimeSessionId: "runtime-session-2",
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
        const onSessionEvent = vi.fn<NativeAiGatewayOptions["onSessionEvent"]>();
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
                modelId: "gpt-5",
                reasoningEffort: "high",
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
                modelId: "gpt-5",
                parentSessionId: "session-1",
                reasoningEffort: "high",
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
        onSessionEvent.mockClear();
        await gateway.closeSession("session-1:subagent:runtime-child-1");
        expect(client.request).not.toHaveBeenCalled();
        expect(onSessionEvent).not.toHaveBeenCalled();

        await gateway.cancelSession("session-1:subagent:runtime-child-1");
        expect(client.request).toHaveBeenCalledWith("ai_cancel_session", {
            runtimeSessionId: "runtime-child-1",
            sessionId: "session-1",
            targetSessionId: "session-1:subagent:runtime-child-1",
        });
    });

    it("hydrates persisted subagent mappings before child events arrive", async () => {
        const client = createClient();
        const onSessionEvent = vi.fn<NativeAiGatewayOptions["onSessionEvent"]>();
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

    it("routes nested descendants through the root backend session", async () => {
        const client = createClient();
        const onSessionEvent = vi.fn<NativeAiGatewayOptions["onSessionEvent"]>();
        const gateway = createGateway(client, { onSessionEvent });
        const childSessionId = "session-child";
        const grandchildSessionId = "session-grandchild";
        const launch = {
            ...createLaunch(),
            persistedSubagentSessionMappings: [
                {
                    appSessionId: childSessionId,
                    parentAppSessionId: "session-1",
                    parentRuntimeSessionId: "runtime-session-1",
                    runtimeSessionId: "runtime-child",
                },
                {
                    appSessionId: grandchildSessionId,
                    parentAppSessionId: childSessionId,
                    parentRuntimeSessionId: "runtime-child",
                    runtimeSessionId: "runtime-grandchild",
                },
            ],
        };

        await gateway.prepareSession({
            input: createPrepareInput(),
            launch,
        });

        client.request.mockClear();
        await gateway.sendPrompt({
            input: {
                ...createPromptInput(),
                messageId: "user-message-grandchild",
                sessionId: grandchildSessionId,
            },
            launch,
        });
        expect(client.request).toHaveBeenCalledWith("ai_send_prompt", {
            messageId: "user-message-grandchild",
            prompt: {
                attachments: [],
                displayText: "Implement the feature.",
                text: "Implement the feature.",
            },
            runtimeSessionId: "runtime-grandchild",
            sessionId: "session-1",
            targetSessionId: grandchildSessionId,
        });

        client.request.mockClear();
        onSessionEvent.mockClear();
        await gateway.closeSession(childSessionId);
        expect(client.request).not.toHaveBeenCalled();
        expect(onSessionEvent).not.toHaveBeenCalled();

        await gateway.cancelSession(grandchildSessionId);
        expect(client.request).toHaveBeenCalledWith("ai_cancel_session", {
            runtimeSessionId: "runtime-grandchild",
            sessionId: "session-1",
            targetSessionId: grandchildSessionId,
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
                        reasoningEffort: "high",
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
                if (command === "ai_count_session_history_by_runtime") {
                    return Promise.resolve({ count: 2 } as T);
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
            reasoningEffort: "high",
            runtimeId: "opencode",
            sessionId: "session-1",
            trackedFiles: [],
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
        await expect(
            gateway.countSessionHistoryByRuntime("opencode"),
        ).resolves.toBe(2);
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

    it("routes open-tail checkpoints, recovery and sealing through native storage", async () => {
        const client = createClient();
        const tail = openTranscriptTail();
        client.request.mockImplementation(
            <T = unknown>(command: string): Promise<T> => {
                if (command === "ai_load_open_transcript_tail") {
                    return Promise.resolve(tail as T);
                }
                if (command === "ai_seal_transcript_turn") {
                    return Promise.resolve([
                        {
                            blockId: "session-1:0",
                            endSequence: 1,
                            entryCount: 1,
                            estimatedHeight: 72,
                            estimatedRowCount: 1,
                            firstCreatedAt: TURN_STARTED_AT,
                            lastCreatedAt: TURN_STARTED_AT,
                            revision: 2,
                            sessionId: "session-1",
                            startSequence: 1,
                        },
                    ] as T);
                }
                if (command === "ai_reconcile_terminal_open_transcript_tail") {
                    return Promise.resolve([
                        {
                            blockId: "session-1:0",
                            endSequence: 1,
                            entryCount: 1,
                            estimatedHeight: 72,
                            estimatedRowCount: 1,
                            firstCreatedAt: TURN_STARTED_AT,
                            lastCreatedAt: TURN_STARTED_AT,
                            revision: 2,
                            sessionId: "session-1",
                            startSequence: 1,
                        },
                    ] as T);
                }
                return Promise.resolve({ ok: true } as T);
            },
        );
        const gateway = createGateway(client);
        const checkpoint = {
            entries: tail.entries,
            entryOrder: tail.entryRevisions,
            payloads: tail.payloads,
            removedEntryIds: [],
            sessionId: tail.sessionId,
            terminalStatus: "cancelled" as const,
            turnId: tail.turnId,
        };

        await gateway.checkpointOpenTranscriptTail(checkpoint);
        await expect(gateway.loadOpenTranscriptTail("session-1")).resolves.toEqual(
            tail,
        );
        await expect(
            gateway.sealTranscriptTurn({
                entries: tail.entries,
                payloads: tail.payloads,
                sessionId: tail.sessionId,
                turnId: tail.turnId,
            }),
        ).resolves.toMatchObject([{ blockId: "session-1:0" }]);
        await expect(
            gateway.reconcileTerminalOpenTranscriptTail({
                sessionId: tail.sessionId,
                turnId: tail.turnId,
            }),
        ).resolves.toMatchObject([{ blockId: "session-1:0" }]);

        expect(client.request).toHaveBeenCalledWith(
            "ai_checkpoint_open_transcript_tail",
            checkpoint,
        );
        expect(client.request).toHaveBeenCalledWith(
            "ai_load_open_transcript_tail",
            { sessionId: "session-1" },
        );
        expect(client.request).toHaveBeenCalledWith(
            "ai_reconcile_terminal_open_transcript_tail",
            { sessionId: "session-1", turnId: tail.turnId },
        );
    });

    it("routes history retention pruning and forgets deleted sessions", async () => {
        const client = createClient();
        client.request.mockImplementation(<T = unknown>(command: string): Promise<T> => {
            if (command === "ai_prune_session_history") {
                return Promise.resolve({
                    deletedRootIds: ["session-1"],
                    deletedSessionIds: ["session-1", "session-child"],
                    failedRootIds: [],
                    inspectedSessionCount: 2,
                    protectedTreeCount: 0,
                    invalidMetadataCount: 0,
                    invalidTimestampCount: 0,
                    policyChanged: false,
                } as T);
            }
            return Promise.resolve(undefined as T);
        });
        const gateway = createGateway(client);

        await expect(
            gateway.pruneSessionHistory({
                cutoff: "2026-08-01T12:00:00.000Z",
                protectedSessionIds: ["session-live"],
                retentionDays: 7,
            }),
        ).resolves.toMatchObject({
            deletedSessionIds: ["session-1", "session-child"],
        });

        expect(client.request).toHaveBeenCalledWith(
            "ai_prune_session_history",
            {
                cutoff: "2026-08-01T12:00:00.000Z",
                protectedSessionIds: ["session-live"],
                retentionDays: 7,
            },
        );
    });

    it("exposes versioned paged transcript, payload and migration capabilities", async () => {
        const client = createClient();
        const tail = openTranscriptTail();
        const entry = tail.entries[0];
        const metadata = {
            blockId: "session-1:0",
            endSequence: 1,
            entryCount: 1,
            estimatedHeight: 72,
            estimatedRowCount: 1,
            firstCreatedAt: TURN_STARTED_AT,
            lastCreatedAt: TURN_STARTED_AT,
            revision: 2,
            sessionId: "session-1",
            startSequence: 1,
        };
        client.request.mockImplementation(
            <T = unknown>(command: string): Promise<T> => {
                const outputs: Record<string, unknown> = {
                    ai_get_history_storage_health: {
                        healthy: true,
                        latestError: null,
                        legacyFallbackAvailable: true,
                        migrationManifestExists: false,
                        nativeSessionCount: 1,
                        orphanedSessionDirs: 0,
                        storageVersion: 3,
                    },
                    ai_get_transcript_storage_state: {
                        capabilityVersion: 1,
                        legacyFallbackAvailable: true,
                        migrationManifestExists: false,
                        mode: "block-native",
                        sessionId: "session-1",
                        storageVersion: 3,
                    },
                    ai_load_transcript_block: {
                        ...metadata,
                        capabilityVersion: 1,
                        entries: [entry],
                        transcriptRevision: 2,
                    },
                    ai_load_transcript_block_metadata: {
                        blocks: [metadata],
                        capabilityVersion: 1,
                        sessionId: "session-1",
                        transcriptRevision: 2,
                    },
                    ai_load_transcript_payload: {
                        byteLength: 10,
                        capabilityVersion: 1,
                        contentHash: "abc123",
                        payloadRef: "tail:message:assistant-1",
                        sessionId: "session-1",
                        transcriptRevision: 2,
                        value: { kind: "message" },
                    },
                    ai_migrate_session_history: {
                        completedAt: TURN_STARTED_AT,
                        errors: [],
                        failedSessions: 0,
                        migratedSessions: 1,
                        skippedSessions: 0,
                        startedAt: TURN_STARTED_AT,
                        updatedAt: TURN_STARTED_AT,
                    },
                };
                return Promise.resolve(outputs[command] as T);
            },
        );
        const gateway = createGateway(client, {
            capabilities: {
                commands: [],
                domains: ["ai"],
                events: [],
                features: ["native-ai-transcript-block-v1"],
            },
        });

        expect(gateway.getTranscriptCapability()).toEqual({
            blockNativeVersion: 1,
            legacyFallbackAvailable: true,
        });
        await expect(
            gateway.loadTranscriptBlockMetadata("session-1"),
        ).resolves.toMatchObject({ blocks: [metadata], transcriptRevision: 2 });
        await expect(
            gateway.loadTranscriptBlock("session-1", metadata.blockId),
        ).resolves.toMatchObject({ blockId: metadata.blockId });
        await expect(
            gateway.loadTranscriptPayload({
                maxBytes: 1024,
                payloadRef: "tail:message:assistant-1",
                sessionId: "session-1",
            }),
        ).resolves.toMatchObject({ contentHash: "abc123" });
        await expect(
            gateway.getTranscriptStorageState("session-1"),
        ).resolves.toMatchObject({ mode: "block-native" });
        await expect(gateway.getHistoryStorageHealth()).resolves.toMatchObject({
            healthy: true,
        });
        await expect(gateway.migrateSessionHistory({ limit: 1 })).resolves.toMatchObject({
            migratedSessions: 1,
        });

        expect(createGateway(createClient()).getTranscriptCapability()).toEqual({
            blockNativeVersion: null,
            legacyFallbackAvailable: true,
        });
    });

    it("rejects paged transcript responses owned by another session", async () => {
        const client = createClient();
        client.request.mockResolvedValue({
            blocks: [],
            capabilityVersion: 1,
            sessionId: "session-2",
            transcriptRevision: 0,
        });
        const gateway = createGateway(client);

        await expect(
            gateway.loadTranscriptBlockMetadata("session-1"),
        ).rejects.toThrow("belongs to another session");
    });

    it("batches payloads only when the negotiated backend command is available", async () => {
        const payload = {
            byteLength: 10,
            capabilityVersion: 1,
            contentHash: "abc123",
            payloadRef: "payload:assistant-1",
            sessionId: "session-1",
            transcriptRevision: 2,
            value: { kind: "message" },
        };
        const batchClient = createClient();
        batchClient.request.mockResolvedValue({
            capabilityVersion: 1,
            payloads: [payload],
            sessionId: "session-1",
            transcriptRevision: 2,
        });
        const batchGateway = createGateway(batchClient, {
            capabilities: {
                commands: ["ai_load_transcript_payloads"],
                domains: ["ai"],
                events: [],
                features: ["native-ai-transcript-block-v1"],
            },
        });

        await expect(
            batchGateway.loadTranscriptPayloads({
                payloadRefs: [payload.payloadRef],
                sessionId: "session-1",
            }),
        ).resolves.toMatchObject({ payloads: [payload] });
        expect(batchClient.request).toHaveBeenCalledWith(
            "ai_load_transcript_payloads",
            expect.any(Object),
        );

        const legacyClient = createClient();
        legacyClient.request.mockResolvedValue(payload);
        const legacyGateway = createGateway(legacyClient, {
            capabilities: {
                commands: [],
                domains: ["ai"],
                events: [],
                features: ["native-ai-transcript-block-v1"],
            },
        });
        await legacyGateway.loadTranscriptPayloads({
            payloadRefs: [payload.payloadRef],
            sessionId: "session-1",
        });
        expect(legacyClient.request).toHaveBeenCalledWith(
            "ai_load_transcript_payload",
            expect.any(Object),
        );
    });

    it("does not hydrate review state when loading historical snapshots", async () => {
        const client = createClient();
        const legacyFile = createNativeTrackedFile({
            path: "src/legacy.ts",
        });
        client.request.mockImplementation(
            <T = unknown>(command: string): Promise<T> => {
                if (command === "ai_load_session_snapshot") {
                    return Promise.resolve(
                        createNativeSnapshotOutput({
                            trackedFiles: [legacyFile],
                        }) as T,
                    );
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

    it("clears tracked files from restored historical snapshots", async () => {
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
                return Promise.resolve({ ok: true } as T);
            },
        );
        const gateway = createGateway(client);

        await expect(gateway.loadSessionSnapshot("session-1")).resolves.toMatchObject({
            sessionId: "session-1",
            trackedFiles: [],
        });
    });

    it("rejects a tracked file through the stateless native disk executor", async () => {
        const client = createClient();
        const gateway = createGateway(client);
        const trackedFile = createIpcTrackedFile({
            path: "src/main.rs",
            version: 2,
        });
        const snapshot = createIpcSnapshot({
            trackedFiles: [trackedFile],
        });

        await expect(
            gateway.rejectTrackedFile({
                context: {
                    additionalRoots: [],
                    cwd: "/workspace/project",
                    ownerWindowId: "window-1",
                    projectRoot: "/workspace/project",
                    snapshot,
                },
                input: {
                    path: "src/main.rs",
                    sessionId: "session-1",
                },
            }),
        ).resolves.toMatchObject({ snapshot });

        expect(client.request).toHaveBeenCalledWith("ai_reject_tracked_file", {
            expectedVersion: 2,
            reviewRoot: "/workspace/project",
            sessionId: "session-1",
            trackedFile,
        });
    });

    it("validates native review mutations against the loaded delta", async () => {
        const client = createClient();
        const gateway = createGateway(client);
        const trackedFile = createIpcTrackedFile({
            nativeReviewDeltaId: "delta-1",
            path: "src/main.rs",
            version: 5,
        });
        const delta = {
            deltaId: "delta-1",
            files: [
                {
                    observedHash: "hash-1",
                    path: "src/main.rs",
                    state: "ready" as const,
                },
            ],
            inputRevision: 4,
            revision: 5,
            sessionId: "session-1",
            state: "ready" as const,
            toolCallId: "tool-1",
            updatedAt: "2026-04-14T00:00:00.000Z",
            workCycleId: "cycle-1",
        };
        const snapshot = createIpcSnapshot({
            reviewDeltas: [delta],
            trackedFiles: [trackedFile],
        });

        await gateway.rejectTrackedFile({
            context: {
                additionalRoots: [],
                cwd: "/workspace/project",
                ownerWindowId: "window-1",
                projectRoot: "/workspace/project",
                snapshot,
            },
            input: {
                path: "src/main.rs",
                sessionId: "session-1",
            },
        });

        expect(client.request).toHaveBeenCalledWith("ai_reject_tracked_file", {
            expectedVersion: 5,
            reference: {
                deltaId: delta.deltaId,
                expectedRevision: delta.revision,
                inputRevision: delta.inputRevision,
                observedHashes: delta.files,
                sessionId: delta.sessionId,
                toolCallId: delta.toolCallId,
                workCycleId: delta.workCycleId,
            },
            reviewRoot: "/workspace/project",
            sessionId: "session-1",
            trackedFile,
        });
    });

    it("rejects all tracked files through the stateless native disk executor", async () => {
        const client = createClient();
        const gateway = createGateway(client);
        const firstFile = createIpcTrackedFile({ path: "a.ts" });
        const secondFile = createIpcTrackedFile({ path: "b.ts" });
        const snapshot = createIpcSnapshot({
            trackedFiles: [firstFile, secondFile],
        });

        await gateway.rejectAllTrackedFiles({
            context: {
                additionalRoots: [],
                cwd: "/workspace/project",
                ownerWindowId: "window-1",
                projectRoot: "/workspace/project",
                snapshot,
            },
            input: "session-1",
        });

        expect(client.request).toHaveBeenCalledWith("ai_reject_all_tracked_files", {
            reviewRoot: "/workspace/project",
            sessionId: "session-1",
            trackedFiles: [firstFile, secondFile],
        });
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

    it("ignores missing sessions during shutdown cleanup", async () => {
        const client = createClient();
        const onDiagnostic = vi.fn();
        const gateway = createGateway(client, { onDiagnostic });

        await gateway.prepareSession({
            input: createPrepareInput(),
            launch: createLaunch(),
        });
        client.request.mockRejectedValueOnce(
            new NativeBackendError({
                code: "ai_session_not_found",
                details: null,
                message: "AI session `session-1` was not found.",
                retryable: false,
            }),
        );

        gateway.close();
        await Promise.resolve();
        await Promise.resolve();

        expect(onDiagnostic).not.toHaveBeenCalledWith(
            expect.stringContaining("shutdown cleanup failed"),
        );
    });

    it("emits the local user message and sends prompts to the native backend", async () => {
        const client = createClient();
        const onSessionEvent =
            vi.fn<NativeAiGatewayOptions["onSessionEvent"]>();
        const gateway = createGateway(client, { onSessionEvent });
        const launch = createLaunch();

        await gateway.prepareSession({
            input: createPrepareInput(),
            launch,
        });
        const attachment = {
            dataBase64: "aGVsbG8=",
            id: "image-1",
            mimeType: "image/png",
            name: "capture.png",
            sizeBytes: 5,
        };
        const promptInput = {
            ...createPromptInput(),
            attachments: [attachment],
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

        const startedEvent = onSessionEvent.mock.calls
            .map(([, event]) => event)
            .find((event) => event.kind === "message-started");
        expect(startedEvent?.kind).toBe("message-started");
        if (!startedEvent || startedEvent.kind !== "message-started") {
            throw new Error("Expected a local user message-started event.");
        }
        expect(startedEvent.message.attachments).toEqual([attachment]);
        expect(startedEvent.message.id).toBe("user-message-1");
        expect(startedEvent.message.kind).toBe("user");
        expect(onSessionEvent).toHaveBeenCalledWith(
            "window-1",
            expect.objectContaining({
                kind: "message-delta",
                content: "Review \u200B«file|new-note.md|new-note.md»\u200B",
                delta: "Review \u200B«file|new-note.md|new-note.md»\u200B",
                messageId: "user-message-1",
                messageKind: "user",
            }),
        );
        expect(client.request).toHaveBeenCalledWith("ai_send_prompt", {
            messageId: "user-message-1",
            prompt: {
                attachments: [attachment],
                displayText:
                    "Review \u200B«file|new-note.md|new-note.md»\u200B",
                text: "Implement the feature.",
            },
            runtimeSessionId: null,
            sessionId: "session-1",
            targetSessionId: null,
        });
    });

    it("maps native session busy rejections to the IPC-safe busy marker", async () => {
        const client = createClient();
        client.request.mockRejectedValueOnce(
            new NativeBackendError({
                code: "ai_session_busy",
                details: {
                    sessionId: "session-1",
                },
                message: "AI session `session-1` is busy.",
                retryable: false,
            }),
        );
        const onSessionEvent = vi.fn<NativeAiGatewayOptions["onSessionEvent"]>();
        const gateway = createGateway(client, { onSessionEvent });

        await expect(
            gateway.sendPrompt({
                input: createPromptInput(),
                launch: createLaunch(),
            }),
        ).rejects.toThrow(AI_SESSION_BUSY_MESSAGE);

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
            | "capabilities"
        >
    > = {},
) {
    return new NativeAiGateway({
        capabilities: options.capabilities,
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
        <T = unknown>(
            command: string,
            args?: Record<string, unknown>,
        ): Promise<T> => {
            void args;
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

function createIpcTrackedFile(
    overrides: Partial<AiTrackedFile> = {},
): AiTrackedFile {
    return createNativeTrackedFile(overrides) as unknown as AiTrackedFile;
}

function createIpcSnapshot(
    overrides: Partial<AiSessionSnapshot> = {},
): AiSessionSnapshot {
    return {
        ...createEmptyAiSessionSnapshot({
            projectId: "project-1",
            runtimeId: "opencode",
            sessionId: "session-1",
            title: "Native session",
            worktreeId: "worktree-1",
        }),
        runtimeSessionId: "runtime-session-1",
        status: "idle",
        updatedAt: "2026-06-20T00:00:01.000Z",
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

function openTranscriptTail(): AiOpenTranscriptTail {
    return {
        entries: [
            {
                createdAt: TURN_STARTED_AT,
                id: "message:assistant-1",
                kind: "message",
                payloadRef: "tail:message:assistant-1",
                sequence: 1,
                sessionId: "session-1",
                summary: {
                    label: "Assistant",
                    preview: "Answer",
                    status: "streaming",
                },
                updatedAt: TURN_STARTED_AT,
            },
        ],
        entryRevisions: [
            {
                entryId: "message:assistant-1",
                entryRevision: 1,
                ordinal: 0,
            },
        ],
        payloads: [
            {
                payloadRef: "tail:message:assistant-1",
                value: {
                    kind: "message",
                    message: {
                        attachments: [],
                        content: "Answer",
                        createdAt: TURN_STARTED_AT,
                        id: "assistant-1",
                        kind: "assistant",
                        status: "streaming",
                    },
                },
            },
        ],
        revision: 1,
        sessionId: "session-1",
        terminalStatus: null,
        turnId: TURN_STARTED_AT,
        updatedAt: TURN_STARTED_AT,
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
