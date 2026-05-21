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

import type { AiWorkerEventMessage, AiWorkerSessionLaunchInput } from "./contracts";

const initializeMock = vi.fn(() => Promise.resolve(undefined));
const loadSessionMock = vi.fn(() =>
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
const newSessionMock = vi.fn(() =>
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
        }

        initialize = initializeMock;
        cancel = cancelRuntimeSessionMock;
        loadSession = loadSessionMock;
        newSession = newSessionMock;
        prompt = promptMock;
        unstable_closeSession = closeRuntimeSessionMock;
    },
    PROTOCOL_VERSION: "test-protocol-version",
    ndJsonStream: vi.fn(() => ({})),
}));

const { AiWorkerRuntime } = await import("./worker-runtime");

describe("AiWorkerRuntime prepareSession", () => {
    beforeEach(() => {
        initializeMock.mockClear();
        loadSessionMock.mockClear();
        loadSessionMock.mockResolvedValue({
            configOptions: [],
            modes: [],
            models: [],
        });
        promptMock.mockClear();
        newSessionMock.mockClear();
        closeRuntimeSessionMock.mockClear();
        cancelRuntimeSessionMock.mockClear();
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
            expect.objectContaining({
                content: "ACTORES/Gabriel Boric.md",
                kind: "assistant",
            }),
        ]);
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
                    (changes) => changes.status === "idle",
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
                    (changes) => changes.status === "streaming",
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
            getLatestPatchMessages(emittedEvents, childSnapshot!.sessionId),
        ).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    content: "reopened and reported",
                    kind: "assistant",
                }),
            ]),
        );
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
            expect.objectContaining({
                content: "report complete",
                kind: "assistant",
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
        expect(getLatestPatchMessages(emittedEvents, firstChild.sessionId)).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    content: "first report complete",
                    kind: "assistant",
                }),
            ]),
        );
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

    it("marks a subagent idle when the parent receives a close breadcrumb", async () => {
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
            expect(
                getLatestPatchChanges(emittedEvents, "session-1"),
            ).toMatchObject({
                lastError: expect.stringContaining("connection died"),
                status: "error",
            });
            expect(
                getLatestPatchChanges(
                    emittedEvents,
                    childSnapshot!.sessionId,
                ),
            ).toMatchObject({
                lastError: expect.stringContaining("connection died"),
                status: "error",
            });
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
        expect(result).toEqual({
            ownerWindowId: "",
            snapshot: expect.objectContaining({
                trackedFiles: [],
            }),
        });
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
        expect(result).toEqual({
            ownerWindowId: "",
            snapshot: expect.objectContaining({
                trackedFiles: [],
            }),
        });
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
                hunkIds: [hunks[0]!.id],
                path: filePath,
                sessionId: "session-1",
            },
        });

        await expect(fs.readFile(filePath, "utf8")).resolves.toBe(
            "one\ntwo\nTHREE\n",
        );
        expect(result).toEqual({
            ownerWindowId: "",
            snapshot: expect.objectContaining({
                trackedFiles: [
                    expect.objectContaining({
                        newText: "one\ntwo\nTHREE\n",
                        path: filePath,
                    }),
                ],
            }),
        });
    });
});

function createRuntime() {
    return new AiWorkerRuntime({
        emitEvent: vi.fn(),
    });
}

async function setupPreparedRuntimeWithClient(title: string): Promise<{
    readonly client: MockAcpClient;
    readonly emittedEvents: AiWorkerEventMessage[];
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
