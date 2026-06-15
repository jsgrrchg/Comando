import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
    AiRuntimeStatus,
    AiSessionSnapshot,
    AiTrackedFile,
    AiSessionUpdate,
} from "@shared/ipc";
import { computeDiffHunks } from "@shared/ai-tracked-file";
import { forgetOpenFileBuffer, recordOpenFileBuffer } from "./openFileBuffers";
import type { AiWorkerGateway } from "./contracts";

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

const claudeReadyStatus: AiRuntimeStatus = {
    ...readyStatus,
    command: "mock-claude-acp",
    runtimeId: "claude",
};

vi.mock("./resolver/runtime-resolver", () => ({
    resolveCodexRuntime: vi.fn(() => ({
        args: [],
        command: "mock-codex-acp",
        executable: "mock-codex-acp",
        status: readyStatus,
    })),
}));

vi.mock("./codex/setup", () => ({
    applyCodexAuthEnv: vi.fn((baseEnv: NodeJS.ProcessEnv) => ({
        ...baseEnv,
    })),
    getCodexAuthMethods: vi.fn(() => []),
    getCodexRuntimeStatus: vi.fn(() => readyStatus),
    isCodexAuthenticationError: vi.fn(() => false),
    loadCodexSecretBundle: vi.fn(() => ({
        codexApiKey: null,
        openaiApiKey: null,
    })),
    saveCodexSecrets: vi.fn(() => ({
        hasCodexApiKey: false,
        hasOpenAiApiKey: false,
    })),
}));

vi.mock("./claude/setup", () => ({
    applyClaudeAuthEnv: vi.fn((baseEnv: NodeJS.ProcessEnv) => ({
        ...baseEnv,
    })),
    buildClaudeSecretPatches: vi.fn(() => ({
        flags: {
            hasAnthropicApiKey: false,
            hasGatewayAuthToken: false,
            hasGatewayCustomHeaders: false,
        },
        patches: [],
    })),
    getClaudeRuntimeStatus: vi.fn(() => claudeReadyStatus),
    isClaudeAuthenticationError: vi.fn(() => false),
    launchClaudeLogin: vi.fn(),
    loadClaudeSecretBundle: vi.fn(() => ({
        anthropicApiKey: null,
        gatewayAuthToken: null,
    })),
    markClaudeAuthInvalidated: vi.fn(
        (settings: Record<string, unknown>) => settings,
    ),
    resolveClaudeRuntime: vi.fn(() => ({
        args: [],
        command: "mock-claude-acp",
        program: "mock-claude-acp",
        status: claudeReadyStatus,
    })),
}));

const { AiService } = await import("./service");

describe("AiService hybrid persistence", () => {
    it("returns the live cached snapshot before falling back to persistence", async () => {
        const persistedSnapshot = createSnapshot({
            sessionId: "session-1",
            title: "Persisted",
            updatedAt: "2026-04-16T00:00:00.000Z",
        });
        const liveSnapshot = createSnapshot({
            sessionId: "session-1",
            title: "Live",
            updatedAt: "2026-04-16T01:00:00.000Z",
        });
        const loadSessionSnapshot = vi.fn(() => persistedSnapshot);
        const service = createService({
            loadSessionSnapshot,
        });

        service.handleWorkerSessionSnapshot("window-1", {
            kind: "snapshot",
            snapshot: liveSnapshot,
        });

        await expect(service.getSessionSnapshot("session-1")).resolves.toEqual(
            liveSnapshot,
        );
        expect(loadSessionSnapshot).not.toHaveBeenCalled();
    });

    it("drops net-clean tracked files from persisted snapshots", async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-ai-service-"),
        );
        try {
            await fs.writeFile(path.join(tempDir, "notes.md"), "before\n", "utf8");
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
                updatedAt: "2026-04-16T00:00:00.000Z",
                version: 1,
            };
            const persistedSnapshot = createSnapshot({
                projectId: "project-1",
                sessionId: "session-1",
                trackedFiles: [trackedFile],
            });
            const saveSessionSnapshot = vi.fn();
            const service = createService({
                loadSessionSnapshot: vi.fn(() => persistedSnapshot),
                projectRoot: tempDir,
                saveSessionSnapshot,
            });

            await expect(service.getSessionSnapshot("session-1")).resolves.toEqual(
                expect.objectContaining({
                    trackedFiles: [],
                }),
            );
            expect(saveSessionSnapshot).toHaveBeenCalledWith(
                expect.objectContaining({
                    sessionId: "session-1",
                    trackedFiles: [],
                }),
            );
        } finally {
            await fs.rm(tempDir, { force: true, recursive: true });
        }
    });

    it("persists and broadcasts patch updates while keeping the merged live cache", async () => {
        const baseSnapshot = createSnapshot({
            sessionId: "session-1",
            title: "Base title",
            updatedAt: "2026-04-16T00:00:00.000Z",
        });
        const saveSessionSnapshot = vi.fn();
        const onSessionSnapshot = vi.fn();
        const service = createService({
            loadSessionSnapshot: vi.fn(() => baseSnapshot),
            onSessionSnapshot,
            saveSessionSnapshot,
        });

        service.handleWorkerSessionSnapshot("window-1", {
            kind: "snapshot",
            snapshot: baseSnapshot,
        });
        onSessionSnapshot.mockClear();
        saveSessionSnapshot.mockClear();

        const update: AiSessionUpdate = {
            kind: "patch",
            patch: {
                changes: {
                    lastError: null,
                    status: "streaming",
                    title: "Updated title",
                    updatedAt: "2026-04-16T02:00:00.000Z",
                },
                runtimeId: "codex",
                sessionId: "session-1",
            },
        };

        service.handleWorkerSessionSnapshot("window-1", update);

        expect(saveSessionSnapshot).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: "session-1",
                status: "streaming",
                title: "Updated title",
                updatedAt: "2026-04-16T02:00:00.000Z",
            }),
        );
        expect(onSessionSnapshot).toHaveBeenCalledWith("window-1", update);
        await expect(service.getSessionSnapshot("session-1")).resolves.toEqual(
            expect.objectContaining({
                sessionId: "session-1",
                status: "streaming",
                title: "Updated title",
                updatedAt: "2026-04-16T02:00:00.000Z",
            }),
        );
    });

    it("replays open file buffers to the worker when it restarts", async () => {
        const persistedSnapshot = createSnapshot({
            sessionId: "session-1",
            title: "Restartable",
        });
        const saveSessionSnapshot = vi.fn();
        const prepareSession = vi.fn(() => Promise.resolve(persistedSnapshot));
        const notifyFileBuffer = vi.fn(() => Promise.resolve(undefined));
        const absolutePath = "/tmp/comando-phase-4-buffer.txt";
        const service = createService({
            aiWorker: {
                cancelSession: vi.fn(),
                close: vi.fn(),
                closeOwnedByWindow: vi.fn(),
                closeSession: vi.fn(),
                keepAllTrackedFiles: vi.fn(),
                keepTrackedFile: vi.fn(),
                keepTrackedFileHunks: vi.fn(),
                notifyFileBuffer,
                prepareSession,
                rejectAllTrackedFiles: vi.fn(),
                rejectTrackedFile: vi.fn(),
                rejectTrackedFileHunks: vi.fn(),
                refreshProjectScopes: vi.fn(),
                respondPermission: vi.fn(),
                respondUserInput: vi.fn(),
                sendPrompt: vi.fn(),
                setSessionConfigOption: vi.fn(),
                setSessionMode: vi.fn(),
                setSessionModel: vi.fn(),
            },
            loadSessionSnapshot: vi.fn(() => persistedSnapshot),
            saveSessionSnapshot,
        });

        recordOpenFileBuffer(absolutePath, "unsaved content");
        try {
            await service.prepareSession(
                {
                    projectId: null,
                    runtimeId: "codex",
                    sessionId: "session-1",
                    title: "Restartable",
                    worktreeId: null,
                },
                "window-1",
            );
            prepareSession.mockClear();

            await service.handleWorkerRestarted();

            expect(notifyFileBuffer).toHaveBeenCalledWith({
                absolutePath,
                content: "unsaved content",
            });
            expect(prepareSession).toHaveBeenCalledTimes(1);
            expect(saveSessionSnapshot).toHaveBeenCalledWith(persistedSnapshot);
        } finally {
            forgetOpenFileBuffer(absolutePath);
        }
    });

    it("does not relaunch live subagents as root sessions when the worker restarts", async () => {
        const parentSnapshot = createSnapshot({
            projectId: "project-1",
            runtimeSessionId: "runtime-parent",
            sessionId: "session-1",
            title: "Parent",
        });
        const childSnapshot = createSnapshot({
            parentSessionId: "session-1",
            projectId: "project-1",
            runtimeSessionId: "runtime-child",
            sessionId: "session-child",
            title: "Child",
        });
        const prepareSession = vi.fn(() => Promise.resolve(parentSnapshot));
        const service = createService({
            aiWorker: createMockWorker({ prepareSession }),
            loadSessionSnapshot: vi.fn((sessionId: string) =>
                sessionId === "session-child" ? childSnapshot : parentSnapshot,
            ),
        });

        await service.prepareSession(
            {
                projectId: "project-1",
                runtimeId: "codex",
                sessionId: "session-1",
                title: "Parent",
                worktreeId: null,
            },
            "window-1",
        );
        service.handleWorkerSessionSnapshot("window-1", {
            kind: "snapshot",
            snapshot: childSnapshot,
        });
        prepareSession.mockClear();

        await service.handleWorkerRestarted();

        expect(prepareSession).toHaveBeenCalledTimes(1);
        const [prepareSessionCall] = prepareSession.mock.calls as unknown as [
            [{ input: { sessionId: string } }],
        ];
        expect(prepareSessionCall[0].input.sessionId).toBe("session-1");
    });

    it("preserves a historical child parent link when the child is opened before the parent", async () => {
        const parentSnapshot = createSnapshot({
            projectId: "project-1",
            runtimeSessionId: "runtime-parent",
            sessionId: "session-1",
            title: "Parent",
        });
        const childSnapshot = createSnapshot({
            parentSessionId: "session-1",
            projectId: "project-1",
            runtimeSessionId: "runtime-child",
            sessionId: "session-child",
            title: "Child",
        });
        const prepareSession = vi.fn(
            ({ input }: Parameters<AiWorkerGateway["prepareSession"]>[0]) =>
                Promise.resolve(
                    input.sessionId === "session-child"
                        ? childSnapshot
                        : parentSnapshot,
                ),
        );
        const service = createService({
            aiWorker: createMockWorker({ prepareSession }),
            loadSessionSnapshot: vi.fn((sessionId: string) =>
                sessionId === "session-child" ? childSnapshot : parentSnapshot,
            ),
        });

        await service.prepareSession(
            {
                projectId: "project-1",
                runtimeId: "codex",
                sessionId: "session-child",
                title: "Child",
                worktreeId: null,
            },
            "window-1",
        );
        await service.prepareSession(
            {
                projectId: "project-1",
                runtimeId: "codex",
                sessionId: "session-1",
                title: "Parent",
                worktreeId: null,
            },
            "window-1",
        );
        prepareSession.mockClear();

        await service.handleWorkerRestarted();

        expect(prepareSession).toHaveBeenCalledTimes(1);
        const [prepareSessionCall] = prepareSession.mock.calls as unknown as [
            [{ input: { sessionId: string } }],
        ];
        expect(prepareSessionCall[0].input.sessionId).toBe("session-1");
    });

    it("keeps subagent parent ownership after sending a prompt to the child", async () => {
        const parentSnapshot = createSnapshot({
            projectId: "project-1",
            runtimeSessionId: "runtime-parent",
            sessionId: "session-1",
            title: "Parent",
        });
        const childSnapshot = createSnapshot({
            parentSessionId: "session-1",
            projectId: "project-1",
            runtimeSessionId: "runtime-child",
            sessionId: "session-child",
            title: "Child",
        });
        const prepareSession = vi.fn(() => Promise.resolve(parentSnapshot));
        const sendPrompt = vi.fn(() => Promise.resolve({
            sessionId: "session-child",
            stopReason: "completed",
        }));
        const service = createService({
            aiWorker: createMockWorker({ prepareSession, sendPrompt }),
            loadSessionSnapshot: vi.fn((sessionId: string) =>
                sessionId === "session-child" ? childSnapshot : parentSnapshot,
            ),
        });

        await service.prepareSession(
            {
                projectId: "project-1",
                runtimeId: "codex",
                sessionId: "session-1",
                title: "Parent",
                worktreeId: null,
            },
            "window-1",
        );
        service.handleWorkerSessionSnapshot("window-1", {
            kind: "snapshot",
            snapshot: childSnapshot,
        });

        await service.sendPrompt(
            {
                attachments: [],
                messageId: "message-child-1",
                projectId: "project-1",
                prompt: "hello child",
                runtimeId: "codex",
                sessionId: "session-child",
                title: "Child",
                worktreeId: null,
            },
            "window-1",
        );
        prepareSession.mockClear();

        await service.handleWorkerRestarted();

        expect(sendPrompt).toHaveBeenCalledTimes(1);
        expect(prepareSession).toHaveBeenCalledTimes(1);
        const [prepareSessionCall] = prepareSession.mock.calls as unknown as [
            [{ input: { sessionId: string } }],
        ];
        expect(prepareSessionCall[0].input.sessionId).toBe("session-1");
    });

    it("does not refresh project scopes for live subagents owned by a live parent", async () => {
        const parentSnapshot = createSnapshot({
            projectId: "project-1",
            runtimeSessionId: "runtime-parent",
            sessionId: "session-1",
            title: "Parent",
        });
        const childSnapshot = createSnapshot({
            parentSessionId: "session-1",
            projectId: "project-1",
            runtimeSessionId: "runtime-child",
            sessionId: "session-child",
            title: "Child",
        });
        const refreshProjectScopes = vi.fn(() => Promise.resolve(undefined));
        const service = createService({
            aiWorker: createMockWorker({
                prepareSession: vi.fn(() => Promise.resolve(parentSnapshot)),
                refreshProjectScopes,
            }),
            loadSessionSnapshot: vi.fn((sessionId: string) =>
                sessionId === "session-child" ? childSnapshot : parentSnapshot,
            ),
        });

        await service.prepareSession(
            {
                projectId: "project-1",
                runtimeId: "codex",
                sessionId: "session-1",
                title: "Parent",
                worktreeId: null,
            },
            "window-1",
        );
        service.handleWorkerSessionSnapshot("window-1", {
            kind: "snapshot",
            snapshot: childSnapshot,
        });

        await service.refreshProjectScopes("project-1");

        expect(refreshProjectScopes).toHaveBeenCalledTimes(1);
        const [refreshProjectScopesCall] = refreshProjectScopes.mock
            .calls as unknown as [
            [
                {
                    sessions: readonly {
                        input: { sessionId: string };
                    }[];
                },
            ],
        ];
        expect(
            refreshProjectScopesCall[0].sessions.map(
                (launch) => launch.input.sessionId,
            ),
        ).toEqual(["session-1"]);
    });

    it("delegates persisted review mutations to the worker and persists the returned snapshot", async () => {
        const persistedSnapshot = createSnapshot({
            sessionId: "session-1",
            trackedFiles: [
                {
                    hunks: [],
                    identityKey: "notes.md",
                    isText: true,
                    kind: "update",
                    newText: "after",
                    oldText: "before",
                    path: "notes.md",
                    previousPath: null,
                    reviewState: "pending",
                    reversible: true,
                    sessionId: "session-1",
                    toolCallId: "tool-1",
                    updatedAt: "2026-04-16T00:00:00.000Z",
                    version: 1,
                } satisfies AiTrackedFile,
            ],
        });
        const saveSessionSnapshot = vi.fn();
        const onSessionSnapshot = vi.fn();
        const keepTrackedFile = vi.fn<AiWorkerGateway["keepTrackedFile"]>(() =>
            Promise.resolve({
                ownerWindowId: "",
                snapshot: {
                    ...persistedSnapshot,
                    trackedFiles: [],
                    updatedAt: "2026-04-16T03:00:00.000Z",
                },
            }),
        );
        const service = createService({
            aiWorker: {
                cancelSession: vi.fn(),
                close: vi.fn(),
                closeOwnedByWindow: vi.fn(),
                closeSession: vi.fn(),
                keepAllTrackedFiles: vi.fn(),
                keepTrackedFile,
                keepTrackedFileHunks: vi.fn(),
                notifyFileBuffer: vi.fn(),
                prepareSession: vi.fn(),
                rejectAllTrackedFiles: vi.fn(),
                rejectTrackedFile: vi.fn(),
                rejectTrackedFileHunks: vi.fn(),
                refreshProjectScopes: vi.fn(),
                respondPermission: vi.fn(),
                respondUserInput: vi.fn(),
                sendPrompt: vi.fn(),
                setSessionConfigOption: vi.fn(),
                setSessionMode: vi.fn(),
                setSessionModel: vi.fn(),
            },
            loadSessionSnapshot: vi.fn(() => persistedSnapshot),
            onSessionSnapshot,
            saveSessionSnapshot,
        });

        await service.keepTrackedFile({
            path: "notes.md",
            sessionId: "session-1",
        });

        const [keepTrackedFileInput] = keepTrackedFile.mock.calls[0] ?? [];
        expect(keepTrackedFileInput?.context.ownerWindowId).toBe("");
        expect(keepTrackedFileInput?.context.snapshot).toBe(persistedSnapshot);
        expect(keepTrackedFileInput?.input).toEqual({
            path: "notes.md",
            sessionId: "session-1",
        });
        expect(saveSessionSnapshot).toHaveBeenCalledWith(
            expect.objectContaining({
                trackedFiles: [],
            }),
        );
        expect(onSessionSnapshot).toHaveBeenCalledWith(
            "",
            expect.objectContaining({
                kind: "patch",
            }),
        );
    });

    it("limits cold starts for many sessions on the same runtime", async () => {
        const starts = new Map<
            string,
            ReturnType<typeof createDeferred<AiSessionSnapshot>>
        >();
        const prepareSession = vi.fn<AiWorkerGateway["prepareSession"]>(
            ({ input }) => {
                const deferred = createDeferred<AiSessionSnapshot>();
                starts.set(input.sessionId, deferred);
                return deferred.promise;
            },
        );
        const service = createService({
            aiWorker: createMockWorker({ prepareSession }),
        });

        const preparePromises = Array.from({ length: 10 }, (_, index) =>
            service.prepareSession(
                {
                    projectId: "project-1",
                    runtimeId: "codex",
                    sessionId: `session-${index}`,
                    title: `Session ${index}`,
                    worktreeId: null,
                },
                "window-1",
            ),
        );

        await vi.waitFor(() => {
            expect(prepareSession).toHaveBeenCalledTimes(1);
        });
        expect(service.getSchedulerDiagnostics()).toMatchObject({
            activeColdStarts: 1,
            queued: 9,
        });

        starts
            .get("session-0")
            ?.resolve(createSnapshot({ sessionId: "session-0" }));
        await vi.waitFor(() => {
            expect(prepareSession).toHaveBeenCalledTimes(2);
        });
        expect(service.getSchedulerDiagnostics()).toMatchObject({
            activeColdStarts: 1,
            queued: 8,
        });

        for (let index = 1; index < 10; index += 1) {
            const sessionId = `session-${index}`;
            await vi.waitFor(() => {
                expect(starts.has(sessionId)).toBe(true);
            });
            starts.get(sessionId)?.resolve(createSnapshot({ sessionId }));
        }

        await Promise.all(preparePromises);
        expect(prepareSession).toHaveBeenCalledTimes(10);
        expect(service.getSchedulerDiagnostics()).toMatchObject({
            activeColdStarts: 0,
            queued: 0,
        });
    });

    it("does not let a slow runtime block cold starts for another runtime", async () => {
        const starts = new Map<
            string,
            ReturnType<typeof createDeferred<AiSessionSnapshot>>
        >();
        const prepareSession = vi.fn<AiWorkerGateway["prepareSession"]>(
            ({ input }) => {
                const deferred = createDeferred<AiSessionSnapshot>();
                starts.set(input.sessionId, deferred);
                return deferred.promise;
            },
        );
        const service = createService({
            aiWorker: createMockWorker({ prepareSession }),
            aiScheduler: {
                maxColdStartsGlobal: 2,
                maxColdStartsPerRuntime: 1,
            },
        });

        const codexOne = service.prepareSession(
            {
                projectId: "project-1",
                runtimeId: "codex",
                sessionId: "codex-1",
                title: "Codex 1",
                worktreeId: null,
            },
            "window-1",
        );
        const codexTwo = service.prepareSession(
            {
                projectId: "project-1",
                runtimeId: "codex",
                sessionId: "codex-2",
                title: "Codex 2",
                worktreeId: null,
            },
            "window-1",
        );
        const claudeOne = service.prepareSession(
            {
                projectId: "project-1",
                runtimeId: "claude",
                sessionId: "claude-1",
                title: "Claude 1",
                worktreeId: null,
            },
            "window-1",
        );

        await vi.waitFor(() => {
            expect(prepareSession).toHaveBeenCalledTimes(2);
        });
        expect([...starts.keys()].sort()).toEqual(["claude-1", "codex-1"]);

        starts
            .get("codex-1")
            ?.resolve(createSnapshot({ sessionId: "codex-1" }));
        await vi.waitFor(() => {
            expect(prepareSession).toHaveBeenCalledTimes(3);
        });
        starts
            .get("codex-2")
            ?.resolve(createSnapshot({ sessionId: "codex-2" }));
        starts.get("claude-1")?.resolve(
            createSnapshot({
                runtimeId: "claude",
                sessionId: "claude-1",
            }),
        );

        await Promise.all([codexOne, codexTwo, claudeOne]);
    });

    it("prioritizes a manual prompt ahead of queued background scope refresh", async () => {
        const blocker = createDeferred<AiSessionSnapshot>();
        const order: string[] = [];
        const prepareSession = vi.fn<AiWorkerGateway["prepareSession"]>(
            ({ input }) => {
                order.push(`prepare:${input.sessionId}`);
                if (input.sessionId === "blocker") {
                    return blocker.promise;
                }
                return Promise.resolve(
                    createSnapshot({
                        projectId: input.projectId,
                        runtimeId: input.runtimeId,
                        sessionId: input.sessionId,
                    }),
                );
            },
        );
        const refreshProjectScopes = vi.fn(() => {
            order.push("refresh");
            return Promise.resolve(undefined);
        });
        const sendPrompt = vi.fn<AiWorkerGateway["sendPrompt"]>(({ input }) => {
            order.push("send");
            return Promise.resolve({
                sessionId: input.sessionId,
                stopReason: "completed",
            });
        });
        const service = createService({
            aiWorker: createMockWorker({
                prepareSession,
                refreshProjectScopes,
                sendPrompt,
            }),
            aiScheduler: {
                maxColdStartsGlobal: 1,
                maxColdStartsPerRuntime: 1,
            },
        });

        await service.prepareSession(
            {
                projectId: "project-1",
                runtimeId: "codex",
                sessionId: "live-session",
                title: "Live",
                worktreeId: null,
            },
            "window-1",
        );
        const blockerPromise = service.prepareSession(
            {
                projectId: "project-1",
                runtimeId: "codex",
                sessionId: "blocker",
                title: "Blocker",
                worktreeId: null,
            },
            "window-1",
        );
        await vi.waitFor(() => {
            expect(order).toContain("prepare:blocker");
        });

        const refreshPromise = service.refreshProjectScopes("project-1");
        const promptPromise = service.sendPrompt(
            {
                attachments: [],
                messageId: "message-1",
                projectId: "project-1",
                prompt: "jump ahead",
                runtimeId: "codex",
                sessionId: "prompt-session",
                title: "Prompt",
                worktreeId: null,
            },
            "window-1",
        );

        await Promise.resolve();
        expect(order).not.toContain("send");
        expect(order).not.toContain("refresh");

        blocker.resolve(
            createSnapshot({
                projectId: "project-1",
                sessionId: "blocker",
            }),
        );
        await blockerPromise;
        await Promise.all([refreshPromise, promptPromise]);

        expect(order.indexOf("send")).toBeGreaterThan(-1);
        expect(order.indexOf("refresh")).toBeGreaterThan(-1);
        expect(order.indexOf("send")).toBeLessThan(order.indexOf("refresh"));
    });

    it("does not put permission responses behind cold-start backpressure", async () => {
        const blocker = createDeferred<AiSessionSnapshot>();
        const prepareSession = vi.fn(() => blocker.promise);
        const respondPermission = vi.fn(() => Promise.resolve(undefined));
        const service = createService({
            aiWorker: createMockWorker({
                prepareSession,
                respondPermission,
            }),
            aiScheduler: {
                maxColdStartsGlobal: 1,
                maxColdStartsPerRuntime: 1,
            },
        });

        const preparePromise = service.prepareSession(
            {
                projectId: "project-1",
                runtimeId: "codex",
                sessionId: "blocked-session",
                title: "Blocked",
                worktreeId: null,
            },
            "window-1",
        );
        await vi.waitFor(() => {
            expect(prepareSession).toHaveBeenCalledTimes(1);
        });

        await service.respondPermission({
            optionId: "approved",
            requestId: "request-1",
            sessionId: "waiting-session",
        });

        expect(respondPermission).toHaveBeenCalledWith({
            optionId: "approved",
            requestId: "request-1",
            sessionId: "waiting-session",
        });

        blocker.resolve(createSnapshot({ sessionId: "blocked-session" }));
        await preparePromise;
    });

    it("freezes the least recently used idle session outside the hot-session budget", async () => {
        const prepareSession = vi.fn<AiWorkerGateway["prepareSession"]>(
            ({ input }) =>
                Promise.resolve(createSnapshot({ sessionId: input.sessionId })),
        );
        const freezeSession = vi.fn<AiWorkerGateway["freezeSession"]>(() =>
            Promise.resolve({
                frozen: true,
                reason: "budget",
                sessionId: "session-1",
            }),
        );
        const service = createService({
            aiSessionRetention: {
                maxHotSessionsPerWindow: 1,
            },
            aiWorker: createMockWorker({
                freezeSession,
                prepareSession,
            }),
        });

        await service.prepareSession(
            {
                projectId: "project-1",
                runtimeId: "codex",
                sessionId: "session-1",
                title: "Session 1",
                worktreeId: null,
            },
            "window-1",
        );
        await service.prepareSession(
            {
                projectId: "project-1",
                runtimeId: "codex",
                sessionId: "session-2",
                title: "Session 2",
                worktreeId: null,
            },
            "window-1",
        );

        await vi.waitFor(() => {
            expect(freezeSession).toHaveBeenCalledWith({
                reason: "budget",
                sessionId: "session-1",
            });
        });
        expect(service.getSessionRetentionDiagnostics()).toMatchObject({
            closed: [
                {
                    reason: "budget",
                    sessionId: "session-1",
                },
            ],
        });
    });

    it("freezes an idle session when the TTL elapses without another action", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-04-16T00:00:00.000Z"));
        let service: ReturnType<typeof createService> | null = null;

        try {
            const prepareSession = vi.fn<AiWorkerGateway["prepareSession"]>(
                ({ input }) =>
                    Promise.resolve(
                        createSnapshot({ sessionId: input.sessionId }),
                    ),
            );
            const freezeSession = vi.fn<AiWorkerGateway["freezeSession"]>(
                ({ sessionId, reason }) =>
                    Promise.resolve({
                        frozen: true,
                        reason,
                        sessionId,
                    }),
            );
            service = createService({
                aiSessionRetention: {
                    idleTtlMs: 1_000,
                    maxHotSessionsPerWindow: 10,
                },
                aiWorker: createMockWorker({
                    freezeSession,
                    prepareSession,
                }),
            });

            await service.prepareSession(
                {
                    projectId: "project-1",
                    runtimeId: "codex",
                    sessionId: "session-ttl",
                    title: "Session TTL",
                    worktreeId: null,
                },
                "window-1",
            );

            await vi.advanceTimersByTimeAsync(999);
            expect(freezeSession).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(1);
            await vi.waitFor(() => {
                expect(freezeSession).toHaveBeenCalledWith({
                    reason: "ttl",
                    sessionId: "session-ttl",
                });
            });
            expect(service.getSessionRetentionDiagnostics()).toMatchObject({
                closed: [
                    {
                        reason: "ttl",
                        sessionId: "session-ttl",
                    },
                ],
            });
        } finally {
            service?.close();
            vi.useRealTimers();
        }
    });

    it("keeps a recently focused session hot when applying the LRU budget", async () => {
        const prepareSession = vi.fn<AiWorkerGateway["prepareSession"]>(
            ({ input }) =>
                Promise.resolve(createSnapshot({ sessionId: input.sessionId })),
        );
        const freezeSession = vi.fn<AiWorkerGateway["freezeSession"]>(
            ({ sessionId, reason }) =>
                Promise.resolve({
                    frozen: true,
                    reason,
                    sessionId,
                }),
        );
        const service = createService({
            aiSessionRetention: {
                maxHotSessionsPerWindow: 2,
            },
            aiWorker: createMockWorker({
                freezeSession,
                prepareSession,
            }),
        });

        await service.prepareSession(
            {
                projectId: "project-1",
                runtimeId: "codex",
                sessionId: "session-1",
                title: "Session 1",
                worktreeId: null,
            },
            "window-1",
        );
        await service.prepareSession(
            {
                projectId: "project-1",
                runtimeId: "codex",
                sessionId: "session-2",
                title: "Session 2",
                worktreeId: null,
            },
            "window-1",
        );
        await service.prepareSession(
            {
                projectId: "project-1",
                runtimeId: "codex",
                sessionId: "session-1",
                title: "Session 1",
                worktreeId: null,
            },
            "window-1",
        );
        await service.prepareSession(
            {
                projectId: "project-1",
                runtimeId: "codex",
                sessionId: "session-3",
                title: "Session 3",
                worktreeId: null,
            },
            "window-1",
        );

        await vi.waitFor(() => {
            expect(freezeSession).toHaveBeenCalledWith({
                reason: "budget",
                sessionId: "session-2",
            });
        });
        expect(freezeSession).not.toHaveBeenCalledWith({
            reason: "budget",
            sessionId: "session-1",
        });
    });

    it("does not freeze sessions with pending review state", async () => {
        const trackedFile = {
            hunks: [],
            identityKey: "src/app.ts",
            isText: true,
            kind: "update",
            newText: "after",
            oldText: "before",
            path: "src/app.ts",
            previousPath: null,
            reviewState: "pending",
            reversible: true,
            sessionId: "session-1",
            toolCallId: null,
            updatedAt: "2026-04-16T00:00:00.000Z",
        } satisfies AiTrackedFile;
        const prepareSession = vi.fn<AiWorkerGateway["prepareSession"]>(
            ({ input }) =>
                Promise.resolve(
                    createSnapshot({
                        sessionId: input.sessionId,
                        trackedFiles:
                            input.sessionId === "session-1"
                                ? [trackedFile]
                                : [],
                    }),
                ),
        );
        const freezeSession = vi.fn<AiWorkerGateway["freezeSession"]>(
            ({ sessionId, reason }) =>
                Promise.resolve({
                    frozen: true,
                    reason,
                    sessionId,
                }),
        );
        const service = createService({
            aiSessionRetention: {
                maxHotSessionsPerWindow: 1,
            },
            aiWorker: createMockWorker({
                freezeSession,
                prepareSession,
            }),
        });

        await service.prepareSession(
            {
                projectId: "project-1",
                runtimeId: "codex",
                sessionId: "session-1",
                title: "Session 1",
                worktreeId: null,
            },
            "window-1",
        );
        await service.prepareSession(
            {
                projectId: "project-1",
                runtimeId: "codex",
                sessionId: "session-2",
                title: "Session 2",
                worktreeId: null,
            },
            "window-1",
        );

        await vi.waitFor(() => {
            expect(service.getSessionRetentionDiagnostics().skipped).toEqual([
                expect.objectContaining({
                    reason: "budget",
                    sessionId: "session-1",
                    skippedReason: "pending_review",
                }),
            ]);
        });
        expect(freezeSession).not.toHaveBeenCalledWith({
            reason: "budget",
            sessionId: "session-1",
        });
    });

    it("does not start a queued cold start after its owner window closes", async () => {
        const starts = new Map<
            string,
            ReturnType<typeof createDeferred<AiSessionSnapshot>>
        >();
        const prepareSession = vi.fn<AiWorkerGateway["prepareSession"]>(
            ({ input }) => {
                const deferred = createDeferred<AiSessionSnapshot>();
                starts.set(input.sessionId, deferred);
                return deferred.promise;
            },
        );
        const closeOwnedByWindow = vi.fn(() => Promise.resolve());
        const service = createService({
            aiScheduler: {
                maxColdStartsGlobal: 1,
                maxColdStartsPerRuntime: 1,
            },
            aiWorker: createMockWorker({
                closeOwnedByWindow,
                prepareSession,
            }),
        });

        const firstPrepare = service.prepareSession(
            {
                projectId: "project-1",
                runtimeId: "codex",
                sessionId: "session-1",
                title: "Session 1",
                worktreeId: null,
            },
            "window-1",
        );
        await vi.waitFor(() => {
            expect(prepareSession).toHaveBeenCalledTimes(1);
        });

        const queuedPrepare = service.prepareSession(
            {
                projectId: "project-1",
                runtimeId: "codex",
                sessionId: "session-2",
                title: "Session 2",
                worktreeId: null,
            },
            "window-1",
        );
        await vi.waitFor(() => {
            expect(service.getSchedulerDiagnostics().queued).toBe(1);
        });

        service.closeOwnedByWindow("window-1");
        starts
            .get("session-1")
            ?.resolve(createSnapshot({ sessionId: "session-1" }));

        await firstPrepare;
        await expect(queuedPrepare).rejects.toThrow(
            "The AI session is no longer open.",
        );
        expect(closeOwnedByWindow).toHaveBeenCalledWith("window-1");
        expect(prepareSession).toHaveBeenCalledTimes(1);
    });

    it("re-enforces the hot-session budget after pending review is resolved", async () => {
        const trackedFile = {
            hunks: [],
            identityKey: "src/app.ts",
            isText: true,
            kind: "update",
            newText: "after",
            oldText: "before",
            path: "src/app.ts",
            previousPath: null,
            reviewState: "pending",
            reversible: true,
            sessionId: "session-1",
            toolCallId: null,
            updatedAt: "2026-04-16T00:00:00.000Z",
        } satisfies AiTrackedFile;
        const prepareSession = vi.fn<AiWorkerGateway["prepareSession"]>(
            ({ input }) =>
                Promise.resolve(
                    createSnapshot({
                        sessionId: input.sessionId,
                        trackedFiles:
                            input.sessionId === "session-1"
                                ? [trackedFile]
                                : [],
                    }),
                ),
        );
        const freezeSession = vi.fn<AiWorkerGateway["freezeSession"]>(
            ({ sessionId, reason }) =>
                Promise.resolve({
                    frozen: true,
                    reason,
                    sessionId,
                }),
        );
        const keepAllTrackedFiles = vi.fn<
            AiWorkerGateway["keepAllTrackedFiles"]
        >(({ context }) =>
            Promise.resolve({
                ownerWindowId: context.ownerWindowId,
                snapshot: {
                    ...context.snapshot,
                    trackedFiles: [],
                    updatedAt: "2026-04-16T00:00:01.000Z",
                },
            }),
        );
        const service = createService({
            aiSessionRetention: {
                maxHotSessionsPerWindow: 1,
            },
            aiWorker: createMockWorker({
                freezeSession,
                keepAllTrackedFiles,
                prepareSession,
            }),
        });

        await service.prepareSession(
            {
                projectId: "project-1",
                runtimeId: "codex",
                sessionId: "session-1",
                title: "Session 1",
                worktreeId: null,
            },
            "window-1",
        );
        await service.prepareSession(
            {
                projectId: "project-1",
                runtimeId: "codex",
                sessionId: "session-2",
                title: "Session 2",
                worktreeId: null,
            },
            "window-1",
        );
        await vi.waitFor(() => {
            expect(service.getSessionRetentionDiagnostics().skipped).toEqual([
                expect.objectContaining({
                    reason: "budget",
                    sessionId: "session-1",
                    skippedReason: "pending_review",
                }),
            ]);
        });

        await service.keepAllTrackedFiles("session-1");

        await vi.waitFor(() => {
            expect(freezeSession).toHaveBeenCalledWith({
                reason: "budget",
                sessionId: "session-2",
            });
        });
    });

    it("reopens a frozen session through prepare without replaying a prompt", async () => {
        const prepareSession = vi.fn<AiWorkerGateway["prepareSession"]>(
            ({ input }) =>
                Promise.resolve(createSnapshot({ sessionId: input.sessionId })),
        );
        const sendPrompt = vi.fn<AiWorkerGateway["sendPrompt"]>(() =>
            Promise.resolve({
                sessionId: "session-1",
                stopReason: "completed",
            }),
        );
        const freezeSession = vi.fn<AiWorkerGateway["freezeSession"]>(
            ({ sessionId, reason }) =>
                Promise.resolve({
                    frozen: true,
                    reason,
                    sessionId,
                }),
        );
        const service = createService({
            aiSessionRetention: {
                maxHotSessionsPerWindow: 1,
            },
            aiWorker: createMockWorker({
                freezeSession,
                prepareSession,
                sendPrompt,
            }),
        });

        await service.prepareSession(
            {
                projectId: "project-1",
                runtimeId: "codex",
                sessionId: "session-1",
                title: "Session 1",
                worktreeId: null,
            },
            "window-1",
        );
        await service.prepareSession(
            {
                projectId: "project-1",
                runtimeId: "codex",
                sessionId: "session-2",
                title: "Session 2",
                worktreeId: null,
            },
            "window-1",
        );
        await vi.waitFor(() => {
            expect(freezeSession).toHaveBeenCalledWith({
                reason: "budget",
                sessionId: "session-1",
            });
        });

        await service.prepareSession(
            {
                projectId: "project-1",
                runtimeId: "codex",
                sessionId: "session-1",
                title: "Session 1",
                worktreeId: null,
            },
            "window-1",
        );

        expect(prepareSession).toHaveBeenCalledTimes(3);
        expect(sendPrompt).not.toHaveBeenCalled();
    });
});

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });

    return { promise, resolve };
}

function createMockWorker(overrides: Record<string, unknown> = {}) {
    return {
        cancelSession: vi.fn(),
        close: vi.fn(),
        closeOwnedByWindow: vi.fn(),
        closeSession: vi.fn(),
        freezeSession: vi.fn(),
        keepAllTrackedFiles: vi.fn(),
        keepTrackedFile: vi.fn(),
        keepTrackedFileHunks: vi.fn(),
        notifyFileBuffer: vi.fn(),
        prepareSession: vi.fn(),
        rejectAllTrackedFiles: vi.fn(),
        rejectTrackedFile: vi.fn(),
        rejectTrackedFileHunks: vi.fn(),
        refreshProjectScopes: vi.fn(),
        respondPermission: vi.fn(),
        respondUserInput: vi.fn(),
        sendPrompt: vi.fn(),
        setSessionConfigOption: vi.fn(),
        setSessionMode: vi.fn(),
        setSessionModel: vi.fn(),
        ...overrides,
    };
}

function createService(overrides: {
    readonly aiWorker?: object;
    readonly aiScheduler?: {
        readonly maxColdStartsGlobal?: number;
        readonly maxColdStartsPerRuntime?: number;
    };
    readonly aiSessionRetention?: {
        readonly idleTtlMs?: number;
        readonly maxHotSessionsPerWindow?: number;
    };
    readonly loadSessionSnapshot?: ReturnType<typeof vi.fn>;
    readonly onSessionSnapshot?: (
        ownerWindowId: string,
        update: AiSessionUpdate,
    ) => void;
    readonly projectRoot?: string;
    readonly saveSessionSnapshot?: ReturnType<typeof vi.fn>;
} = {}) {
    return new AiService({
        aiWorker: overrides.aiWorker as never,
        aiScheduler: overrides.aiScheduler,
        aiSessionRetention: overrides.aiSessionRetention,
        onRuntimeStatus: vi.fn(),
        onSessionSnapshot: overrides.onSessionSnapshot ?? vi.fn(),
        persistence: {
            loadLatestRuntimeCatalog: vi.fn(() => null),
            loadRuntimeSelectionPreferences: vi.fn(() => ({
                configOptions: {},
                modeId: null,
                modelId: null,
            })),
            loadSessionSnapshot:
                overrides.loadSessionSnapshot ?? vi.fn(() => null),
            saveRuntimeSelectionPreferenceOption: vi.fn(),
            saveRuntimeModePreference: vi.fn(),
            saveRuntimeModelPreference: vi.fn(),
            saveSessionSnapshot: overrides.saveSessionSnapshot ?? vi.fn(),
        } as never,
        projectService: {
            getProjectRootPath: vi.fn(
                () => overrides.projectRoot ?? process.cwd(),
            ),
            listProjectWorktrees: vi.fn(() => []),
        } as never,
        secretStore: {
            loadSecret: vi.fn(() => null),
            saveSecret: vi.fn(),
        },
        settingsService: {
            loadClaudeRuntimeSettings: vi.fn(() => ({
                authInvalidatedAtMs: null,
                authMethod: null,
                binaryPath: null,
                gatewayBaseUrl: null,
                hasGatewayAuthToken: false,
                hasGatewayCustomHeaders: false,
            })),
            loadCodexRuntimeSettings: vi.fn(() => ({
                authMethod: "chatgpt",
                binaryPath: null,
                hasCodexApiKey: false,
                hasOpenAiApiKey: false,
            })),
            loadGeminiRuntimeSettings: vi.fn(() => ({
                authInvalidatedAtMs: null,
                authMethod: null,
                binaryPath: null,
                googleCloudLocation: null,
                googleCloudProject: null,
                hasGeminiApiKey: false,
                hasGoogleApiKey: false,
            })),
            loadKiloRuntimeSettings: vi.fn(() => ({
                authInvalidatedAtMs: null,
                binaryPath: null,
            })),
            saveClaudeRuntimeSettings: vi.fn(),
            saveCodexRuntimeSettings: vi.fn(),
            saveGeminiRuntimeSettings: vi.fn(),
            saveKiloRuntimeSettings: vi.fn(),
        } as never,
    });
}

function createSnapshot(
    overrides: Partial<AiSessionSnapshot> & { readonly sessionId: string },
): AiSessionSnapshot {
    const { sessionId, ...rest } = overrides;
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
        projectId: null,
        runtimeId: "codex",
        runtimeSessionId: "runtime-session-1",
        sessionId,
        status: "idle",
        title: "Session",
        tokenUsage: null,
        toolActivity: [],
        trackedFiles: [],
        updatedAt: "2026-04-16T00:00:00.000Z",
        worktreeId: null,
        ...rest,
    };
}
