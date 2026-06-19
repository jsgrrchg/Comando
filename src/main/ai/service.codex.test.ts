import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    AiRuntimeStatus,
    AiSessionSnapshot,
    CodexRuntimeSettings,
} from "@shared/ipc";

import { AiService } from "./service";

const initializeMock = vi.hoisted(() =>
    vi.fn(() =>
        Promise.resolve({
            authMethods: [{ id: "codex-api-key" }, { id: "chatgpt" }],
        }),
    ),
);
const authenticateMock = vi.hoisted(() => vi.fn(() => Promise.resolve({})));
const logoutMock = vi.hoisted(() => vi.fn(() => Promise.resolve({})));
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("@agentclientprotocol/sdk", () => ({
    ClientSideConnection: class MockClientSideConnection {
        initialize = initializeMock;
        authenticate = authenticateMock;
        unstable_logout = logoutMock;
    },
    PROTOCOL_VERSION: "test-protocol-version",
    ndJsonStream: vi.fn(() => ({})),
}));

vi.mock("node:child_process", () => ({
    spawn: spawnMock,
}));

beforeEach(() => {
    initializeMock.mockReset();
    initializeMock.mockResolvedValue({
        authMethods: [{ id: "codex-api-key" }, { id: "chatgpt" }],
    });
    authenticateMock.mockReset();
    authenticateMock.mockResolvedValue({});
    logoutMock.mockReset();
    logoutMock.mockResolvedValue({});
    spawnMock.mockReset();
    spawnMock.mockImplementation(createMockChildProcess);
});

describe("AiService Codex branch", () => {
    it("stores Codex settings, persists only one API key, and emits runtime status", async () => {
        let savedSettings: CodexRuntimeSettings | null = null;
        const runtimeStatusEvents: AiRuntimeStatus[] = [];
        const secretValues = new Map<string, string>();

        const settingsService = {
            loadClaudeRuntimeSettings: vi.fn(() => ({
                authInvalidatedAtMs: null,
                authMethod: null,
                binaryPath: null,
                gatewayBaseUrl: null,
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
                binaryPath: null,
            })),
            saveClaudeRuntimeSettings: vi.fn(),
            saveCodexRuntimeSettings: (settings: CodexRuntimeSettings) => {
                savedSettings = settings;
            },
            saveKiloRuntimeSettings: vi.fn(),
        };
        const secretStore = {
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
        const service = new AiService({
            onRuntimeStatus: (status) => runtimeStatusEvents.push(status),
            onSessionSnapshot: vi.fn(),
            persistence: {
                loadLatestRuntimeCatalog: vi.fn(() => null),
                loadSessionSnapshot: vi.fn(() => null),
                saveSessionSnapshot: vi.fn(),
            } as never,
            projectService: {
                getProjectRootPath: vi.fn(() => process.cwd()),
            } as never,
            secretStore: secretStore,
            settingsService: settingsService as never,
        });

        const status = await service.saveCodexRuntimeSettings({
            authMethod: "openai-api-key",
            binaryPath: "/usr/local/bin/codex-acp",
            codexApiKey: {
                kind: "set",
                value: "codex-secret",
            },
            openaiApiKey: {
                kind: "set",
                value: "openai-secret",
            },
        });

        expect(savedSettings).toEqual({
            authMethod: "openai-api-key",
            binaryPath: "/usr/local/bin/codex-acp",
            hasCodexApiKey: false,
            hasOpenAiApiKey: true,
        });
        expect(secretValues.get("ai.codex:openai_api_key")).toBe(
            "openai-secret",
        );
        expect(secretValues.has("ai.codex:codex_api_key")).toBe(false);
        expect(status.runtimeId).toBe("codex");
        expect(runtimeStatusEvents.at(-1)?.runtimeId).toBe("codex");
    });

    it("updates the secret cache after transactional Codex auth saves", async () => {
        let savedSettings: CodexRuntimeSettings | null = null;
        const secretValues = new Map<string, string | null>();
        const saveCodexAuth = vi.fn(
            (settings: CodexRuntimeSettings) => {
                savedSettings = settings;
            },
        );
        const saveSecret = vi.fn();
        const cacheSecretPatches = vi.fn(
            (
                secrets: readonly {
                    readonly key: string;
                    readonly value: string | null;
                }[],
            ) => {
                for (const secret of secrets) {
                    secretValues.set(secret.key, secret.value);
                }
            },
        );
        const service = new AiService({
            onRuntimeStatus: vi.fn(),
            onSessionSnapshot: vi.fn(),
            persistence: {
                loadLatestRuntimeCatalog: vi.fn(() => null),
                loadSessionSnapshot: vi.fn(() => null),
                saveSessionSnapshot: vi.fn(),
            } as never,
            projectService: {
                getProjectRootPath: vi.fn(() => process.cwd()),
            } as never,
            secretStore: {
                cacheSecretPatches,
                loadSecret: (namespace: string, secretId: string) =>
                    secretValues.get(`secret.${namespace}.${secretId}`) ?? null,
                saveSecret,
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
                    authMethod: null,
                    binaryPath: null,
                    hasCodexApiKey: false,
                    hasOpenAiApiKey: false,
                })),
                loadKiloRuntimeSettings: vi.fn(() => ({
                    authInvalidatedAtMs: null,
                    binaryPath: null,
                })),
                saveClaudeRuntimeSettings: vi.fn(),
                saveCodexAuth,
                saveCodexRuntimeSettings: vi.fn(),
                saveKiloRuntimeSettings: vi.fn(),
            } as never,
        });

        await service.saveCodexRuntimeSettings({
            authMethod: "openai-api-key",
            binaryPath: null,
            codexApiKey: {
                kind: "unchanged",
            },
            openaiApiKey: {
                kind: "set",
                value: "openai-secret",
            },
        });

        expect(saveCodexAuth).toHaveBeenCalledOnce();
        expect(saveSecret).not.toHaveBeenCalled();
        expect(cacheSecretPatches).toHaveBeenCalledOnce();
        expect(secretValues.get("secret.ai.codex.openai_api_key")).toBe(
            "openai-secret",
        );
        expect(savedSettings).toEqual({
            authMethod: "openai-api-key",
            binaryPath: null,
            hasCodexApiKey: false,
            hasOpenAiApiKey: true,
        });
    });

    it("preserves stored Codex keys when saving settings without an explicit auth method", async () => {
        let savedSettings: CodexRuntimeSettings | null = null;
        const secretValues = new Map<string, string>([
            ["ai.codex:codex_api_key", "codex-secret"],
        ]);
        const service = new AiService({
            onRuntimeStatus: vi.fn(),
            onSessionSnapshot: vi.fn(),
            persistence: {
                loadLatestRuntimeCatalog: vi.fn(() => null),
                loadSessionSnapshot: vi.fn(() => null),
                saveSessionSnapshot: vi.fn(),
            } as never,
            projectService: {
                getProjectRootPath: vi.fn(() => process.cwd()),
            } as never,
            secretStore: {
                loadSecret: (namespace: string, secretId: string) =>
                    secretValues.get(`${namespace}:${secretId}`) ?? null,
                saveSecret: (
                    namespace: string,
                    secretId: string,
                    value: string | null,
                ) => {
                    const key = `${namespace}:${secretId}`;
                    if (!value?.trim()) {
                        secretValues.delete(key);
                        return;
                    }

                    secretValues.set(key, value.trim());
                },
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
                    authMethod: null,
                    binaryPath: null,
                    hasCodexApiKey: true,
                    hasOpenAiApiKey: false,
                })),
                loadKiloRuntimeSettings: vi.fn(() => ({
                    authInvalidatedAtMs: null,
                    binaryPath: null,
                })),
                saveClaudeRuntimeSettings: vi.fn(),
                saveCodexRuntimeSettings: (settings: CodexRuntimeSettings) => {
                    savedSettings = settings;
                },
                saveKiloRuntimeSettings: vi.fn(),
            } as never,
        });

        const status = await service.saveCodexRuntimeSettings({
            authMethod: null,
            binaryPath: "/usr/local/bin/codex-acp",
            codexApiKey: {
                kind: "unchanged",
            },
            openaiApiKey: {
                kind: "unchanged",
            },
        });

        expect(secretValues.get("ai.codex:codex_api_key")).toBe("codex-secret");
        expect(savedSettings).toEqual({
            authMethod: null,
            binaryPath: "/usr/local/bin/codex-acp",
            hasCodexApiKey: true,
            hasOpenAiApiKey: false,
        });
        expect(status.authMethod).toBe("codex-api-key");
        expect(status.authCredentialSource).toBe("comando-secret");
    });

    it("propagates an error when secure storage is unavailable", async () => {
        const service = new AiService({
            onRuntimeStatus: vi.fn(),
            onSessionSnapshot: vi.fn(),
            persistence: {
                loadLatestRuntimeCatalog: vi.fn(() => null),
                loadSessionSnapshot: vi.fn(() => null),
                saveSessionSnapshot: vi.fn(),
            } as never,
            projectService: {
                getProjectRootPath: vi.fn(() => process.cwd()),
            } as never,
            secretStore: {
                loadSecret: vi.fn(() => null),
                saveSecret: vi.fn(() => {
                    throw new Error(
                        "Secure secret storage is unavailable on this machine.",
                    );
                }),
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
                    authMethod: null,
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
            service.saveCodexRuntimeSettings({
                authMethod: "codex-api-key",
                binaryPath: null,
                codexApiKey: {
                    kind: "set",
                    value: "codex-secret",
                },
                openaiApiKey: {
                    kind: "unchanged",
                },
            }),
        ).rejects.toThrowError(
            "Secure secret storage is unavailable on this machine.",
        );
    });

    it("disconnects Codex without calling remote logout and preserves binary path", async () => {
        let savedSettings: CodexRuntimeSettings | null = null;
        const secretValues = new Map<string, string>([
            ["ai.codex:codex_api_key", "codex-secret"],
            ["ai.codex:openai_api_key", "openai-secret"],
        ]);
        const service = new AiService({
            onRuntimeStatus: vi.fn(),
            onSessionSnapshot: vi.fn(),
            persistence: {
                loadLatestRuntimeCatalog: vi.fn(() => null),
                loadSessionSnapshot: vi.fn(() => null),
                saveSessionSnapshot: vi.fn(),
            } as never,
            projectService: {
                getProjectRootPath: vi.fn(() => process.cwd()),
            } as never,
            secretStore: {
                loadSecret: (namespace: string, secretId: string) =>
                    secretValues.get(`${namespace}:${secretId}`) ?? null,
                saveSecret: (
                    namespace: string,
                    secretId: string,
                    value: string | null,
                ) => {
                    const key = `${namespace}:${secretId}`;
                    if (!value?.trim()) {
                        secretValues.delete(key);
                    } else {
                        secretValues.set(key, value.trim());
                    }
                },
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
                    authMethod: "codex-api-key",
                    binaryPath: "/usr/local/bin/codex-acp",
                    hasCodexApiKey: true,
                    hasOpenAiApiKey: false,
                })),
                loadKiloRuntimeSettings: vi.fn(() => ({
                    authInvalidatedAtMs: null,
                    binaryPath: null,
                })),
                saveClaudeRuntimeSettings: vi.fn(),
                saveCodexRuntimeSettings: (settings: CodexRuntimeSettings) => {
                    savedSettings = settings;
                },
                saveKiloRuntimeSettings: vi.fn(),
            } as never,
        });

        const status = await service.disconnectRuntimeAuth({
            runtimeId: "codex",
        });

        expect(savedSettings).toEqual({
            authMethod: null,
            binaryPath: "/usr/local/bin/codex-acp",
            hasCodexApiKey: false,
            hasOpenAiApiKey: false,
        });
        expect(secretValues.size).toBe(0);
        expect(status.runtimeId).toBe("codex");
    });

    it("rejects Codex provider logout for API key auth without clearing local secrets", async () => {
        const secretValues = new Map<string, string>([
            ["ai.codex:codex_api_key", "codex-secret"],
        ]);
        const saveCodexRuntimeSettings = vi.fn();
        const service = new AiService({
            onRuntimeStatus: vi.fn(),
            onSessionSnapshot: vi.fn(),
            persistence: {
                loadLatestRuntimeCatalog: vi.fn(() => null),
                loadSessionSnapshot: vi.fn(() => null),
                saveSessionSnapshot: vi.fn(),
            } as never,
            projectService: {
                getProjectRootPath: vi.fn(() => process.cwd()),
            } as never,
            secretStore: {
                loadSecret: (namespace: string, secretId: string) =>
                    secretValues.get(`${namespace}:${secretId}`) ?? null,
                saveSecret: (
                    namespace: string,
                    secretId: string,
                    value: string | null,
                ) => {
                    const key = `${namespace}:${secretId}`;
                    if (!value?.trim()) {
                        secretValues.delete(key);
                    } else {
                        secretValues.set(key, value.trim());
                    }
                },
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
                    authMethod: "codex-api-key",
                    binaryPath: null,
                    hasCodexApiKey: true,
                    hasOpenAiApiKey: false,
                })),
                loadKiloRuntimeSettings: vi.fn(() => ({
                    authInvalidatedAtMs: null,
                    binaryPath: null,
                })),
                saveClaudeRuntimeSettings: vi.fn(),
                saveCodexRuntimeSettings,
                saveKiloRuntimeSettings: vi.fn(),
            } as never,
        });

        await expect(
            service.logoutRuntimeAuth({ runtimeId: "codex" }),
        ).rejects.toThrow("Use Disconnect from Comando");
        expect(secretValues.get("ai.codex:codex_api_key")).toBe(
            "codex-secret",
        );
        expect(saveCodexRuntimeSettings).not.toHaveBeenCalled();
    });

    it("rejects Codex runtime auth when the child process fails to spawn", async () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-codex-auth-spawn-"),
        );
        const executablePath = path.join(tempDir, "codex-acp");
        fs.writeFileSync(executablePath, "#!/bin/sh\nexit 0\n", "utf8");
        fs.chmodSync(executablePath, 0o755);
        const child = createMockChildProcess();
        spawnMock.mockReturnValueOnce(child);
        initializeMock.mockImplementationOnce(
            () => new Promise(() => undefined),
        );
        const service = new AiService({
            onRuntimeStatus: vi.fn(),
            onSessionSnapshot: vi.fn(),
            persistence: {
                loadLatestRuntimeCatalog: vi.fn(() => null),
                loadSessionSnapshot: vi.fn(() => null),
                saveSessionSnapshot: vi.fn(),
            } as never,
            projectService: {
                getProjectRootPath: vi.fn(() => tempDir),
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
                    authMethod: null,
                    binaryPath: executablePath,
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

        const result = service.launchRuntimeAuth({
            methodId: "codex-api-key",
            projectId: null,
            runtimeId: "codex",
        });
        queueMicrotask(() => {
            child.emit("error", new Error("spawn ENOENT"));
        });

        try {
            await expect(result).rejects.toThrow("spawn ENOENT");
            expect(child.kill).toHaveBeenCalled();
            expect(child.stdin.destroyed).toBe(true);
            expect(child.stdout.destroyed).toBe(true);
            expect(child.stderr.destroyed).toBe(true);
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("clears the opposing key when changing Codex preferred method", async () => {
        let savedSettings: CodexRuntimeSettings | null = null;
        const secretValues = new Map<string, string>([
            ["ai.codex:codex_api_key", "codex-secret"],
        ]);
        const service = new AiService({
            onRuntimeStatus: vi.fn(),
            onSessionSnapshot: vi.fn(),
            persistence: {
                loadLatestRuntimeCatalog: vi.fn(() => null),
                loadSessionSnapshot: vi.fn(() => null),
                saveSessionSnapshot: vi.fn(),
            } as never,
            projectService: {
                getProjectRootPath: vi.fn(() => process.cwd()),
            } as never,
            secretStore: {
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
                    authMethod: "codex-api-key",
                    binaryPath: null,
                    hasCodexApiKey: true,
                    hasOpenAiApiKey: false,
                })),
                loadKiloRuntimeSettings: vi.fn(() => ({
                    authInvalidatedAtMs: null,
                    binaryPath: null,
                })),
                saveClaudeRuntimeSettings: vi.fn(),
                saveCodexRuntimeSettings: (settings: CodexRuntimeSettings) => {
                    savedSettings = settings;
                },
                saveKiloRuntimeSettings: vi.fn(),
            } as never,
        });

        await service.saveCodexRuntimeSettings({
            authMethod: "openai-api-key",
            binaryPath: null,
            codexApiKey: { kind: "unchanged" },
            openaiApiKey: { kind: "unchanged" },
        });

        expect(savedSettings).toEqual({
            authMethod: "openai-api-key",
            binaryPath: null,
            hasCodexApiKey: false,
            hasOpenAiApiKey: false,
        });
        expect(secretValues.size).toBe(0);
    });

    it("clears saved API keys when switching to ChatGPT", async () => {
        let savedSettings: CodexRuntimeSettings | null = null;
        const secretValues = new Map<string, string>([
            ["ai.codex:codex_api_key", "codex-secret"],
        ]);
        const service = new AiService({
            onRuntimeStatus: vi.fn(),
            onSessionSnapshot: vi.fn(),
            persistence: {
                loadLatestRuntimeCatalog: vi.fn(() => null),
                loadSessionSnapshot: vi.fn(() => null),
                saveSessionSnapshot: vi.fn(),
            } as never,
            projectService: {
                getProjectRootPath: vi.fn(() => process.cwd()),
            } as never,
            secretStore: {
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
                    authMethod: "codex-api-key",
                    binaryPath: null,
                    hasCodexApiKey: true,
                    hasOpenAiApiKey: false,
                })),
                loadKiloRuntimeSettings: vi.fn(() => ({
                    authInvalidatedAtMs: null,
                    binaryPath: null,
                })),
                saveClaudeRuntimeSettings: vi.fn(),
                saveCodexRuntimeSettings: (settings: CodexRuntimeSettings) => {
                    savedSettings = settings;
                },
                saveKiloRuntimeSettings: vi.fn(),
            } as never,
        });

        await service.saveCodexRuntimeSettings({
            authMethod: "chatgpt",
            binaryPath: null,
            codexApiKey: { kind: "unchanged" },
            openaiApiKey: { kind: "unchanged" },
        });

        expect(savedSettings).toEqual({
            authMethod: "chatgpt",
            binaryPath: null,
            hasCodexApiKey: false,
            hasOpenAiApiKey: false,
        });
        expect(secretValues.size).toBe(0);
    });

    it("verifies an unsaved key without persisting it yet", () => {
        const secretValues = new Map<string, string>();
        const service = new AiService({
            onRuntimeStatus: vi.fn(),
            onSessionSnapshot: vi.fn(),
            persistence: {
                loadLatestRuntimeCatalog: vi.fn(() => null),
                loadSessionSnapshot: vi.fn(() => null),
                saveSessionSnapshot: vi.fn(),
            } as never,
            projectService: {
                getProjectRootPath: vi.fn(() => process.cwd()),
            } as never,
            secretStore: {
                loadSecret: (namespace: string, secretId: string) =>
                    secretValues.get(`${namespace}:${secretId}`) ?? null,
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
                    authMethod: null,
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

        const status = service.verifyCodexRuntimeSettings({
            authMethod: "openai-api-key",
            binaryPath: null,
            codexApiKey: { kind: "unchanged" },
            openaiApiKey: { kind: "set", value: "openai-secret" },
        });

        expect(status.authMethod).toBe("openai-api-key");
        expect(status.authReady).toBe(true);
        expect(secretValues.size).toBe(0);
    });

    it("persists runtime option preferences when updating a stored session", async () => {
        const saveRuntimeSelectionPreferenceOption = vi.fn();
        const saveSessionSnapshot = vi.fn();
        const persistedSnapshot: AiSessionSnapshot = {
            availableCommands: [],
            configOptions: [
                {
                    category: "reasoning",
                    description: null,
                    id: "thought_level",
                    label: "Reasoning",
                    options: [
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
                    value: "medium",
                },
            ],
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
            updatedAt: "2026-04-15T00:00:00.000Z",
            worktreeId: null,
        };

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
                saveRuntimeSelectionPreferenceOption,
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
                    authMethod: null,
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

        await service.setSessionConfigOption({
            optionId: "thought_level",
            sessionId: "session-1",
            value: "high",
        });

        expect(saveRuntimeSelectionPreferenceOption).toHaveBeenCalledWith(
            "codex",
            "thought_level",
            "high",
        );
        expect(saveSessionSnapshot).toHaveBeenCalled();
    });

    it("persists model preferences when updating a stored model config option", async () => {
        const saveRuntimeModelPreference = vi.fn();
        const saveRuntimeSelectionPreferenceOption = vi.fn();
        const saveSessionSnapshot = vi.fn();
        const persistedSnapshot: AiSessionSnapshot = {
            availableCommands: [],
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
                            label: "GPT-5.4",
                            value: "gpt-5.4",
                        },
                        {
                            description: null,
                            groupLabel: null,
                            label: "GPT-5.5",
                            value: "gpt-5.5",
                        },
                    ],
                    type: "select",
                    value: "gpt-5.4",
                },
            ],
            lastError: null,
            messages: [],
            modeId: null,
            modes: [],
            modelId: "gpt-5.4",
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
            updatedAt: "2026-04-15T00:00:00.000Z",
            worktreeId: null,
        };

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
                saveRuntimeSelectionPreferenceOption,
                saveRuntimeModePreference: vi.fn(),
                saveRuntimeModelPreference,
                saveSessionSnapshot,
            } as never,
            projectService: {
                getProjectRootPath: vi.fn(() => process.cwd()),
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
                    authMethod: null,
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

        await service.setSessionConfigOption({
            optionId: "model",
            sessionId: "session-1",
            value: "gpt-5.5",
        });

        expect(saveRuntimeSelectionPreferenceOption).toHaveBeenCalledWith(
            "codex",
            "model",
            "gpt-5.5",
        );
        expect(saveRuntimeModelPreference).toHaveBeenCalledWith(
            "codex",
            "gpt-5.5",
        );
        expect(saveSessionSnapshot).toHaveBeenCalled();
    });
});

function createMockChildProcess() {
    const emitter = new EventEmitter();
    const child = {
        emit: (event: string, ...args: unknown[]) => emitter.emit(event, ...args),
        kill: vi.fn(() => true),
        off: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
            emitter.off(event, listener);
            return child;
        }),
        on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
            emitter.on(event, listener);
            return child;
        }),
        once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
            emitter.once(event, listener);
            return child;
        }),
        stderr: new PassThrough(),
        stdin: new PassThrough(),
        stdout: new PassThrough(),
    };

    return child;
}
