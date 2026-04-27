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
let latestClientFactory:
    | (() => {
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
          }) => Promise<{ content: string }>;
          releaseTerminal: (params: {
              readonly sessionId: string;
              readonly terminalId: string;
          }) => Promise<Record<string, never>>;
          sessionUpdate: (params: {
              readonly sessionId: string;
              readonly update: {
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
          }) => Promise<Record<string, never>>;
      })
    | null = null;
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
