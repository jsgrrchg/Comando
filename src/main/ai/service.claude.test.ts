import { describe, expect, it, vi } from "vitest";

import type { AiRuntimeStatus, ClaudeRuntimeSettings } from "@shared/ipc";

import { AiService } from "./service";

describe("AiService Claude branch", () => {
    it("guarda settings Claude, persiste secretos y emite runtime status", () => {
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
                binaryPath: null,
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
                loadSessionSnapshot: vi.fn(() => null),
                saveSessionSnapshot: vi.fn(),
            } as never,
            projectService: {
                getProjectRootPath: vi.fn(() => process.cwd()),
            } as never,
            secretStore: secretStore as never,
            settingsService: settingsService as never,
        });

        const status = service.saveClaudeRuntimeSettings({
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
});
