import type {
    AppAiChatSettings,
    AppAppearanceSettings,
    AppEditorSettings,
    AppTerminalSettings,
    ClaudeRuntimeSettings,
    CodexRuntimeSettings,
    GrokRuntimeSettings,
    KiloRuntimeSettings,
    OpenCodeRuntimeSettings,
    ProjectSettingsSnapshot,
    SettingsSnapshot,
} from "@shared/ipc";

import type { SecretRecordPatch } from "@main/ai/secret-store";

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
