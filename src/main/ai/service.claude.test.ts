import { describe, expect, it, vi } from "vitest";

import type { AiRuntimeStatus, ClaudeRuntimeSettings } from "@shared/ipc";

import { AiService } from "./service";

describe("AiService Claude branch", () => {
    it("stores Claude settings, persists secrets, and emits runtime status", async () => {
        let savedSettings: ClaudeRuntimeSettings | null = null;
        const runtimeStatusEvents: AiRuntimeStatus[] = [];
        const secretValues = new Map<string, string>();

        const settingsService = {
            loadClaudeRuntimeSettings: () => ({
                authInvalidatedAtMs: null,
                authMethod: null,
                bedrockGatewayBaseUrl: null,
                binaryPath: null,
                gatewayBaseUrl: null,
                hasAnthropicApiKey: false,
                hasGatewayAuthToken: false,
                hasGatewayCustomHeaders: false,
            }),
            loadCodexRuntimeSettings: () => ({
                authMethod: null,
                binaryPath: null,
                hasCodexApiKey: false,
                hasOpenAiApiKey: false,
            }),
            loadKiloRuntimeSettings: vi.fn(() => ({
                authInvalidatedAtMs: null,
                authMethod: null,
                binaryPath: null,
                hasKiloApiKey: false,
            })),
            saveClaudeRuntimeSettings: (settings: ClaudeRuntimeSettings) => {
                savedSettings = settings;
            },
            saveCodexRuntimeSettings: vi.fn(),
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

        const status = await service.saveClaudeRuntimeSettings({
            authMethod: "gateway",
            anthropicApiKey: {
                kind: "unchanged",
            },
            bedrockGatewayBaseUrl: null,
            binaryPath: null,
            gatewayAuthToken: {
                kind: "set",
                value: "token-123",
            },
            gatewayBaseUrl: "https://gateway.example/v1",
            gatewayCustomHeaders: {
                kind: "set",
                value: '{"x-test":"1"}',
            },
        });

        expect(savedSettings).toEqual({
            authInvalidatedAtMs: null,
            authMethod: "gateway",
            bedrockGatewayBaseUrl: null,
            binaryPath: null,
            gatewayBaseUrl: "https://gateway.example/v1",
            hasAnthropicApiKey: false,
            hasGatewayAuthToken: true,
            hasGatewayCustomHeaders: true,
        });
        expect(secretValues.get("ai.claude:anthropic_auth_token")).toBe(
            "token-123",
        );
        expect(secretValues.get("ai.claude:anthropic_custom_headers")).toBe(
            '{"x-test":"1"}',
        );
        expect(status.runtimeId).toBe("claude");
        expect(runtimeStatusEvents.at(-1)?.runtimeId).toBe("claude");
    });

    it("stores Claude Anthropic API key and Bedrock gateway settings", async () => {
        let savedSettings: ClaudeRuntimeSettings | null = null;
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
                loadClaudeRuntimeSettings: () => ({
                    authInvalidatedAtMs: null,
                    authMethod: null,
                    bedrockGatewayBaseUrl: null,
                    binaryPath: null,
                    gatewayBaseUrl: null,
                    hasAnthropicApiKey: false,
                    hasGatewayAuthToken: false,
                    hasGatewayCustomHeaders: false,
                }),
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
                saveClaudeRuntimeSettings: (settings: ClaudeRuntimeSettings) => {
                    savedSettings = settings;
                },
                saveCodexRuntimeSettings: vi.fn(),
                saveKiloRuntimeSettings: vi.fn(),
            } as never,
        });

        const status = await service.saveClaudeRuntimeSettings({
            authMethod: "anthropic-api-key",
            anthropicApiKey: {
                kind: "set",
                value: "sk-ant-123",
            },
            bedrockGatewayBaseUrl: "https://bedrock.example/v1",
            binaryPath: null,
            gatewayAuthToken: {
                kind: "clear",
            },
            gatewayBaseUrl: null,
            gatewayCustomHeaders: {
                kind: "clear",
            },
        });

        expect(savedSettings).toEqual({
            authInvalidatedAtMs: null,
            authMethod: "anthropic-api-key",
            bedrockGatewayBaseUrl: "https://bedrock.example/v1",
            binaryPath: null,
            gatewayBaseUrl: null,
            hasAnthropicApiKey: true,
            hasGatewayAuthToken: false,
            hasGatewayCustomHeaders: false,
        });
        expect(secretValues.get("ai.claude:anthropic_api_key")).toBe(
            "sk-ant-123",
        );
        expect(status.authMethod).toBe("anthropic-api-key");
        expect(status.authReady).toBe(true);
    });

    it("disconnects Claude by clearing secrets and preserving gateway URLs", async () => {
        let savedSettings: ClaudeRuntimeSettings | null = null;
        const secretValues = new Map<string, string>([
            ["ai.claude:anthropic_api_key", "sk-ant-123"],
            ["ai.claude:anthropic_auth_token", "token-123"],
            ["ai.claude:anthropic_custom_headers", "not-json"],
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
                loadClaudeRuntimeSettings: () => ({
                    authInvalidatedAtMs: null,
                    authMethod: "gateway-bedrock",
                    bedrockGatewayBaseUrl: "https://bedrock.example/v1",
                    binaryPath: null,
                    gatewayBaseUrl: "https://gateway.example/v1",
                    hasAnthropicApiKey: true,
                    hasGatewayAuthToken: true,
                    hasGatewayCustomHeaders: true,
                }),
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
                saveClaudeRuntimeSettings: (settings: ClaudeRuntimeSettings) => {
                    savedSettings = settings;
                },
                saveCodexRuntimeSettings: vi.fn(),
                saveKiloRuntimeSettings: vi.fn(),
            } as never,
        });

        await service.disconnectRuntimeAuth({ runtimeId: "claude" });

        expect(savedSettings).toEqual({
            authInvalidatedAtMs: null,
            authMethod: null,
            bedrockGatewayBaseUrl: "https://bedrock.example/v1",
            binaryPath: null,
            gatewayBaseUrl: "https://gateway.example/v1",
            hasAnthropicApiKey: false,
            hasGatewayAuthToken: false,
            hasGatewayCustomHeaders: false,
        });
        expect(secretValues.size).toBe(0);
    });
});
