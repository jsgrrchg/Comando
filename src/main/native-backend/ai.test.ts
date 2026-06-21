import { describe, expect, it, vi } from "vitest";

import type {
    AiRuntimeStatus,
    PrepareAiSessionInput,
    SendAiPromptInput,
} from "@shared/ipc";
import type {
    NativeAiPrepareSessionInput,
    NativeBackendEvent,
} from "@shared/native-backend";

import { createEmptyAiSessionSnapshot } from "@main/ai/persistence";
import type { AiWorkerSessionLaunchInput } from "@main/ai/contracts";

import {
    NATIVE_AI_ENABLED_ENV,
    NATIVE_AI_RUNTIMES_ENV,
    NativeAiGateway,
    type NativeAiGatewayOptions,
    shouldUseNativeAi,
    shouldUseNativeAiRuntime,
} from "./ai";

describe("native AI flags", () => {
    it("requires explicit opt-in and defaults to the full PR 9 runtime matrix", () => {
        expect(shouldUseNativeAi({})).toBe(false);
        expect(
            shouldUseNativeAi({ [NATIVE_AI_ENABLED_ENV]: "1" }),
        ).toBe(true);
        expect(
            shouldUseNativeAiRuntime("opencode", {
                [NATIVE_AI_ENABLED_ENV]: "1",
            }),
        ).toBe(true);
        expect(
            shouldUseNativeAiRuntime("codex", {
                [NATIVE_AI_ENABLED_ENV]: "1",
            }),
        ).toBe(true);
        expect(
            shouldUseNativeAiRuntime("claude", {
                [NATIVE_AI_ENABLED_ENV]: "1",
            }),
        ).toBe(true);
        expect(
            shouldUseNativeAiRuntime("grok", {
                [NATIVE_AI_ENABLED_ENV]: "1",
            }),
        ).toBe(true);
        expect(
            shouldUseNativeAiRuntime("kilo", {
                [NATIVE_AI_ENABLED_ENV]: "1",
            }),
        ).toBe(true);
        expect(
            shouldUseNativeAiRuntime("opencode", {
                [NATIVE_AI_ENABLED_ENV]: "1",
                [NATIVE_AI_RUNTIMES_ENV]: "codex",
            }),
        ).toBe(false);
        expect(
            shouldUseNativeAiRuntime("opencode", {
                [NATIVE_AI_ENABLED_ENV]: "1",
                [NATIVE_AI_RUNTIMES_ENV]: "opencode",
            }),
        ).toBe(true);
    });
});

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
        expect(payload.launch).toMatchObject({
            additionalRoots: ["/workspace/other"],
            args: ["acp"],
            authCredentialSource: "external-runtime",
            authHandshake: null,
            authMethod: "opencode-login",
            cwd: "/workspace/project",
            desiredSelections: {
                configOptions: { model: "gpt-5" },
                modeId: "build",
                modelId: "gpt-5",
            },
            env: { PATH: "/bin", TOKEN: "secret" },
            executable: "opencode",
            ownerWindowId: "window-1",
            persistedRuntimeSessionId: null,
            persistedSubagentSessionMappings: [],
            projectId: "project-1",
            projectRoot: "/workspace/project",
            runtimeId: "opencode",
            worktreeId: "worktree-1",
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
                text: "Implement the feature.",
            },
            runtimeSessionId: "runtime-child-1",
            sessionId: "session-1",
            targetSessionId: childSessionId,
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

    it("emits the local user message and sends prompts to the native backend", async () => {
        const client = createClient();
        const onSessionEvent = vi.fn();
        const gateway = createGateway(client, { onSessionEvent });
        const launch = createLaunch();

        await gateway.prepareSession({
            input: createPrepareInput(),
            launch,
        });
        await expect(
            gateway.sendPrompt({
                input: createPromptInput(),
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
                messageId: "user-message-1",
                messageKind: "user",
            }),
        );
        expect(client.request).toHaveBeenCalledWith("ai_send_prompt", {
            messageId: "user-message-1",
            prompt: {
                attachments: [],
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
        env: { [NATIVE_AI_ENABLED_ENV]: "1" },
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
            void _args;

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

function createLaunch(): AiWorkerSessionLaunchInput {
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
