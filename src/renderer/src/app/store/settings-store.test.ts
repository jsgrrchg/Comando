import { afterEach, describe, expect, it, vi } from "vitest";

import type {
    AppAiChatSettings,
    AppAppearanceSettings,
    AppEditorSettings,
    AppTerminalSettings,
    SettingsUpdatedEvent,
    SystemTheme,
} from "@shared/ipc";
import { DEFAULT_APP_TERMINAL_SETTINGS } from "@shared/terminal-settings";

import {
    resetSettingsStoreForTests,
    useSettingsStore,
} from "./settings-store";

function createEditorSettings(
    overrides: Partial<AppEditorSettings> = {},
): AppEditorSettings {
    return {
        autoSaveDelayMs: 900,
        fontFamily: "sf-mono",
        fontSize: 14,
        lineHeight: 1.55,
        minimapEnabled: false,
        relativeLineNumbersEnabled: false,
        suggestionsEnabled: true,
        vimModeEnabled: false,
        ...overrides,
    };
}

function createAppearanceSettings(
    overrides: Partial<AppAppearanceSettings> = {},
): AppAppearanceSettings {
    return {
        agentsSidebarScale: 1,
        boostCodeContrast: true,
        fileTreeScale: 1,
        stickyFoldersEnabled: true,
        themeMode: "system",
        themePreset: "default",
        transparencyEnabled: true,
        zoomFactor: 1,
        ...overrides,
    };
}

function createAiChatSettings(
    overrides: Partial<AppAiChatSettings> = {},
): AppAiChatSettings {
    return {
        chatFontFamily: "geist",
        chatFontSize: 14,
        composerFontFamily: "geist",
        composerFontSize: 14,
        contextUsageBarEnabled: true,
        historyRetentionDays: 30,
        requireCmdEnterToSend: false,
        reviewDiffZoom: 1,
        screenshotRetentionSeconds: 300,
        toolActivityDefaultExpansion: "collapsed",
        ...overrides,
    };
}

function createTerminalSettings(
    overrides: Partial<AppTerminalSettings> = {},
): AppTerminalSettings {
    return {
        claudeCodeContinueSession: false,
        claudeCodeMaxTurns: 0,
        claudeCodeModel: "",
        claudeCodeOptimized: false,
        claudeCodeSkipPermissions: false,
        terminalFontFamily: "",
        terminalFontSize: 13,
        windowsShell: "default",
        ...overrides,
    };
}

function flushAsyncWork(): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, 0);
    });
}

describe("settings-store", () => {
    afterEach(() => {
        resetSettingsStoreForTests();
        vi.unstubAllGlobals();
    });

    it("hydrates and subscribes only once per window", async () => {
        const getSettingsSnapshot = vi.fn().mockResolvedValue({
            aiChat: createAiChatSettings(),
            appearance: createAppearanceSettings(),
            editor: createEditorSettings(),
            shellState: null,
        });
        const getSystemTheme = vi
            .fn()
            .mockResolvedValue({ isDark: true } satisfies SystemTheme);
        const onSettingsUpdated = vi.fn().mockReturnValue(() => {});
        const onThemeUpdated = vi.fn().mockReturnValue(() => {});

        vi.stubGlobal("window", {
            comando: {
                getSettingsSnapshot,
                getSystemTheme,
                onSettingsUpdated,
                onThemeUpdated,
            },
        });

        await Promise.all([
            useSettingsStore.getState().hydrate(),
            useSettingsStore.getState().hydrate(),
        ]);

        expect(onSettingsUpdated).toHaveBeenCalledTimes(1);
        expect(onThemeUpdated).toHaveBeenCalledTimes(1);
        expect(getSettingsSnapshot).toHaveBeenCalledTimes(1);
        expect(getSystemTheme).toHaveBeenCalledTimes(1);
        expect(useSettingsStore.getState()).toMatchObject({
            revision: 1,
            status: "ready",
            systemTheme: { isDark: true },
            terminal: DEFAULT_APP_TERMINAL_SETTINGS,
        });
    });

    it("refreshes the shared snapshot from a single settings event", async () => {
        const initialAiChat = createAiChatSettings({ chatFontSize: 14 });
        const nextAiChat = createAiChatSettings({ chatFontSize: 18 });
        const initialAppearance = createAppearanceSettings({ zoomFactor: 1 });
        const nextAppearance = createAppearanceSettings({ zoomFactor: 1.2 });
        const initialEditor = createEditorSettings({ fontSize: 14 });
        const nextEditor = createEditorSettings({ fontSize: 16 });
        const initialTerminal = createTerminalSettings({
            terminalFontSize: 13,
        });
        const nextTerminal = createTerminalSettings({
            claudeCodeOptimized: true,
            terminalFontFamily: "Menlo",
            terminalFontSize: 18,
        });
        let settingsListener:
            | ((payload: SettingsUpdatedEvent) => void)
            | null = null;

        const getSettingsSnapshot = vi
            .fn()
            .mockResolvedValueOnce({
                aiChat: initialAiChat,
                appearance: initialAppearance,
                editor: initialEditor,
                shellState: null,
                terminal: initialTerminal,
            })
            .mockResolvedValueOnce({
                aiChat: nextAiChat,
                appearance: nextAppearance,
                editor: nextEditor,
                shellState: null,
                terminal: nextTerminal,
            });

        vi.stubGlobal("window", {
            comando: {
                getSettingsSnapshot,
                getSystemTheme: vi
                    .fn()
                    .mockResolvedValue({ isDark: false } satisfies SystemTheme),
                onSettingsUpdated: vi.fn(
                    (listener: (payload: SettingsUpdatedEvent) => void) => {
                        settingsListener = listener;
                        return () => {
                            settingsListener = null;
                        };
                    },
                ),
                onThemeUpdated: vi.fn().mockReturnValue(() => {}),
            },
        });

        await useSettingsStore.getState().hydrate();
        if (!settingsListener) {
            throw new Error("Expected the settings listener to be registered.");
        }

        const registeredSettingsListener = settingsListener as (
            payload: SettingsUpdatedEvent,
        ) => void;
        registeredSettingsListener({
            aiChat: nextAiChat,
            appearance: nextAppearance,
            editor: nextEditor,
            terminal: nextTerminal,
        });
        await flushAsyncWork();

        expect(useSettingsStore.getState()).toMatchObject({
            aiChat: nextAiChat,
            appearance: nextAppearance,
            editor: nextEditor,
            revision: 2,
            terminal: nextTerminal,
        });
        expect(getSettingsSnapshot).toHaveBeenCalledTimes(2);
    });

    it("normalizes terminal settings from hydrated snapshots", async () => {
        vi.stubGlobal("window", {
            comando: {
                getSettingsSnapshot: vi.fn().mockResolvedValue({
                    shellState: null,
                    terminal: {
                        claudeCodeContinueSession: true,
                        claudeCodeMaxTurns: 5000,
                        claudeCodeModel: "bad-model",
                        claudeCodeOptimized: true,
                        claudeCodeSkipPermissions: true,
                        terminalFontFamily: "  FiraCode\nNerd Font  ",
                        terminalFontSize: 99,
                        windowsShell: "pwsh",
                    },
                }),
                getSystemTheme: vi
                    .fn()
                    .mockResolvedValue({ isDark: false } satisfies SystemTheme),
                onSettingsUpdated: vi.fn().mockReturnValue(() => {}),
                onThemeUpdated: vi.fn().mockReturnValue(() => {}),
            },
        });

        await useSettingsStore.getState().hydrate();

        expect(useSettingsStore.getState().terminal).toEqual({
            claudeCodeContinueSession: true,
            claudeCodeMaxTurns: 1000,
            claudeCodeModel: "",
            claudeCodeOptimized: true,
            claudeCodeSkipPermissions: true,
            terminalFontFamily: "FiraCode Nerd Font",
            terminalFontSize: 24,
            windowsShell: "pwsh",
        });
    });
});
