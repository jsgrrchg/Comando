import fs from "node:fs/promises";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_IMAGE_ATTACHMENTS } from "@shared/ai-attachments";
import type {
    AiPermissionRequest,
    AiRuntimeStatus,
    AiSessionPatchChanges,
    AiSessionSnapshot,
    AiToolActivity,
    AiTrackedFile,
} from "@shared/ipc";
import { computeDiffHunks } from "@shared/ai-tracked-file";

import {
    AI_SESSION_STREAMING_FLUSH_MS,
    CODEX_ACP_PLAN_TITLE_KEY,
    CODEX_ACP_STATUS_EVENT_TYPE_KEY,
    CODEX_ACP_TURN_EVENT_TYPE_KEY,
    CODEX_ACP_TURN_ID_KEY,
    CODEX_ACP_TURN_LIFECYCLE_EVENT_TYPE,
    CODEX_ACP_TURN_STARTED_EVENT_TYPE,
    CODEX_ACP_USER_INPUT_RESPONSE_PREFIX,
    type AiWorkerEventMessage,
    type AiWorkerSessionLaunchInput,
} from "./contracts";

const initializeMock = vi.fn(() => Promise.resolve({}));
const authenticateMock = vi.fn(() => Promise.resolve({}));
type MockSessionCatalogResponse = {
    readonly configOptions: readonly Record<string, unknown>[];
    readonly modes: unknown;
    readonly models: unknown;
};
type MockNewSessionResponse = MockSessionCatalogResponse & {
    readonly sessionId: string;
};
const loadSessionMock = vi.fn<() => Promise<MockSessionCatalogResponse>>(() =>
    Promise.resolve({
        configOptions: [],
        modes: [],
        models: [],
    }),
);
const resumeSessionMock = vi.fn<() => Promise<MockSessionCatalogResponse>>(() =>
    Promise.resolve({
        configOptions: [],
        modes: [],
        models: [],
    }),
);
const promptMock = vi.fn(() =>
    Promise.resolve({
        stopReason: "completed",
    }),
);
const closeRuntimeSessionMock = vi.fn(() => Promise.resolve({}));
const cancelRuntimeSessionMock = vi.fn(() => Promise.resolve({}));
const setSessionConfigOptionMock = vi.fn(
    (params: {
        readonly configId: string;
        readonly sessionId: string;
        readonly type?: "boolean";
        readonly value: boolean | string;
    }) =>
        Promise.resolve({
            configOptions:
                params.configId === "model" && typeof params.value === "string"
                    ? createCodexCatalogResponse({
                          modelId: params.value,
                      }).configOptions
                    : [],
        }),
);
const unstableSetSessionModelMock = vi.fn(() => Promise.resolve({}));
let exposeLegacySetSessionModelMock = true;
type MockAcpClient = {
    createTerminal: (params: {
        readonly args?: readonly string[];
        readonly command: string;
        readonly cwd?: string | null;
        readonly env?: readonly { readonly name: string; readonly value: string }[];
        readonly outputByteLimit?: number | null;
        readonly sessionId: string;
    }) => Promise<{ terminalId: string }>;
    killTerminal: (params: {
        readonly sessionId: string;
        readonly terminalId: string;
    }) => Promise<Record<string, never>>;
    readTextFile: (params: {
        readonly limit?: number;
        readonly line?: number;
        readonly path: string;
        readonly sessionId?: string;
    }) => Promise<{ content: string }>;
    requestPermission: (params: {
        readonly options: readonly {
            readonly kind:
                | "allow_always"
                | "allow_once"
                | "reject_always"
                | "reject_once";
            readonly name: string;
            readonly optionId: string;
        }[];
        readonly sessionId: string;
        readonly toolCall: {
            readonly rawInput?: Record<string, unknown> | null;
            readonly status: string;
            readonly title?: string | null;
            readonly toolCallId: string;
        };
    }) => Promise<{
        readonly outcome:
            | {
                  readonly optionId: string;
                  readonly outcome: "selected";
              }
            | {
                  readonly outcome: "cancelled";
              };
    }>;
    releaseTerminal: (params: {
        readonly sessionId: string;
        readonly terminalId: string;
    }) => Promise<Record<string, never>>;
    sessionUpdate: (params: {
        readonly _meta?: Record<string, unknown> | null;
        readonly sessionId: string;
        readonly update: {
            readonly _meta?: Record<string, unknown> | null;
            readonly sessionUpdate: string;
            readonly [key: string]: unknown;
        };
    }) => Promise<void>;
    terminalOutput: (params: {
        readonly sessionId: string;
        readonly terminalId: string;
    }) => Promise<{
        exitStatus?: {
            readonly exitCode?: number | null;
            readonly signal?: string | null;
        } | null;
        output: string;
        truncated: boolean;
    }>;
    waitForTerminalExit: (params: {
        readonly sessionId: string;
        readonly terminalId: string;
    }) => Promise<{
        readonly exitCode?: number | null;
        readonly signal?: string | null;
    }>;
    writeTextFile: (params: {
        readonly content: string;
        readonly path: string;
        readonly sessionId?: string;
    }) => Promise<Record<string, never>>;
};

type MockAcpClientFactory = () => MockAcpClient;
let latestClientFactory: MockAcpClientFactory | null = null;
const newSessionMock = vi.fn<() => Promise<MockNewSessionResponse>>(() =>
    Promise.resolve({
        configOptions: [],
        modes: [],
        models: [],
        sessionId: "runtime-session-2",
    }),
);
function createMockChildProcess() {
    const emitter = new EventEmitter();
    const child = {
        emit: (event: string, ...args: unknown[]) => emitter.emit(event, ...args),
        kill: vi.fn(() => true),
        off: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
            emitter.off(event, listener);
            return child;
        }),
        on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
            emitter.on(event, listener);
            return child;
        }),
        once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
            emitter.once(event, listener);
            return child;
        }),
        stderr: new PassThrough(),
        stdin: new PassThrough(),
        stdout: new PassThrough(),
    };
    return child;
}

type MockChildProcess = ReturnType<typeof createMockChildProcess>;
let spawnedChildren: MockChildProcess[] = [];
const spawnMock = vi.fn(() => {
    const child = createMockChildProcess();
    spawnedChildren.push(child);
    return child;
});

vi.mock("node:child_process", () => ({
    spawn: spawnMock,
}));

vi.mock("@agentclientprotocol/sdk", () => ({
    ClientSideConnection: class MockClientSideConnection {
        constructor(
            clientFactory: typeof latestClientFactory,
            stream: unknown,
        ) {
            void stream;
            latestClientFactory = clientFactory;
            if (exposeLegacySetSessionModelMock) {
                this.unstable_setSessionModel = unstableSetSessionModelMock;
            }
        }

        initialize = initializeMock;
        authenticate = authenticateMock;
        cancel = cancelRuntimeSessionMock;
        loadSession = loadSessionMock;
        resumeSession = resumeSessionMock;
        newSession = newSessionMock;
        prompt = promptMock;
        closeSession = closeRuntimeSessionMock;
        setSessionConfigOption = setSessionConfigOptionMock;
        unstable_setSessionModel?: typeof unstableSetSessionModelMock;
    },
    PROTOCOL_VERSION: "test-protocol-version",
    ndJsonStream: vi.fn(() => ({})),
}));

const { AiWorkerRuntime } = await import("./worker-runtime");

describe("AiWorkerRuntime prepareSession", () => {
    beforeEach(() => {
        initializeMock.mockClear();
        initializeMock.mockResolvedValue({});
        authenticateMock.mockClear();
        authenticateMock.mockResolvedValue({});
        loadSessionMock.mockClear();
        loadSessionMock.mockResolvedValue({
            configOptions: [],
            modes: [],
            models: [],
        });
        resumeSessionMock.mockClear();
        resumeSessionMock.mockResolvedValue({
            configOptions: [],
            modes: [],
            models: [],
        });
        promptMock.mockClear();
        newSessionMock.mockClear();
        closeRuntimeSessionMock.mockClear();
        cancelRuntimeSessionMock.mockClear();
        setSessionConfigOptionMock.mockClear();
        unstableSetSessionModelMock.mockClear();
        exposeLegacySetSessionModelMock = true;
        spawnMock.mockClear();
        spawnedChildren = [];
        latestClientFactory = null;
    });

    it("clears persisted lastError after a successful restore", async () => {
        const readyStatus: AiRuntimeStatus = {
            authMethod: "chatgpt",
            authMethods: [],
            authReady: true,
            checkedAt: "2026-04-15T00:00:00.000Z",
            command: "mock-codex-acp",
            hasCustomBinaryPath: false,
            hasGatewayConfig: false,
            hasGatewayUrl: false,
            message: null,
            onboardingRequired: false,
            runtimeId: "codex",
            source: "bundled",
            state: "ready",
        };
        const persistedSnapshot: AiSessionSnapshot = {
            availableCommands: [],
            configOptions: [],
            lastError:
                "2026-04-15T22:23:13.719838Z ERROR codex_core::codex: failed to load skill",
            messages: [],
            modeId: null,
            modes: [],
            modelId: null,
            models: [],
            pendingPermission: null,
            pendingUserInput: null,
            plan: null,
            projectId: null,
            runtimeId: "codex",
            runtimeSessionId: "runtime-session-1",
            sessionId: "session-1",
            status: "error",
            title: "Codex 1",
            tokenUsage: null,
            toolActivity: [],
            trackedFiles: [],
            updatedAt: "2026-04-15T22:23:13.719838Z",
            worktreeId: null,
        };
        const emittedEvents: AiWorkerEventMessage[] = [];
        const runtime = new AiWorkerRuntime({
            emitEvent: (event) => {
                emittedEvents.push(event);
            },
        });
        const launch: AiWorkerSessionLaunchInput = {
            additionalRoots: [],
            cwd: process.cwd(),
            desiredSelections: {
                configOptions: [],
                modeId: null,
                modelId: null,
                preferredConfigOptions: {},
            },
            input: {
                projectId: null,
                runtimeId: "codex",
                sessionId: "session-1",
                title: "Codex 1",
                worktreeId: null,
            },
            ownerWindowId: "window-1",
            persistedSnapshot,
            projectRoot: null,
            resolvedRuntime: {
                args: [],
                command: "mock-codex-acp",
                env: process.env,
                executable: "mock-codex-acp",
                status: readyStatus,
            },
        };

        const snapshot = (await runtime.dispatchMethod("ai.prepareSession", {
            input: launch.input,
            launch,
        })) as AiSessionSnapshot;

        expect(loadSessionMock).toHaveBeenCalledWith({
            additionalDirectories: undefined,
            cwd: process.cwd(),
            mcpServers: [],
            sessionId: "runtime-session-1",
        });
        expect(snapshot.lastError).toBeNull();
        expect(snapshot.status).toBe("idle");
        expect(emittedEvents.some((event) => event.event === "ai.snapshot.updated")).toBe(
            true,
        );
        expect(
            emittedEvents.some(
                (event) =>
                    event.event === "ai.session.event" &&
                    event.payload.event.kind === "session-info",
            ),
        ).toBe(true);
    });

    it("reuses an in-flight session startup when a prompt arrives before prepare finishes", async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        let releaseNewSession: (value: MockNewSessionResponse) => void =
            () => {};
        let newSessionStarted: (() => void) | null = null;
        const newSessionStartedPromise = new Promise<void>((resolve) => {
            newSessionStarted = resolve;
        });
        const releaseNewSessionPromise = new Promise<MockNewSessionResponse>(
            (resolve) => {
                releaseNewSession = resolve;
            },
        );
        newSessionMock.mockImplementationOnce(async () => {
            newSessionStarted?.();
            return await releaseNewSessionPromise;
        });
        const baseLaunch = createLaunch({
            cwd: tempDir,
            projectRoot: tempDir,
            title: "Fresh Codex session",
        });
        const launch: AiWorkerSessionLaunchInput = {
            ...baseLaunch,
            persistedSnapshot: {
                ...baseLaunch.persistedSnapshot,
                runtimeSessionId: null,
            },
        };
        const runtime = new AiWorkerRuntime({
            emitEvent: () => {},
        });

        const preparePromise = runtime.dispatchMethod("ai.prepareSession", {
            input: launch.input,
            launch,
        });
        await newSessionStartedPromise;

        await expect(
            runtime.dispatchMethod("ai.sendPrompt", {
                input: {
                    attachments: [],
                    composerParts: [
                        {
                            text: "hello",
                            type: "text",
                        },
                    ],
                    projectId: null,
                    prompt: "hello",
                    runtimeId: "codex",
                    sessionId: "session-1",
                    title: "Fresh Codex session",
                    worktreeId: null,
                },
                launch,
            }),
        ).rejects.toThrow("[ai:session-busy]");

        expect(spawnMock).toHaveBeenCalledTimes(1);
        expect(newSessionMock).toHaveBeenCalledTimes(1);
        expect(promptMock).not.toHaveBeenCalled();

        releaseNewSession({
            configOptions: [],
            modes: [],
            models: [],
            sessionId: "runtime-session-1",
        });
        const snapshot = (await preparePromise) as AiSessionSnapshot;

        expect(snapshot.runtimeSessionId).toBe("runtime-session-1");
        expect(spawnMock).toHaveBeenCalledTimes(1);
        expect(newSessionMock).toHaveBeenCalledTimes(1);
    });

    it("resumes persisted runtime sessions without replaying history when advertised", async () => {
        initializeMock.mockResolvedValueOnce({
            agentCapabilities: {
                sessionCapabilities: {
                    resume: {},
                },
            },
        });
        resumeSessionMock.mockResolvedValueOnce(
            createCodexCatalogResponse({
                modelId: "gpt-5-mini",
            }),
        );
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        const persistedSnapshot: AiSessionSnapshot = {
            availableCommands: [],
            configOptions: [],
            lastError: null,
            messages: [
                {
                    attachments: [],
                    content: "Persisted user message",
                    createdAt: "2026-04-15T22:23:13.719838Z",
                    id: "persisted-user-message",
                    kind: "user",
                    status: "completed",
                },
                {
                    attachments: [],
                    content: "Persisted assistant message",
                    createdAt: "2026-04-15T22:23:14.719838Z",
                    id: "persisted-assistant-message",
                    kind: "assistant",
                    status: "completed",
                },
            ],
            modeId: null,
            modes: [],
            modelId: null,
            models: [],
            pendingPermission: null,
            pendingUserInput: null,
            plan: null,
            projectId: null,
            runtimeId: "codex",
            runtimeSessionId: "runtime-session-1",
            sessionId: "session-1",
            status: "idle",
            title: "Resumed session",
            tokenUsage: null,
            toolActivity: [],
            trackedFiles: [],
            updatedAt: "2026-04-15T22:23:13.719838Z",
            worktreeId: null,
        };
        const emittedEvents: AiWorkerEventMessage[] = [];
        const runtime = new AiWorkerRuntime({
            emitEvent: (event) => {
                emittedEvents.push(event);
            },
        });
        const launch = createLaunch({
            cwd: tempDir,
            persistedSnapshot,
            projectRoot: tempDir,
            title: "Resumed session",
        });

        const snapshot = (await runtime.dispatchMethod("ai.prepareSession", {
            input: launch.input,
            launch,
        })) as AiSessionSnapshot;

        expect(resumeSessionMock).toHaveBeenCalledWith({
            additionalDirectories: undefined,
            cwd: tempDir,
            mcpServers: [],
            sessionId: "runtime-session-1",
        });
        expect(loadSessionMock).not.toHaveBeenCalled();
        expect(snapshot.runtimeSessionId).toBe("runtime-session-1");
        expect(snapshot.messages.map((message) => message.content)).toEqual([
            "Persisted user message",
            "Persisted assistant message",
        ]);
        expect(snapshot.modelId).toBe("gpt-5-mini");

        await runtime.dispatchMethod("ai.sendPrompt", {
            input: {
                attachments: [],
                composerParts: [
                    {
                        text: "Continue",
                        type: "text",
                    },
                ],
                projectId: null,
                prompt: "Continue",
                sessionId: "session-1",
                title: "Resumed session",
                worktreeId: null,
            },
            launch,
        });

        expect(promptMock).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: "runtime-session-1",
            }),
        );
    });

    it("loads non-Codex persisted sessions with replay even when resume is advertised", async () => {
        initializeMock.mockResolvedValueOnce({
            agentCapabilities: {
                sessionCapabilities: {
                    resume: {},
                },
            },
        });
        loadSessionMock.mockResolvedValueOnce({
            configOptions: [],
            modes: [],
            models: [],
        });
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        const launch = createRuntimeLaunch({
            cwd: tempDir,
            projectRoot: tempDir,
            runtimeId: "claude",
            title: "Claude replay session",
        });
        const runtime = new AiWorkerRuntime({
            emitEvent: () => {},
        });

        const snapshot = (await runtime.dispatchMethod("ai.prepareSession", {
            input: launch.input,
            launch,
        })) as AiSessionSnapshot;

        expect(loadSessionMock).toHaveBeenCalledWith({
            additionalDirectories: undefined,
            cwd: tempDir,
            mcpServers: [],
            sessionId: "runtime-session-1",
        });
        expect(resumeSessionMock).not.toHaveBeenCalled();
        expect(snapshot.runtimeSessionId).toBe("runtime-session-1");
    });

    it("launches Windows batch ACP runtimes through cmd.exe", async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        const originalPlatform = process.platform;
        const cases: Array<{
            readonly args: readonly string[];
            readonly executable: string;
            readonly runtimeId: AiRuntimeStatus["runtimeId"];
        }> = [
            {
                args: [],
                executable:
                    "C:\\Program Files\\Comando Test\\codex-acp.cmd",
                runtimeId: "codex",
            },
            {
                args: ["--acp"],
                executable: "C:\\Program Files\\Comando Test\\gemini.cmd",
                runtimeId: "gemini",
            },
            {
                args: ["acp"],
                executable: "C:\\Program Files\\Comando Test\\kilo.cmd",
                runtimeId: "kilo",
            },
            {
                args: ["acp"],
                executable: "C:\\Program Files\\Comando Test\\opencode.cmd",
                runtimeId: "opencode",
            },
            {
                args: ["--no-auto-update", "agent", "stdio"],
                executable: "C:\\Program Files\\Comando Test\\grok.cmd",
                runtimeId: "grok",
            },
        ];

        try {
            Object.defineProperty(process, "platform", {
                configurable: true,
                value: "win32",
            });

            for (const input of cases) {
                spawnMock.mockClear();
                spawnedChildren = [];
                const runtime = createRuntime();
                const command = [input.executable, ...input.args].join(" ");
                const readyStatus: AiRuntimeStatus = {
                    authMethod:
                        input.runtimeId === "codex" ? "chatgpt" : null,
                    authMethods: [],
                    authReady: true,
                    checkedAt: "2026-04-15T00:00:00.000Z",
                    command,
                    hasCustomBinaryPath: true,
                    hasGatewayConfig: false,
                    hasGatewayUrl: false,
                    message: null,
                    onboardingRequired: false,
                    runtimeId: input.runtimeId,
                    source: "settings",
                    state: "ready",
                };
                const launch = createLaunch({
                    cwd: tempDir,
                    projectRoot: tempDir,
                    resolvedRuntime: {
                        args: input.args,
                        command,
                        env: process.env,
                        executable: input.executable,
                        status: readyStatus,
                    },
                    title: `${input.runtimeId} batch launch`,
                });

                await runtime.dispatchMethod("ai.prepareSession", {
                    input: {
                        ...launch.input,
                        runtimeId: input.runtimeId,
                    },
                    launch: {
                        ...launch,
                        input: {
                            ...launch.input,
                            runtimeId: input.runtimeId,
                        },
                        persistedSnapshot: {
                            ...launch.persistedSnapshot,
                            runtimeId: input.runtimeId,
                        },
                    },
                });

                expect(spawnMock).toHaveBeenCalledWith(
                    "cmd.exe",
                    [
                        "/d",
                        "/s",
                        "/v:off",
                        "/c",
                        [
                            `""${input.executable}"`,
                            ...input.args.map((arg) => `"${arg}"`),
                        ].join(" ") + '"',
                    ],
                    expect.objectContaining({
                        cwd: tempDir,
                        env: process.env,
                        stdio: ["pipe", "pipe", "pipe"],
                    }),
                );
            }
        } finally {
            Object.defineProperty(process, "platform", {
                configurable: true,
                value: originalPlatform,
            });
            await fs.rm(tempDir, { force: true, recursive: true });
        }
    });

    it("authenticates Grok with the xAI API key ACP method before opening a session", async () => {
        initializeMock.mockResolvedValueOnce({
            authMethods: [{ id: "xai.api_key" }, { id: "cached_token" }],
        });
        const runtime = new AiWorkerRuntime({
            emitEvent: vi.fn(),
        });
        const launch = createGrokLaunch({
            authCredentialSource: "comando-secret",
            authMethod: "xai-api-key",
            cwd: process.cwd(),
            projectRoot: null,
            title: "Grok 1",
        });

        await runtime.dispatchMethod("ai.prepareSession", {
            input: launch.input,
            launch,
        });

        expect(authenticateMock).toHaveBeenCalledWith({
            _meta: { headless: true },
            methodId: "xai.api_key",
        });
        expect(authenticateMock.mock.invocationCallOrder[0]).toBeLessThan(
            loadSessionMock.mock.invocationCallOrder[0],
        );
    });

    it("authenticates Grok with the cached token ACP method for external login", async () => {
        initializeMock.mockResolvedValueOnce({
            authMethods: [{ id: "xai.api_key" }, { id: "cached_token" }],
        });
        const runtime = new AiWorkerRuntime({
            emitEvent: vi.fn(),
        });
        const launch = createGrokLaunch({
            authCredentialSource: "external-runtime",
            authMethod: "grok-login",
            cwd: process.cwd(),
            projectRoot: null,
            title: "Grok 1",
        });

        await runtime.dispatchMethod("ai.prepareSession", {
            input: launch.input,
            launch,
        });

        expect(authenticateMock).toHaveBeenCalledWith({
            _meta: { headless: true },
            methodId: "cached_token",
        });
    });

    it("fails Grok startup when the expected ACP auth method is missing", async () => {
        initializeMock.mockResolvedValueOnce({
            authMethods: [{ id: "cached_token" }],
        });
        const runtime = new AiWorkerRuntime({
            emitEvent: vi.fn(),
        });
        const launch = createGrokLaunch({
            authCredentialSource: "comando-secret",
            authMethod: "xai-api-key",
            cwd: process.cwd(),
            projectRoot: null,
            title: "Grok 1",
        });

        await expect(
            runtime.dispatchMethod("ai.prepareSession", {
                input: launch.input,
                launch,
            }),
        ).rejects.toThrow(
            "Grok does not advertise the expected authentication method `xai.api_key` on this machine.",
        );
        expect(authenticateMock).not.toHaveBeenCalled();
        expect(loadSessionMock).not.toHaveBeenCalled();
    });

    it("fails Grok startup when ACP auth methods are not advertised", async () => {
        initializeMock.mockResolvedValueOnce({
            authMethods: [],
        });
        const runtime = new AiWorkerRuntime({
            emitEvent: vi.fn(),
        });
        const launch = createGrokLaunch({
            authCredentialSource: "external-runtime",
            authMethod: "grok-login",
            cwd: process.cwd(),
            projectRoot: null,
            title: "Grok 1",
        });

        await expect(
            runtime.dispatchMethod("ai.prepareSession", {
                input: launch.input,
                launch,
            }),
        ).rejects.toThrow(
            "Grok does not advertise authentication methods on this machine.",
        );
        expect(authenticateMock).not.toHaveBeenCalled();
        expect(loadSessionMock).not.toHaveBeenCalled();
    });

    it("fails Grok startup when ACP auth methods are missing", async () => {
        initializeMock.mockResolvedValueOnce({});
        const runtime = new AiWorkerRuntime({
            emitEvent: vi.fn(),
        });
        const launch = createGrokLaunch({
            authCredentialSource: "external-runtime",
            authMethod: "grok-login",
            cwd: process.cwd(),
            projectRoot: null,
            title: "Grok 1",
        });

        await expect(
            runtime.dispatchMethod("ai.prepareSession", {
                input: launch.input,
                launch,
            }),
        ).rejects.toThrow(
            "Grok does not advertise authentication methods on this machine.",
        );
        expect(authenticateMock).not.toHaveBeenCalled();
        expect(loadSessionMock).not.toHaveBeenCalled();
    });

    it("does not reactivate a restored subagent from replayed turn lifecycle events", async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        const emittedEvents: AiWorkerEventMessage[] = [];
        const runtime = new AiWorkerRuntime({
            emitEvent: (event) => {
                emittedEvents.push(event);
            },
        });
        const baseLaunch = createLaunch({
            cwd: tempDir,
            projectRoot: tempDir,
            title: "Restored subagent",
        });
        const launch: AiWorkerSessionLaunchInput = {
            ...baseLaunch,
            input: {
                ...baseLaunch.input,
                sessionId: "child-session-1",
                title: "Restored subagent",
            },
            persistedSnapshot: {
                ...baseLaunch.persistedSnapshot,
                parentSessionId: "parent-session-1",
                runtimeSessionId: "runtime-child-1",
                sessionId: "child-session-1",
                title: "Restored subagent",
            },
        };

        loadSessionMock.mockImplementationOnce(async () => {
            const client = latestClientFactory?.();
            const meta = {
                [CODEX_ACP_STATUS_EVENT_TYPE_KEY]:
                    CODEX_ACP_TURN_LIFECYCLE_EVENT_TYPE,
                [CODEX_ACP_TURN_EVENT_TYPE_KEY]: CODEX_ACP_TURN_STARTED_EVENT_TYPE,
                [CODEX_ACP_TURN_ID_KEY]: "historical-turn-1",
            };
            await client?.sessionUpdate({
                _meta: meta,
                sessionId: "runtime-child-1",
                update: {
                    _meta: meta,
                    sessionUpdate: "session_info_update",
                },
            });
            await new Promise((resolve) => {
                setTimeout(resolve, AI_SESSION_STREAMING_FLUSH_MS + 20);
            });
            return {
                configOptions: [],
                modes: [],
                models: [],
            };
        });

        const snapshot = (await runtime.dispatchMethod("ai.prepareSession", {
            input: launch.input,
            launch,
        })) as AiSessionSnapshot;

        expect(snapshot.activeTurnStartedAt ?? null).toBeNull();
        expect(snapshot.status).toBe("idle");
        expect(
            emittedEvents.some((event) => {
                if (event.event !== "ai.snapshot.updated") {
                    return false;
                }
                const { update } = event.payload;
                return update.kind === "snapshot"
                    ? update.snapshot.status === "streaming"
                    : update.patch.changes.status === "streaming";
            }),
        ).toBe(false);
    });

    it("replays early session updates after the runtime session mapping is registered", async () => {
        const readyStatus: AiRuntimeStatus = {
            authMethod: "chatgpt",
            authMethods: [],
            authReady: true,
            checkedAt: "2026-04-15T00:00:00.000Z",
            command: "mock-codex-acp",
            hasCustomBinaryPath: false,
            hasGatewayConfig: false,
            hasGatewayUrl: false,
            message: null,
            onboardingRequired: false,
            runtimeId: "codex",
            source: "bundled",
            state: "ready",
        };
        const persistedSnapshot: AiSessionSnapshot = {
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
            projectId: null,
            runtimeId: "codex",
            runtimeSessionId: null,
            sessionId: "session-1",
            status: "idle",
            title: "Codex 1",
            tokenUsage: null,
            toolActivity: [],
            trackedFiles: [],
            updatedAt: "2026-04-15T22:23:13.719838Z",
            worktreeId: null,
        };
        const emittedEvents: AiWorkerEventMessage[] = [];
        const runtime = new AiWorkerRuntime({
            emitEvent: (event) => {
                emittedEvents.push(event);
            },
        });
        const launch: AiWorkerSessionLaunchInput = {
            additionalRoots: [],
            cwd: process.cwd(),
            desiredSelections: {
                configOptions: [],
                modeId: null,
                modelId: null,
                preferredConfigOptions: {},
            },
            input: {
                projectId: null,
                runtimeId: "codex",
                sessionId: "session-1",
                title: "Codex 1",
                worktreeId: null,
            },
            ownerWindowId: "window-1",
            persistedSnapshot,
            projectRoot: null,
            resolvedRuntime: {
                args: [],
                command: "mock-codex-acp",
                env: process.env,
                executable: "mock-codex-acp",
                status: readyStatus,
            },
        };

        newSessionMock.mockImplementationOnce(async () => {
            const client = latestClientFactory?.();
            await client?.sessionUpdate({
                sessionId: "runtime-session-2",
                update: {
                    availableCommands: [
                        {
                            description: "Review changes",
                            input: null,
                            name: "review",
                        },
                    ],
                    sessionUpdate: "available_commands_update",
                },
            });

            return {
                configOptions: [],
                modes: [],
                models: [],
                sessionId: "runtime-session-2",
            };
        });

        const snapshot = (await runtime.dispatchMethod("ai.prepareSession", {
            input: launch.input,
            launch,
        })) as AiSessionSnapshot;

        expect(snapshot.availableCommands).toEqual([
            {
                description: "Review changes",
                id: "review",
                insertText: "/review ",
                label: "/review",
            },
        ]);
        expect(
            emittedEvents.some(
                (event) =>
                    event.event === "ai.snapshot.updated" &&
                    event.payload.update.kind === "patch" &&
                    event.payload.update.patch.changes.availableCommands,
            ),
        ).toBe(true);
    });

    it("stores ACP plan titles from metadata", async () => {
        const emittedEvents: AiWorkerEventMessage[] = [];
        const runtime = new AiWorkerRuntime({
            emitEvent: (event) => {
                emittedEvents.push(event);
            },
        });
        const launch = createLaunch({
            cwd: process.cwd(),
            projectRoot: process.cwd(),
            title: "ACP plan title",
        });

        await runtime.dispatchMethod("ai.prepareSession", {
            input: launch.input,
            launch,
        });
        emittedEvents.length = 0;

        const client = latestClientFactory?.();
        expect(client).toBeDefined();
        await client!.sessionUpdate({
            sessionId: "runtime-session-1",
            update: {
                _meta: {
                    [CODEX_ACP_PLAN_TITLE_KEY]: "Restore ACP event bridge",
                },
                entries: [
                    {
                        content: "Check current bridge",
                        priority: "medium",
                        status: "in_progress",
                    },
                ],
                sessionUpdate: "plan",
            },
        });

        await vi.waitFor(() => {
            expect(
                hasPatchChangesMatching(
                    emittedEvents,
                    "session-1",
                    (changes) =>
                        changes.plan?.title ===
                        "Restore ACP event bridge",
                ),
            ).toBe(true);
        });
    });

    it("sets the model through config options when the runtime advertises a model option", async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        const emittedEvents: AiWorkerEventMessage[] = [];
        const runtime = new AiWorkerRuntime({
            emitEvent: (event) => {
                emittedEvents.push(event);
            },
        });
        const launch = createLaunch({
            cwd: tempDir,
            projectRoot: tempDir,
            title: "Model config",
        });
        loadSessionMock.mockResolvedValueOnce(
            createCodexCatalogResponse({
                modelId: "gpt-5",
            }),
        );

        await runtime.dispatchMethod("ai.prepareSession", {
            input: launch.input,
            launch,
        });
        emittedEvents.length = 0;

        await runtime.dispatchMethod("ai.setSessionModel", {
            modelId: "gpt-5-mini",
            sessionId: "session-1",
        });

        expect(setSessionConfigOptionMock).toHaveBeenCalledWith({
            configId: "model",
            sessionId: "runtime-session-1",
            value: "gpt-5-mini",
        });
        expect(unstableSetSessionModelMock).not.toHaveBeenCalled();
        expect(
            hasPatchChangesMatching(
                emittedEvents,
                "session-1",
                (changes) =>
                    changes.modelId === "gpt-5-mini" &&
                    readSelectConfigValue(changes.configOptions, "model") ===
                        "gpt-5-mini",
            ),
        ).toBe(true);
    });

    it("falls back to the legacy model setter when no model config option exists", async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        const emittedEvents: AiWorkerEventMessage[] = [];
        const runtime = new AiWorkerRuntime({
            emitEvent: (event) => {
                emittedEvents.push(event);
            },
        });
        const launch = createLaunch({
            cwd: tempDir,
            projectRoot: tempDir,
            title: "Legacy model",
        });
        loadSessionMock.mockResolvedValueOnce({
            configOptions: [],
            modes: null,
            models: {
                availableModels: [
                    {
                        description: null,
                        modelId: "legacy-base",
                        name: "Legacy base",
                    },
                    {
                        description: null,
                        modelId: "legacy-pro",
                        name: "Legacy pro",
                    },
                ],
                currentModelId: "legacy-base",
            },
        });

        await runtime.dispatchMethod("ai.prepareSession", {
            input: launch.input,
            launch,
        });
        emittedEvents.length = 0;

        await runtime.dispatchMethod("ai.setSessionModel", {
            modelId: "legacy-pro",
            sessionId: "session-1",
        });

        expect(setSessionConfigOptionMock).not.toHaveBeenCalled();
        expect(unstableSetSessionModelMock).toHaveBeenCalledWith({
            modelId: "legacy-pro",
            sessionId: "runtime-session-1",
        });
        expect(
            hasPatchChangesMatching(
                emittedEvents,
                "session-1",
                (changes) => changes.modelId === "legacy-pro",
            ),
        ).toBe(true);
    });

    it("reports a clear error when model changes are unsupported", async () => {
        exposeLegacySetSessionModelMock = false;
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        const runtime = createRuntime();
        const launch = createLaunch({
            cwd: tempDir,
            projectRoot: tempDir,
            title: "No model changes",
        });

        await runtime.dispatchMethod("ai.prepareSession", {
            input: launch.input,
            launch,
        });

        await expect(
            runtime.dispatchMethod("ai.setSessionModel", {
                modelId: "gpt-5",
                sessionId: "session-1",
            }),
        ).rejects.toThrow("This runtime does not support model changes.");
        expect(setSessionConfigOptionMock).not.toHaveBeenCalled();
        expect(unstableSetSessionModelMock).not.toHaveBeenCalled();
    });

    it("emits patch updates after the initial snapshot when the session changes", async () => {
        const readyStatus: AiRuntimeStatus = {
            authMethod: "chatgpt",
            authMethods: [],
            authReady: true,
            checkedAt: "2026-04-15T00:00:00.000Z",
            command: "mock-codex-acp",
            hasCustomBinaryPath: false,
            hasGatewayConfig: false,
            hasGatewayUrl: false,
            message: null,
            onboardingRequired: false,
            runtimeId: "codex",
            source: "bundled",
            state: "ready",
        };
        const persistedSnapshot: AiSessionSnapshot = {
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
            projectId: null,
            runtimeId: "codex",
            runtimeSessionId: "runtime-session-1",
            sessionId: "session-1",
            status: "idle",
            title: "Codex 1",
            tokenUsage: null,
            toolActivity: [],
            trackedFiles: [],
            updatedAt: "2026-04-15T22:23:13.719838Z",
            worktreeId: null,
        };
        const emittedEvents: AiWorkerEventMessage[] = [];
        const runtime = new AiWorkerRuntime({
            emitEvent: (event) => {
                emittedEvents.push(event);
            },
        });
        const launch: AiWorkerSessionLaunchInput = {
            additionalRoots: [],
            cwd: process.cwd(),
            desiredSelections: {
                configOptions: [],
                modeId: null,
                modelId: null,
                preferredConfigOptions: {},
            },
            input: {
                projectId: null,
                runtimeId: "codex",
                sessionId: "session-1",
                title: "Codex 1",
                worktreeId: null,
            },
            ownerWindowId: "window-1",
            persistedSnapshot,
            projectRoot: null,
            resolvedRuntime: {
                args: [],
                command: "mock-codex-acp",
                env: process.env,
                executable: "mock-codex-acp",
                status: readyStatus,
            },
        };

        await runtime.dispatchMethod("ai.prepareSession", {
            input: launch.input,
            launch,
        });
        emittedEvents.length = 0;

        await runtime.dispatchMethod("ai.sendPrompt", {
            input: {
                attachments: [],
                projectId: null,
                prompt: "hello",
                runtimeId: "codex",
                sessionId: "session-1",
                title: "Codex 1",
                worktreeId: null,
            },
            launch,
        });

        const snapshotEvents = emittedEvents.filter(
            (event): event is Extract<AiWorkerEventMessage, { event: "ai.snapshot.updated" }> =>
                event.event === "ai.snapshot.updated",
        );
        expect(snapshotEvents.length).toBeGreaterThan(0);
        expect(
            snapshotEvents.every(
                (event) => event.payload.update.kind === "patch",
            ),
        ).toBe(true);
    });

    it("keeps ACP thought and assistant chunks with the same runtime message id distinct", async () => {
        const emittedEvents: AiWorkerEventMessage[] = [];
        const runtime = new AiWorkerRuntime({
            emitEvent: (event) => {
                emittedEvents.push(event);
            },
        });
        const launch = createLaunch({
            cwd: process.cwd(),
            projectRoot: process.cwd(),
            title: "ACP message id collision",
        });

        await runtime.dispatchMethod("ai.prepareSession", {
            input: launch.input,
            launch,
        });
        emittedEvents.length = 0;

        const client = latestClientFactory?.();
        expect(client).toBeDefined();
        await client!.sessionUpdate({
            sessionId: "runtime-session-1",
            update: {
                content: {
                    text: "internal notes",
                    type: "text",
                },
                messageId: "runtime-message-1",
                sessionUpdate: "agent_thought_chunk",
            },
        });
        await client!.sessionUpdate({
            sessionId: "runtime-session-1",
            update: {
                content: {
                    text: "final answer",
                    type: "text",
                },
                messageId: "runtime-message-1",
                sessionUpdate: "agent_message_chunk",
            },
        });

        await vi.waitFor(() => {
            const messages = getLatestPatchMessages(emittedEvents, "session-1");
            expect(messages).toEqual([
                expect.objectContaining({
                    content: "internal notes",
                    id: "thinking:runtime-message-1",
                    kind: "thinking",
                }),
                expect.objectContaining({
                    content: "final answer",
                    id: "runtime-message-1",
                    kind: "assistant",
                }),
            ]);
        });
        expect(
            emittedEvents.some(
                (event) =>
                    event.event === "ai.session.event" &&
                    event.payload.event.kind === "message-started" &&
                    event.payload.event.message.id === "runtime-message-1" &&
                    event.payload.event.messageKind === "assistant",
            ),
        ).toBe(true);
        expect(
            emittedEvents.some(
                (event) =>
                    event.event === "ai.session.event" &&
                    event.payload.event.kind === "message-delta" &&
                    event.payload.event.messageId === "runtime-message-1" &&
                    event.payload.event.delta === "final answer",
            ),
        ).toBe(true);
    });

    it("does not mark the session streaming for suppressed Codex status updates", async () => {
        const emittedEvents: AiWorkerEventMessage[] = [];
        const runtime = new AiWorkerRuntime({
            emitEvent: (event) => {
                emittedEvents.push(event);
            },
        });
        const launch = createLaunch({
            cwd: process.cwd(),
            projectRoot: process.cwd(),
            title: "Suppressed status test",
        });

        await runtime.dispatchMethod("ai.prepareSession", {
            input: launch.input,
            launch,
        });
        emittedEvents.length = 0;

        const client = latestClientFactory?.();
        expect(client).toBeDefined();
        await client!.sessionUpdate({
            sessionId: "runtime-session-1",
            update: {
                _meta: null,
                sessionUpdate: "tool_call_update",
                status: "completed",
                title: "Drafting response",
                toolCallId: "codex-acp:status:item:agent-msg-42",
            },
        });

        expect(emittedEvents).toHaveLength(0);
        await expect(
            runtime.dispatchMethod("ai.sendPrompt", {
                input: {
                    attachments: [],
                    projectId: null,
                    prompt: "next prompt",
                    runtimeId: "codex",
                    sessionId: "session-1",
                    title: "Suppressed status test",
                    worktreeId: null,
                },
                launch,
            }),
        ).resolves.toEqual({
            sessionId: "session-1",
            stopReason: "completed",
        });
    });

    it("registers Codex subagent updates as separate live sessions", async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        const emittedEvents: AiWorkerEventMessage[] = [];
        const runtime = new AiWorkerRuntime({
            emitEvent: (event) => {
                emittedEvents.push(event);
            },
        });
        const launch = createLaunch({
            cwd: tempDir,
            projectRoot: tempDir,
            title: "Subagent parent",
        });

        await runtime.dispatchMethod("ai.prepareSession", {
            input: launch.input,
            launch,
        });
        emittedEvents.length = 0;

        const client = latestClientFactory?.();
        expect(client).toBeDefined();
        const subagentMeta = {
            codexAcpAgentNickname: "Galileo",
            codexAcpChildSessionId: "runtime-subagent-1",
            codexAcpCwd: tempDir,
            codexAcpEventType: "subagent_session_created",
            codexAcpParentSessionId: "runtime-session-1",
        };
        await client!.sessionUpdate({
            _meta: subagentMeta,
            sessionId: "runtime-subagent-1",
            update: {
                _meta: subagentMeta,
                sessionUpdate: "session_info_update",
                title: "Galileo",
            },
        });

        const childSnapshot = getLatestSnapshot(
            emittedEvents,
            (snapshot) => snapshot.parentSessionId === "session-1",
        );
        expect(childSnapshot).toEqual(
            expect.objectContaining({
                parentSessionId: "session-1",
                projectId: null,
                runtimeId: "codex",
                runtimeSessionId: "runtime-subagent-1",
                status: "idle",
                title: "Galileo",
                worktreeId: null,
            }),
        );
        expect(childSnapshot?.sessionId).not.toBe("session-1");

        emittedEvents.length = 0;
        await client!.sessionUpdate({
            sessionId: "runtime-subagent-1",
            update: {
                content: {
                    text: "child output",
                    type: "text",
                },
                messageId: "child-message-1",
                sessionUpdate: "agent_message_chunk",
            },
        });

        await vi.waitFor(() => {
            const messages = getLatestPatchMessages(
                emittedEvents,
                childSnapshot!.sessionId,
            );
            expect(messages).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        content: "child output",
                        id: "child-message-1",
                    }),
                ]),
            );
        });

        emittedEvents.length = 0;
        const permissionPromise = client!.requestPermission({
            options: [
                {
                    kind: "allow_once",
                    name: "Allow",
                    optionId: "allow",
                },
                {
                    kind: "reject_once",
                    name: "Reject",
                    optionId: "reject",
                },
            ],
            sessionId: "runtime-subagent-1",
            toolCall: {
                rawInput: {
                    command: "echo child",
                },
                status: "pending",
                title: "Child permission",
                toolCallId: "child-tool",
            },
        });
        await vi.waitFor(() => {
            expect(getLatestPendingPermission(emittedEvents)).toEqual(
                expect.objectContaining({
                    sessionId: childSnapshot!.sessionId,
                    title: "Child permission",
                }),
            );
        });
        const pendingPermission = getLatestPendingPermission(emittedEvents);
        expect(pendingPermission).not.toBeNull();
        await runtime.dispatchMethod("ai.respondPermission", {
            input: {
                optionId: "allow",
                requestId: pendingPermission!.requestId,
                sessionId: childSnapshot!.sessionId,
            },
        });
        await expect(permissionPromise).resolves.toMatchObject({
            outcome: {
                optionId: "allow",
                outcome: "selected",
            },
        });

        await runtime.dispatchMethod("ai.closeSession", childSnapshot!.sessionId);

        expect(closeRuntimeSessionMock).toHaveBeenLastCalledWith({
            sessionId: "runtime-subagent-1",
        });
        expect(spawnedChildren[0]?.kill).not.toHaveBeenCalled();
        await expect(
            runtime.dispatchMethod("ai.sendPrompt", {
                input: {
                    attachments: [],
                    projectId: null,
                    prompt: "parent is still alive",
                    runtimeId: "codex",
                    sessionId: "session-1",
                    title: "Subagent parent",
                    worktreeId: null,
                },
                launch,
            }),
        ).resolves.toEqual({
            sessionId: "session-1",
            stopReason: "completed",
        });
    });

    it("rehydrates persisted subagent app identity from runtime mappings", async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        const emittedEvents: AiWorkerEventMessage[] = [];
        const runtime = new AiWorkerRuntime({
            emitEvent: (event) => {
                emittedEvents.push(event);
            },
        });
        const launch = createLaunch({
            cwd: tempDir,
            persistedSubagentSessionMappings: [
                {
                    appSessionId: "session-child-persisted",
                    parentAppSessionId: "session-1",
                    parentRuntimeSessionId: "runtime-session-1",
                    runtimeSessionId: "runtime-subagent-1",
                },
            ],
            projectRoot: tempDir,
            title: "Subagent parent",
        });

        await runtime.dispatchMethod("ai.prepareSession", {
            input: launch.input,
            launch,
        });
        emittedEvents.length = 0;

        const client = latestClientFactory?.();
        expect(client).toBeDefined();
        const subagentMeta = {
            codexAcpAgentNickname: "Galileo",
            codexAcpChildSessionId: "runtime-subagent-1",
            codexAcpCwd: tempDir,
            codexAcpEventType: "subagent_session_created",
            codexAcpParentSessionId: "runtime-session-1",
        };
        await client!.sessionUpdate({
            _meta: subagentMeta,
            sessionId: "runtime-subagent-1",
            update: {
                _meta: subagentMeta,
                sessionUpdate: "session_info_update",
                title: "Galileo",
            },
        });

        expect(
            getLatestSnapshot(
                emittedEvents,
                (snapshot) =>
                    snapshot.runtimeSessionId === "runtime-subagent-1",
            ),
        ).toEqual(
            expect.objectContaining({
                parentSessionId: "session-1",
                runtimeSessionId: "runtime-subagent-1",
                sessionId: "session-child-persisted",
                title: "Galileo",
            }),
        );
    });

    it("retries buffered subagent creation after the parent runtime session mapping is registered", async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        const emittedEvents: AiWorkerEventMessage[] = [];
        const runtime = new AiWorkerRuntime({
            emitEvent: (event) => {
                emittedEvents.push(event);
            },
        });
        const launch = createLaunch({
            cwd: tempDir,
            projectRoot: tempDir,
            title: "Buffered subagent parent",
        });
        const subagentMeta = {
            codexAcpAgentNickname: "Galileo",
            codexAcpChildSessionId: "runtime-subagent-early",
            codexAcpCwd: tempDir,
            codexAcpEventType: "subagent_session_created",
            codexAcpParentSessionId: "runtime-session-1",
        };
        loadSessionMock.mockImplementationOnce(async () => {
            const client = latestClientFactory?.();
            await client?.sessionUpdate({
                _meta: subagentMeta,
                sessionId: "runtime-subagent-early",
                update: {
                    _meta: subagentMeta,
                    sessionUpdate: "session_info_update",
                    title: "Galileo",
                },
            });
            await client?.sessionUpdate({
                sessionId: "runtime-subagent-early",
                update: {
                    content: {
                        text: "early child output",
                        type: "text",
                    },
                    messageId: "early-child-message-1",
                    sessionUpdate: "agent_message_chunk",
                },
            });
            return {
                configOptions: [],
                modes: [],
                models: [],
            };
        });

        await runtime.dispatchMethod("ai.prepareSession", {
            input: launch.input,
            launch,
        });

        await vi.waitFor(() => {
            const childSnapshot = getLatestSnapshot(
                emittedEvents,
                (snapshot) =>
                    snapshot.parentSessionId === "session-1" &&
                    snapshot.runtimeSessionId === "runtime-subagent-early",
            );
            expect(childSnapshot).toEqual(
                expect.objectContaining({
                    messages: [
                        expect.objectContaining({
                            content: "early child output",
                            kind: "assistant",
                        }),
                    ],
                    parentSessionId: "session-1",
                    runtimeSessionId: "runtime-subagent-early",
                    title: "Galileo",
                }),
            );
        });
    });

    it("preserves buffered subagent creation when early child updates overflow the buffer", async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        const emittedEvents: AiWorkerEventMessage[] = [];
        const runtime = new AiWorkerRuntime({
            emitEvent: (event) => {
                emittedEvents.push(event);
            },
        });
        const launch = createLaunch({
            cwd: tempDir,
            projectRoot: tempDir,
            title: "Buffered subagent overflow parent",
        });
        const subagentMeta = {
            codexAcpAgentNickname: "Galileo",
            codexAcpChildSessionId: "runtime-subagent-overflow",
            codexAcpCwd: tempDir,
            codexAcpEventType: "subagent_session_created",
            codexAcpParentSessionId: "runtime-session-1",
        };
        loadSessionMock.mockImplementationOnce(async () => {
            const client = latestClientFactory?.();
            await client?.sessionUpdate({
                _meta: subagentMeta,
                sessionId: "runtime-subagent-overflow",
                update: {
                    _meta: subagentMeta,
                    sessionUpdate: "session_info_update",
                    title: "Galileo",
                },
            });
            for (let index = 0; index < 20; index += 1) {
                await client?.sessionUpdate({
                    sessionId: "runtime-subagent-overflow",
                    update: {
                        content: {
                            text: `buffered child output ${index}`,
                            type: "text",
                        },
                        messageId: `overflow-child-message-${index}`,
                        sessionUpdate: "agent_message_chunk",
                    },
                });
            }
            return {
                configOptions: [],
                modes: [],
                models: [],
            };
        });

        await runtime.dispatchMethod("ai.prepareSession", {
            input: launch.input,
            launch,
        });

        await vi.waitFor(() => {
            const childSnapshot = getLatestSnapshot(
                emittedEvents,
                (snapshot) =>
                    snapshot.parentSessionId === "session-1" &&
                    snapshot.runtimeSessionId === "runtime-subagent-overflow",
            );
            expect(childSnapshot).toEqual(
                expect.objectContaining({
                    parentSessionId: "session-1",
                    runtimeSessionId: "runtime-subagent-overflow",
                    title: "Galileo",
                }),
            );
            expect(childSnapshot?.messages).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        content: "buffered child output 19",
                        kind: "assistant",
                    }),
                ]),
            );
        });
    });

    it("registers Codex subagent sessions from thread metadata when session metadata is absent", async () => {
        const { client, emittedEvents, tempDir } =
            await setupPreparedRuntimeWithClient("Subagent thread metadata parent");
        const subagentMeta = {
            codexAcpAgentNickname: "Galileo",
            codexAcpChildThreadId: "runtime-subagent-thread-1",
            codexAcpCwd: tempDir,
            codexAcpEventType: "subagent_session_created",
            codexAcpParentThreadId: "runtime-session-1",
        };
        await client.sessionUpdate({
            _meta: subagentMeta,
            sessionId: "runtime-subagent-thread-1",
            update: {
                _meta: subagentMeta,
                sessionUpdate: "session_info_update",
                title: "Galileo",
            },
        });

        const childSnapshot = getLatestSnapshot(
            emittedEvents,
            (snapshot) =>
                snapshot.parentSessionId === "session-1" &&
                snapshot.runtimeSessionId === "runtime-subagent-thread-1",
        );
        expect(childSnapshot).toEqual(
            expect.objectContaining({
                parentSessionId: "session-1",
                runtimeSessionId: "runtime-subagent-thread-1",
                title: "Galileo",
            }),
        );
    });

    it("applies Codex subagent model metadata to the initial child snapshot", async () => {
        loadSessionMock.mockResolvedValueOnce(createCodexCatalogResponse());
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        const emittedEvents: AiWorkerEventMessage[] = [];
        const runtime = new AiWorkerRuntime({
            emitEvent: (event) => {
                emittedEvents.push(event);
            },
        });
        const launch = createLaunch({
            cwd: tempDir,
            projectRoot: tempDir,
            title: "Subagent metadata parent",
        });

        await runtime.dispatchMethod("ai.prepareSession", {
            input: launch.input,
            launch,
        });
        emittedEvents.length = 0;

        const client = latestClientFactory?.();
        expect(client).toBeDefined();
        const subagentMeta = {
            codexAcpAgentNickname: "Galileo",
            codexAcpChildSessionId: "runtime-subagent-1",
            codexAcpCwd: tempDir,
            codexAcpEventType: "subagent_session_created",
            codexAcpModel: "gpt-5-mini/high",
            codexAcpParentSessionId: "runtime-session-1",
            codexAcpReasoningEffort: "high",
        };
        await client!.sessionUpdate({
            _meta: subagentMeta,
            sessionId: "runtime-subagent-1",
            update: {
                _meta: subagentMeta,
                sessionUpdate: "session_info_update",
                title: "Galileo",
            },
        });

        const childSnapshot = getLatestSnapshot(
            emittedEvents,
            (snapshot) => snapshot.parentSessionId === "session-1",
        );
        expect(childSnapshot).toEqual(
            expect.objectContaining({
                modelId: "gpt-5-mini",
                runtimeSessionId: "runtime-subagent-1",
                title: "Galileo",
            }),
        );
        expect(
            readSelectConfigValue(childSnapshot?.configOptions, "model"),
        ).toBe("gpt-5-mini");
        expect(
            readSelectConfigValue(
                childSnapshot?.configOptions,
                "reasoning_effort",
            ),
        ).toBe("high");
    });

    it("keeps known dash-suffixed Codex subagent model metadata intact", async () => {
        loadSessionMock.mockResolvedValueOnce(
            createCodexCatalogResponse({
                modelId: "foo",
                modelOptions: [
                    {
                        id: "foo",
                        name: "Foo",
                    },
                    {
                        id: "foo-high",
                        name: "Foo High",
                    },
                ],
                reasoningOptionId: "effort",
            }),
        );
        const { client, emittedEvents, tempDir } =
            await setupPreparedRuntimeWithClient("Subagent dash model parent");

        const subagentMeta = {
            codexAcpAgentNickname: "Ada",
            codexAcpChildSessionId: "runtime-subagent-1",
            codexAcpCwd: tempDir,
            codexAcpEventType: "subagent_session_created",
            codexAcpModel: "foo-high",
            codexAcpParentSessionId: "runtime-session-1",
            codexAcpReasoningEffort: "high",
        };
        await client.sessionUpdate({
            _meta: subagentMeta,
            sessionId: "runtime-subagent-1",
            update: {
                _meta: subagentMeta,
                sessionUpdate: "session_info_update",
                title: "Ada",
            },
        });

        const childSnapshot = getLatestSnapshot(
            emittedEvents,
            (snapshot) => snapshot.parentSessionId === "session-1",
        );
        expect(childSnapshot).toEqual(
            expect.objectContaining({
                modelId: "foo-high",
                runtimeSessionId: "runtime-subagent-1",
                title: "Ada",
            }),
        );
        expect(
            readSelectConfigValue(childSnapshot?.configOptions, "model"),
        ).toBe("foo-high");
        expect(readSelectConfigValue(childSnapshot?.configOptions, "effort")).toBe(
            "high",
        );
    });

    it("updates Codex subagent model metadata from later session info updates", async () => {
        loadSessionMock.mockResolvedValueOnce(
            createCodexCatalogResponse({
                reasoningOptionId: "effort_level",
            }),
        );
        const { client, emittedEvents, tempDir } =
            await setupPreparedRuntimeWithClient("Subagent metadata update parent");
        const childSnapshot = await registerSubagentSession(
            client,
            emittedEvents,
            tempDir,
            {
                nickname: "Galileo",
                runtimeSessionId: "runtime-subagent-1",
            },
        );
        expect(childSnapshot.modelId).toBe("gpt-5");
        expect(
            readSelectConfigValue(childSnapshot.configOptions, "effort_level"),
        ).toBe("medium");

        emittedEvents.length = 0;
        const metadataUpdate = {
            codexAcpModel: "gpt-5-mini",
            codexAcpReasoningEffort: "low",
        };
        await client.sessionUpdate({
            sessionId: "runtime-subagent-1",
            update: {
                _meta: metadataUpdate,
                sessionUpdate: "session_info_update",
                title: "Galileo updated",
            },
        });

        await vi.waitFor(() => {
            const changes = getLatestPatchChanges(
                emittedEvents,
                childSnapshot.sessionId,
            );
            expect(changes).toEqual(
                expect.objectContaining({
                    modelId: "gpt-5-mini",
                    title: "Galileo updated",
                }),
            );
            expect(readSelectConfigValue(changes?.configOptions, "model")).toBe(
                "gpt-5-mini",
            );
            expect(
                readSelectConfigValue(changes?.configOptions, "effort_level"),
            ).toBe("low");
        });
    });

    it("keeps concurrent ACP permission requests independently resolvable", async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        const emittedEvents: AiWorkerEventMessage[] = [];
        const runtime = new AiWorkerRuntime({
            emitEvent: (event) => {
                emittedEvents.push(event);
            },
        });
        const launch = createLaunch({
            cwd: tempDir,
            projectRoot: tempDir,
            title: "Concurrent permissions",
        });

        await runtime.dispatchMethod("ai.prepareSession", {
            input: launch.input,
            launch,
        });

        const client = latestClientFactory?.();
        expect(client).toBeDefined();

        const firstPermissionPromise = client!.requestPermission({
            options: [
                {
                    kind: "allow_once",
                    name: "Allow first",
                    optionId: "allow-first",
                },
            ],
            sessionId: "runtime-session-1",
            toolCall: {
                rawInput: {
                    command: "echo first",
                },
                status: "pending",
                title: "First permission",
                toolCallId: "first-tool",
            },
        });

        await vi.waitFor(() => {
            expect(getLatestPendingPermission(emittedEvents)).toEqual(
                expect.objectContaining({
                    title: "First permission",
                }),
            );
        });
        const firstPermission = getLatestPendingPermission(emittedEvents);
        expect(firstPermission).not.toBeNull();

        const secondPermissionPromise = client!.requestPermission({
            options: [
                {
                    kind: "allow_once",
                    name: "Allow second",
                    optionId: "allow-second",
                },
            ],
            sessionId: "runtime-session-1",
            toolCall: {
                rawInput: {
                    command: "echo second",
                },
                status: "pending",
                title: "Second permission",
                toolCallId: "second-tool",
            },
        });

        await vi.waitFor(() => {
            expect(getLatestPendingPermission(emittedEvents)).toEqual(
                expect.objectContaining({
                    title: "Second permission",
                }),
            );
        });
        const secondPermission = getLatestPendingPermission(emittedEvents);
        expect(secondPermission).not.toBeNull();

        await runtime.dispatchMethod("ai.respondPermission", {
            input: {
                optionId: "allow-first",
                requestId: firstPermission!.requestId,
                sessionId: "session-1",
            },
        });

        await expect(firstPermissionPromise).resolves.toMatchObject({
            outcome: {
                optionId: "allow-first",
                outcome: "selected",
            },
        });
        expect(getLatestPendingPermission(emittedEvents)).toEqual(
            expect.objectContaining({
                requestId: secondPermission!.requestId,
                title: "Second permission",
            }),
        );

        await runtime.dispatchMethod("ai.respondPermission", {
            input: {
                optionId: "allow-second",
                requestId: secondPermission!.requestId,
                sessionId: "session-1",
            },
        });

        await expect(secondPermissionPromise).resolves.toMatchObject({
            outcome: {
                optionId: "allow-second",
                outcome: "selected",
            },
        });
        await vi.waitFor(() => {
            expect(getLatestPendingPermission(emittedEvents)).toBeNull();
        });
    });

    it("uses Codex turn lifecycle as the primary subagent streaming state", async () => {
        const { client, emittedEvents, tempDir } =
            await setupPreparedRuntimeWithClient("Subagent lifecycle parent");
        const childSnapshot = await registerSubagentSession(
            client,
            emittedEvents,
            tempDir,
            {
                nickname: "Galileo",
                runtimeSessionId: "runtime-subagent-1",
            },
        );

        emittedEvents.length = 0;
        await sendTurnLifecycle(client, {
            eventType: "turn_started",
            runtimeSessionId: "runtime-subagent-1",
            turnId: "turn-1",
        });
        await vi.waitFor(() => {
            expect(
                hasPatchChangesMatching(
                    emittedEvents,
                    childSnapshot.sessionId,
                    (changes) => changes.status === "streaming",
                ),
            ).toBe(true);
        });

        emittedEvents.length = 0;
        await sendTurnLifecycle(client, {
            eventType: "turn_complete",
            runtimeSessionId: "runtime-subagent-1",
            turnId: "turn-1",
        });
        await vi.waitFor(() => {
            expect(
                hasPatchChangesMatching(
                    emittedEvents,
                    childSnapshot.sessionId,
                    (changes) => changes.status === "idle",
                ),
            ).toBe(true);
        });
    });

    it("ignores stale subagent turn lifecycle completions", async () => {
        const { client, emittedEvents, tempDir } =
            await setupPreparedRuntimeWithClient("Subagent stale lifecycle parent");
        const childSnapshot = await registerSubagentSession(
            client,
            emittedEvents,
            tempDir,
            {
                nickname: "Galileo",
                runtimeSessionId: "runtime-subagent-1",
            },
        );

        await sendTurnLifecycle(client, {
            eventType: "turn_started",
            runtimeSessionId: "runtime-subagent-1",
            turnId: "turn-1",
        });
        await sendTurnLifecycle(client, {
            eventType: "turn_started",
            runtimeSessionId: "runtime-subagent-1",
            turnId: "turn-2",
        });
        await vi.waitFor(() => {
            expect(
                hasPatchChangesMatching(
                    emittedEvents,
                    childSnapshot.sessionId,
                    (changes) => changes.status === "streaming",
                ),
            ).toBe(true);
        });

        emittedEvents.length = 0;
        await sendTurnLifecycle(client, {
            eventType: "turn_complete",
            runtimeSessionId: "runtime-subagent-1",
            turnId: "turn-1",
        });

        expect(
            hasPatchChangesMatching(
                emittedEvents,
                childSnapshot.sessionId,
                (changes) => changes.status === "idle",
            ),
        ).toBe(false);

        const staleBreadcrumbMeta = {
            codexAcpChildSessionId: "runtime-subagent-1",
            codexAcpEventType: "subagent_breadcrumb",
            codexAcpParentSessionId: "runtime-session-1",
            codexAcpSubagentEventType: "interaction_end",
        };
        await client.sessionUpdate({
            _meta: staleBreadcrumbMeta,
            sessionId: "runtime-session-1",
            update: {
                _meta: staleBreadcrumbMeta,
                rawOutput: {
                    status: {
                        completed: "old result",
                    },
                },
                sessionUpdate: "tool_call_update",
                status: "completed",
                title: "Galileo responded",
                toolCallId: "codex-acp:subagent:interaction-stale",
            },
        });
        expect(
            hasPatchChangesMatching(
                emittedEvents,
                childSnapshot.sessionId,
                (changes) => changes.status === "idle",
            ),
        ).toBe(false);

        await sendTurnLifecycle(client, {
            eventType: "turn_complete",
            runtimeSessionId: "runtime-subagent-1",
            turnId: "turn-2",
        });
        await vi.waitFor(() => {
            expect(
                hasPatchChangesMatching(
                    emittedEvents,
                    childSnapshot.sessionId,
                    (changes) => changes.status === "idle",
                ),
            ).toBe(true);
        });
    });

    it("ignores Codex turn lifecycle for root sessions", async () => {
        const { client, emittedEvents } =
            await setupPreparedRuntimeWithClient("Root lifecycle parent");

        emittedEvents.length = 0;
        await sendTurnLifecycle(client, {
            eventType: "turn_started",
            runtimeSessionId: "runtime-session-1",
            turnId: "turn-root",
        });
        await sendTurnLifecycle(client, {
            eventType: "turn_complete",
            runtimeSessionId: "runtime-session-1",
            turnId: "turn-root",
        });

        expect(
            hasPatchChangesMatching(
                emittedEvents,
                "session-1",
                (changes) => changes.status === "streaming" || changes.status === "idle",
            ),
        ).toBe(false);
    });

    it("normalizes accumulated terminal output updates", async () => {
        const { client, emittedEvents } =
            await setupPreparedRuntimeWithClient("Terminal output normalization");

        await client.sessionUpdate({
            sessionId: "runtime-session-1",
            update: {
                kind: "execute",
                sessionUpdate: "tool_call",
                status: "in_progress",
                title: "exec_command",
                toolCallId: "exec-1",
            },
        });
        await client.sessionUpdate({
            sessionId: "runtime-session-1",
            update: {
                _meta: {
                    terminal_output: {
                        data: "A\n",
                        terminal_id: "term-1",
                    },
                },
                kind: "execute",
                sessionUpdate: "tool_call_update",
                status: "in_progress",
                title: "exec_command",
                toolCallId: "exec-1",
            },
        });
        await client.sessionUpdate({
            sessionId: "runtime-session-1",
            update: {
                _meta: {
                    terminal_output: {
                        data: "A\nB\n",
                        terminal_id: "term-1",
                    },
                },
                kind: "execute",
                sessionUpdate: "tool_call_update",
                status: "completed",
                title: "exec_command",
                toolCallId: "exec-1",
            },
        });

        await vi.waitFor(() => {
            expect(
                hasToolActivityMatching(
                    emittedEvents,
                    "session-1",
                    (activity) =>
                        activity.id === "exec-1" &&
                        activity.terminalOutput === "A\nB\n",
                ),
            ).toBe(true);
        });
    });

    it("keeps child assistant output owned by the child stream when parent response arrives first", async () => {
        const { client, emittedEvents, tempDir } =
            await setupPreparedRuntimeWithClient("Subagent terminal before complete");
        const childSnapshot = await registerSubagentSession(
            client,
            emittedEvents,
            tempDir,
            {
                nickname: "Galileo",
                runtimeSessionId: "runtime-subagent-1",
            },
        );
        const interactionMeta = {
            codexAcpChildSessionId: "runtime-subagent-1",
            codexAcpEventType: "subagent_breadcrumb",
            codexAcpParentSessionId: "runtime-session-1",
            codexAcpSubagentEventType: "interaction_begin",
        };
        await client.sessionUpdate({
            _meta: interactionMeta,
            sessionId: "runtime-session-1",
            update: {
                _meta: interactionMeta,
                kind: "other",
                rawInput: {
                    prompt: "Inspect the failing stream",
                },
                sessionUpdate: "tool_call",
                status: "in_progress",
                title: "Contacting subagent",
                toolCallId: "codex-acp:subagent:interaction-terminal-race",
            },
        });
        await sendTurnLifecycle(client, {
            eventType: "turn_started",
            runtimeSessionId: "runtime-subagent-1",
            turnId: "turn-1",
        });

        emittedEvents.length = 0;
        const endMeta = {
            codexAcpChildSessionId: "runtime-subagent-1",
            codexAcpEventType: "subagent_breadcrumb",
            codexAcpParentSessionId: "runtime-session-1",
            codexAcpSubagentEventType: "interaction_end",
        };
        await client.sessionUpdate({
            _meta: endMeta,
            sessionId: "runtime-session-1",
            update: {
                _meta: endMeta,
                rawOutput: {
                    status: {
                        completed: "terminal response before lifecycle end",
                    },
                },
                sessionUpdate: "tool_call_update",
                status: "completed",
                title: "Galileo responded",
                toolCallId: "codex-acp:subagent:interaction-terminal-race",
            },
        });

        expect(
            getLatestPatchMessages(emittedEvents, childSnapshot.sessionId),
        ).toBeNull();
        for (const text of ["terminal response ", "before lifecycle end"]) {
            await client.sessionUpdate({
                sessionId: "runtime-subagent-1",
                update: {
                    content: {
                        text,
                        type: "text",
                    },
                    messageId: "child-terminal-echo",
                    sessionUpdate: "agent_message_chunk",
                },
            });
        }
        await vi.waitFor(() => {
            const assistantMessages =
                getLatestPatchMessages(
                    emittedEvents,
                    childSnapshot.sessionId,
                )?.filter((message) => message.kind === "assistant") ?? [];
            expect(assistantMessages.map((message) => message.content)).toEqual([
                "terminal response before lifecycle end",
            ]);
        });
        expect(
            hasPatchChangesMatching(
                emittedEvents,
                childSnapshot.sessionId,
                (changes) => changes.status === "idle",
            ),
        ).toBe(false);

        await sendTurnLifecycle(client, {
            eventType: "turn_complete",
            runtimeSessionId: "runtime-subagent-1",
            turnId: "turn-1",
        });
        await vi.waitFor(() => {
            expect(
                hasPatchChangesMatching(
                    emittedEvents,
                    childSnapshot.sessionId,
                    (changes) => changes.status === "idle",
                ),
            ).toBe(true);
        });
    });

    it("attaches open-session actions to Codex subagent breadcrumbs", async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        const emittedEvents: AiWorkerEventMessage[] = [];
        const runtime = new AiWorkerRuntime({
            emitEvent: (event) => {
                emittedEvents.push(event);
            },
        });
        const launch = createLaunch({
            cwd: tempDir,
            projectRoot: tempDir,
            title: "Subagent parent",
        });

        await runtime.dispatchMethod("ai.prepareSession", {
            input: launch.input,
            launch,
        });
        emittedEvents.length = 0;

        const client = latestClientFactory?.();
        expect(client).toBeDefined();
        const subagentMeta = {
            codexAcpAgentNickname: "Galileo",
            codexAcpChildSessionId: "runtime-subagent-1",
            codexAcpCwd: tempDir,
            codexAcpEventType: "subagent_session_created",
            codexAcpParentSessionId: "runtime-session-1",
        };
        await client!.sessionUpdate({
            _meta: subagentMeta,
            sessionId: "runtime-subagent-1",
            update: {
                _meta: subagentMeta,
                sessionUpdate: "session_info_update",
                title: "Galileo",
            },
        });

        const childSnapshot = getLatestSnapshot(
            emittedEvents,
            (snapshot) => snapshot.parentSessionId === "session-1",
        );
        expect(childSnapshot?.sessionId).toBeTruthy();

        emittedEvents.length = 0;
        const breadcrumbMeta = {
            codexAcpChildSessionId: "runtime-subagent-1",
            codexAcpEventType: "subagent_breadcrumb",
            codexAcpParentSessionId: "runtime-session-1",
            codexAcpSubagentEventType: "spawn_end",
        };
        await client!.sessionUpdate({
            _meta: breadcrumbMeta,
            sessionId: "runtime-session-1",
            update: {
                content: [
                    {
                        newText: "child breadcrumb text\n",
                        oldText: "parent text\n",
                        path: path.join(tempDir, "src/breadcrumb.ts"),
                        type: "diff",
                    },
                ],
                _meta: breadcrumbMeta,
                sessionUpdate: "tool_call_update",
                status: "completed",
                title: "Spawned Galileo",
                toolCallId: "codex-acp:subagent:spawn-1",
            },
        });

        await vi.waitFor(() => {
            const toolActivity = getLatestToolActivity(emittedEvents);
            expect(toolActivity).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        action: {
                            kind: "open_session",
                            sessionId: childSnapshot!.sessionId,
                        },
                        id: "codex-acp:subagent:spawn-1",
                    }),
                ]),
            );
        });
        expect(
            hasTrackedFileEvent(emittedEvents, "session-1", "src/breadcrumb.ts"),
        ).toBe(false);
    });

    it("keeps open-session actions when a breadcrumb arrives before child registration", async () => {
        const { client, emittedEvents } =
            await setupPreparedRuntimeWithClient("Subagent action race parent");

        const breadcrumbMeta = {
            codexAcpAgentNickname: "Cicero",
            codexAcpChildSessionId: "runtime-subagent-early",
            codexAcpEventType: "subagent_breadcrumb",
            codexAcpParentSessionId: "runtime-session-1",
            codexAcpSubagentEventType: "spawn_end",
        };
        await client.sessionUpdate({
            _meta: breadcrumbMeta,
            sessionId: "runtime-session-1",
            update: {
                _meta: breadcrumbMeta,
                sessionUpdate: "tool_call_update",
                status: "completed",
                title: "Spawned Cicero",
                toolCallId: "codex-acp:subagent:spawn-early",
            },
        });

        const childSnapshot = getLatestSnapshot(
            emittedEvents,
            (snapshot) =>
                snapshot.runtimeSessionId === "runtime-subagent-early" &&
                snapshot.parentSessionId === "session-1",
        );
        expect(childSnapshot).toEqual(
            expect.objectContaining({
                status: "idle",
                title: "Cicero",
            }),
        );
        expect(
            hasToolActivityMatching(
                emittedEvents,
                "session-1",
                (activity) =>
                    activity.id === "codex-acp:subagent:spawn-early" &&
                    activity.action?.kind === "open_session" &&
                    activity.action.sessionId === childSnapshot!.sessionId,
            ),
        ).toBe(true);

        emittedEvents.length = 0;
        const registrationMeta = {
            codexAcpAgentNickname: "Cicero",
            codexAcpChildSessionId: "runtime-subagent-early",
            codexAcpCwd: process.cwd(),
            codexAcpEventType: "subagent_session_created",
            codexAcpParentSessionId: "runtime-session-1",
        };
        await client.sessionUpdate({
            _meta: registrationMeta,
            sessionId: "runtime-subagent-early",
            update: {
                _meta: registrationMeta,
                sessionUpdate: "session_info_update",
                title: "Cicero",
            },
        });

        const registeredSnapshot = getLatestSnapshot(
            emittedEvents,
            (snapshot) =>
                snapshot.runtimeSessionId === "runtime-subagent-early" &&
                snapshot.parentSessionId === "session-1",
        );
        expect(registeredSnapshot?.sessionId ?? childSnapshot!.sessionId).toBe(
            childSnapshot!.sessionId,
        );

        emittedEvents.length = 0;
        await sendTurnLifecycle(client, {
            eventType: "turn_started",
            runtimeSessionId: "runtime-subagent-early",
            turnId: "turn-early",
        });
        await vi.waitFor(() => {
            expect(
                hasPatchChangesMatching(
                    emittedEvents,
                    childSnapshot!.sessionId,
                    (changes) => changes.status === "streaming",
                ),
            ).toBe(true);
        });
    });

    it("mirrors Codex subagent interaction breadcrumbs into the child thread", async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        const emittedEvents: AiWorkerEventMessage[] = [];
        const runtime = new AiWorkerRuntime({
            emitEvent: (event) => {
                emittedEvents.push(event);
            },
        });
        const launch = createLaunch({
            cwd: tempDir,
            projectRoot: tempDir,
            title: "Subagent interaction parent",
        });

        await runtime.dispatchMethod("ai.prepareSession", {
            input: launch.input,
            launch,
        });
        emittedEvents.length = 0;

        const client = latestClientFactory?.();
        expect(client).toBeDefined();
        const subagentMeta = {
            codexAcpAgentNickname: "Galileo",
            codexAcpChildSessionId: "runtime-subagent-1",
            codexAcpCwd: tempDir,
            codexAcpEventType: "subagent_session_created",
            codexAcpParentSessionId: "runtime-session-1",
        };
        await client!.sessionUpdate({
            _meta: subagentMeta,
            sessionId: "runtime-subagent-1",
            update: {
                _meta: subagentMeta,
                sessionUpdate: "session_info_update",
                title: "Galileo",
            },
        });

        const childSnapshot = getLatestSnapshot(
            emittedEvents,
            (snapshot) => snapshot.parentSessionId === "session-1",
        );
        expect(childSnapshot?.sessionId).toBeTruthy();
        emittedEvents.length = 0;

        const interactionBeginMeta = {
            codexAcpChildSessionId: "runtime-subagent-1",
            codexAcpEventType: "subagent_breadcrumb",
            codexAcpParentSessionId: "runtime-session-1",
            codexAcpSubagentEventType: "interaction_begin",
        };
        await client!.sessionUpdate({
            _meta: interactionBeginMeta,
            sessionId: "runtime-session-1",
            update: {
                _meta: interactionBeginMeta,
                kind: "other",
                rawInput: {
                    prompt: "Add a final hola line to ACTORES/Gabriel Boric.md",
                },
                sessionUpdate: "tool_call",
                status: "in_progress",
                title: "Contacting subagent",
                toolCallId: "codex-acp:subagent:interaction-1",
            },
        });

        await vi.waitFor(() => {
            expect(
                hasPatchChangesMatching(
                    emittedEvents,
                    childSnapshot!.sessionId,
                    (changes) => changes.status === "streaming",
                ),
            ).toBe(true);
        });
        expect(
            getLatestPatchMessages(emittedEvents, childSnapshot!.sessionId),
        ).toEqual([
            expect.objectContaining({
                content: "Add a final hola line to ACTORES/Gabriel Boric.md",
                kind: "user",
            }),
        ]);

        const interactionEndMeta = {
            codexAcpChildSessionId: "runtime-subagent-1",
            codexAcpEventType: "subagent_breadcrumb",
            codexAcpParentSessionId: "runtime-session-1",
            codexAcpSubagentEventType: "interaction_end",
        };
        await client!.sessionUpdate({
            _meta: interactionEndMeta,
            sessionId: "runtime-session-1",
            update: {
                _meta: interactionEndMeta,
                rawOutput: {
                    status: {
                        completed: "ACTORES/Gabriel Boric.md",
                    },
                },
                sessionUpdate: "tool_call_update",
                status: "completed",
                title: "Galileo responded",
                toolCallId: "codex-acp:subagent:interaction-1",
            },
        });

        await vi.waitFor(() => {
            expect(
                hasPatchChangesMatching(
                    emittedEvents,
                    childSnapshot!.sessionId,
                    (changes) =>
                        changes.activeTurnStartedAt === null &&
                        changes.status === "idle",
                ),
            ).toBe(true);
        });
        expect(
            getLatestPatchMessages(emittedEvents, childSnapshot!.sessionId),
        ).toEqual([
            expect.objectContaining({
                content: "Add a final hola line to ACTORES/Gabriel Boric.md",
                kind: "user",
            }),
        ]);
    });

    it("renders subagent child tool activity while keeping parent timeline isolated", async () => {
        const { client, emittedEvents, tempDir } =
            await setupPreparedRuntimeWithClient("Subagent visible tools parent");
        const childSnapshot = await registerSubagentSession(
            client,
            emittedEvents,
            tempDir,
            {
                nickname: "Galileo",
                runtimeSessionId: "runtime-subagent-1",
            },
        );

        emittedEvents.length = 0;
        await client.sessionUpdate({
            sessionId: "runtime-subagent-1",
            update: {
                kind: "execute",
                rawInput: {
                    command: "pnpm test",
                },
                sessionUpdate: "tool_call",
                status: "in_progress",
                title: "exec_command",
                toolCallId: "child-exec",
            },
        });
        await client.sessionUpdate({
            sessionId: "runtime-subagent-1",
            update: {
                _meta: {
                    terminal_output: {
                        data: "running\n",
                        terminal_id: "term-1",
                    },
                },
                kind: "execute",
                sessionUpdate: "tool_call_update",
                status: "completed",
                title: "Tool call",
                toolCallId: "child-exec",
            },
        });
        await client.sessionUpdate({
            sessionId: "runtime-subagent-1",
            update: {
                kind: "read",
                rawInput: {
                    filePath: path.join(tempDir, "src/input.ts"),
                },
                sessionUpdate: "tool_call",
                status: "completed",
                title: "read_file",
                toolCallId: "child-read",
            },
        });
        await client.sessionUpdate({
            sessionId: "runtime-subagent-1",
            update: {
                kind: "plan",
                sessionUpdate: "tool_call",
                status: "completed",
                title: "update_plan",
                toolCallId: "child-plan",
            },
        });

        await vi.waitFor(() => {
            expect(
                hasPatchChangesMatching(
                    emittedEvents,
                    childSnapshot.sessionId,
                    (changes) => changes.status === "streaming",
                ),
            ).toBe(true);
        });
        for (const expectedToolId of [
            "child-exec",
            "child-read",
            "child-plan",
        ]) {
            expect(
                hasToolActivityMatching(
                    emittedEvents,
                    childSnapshot.sessionId,
                    (activity) => activity.id === expectedToolId,
                ),
            ).toBe(true);
            expect(
                hasToolActivityMatching(
                    emittedEvents,
                    "session-1",
                    (activity) => activity.id === expectedToolId,
                ),
            ).toBe(false);
        }

        emittedEvents.length = 0;
        await client.sessionUpdate({
            sessionId: "runtime-subagent-1",
            update: {
                content: [
                    {
                        newText: "export const value = 2;\n",
                        oldText: "export const value = 1;\n",
                        path: path.join(tempDir, "src/subagent-tool.ts"),
                        type: "diff",
                    },
                ],
                kind: "edit",
                sessionUpdate: "tool_call_update",
                status: "completed",
                title: "Edit",
                toolCallId: "child-edit",
            },
        });

        await vi.waitFor(() => {
            expect(
                hasTrackedFileEvent(
                    emittedEvents,
                    childSnapshot.sessionId,
                    "src/subagent-tool.ts",
                ),
            ).toBe(true);
        });
        expect(
            hasToolActivityMatching(
                emittedEvents,
                childSnapshot.sessionId,
                (activity) => activity.id === "child-edit",
            ),
        ).toBe(true);
        expect(
            hasToolActivityMatching(
                emittedEvents,
                "session-1",
                (activity) => activity.id === "child-edit",
            ),
        ).toBe(false);
        expect(
            hasTrackedFileEvent(emittedEvents, "session-1", "src/subagent-tool.ts"),
        ).toBe(false);
    });

    it("renders Codex subagent user message chunks in the child thread", async () => {
        const { client, emittedEvents, tempDir } =
            await setupPreparedRuntimeWithClient("Subagent user chunk parent");
        const childSnapshot = await registerSubagentSession(
            client,
            emittedEvents,
            tempDir,
            {
                nickname: "Galileo",
                runtimeSessionId: "runtime-subagent-1",
            },
        );
        emittedEvents.length = 0;

        await sendTurnLifecycle(client, {
            eventType: "turn_started",
            runtimeSessionId: "runtime-subagent-1",
            turnId: "turn-1",
        });
        await client.sessionUpdate({
            sessionId: "runtime-subagent-1",
            update: {
                content: {
                    text: "Inspect the failing chat stream",
                    type: "text",
                },
                sessionUpdate: "user_message_chunk",
            },
        });

        await vi.waitFor(() => {
            expect(
                getLatestPatchMessages(
                    emittedEvents,
                    childSnapshot.sessionId,
                ),
            ).toEqual([
                expect.objectContaining({
                    content: "Inspect the failing chat stream",
                    kind: "user",
                }),
            ]);
        });
    });

    it("mirrors subagent prompts from breadcrumb content when raw input lacks prompt", async () => {
        const { client, emittedEvents, tempDir } =
            await setupPreparedRuntimeWithClient("Subagent prompt content fallback");
        const childSnapshot = await registerSubagentSession(
            client,
            emittedEvents,
            tempDir,
            {
                nickname: "Galileo",
                runtimeSessionId: "runtime-subagent-1",
            },
        );
        emittedEvents.length = 0;

        const resumeBeginMeta = {
            codexAcpChildSessionId: "runtime-subagent-1",
            codexAcpEventType: "subagent_breadcrumb",
            codexAcpParentSessionId: "runtime-session-1",
            codexAcpSubagentEventType: "resume_begin",
        };
        await client.sessionUpdate({
            _meta: resumeBeginMeta,
            sessionId: "runtime-session-1",
            update: {
                _meta: resumeBeginMeta,
                content: [
                    {
                        content: {
                            text: "Receiver: runtime-subagent-1\nPrompt: sin cambios\ncon contexto adicional",
                            type: "text",
                        },
                        type: "content",
                    },
                ],
                kind: "other",
                rawInput: {
                    receiver_thread_id: "runtime-subagent-1",
                },
                sessionUpdate: "tool_call",
                status: "in_progress",
                title: "Resuming Galileo",
                toolCallId: "codex-acp:subagent:resume-content-prompt",
            },
        });

        await vi.waitFor(() => {
            const userMessages =
                getLatestPatchMessages(
                    emittedEvents,
                    childSnapshot.sessionId,
                )?.filter((message) => message.kind === "user") ?? [];
            expect(userMessages.map((message) => message.content)).toEqual([
                "sin cambios\ncon contexto adicional",
            ]);
        });
    });

    it("does not duplicate mirrored subagent prompts when user chunks also arrive", async () => {
        const { client, emittedEvents, tempDir } =
            await setupPreparedRuntimeWithClient("Subagent user dedupe parent");
        const childSnapshot = await registerSubagentSession(
            client,
            emittedEvents,
            tempDir,
            {
                nickname: "Galileo",
                runtimeSessionId: "runtime-subagent-1",
            },
        );
        emittedEvents.length = 0;

        const interactionBeginMeta = {
            codexAcpChildSessionId: "runtime-subagent-1",
            codexAcpEventType: "subagent_breadcrumb",
            codexAcpParentSessionId: "runtime-session-1",
            codexAcpSubagentEventType: "interaction_begin",
        };
        await client.sessionUpdate({
            _meta: interactionBeginMeta,
            sessionId: "runtime-session-1",
            update: {
                _meta: interactionBeginMeta,
                kind: "other",
                rawInput: {
                    prompt: "Inspect the failing chat stream",
                },
                sessionUpdate: "tool_call",
                status: "in_progress",
                title: "Contacting subagent",
                toolCallId: "codex-acp:subagent:interaction-dedupe",
            },
        });
        await client.sessionUpdate({
            sessionId: "runtime-subagent-1",
            update: {
                content: {
                    text: "Inspect the failing chat stream",
                    type: "text",
                },
                sessionUpdate: "user_message_chunk",
            },
        });

        await vi.waitFor(() => {
            const messages = getLatestPatchMessages(
                emittedEvents,
                childSnapshot.sessionId,
            );
            expect(
                messages?.filter(
                    (message) =>
                        message.kind === "user" &&
                        message.content === "Inspect the failing chat stream",
                ),
            ).toHaveLength(1);
        });
    });

    it("mirrors repeated subagent prompts with distinct tool call ids", async () => {
        const { client, emittedEvents, tempDir } =
            await setupPreparedRuntimeWithClient("Subagent repeated prompt parent");
        const childSnapshot = await registerSubagentSession(
            client,
            emittedEvents,
            tempDir,
            {
                nickname: "Galileo",
                runtimeSessionId: "runtime-subagent-1",
            },
        );
        emittedEvents.length = 0;

        for (const toolCallId of [
            "codex-acp:subagent:interaction-repeat-1",
            "codex-acp:subagent:interaction-repeat-2",
        ]) {
            const interactionBeginMeta = {
                codexAcpChildSessionId: "runtime-subagent-1",
                codexAcpEventType: "subagent_breadcrumb",
                codexAcpParentSessionId: "runtime-session-1",
                codexAcpSubagentEventType: "interaction_begin",
            };
            await client.sessionUpdate({
                _meta: interactionBeginMeta,
                sessionId: "runtime-session-1",
                update: {
                    _meta: interactionBeginMeta,
                    kind: "other",
                    rawInput: {
                        prompt: "Repeat this prompt",
                    },
                    sessionUpdate: "tool_call",
                    status: "in_progress",
                    title: "Contacting subagent",
                    toolCallId,
                },
            });
        }

        await vi.waitFor(() => {
            const userMessages =
                getLatestPatchMessages(
                    emittedEvents,
                    childSnapshot.sessionId,
                )?.filter((message) => message.kind === "user") ?? [];
            expect(userMessages.map((message) => message.content)).toEqual([
                "Repeat this prompt",
                "Repeat this prompt",
            ]);
        });
    });

    it("does not duplicate direct subagent prompts when ACP echoes split user chunks", async () => {
        const { client, emittedEvents, launch, runtime, tempDir } =
            await setupPreparedRuntimeWithClient("Subagent direct user dedupe parent");
        const childSnapshot = await registerSubagentSession(
            client,
            emittedEvents,
            tempDir,
            {
                nickname: "Galileo",
                runtimeSessionId: "runtime-subagent-1",
            },
        );
        emittedEvents.length = 0;

        promptMock.mockImplementationOnce(async () => {
            await client.sessionUpdate({
                sessionId: "runtime-subagent-1",
                update: {
                    content: {
                        text: "hello ",
                        type: "text",
                    },
                    sessionUpdate: "user_message_chunk",
                },
            });
            await client.sessionUpdate({
                sessionId: "runtime-subagent-1",
                update: {
                    content: {
                        text: "child",
                        type: "text",
                    },
                    sessionUpdate: "user_message_chunk",
                },
            });
            return {
                stopReason: "completed",
            };
        });

        const childLaunch: AiWorkerSessionLaunchInput = {
            ...launch,
            input: {
                ...launch.input,
                sessionId: childSnapshot.sessionId,
                title: childSnapshot.title,
            },
            persistedSnapshot: childSnapshot,
        };
        await runtime.dispatchMethod("ai.sendPrompt", {
            input: {
                attachments: [],
                projectId: null,
                prompt: "hello child",
                runtimeId: "codex",
                sessionId: childSnapshot.sessionId,
                title: childSnapshot.title,
                worktreeId: null,
            },
            launch: childLaunch,
        });

        await vi.waitFor(() => {
            const messages = getLatestPatchMessages(
                emittedEvents,
                childSnapshot.sessionId,
            );
            expect(messages?.filter((message) => message.kind === "user")).toEqual(
                [
                    expect.objectContaining({
                        content: "hello child",
                    }),
                ],
            );
        });
    });

    it("does not duplicate mirrored subagent prompts when split user chunks arrive", async () => {
        const { client, emittedEvents, tempDir } =
            await setupPreparedRuntimeWithClient("Subagent split user dedupe parent");
        const childSnapshot = await registerSubagentSession(
            client,
            emittedEvents,
            tempDir,
            {
                nickname: "Galileo",
                runtimeSessionId: "runtime-subagent-1",
            },
        );
        emittedEvents.length = 0;

        const interactionBeginMeta = {
            codexAcpChildSessionId: "runtime-subagent-1",
            codexAcpEventType: "subagent_breadcrumb",
            codexAcpParentSessionId: "runtime-session-1",
            codexAcpSubagentEventType: "interaction_begin",
        };
        await client.sessionUpdate({
            _meta: interactionBeginMeta,
            sessionId: "runtime-session-1",
            update: {
                _meta: interactionBeginMeta,
                kind: "other",
                rawInput: {
                    prompt: "Inspect the failing chat stream",
                },
                sessionUpdate: "tool_call",
                status: "in_progress",
                title: "Contacting subagent",
                toolCallId: "codex-acp:subagent:interaction-split-dedupe",
            },
        });
        await client.sessionUpdate({
            sessionId: "runtime-subagent-1",
            update: {
                content: {
                    text: "Inspect the ",
                    type: "text",
                },
                sessionUpdate: "user_message_chunk",
            },
        });
        await client.sessionUpdate({
            sessionId: "runtime-subagent-1",
            update: {
                content: {
                    text: "failing chat stream",
                    type: "text",
                },
                sessionUpdate: "user_message_chunk",
            },
        });

        await vi.waitFor(() => {
            const messages = getLatestPatchMessages(
                emittedEvents,
                childSnapshot.sessionId,
            );
            expect(messages?.filter((message) => message.kind === "user")).toEqual(
                [
                    expect.objectContaining({
                        content: "Inspect the failing chat stream",
                    }),
                ],
            );
        });
    });

    it("completes a streaming subagent user prefix when the mirrored prompt arrives later", async () => {
        const { client, emittedEvents, tempDir } =
            await setupPreparedRuntimeWithClient("Subagent late prompt parent");
        const childSnapshot = await registerSubagentSession(
            client,
            emittedEvents,
            tempDir,
            {
                nickname: "Galileo",
                runtimeSessionId: "runtime-subagent-1",
            },
        );
        emittedEvents.length = 0;

        await client.sessionUpdate({
            sessionId: "runtime-subagent-1",
            update: {
                content: {
                    text: "Inspect the ",
                    type: "text",
                },
                sessionUpdate: "user_message_chunk",
            },
        });

        const interactionBeginMeta = {
            codexAcpChildSessionId: "runtime-subagent-1",
            codexAcpEventType: "subagent_breadcrumb",
            codexAcpParentSessionId: "runtime-session-1",
            codexAcpSubagentEventType: "interaction_begin",
        };
        await client.sessionUpdate({
            _meta: interactionBeginMeta,
            sessionId: "runtime-session-1",
            update: {
                _meta: interactionBeginMeta,
                kind: "other",
                rawInput: {
                    prompt: "Inspect the failing chat stream",
                },
                sessionUpdate: "tool_call",
                status: "in_progress",
                title: "Contacting subagent",
                toolCallId: "codex-acp:subagent:interaction-late-prompt",
            },
        });
        await client.sessionUpdate({
            sessionId: "runtime-subagent-1",
            update: {
                content: {
                    text: "failing chat stream",
                    type: "text",
                },
                sessionUpdate: "user_message_chunk",
            },
        });

        await vi.waitFor(() => {
            const messages = getLatestPatchMessages(
                emittedEvents,
                childSnapshot.sessionId,
            );
            expect(messages?.filter((message) => message.kind === "user")).toEqual(
                [
                    expect.objectContaining({
                        content: "Inspect the failing chat stream",
                        status: "completed",
                    }),
                ],
            );
        });
    });

    it("does not rewrite completed subagent user messages when a later prompt shares a prefix", async () => {
        const { client, emittedEvents, tempDir } =
            await setupPreparedRuntimeWithClient("Subagent prefix prompt parent");
        const childSnapshot = await registerSubagentSession(
            client,
            emittedEvents,
            tempDir,
            {
                nickname: "Galileo",
                runtimeSessionId: "runtime-subagent-1",
            },
        );
        emittedEvents.length = 0;

        await sendTurnLifecycle(client, {
            eventType: "turn_started",
            runtimeSessionId: "runtime-subagent-1",
            turnId: "turn-1",
        });
        await client.sessionUpdate({
            sessionId: "runtime-subagent-1",
            update: {
                content: {
                    text: "Fix",
                    type: "text",
                },
                sessionUpdate: "user_message_chunk",
            },
        });
        await sendTurnLifecycle(client, {
            eventType: "turn_complete",
            runtimeSessionId: "runtime-subagent-1",
            turnId: "turn-1",
        });

        const interactionBeginMeta = {
            codexAcpChildSessionId: "runtime-subagent-1",
            codexAcpEventType: "subagent_breadcrumb",
            codexAcpParentSessionId: "runtime-session-1",
            codexAcpSubagentEventType: "interaction_begin",
        };
        await client.sessionUpdate({
            _meta: interactionBeginMeta,
            sessionId: "runtime-session-1",
            update: {
                _meta: interactionBeginMeta,
                kind: "other",
                rawInput: {
                    prompt: "Fix tests",
                },
                sessionUpdate: "tool_call",
                status: "in_progress",
                title: "Contacting subagent",
                toolCallId: "codex-acp:subagent:interaction-prefix",
            },
        });

        await vi.waitFor(() => {
            const messages = getLatestPatchMessages(
                emittedEvents,
                childSnapshot.sessionId,
            );
            expect(
                messages
                    ?.filter((message) => message.kind === "user")
                    .map((message) => message.content),
            ).toEqual(["Fix", "Fix tests"]);
        });
    });

    it("clears mirrored prompt echo state when a subagent turn aborts", async () => {
        const { client, emittedEvents, tempDir } =
            await setupPreparedRuntimeWithClient("Subagent abort cleanup parent");
        const childSnapshot = await registerSubagentSession(
            client,
            emittedEvents,
            tempDir,
            {
                nickname: "Galileo",
                runtimeSessionId: "runtime-subagent-1",
            },
        );
        emittedEvents.length = 0;

        const interactionBeginMeta = {
            codexAcpChildSessionId: "runtime-subagent-1",
            codexAcpEventType: "subagent_breadcrumb",
            codexAcpParentSessionId: "runtime-session-1",
            codexAcpSubagentEventType: "interaction_begin",
        };
        await client.sessionUpdate({
            _meta: interactionBeginMeta,
            sessionId: "runtime-session-1",
            update: {
                _meta: interactionBeginMeta,
                kind: "other",
                rawInput: {
                    prompt: "Fix tests",
                },
                sessionUpdate: "tool_call",
                status: "in_progress",
                title: "Contacting subagent",
                toolCallId: "codex-acp:subagent:interaction-abort-cleanup",
            },
        });
        await sendTurnLifecycle(client, {
            eventType: "turn_aborted",
            runtimeSessionId: "runtime-subagent-1",
            turnId: "turn-abort",
        });
        await client.sessionUpdate({
            sessionId: "runtime-subagent-1",
            update: {
                content: {
                    text: "Fix",
                    type: "text",
                },
                sessionUpdate: "user_message_chunk",
            },
        });

        await vi.waitFor(() => {
            const messages = getLatestPatchMessages(
                emittedEvents,
                childSnapshot.sessionId,
            );
            expect(
                messages
                    ?.filter((message) => message.kind === "user")
                    .map((message) => message.content),
            ).toEqual(["Fix tests", "Fix"]);
        });
    });

    it("does not append mirrored interaction responses after real child assistant output", async () => {
        const { client, emittedEvents, tempDir } =
            await setupPreparedRuntimeWithClient("Subagent assistant dedupe parent");
        const childSnapshot = await registerSubagentSession(
            client,
            emittedEvents,
            tempDir,
            {
                nickname: "Galileo",
                runtimeSessionId: "runtime-subagent-1",
            },
        );
        emittedEvents.length = 0;

        const interactionBeginMeta = {
            codexAcpChildSessionId: "runtime-subagent-1",
            codexAcpEventType: "subagent_breadcrumb",
            codexAcpParentSessionId: "runtime-session-1",
            codexAcpSubagentEventType: "interaction_begin",
        };
        await client.sessionUpdate({
            _meta: interactionBeginMeta,
            sessionId: "runtime-session-1",
            update: {
                _meta: interactionBeginMeta,
                kind: "other",
                rawInput: {
                    prompt: "Report on the chat stream",
                },
                sessionUpdate: "tool_call",
                status: "in_progress",
                title: "Contacting subagent",
                toolCallId: "codex-acp:subagent:interaction-assistant-dedupe",
            },
        });
        await client.sessionUpdate({
            sessionId: "runtime-subagent-1",
            update: {
                content: {
                    text: "real child answer",
                    type: "text",
                },
                sessionUpdate: "agent_message_chunk",
            },
        });

        const interactionEndMeta = {
            codexAcpChildSessionId: "runtime-subagent-1",
            codexAcpEventType: "subagent_breadcrumb",
            codexAcpParentSessionId: "runtime-session-1",
            codexAcpSubagentEventType: "interaction_end",
        };
        await client.sessionUpdate({
            _meta: interactionEndMeta,
            sessionId: "runtime-session-1",
            update: {
                _meta: interactionEndMeta,
                rawOutput: {
                    status: {
                        completed: "fallback status answer",
                    },
                },
                sessionUpdate: "tool_call_update",
                status: "completed",
                title: "Galileo responded",
                toolCallId: "codex-acp:subagent:interaction-assistant-dedupe",
            },
        });

        await vi.waitFor(() => {
            const messages = getLatestPatchMessages(
                emittedEvents,
                childSnapshot.sessionId,
            );
            expect(
                messages?.filter(
                    (message) =>
                        message.kind === "assistant" &&
                        message.content === "real child answer",
                ),
            ).toHaveLength(1);
            expect(
                messages?.some(
                    (message) => message.content === "fallback status answer",
                ),
            ).toBe(false);
        });
    });

    it("does not append mirrored waiting-end responses after real child assistant output", async () => {
        const { client, emittedEvents, tempDir } =
            await setupPreparedRuntimeWithClient("Subagent waiting dedupe parent");
        const childSnapshot = await registerSubagentSession(
            client,
            emittedEvents,
            tempDir,
            {
                nickname: "Galileo",
                runtimeSessionId: "runtime-subagent-1",
            },
        );
        emittedEvents.length = 0;

        const interactionBeginMeta = {
            codexAcpChildSessionId: "runtime-subagent-1",
            codexAcpEventType: "subagent_breadcrumb",
            codexAcpParentSessionId: "runtime-session-1",
            codexAcpSubagentEventType: "interaction_begin",
        };
        await client.sessionUpdate({
            _meta: interactionBeginMeta,
            sessionId: "runtime-session-1",
            update: {
                _meta: interactionBeginMeta,
                kind: "other",
                rawInput: {
                    prompt: "Keep working until wait finishes",
                },
                sessionUpdate: "tool_call",
                status: "in_progress",
                title: "Contacting subagent",
                toolCallId: "codex-acp:subagent:interaction-waiting-dedupe",
            },
        });
        await client.sessionUpdate({
            sessionId: "runtime-subagent-1",
            update: {
                content: {
                    text: "real waiting answer",
                    type: "text",
                },
                sessionUpdate: "agent_message_chunk",
            },
        });

        const waitingEndMeta = {
            codexAcpEventType: "subagent_breadcrumb",
            codexAcpParentSessionId: "runtime-session-1",
            codexAcpSubagentEventType: "waiting_end",
        };
        await client.sessionUpdate({
            _meta: waitingEndMeta,
            sessionId: "runtime-session-1",
            update: {
                _meta: waitingEndMeta,
                rawOutput: {
                    agent_statuses: [
                        {
                            agent_nickname: "Galileo",
                            status: {
                                completed: "fallback waiting answer",
                            },
                            thread_id: "runtime-subagent-1",
                        },
                    ],
                },
                sessionUpdate: "tool_call_update",
                status: "completed",
                title: "Subagents finished",
                toolCallId: "codex-acp:subagent:waiting-dedupe",
            },
        });

        await vi.waitFor(() => {
            const messages = getLatestPatchMessages(
                emittedEvents,
                childSnapshot.sessionId,
            );
            expect(
                messages?.filter(
                    (message) =>
                        message.kind === "assistant" &&
                        message.content === "real waiting answer",
                ),
            ).toHaveLength(1);
            expect(
                messages?.some(
                    (message) => message.content === "fallback waiting answer",
                ),
            ).toBe(false);
        });
    });

    it("mirrors Codex subagent resume breadcrumbs after an explicit close", async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        const emittedEvents: AiWorkerEventMessage[] = [];
        const runtime = new AiWorkerRuntime({
            emitEvent: (event) => {
                emittedEvents.push(event);
            },
        });
        const launch = createLaunch({
            cwd: tempDir,
            projectRoot: tempDir,
            title: "Subagent resume parent",
        });

        await runtime.dispatchMethod("ai.prepareSession", {
            input: launch.input,
            launch,
        });
        emittedEvents.length = 0;

        const client = latestClientFactory?.();
        expect(client).toBeDefined();
        const subagentMeta = {
            codexAcpAgentNickname: "Galileo",
            codexAcpChildSessionId: "runtime-subagent-1",
            codexAcpCwd: tempDir,
            codexAcpEventType: "subagent_session_created",
            codexAcpParentSessionId: "runtime-session-1",
        };
        await client!.sessionUpdate({
            _meta: subagentMeta,
            sessionId: "runtime-subagent-1",
            update: {
                _meta: subagentMeta,
                sessionUpdate: "session_info_update",
                title: "Galileo",
            },
        });

        const childSnapshot = getLatestSnapshot(
            emittedEvents,
            (snapshot) => snapshot.parentSessionId === "session-1",
        );
        expect(childSnapshot?.sessionId).toBeTruthy();
        await markRuntimeSessionStreaming(
            client!,
            "runtime-subagent-1",
            "resume-before-close",
        );
        await vi.waitFor(() => {
            expect(
                hasPatchChangesMatching(
                    emittedEvents,
                    childSnapshot!.sessionId,
                    (changes) => changes.status === "streaming",
                ),
            ).toBe(true);
        });
        emittedEvents.length = 0;

        const closeBreadcrumbMeta = {
            codexAcpChildSessionId: "runtime-subagent-1",
            codexAcpEventType: "subagent_breadcrumb",
            codexAcpParentSessionId: "runtime-session-1",
            codexAcpSubagentEventType: "close_end",
        };
        await client!.sessionUpdate({
            _meta: closeBreadcrumbMeta,
            sessionId: "runtime-session-1",
            update: {
                _meta: closeBreadcrumbMeta,
                sessionUpdate: "tool_call_update",
                status: "completed",
                title: "Closed Galileo",
                toolCallId: "codex-acp:subagent:close-1",
            },
        });
        await vi.waitFor(() => {
            expect(
                hasPatchChangesMatching(
                    emittedEvents,
                    childSnapshot!.sessionId,
                    (changes) =>
                        changes.closedAt !== undefined &&
                        changes.status === "idle",
                ),
            ).toBe(true);
        });
        emittedEvents.length = 0;

        const resumeBeginMeta = {
            codexAcpChildSessionId: "runtime-subagent-1",
            codexAcpEventType: "subagent_breadcrumb",
            codexAcpParentSessionId: "runtime-session-1",
            codexAcpSubagentEventType: "resume_begin",
        };
        await client!.sessionUpdate({
            _meta: resumeBeginMeta,
            sessionId: "runtime-session-1",
            update: {
                _meta: resumeBeginMeta,
                kind: "other",
                sessionUpdate: "tool_call",
                status: "in_progress",
                title: "Resuming Galileo",
                toolCallId: "codex-acp:subagent:resume-1",
            },
        });

        await vi.waitFor(() => {
            expect(
                hasPatchChangesMatching(
                    emittedEvents,
                    childSnapshot!.sessionId,
                    (changes) =>
                        changes.closedAt === null &&
                        changes.status === "streaming",
                ),
            ).toBe(true);
        });

        const resumeEndMeta = {
            codexAcpChildSessionId: "runtime-subagent-1",
            codexAcpEventType: "subagent_breadcrumb",
            codexAcpParentSessionId: "runtime-session-1",
            codexAcpSubagentEventType: "resume_end",
        };
        await client!.sessionUpdate({
            _meta: resumeEndMeta,
            sessionId: "runtime-session-1",
            update: {
                _meta: resumeEndMeta,
                content: [
                    {
                        text: "Status: completed: reopened and reported",
                        type: "content",
                    },
                ],
                rawOutput: {
                    status: {
                        completed: "reopened and reported",
                    },
                },
                sessionUpdate: "tool_call_update",
                status: "completed",
                title: "Resumed Galileo",
                toolCallId: "codex-acp:subagent:resume-1",
            },
        });

        await vi.waitFor(() => {
            expect(
                hasPatchChangesMatching(
                    emittedEvents,
                    childSnapshot!.sessionId,
                    (changes) =>
                        changes.activeTurnStartedAt === null &&
                        changes.status === "idle",
                ),
            ).toBe(true);
        });
        expect(
            getLatestPatchMessages(
                emittedEvents,
                childSnapshot!.sessionId,
            )?.some(
                (message) =>
                    message.kind === "assistant" &&
                    message.content === "reopened and reported",
            ),
        ).toBe(false);
    });

    it("does not mark subagents idle for running interaction or resume breadcrumbs", async () => {
        const { client, emittedEvents, tempDir } =
            await setupPreparedRuntimeWithClient("Subagent running breadcrumb parent");
        const childSnapshot = await registerSubagentSession(
            client,
            emittedEvents,
            tempDir,
            {
                nickname: "Galileo",
                runtimeSessionId: "runtime-subagent-1",
            },
        );

        for (const [beginType, endType, toolCallId] of [
            ["interaction_begin", "interaction_end", "interaction-running"],
            ["resume_begin", "resume_end", "resume-running"],
        ] as const) {
            const beginMeta = {
                codexAcpChildSessionId: "runtime-subagent-1",
                codexAcpEventType: "subagent_breadcrumb",
                codexAcpParentSessionId: "runtime-session-1",
                codexAcpSubagentEventType: beginType,
            };
            await client.sessionUpdate({
                _meta: beginMeta,
                sessionId: "runtime-session-1",
                update: {
                    _meta: beginMeta,
                    kind: "other",
                    sessionUpdate: "tool_call",
                    status: "in_progress",
                    title: "Contacting subagent",
                    toolCallId,
                },
            });
            if (beginType === "interaction_begin") {
                await vi.waitFor(() => {
                    expect(
                        hasPatchChangesMatching(
                            emittedEvents,
                            childSnapshot.sessionId,
                            (changes) => changes.status === "streaming",
                        ),
                    ).toBe(true);
                });
            }

            emittedEvents.length = 0;
            const endMeta = {
                codexAcpAgentStatus: "running",
                codexAcpChildSessionId: "runtime-subagent-1",
                codexAcpEventType: "subagent_breadcrumb",
                codexAcpParentSessionId: "runtime-session-1",
                codexAcpSubagentEventType: endType,
            };
            await client.sessionUpdate({
                _meta: endMeta,
                sessionId: "runtime-session-1",
                update: {
                    _meta: endMeta,
                    rawOutput: {
                        status: "running",
                    },
                    sessionUpdate: "tool_call_update",
                    status: "completed",
                    title: "Galileo still running",
                    toolCallId,
                },
            });

            expect(
                hasPatchChangesMatching(
                    emittedEvents,
                    childSnapshot.sessionId,
                    (changes) => changes.status === "idle",
                ),
            ).toBe(false);
        }
    });

    it("marks child threads idle when the parent receives a waiting-end summary", async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        const emittedEvents: AiWorkerEventMessage[] = [];
        const runtime = new AiWorkerRuntime({
            emitEvent: (event) => {
                emittedEvents.push(event);
            },
        });
        const launch = createLaunch({
            cwd: tempDir,
            projectRoot: tempDir,
            title: "Subagent waiting parent",
        });

        await runtime.dispatchMethod("ai.prepareSession", {
            input: launch.input,
            launch,
        });
        emittedEvents.length = 0;

        const client = latestClientFactory?.();
        expect(client).toBeDefined();
        const subagentMeta = {
            codexAcpAgentNickname: "Galileo",
            codexAcpChildSessionId: "runtime-subagent-1",
            codexAcpCwd: tempDir,
            codexAcpEventType: "subagent_session_created",
            codexAcpParentSessionId: "runtime-session-1",
        };
        await client!.sessionUpdate({
            _meta: subagentMeta,
            sessionId: "runtime-subagent-1",
            update: {
                _meta: subagentMeta,
                sessionUpdate: "session_info_update",
                title: "Galileo",
            },
        });

        const childSnapshot = getLatestSnapshot(
            emittedEvents,
            (snapshot) => snapshot.parentSessionId === "session-1",
        );
        expect(childSnapshot?.sessionId).toBeTruthy();
        emittedEvents.length = 0;

        const interactionBeginMeta = {
            codexAcpChildSessionId: "runtime-subagent-1",
            codexAcpEventType: "subagent_breadcrumb",
            codexAcpParentSessionId: "runtime-session-1",
            codexAcpSubagentEventType: "interaction_begin",
        };
        await client!.sessionUpdate({
            _meta: interactionBeginMeta,
            sessionId: "runtime-session-1",
            update: {
                _meta: interactionBeginMeta,
                kind: "other",
                rawInput: {
                    prompt: "Report back without closing.",
                },
                sessionUpdate: "tool_call",
                status: "in_progress",
                title: "Contacting subagent",
                toolCallId: "codex-acp:subagent:interaction-1",
            },
        });
        await vi.waitFor(() => {
            expect(
                hasPatchChangesMatching(
                    emittedEvents,
                    childSnapshot!.sessionId,
                    (changes) => changes.status === "streaming",
                ),
            ).toBe(true);
        });
        emittedEvents.length = 0;

        const waitingEndMeta = {
            codexAcpEventType: "subagent_breadcrumb",
            codexAcpParentSessionId: "runtime-session-1",
            codexAcpSubagentEventType: "waiting_end",
        };
        await client!.sessionUpdate({
            _meta: waitingEndMeta,
            sessionId: "runtime-session-1",
            update: {
                _meta: waitingEndMeta,
                content: [
                    {
                        text: "Galileo: completed: report complete",
                        type: "content",
                    },
                ],
                rawOutput: {
                    agent_statuses: [
                        {
                            agent_nickname: "Galileo",
                            status: {
                                completed: "report complete",
                            },
                            thread_id: "runtime-subagent-1",
                        },
                    ],
                },
                sessionUpdate: "tool_call_update",
                status: "completed",
                title: "Subagents finished",
                toolCallId: "codex-acp:subagent:waiting-1",
            },
        });

        await vi.waitFor(() => {
            expect(
                hasPatchChangesMatching(
                    emittedEvents,
                    childSnapshot!.sessionId,
                    (changes) => changes.status === "idle",
                ),
            ).toBe(true);
        });
        expect(
            getLatestPatchMessages(emittedEvents, childSnapshot!.sessionId),
        ).toEqual([
            expect.objectContaining({
                content: "Report back without closing.",
                kind: "user",
            }),
        ]);
    });

    it("does not idle all subagents when waiting-end has no child statuses", async () => {
        const { client, emittedEvents, tempDir } =
            await setupPreparedRuntimeWithClient("Subagent waiting no-status parent");
        const firstChild = await registerSubagentSession(
            client,
            emittedEvents,
            tempDir,
            {
                nickname: "Galileo",
                runtimeSessionId: "runtime-subagent-1",
            },
        );
        const secondChild = await registerSubagentSession(
            client,
            emittedEvents,
            tempDir,
            {
                nickname: "Curie",
                runtimeSessionId: "runtime-subagent-2",
            },
        );

        await markRuntimeSessionStreaming(client, "runtime-subagent-1", "first");
        await markRuntimeSessionStreaming(client, "runtime-subagent-2", "second");
        await vi.waitFor(() => {
            expect(
                hasPatchChangesMatching(
                    emittedEvents,
                    firstChild.sessionId,
                    (changes) => changes.status === "streaming",
                ),
            ).toBe(true);
            expect(
                hasPatchChangesMatching(
                    emittedEvents,
                    secondChild.sessionId,
                    (changes) => changes.status === "streaming",
                ),
            ).toBe(true);
        });
        emittedEvents.length = 0;

        const waitingEndMeta = {
            codexAcpEventType: "subagent_breadcrumb",
            codexAcpParentSessionId: "runtime-session-1",
            codexAcpSubagentEventType: "waiting_end",
        };
        await client.sessionUpdate({
            _meta: waitingEndMeta,
            sessionId: "runtime-session-1",
            update: {
                _meta: waitingEndMeta,
                sessionUpdate: "tool_call_update",
                status: "completed",
                title: "Subagents finished",
                toolCallId: "codex-acp:subagent:waiting-empty",
            },
        });

        expect(
            hasPatchChangesMatching(
                emittedEvents,
                firstChild.sessionId,
                (changes) => changes.status === "idle",
            ),
        ).toBe(false);
        expect(
            hasPatchChangesMatching(
                emittedEvents,
                secondChild.sessionId,
                (changes) => changes.status === "idle",
            ),
        ).toBe(false);
    });

    it("idles only terminal subagents from structured waiting-end statuses", async () => {
        const { client, emittedEvents, tempDir } =
            await setupPreparedRuntimeWithClient("Subagent waiting mixed parent");
        const firstChild = await registerSubagentSession(
            client,
            emittedEvents,
            tempDir,
            {
                nickname: "Galileo",
                runtimeSessionId: "runtime-subagent-1",
            },
        );
        const secondChild = await registerSubagentSession(
            client,
            emittedEvents,
            tempDir,
            {
                nickname: "Curie",
                runtimeSessionId: "runtime-subagent-2",
            },
        );

        await markRuntimeSessionStreaming(client, "runtime-subagent-1", "first");
        await markRuntimeSessionStreaming(client, "runtime-subagent-2", "second");
        await vi.waitFor(() => {
            expect(
                hasPatchChangesMatching(
                    emittedEvents,
                    firstChild.sessionId,
                    (changes) => changes.status === "streaming",
                ),
            ).toBe(true);
            expect(
                hasPatchChangesMatching(
                    emittedEvents,
                    secondChild.sessionId,
                    (changes) => changes.status === "streaming",
                ),
            ).toBe(true);
        });
        emittedEvents.length = 0;

        const waitingEndMeta = {
            codexAcpAgentStatuses: [
                {
                    codexAcpAgentStatus: {
                        completed: "first report complete",
                    },
                    codexAcpChildSessionId: "runtime-subagent-1",
                },
                {
                    codexAcpAgentStatus: "running",
                    codexAcpChildSessionId: "runtime-subagent-2",
                },
            ],
            codexAcpEventType: "subagent_breadcrumb",
            codexAcpParentSessionId: "runtime-session-1",
            codexAcpSubagentEventType: "waiting_end",
        };
        await client.sessionUpdate({
            _meta: waitingEndMeta,
            sessionId: "runtime-session-1",
            update: {
                _meta: waitingEndMeta,
                sessionUpdate: "tool_call_update",
                status: "completed",
                title: "Subagents finished",
                toolCallId: "codex-acp:subagent:waiting-mixed",
            },
        });

        await vi.waitFor(() => {
            expect(
                hasPatchChangesMatching(
                    emittedEvents,
                    firstChild.sessionId,
                    (changes) =>
                        changes.activeTurnStartedAt === null &&
                        changes.status === "idle",
                ),
            ).toBe(true);
        });
        expect(
            hasPatchChangesMatching(
                emittedEvents,
                secondChild.sessionId,
                (changes) => changes.status === "idle",
            ),
        ).toBe(false);
        expect(
            getLatestPatchMessages(emittedEvents, firstChild.sessionId)?.some(
                (message) =>
                    message.kind === "assistant" &&
                    message.content === "first report complete",
            ),
        ).toBe(false);
    });

    it("keeps subagent diffs isolated from parent tracked files", async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
        await fs.writeFile(
            path.join(tempDir, "src/only-child.ts"),
            "child before\n",
            "utf8",
        );
        await fs.writeFile(
            path.join(tempDir, "src/shared.ts"),
            "shared before\n",
            "utf8",
        );

        const emittedEvents: AiWorkerEventMessage[] = [];
        const runtime = new AiWorkerRuntime({
            emitEvent: (event) => {
                emittedEvents.push(event);
            },
        });
        const launch = createLaunch({
            cwd: tempDir,
            projectRoot: tempDir,
            title: "Subagent diff parent",
        });

        await runtime.dispatchMethod("ai.prepareSession", {
            input: launch.input,
            launch,
        });
        emittedEvents.length = 0;

        const client = latestClientFactory?.();
        expect(client).toBeDefined();
        const subagentMeta = {
            codexAcpAgentNickname: "Galileo",
            codexAcpChildSessionId: "runtime-subagent-1",
            codexAcpCwd: tempDir,
            codexAcpEventType: "subagent_session_created",
            codexAcpParentSessionId: "runtime-session-1",
        };
        await client!.sessionUpdate({
            _meta: subagentMeta,
            sessionId: "runtime-subagent-1",
            update: {
                _meta: subagentMeta,
                sessionUpdate: "session_info_update",
                title: "Galileo",
            },
        });

        const childSnapshot = getLatestSnapshot(
            emittedEvents,
            (snapshot) => snapshot.parentSessionId === "session-1",
        );
        expect(childSnapshot?.sessionId).toBeTruthy();
        emittedEvents.length = 0;

        await client!.sessionUpdate({
            sessionId: "runtime-subagent-1",
            update: {
                content: [
                    {
                        newText: "child after\n",
                        oldText: "child before\n",
                        path: path.join(tempDir, "src/only-child.ts"),
                        type: "diff",
                    },
                ],
                kind: "edit",
                sessionUpdate: "tool_call_update",
                status: "completed",
                title: "Edit only child",
                toolCallId: "child-edit",
            },
        });

        await vi.waitFor(() => {
            expect(
                getLatestTrackedFiles(
                    emittedEvents,
                    childSnapshot!.sessionId,
                ),
            ).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        path: "src/only-child.ts",
                        sessionId: childSnapshot!.sessionId,
                    }),
                ]),
            );
        });
        expect(
            hasTrackedFileEvent(emittedEvents, "session-1", "src/only-child.ts"),
        ).toBe(false);

        emittedEvents.length = 0;
        const sharedDiffContent = [
            {
                newText: "shared parent after\n",
                oldText: "shared before\n",
                path: path.join(tempDir, "src/shared.ts"),
                type: "diff",
            },
        ];
        await client!.sessionUpdate({
            sessionId: "runtime-session-1",
            update: {
                content: sharedDiffContent,
                kind: "edit",
                sessionUpdate: "tool_call_update",
                status: "pending",
                title: "Edit shared parent",
                toolCallId: "shared-tool",
            },
        });
        await client!.sessionUpdate({
            sessionId: "runtime-subagent-1",
            update: {
                content: [
                    {
                        ...sharedDiffContent[0],
                        newText: "shared child after\n",
                    },
                ],
                kind: "edit",
                sessionUpdate: "tool_call_update",
                status: "pending",
                title: "Edit shared child",
                toolCallId: "shared-tool",
            },
        });

        await vi.waitFor(() => {
            expect(getLatestTrackedFiles(emittedEvents, "session-1")).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        path: "src/shared.ts",
                        sessionId: "session-1",
                    }),
                ]),
            );
            expect(
                getLatestTrackedFiles(
                    emittedEvents,
                    childSnapshot!.sessionId,
                ),
            ).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        path: "src/shared.ts",
                        sessionId: childSnapshot!.sessionId,
                    }),
                ]),
            );
        });
    });

    it("marks a subagent closed when the parent receives a close breadcrumb", async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        const emittedEvents: AiWorkerEventMessage[] = [];
        const runtime = new AiWorkerRuntime({
            emitEvent: (event) => {
                emittedEvents.push(event);
            },
        });
        const launch = createLaunch({
            cwd: tempDir,
            projectRoot: tempDir,
            title: "Subagent close parent",
        });

        await runtime.dispatchMethod("ai.prepareSession", {
            input: launch.input,
            launch,
        });
        emittedEvents.length = 0;

        const client = latestClientFactory?.();
        expect(client).toBeDefined();
        const subagentMeta = {
            codexAcpAgentNickname: "Galileo",
            codexAcpChildSessionId: "runtime-subagent-1",
            codexAcpCwd: tempDir,
            codexAcpEventType: "subagent_session_created",
            codexAcpParentSessionId: "runtime-session-1",
        };
        await client!.sessionUpdate({
            _meta: subagentMeta,
            sessionId: "runtime-subagent-1",
            update: {
                _meta: subagentMeta,
                sessionUpdate: "session_info_update",
                title: "Galileo",
            },
        });

        const childSnapshot = getLatestSnapshot(
            emittedEvents,
            (snapshot) => snapshot.parentSessionId === "session-1",
        );
        expect(childSnapshot?.sessionId).toBeTruthy();
        await markRuntimeSessionStreaming(
            client!,
            "runtime-subagent-1",
            "close-before-idle",
        );
        await vi.waitFor(() => {
            expect(
                hasPatchChangesMatching(
                    emittedEvents,
                    childSnapshot!.sessionId,
                    (changes) => changes.status === "streaming",
                ),
            ).toBe(true);
        });
        emittedEvents.length = 0;

        const closeBreadcrumbMeta = {
            codexAcpChildSessionId: "runtime-subagent-1",
            codexAcpEventType: "subagent_breadcrumb",
            codexAcpParentSessionId: "runtime-session-1",
            codexAcpSubagentEventType: "close_end",
        };
        await client!.sessionUpdate({
            _meta: closeBreadcrumbMeta,
            sessionId: "runtime-session-1",
            update: {
                _meta: closeBreadcrumbMeta,
                sessionUpdate: "tool_call_update",
                status: "completed",
                title: "Closed Galileo",
                toolCallId: "codex-acp:subagent:close-1",
            },
        });

        await vi.waitFor(() => {
            const changes = getLatestPatchChanges(
                emittedEvents,
                childSnapshot!.sessionId,
            );
            expect(typeof changes?.closedAt).toBe("string");
            expect(changes?.status).toBe("idle");
        });
    });

    it("marks a subagent idle when cancel is requested", async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        const emittedEvents: AiWorkerEventMessage[] = [];
        const runtime = new AiWorkerRuntime({
            emitEvent: (event) => {
                emittedEvents.push(event);
            },
        });
        const launch = createLaunch({
            cwd: tempDir,
            projectRoot: tempDir,
            title: "Subagent cancel parent",
        });

        await runtime.dispatchMethod("ai.prepareSession", {
            input: launch.input,
            launch,
        });
        emittedEvents.length = 0;

        const client = latestClientFactory?.();
        expect(client).toBeDefined();
        const subagentMeta = {
            codexAcpAgentNickname: "Galileo",
            codexAcpChildSessionId: "runtime-subagent-1",
            codexAcpCwd: tempDir,
            codexAcpEventType: "subagent_session_created",
            codexAcpParentSessionId: "runtime-session-1",
        };
        await client!.sessionUpdate({
            _meta: subagentMeta,
            sessionId: "runtime-subagent-1",
            update: {
                _meta: subagentMeta,
                sessionUpdate: "session_info_update",
                title: "Galileo",
            },
        });

        const childSnapshot = getLatestSnapshot(
            emittedEvents,
            (snapshot) => snapshot.parentSessionId === "session-1",
        );
        expect(childSnapshot?.sessionId).toBeTruthy();
        await markRuntimeSessionStreaming(
            client!,
            "runtime-subagent-1",
            "cancel-before-idle",
        );
        await vi.waitFor(() => {
            expect(
                hasPatchChangesMatching(
                    emittedEvents,
                    childSnapshot!.sessionId,
                    (changes) => changes.status === "streaming",
                ),
            ).toBe(true);
        });
        emittedEvents.length = 0;

        await runtime.dispatchMethod(
            "ai.cancelSession",
            childSnapshot!.sessionId,
        );

        expect(cancelRuntimeSessionMock).toHaveBeenLastCalledWith({
            sessionId: "runtime-subagent-1",
        });
        await vi.waitFor(() => {
            expect(
                getLatestPatchChanges(
                    emittedEvents,
                    childSnapshot!.sessionId,
                ),
            ).toMatchObject({
                status: "idle",
            });
        });
    });

    it("marks every session on a dead ACP connection as errored", async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        const emittedEvents: AiWorkerEventMessage[] = [];
        const runtime = new AiWorkerRuntime({
            emitEvent: (event) => {
                emittedEvents.push(event);
            },
        });
        const launch = createLaunch({
            cwd: tempDir,
            projectRoot: tempDir,
            title: "Dead connection parent",
        });

        await runtime.dispatchMethod("ai.prepareSession", {
            input: launch.input,
            launch,
        });
        const client = latestClientFactory?.();
        expect(client).toBeDefined();

        const subagentMeta = {
            codexAcpAgentNickname: "Galileo",
            codexAcpChildSessionId: "runtime-subagent-1",
            codexAcpCwd: tempDir,
            codexAcpEventType: "subagent_session_created",
            codexAcpParentSessionId: "runtime-session-1",
        };
        await client!.sessionUpdate({
            _meta: subagentMeta,
            sessionId: "runtime-subagent-1",
            update: {
                _meta: subagentMeta,
                sessionUpdate: "session_info_update",
                title: "Galileo",
            },
        });

        const childSnapshot = getLatestSnapshot(
            emittedEvents,
            (snapshot) => snapshot.parentSessionId === "session-1",
        );
        expect(childSnapshot?.sessionId).toBeTruthy();
        emittedEvents.length = 0;

        spawnedChildren[0]?.stderr.write("connection died\n");
        spawnedChildren[0]?.emit("exit", 1, null);

        await vi.waitFor(() => {
            const parentChanges = getLatestPatchChanges(
                emittedEvents,
                "session-1",
            );
            const childChanges = getLatestPatchChanges(
                emittedEvents,
                childSnapshot!.sessionId,
            );

            expect(parentChanges?.lastError).toEqual(
                expect.stringContaining("connection died"),
            );
            expect(parentChanges?.status).toBe("error");
            expect(childChanges?.lastError).toEqual(
                expect.stringContaining("connection died"),
            );
            expect(childChanges?.status).toBe("error");
        });

        const closedSessionIds = emittedEvents
            .filter((event) => event.event === "ai.session.closed")
            .map((event) => event.payload.sessionId);
        expect(closedSessionIds).toEqual(
            expect.arrayContaining(["session-1", childSnapshot!.sessionId]),
        );
    });

    it("rejects prompts that exceed the image attachment limit", async () => {
        const runtime = createRuntime();
        const launch = createLaunch({
            cwd: process.cwd(),
            projectRoot: process.cwd(),
            title: "Attachment limit test",
        });

        await runtime.dispatchMethod("ai.prepareSession", {
            input: launch.input,
            launch,
        });

        await expect(
            runtime.dispatchMethod("ai.sendPrompt", {
                input: {
                    attachments: Array.from(
                        { length: MAX_IMAGE_ATTACHMENTS + 1 },
                        (_, index) => ({
                            dataBase64: "ZmFrZQ==",
                            id: `attachment-${index}`,
                            mimeType: "image/png",
                            name: `attachment-${index}.png`,
                            sizeBytes: 4,
                        }),
                    ),
                    projectId: null,
                    prompt: "hello",
                    runtimeId: "codex",
                    sessionId: "session-1",
                    title: "Attachment limit test",
                    worktreeId: null,
                },
                launch,
            }),
        ).rejects.toThrow("You can attach up to 12 images per message.");
        expect(promptMock).not.toHaveBeenCalled();
    });

    it("does not duplicate direct user image attachments when ACP echoes prompt blocks", async () => {
        const { client, emittedEvents, launch, runtime } =
            await setupPreparedRuntimeWithClient("Prompt image echo");
        emittedEvents.length = 0;
        const attachment = {
            dataBase64: "ZmFrZQ==",
            id: "attachment-1",
            mimeType: "image/png",
            name: "attachment.png",
            sizeBytes: 4,
        };
        promptMock.mockImplementationOnce(
            async (...args: readonly unknown[]) => {
                const params = args[0] as { readonly messageId: string };
                await client.sessionUpdate({
                    sessionId: "runtime-session-1",
                    update: {
                        content: {
                            data: attachment.dataBase64,
                            mimeType: attachment.mimeType,
                            type: "image",
                        },
                        messageId: params.messageId,
                        sessionUpdate: "user_message_chunk",
                    },
                });
                return {
                    stopReason: "completed",
                };
            },
        );

        await runtime.dispatchMethod("ai.sendPrompt", {
            input: {
                attachments: [attachment],
                projectId: null,
                prompt: "hello",
                runtimeId: "codex",
                sessionId: "session-1",
                title: "Prompt image echo",
                worktreeId: null,
            },
            launch,
        });

        await vi.waitFor(() => {
            const userMessages =
                getLatestPatchMessages(emittedEvents, "session-1")?.filter(
                    (message) => message.kind === "user",
                ) ?? [];
            expect(userMessages).toEqual([
                expect.objectContaining({
                    attachments: [
                        expect.objectContaining({
                            dataBase64: attachment.dataBase64,
                            mimeType: attachment.mimeType,
                        }),
                    ],
                    content: "hello",
                }),
            ]);
        });
    });

    it("suppresses internal guided-input payload echoes while keeping the human summary", async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        const emittedEvents: AiWorkerEventMessage[] = [];
        const runtime = new AiWorkerRuntime({
            emitEvent: (event) => {
                emittedEvents.push(event);
            },
        });
        const baseLaunch = createLaunch({
            cwd: tempDir,
            projectRoot: tempDir,
            title: "Guided input echo",
        });
        const launch: AiWorkerSessionLaunchInput = {
            ...baseLaunch,
            persistedSnapshot: {
                ...baseLaunch.persistedSnapshot,
                pendingUserInput: {
                    questions: [
                        {
                            header: "Choice",
                            id: "choice",
                            isOther: false,
                            isSecret: false,
                            options: [],
                            question: "Pick one",
                        },
                    ],
                    requestId: "guided-input-1",
                    sessionId: "session-1",
                    title: "Guided input",
                    toolCallId: "guided-tool-1",
                    turnId: "turn-1",
                    updatedAt: "2026-04-15T22:23:13.719838Z",
                },
                status: "waiting_user_input",
            },
        };

        await runtime.dispatchMethod("ai.prepareSession", {
            input: launch.input,
            launch,
        });
        emittedEvents.length = 0;

        const client = latestClientFactory?.();
        expect(client).toBeDefined();
        promptMock.mockImplementationOnce(async (...args: readonly unknown[]) => {
            const params = args[0] as {
                readonly messageId: string;
                readonly prompt: readonly { readonly text: string; readonly type: string }[];
            };
            await client!.sessionUpdate({
                sessionId: "runtime-session-1",
                update: {
                    content: {
                        text: params.prompt[0]?.text ?? "",
                        type: "text",
                    },
                    messageId: params.messageId,
                    sessionUpdate: "user_message_chunk",
                },
            });
            return {
                stopReason: "completed",
            };
        });

        await runtime.dispatchMethod("ai.respondUserInput", {
            input: {
                answers: [
                    {
                        answers: ["yes"],
                        questionId: "choice",
                    },
                ],
                requestId: "guided-input-1",
                sessionId: "session-1",
            },
        });

        await vi.waitFor(() => {
            const userMessages =
                getLatestPatchMessages(emittedEvents, "session-1")?.filter(
                    (message) => message.kind === "user",
                ) ?? [];
            expect(userMessages.map((message) => message.content)).toEqual([
                "Choice: yes",
            ]);
            expect(
                userMessages.some((message) =>
                    message.content.includes(CODEX_ACP_USER_INPUT_RESPONSE_PREFIX),
                ),
            ).toBe(false);
        });
    });

    it("suppresses late chunked internal guided-input payload echoes", async () => {
        const { client, emittedEvents } =
            await setupPreparedRuntimeWithClient("Late chunked guided input echo");
        emittedEvents.length = 0;

        await client.sessionUpdate({
            sessionId: "runtime-session-1",
            update: {
                content: {
                    text: `${CODEX_ACP_USER_INPUT_RESPONSE_PREFIX}{"response":`,
                    type: "text",
                },
                messageId: "late-guided-echo",
                sessionUpdate: "user_message_chunk",
            },
        });
        await client.sessionUpdate({
            sessionId: "runtime-session-1",
            update: {
                content: {
                    text: '{"answers":{"choice":{"answers":["yes"]}}},"turn_id":"turn-1"}',
                    type: "text",
                },
                messageId: "late-guided-echo",
                sessionUpdate: "user_message_chunk",
            },
        });
        await client.sessionUpdate({
            sessionId: "runtime-session-1",
            update: {
                content: {
                    text: "visible answer",
                    type: "text",
                },
                messageId: "assistant-after-guided-echo",
                sessionUpdate: "agent_message_chunk",
            },
        });

        await vi.waitFor(() => {
            const messages = getLatestPatchMessages(emittedEvents, "session-1");
            expect(messages).toEqual([
                expect.objectContaining({
                    content: "visible answer",
                    kind: "assistant",
                }),
            ]);
        });
    });

    it("does not suppress unexpected text that reuses the prompt message id", async () => {
        const { client, emittedEvents, launch, runtime } =
            await setupPreparedRuntimeWithClient("Prompt text same id");
        emittedEvents.length = 0;
        promptMock.mockImplementationOnce(async (...args: readonly unknown[]) => {
            const params = args[0] as { readonly messageId: string };
            await client.sessionUpdate({
                sessionId: "runtime-session-1",
                update: {
                    content: {
                        text: "unexpected user echo",
                        type: "text",
                    },
                    messageId: params.messageId,
                    sessionUpdate: "user_message_chunk",
                },
            });
            return {
                stopReason: "completed",
            };
        });

        await runtime.dispatchMethod("ai.sendPrompt", {
            input: {
                attachments: [],
                projectId: null,
                prompt: "hello",
                runtimeId: "codex",
                sessionId: "session-1",
                title: "Prompt text same id",
                worktreeId: null,
            },
            launch,
        });

        await vi.waitFor(() => {
            const userMessages =
                getLatestPatchMessages(emittedEvents, "session-1")?.filter(
                    (message) => message.kind === "user",
                ) ?? [];
            expect(userMessages.map((message) => message.content)).toEqual([
                "hello",
                "unexpected user echo",
            ]);
        });
    });

    it("does not suppress non-echo user content that reuses the prompt message id", async () => {
        const { client, emittedEvents, launch, runtime } =
            await setupPreparedRuntimeWithClient("Prompt resource same id");
        emittedEvents.length = 0;
        promptMock.mockImplementationOnce(async (...args: readonly unknown[]) => {
            const params = args[0] as { readonly messageId: string };
            await client.sessionUpdate({
                sessionId: "runtime-session-1",
                update: {
                    content: {
                        name: "legit-context",
                        type: "resource_link",
                        uri: "file:///tmp/legit-context.md",
                    },
                    messageId: params.messageId,
                    sessionUpdate: "user_message_chunk",
                },
            });
            return {
                stopReason: "completed",
            };
        });

        await runtime.dispatchMethod("ai.sendPrompt", {
            input: {
                attachments: [],
                projectId: null,
                prompt: "hello",
                runtimeId: "codex",
                sessionId: "session-1",
                title: "Prompt resource same id",
                worktreeId: null,
            },
            launch,
        });

        await vi.waitFor(() => {
            const userMessages =
                getLatestPatchMessages(emittedEvents, "session-1")?.filter(
                    (message) => message.kind === "user",
                ) ?? [];
            expect(userMessages.map((message) => message.content)).toEqual([
                "hello",
                "file:///tmp/legit-context.md",
            ]);
        });
    });

    it("reads unsaved buffer content before hitting disk", async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        const filePath = path.join(tempDir, "draft.txt");
        await fs.writeFile(filePath, "on-disk", "utf8");
        const runtime = createRuntime();
        const launch = createLaunch({
            cwd: tempDir,
            projectRoot: tempDir,
            title: "Buffer test",
        });

        await runtime.dispatchMethod("ai.prepareSession", {
            input: launch.input,
            launch,
        });
        await runtime.dispatchMethod("ai.notifyFileBuffer", {
            absolutePath: filePath,
            content: "unsaved-buffer",
        });

        const client = latestClientFactory?.();
        expect(client).toBeDefined();
        await expect(
            client!.readTextFile({
                path: "draft.txt",
            }),
        ).resolves.toEqual({
            content: "unsaved-buffer",
        });
    });

    it("writes directly to disk inside the allowed scope", async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        const runtime = createRuntime();
        const launch = createLaunch({
            cwd: tempDir,
            projectRoot: tempDir,
            title: "Write test",
        });

        await runtime.dispatchMethod("ai.prepareSession", {
            input: launch.input,
            launch,
        });

        const client = latestClientFactory?.();
        expect(client).toBeDefined();
        await expect(
            client!.writeTextFile({
                content: "worker-write",
                path: "nested/output.txt",
            }),
        ).resolves.toEqual({});
        await expect(
            fs.readFile(path.join(tempDir, "nested/output.txt"), "utf8"),
        ).resolves.toBe("worker-write");
    });

    it("keeps full-file review state when a runtime re-emits an already-applied snippet diff", async () => {
        const { client, emittedEvents, tempDir } =
            await setupPreparedRuntimeWithClient("OpenCode snippet replay");
        const targetPath = path.join(tempDir, "notes.md");
        const originalContent = [
            "alpha",
            "**ALIANZA: PROVISORIA**",
            "**INTERFAZ: MANIFIESTA DEUDA**",
            "omega",
        ].join("\n");
        const nextContent = ["alpha", "omega"].join("\n");
        const removedSnippet = [
            "**ALIANZA: PROVISORIA**",
            "**INTERFAZ: MANIFIESTA DEUDA**",
        ].join("\n");

        await fs.writeFile(targetPath, originalContent, "utf8");
        await client.writeTextFile({
            content: nextContent,
            path: targetPath,
        });
        emittedEvents.length = 0;

        await client.sessionUpdate({
            sessionId: "runtime-session-1",
            update: {
                content: [
                    {
                        newText: "",
                        oldText: removedSnippet,
                        path: targetPath,
                        type: "diff",
                    },
                ],
                kind: "edit",
                sessionUpdate: "tool_call_update",
                status: "completed",
                title: "Edited notes.md",
                toolCallId: "opencode-edit",
            },
        });

        await vi.waitFor(() => {
            const trackedFile = getLatestTrackedFiles(
                emittedEvents,
                "session-1",
            )?.find((candidate) => candidate.path === "notes.md");
            expect(trackedFile).toEqual(
                expect.objectContaining({
                    currentText: nextContent,
                    diffBase: originalContent,
                    newText: nextContent,
                    oldText: originalContent,
                    toolCallId: "opencode-edit",
                }),
            );
        });
        await expect(fs.readFile(targetPath, "utf8")).resolves.toBe(
            nextContent,
        );
    });

    it("uses a pre-edit read snapshot for snippet-only external edits", async () => {
        const { client, emittedEvents, tempDir } =
            await setupPreparedRuntimeWithClient("OpenCode external snippet");
        const targetPath = path.join(tempDir, "notes.md");
        const originalContent = ["alpha", "remove me", "omega"].join("\n");
        const nextContent = ["alpha", "omega"].join("\n");

        await fs.writeFile(targetPath, originalContent, "utf8");
        await expect(
            client.readTextFile({
                line: 2,
                limit: 1,
                path: "notes.md",
            }),
        ).resolves.toEqual({
            content: "remove me",
        });
        await fs.writeFile(targetPath, nextContent, "utf8");

        await client.sessionUpdate({
            sessionId: "runtime-session-1",
            update: {
                content: [
                    {
                        newText: "",
                        oldText: "remove me\n",
                        path: "notes.md",
                        type: "diff",
                    },
                ],
                kind: "edit",
                sessionUpdate: "tool_call_update",
                status: "completed",
                title: "Edited notes.md",
                toolCallId: "opencode-external-edit",
            },
        });

        await vi.waitFor(() => {
            const trackedFile = getLatestTrackedFiles(
                emittedEvents,
                "session-1",
            )?.find((candidate) => candidate.path === "notes.md");
            expect(trackedFile).toEqual(
                expect.objectContaining({
                    currentText: nextContent,
                    diffBase: originalContent,
                    newText: nextContent,
                    oldText: originalContent,
                    toolCallId: "opencode-external-edit",
                }),
            );
        });
    });

    it("writes directly to additional roots inside the allowed scope", async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        const additionalRoot = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-extra-"),
        );
        const targetPath = path.join(additionalRoot, "nested/output.txt");
        const runtime = createRuntime();
        const launch = createLaunch({
            additionalRoots: [additionalRoot],
            cwd: tempDir,
            projectRoot: tempDir,
            title: "Additional root write test",
        });

        await runtime.dispatchMethod("ai.prepareSession", {
            input: launch.input,
            launch,
        });

        const client = latestClientFactory?.();
        expect(client).toBeDefined();
        await expect(
            client!.writeTextFile({
                content: "worker-extra-write",
                path: targetPath,
            }),
        ).resolves.toEqual({});
        await expect(fs.readFile(targetPath, "utf8")).resolves.toBe(
            "worker-extra-write",
        );
    });

    it("does not close the runtime session when relaunching with changed additional roots", async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        const additionalRoot = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-extra-"),
        );
        const runtime = createRuntime();
        const launch = createLaunch({
            cwd: tempDir,
            projectRoot: tempDir,
            title: "Relaunch root test",
        });

        await runtime.dispatchMethod("ai.prepareSession", {
            input: launch.input,
            launch,
        });

        const relaunch = {
            ...launch,
            additionalRoots: [additionalRoot],
            input: {
                ...launch.input,
                additionalRoots: [additionalRoot],
            },
        };
        await runtime.dispatchMethod("ai.prepareSession", {
            input: relaunch.input,
            launch: relaunch,
        });

        expect(spawnMock).toHaveBeenCalledTimes(2);
        expect(spawnedChildren[0]?.kill).toHaveBeenCalled();
        expect(closeRuntimeSessionMock).not.toHaveBeenCalled();
    });

    it("ignores exit events from a disposed wrapper after relaunching the session", async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        const additionalRoot = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-extra-"),
        );
        const runtime = createRuntime();
        const launch = createLaunch({
            cwd: tempDir,
            projectRoot: tempDir,
            title: "Stale exit test",
        });

        await runtime.dispatchMethod("ai.prepareSession", {
            input: launch.input,
            launch,
        });
        const oldChild = spawnedChildren[0];
        const relaunch = {
            ...launch,
            additionalRoots: [additionalRoot],
            input: {
                ...launch.input,
                additionalRoots: [additionalRoot],
            },
        };
        await runtime.dispatchMethod("ai.prepareSession", {
            input: relaunch.input,
            launch: relaunch,
        });

        oldChild?.emit("exit", 0, null);

        await expect(
            runtime.dispatchMethod("ai.sendPrompt", {
                input: {
                    attachments: [],
                    projectId: null,
                    prompt: "hello after relaunch",
                    runtimeId: "codex",
                    sessionId: "session-1",
                    title: "Stale exit test",
                    worktreeId: null,
                },
                launch: relaunch,
            }),
        ).resolves.toEqual({
            sessionId: "session-1",
            stopReason: "completed",
        });
    });

    it("closes the runtime session for explicit session closes", async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        const runtime = createRuntime();
        const launch = createLaunch({
            cwd: tempDir,
            projectRoot: tempDir,
            title: "Explicit close test",
        });

        await runtime.dispatchMethod("ai.prepareSession", {
            input: launch.input,
            launch,
        });
        await runtime.dispatchMethod("ai.closeSession", "session-1");

        expect(closeRuntimeSessionMock).toHaveBeenCalledWith({
            sessionId: "runtime-session-1",
        });
    });

    it("advertises and handles ACP terminals through the existing permission flow", async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        const emittedEvents: AiWorkerEventMessage[] = [];
        const runtime = new AiWorkerRuntime({
            emitEvent: (event) => {
                emittedEvents.push(event);
            },
        });
        const launch = createLaunch({
            cwd: tempDir,
            projectRoot: tempDir,
            title: "Terminal test",
        });

        await runtime.dispatchMethod("ai.prepareSession", {
            input: launch.input,
            launch,
        });

        expect(initializeMock).toHaveBeenCalledWith(
            expect.objectContaining({
                clientCapabilities: {
                    fs: {
                        readTextFile: true,
                        writeTextFile: true,
                    },
                    terminal: true,
                },
            }),
        );

        const client = latestClientFactory?.();
        expect(client).toBeDefined();
        const createPromise = client!.createTerminal({
            args: ["-v"],
            command: "node",
            cwd: tempDir,
            env: [],
            outputByteLimit: 1024,
            sessionId: "runtime-session-1",
        });

        await Promise.resolve();
        const pendingPermission = getLatestPendingPermission(emittedEvents);
        expect(pendingPermission).not.toBeNull();
        expect(pendingPermission!.description).toContain("Command: node -v");
        expect(pendingPermission!.title).toBe("Run terminal command");

        const allowOption = pendingPermission!.options.find(
            (option) => option.kind === "allow_once",
        );
        expect(allowOption).toBeDefined();
        await runtime.dispatchMethod("ai.respondPermission", {
            input: {
                optionId: allowOption!.optionId,
                requestId: pendingPermission!.requestId,
                sessionId: "session-1",
            },
        });

        const { terminalId } = await createPromise;
        expect(spawnMock).toHaveBeenLastCalledWith(
            "node",
            ["-v"],
            expect.objectContaining({
                cwd: tempDir,
                stdio: ["ignore", "pipe", "pipe"],
            }),
        );

        const terminalChild = spawnedChildren.at(-1);
        expect(terminalChild).toBeDefined();
        terminalChild!.stdout.write("v25.0.0\n");
        await expect(
            client!.terminalOutput({
                sessionId: "runtime-session-1",
                terminalId,
            }),
        ).resolves.toEqual({
            _meta: null,
            exitStatus: null,
            output: "v25.0.0\n",
            truncated: false,
        });

        terminalChild!.emit("close", 0, null);
        await expect(
            client!.waitForTerminalExit({
                sessionId: "runtime-session-1",
                terminalId,
            }),
        ).resolves.toEqual({
            _meta: null,
            exitCode: 0,
            signal: null,
        });

        await vi.waitFor(() => {
            const toolActivity = getLatestToolActivity(emittedEvents);
            expect(toolActivity).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        exitCode: 0,
                        kind: "execute",
                        rawInputJson: JSON.stringify({
                            command: "node -v",
                            cwd: tempDir,
                        }),
                        status: "completed",
                        terminalOutput: "v25.0.0\n",
                    }),
                ]),
            );
        });
    });

    it("launches approved ACP terminal commands resolved by Windows PATHEXT", async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        const binDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-bin-"),
        );
        const executablePath = path.join(binDir, "pnpm.CMD");
        const originalPlatform = process.platform;
        const emittedEvents: AiWorkerEventMessage[] = [];

        try {
            Object.defineProperty(process, "platform", {
                configurable: true,
                value: "win32",
            });
            await fs.writeFile(executablePath, "", "utf8");
            const runtime = new AiWorkerRuntime({
                emitEvent: (event) => {
                    emittedEvents.push(event);
                },
            });
            const launch = createLaunch({
                cwd: tempDir,
                projectRoot: tempDir,
                title: "Terminal Windows PATHEXT test",
            });

            await runtime.dispatchMethod("ai.prepareSession", {
                input: launch.input,
                launch,
            });

            const client = latestClientFactory?.();
            expect(client).toBeDefined();
            const createPromise = client!.createTerminal({
                args: ["test"],
                command: "pnpm",
                cwd: tempDir,
                env: [
                    {
                        name: "PATH",
                        value: binDir,
                    },
                    {
                        name: "PATHEXT",
                        value: ".CMD;.EXE",
                    },
                ],
                outputByteLimit: 1024,
                sessionId: "runtime-session-1",
            });

            await Promise.resolve();
            const pendingPermission = getLatestPendingPermission(emittedEvents);
            expect(pendingPermission).not.toBeNull();
            expect(pendingPermission!.description).toContain(
                "Command: pnpm test",
            );
            const allowOption = pendingPermission!.options.find(
                (option) => option.kind === "allow_once",
            );
            expect(allowOption).toBeDefined();
            await runtime.dispatchMethod("ai.respondPermission", {
                input: {
                    optionId: allowOption!.optionId,
                    requestId: pendingPermission!.requestId,
                    sessionId: "session-1",
                },
            });

            await createPromise;

            expect(spawnMock).toHaveBeenLastCalledWith(
                "cmd.exe",
                [
                    "/d",
                    "/s",
                    "/v:off",
                    "/c",
                    `""${executablePath}" "test""`,
                ],
                expect.objectContaining({
                    cwd: tempDir,
                    stdio: ["ignore", "pipe", "pipe"],
                }),
            );
        } finally {
            Object.defineProperty(process, "platform", {
                configurable: true,
                value: originalPlatform,
            });
            await fs.rm(tempDir, { force: true, recursive: true });
            await fs.rm(binDir, { force: true, recursive: true });
        }
    });

    it("normalizes negative ACP terminal exit codes to null", async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        const emittedEvents: AiWorkerEventMessage[] = [];
        const runtime = new AiWorkerRuntime({
            emitEvent: (event) => {
                emittedEvents.push(event);
            },
        });
        const launch = createLaunch({
            cwd: tempDir,
            projectRoot: tempDir,
            title: "Terminal failure test",
        });

        await runtime.dispatchMethod("ai.prepareSession", {
            input: launch.input,
            launch,
        });

        const client = latestClientFactory?.();
        expect(client).toBeDefined();
        const createPromise = client!.createTerminal({
            args: [],
            command: "missing-command",
            cwd: tempDir,
            env: [],
            outputByteLimit: 1024,
            sessionId: "runtime-session-1",
        });

        await Promise.resolve();
        const pendingPermission = getLatestPendingPermission(emittedEvents);
        expect(pendingPermission).not.toBeNull();
        const allowOption = pendingPermission!.options.find(
            (option) => option.kind === "allow_once",
        );
        expect(allowOption).toBeDefined();
        await runtime.dispatchMethod("ai.respondPermission", {
            input: {
                optionId: allowOption!.optionId,
                requestId: pendingPermission!.requestId,
                sessionId: "session-1",
            },
        });

        const { terminalId } = await createPromise;
        const terminalChild = spawnedChildren.at(-1);
        expect(terminalChild).toBeDefined();
        terminalChild!.emit("error", new Error("spawn ENOENT"));
        terminalChild!.emit("close", -2, null);

        await expect(
            client!.terminalOutput({
                sessionId: "runtime-session-1",
                terminalId,
            }),
        ).resolves.toEqual({
            _meta: null,
            exitStatus: {
                _meta: null,
                exitCode: null,
                signal: null,
            },
            output: "spawn ENOENT\n",
            truncated: false,
        });
        await expect(
            client!.waitForTerminalExit({
                sessionId: "runtime-session-1",
                terminalId,
            }),
        ).resolves.toEqual({
            _meta: null,
            exitCode: null,
            signal: null,
        });

        await vi.waitFor(() => {
            const toolActivity = getLatestToolActivity(emittedEvents);
            expect(toolActivity).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        exitCode: null,
                        kind: "execute",
                        status: "failed",
                        terminalOutput: "spawn ENOENT\n",
                    }),
                ]),
            );
        });
    });

    it("keeps the out-of-project path error semantics", async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        const runtime = createRuntime();
        const launch = createLaunch({
            cwd: tempDir,
            projectRoot: tempDir,
            title: "Scope test",
        });

        await runtime.dispatchMethod("ai.prepareSession", {
            input: launch.input,
            launch,
        });

        const client = latestClientFactory?.();
        expect(client).toBeDefined();
        await expect(
            client!.readTextFile({
                path: "../outside.txt",
            }),
        ).rejects.toThrowError(
            "Codex attempted to access a path outside the project.",
        );
    });

    it("drops net-clean tracked files when preparing a persisted session", async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        try {
            const filePath = path.join(tempDir, "notes.md");
            await fs.writeFile(filePath, "before\n", "utf8");
            const runtime = createRuntime();
            const trackedFile: AiTrackedFile = {
                hunks: computeDiffHunks("before\n", "after\n", "notes.md"),
                identityKey: "notes.md",
                isText: true,
                kind: "update",
                newText: "after\n",
                oldText: "before\n",
                path: "notes.md",
                previousPath: null,
                reviewState: "pending",
                reversible: true,
                sessionId: "session-1",
                toolCallId: "tool-1",
                updatedAt: "2026-04-15T22:23:13.719838Z",
                version: 1,
            };
            const launch = createLaunch({
                cwd: tempDir,
                persistedSnapshot: {
                    ...createLaunch({
                        cwd: tempDir,
                        projectRoot: tempDir,
                        title: "Tracked file reconciliation baseline",
                    }).persistedSnapshot,
                    trackedFiles: [trackedFile],
                },
                projectRoot: tempDir,
                title: "Tracked file reconciliation",
            });

            const snapshot = (await runtime.dispatchMethod("ai.prepareSession", {
                input: launch.input,
                launch,
            })) as AiSessionSnapshot;

            expect(snapshot.trackedFiles).toEqual([]);
        } finally {
            await fs.rm(tempDir, { force: true, recursive: true });
        }
    });

    it("rejects a tracked file for a non-live session and reverts it on disk", async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        const filePath = path.join(tempDir, "notes.md");
        await fs.writeFile(filePath, "after\n", "utf8");
        const runtime = createRuntime();
        const trackedFile: AiTrackedFile = {
            hunks: [],
            identityKey: "notes.md",
            isText: true,
            kind: "update",
            newText: "after\n",
            oldText: "before\n",
            path: "notes.md",
            previousPath: null,
            reviewState: "pending",
            reversible: true,
            sessionId: "session-1",
            toolCallId: "tool-1",
            updatedAt: "2026-04-15T22:23:13.719838Z",
            version: 1,
        };
        const snapshot = createLaunch({
            cwd: tempDir,
            projectRoot: tempDir,
            title: "Review test",
        }).persistedSnapshot;
        const result = await runtime.dispatchMethod("ai.rejectTrackedFile", {
            context: {
                additionalRoots: [],
                cwd: tempDir,
                ownerWindowId: "",
                projectRoot: tempDir,
                snapshot: {
                    ...snapshot,
                    trackedFiles: [trackedFile],
                },
            },
            input: {
                path: "notes.md",
                sessionId: "session-1",
            },
        });

        await expect(fs.readFile(filePath, "utf8")).resolves.toBe("before\n");
        expect(result).toMatchObject({
            ownerWindowId: "",
            snapshot: {
                trackedFiles: [],
            },
        });
    });

    it("keeps tracked files through relative Windows casing aliases", async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        const originalPlatform = process.platform;
        try {
            Object.defineProperty(process, "platform", {
                configurable: true,
                value: "win32",
            });
            const runtime = createRuntime();
            const trackedFile: AiTrackedFile = {
                hunks: [],
                identityKey: "src/App.ts",
                isText: true,
                kind: "update",
                newText: "after\n",
                oldText: "before\n",
                path: "src/App.ts",
                previousPath: null,
                reviewState: "pending",
                reversible: true,
                sessionId: "session-1",
                toolCallId: "tool-1",
                updatedAt: "2026-04-15T22:23:13.719838Z",
                version: 1,
            };
            const snapshot = createLaunch({
                cwd: tempDir,
                projectRoot: tempDir,
                title: "Review casing test",
            }).persistedSnapshot;

            const result = await runtime.dispatchMethod("ai.keepTrackedFile", {
                context: {
                    additionalRoots: [],
                    cwd: tempDir,
                    ownerWindowId: "",
                    projectRoot: tempDir,
                    snapshot: {
                        ...snapshot,
                        trackedFiles: [trackedFile],
                    },
                },
                input: {
                    path: "src/app.ts",
                    sessionId: "session-1",
                },
            });

            expect(result).toMatchObject({
                ownerWindowId: "",
                snapshot: {
                    trackedFiles: [],
                },
            });
        } finally {
            Object.defineProperty(process, "platform", {
                configurable: true,
                value: originalPlatform,
            });
            await fs.rm(tempDir, { force: true, recursive: true });
        }
    });

    it("keeps tracked files through backslash aliases on non-Windows hosts", async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        const originalPlatform = process.platform;
        try {
            Object.defineProperty(process, "platform", {
                configurable: true,
                value: "linux",
            });
            const runtime = createRuntime();
            const trackedFile: AiTrackedFile = {
                hunks: [],
                identityKey: "src/App.ts",
                isText: true,
                kind: "update",
                newText: "after\n",
                oldText: "before\n",
                path: "src\\App.ts",
                previousPath: null,
                reviewState: "pending",
                reversible: true,
                sessionId: "session-1",
                toolCallId: "tool-1",
                updatedAt: "2026-04-15T22:23:13.719838Z",
                version: 1,
            };
            const snapshot = createLaunch({
                cwd: tempDir,
                projectRoot: tempDir,
                title: "Review separator alias test",
            }).persistedSnapshot;

            const result = await runtime.dispatchMethod("ai.keepTrackedFile", {
                context: {
                    additionalRoots: [],
                    cwd: tempDir,
                    ownerWindowId: "",
                    projectRoot: tempDir,
                    snapshot: {
                        ...snapshot,
                        trackedFiles: [trackedFile],
                    },
                },
                input: {
                    path: "src/App.ts",
                    sessionId: "session-1",
                },
            });

            expect(result).toMatchObject({
                ownerWindowId: "",
                snapshot: {
                    trackedFiles: [],
                },
            });
        } finally {
            Object.defineProperty(process, "platform", {
                configurable: true,
                value: originalPlatform,
            });
            await fs.rm(tempDir, { force: true, recursive: true });
        }
    });

    it("rejects tracked files inside additional roots", async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        const additionalRoot = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-extra-"),
        );
        const filePath = path.join(additionalRoot, "notes.md");
        await fs.writeFile(filePath, "after\n", "utf8");
        const runtime = createRuntime();
        const trackedFile: AiTrackedFile = {
            hunks: [],
            identityKey: filePath,
            isText: true,
            kind: "update",
            newText: "after\n",
            oldText: "before\n",
            path: filePath,
            previousPath: null,
            reviewState: "pending",
            reversible: true,
            sessionId: "session-1",
            toolCallId: "tool-1",
            updatedAt: "2026-04-15T22:23:13.719838Z",
            version: 1,
        };
        const snapshot = createLaunch({
            additionalRoots: [additionalRoot],
            cwd: tempDir,
            projectRoot: tempDir,
            title: "Additional root review test",
        }).persistedSnapshot;

        const result = await runtime.dispatchMethod("ai.rejectTrackedFile", {
            context: {
                additionalRoots: [additionalRoot],
                cwd: tempDir,
                ownerWindowId: "",
                projectRoot: tempDir,
                snapshot: {
                    ...snapshot,
                    trackedFiles: [trackedFile],
                },
            },
            input: {
                path: filePath,
                sessionId: "session-1",
            },
        });

        await expect(fs.readFile(filePath, "utf8")).resolves.toBe("before\n");
        expect(result).toMatchObject({
            ownerWindowId: "",
            snapshot: {
                trackedFiles: [],
            },
        });
    });

    it("refuses to reject a moved tracked file when the original path already exists", async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        const previousPath = path.join(tempDir, "before.md");
        const movedPath = path.join(tempDir, "after.md");
        const originalText = "before move\n";
        const currentText = "after move\n";
        const recreatedText = "user recreated path\n";
        await fs.writeFile(previousPath, recreatedText, "utf8");
        await fs.writeFile(movedPath, currentText, "utf8");
        const runtime = createRuntime();
        const trackedFile: AiTrackedFile = {
            hunks: computeDiffHunks(originalText, currentText, "after.md"),
            identityKey: "after.md",
            isText: true,
            kind: "move",
            newText: currentText,
            oldText: originalText,
            path: "after.md",
            previousPath: "before.md",
            reviewState: "pending",
            reversible: true,
            sessionId: "session-1",
            toolCallId: "tool-move",
            updatedAt: "2026-04-15T22:23:13.719838Z",
            version: 1,
        };
        const snapshot = createLaunch({
            cwd: tempDir,
            projectRoot: tempDir,
            title: "Move reject safety test",
        }).persistedSnapshot;

        await expect(
            runtime.dispatchMethod("ai.rejectTrackedFile", {
                context: {
                    additionalRoots: [],
                    cwd: tempDir,
                    ownerWindowId: "",
                    projectRoot: tempDir,
                    snapshot: {
                        ...snapshot,
                        trackedFiles: [trackedFile],
                    },
                },
                input: {
                    path: "after.md",
                    sessionId: "session-1",
                },
            }),
        ).rejects.toThrow("original path for a moved file already exists");

        await expect(fs.readFile(previousPath, "utf8")).resolves.toBe(
            recreatedText,
        );
        await expect(fs.readFile(movedPath, "utf8")).resolves.toBe(currentText);
    });

    it("does not partially reject-all when a moved file's original path already exists", async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        const safePath = path.join(tempDir, "safe.md");
        const previousPath = path.join(tempDir, "before.md");
        const movedPath = path.join(tempDir, "after.md");
        const safeOriginalText = "safe before\n";
        const safeCurrentText = "safe after\n";
        const moveOriginalText = "before move\n";
        const moveCurrentText = "after move\n";
        const recreatedText = "user recreated path\n";
        await fs.writeFile(safePath, safeCurrentText, "utf8");
        await fs.writeFile(previousPath, recreatedText, "utf8");
        await fs.writeFile(movedPath, moveCurrentText, "utf8");
        const runtime = createRuntime();
        const safeTrackedFile: AiTrackedFile = {
            hunks: computeDiffHunks(
                safeOriginalText,
                safeCurrentText,
                "safe.md",
            ),
            identityKey: "safe.md",
            isText: true,
            kind: "update",
            newText: safeCurrentText,
            oldText: safeOriginalText,
            path: "safe.md",
            previousPath: null,
            reviewState: "pending",
            reversible: true,
            sessionId: "session-1",
            toolCallId: "tool-safe",
            updatedAt: "2026-04-15T22:23:13.719838Z",
            version: 1,
        };
        const moveTrackedFile: AiTrackedFile = {
            hunks: computeDiffHunks(
                moveOriginalText,
                moveCurrentText,
                "after.md",
            ),
            identityKey: "after.md",
            isText: true,
            kind: "move",
            newText: moveCurrentText,
            oldText: moveOriginalText,
            path: "after.md",
            previousPath: "before.md",
            reviewState: "pending",
            reversible: true,
            sessionId: "session-1",
            toolCallId: "tool-move",
            updatedAt: "2026-04-15T22:23:13.719838Z",
            version: 1,
        };
        const snapshot = createLaunch({
            cwd: tempDir,
            projectRoot: tempDir,
            title: "Move reject-all safety test",
        }).persistedSnapshot;

        await expect(
            runtime.dispatchMethod("ai.rejectAllTrackedFiles", {
                context: {
                    additionalRoots: [],
                    cwd: tempDir,
                    ownerWindowId: "",
                    projectRoot: tempDir,
                    snapshot: {
                        ...snapshot,
                        trackedFiles: [safeTrackedFile, moveTrackedFile],
                    },
                },
                input: "session-1",
            }),
        ).rejects.toThrow("original path for a moved file already exists");

        await expect(fs.readFile(safePath, "utf8")).resolves.toBe(
            safeCurrentText,
        );
        await expect(fs.readFile(previousPath, "utf8")).resolves.toBe(
            recreatedText,
        );
        await expect(fs.readFile(movedPath, "utf8")).resolves.toBe(
            moveCurrentText,
        );
    });

    it("refuses to reject a snippet-only tracked file over a larger disk file", async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        const filePath = path.join(tempDir, "notes.md");
        const diskText = "alpha\nremove me\nomega\n";
        await fs.writeFile(filePath, diskText, "utf8");
        const runtime = createRuntime();
        const trackedFile: AiTrackedFile = {
            hunks: computeDiffHunks("remove me\n", "", "notes.md"),
            identityKey: "notes.md",
            isText: true,
            kind: "update",
            newText: "",
            oldText: "remove me\n",
            path: "notes.md",
            previousPath: null,
            reviewState: "pending",
            reversible: true,
            sessionId: "session-1",
            toolCallId: "tool-1",
            updatedAt: "2026-04-15T22:23:13.719838Z",
            version: 1,
        };
        const snapshot = createLaunch({
            cwd: tempDir,
            projectRoot: tempDir,
            title: "Snippet review safety test",
        }).persistedSnapshot;

        await expect(
            runtime.dispatchMethod("ai.rejectTrackedFile", {
                context: {
                    additionalRoots: [],
                    cwd: tempDir,
                    ownerWindowId: "",
                    projectRoot: tempDir,
                    snapshot: {
                        ...snapshot,
                        trackedFiles: [trackedFile],
                    },
                },
                input: {
                    path: "notes.md",
                    sessionId: "session-1",
                },
            }),
        ).rejects.toThrow("Cannot safely apply this review change");

        await expect(fs.readFile(filePath, "utf8")).resolves.toBe(diskText);
    });

    it("refuses reject-all when a tracked file is snippet-only", async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        const filePath = path.join(tempDir, "notes.md");
        const diskText = "alpha\nremove me\nomega\n";
        await fs.writeFile(filePath, diskText, "utf8");
        const runtime = createRuntime();
        const trackedFile: AiTrackedFile = {
            hunks: computeDiffHunks("remove me\n", "", "notes.md"),
            identityKey: "notes.md",
            isText: true,
            kind: "update",
            newText: "",
            oldText: "remove me\n",
            path: "notes.md",
            previousPath: null,
            reviewState: "pending",
            reversible: true,
            sessionId: "session-1",
            toolCallId: "tool-1",
            updatedAt: "2026-04-15T22:23:13.719838Z",
            version: 1,
        };
        const snapshot = createLaunch({
            cwd: tempDir,
            projectRoot: tempDir,
            title: "Snippet reject-all safety test",
        }).persistedSnapshot;

        await expect(
            runtime.dispatchMethod("ai.rejectAllTrackedFiles", {
                context: {
                    additionalRoots: [],
                    cwd: tempDir,
                    ownerWindowId: "",
                    projectRoot: tempDir,
                    snapshot: {
                        ...snapshot,
                        trackedFiles: [trackedFile],
                    },
                },
                input: "session-1",
            }),
        ).rejects.toThrow("Cannot safely apply this review change");

        await expect(fs.readFile(filePath, "utf8")).resolves.toBe(diskText);
    });

    it("does not partially revert reject-all when a later tracked file fails safety validation", async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        const safePath = path.join(tempDir, "safe.md");
        const unsafePath = path.join(tempDir, "unsafe.md");
        const safeOriginalText = "before\n";
        const safeCurrentText = "after\n";
        const unsafeDiskText = "alpha\nremove me\nomega\n";
        await fs.writeFile(safePath, safeCurrentText, "utf8");
        await fs.writeFile(unsafePath, unsafeDiskText, "utf8");
        const runtime = createRuntime();
        const safeTrackedFile: AiTrackedFile = {
            hunks: computeDiffHunks(safeOriginalText, safeCurrentText, "safe.md"),
            identityKey: "safe.md",
            isText: true,
            kind: "update",
            newText: safeCurrentText,
            oldText: safeOriginalText,
            path: "safe.md",
            previousPath: null,
            reviewState: "pending",
            reversible: true,
            sessionId: "session-1",
            toolCallId: "tool-safe",
            updatedAt: "2026-04-15T22:23:13.719838Z",
            version: 1,
        };
        const unsafeTrackedFile: AiTrackedFile = {
            hunks: computeDiffHunks("remove me\n", "", "unsafe.md"),
            identityKey: "unsafe.md",
            isText: true,
            kind: "update",
            newText: "",
            oldText: "remove me\n",
            path: "unsafe.md",
            previousPath: null,
            reviewState: "pending",
            reversible: true,
            sessionId: "session-1",
            toolCallId: "tool-unsafe",
            updatedAt: "2026-04-15T22:23:13.719838Z",
            version: 1,
        };
        const snapshot = createLaunch({
            cwd: tempDir,
            projectRoot: tempDir,
            title: "Atomic reject-all safety test",
        }).persistedSnapshot;

        await expect(
            runtime.dispatchMethod("ai.rejectAllTrackedFiles", {
                context: {
                    additionalRoots: [],
                    cwd: tempDir,
                    ownerWindowId: "",
                    projectRoot: tempDir,
                    snapshot: {
                        ...snapshot,
                        trackedFiles: [safeTrackedFile, unsafeTrackedFile],
                    },
                },
                input: "session-1",
            }),
        ).rejects.toThrow("Cannot safely apply this review change");

        await expect(fs.readFile(safePath, "utf8")).resolves.toBe(
            safeCurrentText,
        );
        await expect(fs.readFile(unsafePath, "utf8")).resolves.toBe(
            unsafeDiskText,
        );
    });

    it("rolls back reject-all when a later filesystem write fails", async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        const firstPath = path.join(tempDir, "first.md");
        const secondPath = path.join(tempDir, "second.md");
        const firstOriginalText = "first before\n";
        const firstCurrentText = "first after\n";
        const secondOriginalText = "second before\n";
        const secondCurrentText = "second after\n";
        await fs.writeFile(firstPath, firstCurrentText, "utf8");
        await fs.writeFile(secondPath, secondCurrentText, "utf8");
        const runtime = createRuntime();
        const firstTrackedFile: AiTrackedFile = {
            hunks: computeDiffHunks(
                firstOriginalText,
                firstCurrentText,
                "first.md",
            ),
            identityKey: "first.md",
            isText: true,
            kind: "update",
            newText: firstCurrentText,
            oldText: firstOriginalText,
            path: "first.md",
            previousPath: null,
            reviewState: "pending",
            reversible: true,
            sessionId: "session-1",
            toolCallId: "tool-first",
            updatedAt: "2026-04-15T22:23:13.719838Z",
            version: 1,
        };
        const secondTrackedFile: AiTrackedFile = {
            hunks: computeDiffHunks(
                secondOriginalText,
                secondCurrentText,
                "second.md",
            ),
            identityKey: "second.md",
            isText: true,
            kind: "update",
            newText: secondCurrentText,
            oldText: secondOriginalText,
            path: "second.md",
            previousPath: null,
            reviewState: "pending",
            reversible: true,
            sessionId: "session-1",
            toolCallId: "tool-second",
            updatedAt: "2026-04-15T22:23:13.719838Z",
            version: 1,
        };
        const launch = createLaunch({
            cwd: tempDir,
            projectRoot: tempDir,
            title: "Transactional reject-all write failure test",
        });
        const snapshotWithTrackedFiles = {
            ...launch.persistedSnapshot,
            trackedFiles: [firstTrackedFile, secondTrackedFile],
        };
        await runtime.dispatchMethod("ai.notifyFileBuffer", {
            absolutePath: firstPath,
            content: "first unsaved buffer\n",
        });

        const originalWriteFile = fs.writeFile.bind(fs);
        const writeFileSpy = vi.spyOn(fs, "writeFile");
        let writeCount = 0;
        writeFileSpy.mockImplementation(async (...args) => {
            writeCount += 1;
            if (writeCount === 2) {
                throw new Error("synthetic write failure");
            }

            return await originalWriteFile(...args);
        });

        try {
            await expect(
                runtime.dispatchMethod("ai.rejectAllTrackedFiles", {
                    context: {
                        additionalRoots: [],
                        cwd: tempDir,
                        ownerWindowId: "",
                        projectRoot: tempDir,
                        snapshot: snapshotWithTrackedFiles,
                    },
                    input: "session-1",
                }),
            ).rejects.toThrow("synthetic write failure");
        } finally {
            writeFileSpy.mockRestore();
        }

        await expect(fs.readFile(firstPath, "utf8")).resolves.toBe(
            firstCurrentText,
        );
        await expect(fs.readFile(secondPath, "utf8")).resolves.toBe(
            secondCurrentText,
        );
        expect(snapshotWithTrackedFiles.trackedFiles).toHaveLength(2);

        await runtime.dispatchMethod("ai.prepareSession", {
            input: launch.input,
            launch,
        });
        const client = latestClientFactory?.();
        expect(client).toBeDefined();
        await expect(
            client!.readTextFile({
                path: "first.md",
            }),
        ).resolves.toEqual({
            content: "first unsaved buffer\n",
        });
    });

    it("rolls back moved paths when reject-all fails while removing the moved file", async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        const previousPath = path.join(tempDir, "before.md");
        const movedPath = path.join(tempDir, "after.md");
        const originalText = "before move\n";
        const currentText = "after move\n";
        await fs.writeFile(movedPath, currentText, "utf8");
        const runtime = createRuntime();
        const trackedFile: AiTrackedFile = {
            hunks: computeDiffHunks(originalText, currentText, "after.md"),
            identityKey: "after.md",
            isText: true,
            kind: "move",
            newText: currentText,
            oldText: originalText,
            path: "after.md",
            previousPath: "before.md",
            reviewState: "pending",
            reversible: true,
            sessionId: "session-1",
            toolCallId: "tool-move",
            updatedAt: "2026-04-15T22:23:13.719838Z",
            version: 1,
        };
        const snapshot = createLaunch({
            cwd: tempDir,
            projectRoot: tempDir,
            title: "Transactional reject-all move failure test",
        }).persistedSnapshot;
        const snapshotWithTrackedFiles = {
            ...snapshot,
            trackedFiles: [trackedFile],
        };

        const originalRm = fs.rm.bind(fs);
        const rmSpy = vi.spyOn(fs, "rm");
        rmSpy.mockImplementation(async (...args) => {
            if (args[0] === movedPath) {
                throw new Error("synthetic rm failure");
            }

            return await originalRm(...args);
        });

        try {
            await expect(
                runtime.dispatchMethod("ai.rejectAllTrackedFiles", {
                    context: {
                        additionalRoots: [],
                        cwd: tempDir,
                        ownerWindowId: "",
                        projectRoot: tempDir,
                        snapshot: snapshotWithTrackedFiles,
                    },
                    input: "session-1",
                }),
            ).rejects.toThrow("synthetic rm failure");
        } finally {
            rmSpy.mockRestore();
        }

        await expect(fs.readFile(movedPath, "utf8")).resolves.toBe(currentText);
        await expect(fs.stat(previousPath)).rejects.toMatchObject({
            code: "ENOENT",
        });
        expect(snapshotWithTrackedFiles.trackedFiles).toHaveLength(1);
    });

    it("removes directories created by a failed reject-all rollback", async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        const restoredPath = path.join(tempDir, "nested", "restored.md");
        const failingPath = path.join(tempDir, "failing.md");
        const restoredOriginalText = "deleted before\n";
        const failingOriginalText = "failing before\n";
        const failingCurrentText = "failing after\n";
        await fs.writeFile(failingPath, failingCurrentText, "utf8");
        const runtime = createRuntime();
        const restoredTrackedFile: AiTrackedFile = {
            hunks: computeDiffHunks(
                restoredOriginalText,
                "",
                "nested/restored.md",
            ),
            identityKey: "nested/restored.md",
            isText: true,
            kind: "delete",
            newText: null,
            oldText: restoredOriginalText,
            path: "nested/restored.md",
            previousPath: null,
            reviewState: "pending",
            reversible: true,
            sessionId: "session-1",
            toolCallId: "tool-restored",
            updatedAt: "2026-04-15T22:23:13.719838Z",
            version: 1,
        };
        const failingTrackedFile: AiTrackedFile = {
            hunks: computeDiffHunks(
                failingOriginalText,
                failingCurrentText,
                "failing.md",
            ),
            identityKey: "failing.md",
            isText: true,
            kind: "update",
            newText: failingCurrentText,
            oldText: failingOriginalText,
            path: "failing.md",
            previousPath: null,
            reviewState: "pending",
            reversible: true,
            sessionId: "session-1",
            toolCallId: "tool-failing",
            updatedAt: "2026-04-15T22:23:13.719838Z",
            version: 1,
        };
        const snapshot = createLaunch({
            cwd: tempDir,
            projectRoot: tempDir,
            title: "Transactional reject-all mkdir rollback test",
        }).persistedSnapshot;

        const originalWriteFile = fs.writeFile.bind(fs);
        const writeFileSpy = vi.spyOn(fs, "writeFile");
        let writeCount = 0;
        writeFileSpy.mockImplementation(async (...args) => {
            writeCount += 1;
            if (writeCount === 2) {
                throw new Error("synthetic nested rollback failure");
            }

            return await originalWriteFile(...args);
        });

        try {
            await expect(
                runtime.dispatchMethod("ai.rejectAllTrackedFiles", {
                    context: {
                        additionalRoots: [],
                        cwd: tempDir,
                        ownerWindowId: "",
                        projectRoot: tempDir,
                        snapshot: {
                            ...snapshot,
                            trackedFiles: [
                                restoredTrackedFile,
                                failingTrackedFile,
                            ],
                        },
                    },
                    input: "session-1",
                }),
            ).rejects.toThrow("synthetic nested rollback failure");
        } finally {
            writeFileSpy.mockRestore();
        }

        await expect(fs.stat(restoredPath)).rejects.toMatchObject({
            code: "ENOENT",
        });
        await expect(fs.stat(path.dirname(restoredPath))).rejects.toMatchObject({
            code: "ENOENT",
        });
        await expect(fs.readFile(failingPath, "utf8")).resolves.toBe(
            failingCurrentText,
        );
    });

    it("refuses partial hunk rejection when the tracked file is snippet-only", async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        const filePath = path.join(tempDir, "notes.md");
        const diskText = "alpha\nremove me\nomega\n";
        await fs.writeFile(filePath, diskText, "utf8");
        const runtime = createRuntime();
        const hunks = computeDiffHunks("remove me\n", "", "notes.md");
        const trackedFile: AiTrackedFile = {
            hunks,
            identityKey: "notes.md",
            isText: true,
            kind: "update",
            newText: "",
            oldText: "remove me\n",
            path: "notes.md",
            previousPath: null,
            reviewState: "pending",
            reversible: true,
            sessionId: "session-1",
            toolCallId: "tool-1",
            updatedAt: "2026-04-15T22:23:13.719838Z",
            version: 1,
        };
        const snapshot = createLaunch({
            cwd: tempDir,
            projectRoot: tempDir,
            title: "Snippet hunk review safety test",
        }).persistedSnapshot;

        await expect(
            runtime.dispatchMethod("ai.rejectTrackedFileHunks", {
                context: {
                    additionalRoots: [],
                    cwd: tempDir,
                    ownerWindowId: "",
                    projectRoot: tempDir,
                    snapshot: {
                        ...snapshot,
                        trackedFiles: [trackedFile],
                    },
                },
                input: {
                    hunkIds: hunks.map((hunk) => hunk.id),
                    path: "notes.md",
                    sessionId: "session-1",
                },
            }),
        ).rejects.toThrow("Cannot safely apply this review change");

        await expect(fs.readFile(filePath, "utf8")).resolves.toBe(diskText);
    });

    it("keeps tracked file hunks through relative Windows casing aliases", async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        const originalPlatform = process.platform;
        try {
            Object.defineProperty(process, "platform", {
                configurable: true,
                value: "win32",
            });
            const oldText = "before\n";
            const newText = "after\n";
            const hunks = computeDiffHunks(oldText, newText, "src/App.ts");
            const runtime = createRuntime();
            const trackedFile: AiTrackedFile = {
                hunks,
                identityKey: "src/App.ts",
                isText: true,
                kind: "update",
                newText,
                oldText,
                path: "src/App.ts",
                previousPath: null,
                reviewState: "pending",
                reversible: true,
                sessionId: "session-1",
                toolCallId: "tool-1",
                updatedAt: "2026-04-15T22:23:13.719838Z",
                version: 1,
            };
            const snapshot = createLaunch({
                cwd: tempDir,
                projectRoot: tempDir,
                title: "Hunk casing test",
            }).persistedSnapshot;

            const result = await runtime.dispatchMethod(
                "ai.keepTrackedFileHunks",
                {
                    context: {
                        additionalRoots: [],
                        cwd: tempDir,
                        ownerWindowId: "",
                        projectRoot: tempDir,
                        snapshot: {
                            ...snapshot,
                            trackedFiles: [trackedFile],
                        },
                    },
                    input: {
                        hunkIds: [hunks[0]?.id ?? ""],
                        path: "src/app.ts",
                        sessionId: "session-1",
                    },
                },
            );

            expect(result).toMatchObject({
                ownerWindowId: "",
                snapshot: {
                    trackedFiles: [],
                },
            });
        } finally {
            Object.defineProperty(process, "platform", {
                configurable: true,
                value: originalPlatform,
            });
            await fs.rm(tempDir, { force: true, recursive: true });
        }
    });

    it("applies partial hunk rejections inside additional roots", async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-"),
        );
        const additionalRoot = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-worker-extra-"),
        );
        const filePath = path.join(additionalRoot, "notes.md");
        const oldText = "one\ntwo\nthree\n";
        const newText = "ONE\ntwo\nTHREE\n";
        const hunks = computeDiffHunks(oldText, newText, filePath);
        await fs.writeFile(filePath, newText, "utf8");
        const runtime = createRuntime();
        const trackedFile: AiTrackedFile = {
            hunks,
            identityKey: filePath,
            isText: true,
            kind: "update",
            newText,
            oldText,
            path: filePath,
            previousPath: null,
            reviewState: "pending",
            reversible: true,
            sessionId: "session-1",
            toolCallId: "tool-1",
            updatedAt: "2026-04-15T22:23:13.719838Z",
            version: 1,
        };
        const snapshot = createLaunch({
            additionalRoots: [additionalRoot],
            cwd: tempDir,
            projectRoot: tempDir,
            title: "Additional root hunk review test",
        }).persistedSnapshot;

        expect(hunks).toHaveLength(2);

        const result = await runtime.dispatchMethod("ai.rejectTrackedFileHunks", {
            context: {
                additionalRoots: [additionalRoot],
                cwd: tempDir,
                ownerWindowId: "",
                projectRoot: tempDir,
                snapshot: {
                    ...snapshot,
                    trackedFiles: [trackedFile],
                },
            },
            input: {
                hunkIds: [hunks[0].id],
                path: filePath,
                sessionId: "session-1",
            },
        });

        await expect(fs.readFile(filePath, "utf8")).resolves.toBe(
            "one\ntwo\nTHREE\n",
        );
        expect(result).toMatchObject({
            ownerWindowId: "",
            snapshot: {
                trackedFiles: [
                    {
                        newText: "one\ntwo\nTHREE\n",
                        path: filePath,
                    },
                ],
            },
        });
    });
});

function createRuntime() {
    return new AiWorkerRuntime({
        emitEvent: vi.fn(),
    });
}

function createCodexCatalogResponse(
    input: {
        readonly modelId?: string;
        readonly modelOptions?: readonly {
            readonly description?: string | null;
            readonly id: string;
            readonly name: string;
        }[];
        readonly reasoningEffort?: string;
        readonly reasoningOptionId?: string;
    } = {},
) {
    const modelId = input.modelId ?? "gpt-5";
    const modelOptions = input.modelOptions ?? [
        {
            id: "gpt-5",
            name: "GPT-5",
        },
        {
            id: "gpt-5-mini",
            name: "GPT-5 mini",
        },
    ];
    const reasoningEffort = input.reasoningEffort ?? "medium";
    const reasoningOptionId = input.reasoningOptionId ?? "reasoning_effort";

    return {
        configOptions: [
            {
                category: "model",
                currentValue: modelId,
                description: null,
                id: "model",
                name: "Model",
                options: modelOptions.map((option) => ({
                    description: option.description ?? null,
                    name: option.name,
                    value: option.id,
                })),
                type: "select",
            },
            {
                category: "effort",
                currentValue: reasoningEffort,
                description: null,
                id: reasoningOptionId,
                name: "Reasoning effort",
                options: [
                    {
                        description: null,
                        name: "Low",
                        value: "low",
                    },
                    {
                        description: null,
                        name: "Medium",
                        value: "medium",
                    },
                    {
                        description: null,
                        name: "High",
                        value: "high",
                    },
                ],
                type: "select",
            },
        ],
        modes: null,
        models: {
            availableModels: modelOptions.map((option) => ({
                description: option.description ?? null,
                modelId: option.id,
                name: option.name,
            })),
            currentModelId: modelId,
        },
    };
}

async function setupPreparedRuntimeWithClient(title: string): Promise<{
    readonly client: MockAcpClient;
    readonly emittedEvents: AiWorkerEventMessage[];
    readonly launch: AiWorkerSessionLaunchInput;
    readonly runtime: InstanceType<typeof AiWorkerRuntime>;
    readonly tempDir: string;
}> {
    const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "comando-ai-worker-"),
    );
    const emittedEvents: AiWorkerEventMessage[] = [];
    const runtime = new AiWorkerRuntime({
        emitEvent: (event) => {
            emittedEvents.push(event);
        },
    });
    const launch = createLaunch({
        cwd: tempDir,
        projectRoot: tempDir,
        title,
    });

    await runtime.dispatchMethod("ai.prepareSession", {
        input: launch.input,
        launch,
    });
    emittedEvents.length = 0;

    const client = latestClientFactory?.();
    expect(client).toBeDefined();
    return {
        client: client!,
        emittedEvents,
        launch,
        runtime,
        tempDir,
    };
}

async function registerSubagentSession(
    client: MockAcpClient,
    emittedEvents: AiWorkerEventMessage[],
    tempDir: string,
    input: {
        readonly nickname: string;
        readonly runtimeSessionId: string;
    },
): Promise<AiSessionSnapshot> {
    const subagentMeta = {
        codexAcpAgentNickname: input.nickname,
        codexAcpChildSessionId: input.runtimeSessionId,
        codexAcpCwd: tempDir,
        codexAcpEventType: "subagent_session_created",
        codexAcpParentSessionId: "runtime-session-1",
    };
    await client.sessionUpdate({
        _meta: subagentMeta,
        sessionId: input.runtimeSessionId,
        update: {
            _meta: subagentMeta,
            sessionUpdate: "session_info_update",
            title: input.nickname,
        },
    });

    const childSnapshot = getLatestSnapshot(
        emittedEvents,
        (snapshot) =>
            snapshot.parentSessionId === "session-1" &&
            snapshot.runtimeSessionId === input.runtimeSessionId,
    );
    expect(childSnapshot).toEqual(
        expect.objectContaining({
            parentSessionId: "session-1",
            runtimeSessionId: input.runtimeSessionId,
            title: input.nickname,
        }),
    );
    return childSnapshot!;
}

async function sendTurnLifecycle(
    client: MockAcpClient,
    input: {
        readonly eventType: string;
        readonly runtimeSessionId: string;
        readonly turnId?: string;
    },
): Promise<void> {
    const meta: Record<string, unknown> = {
        codexAcpEventType: "turn_lifecycle",
        codexAcpTurnEventType: input.eventType,
    };
    if (input.turnId) {
        meta.codexAcpTurnId = input.turnId;
    }

    await client.sessionUpdate({
        _meta: meta,
        sessionId: input.runtimeSessionId,
        update: {
            _meta: meta,
            sessionUpdate: "session_info_update",
        },
    });
}

async function markRuntimeSessionStreaming(
    client: MockAcpClient,
    runtimeSessionId: string,
    messageId: string,
): Promise<void> {
    await client.sessionUpdate({
        sessionId: runtimeSessionId,
        update: {
            content: {
                text: "working",
                type: "text",
            },
            messageId,
            sessionUpdate: "agent_thought_chunk",
        },
    });
}

function getLatestPendingPermission(
    events: readonly AiWorkerEventMessage[],
): AiPermissionRequest | null {
    for (const event of [...events].reverse()) {
        if (event.event !== "ai.snapshot.updated") {
            continue;
        }

        const update = event.payload.update;
        if (update.kind === "snapshot") {
            return update.snapshot.pendingPermission;
        }

        if ("pendingPermission" in update.patch.changes) {
            return update.patch.changes.pendingPermission ?? null;
        }
    }

    return null;
}

function getLatestToolActivity(
    events: readonly AiWorkerEventMessage[],
): readonly AiToolActivity[] | null {
    for (const event of [...events].reverse()) {
        if (event.event !== "ai.snapshot.updated") {
            continue;
        }

        const update = event.payload.update;
        if (update.kind === "snapshot") {
            return update.snapshot.toolActivity;
        }

        if ("toolActivity" in update.patch.changes) {
            return update.patch.changes.toolActivity ?? null;
        }
    }

    return null;
}

function hasToolActivityMatching(
    events: readonly AiWorkerEventMessage[],
    sessionId: string,
    predicate: (activity: AiToolActivity) => boolean,
): boolean {
    return events.some((event) => {
        if (event.event !== "ai.snapshot.updated") {
            return false;
        }

        const update = event.payload.update;
        const toolActivity =
            update.kind === "snapshot" && update.snapshot.sessionId === sessionId
                ? update.snapshot.toolActivity
                : update.kind === "patch" &&
                    update.patch.sessionId === sessionId &&
                    "toolActivity" in update.patch.changes
                  ? update.patch.changes.toolActivity
                  : null;

        return toolActivity?.some(predicate) ?? false;
    });
}

function getLatestSnapshot(
    events: readonly AiWorkerEventMessage[],
    predicate: (snapshot: AiSessionSnapshot) => boolean,
): AiSessionSnapshot | null {
    for (const event of [...events].reverse()) {
        if (
            event.event === "ai.snapshot.updated" &&
            event.payload.update.kind === "snapshot" &&
            predicate(event.payload.update.snapshot)
        ) {
            return event.payload.update.snapshot;
        }
    }

    return null;
}

function readSelectConfigValue(
    configOptions: AiSessionSnapshot["configOptions"] | undefined,
    optionId: string,
): string | null {
    const option = configOptions?.find((candidate) => candidate.id === optionId);
    return option?.type === "select" ? option.value : null;
}

function getLatestPatchChanges(
    events: readonly AiWorkerEventMessage[],
    sessionId: string,
): AiSessionPatchChanges | null {
    for (const event of [...events].reverse()) {
        if (
            event.event !== "ai.snapshot.updated" ||
            event.payload.update.kind !== "patch" ||
            event.payload.update.patch.sessionId !== sessionId
        ) {
            continue;
        }

        return event.payload.update.patch.changes;
    }

    return null;
}

function hasPatchChangesMatching(
    events: readonly AiWorkerEventMessage[],
    sessionId: string,
    predicate: (changes: AiSessionPatchChanges) => boolean,
): boolean {
    return events.some((event) => {
        if (
            event.event !== "ai.snapshot.updated" ||
            event.payload.update.kind !== "patch" ||
            event.payload.update.patch.sessionId !== sessionId
        ) {
            return false;
        }

        return predicate(event.payload.update.patch.changes);
    });
}

function getLatestPatchMessages(
    events: readonly AiWorkerEventMessage[],
    sessionId: string,
): AiSessionSnapshot["messages"] | null {
    for (const event of [...events].reverse()) {
        if (
            event.event !== "ai.snapshot.updated" ||
            event.payload.update.kind !== "patch" ||
            event.payload.update.patch.sessionId !== sessionId
        ) {
            continue;
        }

        if ("messages" in event.payload.update.patch.changes) {
            return event.payload.update.patch.changes.messages ?? null;
        }
    }

    return null;
}

function getLatestTrackedFiles(
    events: readonly AiWorkerEventMessage[],
    sessionId: string,
): readonly AiTrackedFile[] | null {
    for (const event of [...events].reverse()) {
        if (event.event !== "ai.snapshot.updated") {
            continue;
        }

        const update = event.payload.update;
        if (
            update.kind === "snapshot" &&
            update.snapshot.sessionId === sessionId
        ) {
            return update.snapshot.trackedFiles;
        }

        if (
            update.kind === "patch" &&
            update.patch.sessionId === sessionId &&
            "trackedFiles" in update.patch.changes
        ) {
            return update.patch.changes.trackedFiles ?? null;
        }
    }

    return null;
}

function hasTrackedFileEvent(
    events: readonly AiWorkerEventMessage[],
    sessionId: string,
    filePath: string,
): boolean {
    return events.some((event) => {
        if (event.event !== "ai.snapshot.updated") {
            return false;
        }

        const update = event.payload.update;
        const trackedFiles =
            update.kind === "snapshot" && update.snapshot.sessionId === sessionId
                ? update.snapshot.trackedFiles
                : update.kind === "patch" &&
                    update.patch.sessionId === sessionId &&
                    "trackedFiles" in update.patch.changes
                  ? update.patch.changes.trackedFiles
                  : null;

        return (
            trackedFiles?.some((trackedFile) => trackedFile.path === filePath) ??
            false
        );
    });
}

function createLaunch(
    overrides: Partial<AiWorkerSessionLaunchInput> & {
        readonly cwd: string;
        readonly projectRoot: string | null;
        readonly title: string;
    },
): AiWorkerSessionLaunchInput {
    const { cwd, projectRoot, title, ...rest } = overrides;
    const readyStatus: AiRuntimeStatus = {
        authMethod: "chatgpt",
        authMethods: [],
        authReady: true,
        checkedAt: "2026-04-15T00:00:00.000Z",
        command: "mock-codex-acp",
        hasCustomBinaryPath: false,
        hasGatewayConfig: false,
        hasGatewayUrl: false,
        message: null,
        onboardingRequired: false,
        runtimeId: "codex",
        source: "bundled",
        state: "ready",
    };

    return {
        additionalRoots: [],
        cwd,
        desiredSelections: {
            configOptions: [],
            modeId: null,
            modelId: null,
            preferredConfigOptions: {},
        },
        input: {
            projectId: null,
            runtimeId: "codex",
            sessionId: "session-1",
            title,
            worktreeId: null,
        },
        ownerWindowId: "window-1",
        persistedSnapshot: {
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
            projectId: null,
            runtimeId: "codex",
            runtimeSessionId: "runtime-session-1",
            sessionId: "session-1",
            status: "idle",
            title,
            tokenUsage: null,
            toolActivity: [],
            trackedFiles: [],
            updatedAt: "2026-04-15T22:23:13.719838Z",
            worktreeId: null,
        },
        projectRoot,
        resolvedRuntime: {
            args: [],
            command: "mock-codex-acp",
            env: process.env,
            executable: "mock-codex-acp",
            status: readyStatus,
        },
        ...rest,
    };
}

function createRuntimeLaunch(input: {
    readonly cwd: string;
    readonly projectRoot: string | null;
    readonly runtimeId: AiRuntimeStatus["runtimeId"];
    readonly title: string;
}): AiWorkerSessionLaunchInput {
    const launch = createLaunch({
        cwd: input.cwd,
        projectRoot: input.projectRoot,
        title: input.title,
    });
    const status = {
        ...launch.resolvedRuntime.status,
        authMethod: input.runtimeId === "codex" ? "chatgpt" : null,
        command: `mock-${input.runtimeId}-acp`,
        runtimeId: input.runtimeId,
    } satisfies AiRuntimeStatus;

    return {
        ...launch,
        input: {
            ...launch.input,
            runtimeId: input.runtimeId,
            title: input.title,
        },
        persistedSnapshot: {
            ...launch.persistedSnapshot,
            runtimeId: input.runtimeId,
            title: input.title,
        },
        resolvedRuntime: {
            ...launch.resolvedRuntime,
            command: status.command,
            executable: status.command,
            status,
        },
    };
}

function createGrokLaunch(input: {
    readonly authCredentialSource: NonNullable<
        AiRuntimeStatus["authCredentialSource"]
    >;
    readonly authMethod: string;
    readonly cwd: string;
    readonly projectRoot: string | null;
    readonly title: string;
}): AiWorkerSessionLaunchInput {
    const launch = createLaunch({
        cwd: input.cwd,
        projectRoot: input.projectRoot,
        title: input.title,
    });
    const status = {
        ...launch.resolvedRuntime.status,
        authCredentialSource: input.authCredentialSource,
        authMethod: input.authMethod,
        command: "mock-grok-acp",
        runtimeId: "grok",
    } satisfies AiRuntimeStatus;

    return {
        ...launch,
        input: {
            ...launch.input,
            runtimeId: "grok",
            title: input.title,
        },
        persistedSnapshot: {
            ...launch.persistedSnapshot,
            runtimeId: "grok",
            title: input.title,
        },
        resolvedRuntime: {
            ...launch.resolvedRuntime,
            authHandshake: {
                envMethodId: "xai.api_key",
                externalMethodId: "cached_token",
                meta: {
                    headless: true,
                },
            },
            command: "mock-grok-acp",
            executable: "mock-grok-acp",
            status,
        },
    };
}
