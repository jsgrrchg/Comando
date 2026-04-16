import { PassThrough } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AiRuntimeStatus, AiSessionSnapshot } from "@shared/ipc";

const initializeMock = vi.fn(() => Promise.resolve(undefined));
const loadSessionMock = vi.fn(() =>
    Promise.resolve({
        configOptions: [],
        modes: [],
        models: [],
    }),
);
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
        initialize = initializeMock;
        loadSession = loadSessionMock;
        newSession = newSessionMock;
    },
    PROTOCOL_VERSION: "test-protocol-version",
    ndJsonStream: vi.fn(() => ({})),
}));

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
        initializeMock.mockClear();
        loadSessionMock.mockClear();
        loadSessionMock.mockResolvedValue({
            configOptions: [],
            modes: [],
            models: [],
        });
        newSessionMock.mockClear();
        spawnMock.mockClear();
    });

    it("clears persisted lastError after a successful restore", async () => {
        const persistedSnapshot: AiSessionSnapshot = {
            availableCommands: [],
            configOptions: [],
            lastError:
                "2026-04-15T22:23:13.719838Z ERROR codex_core::codex: failed to load skill /Users/test/.codex/skills/vaultai-release-operator/SKILL.md",
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
            toolActivity: [],
            trackedFiles: [],
            updatedAt: "2026-04-15T22:23:13.719838Z",
            worktreeId: null,
        };
        const saveSessionSnapshot = vi.fn();
        const service = new AiService({
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
                saveRuntimeModePreference: vi.fn(),
                saveRuntimeModelPreference: vi.fn(),
                saveSessionSnapshot,
            } as never,
            projectService: {
                getProjectRootPath: vi.fn(() => process.cwd()),
            } as never,
            secretStore: {
                loadSecret: vi.fn(() => null),
                saveSecret: vi.fn(),
            } as never,
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

        expect(loadSessionMock).toHaveBeenCalledWith({
            additionalDirectories: undefined,
            cwd: process.cwd(),
            mcpServers: [],
            sessionId: "runtime-session-1",
        });
        expect(snapshot.lastError).toBeNull();
        expect(snapshot.status).toBe("idle");
        expect(saveSessionSnapshot).toHaveBeenLastCalledWith(
            expect.objectContaining({
                lastError: null,
                status: "idle",
            }),
        );
    });
});
