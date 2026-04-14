import type {
    AppAiChatSettings,
    AppAppearanceSettings,
    AppEditorSettings,
    ProjectAppearanceSettings,
    ProjectEditorSettings,
    ProjectSettingsSnapshot,
    SettingsSnapshot,
} from "@shared/ipc";

import {
    getDefaultAiChatSettings,
    getDefaultAppAppearance,
    getDefaultAppEditorSettings,
    getDefaultProjectAppearance,
    getDefaultProjectEditorSettings,
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

export async function loadProjectAppearanceSettings(
    projectId: string,
): Promise<ProjectAppearanceSettings> {
    const snapshot = await getComandoApi().getProjectSettings(projectId);
    return snapshot?.appearance ?? getDefaultProjectAppearance();
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

export async function loadProjectEditorSettings(
    projectId: string,
): Promise<ProjectEditorSettings> {
    const snapshot = await getComandoApi().getProjectSettings(projectId);
    return snapshot?.editor ?? getDefaultProjectEditorSettings();
}

export async function saveProjectAppearanceSettings(
    projectId: string,
    appearance: ProjectAppearanceSettings,
): Promise<void> {
    const currentSnapshot = await getComandoApi().getProjectSettings(projectId);
    const snapshot: ProjectSettingsSnapshot = {
        appearance,
        editor: currentSnapshot?.editor ?? getDefaultProjectEditorSettings(),
        projectId,
    };

    await getComandoApi().saveProjectSettings(snapshot);
}

export async function saveProjectEditorSettings(
    projectId: string,
    editor: ProjectEditorSettings,
): Promise<void> {
    const currentSnapshot = await getComandoApi().getProjectSettings(projectId);
    const snapshot: ProjectSettingsSnapshot = {
        appearance:
            currentSnapshot?.appearance ?? getDefaultProjectAppearance(),
        editor,
        projectId,
    };

    await getComandoApi().saveProjectSettings(snapshot);
}

function getComandoApi() {
    if (!window.comando) {
        throw new Error("Comando API is not available in this window.");
    }

    return window.comando;
}
