import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppEditorSettings, SettingsSnapshot } from "@shared/ipc";

import {
    getCachedAppEditorSettings,
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

function stubComandoApi(snapshot: SettingsSnapshot) {
    vi.stubGlobal("window", {
        comando: {
            getSettingsSnapshot: vi.fn().mockResolvedValue(snapshot),
            saveSettingsSnapshot: vi.fn(),
        },
    });
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
