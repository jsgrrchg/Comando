import { describe, expect, it, vi } from "vitest";

import type {
    AiRuntimeStatus,
    AiSessionSnapshot,
    CodexRuntimeSettings,
} from "@shared/ipc";

import { AiService } from "./service";

describe("AiService Codex branch", () => {
    it("stores Codex settings, persists only one API key, and emits runtime status", () => {
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
            saveCodexRuntimeSettings: (settings: CodexRuntimeSettings) => {
                savedSettings = settings;
            },
            saveGeminiRuntimeSettings: vi.fn(),
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
            secretStore: secretStore as never,
            settingsService: settingsService as never,
        });

        const status = service.saveCodexRuntimeSettings({
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

    it("propagates an error when secure storage is unavailable", () => {
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
                    binaryPath: null,
                })),
                saveClaudeRuntimeSettings: vi.fn(),
                saveCodexRuntimeSettings: vi.fn(),
                saveGeminiRuntimeSettings: vi.fn(),
                saveKiloRuntimeSettings: vi.fn(),
            } as never,
        });

        expect(() =>
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
        ).toThrowError("Secure secret storage is unavailable on this machine.");
    });

    it("clears the opposing key when changing Codex preferred method", () => {
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
                    authMethod: "codex-api-key",
                    binaryPath: null,
                    hasCodexApiKey: true,
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
                saveCodexRuntimeSettings: (settings: CodexRuntimeSettings) => {
                    savedSettings = settings;
                },
                saveGeminiRuntimeSettings: vi.fn(),
                saveKiloRuntimeSettings: vi.fn(),
            } as never,
        });

        service.saveCodexRuntimeSettings({
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

    it("clears saved API keys when switching to ChatGPT", () => {
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
                    authMethod: "codex-api-key",
                    binaryPath: null,
                    hasCodexApiKey: true,
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
                saveCodexRuntimeSettings: (settings: CodexRuntimeSettings) => {
                    savedSettings = settings;
                },
                saveGeminiRuntimeSettings: vi.fn(),
                saveKiloRuntimeSettings: vi.fn(),
            } as never,
        });

        service.saveCodexRuntimeSettings({
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
                    binaryPath: null,
                })),
                saveClaudeRuntimeSettings: vi.fn(),
                saveCodexRuntimeSettings: vi.fn(),
                saveGeminiRuntimeSettings: vi.fn(),
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
                    binaryPath: null,
                })),
                saveClaudeRuntimeSettings: vi.fn(),
                saveCodexRuntimeSettings: vi.fn(),
                saveGeminiRuntimeSettings: vi.fn(),
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
});
