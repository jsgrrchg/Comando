import { describe, expect, it } from "vitest";

import { resolveSettingsSnapshotSaveEffects } from "./settings-save-effects";

describe("resolveSettingsSnapshotSaveEffects", () => {
    it("does not broadcast for shell-only snapshots", () => {
        expect(
            resolveSettingsSnapshotSaveEffects({
                shellState: null,
            }),
        ).toEqual({
            applyAppZoom: false,
            broadcastSettingsUpdated: false,
        });
    });

    it("broadcasts terminal updates without applying app zoom", () => {
        expect(
            resolveSettingsSnapshotSaveEffects({
                shellState: null,
                terminal: {
                    claudeCodeContinueSession: false,
                    claudeCodeMaxTurns: 0,
                    claudeCodeModel: "",
                    claudeCodeOptimized: true,
                    claudeCodeSkipPermissions: false,
                    terminalFontFamily: "Menlo",
                    terminalFontSize: 14,
                    windowsShell: "default",
                },
            }),
        ).toEqual({
            applyAppZoom: false,
            broadcastSettingsUpdated: true,
        });
    });

    it("applies app zoom only when appearance is part of the saved snapshot", () => {
        expect(
            resolveSettingsSnapshotSaveEffects({
                appearance: null,
                shellState: null,
            }),
        ).toEqual({
            applyAppZoom: true,
            broadcastSettingsUpdated: true,
        });

        expect(
            resolveSettingsSnapshotSaveEffects({
                aiChat: null,
                shellState: null,
            }),
        ).toEqual({
            applyAppZoom: false,
            broadcastSettingsUpdated: true,
        });
    });
});
