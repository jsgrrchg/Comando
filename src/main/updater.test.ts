import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    hasPackagedUpdateConfig,
    resolvePackagedUpdateConfigPath,
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

    it("supports packaged release builds on macOS and Windows", () => {
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
    });

    it("skips unsupported platforms", () => {
        expect(
            shouldEnableAutoUpdates({
                appChannel: "release",
                isPackaged: true,
                platform: "linux",
            }),
        ).toBe(false);
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
