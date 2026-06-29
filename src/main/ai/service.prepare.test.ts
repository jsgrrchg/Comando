import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    AiRuntimeStatus,
    AiSessionConfigOption,
    AiSessionSnapshot,
    AiSessionUpdate,
    AiTrackedFile,
} from "@shared/ipc";

import type { NativeAiGateway } from "./contracts";

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
                title: "Codex 1",
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
        expect(saveRuntimeModePreference).toHaveBeenCalledWith(
            "codex",
            "agent",
        );
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
                changes: { title: "Manual title" },
                sessionId: "session-1",
            },
        });
        expect(await service.getSessionSnapshot("session-1")).toMatchObject({
            sessionId: "session-1",
            title: "Manual title",
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
        const prepareSession = vi.fn<NativeAiGateway["prepareSession"]>(
            ({ launch }) => Promise.resolve(launch.persistedSnapshot),
        );
        const service = createPrepareService({
            nativeAi: createNativeAi({
                loadSessionSnapshot: vi.fn(() =>
                    Promise.resolve(persistedSnapshot),
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
        ).toBe("high");
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
