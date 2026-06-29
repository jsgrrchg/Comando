import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    ensurePackagedLinuxUpdaterConfig,
    resolvePackagedLinuxUpdaterConfig,
    verifyPackagedLinuxUpdaterConfig,
} from "./linux-release-metadata.mjs";

const temporaryDirectories = new Set();

afterEach(() => {
    for (const directoryPath of temporaryDirectories) {
        fs.rmSync(directoryPath, {
            force: true,
            recursive: true,
        });
    }
    temporaryDirectories.clear();
});

describe("Linux updater metadata", () => {
    it("resolves packaged updater config from package metadata", () => {
        expect(
            resolvePackagedLinuxUpdaterConfig({
                packageJson: {
                    name: "comando",
                    repository: {
                        type: "git",
                        url: "git+https://github.com/jsgrrchg/Comando.git",
                    },
                },
            }),
        ).toEqual({
            channel: "latest",
            owner: "jsgrrchg",
            provider: "github",
            repo: "Comando",
            updaterCacheDirName: "comando-updater",
        });
    });

    it("materializes missing packaged updater config", () => {
        const tempDir = createTempDir();
        const appUpdateConfigPath = path.join(tempDir, "app-update.yml");

        expect(
            ensurePackagedLinuxUpdaterConfig({
                appUpdateConfigPath,
                packageJson: {
                    name: "comando",
                    repository: "git@github.com:jsgrrchg/Comando.git",
                },
            }),
        ).toBe(true);

        expect(fs.readFileSync(appUpdateConfigPath, "utf8")).toBe(
            [
                "channel: latest",
                "owner: jsgrrchg",
                "provider: github",
                "repo: Comando",
                "updaterCacheDirName: comando-updater",
                "",
            ].join("\n"),
        );
    });

    it("verifies that the packaged app points at GitHub Releases", () => {
        const tempDir = createTempDir();
        const appUpdateConfigPath = path.join(tempDir, "app-update.yml");
        fs.writeFileSync(
            appUpdateConfigPath,
            [
                "channel: latest",
                "owner: jsgrrchg",
                "provider: github",
                "repo: Comando",
                "updaterCacheDirName: comando-updater",
            ].join("\n"),
            "utf8",
        );

        expect(() =>
            verifyPackagedLinuxUpdaterConfig({
                appUpdateConfigPath,
                packageJson: {
                    name: "comando",
                    repository: "git@github.com:jsgrrchg/Comando.git",
                },
            }),
        ).not.toThrow();
    });

    it("rejects packaged updater config that points at another repository", () => {
        const tempDir = createTempDir();
        const appUpdateConfigPath = path.join(tempDir, "app-update.yml");
        fs.writeFileSync(
            appUpdateConfigPath,
            [
                "channel: latest",
                "owner: other",
                "provider: github",
                "repo: Comando",
                "updaterCacheDirName: comando-updater",
            ].join("\n"),
            "utf8",
        );

        expect(() =>
            verifyPackagedLinuxUpdaterConfig({
                appUpdateConfigPath,
                packageJson: {
                    name: "comando",
                    repository: "git@github.com:jsgrrchg/Comando.git",
                },
            }),
        ).toThrow(/owner: jsgrrchg/u);
    });
});

function createTempDir() {
    const directoryPath = fs.mkdtempSync(
        path.join(os.tmpdir(), "comando-linux-release-test-"),
    );
    temporaryDirectories.add(directoryPath);
    return directoryPath;
}
