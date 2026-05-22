import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
    AiRuntimeStatus,
    AiSessionSnapshot,
    OpenCodeRuntimeSettings,
} from "@shared/ipc";

import { AiService } from "./service";
import type { AiWorkerGateway } from "./contracts";

describe("AiService OpenCode branch", () => {
    it("stores OpenCode settings and emits runtime status", async () => {
        let savedSettings: OpenCodeRuntimeSettings | null = null;
        const runtimeStatusEvents: AiRuntimeStatus[] = [];
        const settingsService = createSettingsService({
            loadOpenCodeRuntimeSettings: vi.fn(() =>
                createOpenCodeSettings(),
            ),
            saveOpenCodeRuntimeSettings: (
                settings: OpenCodeRuntimeSettings,
            ) => {
                savedSettings = settings;
            },
        });
        const service = createService({
            onRuntimeStatus: (status) => runtimeStatusEvents.push(status),
            settingsService,
        });

        const status = await service.saveOpenCodeRuntimeSettings({
            authMethod: "opencode-login",
            binaryPath: "/opt/homebrew/bin/opencode",
        });

        expect(savedSettings).toEqual({
            authInvalidatedAtMs: null,
            authMethod: "opencode-login",
            binaryPath: "/opt/homebrew/bin/opencode",
        });
        expect(status.runtimeId).toBe("opencode");
        expect(runtimeStatusEvents.at(-1)?.runtimeId).toBe("opencode");
    });

    it("disconnects OpenCode from Comando without deleting external credentials", async () => {
        let savedSettings: OpenCodeRuntimeSettings | null = null;
        const service = createService({
            settingsService: createSettingsService({
                loadOpenCodeRuntimeSettings: vi.fn(() =>
                    createOpenCodeSettings({
                        authMethod: "opencode-login",
                        binaryPath: "/opt/homebrew/bin/opencode",
                    }),
                ),
                saveOpenCodeRuntimeSettings: (
                    settings: OpenCodeRuntimeSettings,
                ) => {
                    savedSettings = settings;
                },
            }),
        });

        await service.disconnectRuntimeAuth({ runtimeId: "opencode" });

        expect(savedSettings).not.toBeNull();
        const nextSettings =
            savedSettings as unknown as OpenCodeRuntimeSettings;
        expect(nextSettings.binaryPath).toBe("/opt/homebrew/bin/opencode");
        expect(nextSettings.authMethod).toBeNull();
        expect(nextSettings.authInvalidatedAtMs).toEqual(expect.any(Number));
    });

    it("prepares OpenCode sessions with opencode acp launch details", async () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-opencode-service-"),
        );

        try {
            const binaryPath = writeExecutable(tempDir, "opencode");
            const preparedSnapshot = createSessionSnapshot();
            const prepareSession = vi.fn<AiWorkerGateway["prepareSession"]>(
                async () => preparedSnapshot,
            );
            const aiWorker = createAiWorker({ prepareSession });
            const service = createService({
                aiWorker,
                settingsService: createSettingsService({
                    loadOpenCodeRuntimeSettings: vi.fn(() =>
                        createOpenCodeSettings({
                            authMethod: "opencode-login",
                            binaryPath,
                        }),
                    ),
                }),
            });

            await service.prepareSession(
                {
                    projectId: null,
                    runtimeId: "opencode",
                    sessionId: "session-opencode",
                    title: "OpenCode 1",
                    worktreeId: null,
                },
                "window-1",
            );

            const launch = prepareSession.mock.calls[0][0].launch;
            expect(launch.resolvedRuntime.executable).toBe(binaryPath);
            expect(launch.resolvedRuntime.args).toEqual(["acp"]);
            expect(launch.resolvedRuntime.command).toBe(`${binaryPath} acp`);
            expect(launch.resolvedRuntime.status.runtimeId).toBe("opencode");
            expect(launch.resolvedRuntime.status.onboardingRequired).toBe(
                false,
            );
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });
});

function createService(overrides: {
    readonly aiWorker?: AiWorkerGateway;
    readonly onRuntimeStatus?: (status: AiRuntimeStatus) => void;
    readonly settingsService?: unknown;
}): AiService {
    return new AiService({
        aiWorker: overrides.aiWorker ?? null,
        onRuntimeStatus: overrides.onRuntimeStatus ?? vi.fn(),
        onSessionSnapshot: vi.fn(),
        persistence: {
            loadLatestRuntimeCatalog: vi.fn(() => null),
            loadRuntimeSelectionPreferences: vi.fn(() => ({
                configOptions: {},
                modeId: null,
                modelId: null,
            })),
            loadSessionSnapshot: vi.fn(() => null),
            saveRuntimeModePreference: vi.fn(),
            saveRuntimeModelPreference: vi.fn(),
            saveRuntimeSelectionPreferenceOption: vi.fn(),
            saveSessionSnapshot: vi.fn(),
        } as never,
        projectService: {
            getProjectRootPath: vi.fn(() => process.cwd()),
            listProjectWorktrees: vi.fn(() => []),
        } as never,
        secretStore: {
            cacheSecretPatches: vi.fn(),
            getStorageStatus: vi.fn(() => ({
                encryptionAvailable: true,
                isWeakBackend: false,
                message: null,
                platform: process.platform,
                selectedBackend: null,
            })),
            loadSecret: vi.fn(() => null),
            saveSecret: vi.fn(),
        } as never,
        settingsService: (overrides.settingsService ??
            createSettingsService({})) as never,
    });
}

function createSettingsService(overrides: Record<string, unknown>) {
    return {
        loadClaudeRuntimeSettings: vi.fn(() => ({
            authInvalidatedAtMs: null,
            authMethod: null,
            bedrockGatewayBaseUrl: null,
            binaryPath: null,
            gatewayBaseUrl: null,
            hasAnthropicApiKey: false,
            hasGatewayAuthToken: false,
            hasGatewayCustomHeaders: false,
        })),
        loadCodexRuntimeSettings: vi.fn(() => ({
            authMethod: null,
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
            authMethod: null,
            binaryPath: null,
            hasKiloApiKey: false,
        })),
        loadOpenCodeRuntimeSettings: vi.fn(() => createOpenCodeSettings()),
        saveClaudeRuntimeSettings: vi.fn(),
        saveCodexRuntimeSettings: vi.fn(),
        saveGeminiRuntimeSettings: vi.fn(),
        saveKiloRuntimeSettings: vi.fn(),
        saveOpenCodeRuntimeSettings: vi.fn(),
        ...overrides,
    } as never;
}

function createAiWorker(overrides: Partial<AiWorkerGateway>): AiWorkerGateway {
    return {
        cancelSession: vi.fn(),
        close: vi.fn(),
        closeOwnedByWindow: vi.fn(),
        closeSession: vi.fn(),
        keepAllTrackedFiles: vi.fn(),
        keepTrackedFile: vi.fn(),
        keepTrackedFileHunks: vi.fn(),
        notifyFileBuffer: vi.fn(),
        prepareSession: vi.fn(),
        refreshProjectScopes: vi.fn(),
        rejectAllTrackedFiles: vi.fn(),
        rejectTrackedFile: vi.fn(),
        rejectTrackedFileHunks: vi.fn(),
        renameSession: vi.fn(),
        respondPermission: vi.fn(),
        respondUserInput: vi.fn(),
        sendPrompt: vi.fn(),
        setSessionConfigOption: vi.fn(),
        setSessionMode: vi.fn(),
        setSessionModel: vi.fn(),
        ...overrides,
    };
}

function createOpenCodeSettings(
    overrides: Partial<OpenCodeRuntimeSettings> = {},
): OpenCodeRuntimeSettings {
    return {
        authInvalidatedAtMs: null,
        authMethod: null,
        binaryPath: null,
        ...overrides,
    };
}

function createSessionSnapshot(): AiSessionSnapshot {
    return {
        activeTurnStartedAt: null,
        availableCommands: [],
        configOptions: [],
        lastError: null,
        messages: [],
        modeId: null,
        modes: [],
        modelId: null,
        models: [],
        parentSessionId: null,
        pendingPermission: null,
        pendingUserInput: null,
        plan: null,
        projectId: null,
        runtimeId: "opencode",
        runtimeSessionId: "runtime-opencode",
        sessionId: "session-opencode",
        status: "idle",
        title: "OpenCode 1",
        tokenUsage: null,
        toolActivity: [],
        trackedFiles: [],
        updatedAt: "2026-05-22T00:00:00.000Z",
        worktreeId: null,
    };
}

function writeExecutable(dir: string, name: string): string {
    const binaryPath = path.join(dir, name);
    fs.writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n", "utf8");
    fs.chmodSync(binaryPath, 0o755);
    return binaryPath;
}
