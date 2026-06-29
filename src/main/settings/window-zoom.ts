import type { BrowserWindow } from "electron";

import { clampAppZoomFactor } from "@shared/app-zoom";
import {
    IPC_EVENTS,
    type AppAiChatSettings,
    type AppAppearanceSettings,
    type AppEditorSettings,
    type AppTerminalSettings,
    type SettingsUpdatedEvent,
} from "@shared/ipc";

import { applyWindowTransparencyToWindow, forEachLiveWindow } from "../window";

export function applyAppZoomToWindow(
    window: BrowserWindow,
    zoomFactor: number,
): void {
    window.webContents.setZoomFactor(clampAppZoomFactor(zoomFactor));
}

export function applyAppZoomToAllWindows(zoomFactor: number): void {
    forEachLiveWindow((window) => {
        applyAppZoomToWindow(window, zoomFactor);
    });
}

export function applyWindowTransparencyToAllWindows(
    transparencyEnabled: boolean,
): void {
    forEachLiveWindow((window) => {
        applyWindowTransparencyToWindow(window, transparencyEnabled);
    });
}

export function broadcastSettingsUpdated(
    appearance: AppAppearanceSettings | null,
    editor: AppEditorSettings | null,
    aiChat: AppAiChatSettings | null,
    terminal: AppTerminalSettings | null,
): void {
    const payload: SettingsUpdatedEvent = {
        aiChat,
        appearance,
        editor,
        terminal,
    };

    forEachLiveWindow((window) => {
        window.webContents.send(IPC_EVENTS.settingsUpdated, payload);
    });
}
