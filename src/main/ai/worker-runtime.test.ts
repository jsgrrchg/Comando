import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AiRuntimeStatus, AiSessionSnapshot, AiTrackedFile } from "@shared/ipc";

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
let latestClientFactory:
    | (() => {
          readTextFile: (params: {
              readonly limit?: number;
              readonly line?: number;
              readonly path: string;
          }) => Promise<{ content: string }>;
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
const spawnMock = vi.fn(() => ({
    kill: vi.fn(),
    on: vi.fn(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    stdout: new PassThrough(),
}));

vi.mock("node:child_process", () => ({
    spawn: spawnMock,
}));

vi.mock("@agentclientprotocol/sdk", () => ({
    ClientSideConnection: class MockClientSideConnection {
        constructor(
            clientFactory: typeof latestClientFactory,
            _stream: unknown,
        ) {
            latestClientFactory = clientFactory;
        }

        initialize = initializeMock;
        loadSession = loadSessionMock;
        newSession = newSessionMock;
        prompt = promptMock;
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
        spawnMock.mockClear();
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
});

function createRuntime() {
    return new AiWorkerRuntime({
        emitEvent: vi.fn(),
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
