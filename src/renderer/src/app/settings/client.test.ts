import { afterEach, describe, expect, it, vi } from "vitest";

import type {
    AppAppearanceSettings,
    AppEditorSettings,
    SettingsSnapshot,
} from "@shared/ipc";
import { DEFAULT_APP_TERMINAL_SETTINGS } from "@shared/terminal-settings";

import {
    getCachedAppEditorSettings,
    loadAppTerminalSettings,
    saveAppTerminalSettings,
    loadAppEditorSettings,
    setCachedAppEditorSettings,
} from "./client";

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
        agentsSidebarScale: 1,
        boostCodeContrast: true,
        fileTreeScale: 1,
        stickyFoldersEnabled: true,
        themeMode: "system",
        themePreset: "default",
        zoomFactor: 1,
        ...overrides,
    };
}

function stubComandoApi(snapshot: SettingsSnapshot) {
    const saveSettingsSnapshot = vi.fn();
    vi.stubGlobal("window", {
        comando: {
            getSettingsSnapshot: vi.fn().mockResolvedValue(snapshot),
            saveSettingsSnapshot,
        },
    });
    return { saveSettingsSnapshot };
}

describe("settings client editor cache", () => {
    afterEach(() => {
        setCachedAppEditorSettings(null);
        vi.unstubAllGlobals();
    });

    it("hydrates the cached editor settings from the settings snapshot", async () => {
        const editor = createEditorSettings();
        stubComandoApi({ editor, shellState: null });

        expect(getCachedAppEditorSettings()).toBeNull();
        await expect(loadAppEditorSettings()).resolves.toEqual(editor);
        expect(getCachedAppEditorSettings()).toEqual(editor);
    });

    it("clears stale cached editor settings when the snapshot has no editor payload", async () => {
        setCachedAppEditorSettings(
            createEditorSettings({ minimapEnabled: true }),
        );
        stubComandoApi({ shellState: null });

        const editor = await loadAppEditorSettings();

        expect(editor.minimapEnabled).toBe(true);
        expect(getCachedAppEditorSettings()).toBeNull();
    });
});

describe("settings client terminal settings", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("loads defaults when the snapshot has no terminal payload", async () => {
        stubComandoApi({ shellState: null });

        await expect(loadAppTerminalSettings()).resolves.toEqual(
            DEFAULT_APP_TERMINAL_SETTINGS,
        );
    });

    it("loads normalized terminal settings from the snapshot", async () => {
        stubComandoApi({
            shellState: null,
            terminal: {
                claudeCodeContinueSession: true,
                claudeCodeMaxTurns: 2000,
                claudeCodeModel: "unknown-model",
                claudeCodeOptimized: true,
                claudeCodeSkipPermissions: true,
                terminalFontFamily: "  FiraCode\nNerd Font  ",
                terminalFontSize: 99,
            },
        });

        await expect(loadAppTerminalSettings()).resolves.toEqual({
            claudeCodeContinueSession: true,
            claudeCodeMaxTurns: 1000,
            claudeCodeModel: "",
            claudeCodeOptimized: true,
            claudeCodeSkipPermissions: true,
            terminalFontFamily: "FiraCode Nerd Font",
            terminalFontSize: 24,
        });
    });

    it("normalizes terminal settings before saving and preserves the current snapshot", async () => {
        const appearance = createAppearanceSettings({ zoomFactor: 1.2 });
        const { saveSettingsSnapshot } = stubComandoApi({
            appearance,
            shellState: {
                activeSurface: "workspace",
                leftWidth: 312,
            },
        });

        await saveAppTerminalSettings({
            claudeCodeContinueSession: true,
            claudeCodeMaxTurns: 2000,
            claudeCodeModel: "not-safe",
            claudeCodeOptimized: true,
            claudeCodeSkipPermissions: true,
            terminalFontFamily: "  Menlo\nmonospace  ",
            terminalFontSize: 4,
        });

        expect(saveSettingsSnapshot).toHaveBeenCalledWith({
            appearance,
            shellState: {
                activeSurface: "workspace",
                leftWidth: 312,
            },
            terminal: {
                claudeCodeContinueSession: true,
                claudeCodeMaxTurns: 1000,
                claudeCodeModel: "",
                claudeCodeOptimized: true,
                claudeCodeSkipPermissions: true,
                terminalFontFamily: "Menlo monospace",
                terminalFontSize: 8,
            },
        });
    });
});
