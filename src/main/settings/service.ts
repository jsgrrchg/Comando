import type Database from "better-sqlite3";

import type {
    AppAiChatSettings,
    AppAppearanceSettings,
    AppEditorSettings,
    ChatFontFamily,
    ClaudeRuntimeSettings,
    CodexRuntimeSettings,
    EditorFontFamily,
    GeminiRuntimeSettings,
    KiloRuntimeSettings,
    PersistedShellState,
    ProjectAppearanceSettings,
    ProjectEditorSettings,
    ProjectSettingsSnapshot,
    SettingsSnapshot,
    ThemeMode,
    ThemePreset,
} from "@shared/ipc";
import {
    AI_CHAT_FONT_SIZE_MAX,
    AI_CHAT_FONT_SIZE_MIN,
    AI_COMPOSER_FONT_SIZE_MAX,
    AI_COMPOSER_FONT_SIZE_MIN,
    clampRoundedInt,
    DEFAULT_AI_CHAT_FONT_SIZE,
    DEFAULT_AI_COMPOSER_FONT_SIZE,
    DEFAULT_EDITOR_FONT_SIZE,
    EDITOR_FONT_SIZE_MAX,
    EDITOR_FONT_SIZE_MIN,
} from "@shared/typography";

const CLAUDE_AUTH_INVALIDATED_AT_KEY = "ai.claude.auth_invalidated_at_ms";
const CLAUDE_AUTH_METHOD_KEY = "ai.claude.auth_method";
const CODEX_BINARY_PATH_KEY = "ai.codex.binary_path";
const CLAUDE_BINARY_PATH_KEY = "ai.claude.binary_path";
const CLAUDE_GATEWAY_BASE_URL_KEY = "ai.claude.gateway_base_url";
const CLAUDE_HAS_GATEWAY_AUTH_TOKEN_KEY = "ai.claude.has_gateway_auth_token";
const CLAUDE_HAS_GATEWAY_CUSTOM_HEADERS_KEY =
    "ai.claude.has_gateway_custom_headers";
const GEMINI_AUTH_INVALIDATED_AT_KEY = "ai.gemini.auth_invalidated_at_ms";
const GEMINI_AUTH_METHOD_KEY = "ai.gemini.auth_method";
const GEMINI_BINARY_PATH_KEY = "ai.gemini.binary_path";
const GEMINI_GOOGLE_CLOUD_LOCATION_KEY = "ai.gemini.google_cloud_location";
const GEMINI_GOOGLE_CLOUD_PROJECT_KEY = "ai.gemini.google_cloud_project";
const GEMINI_HAS_GEMINI_API_KEY_KEY = "ai.gemini.has_gemini_api_key";
const GEMINI_HAS_GOOGLE_API_KEY_KEY = "ai.gemini.has_google_api_key";
const KILO_AUTH_INVALIDATED_AT_KEY = "ai.kilo.auth_invalidated_at_ms";
const KILO_BINARY_PATH_KEY = "ai.kilo.binary_path";
const APP_THEME_MODE_KEY = "appearance.theme_mode";
const APP_THEME_PRESET_KEY = "appearance.theme_preset";
const APP_EDITOR_FONT_FAMILY_KEY = "editor.font_family";
const APP_EDITOR_FONT_SIZE_KEY = "editor.font_size";
const APP_EDITOR_LINE_HEIGHT_KEY = "editor.line_height";
const PROJECT_THEME_MODE_KEY = "appearance.theme_mode";
const PROJECT_THEME_PRESET_KEY = "appearance.theme_preset";
const PROJECT_EDITOR_FONT_FAMILY_KEY = "editor.font_family";
const PROJECT_EDITOR_FONT_SIZE_KEY = "editor.font_size";
const PROJECT_EDITOR_LINE_HEIGHT_KEY = "editor.line_height";

const AI_CHAT_FONT_FAMILY_KEY = "ai.chat.font_family";
const AI_CHAT_FONT_SIZE_KEY = "ai.chat.font_size";
const AI_COMPOSER_FONT_FAMILY_KEY = "ai.composer.font_family";
const AI_COMPOSER_FONT_SIZE_KEY = "ai.composer.font_size";
const AI_REQUIRE_CMD_ENTER_KEY = "ai.composer.require_cmd_enter";
const AI_SCREENSHOT_RETENTION_KEY = "ai.composer.screenshot_retention_seconds";
const AI_HISTORY_RETENTION_KEY = "ai.chat.history_retention_days";

const DEFAULT_CHAT_FONT_FAMILY: ChatFontFamily = "system";
const DEFAULT_CHAT_FONT_SIZE = DEFAULT_AI_CHAT_FONT_SIZE;
const DEFAULT_COMPOSER_FONT_SIZE = DEFAULT_AI_COMPOSER_FONT_SIZE;
const DEFAULT_REQUIRE_CMD_ENTER = false;
const DEFAULT_SCREENSHOT_RETENTION = 0;
const DEFAULT_HISTORY_RETENTION = 0;

const VALID_CHAT_FONT_FAMILIES = new Set<ChatFontFamily>([
    "system",
    "sans",
    "mono",
    "jetbrains-mono",
    "ibm-plex-mono",
]);

const DEFAULT_THEME_MODE: ThemeMode = "system";
const DEFAULT_THEME_PRESET: ThemePreset = "default";
const DEFAULT_EDITOR_FONT_FAMILY: EditorFontFamily = "sf-mono";
const DEFAULT_EDITOR_LINE_HEIGHT = 1.55;

const VALID_THEME_MODES = new Set<ThemeMode>(["system", "light", "dark"]);
const VALID_THEME_PRESETS = new Set<ThemePreset>([
    "default",
    "ocean",
    "forest",
    "amber",
    "rose",
    "lavender",
    "nord",
    "sunset",
    "catppuccin",
    "solarized",
    "tokyoNight",
    "gruvbox",
    "ayu",
    "nightOwl",
    "vesper",
    "rosePine",
    "kanagawa",
    "everforest",
    "synthwave84",
    "claude",
    "codex",
]);
const VALID_EDITOR_FONT_FAMILIES = new Set<EditorFontFamily>([
    "sf-mono",
    "jetbrains-mono",
    "cascadia-code",
    "ibm-plex-mono",
]);

interface SettingRow {
    readonly value: string;
}

export class SettingsService {
    readonly #connection: Database.Database;

    constructor(connection: Database.Database) {
        this.#connection = connection;
    }

    loadSnapshot(): SettingsSnapshot {
        return {
            ai: {
                claude: this.loadClaudeRuntimeSettings(),
                codex: {
                    binaryPath:
                        this.#loadStringSetting(CODEX_BINARY_PATH_KEY) ?? null,
                },
                gemini: this.loadGeminiRuntimeSettings(),
                kilo: this.loadKiloRuntimeSettings(),
            },
            aiChat: this.loadAiChatSettings(),
            appearance: this.loadAppAppearanceSettings(),
            editor: this.loadAppEditorSettings(),
            shellState:
                this.#loadJsonSetting<PersistedShellState>("shell.state"),
        };
    }

    saveSnapshot(snapshot: SettingsSnapshot): void {
        if (snapshot.shellState) {
            this.#saveSetting(
                "shell.state",
                JSON.stringify(snapshot.shellState),
            );
        } else {
            this.#deleteSetting("shell.state");
        }

        if (snapshot.ai?.codex) {
            this.saveCodexRuntimeSettings(snapshot.ai.codex);
        }

        if (snapshot.ai?.claude) {
            this.saveClaudeRuntimeSettings(snapshot.ai.claude);
        }

        if (snapshot.ai?.gemini) {
            this.saveGeminiRuntimeSettings(snapshot.ai.gemini);
        }

        if (snapshot.ai?.kilo) {
            this.saveKiloRuntimeSettings(snapshot.ai.kilo);
        }

        if (snapshot.aiChat) {
            this.saveAiChatSettings(snapshot.aiChat);
        }

        if (snapshot.appearance) {
            this.saveAppAppearanceSettings(snapshot.appearance);
        }

        if (snapshot.editor) {
            this.saveAppEditorSettings(snapshot.editor);
        }
    }

    loadAppAppearanceSettings(): AppAppearanceSettings {
        return {
            themeMode: this.#normalizeThemeMode(
                this.#loadStringSetting(APP_THEME_MODE_KEY),
            ),
            themePreset: this.#normalizeThemePreset(
                this.#loadStringSetting(APP_THEME_PRESET_KEY),
            ),
        };
    }

    saveAppAppearanceSettings(settings: AppAppearanceSettings): void {
        this.#saveSetting(
            APP_THEME_MODE_KEY,
            this.#normalizeThemeMode(settings.themeMode),
        );
        this.#saveSetting(
            APP_THEME_PRESET_KEY,
            this.#normalizeThemePreset(settings.themePreset),
        );
    }

    loadAppEditorSettings(): AppEditorSettings {
        return {
            fontFamily: this.#normalizeEditorFontFamily(
                this.#loadStringSetting(APP_EDITOR_FONT_FAMILY_KEY),
            ),
            fontSize: this.#normalizeEditorFontSize(
                this.#loadNumberSetting(APP_EDITOR_FONT_SIZE_KEY),
            ),
            lineHeight: this.#normalizeEditorLineHeight(
                this.#loadNumberSetting(APP_EDITOR_LINE_HEIGHT_KEY),
            ),
        };
    }

    saveAppEditorSettings(settings: AppEditorSettings): void {
        this.#saveSetting(
            APP_EDITOR_FONT_FAMILY_KEY,
            this.#normalizeEditorFontFamily(settings.fontFamily),
        );
        this.#saveSetting(
            APP_EDITOR_FONT_SIZE_KEY,
            String(this.#normalizeEditorFontSize(settings.fontSize)),
        );
        this.#saveSetting(
            APP_EDITOR_LINE_HEIGHT_KEY,
            String(this.#normalizeEditorLineHeight(settings.lineHeight)),
        );
    }

    loadAiChatSettings(): AppAiChatSettings {
        return {
            chatFontFamily: this.#normalizeChatFontFamily(
                this.#loadStringSetting(AI_CHAT_FONT_FAMILY_KEY),
            ),
            chatFontSize: this.#normalizeChatFontSize(
                this.#loadNumberSetting(AI_CHAT_FONT_SIZE_KEY),
            ),
            composerFontFamily: this.#normalizeChatFontFamily(
                this.#loadStringSetting(AI_COMPOSER_FONT_FAMILY_KEY),
            ),
            composerFontSize: this.#normalizeComposerFontSize(
                this.#loadNumberSetting(AI_COMPOSER_FONT_SIZE_KEY),
            ),
            requireCmdEnterToSend:
                this.#loadStringSetting(AI_REQUIRE_CMD_ENTER_KEY) === "true" ||
                DEFAULT_REQUIRE_CMD_ENTER,
            screenshotRetentionSeconds: Math.max(
                0,
                this.#loadNumberSetting(AI_SCREENSHOT_RETENTION_KEY) ??
                    DEFAULT_SCREENSHOT_RETENTION,
            ),
            historyRetentionDays: Math.max(
                0,
                this.#loadNumberSetting(AI_HISTORY_RETENTION_KEY) ??
                    DEFAULT_HISTORY_RETENTION,
            ),
        };
    }

    saveAiChatSettings(settings: AppAiChatSettings): void {
        this.#saveSetting(
            AI_CHAT_FONT_FAMILY_KEY,
            this.#normalizeChatFontFamily(settings.chatFontFamily),
        );
        this.#saveSetting(
            AI_CHAT_FONT_SIZE_KEY,
            String(this.#normalizeChatFontSize(settings.chatFontSize)),
        );
        this.#saveSetting(
            AI_COMPOSER_FONT_FAMILY_KEY,
            this.#normalizeChatFontFamily(settings.composerFontFamily),
        );
        this.#saveSetting(
            AI_COMPOSER_FONT_SIZE_KEY,
            String(this.#normalizeComposerFontSize(settings.composerFontSize)),
        );
        this.#saveSetting(
            AI_REQUIRE_CMD_ENTER_KEY,
            String(settings.requireCmdEnterToSend),
        );
        this.#saveSetting(
            AI_SCREENSHOT_RETENTION_KEY,
            String(Math.max(0, settings.screenshotRetentionSeconds)),
        );
        this.#saveSetting(
            AI_HISTORY_RETENTION_KEY,
            String(Math.max(0, settings.historyRetentionDays)),
        );
    }

    loadProjectSettings(projectId: string): ProjectSettingsSnapshot | null {
        const themeMode = this.#loadProjectStringSetting(
            projectId,
            PROJECT_THEME_MODE_KEY,
        );
        const themePreset = this.#loadProjectStringSetting(
            projectId,
            PROJECT_THEME_PRESET_KEY,
        );

        const appearance = {
            themeMode: this.#normalizeOptionalThemeMode(themeMode),
            themePreset: this.#normalizeOptionalThemePreset(themePreset),
        };
        const editor = {
            fontFamily: this.#normalizeOptionalEditorFontFamily(
                this.#loadProjectStringSetting(
                    projectId,
                    PROJECT_EDITOR_FONT_FAMILY_KEY,
                ),
            ),
            fontSize: this.#normalizeOptionalEditorFontSize(
                this.#loadProjectNumberSetting(
                    projectId,
                    PROJECT_EDITOR_FONT_SIZE_KEY,
                ),
            ),
            lineHeight: this.#normalizeOptionalEditorLineHeight(
                this.#loadProjectNumberSetting(
                    projectId,
                    PROJECT_EDITOR_LINE_HEIGHT_KEY,
                ),
            ),
        };

        if (
            appearance.themeMode === null &&
            appearance.themePreset === null &&
            editor.fontFamily === null &&
            editor.fontSize === null &&
            editor.lineHeight === null
        ) {
            return null;
        }

        return {
            appearance,
            editor,
            projectId,
        };
    }

    saveProjectSettings(snapshot: ProjectSettingsSnapshot): void {
        if (snapshot.appearance === null && snapshot.editor === null) {
            this.#deleteProjectSetting(
                snapshot.projectId,
                PROJECT_THEME_MODE_KEY,
            );
            this.#deleteProjectSetting(
                snapshot.projectId,
                PROJECT_THEME_PRESET_KEY,
            );
            this.#deleteProjectSetting(
                snapshot.projectId,
                PROJECT_EDITOR_FONT_FAMILY_KEY,
            );
            this.#deleteProjectSetting(
                snapshot.projectId,
                PROJECT_EDITOR_FONT_SIZE_KEY,
            );
            this.#deleteProjectSetting(
                snapshot.projectId,
                PROJECT_EDITOR_LINE_HEIGHT_KEY,
            );
            return;
        }

        this.#saveOptionalProjectThemeMode(
            snapshot.projectId,
            PROJECT_THEME_MODE_KEY,
            snapshot.appearance?.themeMode ?? null,
        );
        this.#saveOptionalProjectThemePreset(
            snapshot.projectId,
            PROJECT_THEME_PRESET_KEY,
            snapshot.appearance?.themePreset ?? null,
        );
        this.#saveOptionalProjectEditorFontFamily(
            snapshot.projectId,
            PROJECT_EDITOR_FONT_FAMILY_KEY,
            snapshot.editor?.fontFamily ?? null,
        );
        this.#saveOptionalProjectEditorNumber(
            snapshot.projectId,
            PROJECT_EDITOR_FONT_SIZE_KEY,
            this.#normalizeOptionalEditorFontSize(
                snapshot.editor?.fontSize ?? null,
            ),
        );
        this.#saveOptionalProjectEditorNumber(
            snapshot.projectId,
            PROJECT_EDITOR_LINE_HEIGHT_KEY,
            this.#normalizeOptionalEditorLineHeight(
                snapshot.editor?.lineHeight ?? null,
            ),
        );
    }

    loadCodexRuntimeSettings(): CodexRuntimeSettings {
        return {
            binaryPath: this.#loadStringSetting(CODEX_BINARY_PATH_KEY) ?? null,
        };
    }

    saveCodexRuntimeSettings(settings: CodexRuntimeSettings): void {
        if (settings.binaryPath?.trim()) {
            this.#saveSetting(
                CODEX_BINARY_PATH_KEY,
                settings.binaryPath.trim(),
            );
            return;
        }

        this.#deleteSetting(CODEX_BINARY_PATH_KEY);
    }

    loadClaudeRuntimeSettings(): ClaudeRuntimeSettings {
        return {
            authInvalidatedAtMs: this.#loadNumberSetting(
                CLAUDE_AUTH_INVALIDATED_AT_KEY,
            ),
            authMethod:
                (this.#loadStringSetting(
                    CLAUDE_AUTH_METHOD_KEY,
                ) as ClaudeRuntimeSettings["authMethod"]) ?? null,
            binaryPath: this.#loadStringSetting(CLAUDE_BINARY_PATH_KEY) ?? null,
            gatewayBaseUrl:
                this.#loadStringSetting(CLAUDE_GATEWAY_BASE_URL_KEY) ?? null,
            hasGatewayAuthToken:
                this.#loadBooleanSetting(CLAUDE_HAS_GATEWAY_AUTH_TOKEN_KEY) ??
                false,
            hasGatewayCustomHeaders:
                this.#loadBooleanSetting(
                    CLAUDE_HAS_GATEWAY_CUSTOM_HEADERS_KEY,
                ) ?? false,
        };
    }

    saveClaudeRuntimeSettings(settings: ClaudeRuntimeSettings): void {
        this.#saveOptionalTrimmedStringSetting(
            CLAUDE_BINARY_PATH_KEY,
            settings.binaryPath,
        );
        this.#saveOptionalTrimmedStringSetting(
            CLAUDE_AUTH_METHOD_KEY,
            settings.authMethod,
        );
        this.#saveOptionalTrimmedStringSetting(
            CLAUDE_GATEWAY_BASE_URL_KEY,
            settings.gatewayBaseUrl,
        );
        this.#saveOptionalNumberSetting(
            CLAUDE_AUTH_INVALIDATED_AT_KEY,
            settings.authInvalidatedAtMs,
        );
        this.#saveBooleanSetting(
            CLAUDE_HAS_GATEWAY_AUTH_TOKEN_KEY,
            settings.hasGatewayAuthToken,
        );
        this.#saveBooleanSetting(
            CLAUDE_HAS_GATEWAY_CUSTOM_HEADERS_KEY,
            settings.hasGatewayCustomHeaders,
        );
    }

    loadGeminiRuntimeSettings(): GeminiRuntimeSettings {
        return {
            authInvalidatedAtMs: this.#loadNumberSetting(
                GEMINI_AUTH_INVALIDATED_AT_KEY,
            ),
            authMethod:
                (this.#loadStringSetting(
                    GEMINI_AUTH_METHOD_KEY,
                ) as GeminiRuntimeSettings["authMethod"]) ?? null,
            binaryPath: this.#loadStringSetting(GEMINI_BINARY_PATH_KEY) ?? null,
            googleCloudLocation:
                this.#loadStringSetting(GEMINI_GOOGLE_CLOUD_LOCATION_KEY) ??
                null,
            googleCloudProject:
                this.#loadStringSetting(GEMINI_GOOGLE_CLOUD_PROJECT_KEY) ??
                null,
            hasGeminiApiKey:
                this.#loadBooleanSetting(GEMINI_HAS_GEMINI_API_KEY_KEY) ??
                false,
            hasGoogleApiKey:
                this.#loadBooleanSetting(GEMINI_HAS_GOOGLE_API_KEY_KEY) ??
                false,
        };
    }

    saveGeminiRuntimeSettings(settings: GeminiRuntimeSettings): void {
        this.#saveOptionalTrimmedStringSetting(
            GEMINI_BINARY_PATH_KEY,
            settings.binaryPath,
        );
        this.#saveOptionalTrimmedStringSetting(
            GEMINI_AUTH_METHOD_KEY,
            settings.authMethod,
        );
        this.#saveOptionalNumberSetting(
            GEMINI_AUTH_INVALIDATED_AT_KEY,
            settings.authInvalidatedAtMs,
        );
        this.#saveOptionalTrimmedStringSetting(
            GEMINI_GOOGLE_CLOUD_PROJECT_KEY,
            settings.googleCloudProject,
        );
        this.#saveOptionalTrimmedStringSetting(
            GEMINI_GOOGLE_CLOUD_LOCATION_KEY,
            settings.googleCloudLocation,
        );
        this.#saveBooleanSetting(
            GEMINI_HAS_GEMINI_API_KEY_KEY,
            settings.hasGeminiApiKey,
        );
        this.#saveBooleanSetting(
            GEMINI_HAS_GOOGLE_API_KEY_KEY,
            settings.hasGoogleApiKey,
        );
    }

    loadKiloRuntimeSettings(): KiloRuntimeSettings {
        return {
            authInvalidatedAtMs: this.#loadNumberSetting(
                KILO_AUTH_INVALIDATED_AT_KEY,
            ),
            binaryPath: this.#loadStringSetting(KILO_BINARY_PATH_KEY) ?? null,
        };
    }

    saveKiloRuntimeSettings(settings: KiloRuntimeSettings): void {
        this.#saveOptionalTrimmedStringSetting(
            KILO_BINARY_PATH_KEY,
            settings.binaryPath,
        );
        this.#saveOptionalNumberSetting(
            KILO_AUTH_INVALIDATED_AT_KEY,
            settings.authInvalidatedAtMs,
        );
    }

    #loadJsonSetting<T>(key: string): T | null {
        const row = this.#connection
            .prepare<
                [string],
                SettingRow | undefined
            >("SELECT value FROM app_settings WHERE key = ?")
            .get(key);

        if (!row) {
            return null;
        }

        try {
            return JSON.parse(row.value) as T;
        } catch {
            return null;
        }
    }

    #loadStringSetting(key: string): string | null {
        const row = this.#connection
            .prepare<
                [string],
                SettingRow | undefined
            >("SELECT value FROM app_settings WHERE key = ?")
            .get(key);

        return row?.value ?? null;
    }

    #loadProjectStringSetting(projectId: string, key: string): string | null {
        const row = this.#connection
            .prepare<[string, string], SettingRow | undefined>(
                `
                SELECT value
                FROM project_settings
                WHERE project_id = ? AND key = ?
                `,
            )
            .get(projectId, key);

        return row?.value ?? null;
    }

    #loadProjectNumberSetting(projectId: string, key: string): number | null {
        const value = this.#loadProjectStringSetting(projectId, key);
        if (value === null) {
            return null;
        }

        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    #loadBooleanSetting(key: string): boolean | null {
        const value = this.#loadStringSetting(key);
        if (value === null) {
            return null;
        }

        return value === "1";
    }

    #loadNumberSetting(key: string): number | null {
        const value = this.#loadStringSetting(key);
        if (value === null) {
            return null;
        }

        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    #saveSetting(key: string, value: string): void {
        this.#connection
            .prepare<[string, string, string], void>(
                `
                INSERT INTO app_settings (key, value, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value,
                    updated_at = excluded.updated_at
                `,
            )
            .run(key, value, new Date().toISOString());
    }

    #saveOptionalTrimmedStringSetting(key: string, value: string | null): void {
        if (value?.trim()) {
            this.#saveSetting(key, value.trim());
            return;
        }

        this.#deleteSetting(key);
    }

    #saveOptionalNumberSetting(key: string, value: number | null): void {
        if (typeof value === "number" && Number.isFinite(value)) {
            this.#saveSetting(key, String(value));
            return;
        }

        this.#deleteSetting(key);
    }

    #saveBooleanSetting(key: string, value: boolean): void {
        this.#saveSetting(key, value ? "1" : "0");
    }

    #saveProjectSetting(projectId: string, key: string, value: string): void {
        this.#connection
            .prepare<[string, string, string, string], void>(
                `
                INSERT INTO project_settings (project_id, key, value, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(project_id, key) DO UPDATE SET
                    value = excluded.value,
                    updated_at = excluded.updated_at
                `,
            )
            .run(projectId, key, value, new Date().toISOString());
    }

    #saveOptionalProjectThemeMode(
        projectId: string,
        key: string,
        value: ProjectAppearanceSettings["themeMode"],
    ): void {
        const normalized = this.#normalizeOptionalThemeMode(value);
        if (normalized === null) {
            this.#deleteProjectSetting(projectId, key);
            return;
        }

        this.#saveProjectSetting(projectId, key, normalized);
    }

    #saveOptionalProjectThemePreset(
        projectId: string,
        key: string,
        value: ProjectAppearanceSettings["themePreset"],
    ): void {
        const normalized = this.#normalizeOptionalThemePreset(value);
        if (normalized === null) {
            this.#deleteProjectSetting(projectId, key);
            return;
        }

        this.#saveProjectSetting(projectId, key, normalized);
    }

    #saveOptionalProjectEditorFontFamily(
        projectId: string,
        key: string,
        value: ProjectEditorSettings["fontFamily"],
    ): void {
        const normalized = this.#normalizeOptionalEditorFontFamily(value);
        if (normalized === null) {
            this.#deleteProjectSetting(projectId, key);
            return;
        }

        this.#saveProjectSetting(projectId, key, normalized);
    }

    #saveOptionalProjectEditorNumber(
        projectId: string,
        key: string,
        value: number | null,
    ): void {
        if (value === null) {
            this.#deleteProjectSetting(projectId, key);
            return;
        }

        this.#saveProjectSetting(projectId, key, String(value));
    }

    #deleteSetting(key: string): void {
        this.#connection
            .prepare<[string], void>("DELETE FROM app_settings WHERE key = ?")
            .run(key);
    }

    #deleteProjectSetting(projectId: string, key: string): void {
        this.#connection
            .prepare<
                [string, string],
                void
            >("DELETE FROM project_settings WHERE project_id = ? AND key = ?")
            .run(projectId, key);
    }

    #normalizeThemeMode(value: string | null | undefined): ThemeMode {
        return VALID_THEME_MODES.has(value as ThemeMode)
            ? (value as ThemeMode)
            : DEFAULT_THEME_MODE;
    }

    #normalizeThemePreset(value: string | null | undefined): ThemePreset {
        return VALID_THEME_PRESETS.has(value as ThemePreset)
            ? (value as ThemePreset)
            : DEFAULT_THEME_PRESET;
    }

    #normalizeOptionalThemeMode(
        value: string | null | undefined,
    ): ThemeMode | null {
        if (!value) {
            return null;
        }

        return VALID_THEME_MODES.has(value as ThemeMode)
            ? (value as ThemeMode)
            : null;
    }

    #normalizeOptionalThemePreset(
        value: string | null | undefined,
    ): ThemePreset | null {
        if (!value) {
            return null;
        }

        return VALID_THEME_PRESETS.has(value as ThemePreset)
            ? (value as ThemePreset)
            : null;
    }

    #normalizeEditorFontFamily(
        value: string | null | undefined,
    ): EditorFontFamily {
        return VALID_EDITOR_FONT_FAMILIES.has(value as EditorFontFamily)
            ? (value as EditorFontFamily)
            : DEFAULT_EDITOR_FONT_FAMILY;
    }

    #normalizeOptionalEditorFontFamily(
        value: string | null | undefined,
    ): EditorFontFamily | null {
        if (!value) {
            return null;
        }

        return VALID_EDITOR_FONT_FAMILIES.has(value as EditorFontFamily)
            ? (value as EditorFontFamily)
            : null;
    }

    #normalizeEditorFontSize(value: number | null | undefined): number {
        if (typeof value !== "number" || !Number.isFinite(value)) {
            return DEFAULT_EDITOR_FONT_SIZE;
        }

        return clampRoundedInt(
            value,
            EDITOR_FONT_SIZE_MIN,
            EDITOR_FONT_SIZE_MAX,
        );
    }

    #normalizeOptionalEditorFontSize(
        value: number | null | undefined,
    ): number | null {
        if (typeof value !== "number" || !Number.isFinite(value)) {
            return null;
        }

        return clampRoundedInt(
            value,
            EDITOR_FONT_SIZE_MIN,
            EDITOR_FONT_SIZE_MAX,
        );
    }

    #normalizeEditorLineHeight(value: number | null | undefined): number {
        if (typeof value !== "number" || !Number.isFinite(value)) {
            return DEFAULT_EDITOR_LINE_HEIGHT;
        }

        return Math.min(2, Math.max(1.2, Math.round(value * 100) / 100));
    }

    #normalizeOptionalEditorLineHeight(
        value: number | null | undefined,
    ): number | null {
        if (typeof value !== "number" || !Number.isFinite(value)) {
            return null;
        }

        return Math.min(2, Math.max(1.2, Math.round(value * 100) / 100));
    }

    #normalizeChatFontFamily(value: string | null | undefined): ChatFontFamily {
        return VALID_CHAT_FONT_FAMILIES.has(value as ChatFontFamily)
            ? (value as ChatFontFamily)
            : DEFAULT_CHAT_FONT_FAMILY;
    }

    #normalizeChatFontSize(value: number | null | undefined): number {
        if (typeof value !== "number" || !Number.isFinite(value)) {
            return DEFAULT_CHAT_FONT_SIZE;
        }

        return clampRoundedInt(
            value,
            AI_CHAT_FONT_SIZE_MIN,
            AI_CHAT_FONT_SIZE_MAX,
        );
    }

    #normalizeComposerFontSize(value: number | null | undefined): number {
        if (typeof value !== "number" || !Number.isFinite(value)) {
            return DEFAULT_COMPOSER_FONT_SIZE;
        }

        return clampRoundedInt(
            value,
            AI_COMPOSER_FONT_SIZE_MIN,
            AI_COMPOSER_FONT_SIZE_MAX,
        );
    }
}
