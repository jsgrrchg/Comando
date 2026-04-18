import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { SettingsService } from "./service";

describe("SettingsService", () => {
    it("stores and reloads the global settings snapshot", () => {
        const connection = createFakeSettingsConnection();
        const service = new SettingsService(
            connection as unknown as Database.Database,
        );

        service.saveSnapshot({
            appearance: {
                fileTreeScale: 1.1,
                themeMode: "dark",
                themePreset: "ocean",
                zoomFactor: 1.15,
            },
            editor: {
                autoSaveDelayMs: 1800,
                fontFamily: "jetbrains-mono",
                fontSize: 15,
                lineHeight: 1.7,
                minimapEnabled: false,
                suggestionsEnabled: false,
            },
            shellState: {
                activeSurface: "workspace",
                leftWidth: 280,
            },
        });

        expect(service.loadSnapshot()).toEqual({
            ai: createEmptyAiSettings(),
            aiChat: createDefaultAiChatSettings(),
            appearance: {
                fileTreeScale: 1.1,
                themeMode: "dark",
                themePreset: "ocean",
                zoomFactor: 1.15,
            },
            editor: {
                autoSaveDelayMs: 1800,
                fontFamily: "jetbrains",
                fontSize: 15,
                lineHeight: 1.7,
                minimapEnabled: false,
                suggestionsEnabled: false,
            },
            shellState: {
                activeSurface: "workspace",
                leftWidth: 280,
            },
        });
    });

    it("tolerates corrupt settings and returns defaults", () => {
        const connection = createFakeSettingsConnection({
            app: {
                "appearance.file_tree_scale": "??",
                "shell.state": "{invalid json",
                "appearance.theme_mode": "??",
                "appearance.theme_preset": "??",
                "appearance.zoom_factor": "??",
                "editor.autosave_delay_ms": "??",
                "editor.font_family": "??",
                "editor.font_size": "??",
                "editor.line_height": "??",
                "editor.minimap_enabled": "??",
                "editor.suggestions_enabled": "??",
            },
            project: {
                "project-a": {
                    "appearance.theme_mode": "nope",
                    "appearance.theme_preset": "nope",
                    "editor.font_family": "bad",
                    "editor.font_size": "bad",
                    "editor.line_height": "bad",
                    "editor.minimap_enabled": "??",
                    "editor.suggestions_enabled": "??",
                },
            },
        });
        const service = new SettingsService(
            connection as unknown as Database.Database,
        );

        expect(service.loadSnapshot()).toEqual({
            ai: createEmptyAiSettings(),
            aiChat: createDefaultAiChatSettings(),
            appearance: {
                fileTreeScale: 1,
                themeMode: "system",
                themePreset: "default",
                zoomFactor: 1,
            },
            editor: {
                autoSaveDelayMs: 900,
                fontFamily: "sf-mono",
                fontSize: 14,
                lineHeight: 1.55,
                minimapEnabled: true,
                suggestionsEnabled: true,
            },
            shellState: null,
        });

        expect(service.loadProjectSettings("project-a")).toEqual(null);
    });

    it("stores and reloads the configured Codex path", () => {
        const connection = createFakeSettingsConnection();
        const service = new SettingsService(
            connection as unknown as Database.Database,
        );

        service.saveCodexRuntimeSettings({
            authMethod: "openai-api-key",
            binaryPath: "/usr/local/bin/codex-acp",
            hasCodexApiKey: false,
            hasOpenAiApiKey: true,
        });

        expect(service.loadCodexRuntimeSettings()).toEqual({
            authMethod: "openai-api-key",
            binaryPath: "/usr/local/bin/codex-acp",
            hasCodexApiKey: false,
            hasOpenAiApiKey: true,
        });
        expect(service.loadSnapshot().ai).toEqual({
            ...createEmptyAiSettings(),
            codex: {
                authMethod: "openai-api-key",
                binaryPath: "/usr/local/bin/codex-acp",
                hasCodexApiKey: false,
                hasOpenAiApiKey: true,
            },
        });
    });

    it("stores and reloads Gemini settings", () => {
        const connection = createFakeSettingsConnection();
        const service = new SettingsService(
            connection as unknown as Database.Database,
        );

        service.saveGeminiRuntimeSettings({
            authInvalidatedAtMs: 1234,
            authMethod: "login_with_google",
            binaryPath: "/opt/homebrew/bin/gemini",
            googleCloudLocation: "us-central1",
            googleCloudProject: "demo-project",
            hasGeminiApiKey: true,
            hasGoogleApiKey: false,
        });

        expect(service.loadGeminiRuntimeSettings()).toEqual({
            authInvalidatedAtMs: 1234,
            authMethod: "login_with_google",
            binaryPath: "/opt/homebrew/bin/gemini",
            googleCloudLocation: "us-central1",
            googleCloudProject: "demo-project",
            hasGeminiApiKey: true,
            hasGoogleApiKey: false,
        });
        expect(service.loadSnapshot().ai).toEqual({
            ...createEmptyAiSettings(),
            gemini: {
                authInvalidatedAtMs: 1234,
                authMethod: "login_with_google",
                binaryPath: "/opt/homebrew/bin/gemini",
                googleCloudLocation: "us-central1",
                googleCloudProject: "demo-project",
                hasGeminiApiKey: true,
                hasGoogleApiKey: false,
            },
        });
    });

    it("stores and reloads Kilo settings", () => {
        const connection = createFakeSettingsConnection();
        const service = new SettingsService(
            connection as unknown as Database.Database,
        );

        service.saveKiloRuntimeSettings({
            authInvalidatedAtMs: 5678,
            binaryPath: "/opt/homebrew/bin/kilo",
        });

        expect(service.loadKiloRuntimeSettings()).toEqual({
            authInvalidatedAtMs: 5678,
            binaryPath: "/opt/homebrew/bin/kilo",
        });
        expect(service.loadSnapshot().ai).toEqual({
            ...createEmptyAiSettings(),
            kilo: {
                authInvalidatedAtMs: 5678,
                binaryPath: "/opt/homebrew/bin/kilo",
            },
        });
    });

    it("ignores project-specific settings and clears legacy overrides", () => {
        const connection = createFakeSettingsConnection();
        const service = new SettingsService(
            connection as unknown as Database.Database,
        );

        service.saveProjectSettings({
            projectId: "project-a",
            appearance: {
                themeMode: "light",
                themePreset: "rose",
            },
            editor: {
                fontFamily: "ibm-plex-mono",
                fontSize: 16,
                lineHeight: 1.8,
                minimapEnabled: false,
                suggestionsEnabled: false,
            },
        });

        expect(service.loadProjectSettings("project-a")).toEqual(null);
    });

    it("accepts presets imported from the previous codebase", () => {
        const connection = createFakeSettingsConnection();
        const service = new SettingsService(
            connection as unknown as Database.Database,
        );

        service.saveSnapshot({
            appearance: {
                fileTreeScale: 0.95,
                themeMode: "dark",
                themePreset: "tokyoNight",
                zoomFactor: 0.9,
            },
            shellState: null,
        });
        service.saveProjectSettings({
            projectId: "project-b",
            appearance: {
                themeMode: "light",
                themePreset: "rosePine",
            },
            editor: null,
        });

        expect(service.loadSnapshot().appearance).toEqual({
            fileTreeScale: 0.95,
            themeMode: "dark",
            themePreset: "tokyoNight",
            zoomFactor: 0.9,
        });
        expect(service.loadProjectSettings("project-b")).toEqual(null);
    });

    it("normalizes legacy font aliases when loading settings", () => {
        const connection = createFakeSettingsConnection({
            app: {
                "editor.font_family": "jetbrains-mono",
                "ai.chat.font_family": "jetbrains-mono",
                "ai.composer.font_family": "jetbrains-mono",
            },
        });
        const service = new SettingsService(
            connection as unknown as Database.Database,
        );

        expect(service.loadSnapshot().editor).toMatchObject({
            fontFamily: "jetbrains",
        });
        expect(service.loadSnapshot().aiChat).toMatchObject({
            chatFontFamily: "jetbrains",
            composerFontFamily: "jetbrains",
        });
    });

    it("stores and reloads the new AI fonts for Comando", () => {
        const connection = createFakeSettingsConnection();
        const service = new SettingsService(
            connection as unknown as Database.Database,
        );

        service.saveSnapshot({
            aiChat: {
                chatFontFamily: "typewriter",
                chatFontSize: 15,
                composerFontFamily: "literata",
                composerFontSize: 16,
                reviewDiffZoom: 0.8,
                requireCmdEnterToSend: false,
                screenshotRetentionSeconds: 0,
                historyRetentionDays: 0,
            },
            shellState: null,
        });

        expect(service.loadSnapshot().aiChat).toEqual({
            chatFontFamily: "typewriter",
            chatFontSize: 15,
            composerFontFamily: "literata",
            composerFontSize: 16,
            reviewDiffZoom: 0.8,
            requireCmdEnterToSend: false,
            screenshotRetentionSeconds: 0,
            historyRetentionDays: 0,
        });
    });
});

function createEmptyClaudeSettings() {
    return {
        authInvalidatedAtMs: null,
        authMethod: null,
        binaryPath: null,
        gatewayBaseUrl: null,
        hasGatewayAuthToken: false,
        hasGatewayCustomHeaders: false,
    };
}

function createEmptyGeminiSettings() {
    return {
        authInvalidatedAtMs: null,
        authMethod: null,
        binaryPath: null,
        googleCloudLocation: null,
        googleCloudProject: null,
        hasGeminiApiKey: false,
        hasGoogleApiKey: false,
    };
}

function createEmptyAiSettings() {
    return {
        claude: createEmptyClaudeSettings(),
        codex: {
            authMethod: null,
            binaryPath: null,
            hasCodexApiKey: false,
            hasOpenAiApiKey: false,
        },
        gemini: createEmptyGeminiSettings(),
        kilo: {
            authInvalidatedAtMs: null,
            binaryPath: null,
        },
    };
}

function createDefaultAiChatSettings() {
    return {
        chatFontFamily: "system",
        chatFontSize: 14,
        composerFontFamily: "system",
        composerFontSize: 14,
        reviewDiffZoom: 0.96,
        requireCmdEnterToSend: false,
        screenshotRetentionSeconds: 0,
        historyRetentionDays: 0,
    };
}

function createFakeSettingsConnection(
    seed: {
        app?: Record<string, string>;
        project?: Record<string, Record<string, string>>;
    } = {},
) {
    const appSettings = new Map(Object.entries(seed.app ?? {}));
    const projectSettings = new Map<string, string>();

    for (const [projectId, values] of Object.entries(seed.project ?? {})) {
        for (const [key, value] of Object.entries(values)) {
            projectSettings.set(`${projectId}:${key}`, value);
        }
    }

    return {
        prepare(sql: string) {
            const normalizedSql = sql.replace(/\s+/g, " ").trim();
            const normalizedLowerSql = normalizedSql.toLowerCase();

            if (
                normalizedLowerSql.includes(
                    "select value from app_settings where key = ?",
                )
            ) {
                return {
                    get(key: string) {
                        const value = appSettings.get(key);
                        return value !== undefined ? { value } : undefined;
                    },
                };
            }

            if (normalizedLowerSql.includes("insert into app_settings")) {
                return {
                    run(key: string, value: string) {
                        appSettings.set(key, value);
                    },
                };
            }

            if (
                normalizedLowerSql.includes(
                    "delete from app_settings where key = ?",
                )
            ) {
                return {
                    run(key: string) {
                        appSettings.delete(key);
                    },
                };
            }

            if (
                normalizedLowerSql.includes(
                    "select value from project_settings where project_id = ? and key = ?",
                )
            ) {
                return {
                    get(projectId: string, key: string) {
                        const value = projectSettings.get(
                            `${projectId}:${key}`,
                        );
                        return value !== undefined ? { value } : undefined;
                    },
                };
            }

            if (normalizedLowerSql.includes("insert into project_settings")) {
                return {
                    run(projectId: string, key: string, value: string) {
                        projectSettings.set(`${projectId}:${key}`, value);
                    },
                };
            }

            if (
                normalizedLowerSql.includes(
                    "delete from project_settings where project_id = ? and key = ?",
                )
            ) {
                return {
                    run(projectId: string, key: string) {
                        projectSettings.delete(`${projectId}:${key}`);
                    },
                };
            }

            throw new Error(`Unsupported SQL in fake settings test:
${sql}`);
        },
    };
}
