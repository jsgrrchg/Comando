import { BrowserWindow } from "electron";

import { clampAppZoomFactor } from "@shared/app-zoom";
import {
    IPC_EVENTS,
    type AppAppearanceSettings,
    type AppEditorSettings,
    type SettingsUpdatedEvent,
} from "@shared/ipc";

export function applyAppZoomToWindow(
    window: BrowserWindow,
    zoomFactor: number,
): void {
    window.webContents.setZoomFactor(clampAppZoomFactor(zoomFactor));
}

export function applyAppZoomToAllWindows(zoomFactor: number): void {
    for (const window of BrowserWindow.getAllWindows()) {
        applyAppZoomToWindow(window, zoomFactor);
    }
}

export function broadcastSettingsUpdated(
    appearance: AppAppearanceSettings | null,
    editor: AppEditorSettings | null,
): void {
    const payload: SettingsUpdatedEvent = { appearance, editor };

    for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(IPC_EVENTS.settingsUpdated, payload);
    }
}
