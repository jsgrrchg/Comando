import type {
    AppAiChatSettings,
    AppAppearanceSettings,
    AppEditorSettings,
    SettingsSnapshot,
} from "@shared/ipc";

import {
    getDefaultAiChatSettings,
    getDefaultAppAppearance,
    getDefaultAppEditorSettings,
} from "./theme";

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

export async function loadAppEditorSettings(): Promise<AppEditorSettings> {
    const snapshot = await getComandoApi().getSettingsSnapshot();
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
}

function getComandoApi() {
    if (!window.comando) {
        throw new Error("Comando API is not available in this window.");
    }

    return window.comando;
}
