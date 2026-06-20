import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
    AiRuntimeStatus,
    AiSessionSnapshot,
    AiSessionUpdate,
    OpenCodeRuntimeSettings,
} from "@shared/ipc";

import { AiService } from "./service";
import type { AiWorkerGateway, NativeAiGateway } from "./contracts";

const OPENCODE_ENV_CREDENTIAL_NAMES = [
    "ANTHROPIC_API_KEY",
    "CODEX_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "OPENAI_API_KEY",
    "OPENCODE_API_KEY",
] as const;
const originalEnvCredentials = Object.fromEntries(
    OPENCODE_ENV_CREDENTIAL_NAMES.map((name) => [name, process.env[name]]),
) as Record<(typeof OPENCODE_ENV_CREDENTIAL_NAMES)[number], string | undefined>;
const originalXdgDataHome = process.env.XDG_DATA_HOME;

beforeEach(() => {
    for (const name of OPENCODE_ENV_CREDENTIAL_NAMES) {
        delete process.env[name];
    }
    delete process.env.XDG_DATA_HOME;
});

afterEach(() => {
    for (const name of OPENCODE_ENV_CREDENTIAL_NAMES) {
        restoreEnv(name, originalEnvCredentials[name]);
    }
    restoreEnv("XDG_DATA_HOME", originalXdgDataHome);
});

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

    it("does not clear an invalidated OpenCode login on an unchanged save", async () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-opencode-unchanged-save-"),
        );

        try {
            const binaryPath = writeExecutable(tempDir, "opencode");
            process.env.XDG_DATA_HOME = path.join(tempDir, "xdg");
            let savedSettings: OpenCodeRuntimeSettings | null = null;
            const currentSettings = createOpenCodeSettings({
                authInvalidatedAtMs: 12345,
                authMethod: "opencode-login",
                binaryPath,
            });
            const service = createService({
                settingsService: createSettingsService({
                    loadOpenCodeRuntimeSettings: vi.fn(() => currentSettings),
                    saveOpenCodeRuntimeSettings: (
                        settings: OpenCodeRuntimeSettings,
                    ) => {
                        savedSettings = settings;
                    },
                }),
            });

            const status = await service.saveOpenCodeRuntimeSettings({
                authMethod: "opencode-login",
                binaryPath,
            });

            expect(savedSettings).toEqual(currentSettings);
            expect(status.authReady).toBe(false);
            expect(status.onboardingRequired).toBe(true);
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("clears OpenCode invalidation when settings change explicitly", async () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-opencode-changed-save-"),
        );

        try {
            const currentBinaryPath = writeExecutable(tempDir, "opencode");
            const nextBinaryPath = writeExecutable(tempDir, "next-opencode");
            process.env.XDG_DATA_HOME = path.join(tempDir, "xdg");
            let savedSettings: OpenCodeRuntimeSettings | null = null;
            const service = createService({
                settingsService: createSettingsService({
                    loadOpenCodeRuntimeSettings: vi.fn(() =>
                        createOpenCodeSettings({
                            authInvalidatedAtMs: 12345,
                            authMethod: "opencode-login",
                            binaryPath: currentBinaryPath,
                        }),
                    ),
                    saveOpenCodeRuntimeSettings: (
                        settings: OpenCodeRuntimeSettings,
                    ) => {
                        savedSettings = settings;
                    },
                }),
            });

            const status = await service.saveOpenCodeRuntimeSettings({
                authMethod: "opencode-login",
                binaryPath: nextBinaryPath,
            });

            expect(savedSettings).toMatchObject({
                authInvalidatedAtMs: null,
                authMethod: "opencode-login",
                binaryPath: nextBinaryPath,
            });
            expect(status.authReady).toBe(true);
            expect(status.onboardingRequired).toBe(false);
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
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
            process.env.XDG_DATA_HOME = path.join(tempDir, "xdg");
            const preparedSnapshot = createSessionSnapshot();
            const prepareSession = vi.fn<AiWorkerGateway["prepareSession"]>(
                () => Promise.resolve(preparedSnapshot),
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

    it("persists native session events through the service snapshot cache", async () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-opencode-native-events-"),
        );

        try {
            const binaryPath = writeExecutable(tempDir, "opencode");
            process.env.OPENCODE_API_KEY = "test-opencode-key";
            const saveSessionSnapshot = vi.fn();
            const onSessionSnapshot = vi.fn();
            const nativeAi: NativeAiGateway = {
                cancelSession: vi.fn(),
                close: vi.fn(),
                closeOwnedByWindow: vi.fn(),
                closeSession: vi.fn(),
                prepareSession: vi.fn(async ({ launch }) => ({
                    ...launch.persistedSnapshot,
                    runtimeSessionId: "runtime-native-1",
                    status: "idle",
                    updatedAt: "2026-06-20T00:00:00.000Z",
                })),
                respondPermission: vi.fn(),
                respondUserInput: vi.fn(),
                sendPrompt: vi.fn(),
                setSessionConfigOption: vi.fn(),
                setSessionMode: vi.fn(),
                setSessionModel: vi.fn(),
                shouldHandleRuntime: vi.fn((runtimeId) => runtimeId === "opencode"),
            };
            const service = createService({
                nativeAi,
                onSessionSnapshot,
                persistence: {
                    saveSessionSnapshot,
                },
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
            service.handleNativeSessionEvent("window-1", {
                kind: "message-started",
                message: {
                    attachments: [],
                    content: "",
                    createdAt: "2026-06-20T00:00:01.000Z",
                    id: "assistant-1",
                    kind: "assistant",
                    status: "streaming",
                },
                messageKind: "assistant",
                origin: "live",
                parentSessionId: null,
                runtimeId: "opencode",
                runtimeSessionId: "runtime-native-1",
                sessionId: "session-opencode",
                updatedAt: "2026-06-20T00:00:01.000Z",
            });
            service.handleNativeSessionEvent("window-1", {
                content: "Hello",
                delta: "Hello",
                kind: "message-delta",
                messageId: "assistant-1",
                messageKind: "assistant",
                origin: "live",
                parentSessionId: null,
                runtimeId: "opencode",
                runtimeSessionId: "runtime-native-1",
                sessionId: "session-opencode",
                updatedAt: "2026-06-20T00:00:02.000Z",
            });

            const persistedSnapshots = saveSessionSnapshot.mock.calls.map(
                ([snapshot]) => snapshot as AiSessionSnapshot,
            );
            expect(persistedSnapshots.at(-1)?.messages).toEqual([
                expect.objectContaining({
                    content: "Hello",
                    id: "assistant-1",
                    status: "streaming",
                }),
            ]);
            expect(onSessionSnapshot).toHaveBeenCalledWith(
                "window-1",
                expect.objectContaining({ kind: "patch" }),
            );
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });
});

function createService(overrides: {
    readonly aiWorker?: AiWorkerGateway;
    readonly nativeAi?: NativeAiGateway;
    readonly onRuntimeStatus?: (status: AiRuntimeStatus) => void;
    readonly onSessionSnapshot?: (
        ownerWindowId: string,
        update: AiSessionUpdate,
    ) => void;
    readonly persistence?: Partial<ConstructorParameters<typeof AiService>[0]["persistence"]>;
    readonly settingsService?: unknown;
}): AiService {
    const persistence = {
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
        ...overrides.persistence,
    };

    return new AiService({
        aiWorker: overrides.aiWorker ?? null,
        nativeAi: overrides.nativeAi ?? null,
        onRuntimeStatus: overrides.onRuntimeStatus ?? vi.fn(),
        onSessionSnapshot: overrides.onSessionSnapshot ?? vi.fn(),
        persistence: persistence as never,
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
        },
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
        loadKiloRuntimeSettings: vi.fn(() => ({
            authInvalidatedAtMs: null,
            authMethod: null,
            binaryPath: null,
            hasKiloApiKey: false,
        })),
        loadOpenCodeRuntimeSettings: vi.fn(() => createOpenCodeSettings()),
        saveClaudeRuntimeSettings: vi.fn(),
        saveCodexRuntimeSettings: vi.fn(),
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
        freezeSession: vi.fn(),
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

function restoreEnv(name: string, value: string | undefined): void {
    if (typeof value === "string") {
        process.env[name] = value;
    } else {
        delete process.env[name];
    }
}
