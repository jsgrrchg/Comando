import { describe, expect, it, vi } from "vitest";

import type {
    AiRuntimeStatus,
    PrepareAiSessionInput,
    SendAiPromptInput,
} from "@shared/ipc";
import type { NativeBackendEvent } from "@shared/native-backend";

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

        expect(client.request).toHaveBeenCalledWith(
            "ai_prepare_session",
            expect.objectContaining({
                configOptions: { model: "gpt-5" },
                cwd: "/workspace/project",
                launch: expect.objectContaining({
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
                    projectId: "project-1",
                    projectRoot: "/workspace/project",
                    runtimeId: "opencode",
                    worktreeId: "worktree-1",
                }),
                modeId: "build",
                modelId: "gpt-5",
                runtimeId: "opencode",
                sessionId: "session-1",
                windowId: "window-1",
            }),
        );
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
            sessionId: "session-1",
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
        Pick<NativeAiGatewayOptions, "onRuntimeStatus" | "onSessionEvent">
    > = {},
) {
    return new NativeAiGateway({
        client,
        env: { [NATIVE_AI_ENABLED_ENV]: "1" },
        onRuntimeStatus: options.onRuntimeStatus ?? vi.fn(),
        onSessionEvent: options.onSessionEvent ?? vi.fn(),
    });
}

function createClient() {
    let listener: ((event: NativeBackendEvent) => void) | null = null;
    const request = vi.fn(async <T = unknown>(command: string): Promise<T> => {
        if (command === "ai_prepare_session") {
            return {
                projectId: "project-1",
                runtimeId: "opencode",
                runtimeSessionId: "runtime-session-1",
                sessionId: "session-1",
                status: "idle",
                title: "Native session",
                updatedAt: "2026-06-20T00:00:00.000Z",
                worktreeId: "worktree-1",
            } as T;
        }

        if (command === "ai_send_prompt") {
            return {
                accepted: true,
                sessionId: "session-1",
            } as T;
        }

        return { ok: true } as T;
    });

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
