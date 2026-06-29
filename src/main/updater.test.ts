import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    hasPackagedUpdateConfig,
    isLinuxAppImageEnvironment,
    resolvePackagedUpdateConfigPath,
    resolveAutoUpdateSupportState,
    shouldEnableAutoUpdates,
} from "./updater-config";

const temporaryDirectories = new Set<string>();

afterEach(() => {
    for (const directoryPath of temporaryDirectories) {
        fs.rmSync(directoryPath, {
            force: true,
            recursive: true,
        });
    }
    temporaryDirectories.clear();
});

describe("shouldEnableAutoUpdates", () => {
    it("requires packaged release builds", () => {
        expect(
            shouldEnableAutoUpdates({
                appChannel: "dev",
                isPackaged: true,
                platform: "darwin",
            }),
        ).toBe(false);

        expect(
            shouldEnableAutoUpdates({
                appChannel: "release",
                isPackaged: false,
                platform: "darwin",
            }),
        ).toBe(false);
    });

    it("supports packaged release builds on macOS, Windows, and Linux AppImage", () => {
        expect(
            shouldEnableAutoUpdates({
                appChannel: "release",
                isPackaged: true,
                platform: "darwin",
            }),
        ).toBe(true);

        expect(
            shouldEnableAutoUpdates({
                appChannel: "release",
                isPackaged: true,
                platform: "win32",
            }),
        ).toBe(true);

        expect(
            shouldEnableAutoUpdates({
                appChannel: "release",
                isLinuxAppImage: true,
                isPackaged: true,
                platform: "linux",
            }),
        ).toBe(true);
    });

    it("skips unsupported platforms and non-AppImage Linux packages", () => {
        expect(
            shouldEnableAutoUpdates({
                appChannel: "release",
                isPackaged: true,
                platform: "linux",
            }),
        ).toBe(false);

        expect(
            shouldEnableAutoUpdates({
                appChannel: "release",
                isLinuxAppImage: false,
                isPackaged: true,
                platform: "linux",
            }),
        ).toBe(false);
    });
});

describe("isLinuxAppImageEnvironment", () => {
    it("detects AppImage runtime environments", () => {
        expect(isLinuxAppImageEnvironment({ APPIMAGE: "/opt/Comando.AppImage" }))
            .toBe(true);
        expect(isLinuxAppImageEnvironment({ APPIMAGE: "   " })).toBe(false);
        expect(isLinuxAppImageEnvironment({})).toBe(false);
    });
});

describe("hasPackagedUpdateConfig", () => {
    it("resolves the packaged updater metadata file", () => {
        expect(resolvePackagedUpdateConfigPath("/tmp/comando")).toBe(
            path.join("/tmp/comando", "app-update.yml"),
        );
    });

    it("detects when the packaged updater metadata exists", () => {
        const resourcesPath = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-updater-test-"),
        );
        temporaryDirectories.add(resourcesPath);

        expect(hasPackagedUpdateConfig(resourcesPath)).toBe(false);

        fs.writeFileSync(
            resolvePackagedUpdateConfigPath(resourcesPath),
            "provider: github\n",
            "utf8",
        );

        expect(hasPackagedUpdateConfig(resourcesPath)).toBe(true);
    });
});

describe("resolveAutoUpdateSupportState", () => {
    it("describes why development builds cannot auto-update", () => {
        expect(
            resolveAutoUpdateSupportState({
                appChannel: "dev",
                isPackaged: false,
                platform: "darwin",
            }),
        ).toEqual({
            enabled: false,
            message:
                "Auto-updates are only available in packaged release builds.",
        });
    });

    it("requires packaged updater metadata when resourcesPath is provided", () => {
        const resourcesPath = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-updater-support-test-"),
        );
        temporaryDirectories.add(resourcesPath);

        expect(
            resolveAutoUpdateSupportState({
                appChannel: "release",
                isLinuxAppImage: true,
                isPackaged: true,
                platform: "linux",
                resourcesPath,
            }),
        ).toEqual({
            enabled: false,
            message:
                "This packaged build does not include updater metadata yet.",
        });

        fs.writeFileSync(
            resolvePackagedUpdateConfigPath(resourcesPath),
            "provider: github\n",
            "utf8",
        );

        expect(
            resolveAutoUpdateSupportState({
                appChannel: "release",
                isLinuxAppImage: true,
                isPackaged: true,
                platform: "linux",
                resourcesPath,
            }),
        ).toEqual({
            enabled: true,
            message:
                "Automatic updates are enabled for this packaged release build.",
        });
    });
});
