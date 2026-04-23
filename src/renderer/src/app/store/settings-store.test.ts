import { afterEach, describe, expect, it, vi } from "vitest";

import type {
    AppAiChatSettings,
    AppAppearanceSettings,
    AppEditorSettings,
    SettingsUpdatedEvent,
    SystemTheme,
} from "@shared/ipc";

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
        suggestionsEnabled: true,
        ...overrides,
    };
}

function createAppearanceSettings(
    overrides: Partial<AppAppearanceSettings> = {},
): AppAppearanceSettings {
    return {
        boostCodeContrast: true,
        fileTreeScale: 1,
        stickyFoldersEnabled: true,
        themeMode: "system",
        themePreset: "default",
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
        });
    });

    it("refreshes the shared snapshot from a single settings event", async () => {
        const initialAiChat = createAiChatSettings({ chatFontSize: 14 });
        const nextAiChat = createAiChatSettings({ chatFontSize: 18 });
        const initialAppearance = createAppearanceSettings({ zoomFactor: 1 });
        const nextAppearance = createAppearanceSettings({ zoomFactor: 1.2 });
        const initialEditor = createEditorSettings({ fontSize: 14 });
        const nextEditor = createEditorSettings({ fontSize: 16 });
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
            })
            .mockResolvedValueOnce({
                aiChat: nextAiChat,
                appearance: nextAppearance,
                editor: nextEditor,
                shellState: null,
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
            appearance: nextAppearance,
            editor: nextEditor,
        });
        await flushAsyncWork();

        expect(useSettingsStore.getState()).toMatchObject({
            aiChat: nextAiChat,
            appearance: nextAppearance,
            editor: nextEditor,
            revision: 2,
        });
        expect(getSettingsSnapshot).toHaveBeenCalledTimes(2);
    });
});
