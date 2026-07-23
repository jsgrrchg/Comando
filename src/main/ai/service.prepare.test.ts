import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    AiRuntimeStatus,
    AiSessionConfigOption,
    AiSessionSnapshot,
    AiSessionUpdate,
    AiTrackedFile,
} from "@shared/ipc";

import type { NativeAiGateway } from "./contracts";
import { NativeBackendError } from "../native-backend/client";

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

const { AiService } = await import("./service");

describe("AiService prepareSession", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("delegates session startup to the native AI backend with a resolved launch payload", async () => {
        const persistedSnapshot: AiSessionSnapshot = {
            availableCommands: [],
            configOptions: [],
            lastError: "stale error",
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
            manualTitle: "Manual title",
            title: "Codex 1",
            tokenUsage: null,
            toolActivity: [],
            trackedFiles: [],
            updatedAt: "2026-04-15T22:23:13.719838Z",
            worktreeId: null,
        };
        const nativeSnapshot: AiSessionSnapshot = {
            ...persistedSnapshot,
            lastError: null,
            status: "idle",
            updatedAt: "2026-04-16T00:00:00.000Z",
        };
        const prepareSession = vi.fn<NativeAiGateway["prepareSession"]>(() =>
            Promise.resolve(nativeSnapshot),
        );
        const loadSessionSnapshot = vi.fn<NativeAiGateway["loadSessionSnapshot"]>(
            () => Promise.resolve(persistedSnapshot),
        );
        const renameSession = vi.fn(() => Promise.resolve());
        const nativeAi = createNativeAi({
            loadSessionSnapshot,
            prepareSession,
            renameSession,
        });
        const runtimeStatusEvents: AiRuntimeStatus[] = [];
        const saveSessionSnapshot = vi.fn();
        const service = new AiService({
            nativeAi,
            onRuntimeStatus: (status) => runtimeStatusEvents.push(status),
            onSessionSnapshot: vi.fn(),
            persistence: {
                loadLatestRuntimeCatalog: vi.fn(() => null),
                loadRuntimeSelectionPreferences: vi.fn(() => ({
                    configOptions: {},
                    modeId: null,
                    modelId: null,
                })),
                loadSessionSnapshot: vi.fn(() => persistedSnapshot),
                saveRuntimeSelectionPreferenceOption: vi.fn(),
                saveRuntimeModePreference: vi.fn(),
                saveRuntimeModelPreference: vi.fn(),
                saveSessionSnapshot,
            } as never,
            projectService: {
                getProjectRootPath: vi.fn(() => process.cwd()),
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
                loadKiloRuntimeSettings: vi.fn(() => ({
                    authInvalidatedAtMs: null,
                    binaryPath: null,
                })),
                saveClaudeRuntimeSettings: vi.fn(),
                saveCodexRuntimeSettings: vi.fn(),
                saveKiloRuntimeSettings: vi.fn(),
            } as never,
        });

        const snapshot = await service.prepareSession(
            {
                projectId: null,
                runtimeId: "codex",
                sessionId: "session-1",
                title: "Manual title",
                worktreeId: null,
            },
            "window-1",
        );

        expect(snapshot).toBe(nativeSnapshot);
        const [prepareSessionInput] = prepareSession.mock.calls[0] ?? [];
        expect(prepareSessionInput?.input).toEqual({
            projectId: null,
            runtimeId: "codex",
            sessionId: "session-1",
            title: "Codex 1",
            worktreeId: null,
        });
        expect(prepareSessionInput?.launch).toMatchObject({
            additionalRoots: [],
            cwd: process.cwd(),
            input: {
                additionalRoots: [],
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
                command: "mock-codex-acp",
                executable: "mock-codex-acp",
                status: readyStatus,
            },
        });
        expect(saveSessionSnapshot).not.toHaveBeenCalled();
        expect(runtimeStatusEvents.at(-1)).toEqual(readyStatus);
    });

    it("prepares and dispatches a queued prompt from persisted history", async () => {
        const persistedSnapshot = createSnapshot({
            runtimeSessionId: "runtime-session-history",
            sessionId: "session-history",
            title: "Saved chat",
        });
        const prepareSession = vi.fn<NativeAiGateway["prepareSession"]>(
            ({ launch }) =>
                Promise.resolve({
                    ...launch.persistedSnapshot,
                    runtimeSessionId: "runtime-session-history",
                    status: "idle",
                }),
        );
        const sendPrompt = vi.fn<NativeAiGateway["sendPrompt"]>(({ input }) =>
            Promise.resolve({
                sessionId: input.sessionId,
                stopReason: "accepted",
            }),
        );
        const service = createPrepareService({
            nativeAi: createNativeAi({
                captureReviewBaseline: vi.fn(() => Promise.resolve(true)),
                loadSessionSnapshot: vi.fn(() =>
                    Promise.resolve(persistedSnapshot),
                ),
                prepareSession,
                sendPrompt,
            }),
        });

        service.enqueuePrompt(
            {
                attachments: [],
                composerParts: [{ text: "Continue.", type: "text" }],
                fileContextsSnapshot: [],
                messageId: "message-history-1",
                projectId: null,
                prompt: "Continue.",
                runtimeId: "codex",
                sessionId: "session-history",
                title: "Saved chat",
                worktreeId: null,
            },
            "window-1",
        );

        await vi.waitFor(() => {
            const queue = service.getPromptQueue(
                "session-history",
                "window-1",
            );
            expect(queue.activeItem?.status ?? queue.items[0]?.error).toBe(
                "running",
            );
        });

        expect(sendPrompt).toHaveBeenCalledTimes(1);
        expect(prepareSession).toHaveBeenCalledTimes(1);
        expect(sendPrompt.mock.calls[0]?.[0]).toMatchObject({
            input: {
                messageId: "message-history-1",
                sessionId: "session-history",
            },
            launch: {
                ownerWindowId: "window-1",
                persistedSnapshot,
            },
        });
        expect(
            service.getPromptQueue("session-history", "window-1"),
        ).toMatchObject({
            activeItem: {
                messageId: "message-history-1",
                status: "running",
            },
            items: [],
            paused: false,
        });
    });

    it("reopens a session frozen by retention and dispatches its first queued prompt", async () => {
        const persistedSnapshot = createSnapshot({
            runtimeSessionId: "runtime-session-retained",
            sessionId: "session-retained",
            title: "Retained chat",
        });
        let releaseClose!: () => void;
        const closeSession = vi.fn<NativeAiGateway["closeSession"]>(() =>
            new Promise<void>((resolve) => {
                releaseClose = resolve;
            }),
        );
        const prepareSession = vi
            .fn<NativeAiGateway["prepareSession"]>()
            .mockImplementation(({ launch }) =>
                Promise.resolve({
                    ...launch.persistedSnapshot,
                    runtimeSessionId: `runtime-${prepareSession.mock.calls.length}`,
                    status:
                        prepareSession.mock.calls.length === 1
                            ? "idle"
                            : "streaming",
                }),
            );
        const sendPrompt = vi.fn<NativeAiGateway["sendPrompt"]>(
            ({ input }) =>
                Promise.resolve({
                    sessionId: input.sessionId,
                    stopReason: "accepted",
                }),
        );
        const service = createPrepareService({
            aiSessionRetention: {
                idleTtlMs: -1,
                maxHotSessionsPerWindow: 0,
            },
            nativeAi: createNativeAi({
                closeSession,
                loadSessionSnapshot: vi.fn(() =>
                    Promise.resolve(persistedSnapshot),
                ),
                prepareSession,
                sendPrompt,
            }),
        });

        await service.prepareSession(
            {
                projectId: null,
                runtimeId: "codex",
                sessionId: "session-retained",
                title: "Retained chat",
                worktreeId: null,
            },
            "window-1",
        );
        await vi.waitFor(() => expect(closeSession).toHaveBeenCalledTimes(1));

        // Retention's close event used to terminalize this existing queue.
        service.getPromptQueue("session-retained", "window-1");
        service.handleNativeSessionEvent("window-1", {
            closedAt: "2026-07-13T00:00:01.000Z",
            kind: "session-closed",
            origin: "live",
            parentSessionId: null,
            runtimeId: "codex",
            runtimeSessionId: "runtime-1",
            sessionId: "session-retained",
            updatedAt: "2026-07-13T00:00:01.000Z",
        });
        releaseClose();

        service.enqueuePrompt(
            {
                attachments: [],
                composerParts: [{ text: "Continue.", type: "text" }],
                fileContextsSnapshot: [],
                messageId: "message-retained-1",
                projectId: null,
                prompt: "Continue.",
                runtimeId: "codex",
                sessionId: "session-retained",
                title: "Retained chat",
                worktreeId: null,
            },
            "window-1",
        );

        await vi.waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1));
        expect(prepareSession).toHaveBeenCalledTimes(2);
        expect(sendPrompt.mock.calls[0]?.[0].input).toMatchObject({
            messageId: "message-retained-1",
            sessionId: "session-retained",
        });
    });

    it("ignores a retained runtime close event that arrives after reopening", async () => {
        const persistedSnapshot = createSnapshot({
            runtimeSessionId: "runtime-session-retained",
            sessionId: "session-retained-late-close",
            title: "Retained chat",
        });
        const closeSession = vi.fn<NativeAiGateway["closeSession"]>(() =>
            Promise.resolve(),
        );
        const prepareSession = vi
            .fn<NativeAiGateway["prepareSession"]>()
            .mockImplementation(({ launch }) =>
                Promise.resolve({
                    ...launch.persistedSnapshot,
                    runtimeSessionId: `runtime-${prepareSession.mock.calls.length}`,
                    status:
                        prepareSession.mock.calls.length === 1
                            ? "idle"
                            : "streaming",
                }),
            );
        const sendPrompt = vi.fn<NativeAiGateway["sendPrompt"]>(({ input }) =>
            Promise.resolve({
                sessionId: input.sessionId,
                stopReason: "accepted",
            }),
        );
        const service = createPrepareService({
            aiSessionRetention: {
                idleTtlMs: -1,
                maxHotSessionsPerWindow: 0,
            },
            nativeAi: createNativeAi({
                closeSession,
                loadSessionSnapshot: vi.fn(() =>
                    Promise.resolve(persistedSnapshot),
                ),
                prepareSession,
                sendPrompt,
            }),
        });

        await service.prepareSession(
            {
                projectId: null,
                runtimeId: "codex",
                sessionId: "session-retained-late-close",
                title: "Retained chat",
                worktreeId: null,
            },
            "window-1",
        );
        await vi.waitFor(() => expect(closeSession).toHaveBeenCalledTimes(1));

        service.enqueuePrompt(
            {
                attachments: [],
                composerParts: [{ text: "Continue.", type: "text" }],
                fileContextsSnapshot: [],
                messageId: "message-retained-late-close-1",
                projectId: null,
                prompt: "Continue.",
                runtimeId: "codex",
                sessionId: "session-retained-late-close",
                title: "Retained chat",
                worktreeId: null,
            },
            "window-1",
        );
        await vi.waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1));

        service.handleNativeSessionEvent("window-1", {
            closedAt: "2026-07-13T00:00:01.000Z",
            kind: "session-closed",
            origin: "live",
            parentSessionId: null,
            runtimeId: "codex",
            runtimeSessionId: "runtime-1",
            sessionId: "session-retained-late-close",
            updatedAt: "2026-07-13T00:00:01.000Z",
        });

        expect(
            service.getPromptQueue("session-retained-late-close", "window-1"),
        ).toMatchObject({
            activeItem: {
                messageId: "message-retained-late-close-1",
                status: "running",
            },
            items: [],
            paused: false,
        });
    });

    it("reprepares and retries a prompt once when the runtime evicts its session", async () => {
        const snapshot = createSnapshot({
            runtimeSessionId: "runtime-session-1",
            sessionId: "session-retry",
            title: "Retry chat",
        });
        const prepareSession = vi
            .fn<NativeAiGateway["prepareSession"]>()
            .mockResolvedValueOnce(snapshot)
            .mockResolvedValueOnce({
                ...snapshot,
                runtimeSessionId: "runtime-session-2",
            });
        const sendPrompt = vi
            .fn<NativeAiGateway["sendPrompt"]>()
            .mockRejectedValueOnce(
                new NativeBackendError({
                    code: "ai_session_not_found",
                    details: null,
                    message: "The AI session was not found.",
                    retryable: false,
                }),
            )
            .mockResolvedValueOnce({
                sessionId: "session-retry",
                stopReason: "accepted",
            });
        const service = createPrepareService({
            nativeAi: createNativeAi({ prepareSession, sendPrompt }),
        });

        await service.prepareSession(
            {
                projectId: null,
                runtimeId: "codex",
                sessionId: "session-retry",
                title: "Retry chat",
                worktreeId: null,
            },
            "window-1",
        );
        await service.sendPrompt(
            {
                attachments: [],
                composerParts: [{ text: "Retry this.", type: "text" }],
                messageId: "message-retry-1",
                projectId: null,
                prompt: "Retry this.",
                runtimeId: "codex",
                sessionId: "session-retry",
                title: "Retry chat",
                worktreeId: null,
            },
            "window-1",
        );

        expect(prepareSession).toHaveBeenCalledTimes(2);
        expect(sendPrompt).toHaveBeenCalledTimes(2);
        expect(
            sendPrompt.mock.calls.map(
                ([request]) => request.input.messageId,
            ),
        ).toEqual(["message-retry-1", "message-retry-1"]);
    });

    it("reprepares the root before retrying an evicted subagent prompt", async () => {
        const parentSnapshot = createSnapshot({
            runtimeSessionId: "runtime-parent-1",
            sessionId: "session-parent",
            title: "Parent chat",
        });
        const childSnapshot = createSnapshot({
            parentSessionId: "session-parent",
            runtimeSessionId: "runtime-child-1",
            sessionId: "session-child",
            title: "Child chat",
        });
        const loadSessionSnapshot = vi.fn<NativeAiGateway["loadSessionSnapshot"]>(
            (sessionId) =>
                Promise.resolve(
                    sessionId === "session-child"
                        ? childSnapshot
                        : parentSnapshot,
                ),
        );
        const prepareSession = vi
            .fn<NativeAiGateway["prepareSession"]>()
            .mockResolvedValueOnce(parentSnapshot)
            .mockResolvedValueOnce({
                ...parentSnapshot,
                runtimeSessionId: "runtime-parent-2",
            });
        const sendPrompt = vi
            .fn<NativeAiGateway["sendPrompt"]>()
            .mockRejectedValueOnce(
                new NativeBackendError({
                    code: "ai_session_not_found",
                    details: null,
                    message: "The AI session was not found.",
                    retryable: false,
                }),
            )
            .mockResolvedValueOnce({
                sessionId: "session-child",
                stopReason: "accepted",
            });
        const service = createPrepareService({
            nativeAi: createNativeAi({
                loadSessionSnapshot,
                prepareSession,
                sendPrompt,
            }),
        });

        await service.prepareSession(
            {
                projectId: null,
                runtimeId: "codex",
                sessionId: "session-child",
                title: "Child chat",
                worktreeId: null,
            },
            "window-1",
        );
        await service.sendPrompt(
            {
                attachments: [],
                composerParts: [{ text: "Continue.", type: "text" }],
                messageId: "message-child-retry-1",
                projectId: null,
                prompt: "Continue.",
                runtimeId: "codex",
                sessionId: "session-child",
                title: "Child chat",
                worktreeId: null,
            },
            "window-1",
        );

        expect(prepareSession).toHaveBeenCalledTimes(2);
        expect(
            prepareSession.mock.calls.map(
                ([request]) => request.input.sessionId,
            ),
        ).toEqual(["session-parent", "session-parent"]);
        expect(sendPrompt).toHaveBeenCalledTimes(2);
        expect(
            sendPrompt.mock.calls[1]?.[0].launch.persistedSnapshot.sessionId,
        ).toBe("session-child");
    });

    it("hydrates newly prepared native sessions with persisted ACP catalog controls", async () => {
        const nativeSnapshot: AiSessionSnapshot = {
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
            updatedAt: "2026-04-16T00:00:00.000Z",
            worktreeId: null,
        };
        const runtimeCatalog = {
            availableCommands: [
                {
                    description: "Review changes",
                    id: "review",
                    insertText: "/review ",
                    label: "/review",
                },
            ],
            configOptions: [
                {
                    category: "model",
                    description: null,
                    id: "model",
                    label: "Model",
                    options: [
                        {
                            description: null,
                            groupLabel: null,
                            label: "GPT-5.5",
                            value: "gpt-5.5",
                        },
                    ],
                    type: "select",
                    value: "gpt-5.5",
                },
            ],
            modeId: "full-access",
            modes: [
                {
                    description: "No prompts",
                    id: "full-access",
                    name: "Full Access",
                },
            ],
            modelId: "gpt-5.5",
            models: [
                {
                    description: "Frontier model",
                    id: "gpt-5.5",
                    name: "GPT-5.5",
                },
            ],
        } satisfies Pick<
            AiSessionSnapshot,
            | "availableCommands"
            | "configOptions"
            | "modeId"
            | "modes"
            | "modelId"
            | "models"
        >;
        const prepareSession = vi.fn<NativeAiGateway["prepareSession"]>(() =>
            Promise.resolve(nativeSnapshot),
        );
        const service = new AiService({
            nativeAi: createNativeAi({ prepareSession }),
            onRuntimeStatus: vi.fn(),
            onSessionSnapshot: vi.fn(),
            persistence: {
                loadLatestRuntimeCatalog: vi.fn(() => runtimeCatalog),
                loadRuntimeSelectionPreferences: vi.fn(() => ({
                    configOptions: {},
                    modeId: null,
                    modelId: null,
                })),
                loadSessionSnapshot: vi.fn(() => null),
                saveRuntimeSelectionPreferenceOption: vi.fn(),
                saveRuntimeModePreference: vi.fn(),
                saveRuntimeModelPreference: vi.fn(),
                saveSessionSnapshot: vi.fn(),
            } as never,
            projectService: {
                getProjectRootPath: vi.fn(() => process.cwd()),
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
                loadKiloRuntimeSettings: vi.fn(() => ({
                    authInvalidatedAtMs: null,
                    binaryPath: null,
                })),
                saveClaudeRuntimeSettings: vi.fn(),
                saveCodexRuntimeSettings: vi.fn(),
                saveKiloRuntimeSettings: vi.fn(),
            } as never,
        });

        const snapshot = await service.prepareSession(
            {
                projectId: null,
                runtimeId: "codex",
                sessionId: "session-1",
                title: "Codex 1",
                worktreeId: null,
            },
            "window-1",
        );

        expect(snapshot).toMatchObject({
            availableCommands: runtimeCatalog.availableCommands,
            configOptions: runtimeCatalog.configOptions,
            modeId: "full-access",
            modes: runtimeCatalog.modes,
            modelId: "gpt-5.5",
            models: runtimeCatalog.models,
            sessionId: "session-1",
        });
        expect(prepareSession.mock.calls[0]?.[0].launch.persistedSnapshot).toMatchObject({
            configOptions: runtimeCatalog.configOptions,
            modelId: "gpt-5.5",
        });
    });

    it("projects saved selections over the persisted runtime catalog", async () => {
        const runtimeCatalog = {
            availableCommands: [],
            configOptions: [
                createModelConfig("gpt-5.4-mini"),
                createReasoningConfig("low"),
            ],
            modeId: "default",
            modes: [
                {
                    description: null,
                    id: "default",
                    name: "Default",
                },
                {
                    description: null,
                    id: "full-access",
                    name: "Full Access",
                },
            ],
            modelId: "gpt-5.4-mini",
            models: [
                {
                    description: null,
                    id: "gpt-5.4-mini",
                    name: "GPT 5.4 Mini",
                },
                {
                    description: null,
                    id: "gpt-5.5",
                    name: "GPT 5.5",
                },
            ],
        };
        const service = createPrepareService({
            nativeAi: createNativeAi({
                getRuntimeStatus: vi.fn(() => Promise.resolve(readyStatus)),
            }),
            persistence: {
                loadLatestRuntimeCatalog: vi.fn(() => runtimeCatalog),
                loadRuntimeSelectionPreferences: vi.fn(() => ({
                    configOptions: {
                        model: "gpt-5.5",
                        reasoning_effort: "high",
                    },
                    modeId: "full-access",
                    modelId: "gpt-5.5",
                })),
                loadSessionSnapshot: vi.fn(() => null),
                saveRuntimeSelectionPreferenceOption: vi.fn(),
                saveRuntimeModePreference: vi.fn(),
                saveRuntimeModelPreference: vi.fn(),
                saveSessionSnapshot: vi.fn(),
            } as never,
        });

        const status = await service.getRuntimeStatus("codex");

        expect(status).toMatchObject({
            modeId: "full-access",
            modelId: "gpt-5.5",
        });
        expect(
            status.configOptions?.find((option) => option.id === "model")
                ?.value,
        ).toBe("gpt-5.5");
        expect(
            status.configOptions?.find(
                (option) => option.id === "reasoning_effort",
            )?.value,
        ).toBe("high");
    });

    it("normalizes restored active snapshots before native startup", async () => {
        const persistedSnapshot = createSnapshot({
            activeTurnStartedAt: "2026-04-15T22:23:13.000Z",
            messages: [
                {
                    attachments: [],
                    content: "partial response",
                    createdAt: "2026-04-15T22:23:14.000Z",
                    id: "assistant-1",
                    kind: "assistant",
                    status: "streaming",
                },
            ],
            pendingPermission: {
                options: [],
                requestId: "permission-1",
                sessionId: "session-1",
                title: "Run command",
                toolCallId: "tool-1",
            } as never,
            runtimeSessionId: "runtime-session-1",
            status: "streaming",
            toolActivity: [
                {
                    createdAt: "2026-04-15T22:23:15.000Z",
                    diffs: [],
                    exitCode: null,
                    id: "tool-1",
                    kind: "shell",
                    locations: [],
                    rawInputJson: null,
                    rawOutputJson: null,
                    sessionId: "session-1",
                    status: "in_progress",
                    summary: null,
                    terminalOutput: null,
                    title: "Run command",
                    updatedAt: "2026-04-15T22:23:16.000Z",
                },
            ],
        });
        const loadSessionSnapshot = vi.fn<NativeAiGateway["loadSessionSnapshot"]>(
            () => Promise.resolve(persistedSnapshot),
        );
        const prepareSession = vi.fn<NativeAiGateway["prepareSession"]>(
            ({ launch }) =>
                Promise.resolve({
                    ...launch.persistedSnapshot,
                    runtimeSessionId: "runtime-session-1",
                    updatedAt: "2026-04-16T00:00:00.000Z",
                }),
        );
        const service = createPrepareService({
            nativeAi: createNativeAi({
                loadSessionSnapshot,
                prepareSession,
            }),
        });

        const snapshot = await service.prepareSession(
            {
                projectId: null,
                runtimeId: "codex",
                sessionId: "session-1",
                title: "Codex 1",
                worktreeId: null,
            },
            "window-1",
        );

        const launchSnapshot =
            prepareSession.mock.calls[0]?.[0].launch.persistedSnapshot;
        expect(launchSnapshot).toMatchObject({
            activeTurnStartedAt: null,
            pendingPermission: null,
            pendingUserInput: null,
            status: "idle",
        });
        expect(launchSnapshot?.messages[0]?.status).toBe("completed");
        expect(launchSnapshot?.toolActivity[0]?.status).toBe("failed");
        expect(snapshot.status).toBe("idle");
        expect(snapshot.activeTurnStartedAt).toBeNull();
    });

    it("adopts restored active subagent snapshots as idle on cold prepare", async () => {
        const parentSnapshot = createSnapshot({
            runtimeSessionId: "parent-runtime-session",
            sessionId: "parent-session",
            title: "Parent",
        });
        const childSnapshot = createSnapshot({
            activeTurnStartedAt: "2026-04-15T22:23:13.000Z",
            parentSessionId: "parent-session",
            runtimeSessionId: "child-runtime-session",
            sessionId: "child-session",
            status: "streaming",
            title: "Child",
        });
        const loadSessionSnapshot = vi.fn<NativeAiGateway["loadSessionSnapshot"]>(
            (sessionId) =>
                Promise.resolve(
                    sessionId === "child-session"
                        ? childSnapshot
                        : parentSnapshot,
                ),
        );
        const prepareSession = vi.fn<NativeAiGateway["prepareSession"]>(
            ({ launch }) => Promise.resolve(launch.persistedSnapshot),
        );
        const onSessionSnapshot = vi.fn<
            (ownerWindowId: string, update: AiSessionUpdate) => void
        >();
        const service = createPrepareService({
            nativeAi: createNativeAi({
                loadSessionSnapshot,
                prepareSession,
            }),
            onSessionSnapshot,
        });

        const snapshot = await service.prepareSession(
            {
                projectId: null,
                runtimeId: "codex",
                sessionId: "child-session",
                title: "Child",
                worktreeId: null,
            },
            "window-1",
        );

        expect(prepareSession.mock.calls[0]?.[0].input.sessionId).toBe(
            "parent-session",
        );
        expect(snapshot).toMatchObject({
            activeTurnStartedAt: null,
            parentSessionId: "parent-session",
            sessionId: "child-session",
            status: "idle",
        });
        const emittedUpdate = onSessionSnapshot.mock.calls[0]?.[1];
        if (emittedUpdate?.kind !== "snapshot") {
            throw new Error("Expected a snapshot update for the subagent.");
        }
        expect(onSessionSnapshot.mock.calls[0]?.[0]).toBe("window-1");
        expect(emittedUpdate.snapshot).toMatchObject({
            activeTurnStartedAt: null,
            sessionId: "child-session",
            status: "idle",
        });
    });

    it("clears the live context when native startup fails", async () => {
        const persistedSnapshot: AiSessionSnapshot = {
            availableCommands: [],
            configOptions: [],
            lastError: "stale error",
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
        const nativePrepareError = new Error("native startup failed");
        const prepareSession = vi.fn<NativeAiGateway["prepareSession"]>(() =>
            Promise.reject(nativePrepareError),
        );
        const renameSession = vi.fn(() => Promise.resolve());
        const setSessionMode = vi.fn();
        const saveSessionSnapshot = vi.fn();
        const saveRuntimeModePreference = vi.fn();
        const service = new AiService({
            nativeAi: createNativeAi({
                prepareSession,
                renameSession,
                setSessionConfigOption: vi.fn(),
                setSessionMode,
                setSessionModel: vi.fn(),
            }),
            onRuntimeStatus: vi.fn(),
            onSessionSnapshot: vi.fn(),
            persistence: {
                loadLatestRuntimeCatalog: vi.fn(() => null),
                loadRuntimeSelectionPreferences: vi.fn(() => ({
                    configOptions: {},
                    modeId: null,
                    modelId: null,
                })),
                loadSessionSnapshot: vi.fn(() => persistedSnapshot),
                saveRuntimeSelectionPreferenceOption: vi.fn(),
                saveRuntimeModePreference,
                saveRuntimeModelPreference: vi.fn(),
                saveSessionSnapshot,
            } as never,
            projectService: {
                getProjectRootPath: vi.fn(() => process.cwd()),
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
                loadKiloRuntimeSettings: vi.fn(() => ({
                    authInvalidatedAtMs: null,
                    binaryPath: null,
                })),
                saveClaudeRuntimeSettings: vi.fn(),
                saveCodexRuntimeSettings: vi.fn(),
                saveKiloRuntimeSettings: vi.fn(),
            } as never,
        });

        await expect(
            service.prepareSession(
                {
                    projectId: null,
                    runtimeId: "codex",
                    sessionId: "session-1",
                    title: "Codex 1",
                    worktreeId: null,
                },
                "window-1",
            ),
        ).rejects.toThrow(nativePrepareError);

        await service.setSessionMode({
            modeId: "agent",
            sessionId: "session-1",
        });

        expect(setSessionMode).not.toHaveBeenCalled();
        expect(saveSessionSnapshot).toHaveBeenCalledWith(
            expect.objectContaining({
                modeId: "agent",
                sessionId: "session-1",
            }),
        );
        expect(saveRuntimeModePreference).toHaveBeenCalledWith("codex", "agent");
    });

    it("routes live renames through the native backend and updates the cached snapshot", async () => {
        const snapshot: AiSessionSnapshot = {
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
            updatedAt: "2026-04-16T00:00:00.000Z",
            worktreeId: null,
        };
        const prepareSession = vi.fn<NativeAiGateway["prepareSession"]>(() =>
            Promise.resolve(snapshot),
        );
        const renameSession = vi.fn(() => Promise.resolve());
        const onSessionSnapshot = vi.fn<
            (ownerWindowId: string, update: AiSessionUpdate) => void
        >();
        const saveSessionSnapshot = vi.fn();
        const service = new AiService({
            nativeAi: createNativeAi({
                prepareSession,
                renameSession,
            }),
            onRuntimeStatus: vi.fn(),
            onSessionSnapshot,
            persistence: {
                loadLatestRuntimeCatalog: vi.fn(() => null),
                loadRuntimeSelectionPreferences: vi.fn(() => ({
                    configOptions: {},
                    modeId: null,
                    modelId: null,
                })),
                loadSessionSnapshot: vi.fn(() => snapshot),
                saveRuntimeSelectionPreferenceOption: vi.fn(),
                saveRuntimeModePreference: vi.fn(),
                saveRuntimeModelPreference: vi.fn(),
                saveSessionSnapshot,
            } as never,
            projectService: {
                getProjectRootPath: vi.fn(() => process.cwd()),
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
                loadKiloRuntimeSettings: vi.fn(() => ({
                    authInvalidatedAtMs: null,
                    binaryPath: null,
                })),
                saveClaudeRuntimeSettings: vi.fn(),
                saveCodexRuntimeSettings: vi.fn(),
                saveKiloRuntimeSettings: vi.fn(),
            } as never,
        });

        await service.prepareSession(
            {
                projectId: null,
                runtimeId: "codex",
                sessionId: "session-1",
                title: "Codex 1",
                worktreeId: null,
            },
            "window-1",
        );

        await service.renameSession({
            sessionId: "session-1",
            title: "Manual title",
        });

        expect(renameSession).toHaveBeenCalledWith({
            sessionId: "session-1",
            title: "Manual title",
        });
        expect(saveSessionSnapshot).not.toHaveBeenCalled();
        const lastSnapshotCall = onSessionSnapshot.mock.lastCall;
        expect(lastSnapshotCall?.[0]).toBe("window-1");
        expect(lastSnapshotCall?.[1]).toMatchObject({
            kind: "patch",
            patch: {
                changes: {
                    manualTitle: "Manual title",
                },
                sessionId: "session-1",
            },
        });
        expect(await service.getSessionSnapshot("session-1")).toMatchObject({
            manualTitle: "Manual title",
            sessionId: "session-1",
            title: "Codex 1",
        });
    });

    it("keeps manual titles when native session-info titles arrive later", async () => {
        const onSessionSnapshot = vi.fn();
        const service = createPrepareService({
            nativeAi: createNativeAi({
                prepareSession: vi.fn<NativeAiGateway["prepareSession"]>(() =>
                    Promise.resolve(createSnapshot({ runtimeId: "codex" })),
                ),
                renameSession: vi.fn<NativeAiGateway["renameSession"]>(() =>
                    Promise.resolve(),
                ),
            }),
            onSessionSnapshot,
        });

        await service.prepareSession(
            {
                projectId: null,
                runtimeId: "codex",
                sessionId: "session-1",
                title: "Codex 1",
                worktreeId: null,
            },
            "window-1",
        );
        await service.renameSession({
            sessionId: "session-1",
            title: "Manual title",
        });
        onSessionSnapshot.mockClear();

        service.handleNativeSessionEvent("window-1", {
            kind: "session-info",
            origin: "live",
            parentSessionId: null,
            projectId: null,
            runtimeId: "codex",
            runtimeSessionId: null,
            sessionId: "session-1",
            title: "Late runtime title",
            updatedAt: "2026-04-15T22:24:00.000Z",
            worktreeId: null,
        });

        expect(await service.getSessionSnapshot("session-1")).toMatchObject({
            manualTitle: "Manual title",
            title: "Late runtime title",
            updatedAt: "2026-04-15T22:24:00.000Z",
        });
        const update = onSessionSnapshot.mock.lastCall?.[1] as
            | AiSessionUpdate
            | undefined;
        expect(update?.kind).toBe("patch");
        expect(update?.kind === "patch" ? update.patch.changes.title : null).toBe(
            "Late runtime title",
        );
        expect(
            update?.kind === "patch"
                ? update.patch.changes.manualTitle
                : null,
        ).toBe("Manual title");
    });

    it("keeps manual titles when full native snapshots arrive later", async () => {
        const service = createPrepareService({
            nativeAi: createNativeAi({
                prepareSession: vi.fn<NativeAiGateway["prepareSession"]>(() =>
                    Promise.resolve(createSnapshot({ runtimeId: "codex" })),
                ),
                renameSession: vi.fn<NativeAiGateway["renameSession"]>(() =>
                    Promise.resolve(),
                ),
            }),
        });

        await service.prepareSession(
            {
                projectId: null,
                runtimeId: "codex",
                sessionId: "session-1",
                title: "Codex 1",
                worktreeId: null,
            },
            "window-1",
        );
        await service.renameSession({
            sessionId: "session-1",
            title: "Manual title",
        });

        service.handleNativeSessionSnapshot("window-1", {
            kind: "snapshot",
            snapshot: createSnapshot({
                runtimeId: "codex",
                sessionId: "session-1",
                title: "Late runtime title",
                updatedAt: "2026-04-15T22:25:00.000Z",
            }),
        });

        expect(await service.getSessionSnapshot("session-1")).toMatchObject({
            manualTitle: "Manual title",
            title: "Late runtime title",
            updatedAt: "2026-04-15T22:25:00.000Z",
        });
    });

    it("keeps live model config option changes in the main snapshot", async () => {
        const snapshot = createSnapshot({
            configOptions: [createModelConfig("gpt-5.4-mini")],
            modelId: "gpt-5.4-mini",
        });
        const prepareSession = vi.fn<NativeAiGateway["prepareSession"]>(() =>
            Promise.resolve(snapshot),
        );
        const setSessionConfigOption = vi.fn<
            NativeAiGateway["setSessionConfigOption"]
        >(() => Promise.resolve());
        const onSessionSnapshot = vi.fn<
            (ownerWindowId: string, update: AiSessionUpdate) => void
        >();
        const service = createPrepareService({
            nativeAi: createNativeAi({
                prepareSession,
                setSessionConfigOption,
            }),
            onSessionSnapshot,
        });

        await service.prepareSession(
            {
                projectId: null,
                runtimeId: "codex",
                sessionId: "session-1",
                title: "Codex 1",
                worktreeId: null,
            },
            "window-1",
        );

        await service.setSessionConfigOption({
            optionId: "model",
            sessionId: "session-1",
            value: "gpt-5.5",
        });

        expect(setSessionConfigOption).toHaveBeenCalledWith({
            optionId: "model",
            sessionId: "session-1",
            value: "gpt-5.5",
        });
        const updatedSnapshot = await service.getSessionSnapshot("session-1");
        expect(updatedSnapshot?.modelId).toBe("gpt-5.5");
        expect(
            updatedSnapshot?.configOptions.find((option) => option.id === "model")
                ?.value,
        ).toBe("gpt-5.5");
        expect(onSessionSnapshot.mock.lastCall?.[0]).toBe("window-1");
    });

    it("reprepares a live session once when a control mutation loses its runtime session", async () => {
        const snapshot = createSnapshot({
            configOptions: [createReasoningConfig("low")],
            runtimeSessionId: "runtime-session-1",
        });
        const prepareSession = vi
            .fn<NativeAiGateway["prepareSession"]>()
            .mockResolvedValueOnce(snapshot)
            .mockResolvedValueOnce({
                ...snapshot,
                runtimeSessionId: "runtime-session-2",
            });
        const setSessionConfigOption = vi
            .fn<NativeAiGateway["setSessionConfigOption"]>()
            .mockRejectedValueOnce(
                new NativeBackendError({
                    code: "ai_session_not_found",
                    details: null,
                    message: "The AI session was not found.",
                    retryable: false,
                }),
            )
            .mockResolvedValueOnce(undefined);
        const service = createPrepareService({
            nativeAi: createNativeAi({
                prepareSession,
                setSessionConfigOption,
            }),
        });

        await service.prepareSession(
            {
                projectId: null,
                runtimeId: "codex",
                sessionId: "session-1",
                title: "Codex 1",
                worktreeId: null,
            },
            "window-1",
        );

        await service.setSessionConfigOption({
            optionId: "reasoning_effort",
            sessionId: "session-1",
            value: "high",
        });

        expect(prepareSession).toHaveBeenCalledTimes(2);
        expect(setSessionConfigOption).toHaveBeenCalledTimes(2);
        expect(await service.getSessionSnapshot("session-1")).toMatchObject({
            runtimeSessionId: "runtime-session-2",
        });
    });

    it("does not reprepare a live session for another control mutation failure", async () => {
        const snapshot = createSnapshot({
            configOptions: [createReasoningConfig("low")],
            runtimeSessionId: "runtime-session-1",
        });
        const prepareSession = vi
            .fn<NativeAiGateway["prepareSession"]>()
            .mockResolvedValue(snapshot);
        const setSessionConfigOption = vi
            .fn<NativeAiGateway["setSessionConfigOption"]>()
            .mockRejectedValue(
                new NativeBackendError({
                    code: "ai_runtime_exited",
                    details: null,
                    message: "The runtime exited.",
                    retryable: false,
                }),
            );
        const service = createPrepareService({
            nativeAi: createNativeAi({
                prepareSession,
                setSessionConfigOption,
            }),
        });

        await service.prepareSession(
            {
                projectId: null,
                runtimeId: "codex",
                sessionId: "session-1",
                title: "Codex 1",
                worktreeId: null,
            },
            "window-1",
        );

        await expect(
            service.setSessionConfigOption({
                optionId: "reasoning_effort",
                sessionId: "session-1",
                value: "high",
            }),
        ).rejects.toThrow("The runtime exited.");

        expect(prepareSession).toHaveBeenCalledTimes(1);
        expect(setSessionConfigOption).toHaveBeenCalledTimes(1);
    });

    it("keeps live reasoning config option changes in the main snapshot", async () => {
        const snapshot = createSnapshot({
            configOptions: [createReasoningConfig("low")],
        });
        const prepareSession = vi.fn<NativeAiGateway["prepareSession"]>(() =>
            Promise.resolve(snapshot),
        );
        const setSessionConfigOption = vi.fn<
            NativeAiGateway["setSessionConfigOption"]
        >(() => Promise.resolve());
        const saveRuntimeSelectionPreferenceOption = vi.fn();
        const saveRuntimeModePreference = vi.fn();
        const saveRuntimeModelPreference = vi.fn();
        const service = createPrepareService({
            nativeAi: createNativeAi({
                prepareSession,
                setSessionConfigOption,
            }),
            persistence: {
                loadLatestRuntimeCatalog: vi.fn(() => null),
                loadRuntimeSelectionPreferences: vi.fn(() => ({
                    configOptions: {},
                    modeId: null,
                    modelId: null,
                })),
                loadSessionSnapshot: vi.fn(() => null),
                saveRuntimeSelectionPreferenceOption,
                saveRuntimeModePreference,
                saveRuntimeModelPreference,
                saveSessionSnapshot: vi.fn(),
            } as never,
        });

        await service.prepareSession(
            {
                projectId: null,
                runtimeId: "codex",
                sessionId: "session-1",
                title: "Codex 1",
                worktreeId: null,
            },
            "window-1",
        );

        await service.setSessionConfigOption({
            optionId: "reasoning_effort",
            sessionId: "session-1",
            value: "medium",
        });

        expect(setSessionConfigOption).toHaveBeenCalledWith({
            optionId: "reasoning_effort",
            sessionId: "session-1",
            value: "medium",
        });
        const updatedSnapshot = await service.getSessionSnapshot("session-1");
        expect(
            updatedSnapshot?.configOptions.find(
                (option) => option.id === "reasoning_effort",
            )?.value,
        ).toBe("medium");
        expect(updatedSnapshot?.reasoningEffort).toBe("medium");
        expect(saveRuntimeSelectionPreferenceOption).toHaveBeenCalledWith(
            "codex",
            "reasoning_effort",
            "medium",
        );
        expect(saveRuntimeModePreference).not.toHaveBeenCalled();
        expect(saveRuntimeModelPreference).not.toHaveBeenCalled();
    });

    it("applies saved reasoning preferences after a fresh prepare discovers config options", async () => {
        const preparedSnapshot = createSnapshot({
            configOptions: [createReasoningConfig("low")],
        });
        const prepareSession = vi.fn<NativeAiGateway["prepareSession"]>(() =>
            Promise.resolve(preparedSnapshot),
        );
        const setSessionConfigOption = vi.fn<
            NativeAiGateway["setSessionConfigOption"]
        >(() => Promise.resolve());
        const saveRuntimeSelectionPreferenceOption = vi.fn();
        const saveRuntimeModePreference = vi.fn();
        const saveRuntimeModelPreference = vi.fn();
        const service = createPrepareService({
            nativeAi: createNativeAi({
                prepareSession,
                setSessionConfigOption,
            }),
            persistence: {
                loadLatestRuntimeCatalog: vi.fn(() => null),
                loadRuntimeSelectionPreferences: vi.fn(() => ({
                    configOptions: {
                        reasoning_effort: "medium",
                    },
                    modeId: null,
                    modelId: null,
                })),
                loadSessionSnapshot: vi.fn(() => null),
                saveRuntimeSelectionPreferenceOption,
                saveRuntimeModePreference,
                saveRuntimeModelPreference,
                saveSessionSnapshot: vi.fn(),
            } as never,
        });

        const snapshot = await service.prepareSession(
            {
                projectId: null,
                runtimeId: "codex",
                sessionId: "session-1",
                title: "Codex 1",
                worktreeId: null,
            },
            "window-1",
        );

        expect(
            prepareSession.mock.calls[0]?.[0].launch.desiredSelections
                .configOptions,
        ).toEqual([]);
        expect(setSessionConfigOption).toHaveBeenCalledWith({
            optionId: "reasoning_effort",
            sessionId: "session-1",
            value: "medium",
        });
        expect(
            snapshot.configOptions.find(
                (option) => option.id === "reasoning_effort",
            )?.value,
        ).toBe("medium");
        expect(saveRuntimeSelectionPreferenceOption).not.toHaveBeenCalled();
        expect(saveRuntimeModePreference).not.toHaveBeenCalled();
        expect(saveRuntimeModelPreference).not.toHaveBeenCalled();
    });

    it("keeps existing reasoning selections over runtime defaults when preparing", async () => {
        const persistedSnapshot = createSnapshot({
            configOptions: [createReasoningConfig("high")],
        });
        const prepareSession = vi.fn<NativeAiGateway["prepareSession"]>(() =>
            Promise.resolve(persistedSnapshot),
        );
        const setSessionConfigOption = vi.fn<
            NativeAiGateway["setSessionConfigOption"]
        >(() => Promise.resolve());
        const service = createPrepareService({
            nativeAi: createNativeAi({
                loadSessionSnapshot: vi.fn(() =>
                    Promise.resolve(persistedSnapshot),
                ),
                prepareSession,
                setSessionConfigOption,
            }),
            persistence: {
                loadLatestRuntimeCatalog: vi.fn(() => null),
                loadRuntimeSelectionPreferences: vi.fn(() => ({
                    configOptions: {
                        reasoning_effort: "low",
                    },
                    modeId: null,
                    modelId: null,
                })),
                loadSessionSnapshot: vi.fn(() => persistedSnapshot),
                saveRuntimeSelectionPreferenceOption: vi.fn(),
                saveRuntimeModePreference: vi.fn(),
                saveRuntimeModelPreference: vi.fn(),
                saveSessionSnapshot: vi.fn(),
            } as never,
        });

        const snapshot = await service.prepareSession(
            {
                projectId: null,
                runtimeId: "codex",
                sessionId: "session-1",
                title: "Codex 1",
                worktreeId: null,
            },
            "window-1",
        );

        expect(setSessionConfigOption).not.toHaveBeenCalled();
        expect(
            prepareSession.mock.calls[0]?.[0].launch.desiredSelections
                .configOptions.find((option) => option.id === "reasoning_effort")
                ?.value,
        ).toBe("high");
        expect(
            snapshot.configOptions.find(
                (option) => option.id === "reasoning_effort",
            )?.value,
        ).toBe("high");
    });

    it("keeps persisted model selections over runtime defaults when preparing", async () => {
        const persistedSnapshot = createSnapshot({
            configOptions: [createModelConfig("gpt-5.4-mini")],
            modelId: "gpt-5.4-mini",
        });
        const prepareSession = vi.fn<NativeAiGateway["prepareSession"]>(() =>
            Promise.resolve(persistedSnapshot),
        );
        const service = createPrepareService({
            nativeAi: createNativeAi({
                loadSessionSnapshot: vi.fn(() =>
                    Promise.resolve(persistedSnapshot),
                ),
                prepareSession,
            }),
            persistence: {
                loadLatestRuntimeCatalog: vi.fn(() => null),
                loadRuntimeSelectionPreferences: vi.fn(() => ({
                    configOptions: {},
                    modeId: null,
                    modelId: "gpt-5.5",
                })),
                loadSessionSnapshot: vi.fn(() => persistedSnapshot),
                saveRuntimeSelectionPreferenceOption: vi.fn(),
                saveRuntimeModePreference: vi.fn(),
                saveRuntimeModelPreference: vi.fn(),
                saveSessionSnapshot: vi.fn(),
            } as never,
        });

        await service.prepareSession(
            {
                projectId: null,
                runtimeId: "codex",
                sessionId: "session-1",
                title: "Codex 1",
                worktreeId: null,
            },
            "window-1",
        );

        const desiredSelections =
            prepareSession.mock.calls[0]?.[0].launch.desiredSelections;
        expect(desiredSelections).toMatchObject({
            modelId: "gpt-5.4-mini",
        });
        expect(
            desiredSelections?.configOptions.find((option) => option.id === "model")
                ?.value,
        ).toBe("gpt-5.4-mini");
    });

    it("uses runtime defaults for new sessions without their own selections", async () => {
        const runtimeCatalog = createSnapshot({
            configOptions: [createReasoningConfig("medium")],
        });
        const prepareSession = vi.fn<NativeAiGateway["prepareSession"]>(
            ({ launch }) => Promise.resolve(launch.persistedSnapshot),
        );
        const service = createPrepareService({
            nativeAi: createNativeAi({
                prepareSession,
            }),
            persistence: {
                loadLatestRuntimeCatalog: vi.fn(() => ({
                    availableCommands: runtimeCatalog.availableCommands,
                    configOptions: runtimeCatalog.configOptions,
                    modeId: runtimeCatalog.modeId,
                    modes: runtimeCatalog.modes,
                    modelId: runtimeCatalog.modelId,
                    models: runtimeCatalog.models,
                })),
                loadRuntimeSelectionPreferences: vi.fn(() => ({
                    configOptions: {
                        reasoning_effort: "low",
                    },
                    modeId: null,
                    modelId: null,
                })),
                loadSessionSnapshot: vi.fn(() => null),
                saveRuntimeSelectionPreferenceOption: vi.fn(),
                saveRuntimeModePreference: vi.fn(),
                saveRuntimeModelPreference: vi.fn(),
                saveSessionSnapshot: vi.fn(),
            } as never,
        });

        await service.prepareSession(
            {
                projectId: null,
                runtimeId: "codex",
                sessionId: "session-1",
                title: "Codex 1",
                worktreeId: null,
            },
            "window-1",
        );

        const desiredSelections =
            prepareSession.mock.calls[0]?.[0].launch.desiredSelections;
        expect(
            desiredSelections?.configOptions.find(
                (option) => option.id === "reasoning_effort",
            )?.value,
        ).toBe("low");
    });

    it("uses preferences captured at launch when a new session discovers config later", async () => {
        const prepareSession = vi.fn<NativeAiGateway["prepareSession"]>(
            ({ launch }) => Promise.resolve(launch.persistedSnapshot),
        );
        const setSessionConfigOption = vi.fn<
            NativeAiGateway["setSessionConfigOption"]
        >(() => Promise.resolve());
        const loadRuntimeSelectionPreferences = vi.fn(() => ({
            configOptions: {
                reasoning_effort: "low",
            },
            modeId: null,
            modelId: null,
        }));
        const service = createPrepareService({
            nativeAi: createNativeAi({
                prepareSession,
                setSessionConfigOption,
            }),
            persistence: {
                loadLatestRuntimeCatalog: vi.fn(() => null),
                loadRuntimeSelectionPreferences,
                loadSessionSnapshot: vi.fn(() => null),
                saveRuntimeSelectionPreferenceOption: vi.fn(),
                saveRuntimeModePreference: vi.fn(),
                saveRuntimeModelPreference: vi.fn(),
                saveSessionSnapshot: vi.fn(),
            } as never,
        });

        await service.prepareSession(
            {
                projectId: null,
                runtimeId: "codex",
                sessionId: "session-1",
                title: "Codex 1",
                worktreeId: null,
            },
            "window-1",
        );
        loadRuntimeSelectionPreferences.mockReturnValue({
            configOptions: {
                reasoning_effort: "high",
            },
            modeId: null,
            modelId: null,
        });

        service.handleNativeSessionCatalogPatch(
            "window-1",
            "session-1",
            {
                configOptions: [createReasoningConfig("medium")],
            },
            "2026-04-15T22:24:13.719838Z",
        );
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(setSessionConfigOption).toHaveBeenCalledWith({
            optionId: "reasoning_effort",
            sessionId: "session-1",
            value: "low",
        });
        expect(loadRuntimeSelectionPreferences).toHaveBeenCalledTimes(1);
    });

    it("stops applying captured defaults after a manual selection", async () => {
        const prepareSession = vi.fn<NativeAiGateway["prepareSession"]>(
            ({ launch }) => Promise.resolve(launch.persistedSnapshot),
        );
        let resolveModelMutation!: () => void;
        const modelMutationPending = new Promise<void>((resolve) => {
            resolveModelMutation = resolve;
        });
        const setSessionConfigOption = vi.fn<
            NativeAiGateway["setSessionConfigOption"]
        >((input) =>
            input.optionId === "model"
                ? modelMutationPending
                : Promise.resolve(),
        );
        const service = createPrepareService({
            nativeAi: createNativeAi({
                prepareSession,
                setSessionConfigOption,
            }),
            persistence: {
                loadLatestRuntimeCatalog: vi.fn(() => null),
                loadRuntimeSelectionPreferences: vi.fn(() => ({
                    configOptions: {
                        model: "gpt-5.5",
                        reasoning_effort: "low",
                    },
                    modeId: null,
                    modelId: "gpt-5.5",
                })),
                loadSessionSnapshot: vi.fn(() => null),
                saveRuntimeSelectionPreferenceOption: vi.fn(),
                saveRuntimeModePreference: vi.fn(),
                saveRuntimeModelPreference: vi.fn(),
                saveSessionSnapshot: vi.fn(),
            } as never,
        });

        await service.prepareSession(
            {
                projectId: null,
                runtimeId: "codex",
                sessionId: "session-1",
                title: "Codex 1",
                worktreeId: null,
            },
            "window-1",
        );

        service.handleNativeSessionCatalogPatch(
            "window-1",
            "session-1",
            {
                configOptions: [
                    createModelConfig("gpt-5.4-mini"),
                    createReasoningConfig("medium"),
                ],
            },
            "2026-04-15T22:24:13.719838Z",
        );
        await vi.waitFor(() => {
            expect(setSessionConfigOption).toHaveBeenCalledWith({
                optionId: "model",
                sessionId: "session-1",
                value: "gpt-5.5",
            });
        });

        const manualModelMutation = service.setSessionConfigOption({
            optionId: "model",
            sessionId: "session-1",
            value: "gpt-5.4-mini",
        });
        resolveModelMutation();
        await manualModelMutation;

        expect(setSessionConfigOption).not.toHaveBeenCalledWith({
            optionId: "reasoning_effort",
            sessionId: "session-1",
            value: "low",
        });
        expect(setSessionConfigOption).toHaveBeenCalledWith({
            optionId: "model",
            sessionId: "session-1",
            value: "gpt-5.4-mini",
        });
        const updatedSnapshot = await service.getSessionSnapshot("session-1");
        expect(
            updatedSnapshot?.configOptions.find((option) => option.id === "model")
                ?.value,
        ).toBe("gpt-5.4-mini");
    });

    it("does not apply runtime preferences to restored sessions without their own selections", async () => {
        const runtimeCatalog = createSnapshot({
            configOptions: [createReasoningConfig("medium")],
        });
        const restoredSnapshot = createSnapshot({
            configOptions: [],
            sessionId: "session-1",
        });
        const prepareSession = vi.fn<NativeAiGateway["prepareSession"]>(
            ({ launch }) => Promise.resolve(launch.persistedSnapshot),
        );
        const setSessionConfigOption = vi.fn<
            NativeAiGateway["setSessionConfigOption"]
        >(() => Promise.resolve());
        const service = createPrepareService({
            nativeAi: createNativeAi({
                loadSessionSnapshot: vi.fn(() =>
                    Promise.resolve(restoredSnapshot),
                ),
                prepareSession,
                setSessionConfigOption,
            }),
            persistence: {
                loadLatestRuntimeCatalog: vi.fn(() => ({
                    availableCommands: runtimeCatalog.availableCommands,
                    configOptions: runtimeCatalog.configOptions,
                    modeId: runtimeCatalog.modeId,
                    modes: runtimeCatalog.modes,
                    modelId: runtimeCatalog.modelId,
                    models: runtimeCatalog.models,
                })),
                loadRuntimeSelectionPreferences: vi.fn(() => ({
                    configOptions: {
                        reasoning_effort: "low",
                    },
                    modeId: null,
                    modelId: null,
                })),
                loadSessionSnapshot: vi.fn(() => restoredSnapshot),
                saveRuntimeSelectionPreferenceOption: vi.fn(),
                saveRuntimeModePreference: vi.fn(),
                saveRuntimeModelPreference: vi.fn(),
                saveSessionSnapshot: vi.fn(),
            } as never,
        });

        await service.prepareSession(
            {
                projectId: null,
                runtimeId: "codex",
                sessionId: "session-1",
                title: "Codex 1",
                worktreeId: null,
            },
            "window-1",
        );

        const desiredSelections =
            prepareSession.mock.calls[0]?.[0].launch.desiredSelections;
        expect(
            desiredSelections?.configOptions.find(
                (option) => option.id === "reasoning_effort",
            )?.value,
        ).toBe("medium");
        expect(setSessionConfigOption).not.toHaveBeenCalled();
    });

    it("keeps authoritative subagent reasoning effort over runtime defaults", async () => {
        const runtimeCatalog = createSnapshot({
            configOptions: [createReasoningConfig("medium")],
        });
        const persistedSnapshot = createSnapshot({
            configOptions: [],
            parentSessionId: "session-parent",
            reasoningEffort: "high",
            sessionId: "session-parent:subagent:runtime-child",
        });
        const parentSnapshot = createSnapshot({
            configOptions: [createReasoningConfig("medium")],
            parentSessionId: null,
            reasoningEffort: "medium",
            sessionId: "session-parent",
        });
        const prepareSession = vi.fn<NativeAiGateway["prepareSession"]>(
            ({ launch }) => Promise.resolve(launch.persistedSnapshot),
        );
        const service = createPrepareService({
            nativeAi: createNativeAi({
                loadSessionSnapshot: vi.fn((sessionId) =>
                    Promise.resolve(
                        sessionId === "session-parent"
                            ? parentSnapshot
                            : persistedSnapshot,
                    ),
                ),
                prepareSession,
            }),
            persistence: {
                loadLatestRuntimeCatalog: vi.fn(() => ({
                    availableCommands: runtimeCatalog.availableCommands,
                    configOptions: runtimeCatalog.configOptions,
                    modeId: runtimeCatalog.modeId,
                    modes: runtimeCatalog.modes,
                    modelId: runtimeCatalog.modelId,
                    models: runtimeCatalog.models,
                })),
                loadRuntimeSelectionPreferences: vi.fn(() => ({
                    configOptions: {
                        reasoning_effort: "low",
                    },
                    modeId: null,
                    modelId: null,
                })),
                loadSessionSnapshot: vi.fn((sessionId) =>
                    sessionId === "session-parent"
                        ? parentSnapshot
                        : persistedSnapshot,
                ),
                saveRuntimeSelectionPreferenceOption: vi.fn(),
                saveRuntimeModePreference: vi.fn(),
                saveRuntimeModelPreference: vi.fn(),
                saveSessionSnapshot: vi.fn(),
            } as never,
        });

        const prepared = await service.prepareSession(
            {
                projectId: null,
                runtimeId: "codex",
                sessionId: "session-parent:subagent:runtime-child",
                title: "Child",
                worktreeId: null,
            },
            "window-1",
        );

        const desiredSelections =
            prepareSession.mock.calls[0]?.[0].launch.desiredSelections;
        expect(
            desiredSelections?.configOptions.find(
                (option) => option.id === "reasoning_effort",
            )?.value,
        ).toBe("medium");
        expect(prepared.reasoningEffort).toBe("high");
    });

    it("keeps Codex subagents on inherited config instead of runtime preferences", async () => {
        const runtimeCatalog = createSnapshot({
            configOptions: [createReasoningConfig("medium")],
        });
        const persistedSnapshot = createSnapshot({
            configOptions: [],
            parentSessionId: "session-parent",
            reasoningEffort: null,
            sessionId: "session-parent:subagent:runtime-child",
        });
        const parentSnapshot = createSnapshot({
            configOptions: [createReasoningConfig("medium")],
            parentSessionId: null,
            reasoningEffort: "medium",
            sessionId: "session-parent",
        });
        const prepareSession = vi.fn<NativeAiGateway["prepareSession"]>(
            ({ launch }) => Promise.resolve(launch.persistedSnapshot),
        );
        const setSessionConfigOption = vi.fn<
            NativeAiGateway["setSessionConfigOption"]
        >(() => Promise.resolve());
        const service = createPrepareService({
            nativeAi: createNativeAi({
                loadSessionSnapshot: vi.fn((sessionId) =>
                    Promise.resolve(
                        sessionId === "session-parent"
                            ? parentSnapshot
                            : persistedSnapshot,
                    ),
                ),
                prepareSession,
                setSessionConfigOption,
            }),
            persistence: {
                loadLatestRuntimeCatalog: vi.fn(() => ({
                    availableCommands: runtimeCatalog.availableCommands,
                    configOptions: runtimeCatalog.configOptions,
                    modeId: runtimeCatalog.modeId,
                    modes: runtimeCatalog.modes,
                    modelId: runtimeCatalog.modelId,
                    models: runtimeCatalog.models,
                })),
                loadRuntimeSelectionPreferences: vi.fn(() => ({
                    configOptions: {
                        reasoning_effort: "low",
                    },
                    modeId: null,
                    modelId: null,
                })),
                loadSessionSnapshot: vi.fn((sessionId) =>
                    sessionId === "session-parent"
                        ? parentSnapshot
                        : persistedSnapshot,
                ),
                saveRuntimeSelectionPreferenceOption: vi.fn(),
                saveRuntimeModePreference: vi.fn(),
                saveRuntimeModelPreference: vi.fn(),
                saveSessionSnapshot: vi.fn(),
            } as never,
        });

        await service.prepareSession(
            {
                projectId: null,
                runtimeId: "codex",
                sessionId: "session-parent:subagent:runtime-child",
                title: "Child",
                worktreeId: null,
            },
            "window-1",
        );

        const desiredSelections =
            prepareSession.mock.calls[0]?.[0].launch.desiredSelections;
        expect(
            desiredSelections?.configOptions.find(
                (option) => option.id === "reasoning_effort",
            )?.value,
        ).toBe("medium");
        expect(setSessionConfigOption).not.toHaveBeenCalled();
    });

    it("does not restore persisted review files before native prepare", async () => {
        const pendingFile: AiTrackedFile = {
            currentText: "export const value = 2;\n",
            diffBase: "export const value = 1;\n",
            hunks: [],
            identityKey: "native:session-1::src-app.ts",
            isText: true,
            kind: "update",
            newText: "export const value = 2;\n",
            oldText: "export const value = 1;\n",
            path: "src-app.ts",
            previousPath: null,
            reviewState: "pending",
            reversible: true,
            sessionId: "session-1",
            toolCallId: null,
            updatedAt: "2026-06-20T00:00:00.000Z",
            version: 1,
        };
        const persistedSnapshot = createSnapshot({
            projectId: "project-1",
            trackedFiles: [pendingFile],
        });
        const prepareSession = vi.fn<NativeAiGateway["prepareSession"]>(
            ({ launch }) =>
                Promise.resolve({
                    ...launch.persistedSnapshot,
                    runtimeSessionId: "runtime-session-1",
                    status: "idle",
                    updatedAt: "2026-06-20T00:00:01.000Z",
                }),
        );
        const nativeAi = createNativeAi({
            loadSessionSnapshot: vi.fn(() => Promise.resolve(persistedSnapshot)),
            prepareSession,
        });
        const service = createPrepareService({ nativeAi });

        const snapshot = await service.prepareSession(
            {
                projectId: "project-1",
                runtimeId: "codex",
                sessionId: "session-1",
                title: "Codex 1",
                worktreeId: null,
            },
            "window-1",
        );

        expect(snapshot.trackedFiles).toEqual([]);
        expect(
            prepareSession.mock.calls[0]?.[0].launch.persistedSnapshot
                .trackedFiles,
        ).toEqual([]);
    });

    it("returns active live session snapshots owned by a window for stream resync", async () => {
        const nativeAi = createNativeAi({
            prepareSession: vi.fn<NativeAiGateway["prepareSession"]>(({ input }) =>
                Promise.resolve(
                    createSnapshot({
                        projectId: input.projectId,
                        runtimeId: input.runtimeId,
                        runtimeSessionId: `runtime-${input.sessionId}`,
                        sessionId: input.sessionId,
                        status:
                            input.sessionId === "session-2"
                                ? "waiting_permission"
                                : "streaming",
                        title: input.title,
                        worktreeId: input.worktreeId ?? null,
                    }),
                ),
            ),
        });
        const service = createPrepareService({ nativeAi });

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
                projectId: "project-2",
                runtimeId: "codex",
                sessionId: "session-3",
                title: "Session 3",
                worktreeId: null,
            },
            "window-2",
        );

        expect(
            service
                .getLiveSessionSnapshotsForWindow("window-1")
                .map((snapshot) => [snapshot.sessionId, snapshot.status]),
        ).toEqual([
            ["session-1", "streaming"],
            ["session-2", "waiting_permission"],
        ]);
        expect(
            service
                .getLiveSessionSnapshotsForWindow("window-2")
                .map((snapshot) => snapshot.sessionId),
        ).toEqual(["session-3"]);
    });

    it("returns a single live session snapshot only to its owning window", async () => {
        const nativeAi = createNativeAi({
            prepareSession: vi.fn<NativeAiGateway["prepareSession"]>(({ input }) =>
                Promise.resolve(
                    createSnapshot({
                        runtimeSessionId: `runtime-${input.sessionId}`,
                        sessionId: input.sessionId,
                        status: "streaming",
                        title: input.title,
                    }),
                ),
            ),
        });
        const service = createPrepareService({ nativeAi });

        const snapshot = await service.prepareSession(
            {
                projectId: null,
                runtimeId: "codex",
                sessionId: "session-1",
                title: "Streaming",
                worktreeId: null,
            },
            "window-1",
        );

        expect(
            service.getLiveSessionSnapshotForWindow("window-1", "session-1"),
        ).toBe(snapshot);
        expect(
            service.getLiveSessionSnapshotForWindow("window-2", "session-1"),
        ).toBeNull();
        expect(
            service.getLiveSessionSnapshotForWindow("window-1", "missing"),
        ).toBeNull();
    });

    it("omits inactive sessions and snapshots without live context from stream resync", async () => {
        const nativeAi = createNativeAi({
            prepareSession: vi.fn<NativeAiGateway["prepareSession"]>(({ input }) =>
                Promise.resolve(
                    createSnapshot({
                        runtimeSessionId: `runtime-${input.sessionId}`,
                        sessionId: input.sessionId,
                        status:
                            input.sessionId === "session-1"
                                ? "idle"
                                : "starting",
                        title: input.title,
                    }),
                ),
            ),
        });
        const service = createPrepareService({ nativeAi });

        await service.prepareSession(
            {
                projectId: null,
                runtimeId: "codex",
                sessionId: "session-1",
                title: "Idle",
                worktreeId: null,
            },
            "window-1",
        );
        await service.prepareSession(
            {
                projectId: null,
                runtimeId: "codex",
                sessionId: "session-2",
                title: "Starting",
                worktreeId: null,
            },
            "window-1",
        );
        service.handleNativeSessionSnapshot("window-1", {
            kind: "snapshot",
            snapshot: createSnapshot({
                runtimeSessionId: "runtime-orphan",
                sessionId: "orphan-session",
                status: "streaming",
                title: "Orphan",
            }),
        });

        expect(
            service
                .getLiveSessionSnapshotsForWindow("window-1")
                .map((snapshot) => snapshot.sessionId),
        ).toEqual(["session-2"]);
    });

    it("does not mutate live snapshots while reading stream resync state", async () => {
        const onSessionSnapshot = vi.fn();
        const nativeAi = createNativeAi({
            prepareSession: vi.fn<NativeAiGateway["prepareSession"]>(({ input }) =>
                Promise.resolve(
                    createSnapshot({
                        runtimeSessionId: `runtime-${input.sessionId}`,
                        sessionId: input.sessionId,
                        status: "streaming",
                        title: input.title,
                    }),
                ),
            ),
        });
        const service = createPrepareService({
            nativeAi,
            onSessionSnapshot,
        });

        await service.prepareSession(
            {
                projectId: null,
                runtimeId: "codex",
                sessionId: "session-1",
                title: "Streaming",
                worktreeId: null,
            },
            "window-1",
        );
        const callsBeforeRead = onSessionSnapshot.mock.calls.length;
        const before = service.getLiveSessionSnapshotsForWindow("window-1");
        const after = service.getLiveSessionSnapshotsForWindow("window-1");

        expect(after).toHaveLength(1);
        expect(after[0]).toBe(before[0]);
        expect(onSessionSnapshot).toHaveBeenCalledTimes(callsBeforeRead);
    });

    it("does not return live snapshots after the owning window is closed", async () => {
        const nativeAi = createNativeAi({
            prepareSession: vi.fn<NativeAiGateway["prepareSession"]>(({ input }) =>
                Promise.resolve(
                    createSnapshot({
                        runtimeSessionId: `runtime-${input.sessionId}`,
                        sessionId: input.sessionId,
                        status: "streaming",
                        title: input.title,
                    }),
                ),
            ),
        });
        const service = createPrepareService({ nativeAi });

        await service.prepareSession(
            {
                projectId: null,
                runtimeId: "codex",
                sessionId: "session-1",
                title: "Streaming",
                worktreeId: null,
            },
            "window-1",
        );

        service.closeOwnedByWindow("window-1");

        expect(service.getLiveSessionSnapshotsForWindow("window-1")).toEqual([]);
    });
});

function createNativeAi(
    overrides: Partial<NativeAiGateway> = {},
): NativeAiGateway {
    return {
        cancelSession: vi.fn(),
        captureReviewBaseline: vi.fn(),
        close: vi.fn(),
        closeOwnedByWindow: vi.fn(),
        closeSession: vi.fn(),
        deleteSession: vi.fn(),
        listSessionHistory: vi.fn(() => Promise.resolve([])),
        loadSessionSnapshot: vi.fn(() => Promise.resolve(null)),
        loadSessionTranscriptPage: vi.fn(() => Promise.resolve(null)),
        prepareSession: vi.fn(),
        renameSession: vi.fn(),
        respondPermission: vi.fn(),
        respondUserInput: vi.fn(),
        sendPrompt: vi.fn(),
        setSessionConfigOption: vi.fn(),
        setSessionMode: vi.fn(),
        setSessionModel: vi.fn(),
        setSessionPinned: vi.fn(),
        shouldHandleHistory: vi.fn(() => true),
        shouldHandleReview: vi.fn(() => true),
        shouldHandleRuntime: vi.fn((runtimeId) => runtimeId === "codex"),
        ...overrides,
    };
}

function createSnapshot(
    overrides: Partial<AiSessionSnapshot> = {},
): AiSessionSnapshot {
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
        ...overrides,
    };
}

function createModelConfig(value: string): AiSessionConfigOption {
    return {
        category: "model",
        description: null,
        id: "model",
        label: "Model",
        options: [
            {
                description: null,
                groupLabel: null,
                label: "GPT 5.4 Mini",
                value: "gpt-5.4-mini",
            },
            {
                description: null,
                groupLabel: null,
                label: "GPT 5.5",
                value: "gpt-5.5",
            },
        ],
        type: "select",
        value,
    };
}

function createReasoningConfig(value: string): AiSessionConfigOption {
    return {
        category: "reasoning",
        description: null,
        id: "reasoning_effort",
        label: "Effort",
        options: [
            {
                description: null,
                groupLabel: null,
                label: "Low",
                value: "low",
            },
            {
                description: null,
                groupLabel: null,
                label: "Medium",
                value: "medium",
            },
            {
                description: null,
                groupLabel: null,
                label: "High",
                value: "high",
            },
        ],
        type: "select",
        value,
    };
}

function createPrepareService(
    options: {
        readonly aiSessionRetention?: ConstructorParameters<
            typeof AiService
        >[0]["aiSessionRetention"];
        readonly nativeAi?: NativeAiGateway;
        readonly onSessionSnapshot?: (
            ownerWindowId: string,
            update: AiSessionUpdate,
        ) => void;
        readonly persistence?: ConstructorParameters<
            typeof AiService
        >[0]["persistence"];
    } = {},
): InstanceType<typeof AiService> {
    return new AiService({
        aiSessionRetention: options.aiSessionRetention,
        nativeAi: options.nativeAi ?? createNativeAi(),
        onRuntimeStatus: vi.fn(),
        onSessionSnapshot: options.onSessionSnapshot ?? vi.fn(),
        persistence:
            options.persistence ??
            ({
                loadLatestRuntimeCatalog: vi.fn(() => null),
                loadRuntimeSelectionPreferences: vi.fn(() => ({
                    configOptions: {},
                    modeId: null,
                    modelId: null,
                })),
                loadSessionSnapshot: vi.fn(() => null),
                saveRuntimeSelectionPreferenceOption: vi.fn(),
                saveRuntimeModePreference: vi.fn(),
                saveRuntimeModelPreference: vi.fn(),
                saveSessionSnapshot: vi.fn(),
            } as never),
        projectService: {
            getProjectRootPath: vi.fn(() => process.cwd()),
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
            loadKiloRuntimeSettings: vi.fn(() => ({
                authInvalidatedAtMs: null,
                binaryPath: null,
            })),
            saveClaudeRuntimeSettings: vi.fn(),
            saveCodexRuntimeSettings: vi.fn(),
            saveKiloRuntimeSettings: vi.fn(),
        } as never,
    });
}
