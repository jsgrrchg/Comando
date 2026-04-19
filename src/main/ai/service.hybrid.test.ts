import { describe, expect, it, vi } from "vitest";

import type {
    AiRuntimeStatus,
    AiSessionSnapshot,
    AiSessionUpdate,
} from "@shared/ipc";

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
});

function createService(overrides: {
    readonly loadSessionSnapshot?: ReturnType<typeof vi.fn>;
    readonly onSessionSnapshot?: (
        ownerWindowId: string,
        update: AiSessionUpdate,
    ) => void;
    readonly saveSessionSnapshot?: ReturnType<typeof vi.fn>;
} = {}) {
    return new AiService({
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
            getProjectRootPath: vi.fn(() => process.cwd()),
            listProjectWorktrees: vi.fn(() => []),
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
        toolActivity: [],
        trackedFiles: [],
        updatedAt: "2026-04-16T00:00:00.000Z",
        worktreeId: null,
        ...rest,
    };
}
