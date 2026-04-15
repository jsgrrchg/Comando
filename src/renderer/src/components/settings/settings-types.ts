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
    readonly fileTreeScale?: number;
    readonly mode: ThemeMode;
    readonly presetId: string;
    readonly presets: readonly ThemePresetOption[];
    readonly zoomFactor?: number;
    readonly disabled?: boolean;
    readonly onFileTreeScaleChange?: (fileTreeScale: number) => void;
    readonly onModeChange?: (mode: ThemeMode) => void;
    readonly onPresetChange?: (presetId: string) => void;
    readonly onZoomFactorChange?: (zoomFactor: number) => void;
}

export interface SettingsEditorControlState {
    readonly fontFamilyId: string;
    readonly fontFamilies: readonly EditorFontFamilyOption[];
    readonly fontSize: number;
    readonly lineHeight: number;
    readonly minimapEnabled: boolean;
    readonly suggestionsEnabled: boolean;
    readonly disabled?: boolean;
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
    readonly pendingReviewCardTextZoomPercent: number;
    readonly requireCmdEnterToSend: boolean;
    readonly reviewDiffZoomPercent: number;
    readonly screenshotRetentionSeconds: number;
    readonly historyRetentionDays: number;
    readonly onChatFontFamilyChange?: (id: string) => void;
    readonly onChatFontSizeChange?: (size: number) => void;
    readonly onComposerFontFamilyChange?: (id: string) => void;
    readonly onComposerFontSizeChange?: (size: number) => void;
    readonly onPendingReviewCardTextZoomPercentChange?: (
        percent: number,
    ) => void;
    readonly onRequireCmdEnterChange?: (value: boolean) => void;
    readonly onReviewDiffZoomPercentChange?: (percent: number) => void;
    readonly onScreenshotRetentionChange?: (seconds: number) => void;
    readonly onHistoryRetentionChange?: (days: number) => void;
}

export interface SettingsWindowProps {
    readonly onClose?: () => void;
    readonly appAppearance: SettingsThemeControlState;
    readonly appEditor: SettingsEditorControlState;
    readonly aiChat: SettingsAiChatState;
    readonly shortcuts?: readonly ShortcutEntryOption[];
    readonly runtimes?: readonly RuntimeCardOption[];
    readonly onRuntimeAction?: (runtimeId: string, actionId: string) => void;
}
