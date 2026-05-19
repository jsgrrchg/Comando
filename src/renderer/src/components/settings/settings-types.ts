import type {
    AppChangelogRelease,
    AiToolCardExpansionMode,
    ProjectAppDataSummary,
    AppPrivacyAccessState,
    AppUpdateState,
    GitHubAuthStatus,
} from "@shared/ipc";

import type { AIProvidersSettingsProps } from "./AIProvidersSettings";

export type ThemeMode = "system" | "light" | "dark";

export interface EditorFontFamilyOption {
    readonly group?: string;
    readonly id: string;
    readonly label: string;
    readonly description?: string;
    readonly disabled?: boolean;
    readonly preview?: string;
}

export interface ThemePresetOption {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
    readonly swatches?: readonly [string, string, string];
    readonly disabled?: boolean;
}

export interface SettingsThemeControlState {
    readonly agentsSidebarScale?: number;
    readonly boostCodeContrast: boolean;
    readonly fileTreeScale?: number;
    readonly mode: ThemeMode;
    readonly presetId: string;
    readonly presets: readonly ThemePresetOption[];
    readonly stickyFoldersEnabled: boolean;
    readonly zoomFactor?: number;
    readonly disabled?: boolean;
    readonly onAgentsSidebarScaleChange?: (agentsSidebarScale: number) => void;
    readonly onBoostCodeContrastChange?: (enabled: boolean) => void;
    readonly onFileTreeScaleChange?: (fileTreeScale: number) => void;
    readonly onModeChange?: (mode: ThemeMode) => void;
    readonly onPresetChange?: (presetId: string) => void;
    readonly onStickyFoldersEnabledChange?: (enabled: boolean) => void;
    readonly onZoomFactorChange?: (zoomFactor: number) => void;
}

export interface SettingsEditorControlState {
    readonly autoSaveDelayMs: number;
    readonly fontFamilyId: string;
    readonly fontFamilies: readonly EditorFontFamilyOption[];
    readonly fontSize: number;
    readonly lineHeight: number;
    readonly minimapEnabled: boolean;
    readonly suggestionsEnabled: boolean;
    readonly disabled?: boolean;
    readonly onAutoSaveDelayMsChange?: (autoSaveDelayMs: number) => void;
    readonly onFontFamilyChange?: (fontFamilyId: string) => void;
    readonly onFontSizeChange?: (fontSize: number) => void;
    readonly onLineHeightChange?: (lineHeight: number) => void;
    readonly onMinimapEnabledChange?: (enabled: boolean) => void;
    readonly onSuggestionsEnabledChange?: (enabled: boolean) => void;
}

export interface RuntimeActionOption {
    readonly id: string;
    readonly label: string;
    readonly disabled?: boolean;
    readonly tone?: "default" | "primary" | "danger";
    readonly hint?: string;
}

export interface RuntimeCardOption {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
    readonly status?: string;
    readonly source?: string;
    readonly details?: string;
    readonly actions?: readonly RuntimeActionOption[];
}

export interface ShortcutEntryOption {
    readonly description: string;
    readonly id: string;
    readonly keys: string;
    readonly label: string;
    readonly section: string;
}

export interface ChatFontFamilyOption {
    readonly group?: string;
    readonly id: string;
    readonly label: string;
    readonly disabled?: boolean;
}

export interface SettingsAiChatState {
    readonly chatFontFamily: string;
    readonly chatFontFamilies: readonly ChatFontFamilyOption[];
    readonly chatFontSize: number;
    readonly composerFontFamily: string;
    readonly composerFontFamilies: readonly ChatFontFamilyOption[];
    readonly composerFontSize: number;
    readonly requireCmdEnterToSend: boolean;
    readonly screenshotRetentionSeconds: number;
    readonly historyRetentionDays: number;
    readonly contextUsageBarEnabled: boolean;
    readonly toolCardExpansionMode: AiToolCardExpansionMode;
    readonly onChatFontFamilyChange?: (id: string) => void;
    readonly onChatFontSizeChange?: (size: number) => void;
    readonly onComposerFontFamilyChange?: (id: string) => void;
    readonly onComposerFontSizeChange?: (size: number) => void;
    readonly onRequireCmdEnterChange?: (value: boolean) => void;
    readonly onScreenshotRetentionChange?: (seconds: number) => void;
    readonly onHistoryRetentionChange?: (days: number) => void;
    readonly onContextUsageBarEnabledChange?: (value: boolean) => void;
    readonly onToolCardExpansionModeChange?: (
        value: AiToolCardExpansionMode,
    ) => void;
}

export interface SettingsWindowProps {
    readonly appAppearance: SettingsThemeControlState;
    readonly appEditor: SettingsEditorControlState;
    readonly aiChat: SettingsAiChatState;
    readonly github: SettingsGitHubState;
    readonly privacy: SettingsPrivacyState;
    readonly projects: SettingsProjectsState;
    readonly updates: SettingsUpdatesState;
    readonly shortcuts?: readonly ShortcutEntryOption[];
    readonly aiProviders?: AIProvidersSettingsProps;
    readonly runtimes?: readonly RuntimeCardOption[];
    readonly onRuntimeAction?: (runtimeId: string, actionId: string) => void;
}

export interface SettingsProjectOption {
    readonly id: string;
    readonly name: string;
    readonly rootPath: string;
    readonly lastOpenedAt: string | null;
}

export interface SettingsProjectsState {
    readonly error: string | null;
    readonly loading: boolean;
    readonly projects: readonly SettingsProjectOption[];
    readonly onAddProject?: () => void;
    readonly onClearAppData?: (projectId: string) => void;
    readonly onGetAppDataSummary?: (
        projectId: string,
    ) => Promise<ProjectAppDataSummary>;
    readonly onRelocateProject?: (projectId: string) => void;
    readonly onRemoveProject?: (projectId: string) => void;
    readonly onRevealProject?: (projectId: string) => void;
}

export interface SettingsPrivacyState {
    readonly state: AppPrivacyAccessState;
    readonly onOpenFullDiskAccessSettings?: () => void;
}

export interface SettingsGitHubState {
    readonly error: string | null;
    readonly loading: boolean;
    readonly notice: string | null;
    readonly saving: boolean;
    readonly status: GitHubAuthStatus;
    readonly tokenDraft: string;
    readonly onDisconnect?: () => void;
    readonly onRefresh?: () => void;
    readonly onSaveToken?: () => void;
    readonly onTokenDraftChange?: (value: string) => void;
}

export interface SettingsUpdatesState {
    readonly changelog: readonly AppChangelogRelease[];
    readonly state: AppUpdateState;
    readonly onCheckForUpdates?: () => void;
    readonly onInstallUpdate?: () => void;
}
