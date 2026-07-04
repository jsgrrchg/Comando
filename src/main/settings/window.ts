import type { BrowserWindow } from "electron";

import { applyAppZoomToWindow } from "@main/settings/window-zoom";
import { createSettingsWindow as createSettingsBrowserWindow } from "@main/window";
import { windowRegistry } from "@main/windows/registry";
import type { OpenSettingsWindowInput } from "@shared/ipc";

const SETTINGS_WINDOW_KEY_PREFIX = "settings";

const activeSettingsWindows = new Map<string, BrowserWindow>();

export function openSettingsWindow(
    input: OpenSettingsWindowInput,
    zoomFactor = 1,
    transparencyEnabled = true,
): void {
    const windowKey = getSettingsWindowKey(input.projectId);
    const existingWindow = activeSettingsWindows.get(windowKey);

    if (existingWindow) {
        if (existingWindow.isMinimized()) {
            existingWindow.restore();
        }
        existingWindow.show();
        existingWindow.focus();
        return;
    }

    const settingsWindow = createSettingsBrowserWindow(
        input.projectId,
        input.initialCategory ?? null,
        transparencyEnabled,
    );
    applyAppZoomToWindow(settingsWindow, zoomFactor);

    activeSettingsWindows.set(windowKey, settingsWindow);
    windowRegistry.register(settingsWindow, {
        projectId: input.projectId,
        windowId: windowKey,
        windowKind: "settings",
        workspaceId: null,
        workspaceSessionId: null,
    });
    settingsWindow.on("closed", () => {
        activeSettingsWindows.delete(windowKey);
    });
}

function getSettingsWindowKey(projectId: string | null): string {
    if (!projectId) {
        return SETTINGS_WINDOW_KEY_PREFIX;
    }

    let hash = 5381;
    for (let index = 0; index < projectId.length; index += 1) {
        hash = (((hash << 5) + hash) ^ projectId.charCodeAt(index)) >>> 0;
    }

    return `${SETTINGS_WINDOW_KEY_PREFIX}-${hash.toString(36)}`;
}
