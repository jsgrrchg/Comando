import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AiRuntimeStatus, AiSessionSnapshot } from "@shared/ipc";

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

    it("delegates session startup to the AI worker with a resolved launch payload", async () => {
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
        const workerSnapshot: AiSessionSnapshot = {
            ...persistedSnapshot,
            lastError: null,
            status: "idle",
            updatedAt: "2026-04-16T00:00:00.000Z",
        };
        const prepareSession = vi.fn<AiWorkerGateway["prepareSession"]>(() =>
            Promise.resolve(workerSnapshot),
        );
        const renameSession = vi.fn(() => Promise.resolve());
        const aiWorker: AiWorkerGateway = {
            cancelSession: vi.fn(),
            close: vi.fn(),
            closeOwnedByWindow: vi.fn(),
            closeSession: vi.fn(),
            freezeSession: vi.fn(),
            keepAllTrackedFiles: vi.fn(),
            keepTrackedFile: vi.fn(),
            keepTrackedFileHunks: vi.fn(),
            notifyFileBuffer: vi.fn(),
            prepareSession,
            renameSession,
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
        };
        const runtimeStatusEvents: AiRuntimeStatus[] = [];
        const saveSessionSnapshot = vi.fn();
        const service = new AiService({
            aiWorker,
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

        expect(snapshot).toBe(workerSnapshot);
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
        expect(saveSessionSnapshot).toHaveBeenCalledWith(workerSnapshot);
        expect(runtimeStatusEvents.at(-1)).toEqual(readyStatus);
    });

    it("rejects legacy Gemini sessions before worker startup", async () => {
        const prepareSession = vi.fn<AiWorkerGateway["prepareSession"]>();
        const runtimeStatusEvents: AiRuntimeStatus[] = [];
        const service = new AiService({
            aiWorker: {
                cancelSession: vi.fn(),
                close: vi.fn(),
                closeOwnedByWindow: vi.fn(),
                closeSession: vi.fn(),
                freezeSession: vi.fn(),
                keepAllTrackedFiles: vi.fn(),
                keepTrackedFile: vi.fn(),
                keepTrackedFileHunks: vi.fn(),
                notifyFileBuffer: vi.fn(),
                prepareSession,
                rejectAllTrackedFiles: vi.fn(),
                rejectTrackedFile: vi.fn(),
                rejectTrackedFileHunks: vi.fn(),
                refreshProjectScopes: vi.fn(),
                renameSession: vi.fn(),
                respondPermission: vi.fn(),
                respondUserInput: vi.fn(),
                sendPrompt: vi.fn(),
                setSessionConfigOption: vi.fn(),
                setSessionMode: vi.fn(),
                setSessionModel: vi.fn(),
            },
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

    it("clears the live context when worker startup fails", async () => {
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
        const workerPrepareError = new Error("worker startup failed");
        const prepareSession = vi.fn<AiWorkerGateway["prepareSession"]>(() =>
            Promise.reject(workerPrepareError),
        );
        const renameSession = vi.fn(() => Promise.resolve());
        const setSessionMode = vi.fn();
        const saveSessionSnapshot = vi.fn();
        const saveRuntimeModePreference = vi.fn();
        const service = new AiService({
            aiWorker: {
                cancelSession: vi.fn(),
                close: vi.fn(),
                closeOwnedByWindow: vi.fn(),
                closeSession: vi.fn(),
                freezeSession: vi.fn(),
                keepAllTrackedFiles: vi.fn(),
                keepTrackedFile: vi.fn(),
                keepTrackedFileHunks: vi.fn(),
                notifyFileBuffer: vi.fn(),
                prepareSession,
                renameSession,
                rejectAllTrackedFiles: vi.fn(),
                rejectTrackedFile: vi.fn(),
                rejectTrackedFileHunks: vi.fn(),
                refreshProjectScopes: vi.fn(),
                respondPermission: vi.fn(),
                respondUserInput: vi.fn(),
                sendPrompt: vi.fn(),
                setSessionConfigOption: vi.fn(),
                setSessionMode,
                setSessionModel: vi.fn(),
            },
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
        ).rejects.toThrow(workerPrepareError);

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

    it("routes live renames through the worker instead of mutating a stale shadow snapshot", async () => {
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
        const prepareSession = vi.fn<AiWorkerGateway["prepareSession"]>(() =>
            Promise.resolve(snapshot),
        );
        const renameSession = vi.fn(() => Promise.resolve());
        const saveSessionSnapshot = vi.fn();
        const service = new AiService({
            aiWorker: {
                cancelSession: vi.fn(),
                close: vi.fn(),
                closeOwnedByWindow: vi.fn(),
                closeSession: vi.fn(),
                freezeSession: vi.fn(),
                keepAllTrackedFiles: vi.fn(),
                keepTrackedFile: vi.fn(),
                keepTrackedFileHunks: vi.fn(),
                notifyFileBuffer: vi.fn(),
                prepareSession,
                renameSession,
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
            onRuntimeStatus: vi.fn(),
            onSessionSnapshot: vi.fn(),
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
        expect(saveSessionSnapshot).toHaveBeenCalledTimes(1);
        expect(saveSessionSnapshot).not.toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: "session-1",
                title: "Manual title",
            }),
        );
    });
});
