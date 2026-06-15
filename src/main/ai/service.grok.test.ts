import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
    AiRuntimeStatus,
    AiSessionSnapshot,
    GrokRuntimeSettings,
} from "@shared/ipc";

import { launchTerminalLoginCommand } from "./auth/terminal-login";
import type { AiWorkerGateway } from "./contracts";
import { AiService } from "./service";

const probeGrokCachedTokenAuthMock = vi.hoisted(() =>
    vi.fn(() => Promise.resolve(false)),
);

vi.mock("./auth/terminal-login", () => ({
    launchTerminalLoginCommand: vi.fn(() => Promise.resolve()),
}));

vi.mock("./grok/setup", async (importOriginal) => {
    const original = await importOriginal<typeof import("./grok/setup")>();
    return {
        ...original,
        probeGrokCachedTokenAuth: probeGrokCachedTokenAuthMock,
    };
});

const originalXaiApiKey = process.env.XAI_API_KEY;
const originalGrokBin = process.env.COMANDO_GROK_ACP_BIN;

beforeEach(() => {
    delete process.env.XAI_API_KEY;
    delete process.env.COMANDO_GROK_ACP_BIN;
    vi.mocked(launchTerminalLoginCommand).mockClear();
    probeGrokCachedTokenAuthMock.mockReset();
    probeGrokCachedTokenAuthMock.mockResolvedValue(false);
});

afterEach(() => {
    restoreEnv("XAI_API_KEY", originalXaiApiKey);
    restoreEnv("COMANDO_GROK_ACP_BIN", originalGrokBin);
});

describe("AiService Grok branch", () => {
    it("stores Grok settings, persists the xAI API key, and emits runtime status", async () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-grok-save-"),
        );

        try {
            const binaryPath = writeExecutable(tempDir, "grok");
            let savedSettings: GrokRuntimeSettings | null = null;
            const runtimeStatusEvents: AiRuntimeStatus[] = [];
            const secretValues = new Map<string, string>();
            const service = createService({
                onRuntimeStatus: (status) => runtimeStatusEvents.push(status),
                secretValues,
                settingsService: createSettingsService({
                    loadGrokRuntimeSettings: vi.fn(() =>
                        createGrokSettings(),
                    ),
                    saveGrokRuntimeSettings: (
                        settings: GrokRuntimeSettings,
                    ) => {
                        savedSettings = settings;
                    },
                }),
            });

            const status = await service.saveGrokRuntimeSettings({
                authMethod: "xai-api-key",
                binaryPath,
                xaiApiKey: {
                    kind: "set",
                    value: "xai-key-123",
                },
            });

            expect(savedSettings).toEqual({
                authInvalidatedAtMs: null,
                authMethod: "xai-api-key",
                binaryPath,
                hasXaiApiKey: true,
            });
            expect(secretValues.get("ai.grok:xai_api_key")).toBe(
                "xai-key-123",
            );
            expect(status.runtimeId).toBe("grok");
            expect(status.authCredentialSource).toBe("comando-secret");
            expect(runtimeStatusEvents.at(-1)?.runtimeId).toBe("grok");
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("prefers XAI_API_KEY from the environment over saved Grok settings", async () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-grok-env-"),
        );

        try {
            const binaryPath = writeExecutable(tempDir, "grok");
            process.env.XAI_API_KEY = "env-xai-key";
            const service = createService({
                settingsService: createSettingsService({
                    loadGrokRuntimeSettings: vi.fn(() =>
                        createGrokSettings({
                            authInvalidatedAtMs: 12345,
                            authMethod: "grok-login",
                            binaryPath,
                        }),
                    ),
                }),
            });

            const status = await service.getRuntimeStatus("grok");

            expect(status.authMethod).toBe("xai-api-key");
            expect(status.authCredentialSource).toBe("environment");
            expect(status.authReady).toBe(true);
            expect(probeGrokCachedTokenAuthMock).not.toHaveBeenCalled();
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("keeps saved Grok login pending until local credentials are verified", async () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-grok-pending-login-"),
        );

        try {
            const binaryPath = writeExecutable(tempDir, "grok");
            let savedSettings: GrokRuntimeSettings | null = null;
            const service = createService({
                settingsService: createSettingsService({
                    loadGrokRuntimeSettings: vi.fn(() =>
                        createGrokSettings(),
                    ),
                    saveGrokRuntimeSettings: (
                        settings: GrokRuntimeSettings,
                    ) => {
                        savedSettings = settings;
                    },
                }),
            });

            const status = await service.saveGrokRuntimeSettings({
                authMethod: "grok-login",
                binaryPath,
                xaiApiKey: {
                    kind: "unchanged",
                },
            });

            expect(savedSettings).toMatchObject({
                authMethod: "grok-login",
                binaryPath,
                hasXaiApiKey: false,
            });
            expect(
                (savedSettings as unknown as GrokRuntimeSettings)
                    .authInvalidatedAtMs,
            ).toEqual(expect.any(Number));
            expect(status).toMatchObject({
                authCredentialSource: "none",
                authMethod: null,
                authReady: false,
                onboardingRequired: true,
                runtimeId: "grok",
            });
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("does not treat XAI_API_KEY as verified Grok login state", async () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-grok-env-login-"),
        );

        try {
            const binaryPath = writeExecutable(tempDir, "grok");
            process.env.XAI_API_KEY = "env-xai-key";
            let savedSettings: GrokRuntimeSettings | null = null;
            const service = createService({
                settingsService: createSettingsService({
                    loadGrokRuntimeSettings: vi.fn(() =>
                        createGrokSettings(),
                    ),
                    saveGrokRuntimeSettings: (
                        settings: GrokRuntimeSettings,
                    ) => {
                        savedSettings = settings;
                    },
                }),
            });

            const status = await service.saveGrokRuntimeSettings({
                authMethod: "grok-login",
                binaryPath,
                xaiApiKey: {
                    kind: "unchanged",
                },
            });

            expect(
                (savedSettings as unknown as GrokRuntimeSettings)
                    .authInvalidatedAtMs,
            ).toEqual(expect.any(Number));
            expect(status).toMatchObject({
                authCredentialSource: "environment",
                authMethod: "xai-api-key",
                authReady: true,
                runtimeId: "grok",
            });
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("trusts saved Grok login when local credentials are already present", async () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-grok-trusted-login-"),
        );
        const originalHome = process.env.HOME;
        const originalUserProfile = process.env.USERPROFILE;

        try {
            const binaryPath = writeExecutable(tempDir, "grok");
            writeGrokAuthStore(tempDir);
            process.env.HOME = tempDir;
            delete process.env.USERPROFILE;
            let savedSettings: GrokRuntimeSettings | null = null;
            const service = createService({
                settingsService: createSettingsService({
                    loadGrokRuntimeSettings: vi.fn(() =>
                        createGrokSettings({
                            authInvalidatedAtMs: Date.now() - 60_000,
                        }),
                    ),
                    saveGrokRuntimeSettings: (
                        settings: GrokRuntimeSettings,
                    ) => {
                        savedSettings = settings;
                    },
                }),
            });

            const status = await service.saveGrokRuntimeSettings({
                authMethod: "grok-login",
                binaryPath,
                xaiApiKey: {
                    kind: "unchanged",
                },
            });

            expect(savedSettings).toMatchObject({
                authInvalidatedAtMs: null,
                authMethod: "grok-login",
                binaryPath,
            });
            expect(status).toMatchObject({
                authCredentialSource: "external-runtime",
                authMethod: "grok-login",
                authReady: true,
                onboardingRequired: false,
                runtimeId: "grok",
            });
        } finally {
            restoreEnv("HOME", originalHome);
            restoreEnv("USERPROFILE", originalUserProfile);
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("hydrates Grok login from the ACP cached token probe", async () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-grok-probe-"),
        );

        try {
            const binaryPath = writeExecutable(tempDir, "grok");
            const invalidatedAtMs = Date.now();
            let savedSettings: GrokRuntimeSettings | null = null;
            const runtimeStatusEvents: AiRuntimeStatus[] = [];
            probeGrokCachedTokenAuthMock.mockResolvedValueOnce(true);

            const service = createService({
                onRuntimeStatus: (status) => runtimeStatusEvents.push(status),
                settingsService: createSettingsService({
                    loadGrokRuntimeSettings: vi.fn(() =>
                        createGrokSettings({
                            authInvalidatedAtMs: invalidatedAtMs,
                            binaryPath,
                        }),
                    ),
                    saveGrokRuntimeSettings: (
                        settings: GrokRuntimeSettings,
                    ) => {
                        savedSettings = settings;
                    },
                }),
            });

            const status = await service.getRuntimeStatus("grok");

            expect(probeGrokCachedTokenAuthMock).toHaveBeenCalledWith(
                expect.objectContaining({
                    authInvalidatedAtMs: invalidatedAtMs,
                    binaryPath,
                }),
                expect.any(Object),
            );
            expect(savedSettings).toMatchObject({
                authInvalidatedAtMs: null,
                authMethod: "grok-login",
                binaryPath,
            });
            expect(status.authMethod).toBe("grok-login");
            expect(status.authCredentialSource).toBe("external-runtime");
            expect(status.authReady).toBe(true);
            expect(status.onboardingRequired).toBe(false);
            expect(runtimeStatusEvents.at(-1)?.authMethod).toBe("grok-login");
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("opens Grok login in a terminal and marks previous login state invalid", async () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-grok-login-"),
        );

        try {
            const binaryPath = writeExecutable(tempDir, "grok");
            let savedSettings: GrokRuntimeSettings | null = null;
            const service = createService({
                settingsService: createSettingsService({
                    loadGrokRuntimeSettings: vi.fn(() =>
                        createGrokSettings({ binaryPath }),
                    ),
                    saveGrokRuntimeSettings: (
                        settings: GrokRuntimeSettings,
                    ) => {
                        savedSettings = settings;
                    },
                }),
            });

            await service.launchRuntimeAuth({
                methodId: "grok-login",
                projectId: null,
                runtimeId: "grok",
                worktreeId: null,
            });

            expect(savedSettings).toMatchObject({
                authMethod: "grok-login",
                binaryPath,
            });
            const nextSettings = savedSettings as unknown as GrokRuntimeSettings;
            expect(nextSettings.authInvalidatedAtMs).toEqual(
                expect.any(Number),
            );
            expect(launchTerminalLoginCommand).toHaveBeenCalledWith(
                expect.objectContaining({
                    commandParts: [binaryPath, "login"],
                    scriptPrefix: "comando-grok-login",
                }),
            );
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("rejects terminal login for the xAI API key method", async () => {
        const service = createService({
            settingsService: createSettingsService({
                loadGrokRuntimeSettings: vi.fn(() =>
                    createGrokSettings({ authMethod: "xai-api-key" }),
                ),
            }),
        });

        await expect(
            service.launchRuntimeAuth({
                methodId: "xai-api-key",
                projectId: null,
                runtimeId: "grok",
                worktreeId: null,
            }),
        ).rejects.toThrow(
            "The xAI API key does not need a login terminal. Save the API key from settings.",
        );
        expect(launchTerminalLoginCommand).not.toHaveBeenCalled();
    });

    it("disconnects Grok by clearing the API key and invalidating external login", async () => {
        let savedSettings: GrokRuntimeSettings | null = null;
        const secretValues = new Map<string, string>([
            ["ai.grok:xai_api_key", "xai-key"],
        ]);
        const service = createService({
            secretValues,
            settingsService: createSettingsService({
                loadGrokRuntimeSettings: vi.fn(() =>
                    createGrokSettings({
                        authMethod: "grok-login",
                        binaryPath: "/opt/homebrew/bin/grok",
                        hasXaiApiKey: true,
                    }),
                ),
                saveGrokRuntimeSettings: (settings: GrokRuntimeSettings) => {
                    savedSettings = settings;
                },
            }),
        });

        await service.disconnectRuntimeAuth({ runtimeId: "grok" });

        expect(savedSettings).not.toBeNull();
        const nextSettings = savedSettings as unknown as GrokRuntimeSettings;
        expect(nextSettings.binaryPath).toBe("/opt/homebrew/bin/grok");
        expect(nextSettings.authMethod).toBeNull();
        expect(nextSettings.hasXaiApiKey).toBe(false);
        expect(nextSettings.authInvalidatedAtMs).toEqual(expect.any(Number));
        expect(secretValues.has("ai.grok:xai_api_key")).toBe(false);
    });

    it("prepares Grok sessions with ACP launch details and stored xAI API key", async () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-grok-session-"),
        );

        try {
            const binaryPath = writeExecutable(tempDir, "grok");
            const preparedSnapshot = createSessionSnapshot();
            const prepareSession = vi.fn<AiWorkerGateway["prepareSession"]>(
                () => Promise.resolve(preparedSnapshot),
            );
            const aiWorker = createAiWorker({ prepareSession });
            const service = createService({
                aiWorker,
                secretValues: new Map([["ai.grok:xai_api_key", "xai-key"]]),
                settingsService: createSettingsService({
                    loadGrokRuntimeSettings: vi.fn(() =>
                        createGrokSettings({
                            authMethod: "xai-api-key",
                            binaryPath,
                            hasXaiApiKey: true,
                        }),
                    ),
                }),
            });

            await service.prepareSession(
                {
                    projectId: null,
                    runtimeId: "grok",
                    sessionId: "session-grok",
                    title: "Grok 1",
                    worktreeId: null,
                },
                "window-1",
            );

            const launch = prepareSession.mock.calls[0][0].launch;
            expect(launch.resolvedRuntime.executable).toBe(binaryPath);
            expect(launch.resolvedRuntime.args).toEqual([
                "--no-auto-update",
                "agent",
                "stdio",
            ]);
            expect(launch.resolvedRuntime.command).toBe(
                `${binaryPath} --no-auto-update agent stdio`,
            );
            expect(launch.resolvedRuntime.env.XAI_API_KEY).toBe("xai-key");
            expect(launch.resolvedRuntime.status.runtimeId).toBe("grok");
            expect(launch.resolvedRuntime.status.onboardingRequired).toBe(
                false,
            );
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("hydrates Grok login during session preparation after terminal login", async () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-grok-prepare-probe-"),
        );

        try {
            const binaryPath = writeExecutable(tempDir, "grok");
            const invalidatedAtMs = Date.now();
            let grokSettings = createGrokSettings({
                authInvalidatedAtMs: invalidatedAtMs,
                authMethod: "grok-login",
                binaryPath,
            });
            const preparedSnapshot = createSessionSnapshot();
            const prepareSession = vi.fn<AiWorkerGateway["prepareSession"]>(
                () => Promise.resolve(preparedSnapshot),
            );
            const aiWorker = createAiWorker({ prepareSession });
            probeGrokCachedTokenAuthMock.mockResolvedValueOnce(true);

            const service = createService({
                aiWorker,
                settingsService: createSettingsService({
                    loadGrokRuntimeSettings: vi.fn(() => grokSettings),
                    saveGrokRuntimeSettings: (
                        settings: GrokRuntimeSettings,
                    ) => {
                        grokSettings = settings;
                    },
                }),
            });

            await service.prepareSession(
                {
                    projectId: null,
                    runtimeId: "grok",
                    sessionId: "session-grok",
                    title: "Grok 1",
                    worktreeId: null,
                },
                "window-1",
            );

            expect(probeGrokCachedTokenAuthMock).toHaveBeenCalledWith(
                expect.objectContaining({
                    authInvalidatedAtMs: invalidatedAtMs,
                    authMethod: "grok-login",
                    binaryPath,
                }),
                expect.any(Object),
            );
            expect(grokSettings).toMatchObject({
                authInvalidatedAtMs: null,
                authMethod: "grok-login",
                binaryPath,
            });
            expect(prepareSession).toHaveBeenCalledOnce();
            expect(
                prepareSession.mock.calls[0][0].launch.resolvedRuntime.status
                    .onboardingRequired,
            ).toBe(false);
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("invalidates Grok login after an authentication error", () => {
        let savedSettings: GrokRuntimeSettings | null = null;
        const service = createService({
            settingsService: createSettingsService({
                loadGrokRuntimeSettings: vi.fn(() =>
                    createGrokSettings({
                        authMethod: "grok-login",
                        binaryPath: "/opt/homebrew/bin/grok",
                    }),
                ),
                saveGrokRuntimeSettings: (settings: GrokRuntimeSettings) => {
                    savedSettings = settings;
                },
            }),
        });

        service.handleWorkerSessionSnapshot("window-1", {
            kind: "snapshot",
            snapshot: {
                ...createSessionSnapshot(),
                lastError: "Unauthorized: cached_token expired",
            },
        });

        expect(savedSettings).toMatchObject({
            authMethod: "grok-login",
            binaryPath: "/opt/homebrew/bin/grok",
        });
        const nextSettings = savedSettings as unknown as GrokRuntimeSettings;
        expect(nextSettings.authInvalidatedAtMs).toEqual(expect.any(Number));
    });

    it("clears a stored xAI API key after a Grok API key authentication error", async () => {
        let savedSettings: GrokRuntimeSettings | null = null;
        const runtimeStatusEvents: AiRuntimeStatus[] = [];
        const secretValues = new Map<string, string>([
            ["ai.grok:xai_api_key", "invalid-xai-key"],
        ]);
        const service = createService({
            onRuntimeStatus: (status) => runtimeStatusEvents.push(status),
            secretValues,
            settingsService: createSettingsService({
                loadGrokRuntimeSettings: vi.fn(() =>
                    createGrokSettings({
                        authMethod: "xai-api-key",
                        binaryPath: "/opt/homebrew/bin/grok",
                        hasXaiApiKey: true,
                    }),
                ),
                saveGrokRuntimeSettings: (settings: GrokRuntimeSettings) => {
                    savedSettings = settings;
                },
            }),
        });

        service.handleWorkerSessionSnapshot("window-1", {
            kind: "snapshot",
            snapshot: {
                ...createSessionSnapshot(),
                lastError: "invalid api key",
            },
        });
        await flushAsyncWork();

        expect(savedSettings).toMatchObject({
            authMethod: null,
            hasXaiApiKey: false,
        });
        expect(secretValues.has("ai.grok:xai_api_key")).toBe(false);
        expect(runtimeStatusEvents.at(-1)).toMatchObject({
            authCredentialSource: "none",
            authMethod: null,
            authReady: false,
            runtimeId: "grok",
        });
    });

    it("does not rewrite environment xAI API key errors to Grok login", () => {
        process.env.XAI_API_KEY = "invalid-env-key";
        let savedSettings: GrokRuntimeSettings | null = null;
        const service = createService({
            settingsService: createSettingsService({
                loadGrokRuntimeSettings: vi.fn(() =>
                    createGrokSettings({
                        authMethod: "xai-api-key",
                        binaryPath: "/opt/homebrew/bin/grok",
                    }),
                ),
                saveGrokRuntimeSettings: (settings: GrokRuntimeSettings) => {
                    savedSettings = settings;
                },
            }),
        });

        service.handleWorkerSessionSnapshot("window-1", {
            kind: "snapshot",
            snapshot: {
                ...createSessionSnapshot(),
                lastError: "Unauthorized: invalid api key",
            },
        });

        expect(savedSettings).toBeNull();
    });
});

function createService(overrides: {
    readonly aiWorker?: AiWorkerGateway;
    readonly onRuntimeStatus?: (status: AiRuntimeStatus) => void;
    readonly secretValues?: Map<string, string>;
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
        secretStore: createSecretStore(
            overrides.secretValues ?? new Map<string, string>(),
        ),
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
        loadGrokRuntimeSettings: vi.fn(() => createGrokSettings()),
        loadKiloRuntimeSettings: vi.fn(() => ({
            authInvalidatedAtMs: null,
            authMethod: null,
            binaryPath: null,
            hasKiloApiKey: false,
        })),
        loadOpenCodeRuntimeSettings: vi.fn(() => ({
            authInvalidatedAtMs: null,
            authMethod: null,
            binaryPath: null,
        })),
        saveClaudeRuntimeSettings: vi.fn(),
        saveCodexRuntimeSettings: vi.fn(),
        saveGeminiRuntimeSettings: vi.fn(),
        saveGrokRuntimeSettings: vi.fn(),
        saveKiloRuntimeSettings: vi.fn(),
        saveOpenCodeRuntimeSettings: vi.fn(),
        ...overrides,
    } as never;
}

function createSecretStore(secretValues: Map<string, string>) {
    return {
        cacheSecretPatches: vi.fn(
            (
                patches: readonly {
                    readonly key: string;
                    readonly value: string | null;
                }[],
            ) => {
                for (const patch of patches) {
                    const parsed = parseTestSecretStorageKey(patch.key);
                    if (!parsed) {
                        continue;
                    }

                    const normalized = patch.value?.trim() ?? "";
                    const key = `${parsed.namespace}:${parsed.secretId}`;
                    if (!normalized) {
                        secretValues.delete(key);
                        continue;
                    }

                    secretValues.set(key, normalized);
                }
            },
        ),
        getStorageStatus: vi.fn(() => ({
            encryptionAvailable: true,
            isWeakBackend: false,
            message: null,
            platform: process.platform,
            selectedBackend: null,
        })),
        loadSecret: (namespace: string, secretId: string) =>
            secretValues.get(`${namespace}:${secretId}`) ?? null,
        saveSecret: (
            namespace: string,
            secretId: string,
            value: string | null,
        ) => {
            const key = `${namespace}:${secretId}`;
            const normalized = value?.trim() ?? "";
            if (!normalized) {
                secretValues.delete(key);
                return;
            }

            secretValues.set(key, normalized);
        },
    };
}

function parseTestSecretStorageKey(
    key: string,
): { readonly namespace: string; readonly secretId: string } | null {
    const prefix = "secret.";
    if (!key.startsWith(prefix)) {
        return null;
    }

    const body = key.slice(prefix.length);
    const separatorIndex = body.lastIndexOf(".");
    if (separatorIndex <= 0 || separatorIndex === body.length - 1) {
        return null;
    }

    return {
        namespace: body.slice(0, separatorIndex),
        secretId: body.slice(separatorIndex + 1),
    };
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

function createGrokSettings(
    overrides: Partial<GrokRuntimeSettings> = {},
): GrokRuntimeSettings {
    return {
        authInvalidatedAtMs: null,
        authMethod: null,
        binaryPath: null,
        hasXaiApiKey: false,
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
        runtimeId: "grok",
        runtimeSessionId: "runtime-grok",
        sessionId: "session-grok",
        status: "idle",
        title: "Grok 1",
        toolActivity: [],
        tokenUsage: null,
        trackedFiles: [],
        updatedAt: new Date().toISOString(),
        worktreeId: null,
    };
}

function writeExecutable(directory: string, name: string): string {
    const binaryPath = path.join(directory, name);
    fs.writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n", "utf8");
    fs.chmodSync(binaryPath, 0o755);
    return binaryPath;
}

function writeGrokAuthStore(homeDir: string): void {
    const authDir = path.join(homeDir, ".grok", "auth");
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(path.join(authDir, "token"), "cached-token", "utf8");
}

function restoreEnv(name: string, value: string | undefined): void {
    if (value === undefined) {
        delete process.env[name];
        return;
    }

    process.env[name] = value;
}

async function flushAsyncWork(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}
