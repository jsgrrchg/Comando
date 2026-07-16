import { beforeEach, describe, expect, it, vi } from "vitest";

import { IPC_EVENTS } from "@shared/ipc";
import { DEFAULT_APP_TERMINAL_SETTINGS } from "@shared/terminal-settings";

const liveWindows: Array<{
    readonly webContents: { readonly send: ReturnType<typeof vi.fn> };
}> = [];
const embeddedWebContents: Array<{
    readonly send: ReturnType<typeof vi.fn>;
}> = [];

vi.mock("../window", () => ({
    forEachLiveWindow: (
        callback: (window: (typeof liveWindows)[number]) => void,
    ) => {
        for (const window of liveWindows) {
            callback(window);
        }
    },
}));

vi.mock("../windows/registry", () => ({
    windowRegistry: {
        forEachLiveWebContents: (
            callback: (webContents: (typeof embeddedWebContents)[number]) => void,
        ) => {
            for (const webContents of embeddedWebContents) {
                callback(webContents);
            }
        },
    },
}));

describe("broadcastSettingsUpdated", () => {
    beforeEach(() => {
        liveWindows.length = 0;
        embeddedWebContents.length = 0;
    });

    it("sends appearance, editor, aiChat, and terminal settings", async () => {
        const { broadcastSettingsUpdated } = await import("./window-zoom");
        const send = vi.fn();
        liveWindows.push({ webContents: { send } });

        broadcastSettingsUpdated(
            {
                agentsSidebarScale: 1,
                boostCodeContrast: true,
                chromeTransparency: 45,
                fileTreeScale: 1,
                stickyFoldersEnabled: true,
                themeMode: "dark",
                themePreset: "default",
                transparencyEnabled: true,
                zoomFactor: 1,
            },
            {
                autoSaveDelayMs: 900,
                fontFamily: "ibm-plex-mono",
                fontSize: 14,
                lineHeight: 1.55,
                minimapEnabled: true,
                relativeLineNumbersEnabled: false,
                suggestionsEnabled: true,
                vimModeEnabled: false,
            },
            {
                chatFontFamily: "andale",
                chatFontSize: 14,
                composerFontFamily: "ibm-plex-mono",
                composerFontSize: 14,
                contextUsageBarEnabled: true,
                historyRetentionDays: 0,
                requireCmdEnterToSend: false,
                reviewDiffZoom: 0.96,
                screenshotRetentionSeconds: 0,
                toolActivityDefaultExpansion: "collapsed",
            },
            DEFAULT_APP_TERMINAL_SETTINGS,
        );

        expect(send).toHaveBeenCalledWith(IPC_EVENTS.settingsUpdated, {
            aiChat: {
                chatFontFamily: "andale",
                chatFontSize: 14,
                composerFontFamily: "ibm-plex-mono",
                composerFontSize: 14,
                contextUsageBarEnabled: true,
                historyRetentionDays: 0,
                requireCmdEnterToSend: false,
                reviewDiffZoom: 0.96,
                screenshotRetentionSeconds: 0,
                toolActivityDefaultExpansion: "collapsed",
            },
            appearance: {
                agentsSidebarScale: 1,
                boostCodeContrast: true,
                chromeTransparency: 45,
                fileTreeScale: 1,
                stickyFoldersEnabled: true,
                themeMode: "dark",
                themePreset: "default",
                transparencyEnabled: true,
                zoomFactor: 1,
            },
            editor: {
                autoSaveDelayMs: 900,
                fontFamily: "ibm-plex-mono",
                fontSize: 14,
                lineHeight: 1.55,
                minimapEnabled: true,
                relativeLineNumbersEnabled: false,
                suggestionsEnabled: true,
                vimModeEnabled: false,
            },
            terminal: DEFAULT_APP_TERMINAL_SETTINGS,
        });
    });

    it("sends settings updates to embedded workspace renderers", async () => {
        const { broadcastSettingsUpdated } = await import("./window-zoom");
        const send = vi.fn();
        embeddedWebContents.push({ send });

        broadcastSettingsUpdated(null, null, null, null);

        expect(send).toHaveBeenCalledWith(IPC_EVENTS.settingsUpdated, {
            aiChat: null,
            appearance: null,
            editor: null,
            terminal: null,
        });
    });
});
