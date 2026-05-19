import { describe, expect, it, vi } from "vitest";

import type { AiRuntimeStatus, KiloRuntimeSettings } from "@shared/ipc";

import { AiService } from "./service";

describe("AiService Kilo branch", () => {
    it("stores Kilo settings and emits runtime status", async () => {
        let savedSettings: KiloRuntimeSettings | null = null;
        const runtimeStatusEvents: AiRuntimeStatus[] = [];

        const settingsService = {
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
            saveClaudeRuntimeSettings: vi.fn(),
            saveCodexRuntimeSettings: vi.fn(),
            saveGeminiRuntimeSettings: vi.fn(),
            saveKiloRuntimeSettings: (settings: KiloRuntimeSettings) => {
                savedSettings = settings;
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
            secretStore: {
                cacheSecretPatches: vi.fn(),
                loadSecret: vi.fn(() => null),
                saveSecret: vi.fn(),
            } as never,
            settingsService: settingsService as never,
        });

        const status = await service.saveKiloRuntimeSettings({
            authMethod: "kilo-api-key",
            binaryPath: "/opt/homebrew/bin/kilo",
            kiloApiKey: {
                kind: "set",
                value: "stored-kilo-key",
            },
        });

        expect(savedSettings).toEqual(
            expect.objectContaining({
                authInvalidatedAtMs: null,
                authMethod: "kilo-api-key",
                binaryPath: "/opt/homebrew/bin/kilo",
                hasKiloApiKey: true,
            }),
        );
        expect(status.runtimeId).toBe("kilo");
        expect(runtimeStatusEvents.at(-1)?.runtimeId).toBe("kilo");
    });

    it("disconnects Kilo by marking the external login as invalidated", async () => {
        let savedSettings: KiloRuntimeSettings | null = null;
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
                saveSecret: vi.fn(),
            } as never,
            settingsService: {
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
                    authMethod: "kilo-login",
                    binaryPath: "/opt/homebrew/bin/kilo",
                    hasKiloApiKey: false,
                })),
                saveClaudeRuntimeSettings: vi.fn(),
                saveCodexRuntimeSettings: vi.fn(),
                saveGeminiRuntimeSettings: vi.fn(),
                saveKiloRuntimeSettings: (settings: KiloRuntimeSettings) => {
                    savedSettings = settings;
                },
            } as never,
        });

        await service.disconnectRuntimeAuth({ runtimeId: "kilo" });

        expect(savedSettings).not.toBeNull();
        const nextSettings = savedSettings as unknown as KiloRuntimeSettings;
        expect(nextSettings.binaryPath).toBe("/opt/homebrew/bin/kilo");
        expect(nextSettings.authMethod).toBeNull();
        expect(nextSettings.authInvalidatedAtMs).toEqual(expect.any(Number));
    });
});
