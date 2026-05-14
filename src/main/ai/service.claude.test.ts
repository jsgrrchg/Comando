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
                binaryPath: null,
                gatewayBaseUrl: null,
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
                binaryPath: null,
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
            secretStore: secretStore as never,
            settingsService: settingsService as never,
        });

        const status = await service.saveClaudeRuntimeSettings({
            authMethod: "gateway",
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
            binaryPath: null,
            gatewayBaseUrl: "https://gateway.example/v1",
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

    it("disconnects Claude by clearing gateway secrets and preserving gateway URL", async () => {
        let savedSettings: ClaudeRuntimeSettings | null = null;
        const secretValues = new Map<string, string>([
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
            } as never,
            settingsService: {
                loadClaudeRuntimeSettings: () => ({
                    authInvalidatedAtMs: null,
                    authMethod: "gateway",
                    binaryPath: null,
                    gatewayBaseUrl: "https://gateway.example/v1",
                    hasGatewayAuthToken: true,
                    hasGatewayCustomHeaders: true,
                }),
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
                saveClaudeRuntimeSettings: (settings: ClaudeRuntimeSettings) => {
                    savedSettings = settings;
                },
                saveCodexRuntimeSettings: vi.fn(),
                saveGeminiRuntimeSettings: vi.fn(),
                saveKiloRuntimeSettings: vi.fn(),
            } as never,
        });

        await service.disconnectRuntimeAuth({ runtimeId: "claude" });

        expect(savedSettings).toEqual({
            authInvalidatedAtMs: null,
            authMethod: null,
            binaryPath: null,
            gatewayBaseUrl: "https://gateway.example/v1",
            hasGatewayAuthToken: false,
            hasGatewayCustomHeaders: false,
        });
        expect(secretValues.size).toBe(0);
    });
});
