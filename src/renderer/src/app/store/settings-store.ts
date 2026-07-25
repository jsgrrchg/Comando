import { create } from "zustand";

import type {
    AiRuntimeDescriptor,
    AppAiChatSettings,
    AppAppearanceSettings,
    AppEditorSettings,
    AppTerminalSettings,
    SettingsSnapshot,
    SystemTheme,
} from "@shared/ipc";
import { buildAiRuntimeCatalog } from "@shared/ai-runtimes";
import {
    DEFAULT_APP_TERMINAL_SETTINGS,
    normalizeAppTerminalSettings,
} from "@shared/terminal-settings";

import { setCachedAppEditorSettings } from "../settings/client";
import {
    getDefaultAiChatSettings,
    getDefaultAppAppearance,
    getDefaultAppEditorSettings,
} from "../settings/theme";

type SettingsStatus = "idle" | "loading" | "ready" | "error";

interface SettingsStore {
    readonly aiChat: AppAiChatSettings;
    readonly appearance: AppAppearanceSettings;
    readonly editor: AppEditorSettings;
    readonly error: string | null;
    readonly revision: number;
    readonly runtimeCatalog: readonly AiRuntimeDescriptor[];
    readonly status: SettingsStatus;
    readonly systemTheme: SystemTheme;
    readonly terminal: AppTerminalSettings;
    hydrate: () => Promise<void>;
}

const DEFAULT_SYSTEM_THEME: SystemTheme = { isDark: false };

let settingsListenerCleanup: (() => void) | null = null;
let themeListenerCleanup: (() => void) | null = null;
let hydratePromise: Promise<void> | null = null;

function createDefaultSettingsState() {
    return {
        aiChat: getDefaultAiChatSettings(),
        appearance: getDefaultAppAppearance(),
        editor: getDefaultAppEditorSettings(),
        error: null,
        revision: 0,
        runtimeCatalog: buildAiRuntimeCatalog(),
        status: "idle" as const,
        systemTheme: DEFAULT_SYSTEM_THEME,
        terminal: DEFAULT_APP_TERMINAL_SETTINGS,
    };
}

export const useSettingsStore = create<SettingsStore>(() => ({
    ...createDefaultSettingsState(),
    hydrate: async () => {
        ensureSettingsSubscriptions();

        if (useSettingsStore.getState().status === "ready") {
            return;
        }

        if (hydratePromise) {
            return hydratePromise;
        }

        hydratePromise = refreshSettingsState({
            includeSystemTheme: true,
            setLoadingState: true,
        }).finally(() => {
            hydratePromise = null;
        });

        return hydratePromise;
    },
}));

function ensureSettingsSubscriptions(): void {
    if (!window.comando || settingsListenerCleanup || themeListenerCleanup) {
        return;
    }

    settingsListenerCleanup = window.comando.onSettingsUpdated(() => {
        void refreshSettingsState();
    });
    themeListenerCleanup = window.comando.onThemeUpdated((systemTheme) => {
        useSettingsStore.setState({ systemTheme });
    });
}

async function refreshSettingsState(options?: {
    readonly includeSystemTheme?: boolean;
    readonly setLoadingState?: boolean;
}): Promise<void> {
    if (!window.comando) {
        return;
    }

    if (options?.setLoadingState) {
        useSettingsStore.setState({ error: null, status: "loading" });
    }

    try {
        const [snapshot, systemTheme] = await Promise.all([
            window.comando.getSettingsSnapshot(),
            options?.includeSystemTheme
                ? window.comando.getSystemTheme()
                : Promise.resolve(useSettingsStore.getState().systemTheme),
        ]);

        applySnapshot(snapshot, systemTheme);
    } catch (error) {
        const message =
            error instanceof Error
                ? error.message
                : "Could not hydrate application settings.";

        useSettingsStore.setState({ error: message, status: "error" });
    }
}

function applySnapshot(
    snapshot: SettingsSnapshot,
    systemTheme: SystemTheme,
): void {
    const aiChat = snapshot.aiChat ?? getDefaultAiChatSettings();
    const appearance = snapshot.appearance ?? getDefaultAppAppearance();
    const editor = snapshot.editor ?? getDefaultAppEditorSettings();
    const runtimeCatalog = buildAiRuntimeCatalog(
        snapshot.customAcpRuntimes?.runtimes,
    );
    const terminal = normalizeAppTerminalSettings(snapshot.terminal);

    setCachedAppEditorSettings(snapshot.editor);
    useSettingsStore.setState((state) => ({
        aiChat,
        appearance,
        editor,
        error: null,
        revision: state.revision + 1,
        runtimeCatalog,
        status: "ready",
        systemTheme,
        terminal,
    }));
}

export function resetSettingsStoreForTests(): void {
    settingsListenerCleanup?.();
    themeListenerCleanup?.();
    settingsListenerCleanup = null;
    themeListenerCleanup = null;
    hydratePromise = null;
    setCachedAppEditorSettings(null);
    useSettingsStore.setState(createDefaultSettingsState());
}
