import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    AiRuntimeStatus,
    AiSessionSnapshot,
    AiSessionUpdate,
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

    it("rejects legacy Gemini sessions before native startup", async () => {
        const prepareSession = vi.fn<NativeAiGateway["prepareSession"]>();
        const runtimeStatusEvents: AiRuntimeStatus[] = [];
        const service = new AiService({
            nativeAi: createNativeAi({
                prepareSession,
            }),
            onRuntimeStatus: (status) => runtimeStatusEvents.push(status),
            onSessionSnapshot: vi.fn(),
            persistence: {
                loadLatestRuntimeCatalog: vi.fn(() => null),
                loadRuntimeSelectionPreferences: vi.fn(() => ({
                    configOptions: {},
                    modeId: null,
                    modelId: null,
                })),
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
                loadCodexRuntimeSettings: vi.fn(() => ({
                    authMethod: "chatgpt",
                    binaryPath: null,
                    hasCodexApiKey: false,
                    hasOpenAiApiKey: false,
                })),
            } as never,
        });

        await expect(
            service.prepareSession(
                {
                    projectId: null,
                    runtimeId: "gemini",
                    sessionId: "session-gemini",
                    title: "Gemini 1",
                    worktreeId: null,
                },
                "window-1",
            ),
        ).rejects.toThrow(
            "Gemini ACP support has been removed. Use Kilo or OpenCode with a Gemini API key instead.",
        );

        expect(prepareSession).not.toHaveBeenCalled();
        expect(runtimeStatusEvents.at(-1)).toMatchObject({
            message:
                "Gemini ACP support has been removed. Use Kilo or OpenCode with a Gemini API key instead.",
            runtimeId: "gemini",
            state: "error",
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
