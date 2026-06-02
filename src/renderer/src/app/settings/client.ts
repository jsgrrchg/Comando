import type {
    AppAiChatSettings,
    AppAppearanceSettings,
    AppEditorSettings,
    AppTerminalSettings,
    SettingsSnapshot,
} from "@shared/ipc";
import {
    DEFAULT_APP_TERMINAL_SETTINGS,
    normalizeAppTerminalSettings,
} from "@shared/terminal-settings";

import {
    getDefaultAiChatSettings,
    getDefaultAppAppearance,
    getDefaultAppEditorSettings,
} from "./theme";

let cachedAppEditorSettings: AppEditorSettings | null = null;

export function getCachedAppEditorSettings(): AppEditorSettings | null {
    return cachedAppEditorSettings;
}

export function setCachedAppEditorSettings(
    editor: AppEditorSettings | null | undefined,
): void {
    cachedAppEditorSettings = editor ?? null;
}

export async function loadAppAppearanceSettings(): Promise<AppAppearanceSettings> {
    const snapshot = await getComandoApi().getSettingsSnapshot();
    return snapshot.appearance ?? getDefaultAppAppearance();
}

export async function saveAppAppearanceSettings(
    appearance: AppAppearanceSettings,
): Promise<void> {
    const currentSnapshot = await getComandoApi().getSettingsSnapshot();
    const nextSnapshot: SettingsSnapshot = {
        ...currentSnapshot,
        appearance,
        shellState: currentSnapshot.shellState,
    };

    await getComandoApi().saveSettingsSnapshot(nextSnapshot);
}

export async function loadAiChatSettings(): Promise<AppAiChatSettings> {
    const snapshot = await getComandoApi().getSettingsSnapshot();
    return snapshot.aiChat ?? getDefaultAiChatSettings();
}

export async function saveAiChatSettings(
    aiChat: AppAiChatSettings,
): Promise<void> {
    const currentSnapshot = await getComandoApi().getSettingsSnapshot();
    const nextSnapshot: SettingsSnapshot = {
        ...currentSnapshot,
        aiChat,
        shellState: currentSnapshot.shellState,
    };

    await getComandoApi().saveSettingsSnapshot(nextSnapshot);
}

export async function loadAppTerminalSettings(): Promise<AppTerminalSettings> {
    const snapshot = await getComandoApi().getSettingsSnapshot();
    return normalizeAppTerminalSettings(
        snapshot.terminal ?? DEFAULT_APP_TERMINAL_SETTINGS,
    );
}

export async function saveAppTerminalSettings(
    terminal: AppTerminalSettings,
): Promise<void> {
    const currentSnapshot = await getComandoApi().getSettingsSnapshot();
    const nextSnapshot: SettingsSnapshot = {
        ...currentSnapshot,
        shellState: currentSnapshot.shellState,
        terminal: normalizeAppTerminalSettings(terminal),
    };

    await getComandoApi().saveSettingsSnapshot(nextSnapshot);
}

export async function loadAppEditorSettings(): Promise<AppEditorSettings> {
    const snapshot = await getComandoApi().getSettingsSnapshot();
    setCachedAppEditorSettings(snapshot.editor);
    return snapshot.editor ?? getDefaultAppEditorSettings();
}

export async function saveAppEditorSettings(
    editor: AppEditorSettings,
): Promise<void> {
    const currentSnapshot = await getComandoApi().getSettingsSnapshot();
    const nextSnapshot: SettingsSnapshot = {
        ...currentSnapshot,
        editor,
        shellState: currentSnapshot.shellState,
    };

    await getComandoApi().saveSettingsSnapshot(nextSnapshot);
    setCachedAppEditorSettings(editor);
}

function getComandoApi() {
    if (!window.comando) {
        throw new Error("Comando API is not available in this window.");
    }

    return window.comando;
}
