import { describe, expect, it, vi } from "vitest";

import type { AiRuntimeStatus, KiloRuntimeSettings } from "@shared/ipc";

import { AiService } from "./service";

describe("AiService Kilo branch", () => {
    it("stores Kilo settings and emits runtime status", () => {
        let savedSettings: KiloRuntimeSettings | null = null;
        const runtimeStatusEvents: AiRuntimeStatus[] = [];

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
                loadSecret: vi.fn(() => null),
                saveSecret: vi.fn(),
            } as never,
            settingsService: settingsService as never,
        });

        const status = service.saveKiloRuntimeSettings({
            binaryPath: "/opt/homebrew/bin/kilo",
        });

        expect(savedSettings).toEqual({
            authInvalidatedAtMs: null,
            binaryPath: "/opt/homebrew/bin/kilo",
        });
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
                    binaryPath: "/opt/homebrew/bin/kilo",
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
        expect(nextSettings.authInvalidatedAtMs).toEqual(expect.any(Number));
    });
});
