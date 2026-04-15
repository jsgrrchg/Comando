import { describe, expect, it, vi } from "vitest";

import type { AiRuntimeStatus, GeminiRuntimeSettings } from "@shared/ipc";

import { AiService } from "./service";

describe("AiService Gemini branch", () => {
    it("stores Gemini settings, persists secrets, and emits runtime status", () => {
        let savedSettings: GeminiRuntimeSettings | null = null;
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
            loadGeminiRuntimeSettings: () => ({
                authInvalidatedAtMs: null,
                authMethod: null,
                binaryPath: null,
                googleCloudLocation: null,
                googleCloudProject: null,
                hasGeminiApiKey: false,
                hasGoogleApiKey: false,
            }),
            loadKiloRuntimeSettings: vi.fn(() => ({
                authInvalidatedAtMs: null,
                binaryPath: null,
            })),
            saveClaudeRuntimeSettings: vi.fn(),
            saveCodexRuntimeSettings: vi.fn(),
            saveGeminiRuntimeSettings: (settings: GeminiRuntimeSettings) => {
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
            secretStore: secretStore as never,
            settingsService: settingsService as never,
        });

        const status = service.saveGeminiRuntimeSettings({
            authMethod: "use_gemini",
            binaryPath: "/opt/homebrew/bin/gemini",
            geminiApiKey: {
                kind: "set",
                value: "gem-key-123",
            },
            googleApiKey: {
                kind: "set",
                value: "google-key-456",
            },
            googleCloudLocation: "us-central1",
            googleCloudProject: "demo-project",
        });

        expect(savedSettings).toEqual({
            authInvalidatedAtMs: null,
            authMethod: "use_gemini",
            binaryPath: "/opt/homebrew/bin/gemini",
            googleCloudLocation: "us-central1",
            googleCloudProject: "demo-project",
            hasGeminiApiKey: true,
            hasGoogleApiKey: true,
        });
        expect(secretValues.get("ai.gemini:gemini_api_key")).toBe(
            "gem-key-123",
        );
        expect(secretValues.get("ai.gemini:google_api_key")).toBe(
            "google-key-456",
        );
        expect(status.runtimeId).toBe("gemini");
        expect(runtimeStatusEvents.at(-1)?.runtimeId).toBe("gemini");
    });
});
