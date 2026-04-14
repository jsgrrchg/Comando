import { describe, expect, it, vi } from "vitest";

import type { AiRuntimeStatus, KiloRuntimeSettings } from "@shared/ipc";

import { AiService } from "./service";

describe("AiService Kilo branch", () => {
    it("guarda settings Kilo y emite runtime status", () => {
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
                binaryPath: null,
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
});
