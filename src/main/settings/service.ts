import type Database from "better-sqlite3";

import {
    AGENTS_SIDEBAR_SCALE_DEFAULT,
    clampAgentsSidebarScale,
} from "@shared/agents-sidebar-scale";
import { clampAppZoomFactor } from "@shared/app-zoom";
import {
    EDITOR_AUTOSAVE_DELAY_MS_DEFAULT,
    clampEditorAutosaveDelayMs,
} from "@shared/editor-autosave";
import {
    FILE_TREE_SCALE_DEFAULT,
    clampFileTreeScale,
} from "@shared/file-tree-scale";
import {
    normalizeAppTerminalSettings,
    type AppTerminalSettings,
} from "@shared/terminal-settings";
import type {
    AppAiChatSettings,
    AppAppearanceSettings,
    AppEditorSettings,
    AiToolCardExpansionMode,
    ChatFontFamily,
    ClaudeRuntimeSettings,
    CodexRuntimeSettings,
    EditorFontFamily,
    GeminiRuntimeSettings,
    GrokRuntimeSettings,
    KiloRuntimeSettings,
    OpenCodeRuntimeSettings,
    PersistedShellState,
    ProjectSettingsSnapshot,
    SettingsSnapshot,
    ThemeMode,
    ThemePreset,
} from "@shared/ipc";

import type { SecretRecordPatch } from "../ai/secret-store";
import {
    AI_CHAT_FONT_SIZE_MAX,
    AI_CHAT_FONT_SIZE_MIN,
    AI_COMPOSER_FONT_SIZE_MAX,
    AI_COMPOSER_FONT_SIZE_MIN,
    clampRoundedInt,
    DEFAULT_AI_CHAT_FONT_FAMILY,
    DEFAULT_AI_CHAT_FONT_SIZE,
    DEFAULT_AI_COMPOSER_FONT_FAMILY,
    DEFAULT_AI_COMPOSER_FONT_SIZE,
    DEFAULT_EDITOR_FONT_FAMILY,
    DEFAULT_EDITOR_FONT_SIZE,
    EDITOR_FONT_FAMILY_IDS,
    EDITOR_FONT_SIZE_MAX,
    EDITOR_FONT_SIZE_MIN,
} from "@shared/typography";

import { debugBenignError } from "@main/observability/logging";

const CLAUDE_AUTH_INVALIDATED_AT_KEY = "ai.claude.auth_invalidated_at_ms";
const CLAUDE_AUTH_METHOD_KEY = "ai.claude.auth_method";
const CODEX_AUTH_METHOD_KEY = "ai.codex.auth_method";
const CODEX_BINARY_PATH_KEY = "ai.codex.binary_path";
const CODEX_HAS_CODEX_API_KEY_KEY = "ai.codex.has_codex_api_key";
const CODEX_HAS_OPENAI_API_KEY_KEY = "ai.codex.has_openai_api_key";
const CLAUDE_BINARY_PATH_KEY = "ai.claude.binary_path";
const CLAUDE_BEDROCK_GATEWAY_BASE_URL_KEY =
    "ai.claude.bedrock_gateway_base_url";
const CLAUDE_GATEWAY_BASE_URL_KEY = "ai.claude.gateway_base_url";
const CLAUDE_HAS_ANTHROPIC_API_KEY_KEY = "ai.claude.has_anthropic_api_key";
const CLAUDE_HAS_GATEWAY_AUTH_TOKEN_KEY = "ai.claude.has_gateway_auth_token";
const CLAUDE_HAS_GATEWAY_CUSTOM_HEADERS_KEY =
    "ai.claude.has_gateway_custom_headers";
const GROK_AUTH_INVALIDATED_AT_KEY = "ai.grok.auth_invalidated_at_ms";
const GROK_AUTH_METHOD_KEY = "ai.grok.auth_method";
const GROK_BINARY_PATH_KEY = "ai.grok.binary_path";
const GROK_HAS_XAI_API_KEY_KEY = "ai.grok.has_xai_api_key";
const KILO_AUTH_INVALIDATED_AT_KEY = "ai.kilo.auth_invalidated_at_ms";
const KILO_AUTH_METHOD_KEY = "ai.kilo.auth_method";
const KILO_BINARY_PATH_KEY = "ai.kilo.binary_path";
const KILO_HAS_KILO_API_KEY_KEY = "ai.kilo.has_kilo_api_key";
const OPENCODE_AUTH_INVALIDATED_AT_KEY =
    "ai.opencode.auth_invalidated_at_ms";
const OPENCODE_AUTH_METHOD_KEY = "ai.opencode.auth_method";
const OPENCODE_BINARY_PATH_KEY = "ai.opencode.binary_path";
const APP_BOOST_CODE_CONTRAST_KEY = "appearance.boost_code_contrast";
const APP_AGENTS_SIDEBAR_SCALE_KEY = "appearance.agents_sidebar_scale";
const APP_FILE_TREE_SCALE_KEY = "appearance.file_tree_scale";
const APP_STICKY_FOLDERS_ENABLED_KEY = "appearance.sticky_folders_enabled";
const APP_THEME_MODE_KEY = "appearance.theme_mode";
const APP_THEME_PRESET_KEY = "appearance.theme_preset";
const APP_ZOOM_FACTOR_KEY = "appearance.zoom_factor";
const APP_EDITOR_FONT_FAMILY_KEY = "editor.font_family";
const APP_EDITOR_FONT_SIZE_KEY = "editor.font_size";
const APP_EDITOR_LINE_HEIGHT_KEY = "editor.line_height";
const APP_EDITOR_AUTOSAVE_DELAY_MS_KEY = "editor.autosave_delay_ms";
const APP_EDITOR_MINIMAP_ENABLED_KEY = "editor.minimap_enabled";
const APP_EDITOR_RELATIVE_LINE_NUMBERS_ENABLED_KEY =
    "editor.relative_line_numbers_enabled";
const APP_EDITOR_SUGGESTIONS_ENABLED_KEY = "editor.suggestions_enabled";
const APP_EDITOR_VIM_MODE_ENABLED_KEY = "editor.vim_mode_enabled";
const APP_TERMINAL_FONT_FAMILY_KEY = "terminal.font_family";
const APP_TERMINAL_FONT_SIZE_KEY = "terminal.font_size";
const APP_TERMINAL_WINDOWS_SHELL_KEY = "terminal.windows_shell";
const APP_TERMINAL_CLAUDE_CODE_OPTIMIZED_KEY =
    "terminal.claude_code_optimized";
const APP_TERMINAL_CLAUDE_CODE_SKIP_PERMISSIONS_KEY =
    "terminal.claude_code_skip_permissions";
const APP_TERMINAL_CLAUDE_CODE_MODEL_KEY = "terminal.claude_code_model";
const APP_TERMINAL_CLAUDE_CODE_CONTINUE_SESSION_KEY =
    "terminal.claude_code_continue_session";
const APP_TERMINAL_CLAUDE_CODE_MAX_TURNS_KEY =
    "terminal.claude_code_max_turns";
const PROJECT_THEME_MODE_KEY = "appearance.theme_mode";
const PROJECT_THEME_PRESET_KEY = "appearance.theme_preset";
const PROJECT_EDITOR_FONT_FAMILY_KEY = "editor.font_family";
const PROJECT_EDITOR_FONT_SIZE_KEY = "editor.font_size";
const PROJECT_EDITOR_LINE_HEIGHT_KEY = "editor.line_height";
const PROJECT_EDITOR_MINIMAP_ENABLED_KEY = "editor.minimap_enabled";
const PROJECT_EDITOR_SUGGESTIONS_ENABLED_KEY = "editor.suggestions_enabled";

const AI_CHAT_FONT_FAMILY_KEY = "ai.chat.font_family";
const AI_CHAT_FONT_SIZE_KEY = "ai.chat.font_size";
const AI_COMPOSER_FONT_FAMILY_KEY = "ai.composer.font_family";
const AI_COMPOSER_FONT_SIZE_KEY = "ai.composer.font_size";
const AI_REVIEW_DIFF_ZOOM_KEY = "ai.review.diff_zoom";
const AI_REQUIRE_CMD_ENTER_KEY = "ai.composer.require_cmd_enter";
const AI_SCREENSHOT_RETENTION_KEY = "ai.composer.screenshot_retention_seconds";
const AI_HISTORY_RETENTION_KEY = "ai.chat.history_retention_days";
const AI_CONTEXT_USAGE_BAR_KEY = "ai.composer.context_usage_bar_enabled";
const AI_TOOL_CARD_EXPANSION_MODE_KEY = "ai.chat.tool_card_expansion_mode";

const DEFAULT_CHAT_FONT_FAMILY: ChatFontFamily = DEFAULT_AI_CHAT_FONT_FAMILY;
const DEFAULT_CHAT_FONT_SIZE = DEFAULT_AI_CHAT_FONT_SIZE;
const DEFAULT_COMPOSER_FONT_FAMILY: ChatFontFamily =
    DEFAULT_AI_COMPOSER_FONT_FAMILY;
const DEFAULT_COMPOSER_FONT_SIZE = DEFAULT_AI_COMPOSER_FONT_SIZE;
const DEFAULT_REVIEW_DIFF_ZOOM = 0.96;
const DEFAULT_REQUIRE_CMD_ENTER = false;
const DEFAULT_SCREENSHOT_RETENTION = 0;
const DEFAULT_HISTORY_RETENTION = 0;
const DEFAULT_CONTEXT_USAGE_BAR = true;
const DEFAULT_TOOL_CARD_EXPANSION_MODE: AiToolCardExpansionMode = "collapsed";
const REVIEW_DIFF_ZOOM_MIN = 0.64;
const REVIEW_DIFF_ZOOM_MAX = 0.96;

const VALID_CHAT_FONT_FAMILIES = new Set<ChatFontFamily>(
    EDITOR_FONT_FAMILY_IDS,
);
const VALID_TOOL_CARD_EXPANSION_MODES = new Set<AiToolCardExpansionMode>([
    "collapsed",
    "latest",
    "expanded",
]);

const DEFAULT_THEME_MODE: ThemeMode = "system";
const DEFAULT_THEME_PRESET: ThemePreset = "default";
const DEFAULT_STICKY_FOLDERS_ENABLED = true;
const DEFAULT_EDITOR_LINE_HEIGHT = 1.55;
const DEFAULT_EDITOR_AUTOSAVE_DELAY_MS = EDITOR_AUTOSAVE_DELAY_MS_DEFAULT;
const DEFAULT_EDITOR_MINIMAP_ENABLED = true;
const DEFAULT_EDITOR_RELATIVE_LINE_NUMBERS_ENABLED = false;
const DEFAULT_EDITOR_SUGGESTIONS_ENABLED = true;
const DEFAULT_EDITOR_VIM_MODE_ENABLED = false;

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
const VALID_EDITOR_FONT_FAMILIES = new Set<EditorFontFamily>(
    EDITOR_FONT_FAMILY_IDS,
);

function createRemovedGeminiRuntimeSettings(): GeminiRuntimeSettings {
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

function normalizeFontFamilyAlias(
    value: string | null | undefined,
): string | null | undefined {
    if (value === "jetbrains-mono") {
        return "jetbrains";
    }

    return value;
}

interface SettingRow {
    readonly value: string;
}

export interface SettingsGateway {
    runTransaction?(action: () => void): void;
    saveCodexAuth?(
        settings: CodexRuntimeSettings,
        secrets: readonly SecretRecordPatch[],
    ): Promise<void>;
    saveClaudeAuth?(
        settings: ClaudeRuntimeSettings,
        secrets: readonly SecretRecordPatch[],
    ): Promise<void>;
    saveGrokAuth?(
        settings: GrokRuntimeSettings,
        secrets: readonly SecretRecordPatch[],
    ): Promise<void>;
    saveKiloAuth?(
        settings: KiloRuntimeSettings,
        secrets: readonly SecretRecordPatch[],
    ): Promise<void>;
    saveOpenCodeAuth?(
        settings: OpenCodeRuntimeSettings,
        secrets: readonly SecretRecordPatch[],
    ): Promise<void>;
    loadSnapshot(): SettingsSnapshot;
    saveSnapshot(snapshot: SettingsSnapshot): void;
    loadAppAppearanceSettings(): AppAppearanceSettings;
    saveAppAppearanceSettings(settings: AppAppearanceSettings): void;
    loadAppEditorSettings(): AppEditorSettings;
    saveAppEditorSettings(settings: AppEditorSettings): void;
    loadAiChatSettings(): AppAiChatSettings;
    saveAiChatSettings(settings: AppAiChatSettings): void;
    loadAppTerminalSettings(): AppTerminalSettings;
    saveAppTerminalSettings(settings: AppTerminalSettings): void;
    loadProjectSettings(projectId: string): ProjectSettingsSnapshot | null;
    saveProjectSettings(snapshot: ProjectSettingsSnapshot): void;
    loadCodexRuntimeSettings(): CodexRuntimeSettings;
    saveCodexRuntimeSettings(settings: CodexRuntimeSettings): void;
    loadClaudeRuntimeSettings(): ClaudeRuntimeSettings;
    saveClaudeRuntimeSettings(settings: ClaudeRuntimeSettings): void;
    loadGrokRuntimeSettings(): GrokRuntimeSettings;
    saveGrokRuntimeSettings(settings: GrokRuntimeSettings): void;
    loadKiloRuntimeSettings(): KiloRuntimeSettings;
    saveKiloRuntimeSettings(settings: KiloRuntimeSettings): void;
    loadOpenCodeRuntimeSettings(): OpenCodeRuntimeSettings;
    saveOpenCodeRuntimeSettings(settings: OpenCodeRuntimeSettings): void;
}

export class SettingsService {
    readonly #connection: Database.Database;

    constructor(connection: Database.Database) {
        this.#connection = connection;
    }

    runTransaction(action: () => void): void {
        this.#connection.transaction(action)();
    }

    loadSnapshot(): SettingsSnapshot {
        return {
            ai: {
                claude: this.loadClaudeRuntimeSettings(),
                codex: this.loadCodexRuntimeSettings(),
                gemini: createRemovedGeminiRuntimeSettings(),
                grok: this.loadGrokRuntimeSettings(),
                kilo: this.loadKiloRuntimeSettings(),
                opencode: this.loadOpenCodeRuntimeSettings(),
            },
            aiChat: this.loadAiChatSettings(),
            appearance: this.loadAppAppearanceSettings(),
            editor: this.loadAppEditorSettings(),
            shellState:
                this.#loadJsonSetting<PersistedShellState>("shell.state"),
            terminal: this.loadAppTerminalSettings(),
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

        if (snapshot.ai?.grok) {
            this.saveGrokRuntimeSettings(snapshot.ai.grok);
        }

        if (snapshot.ai?.kilo) {
            this.saveKiloRuntimeSettings(snapshot.ai.kilo);
        }

        if (snapshot.ai?.opencode) {
            this.saveOpenCodeRuntimeSettings(snapshot.ai.opencode);
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

        if (snapshot.terminal) {
            this.saveAppTerminalSettings(snapshot.terminal);
        }
    }

    loadAppAppearanceSettings(): AppAppearanceSettings {
        return {
            agentsSidebarScale: this.#normalizeAgentsSidebarScale(
                this.#loadNumberSetting(APP_AGENTS_SIDEBAR_SCALE_KEY),
            ),
            boostCodeContrast:
                this.#loadBooleanSetting(APP_BOOST_CODE_CONTRAST_KEY) ?? true,
            fileTreeScale: this.#normalizeFileTreeScale(
                this.#loadNumberSetting(APP_FILE_TREE_SCALE_KEY),
            ),
            stickyFoldersEnabled:
                this.#loadBooleanSetting(APP_STICKY_FOLDERS_ENABLED_KEY) ??
                DEFAULT_STICKY_FOLDERS_ENABLED,
            themeMode: this.#normalizeThemeMode(
                this.#loadStringSetting(APP_THEME_MODE_KEY),
            ),
            themePreset: this.#normalizeThemePreset(
                this.#loadStringSetting(APP_THEME_PRESET_KEY),
            ),
            zoomFactor: this.#normalizeAppZoomFactor(
                this.#loadNumberSetting(APP_ZOOM_FACTOR_KEY),
            ),
        };
    }

    saveAppAppearanceSettings(settings: AppAppearanceSettings): void {
        this.#saveSetting(
            APP_AGENTS_SIDEBAR_SCALE_KEY,
            String(
                this.#normalizeAgentsSidebarScale(settings.agentsSidebarScale),
            ),
        );
        this.#saveBooleanSetting(
            APP_BOOST_CODE_CONTRAST_KEY,
            settings.boostCodeContrast,
        );
        this.#saveSetting(
            APP_FILE_TREE_SCALE_KEY,
            String(this.#normalizeFileTreeScale(settings.fileTreeScale)),
        );
        this.#saveBooleanSetting(
            APP_STICKY_FOLDERS_ENABLED_KEY,
            settings.stickyFoldersEnabled ?? DEFAULT_STICKY_FOLDERS_ENABLED,
        );
        this.#saveSetting(
            APP_THEME_MODE_KEY,
            this.#normalizeThemeMode(settings.themeMode),
        );
        this.#saveSetting(
            APP_THEME_PRESET_KEY,
            this.#normalizeThemePreset(settings.themePreset),
        );
        this.#saveSetting(
            APP_ZOOM_FACTOR_KEY,
            String(this.#normalizeAppZoomFactor(settings.zoomFactor)),
        );
    }

    loadAppEditorSettings(): AppEditorSettings {
        return {
            autoSaveDelayMs: this.#normalizeEditorAutosaveDelayMs(
                this.#loadNumberSetting(APP_EDITOR_AUTOSAVE_DELAY_MS_KEY),
            ),
            fontFamily: this.#normalizeEditorFontFamily(
                this.#loadStringSetting(APP_EDITOR_FONT_FAMILY_KEY),
            ),
            fontSize: this.#normalizeEditorFontSize(
                this.#loadNumberSetting(APP_EDITOR_FONT_SIZE_KEY),
            ),
            lineHeight: this.#normalizeEditorLineHeight(
                this.#loadNumberSetting(APP_EDITOR_LINE_HEIGHT_KEY),
            ),
            minimapEnabled: this.#normalizeEditorMinimapEnabled(
                this.#loadBooleanSetting(APP_EDITOR_MINIMAP_ENABLED_KEY),
            ),
            relativeLineNumbersEnabled:
                this.#normalizeEditorRelativeLineNumbersEnabled(
                    this.#loadBooleanSetting(
                        APP_EDITOR_RELATIVE_LINE_NUMBERS_ENABLED_KEY,
                    ),
                ),
            suggestionsEnabled: this.#normalizeEditorSuggestionsEnabled(
                this.#loadBooleanSetting(APP_EDITOR_SUGGESTIONS_ENABLED_KEY),
            ),
            vimModeEnabled: this.#normalizeEditorVimModeEnabled(
                this.#loadBooleanSetting(APP_EDITOR_VIM_MODE_ENABLED_KEY),
            ),
        };
    }

    saveAppEditorSettings(settings: AppEditorSettings): void {
        this.#saveSetting(
            APP_EDITOR_AUTOSAVE_DELAY_MS_KEY,
            String(
                this.#normalizeEditorAutosaveDelayMs(settings.autoSaveDelayMs),
            ),
        );
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
        this.#saveBooleanSetting(
            APP_EDITOR_MINIMAP_ENABLED_KEY,
            this.#normalizeEditorMinimapEnabled(settings.minimapEnabled),
        );
        this.#saveBooleanSetting(
            APP_EDITOR_RELATIVE_LINE_NUMBERS_ENABLED_KEY,
            this.#normalizeEditorRelativeLineNumbersEnabled(
                settings.relativeLineNumbersEnabled,
            ),
        );
        this.#saveBooleanSetting(
            APP_EDITOR_SUGGESTIONS_ENABLED_KEY,
            this.#normalizeEditorSuggestionsEnabled(
                settings.suggestionsEnabled,
            ),
        );
        this.#saveBooleanSetting(
            APP_EDITOR_VIM_MODE_ENABLED_KEY,
            this.#normalizeEditorVimModeEnabled(settings.vimModeEnabled),
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
            composerFontFamily: this.#normalizeComposerFontFamily(
                this.#loadStringSetting(AI_COMPOSER_FONT_FAMILY_KEY),
            ),
            composerFontSize: this.#normalizeComposerFontSize(
                this.#loadNumberSetting(AI_COMPOSER_FONT_SIZE_KEY),
            ),
            reviewDiffZoom: this.#normalizeReviewDiffZoom(
                this.#loadNumberSetting(AI_REVIEW_DIFF_ZOOM_KEY),
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
            contextUsageBarEnabled: this.#loadContextUsageBarEnabled(),
            toolCardExpansionMode: this.#normalizeToolCardExpansionMode(
                this.#loadStringSetting(AI_TOOL_CARD_EXPANSION_MODE_KEY),
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
            this.#normalizeComposerFontFamily(settings.composerFontFamily),
        );
        this.#saveSetting(
            AI_COMPOSER_FONT_SIZE_KEY,
            String(this.#normalizeComposerFontSize(settings.composerFontSize)),
        );
        this.#deleteSetting("ai.review.pending_review_card_text_zoom");
        this.#saveSetting(
            AI_REVIEW_DIFF_ZOOM_KEY,
            String(this.#normalizeReviewDiffZoom(settings.reviewDiffZoom)),
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
        this.#saveSetting(
            AI_CONTEXT_USAGE_BAR_KEY,
            String(settings.contextUsageBarEnabled),
        );
        this.#saveSetting(
            AI_TOOL_CARD_EXPANSION_MODE_KEY,
            this.#normalizeToolCardExpansionMode(
                settings.toolCardExpansionMode,
            ),
        );
    }

    loadAppTerminalSettings(): AppTerminalSettings {
        return normalizeAppTerminalSettings({
            claudeCodeContinueSession: this.#loadBooleanSetting(
                APP_TERMINAL_CLAUDE_CODE_CONTINUE_SESSION_KEY,
            ),
            claudeCodeMaxTurns: this.#loadNumberSetting(
                APP_TERMINAL_CLAUDE_CODE_MAX_TURNS_KEY,
            ),
            claudeCodeModel: this.#loadStringSetting(
                APP_TERMINAL_CLAUDE_CODE_MODEL_KEY,
            ),
            claudeCodeOptimized: this.#loadBooleanSetting(
                APP_TERMINAL_CLAUDE_CODE_OPTIMIZED_KEY,
            ),
            claudeCodeSkipPermissions: this.#loadBooleanSetting(
                APP_TERMINAL_CLAUDE_CODE_SKIP_PERMISSIONS_KEY,
            ),
            terminalFontFamily: this.#loadStringSetting(
                APP_TERMINAL_FONT_FAMILY_KEY,
            ),
            terminalFontSize: this.#loadNumberSetting(
                APP_TERMINAL_FONT_SIZE_KEY,
            ),
            windowsShell: this.#loadStringSetting(
                APP_TERMINAL_WINDOWS_SHELL_KEY,
            ),
        });
    }

    saveAppTerminalSettings(settings: AppTerminalSettings): void {
        const normalized = normalizeAppTerminalSettings(settings);
        this.#saveSetting(
            APP_TERMINAL_FONT_FAMILY_KEY,
            normalized.terminalFontFamily,
        );
        this.#saveSetting(
            APP_TERMINAL_FONT_SIZE_KEY,
            String(normalized.terminalFontSize),
        );
        this.#saveSetting(
            APP_TERMINAL_WINDOWS_SHELL_KEY,
            normalized.windowsShell,
        );
        this.#saveBooleanSetting(
            APP_TERMINAL_CLAUDE_CODE_OPTIMIZED_KEY,
            normalized.claudeCodeOptimized,
        );
        this.#saveBooleanSetting(
            APP_TERMINAL_CLAUDE_CODE_SKIP_PERMISSIONS_KEY,
            normalized.claudeCodeSkipPermissions,
        );
        this.#saveSetting(
            APP_TERMINAL_CLAUDE_CODE_MODEL_KEY,
            normalized.claudeCodeModel,
        );
        this.#saveBooleanSetting(
            APP_TERMINAL_CLAUDE_CODE_CONTINUE_SESSION_KEY,
            normalized.claudeCodeContinueSession,
        );
        this.#saveSetting(
            APP_TERMINAL_CLAUDE_CODE_MAX_TURNS_KEY,
            String(normalized.claudeCodeMaxTurns),
        );
    }

    loadProjectSettings(projectId: string): ProjectSettingsSnapshot | null {
        void projectId;
        return null;
    }

    saveProjectSettings(snapshot: ProjectSettingsSnapshot): void {
        this.#deleteLegacyProjectSettings(snapshot.projectId);
    }

    loadCodexRuntimeSettings(): CodexRuntimeSettings {
        return {
            authMethod:
                (this.#loadStringSetting(
                    CODEX_AUTH_METHOD_KEY,
                ) as CodexRuntimeSettings["authMethod"]) ?? null,
            binaryPath: this.#loadStringSetting(CODEX_BINARY_PATH_KEY) ?? null,
            hasCodexApiKey:
                this.#loadBooleanSetting(CODEX_HAS_CODEX_API_KEY_KEY) ?? false,
            hasOpenAiApiKey:
                this.#loadBooleanSetting(CODEX_HAS_OPENAI_API_KEY_KEY) ?? false,
        };
    }

    saveCodexRuntimeSettings(settings: CodexRuntimeSettings): void {
        this.#saveOptionalTrimmedStringSetting(
            CODEX_AUTH_METHOD_KEY,
            settings.authMethod,
        );
        this.#saveOptionalTrimmedStringSetting(
            CODEX_BINARY_PATH_KEY,
            settings.binaryPath,
        );
        this.#saveBooleanSetting(
            CODEX_HAS_CODEX_API_KEY_KEY,
            settings.hasCodexApiKey,
        );
        this.#saveBooleanSetting(
            CODEX_HAS_OPENAI_API_KEY_KEY,
            settings.hasOpenAiApiKey,
        );
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
            bedrockGatewayBaseUrl:
                this.#loadStringSetting(CLAUDE_BEDROCK_GATEWAY_BASE_URL_KEY) ??
                null,
            binaryPath: this.#loadStringSetting(CLAUDE_BINARY_PATH_KEY) ?? null,
            gatewayBaseUrl:
                this.#loadStringSetting(CLAUDE_GATEWAY_BASE_URL_KEY) ?? null,
            hasAnthropicApiKey:
                this.#loadBooleanSetting(CLAUDE_HAS_ANTHROPIC_API_KEY_KEY) ??
                false,
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
            CLAUDE_BEDROCK_GATEWAY_BASE_URL_KEY,
            settings.bedrockGatewayBaseUrl,
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
            CLAUDE_HAS_ANTHROPIC_API_KEY_KEY,
            settings.hasAnthropicApiKey,
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

    loadGrokRuntimeSettings(): GrokRuntimeSettings {
        return {
            authInvalidatedAtMs: this.#loadNumberSetting(
                GROK_AUTH_INVALIDATED_AT_KEY,
            ),
            authMethod:
                (this.#loadStringSetting(
                    GROK_AUTH_METHOD_KEY,
                ) as GrokRuntimeSettings["authMethod"]) ?? null,
            binaryPath: this.#loadStringSetting(GROK_BINARY_PATH_KEY) ?? null,
            hasXaiApiKey:
                this.#loadBooleanSetting(GROK_HAS_XAI_API_KEY_KEY) ?? false,
        };
    }

    saveGrokRuntimeSettings(settings: GrokRuntimeSettings): void {
        this.#saveOptionalTrimmedStringSetting(
            GROK_BINARY_PATH_KEY,
            settings.binaryPath,
        );
        this.#saveOptionalTrimmedStringSetting(
            GROK_AUTH_METHOD_KEY,
            settings.authMethod,
        );
        this.#saveOptionalNumberSetting(
            GROK_AUTH_INVALIDATED_AT_KEY,
            settings.authInvalidatedAtMs,
        );
        this.#saveBooleanSetting(
            GROK_HAS_XAI_API_KEY_KEY,
            settings.hasXaiApiKey,
        );
    }

    loadKiloRuntimeSettings(): KiloRuntimeSettings {
        return {
            authInvalidatedAtMs: this.#loadNumberSetting(
                KILO_AUTH_INVALIDATED_AT_KEY,
            ),
            authMethod:
                (this.#loadStringSetting(
                    KILO_AUTH_METHOD_KEY,
                ) as KiloRuntimeSettings["authMethod"]) ?? null,
            binaryPath: this.#loadStringSetting(KILO_BINARY_PATH_KEY) ?? null,
            hasKiloApiKey:
                this.#loadBooleanSetting(KILO_HAS_KILO_API_KEY_KEY) ?? false,
        };
    }

    saveKiloRuntimeSettings(settings: KiloRuntimeSettings): void {
        this.#saveOptionalTrimmedStringSetting(
            KILO_AUTH_METHOD_KEY,
            settings.authMethod,
        );
        this.#saveOptionalTrimmedStringSetting(
            KILO_BINARY_PATH_KEY,
            settings.binaryPath,
        );
        this.#saveOptionalNumberSetting(
            KILO_AUTH_INVALIDATED_AT_KEY,
            settings.authInvalidatedAtMs,
        );
        this.#saveBooleanSetting(
            KILO_HAS_KILO_API_KEY_KEY,
            settings.hasKiloApiKey,
        );
    }

    loadOpenCodeRuntimeSettings(): OpenCodeRuntimeSettings {
        return {
            authInvalidatedAtMs: this.#loadNumberSetting(
                OPENCODE_AUTH_INVALIDATED_AT_KEY,
            ),
            authMethod:
                (this.#loadStringSetting(
                    OPENCODE_AUTH_METHOD_KEY,
                ) as OpenCodeRuntimeSettings["authMethod"]) ?? null,
            binaryPath:
                this.#loadStringSetting(OPENCODE_BINARY_PATH_KEY) ?? null,
        };
    }

    saveOpenCodeRuntimeSettings(settings: OpenCodeRuntimeSettings): void {
        this.#saveOptionalTrimmedStringSetting(
            OPENCODE_AUTH_METHOD_KEY,
            settings.authMethod,
        );
        this.#saveOptionalTrimmedStringSetting(
            OPENCODE_BINARY_PATH_KEY,
            settings.binaryPath,
        );
        this.#saveOptionalNumberSetting(
            OPENCODE_AUTH_INVALIDATED_AT_KEY,
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
        } catch (error) {
            debugBenignError("settings.loadJsonSetting", error);
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

    #loadBooleanSetting(key: string): boolean | null {
        const value = this.#loadStringSetting(key);
        if (value === null) {
            return null;
        }

        if (value === "1" || value === "true") {
            return true;
        }

        if (value === "0" || value === "false") {
            return false;
        }

        return null;
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

    #deleteLegacyProjectSettings(projectId: string): void {
        this.#deleteProjectSetting(projectId, PROJECT_THEME_MODE_KEY);
        this.#deleteProjectSetting(projectId, PROJECT_THEME_PRESET_KEY);
        this.#deleteProjectSetting(projectId, PROJECT_EDITOR_FONT_FAMILY_KEY);
        this.#deleteProjectSetting(projectId, PROJECT_EDITOR_FONT_SIZE_KEY);
        this.#deleteProjectSetting(projectId, PROJECT_EDITOR_LINE_HEIGHT_KEY);
        this.#deleteProjectSetting(
            projectId,
            PROJECT_EDITOR_MINIMAP_ENABLED_KEY,
        );
        this.#deleteProjectSetting(
            projectId,
            PROJECT_EDITOR_SUGGESTIONS_ENABLED_KEY,
        );
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

    #normalizeAppZoomFactor(value: number | null | undefined): number {
        return clampAppZoomFactor(value ?? Number.NaN);
    }

    #normalizeAgentsSidebarScale(value: number | null | undefined): number {
        if (typeof value !== "number") {
            return AGENTS_SIDEBAR_SCALE_DEFAULT;
        }

        return clampAgentsSidebarScale(value);
    }

    #normalizeFileTreeScale(value: number | null | undefined): number {
        if (typeof value !== "number") {
            return FILE_TREE_SCALE_DEFAULT;
        }

        return clampFileTreeScale(value);
    }

    #normalizeEditorFontFamily(
        value: string | null | undefined,
    ): EditorFontFamily {
        const normalizedValue = normalizeFontFamilyAlias(value);
        return VALID_EDITOR_FONT_FAMILIES.has(
            normalizedValue as EditorFontFamily,
        )
            ? (normalizedValue as EditorFontFamily)
            : DEFAULT_EDITOR_FONT_FAMILY;
    }

    #normalizeEditorAutosaveDelayMs(value: number | null | undefined): number {
        if (typeof value !== "number" || !Number.isFinite(value)) {
            return DEFAULT_EDITOR_AUTOSAVE_DELAY_MS;
        }

        return clampEditorAutosaveDelayMs(value);
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

    #normalizeEditorLineHeight(value: number | null | undefined): number {
        if (typeof value !== "number" || !Number.isFinite(value)) {
            return DEFAULT_EDITOR_LINE_HEIGHT;
        }

        return Math.min(2, Math.max(1.2, Math.round(value * 100) / 100));
    }

    #normalizeEditorMinimapEnabled(value: boolean | null | undefined): boolean {
        if (typeof value !== "boolean") {
            return DEFAULT_EDITOR_MINIMAP_ENABLED;
        }

        return value;
    }

    #loadContextUsageBarEnabled(): boolean {
        const raw = this.#loadStringSetting(AI_CONTEXT_USAGE_BAR_KEY);
        if (raw === "true") return true;
        if (raw === "false") return false;
        return DEFAULT_CONTEXT_USAGE_BAR;
    }

    #normalizeEditorSuggestionsEnabled(
        value: boolean | null | undefined,
    ): boolean {
        if (typeof value !== "boolean") {
            return DEFAULT_EDITOR_SUGGESTIONS_ENABLED;
        }

        return value;
    }

    #normalizeEditorRelativeLineNumbersEnabled(
        value: boolean | null | undefined,
    ): boolean {
        if (typeof value !== "boolean") {
            return DEFAULT_EDITOR_RELATIVE_LINE_NUMBERS_ENABLED;
        }

        return value;
    }

    #normalizeEditorVimModeEnabled(
        value: boolean | null | undefined,
    ): boolean {
        if (typeof value !== "boolean") {
            return DEFAULT_EDITOR_VIM_MODE_ENABLED;
        }

        return value;
    }

    #normalizeChatFontFamily(value: string | null | undefined): ChatFontFamily {
        const normalizedValue = normalizeFontFamilyAlias(value);
        return VALID_CHAT_FONT_FAMILIES.has(normalizedValue as ChatFontFamily)
            ? (normalizedValue as ChatFontFamily)
            : DEFAULT_CHAT_FONT_FAMILY;
    }

    #normalizeComposerFontFamily(
        value: string | null | undefined,
    ): ChatFontFamily {
        const normalizedValue = normalizeFontFamilyAlias(value);
        return VALID_CHAT_FONT_FAMILIES.has(normalizedValue as ChatFontFamily)
            ? (normalizedValue as ChatFontFamily)
            : DEFAULT_COMPOSER_FONT_FAMILY;
    }

    #normalizeToolCardExpansionMode(
        value: string | null | undefined,
    ): AiToolCardExpansionMode {
        return VALID_TOOL_CARD_EXPANSION_MODES.has(
            value as AiToolCardExpansionMode,
        )
            ? (value as AiToolCardExpansionMode)
            : DEFAULT_TOOL_CARD_EXPANSION_MODE;
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

    #normalizeReviewDiffZoom(value: number | null | undefined): number {
        if (typeof value !== "number" || !Number.isFinite(value)) {
            return DEFAULT_REVIEW_DIFF_ZOOM;
        }

        return (
            Math.round(
                Math.min(
                    REVIEW_DIFF_ZOOM_MAX,
                    Math.max(REVIEW_DIFF_ZOOM_MIN, value),
                ) * 100,
            ) / 100
        );
    }
}
