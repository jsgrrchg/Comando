import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    ensurePackagedMacUpdaterConfig,
    resolveMacReleaseArtifacts,
    resolvePackagedMacUpdaterConfig,
    verifyMacReleaseArtifacts,
    verifyPackagedMacUpdaterConfig,
} from "./mac-release-metadata.mjs";

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

describe("macOS updater metadata", () => {
    it("resolves universal release artifact names", () => {
        expect(
            resolveMacReleaseArtifacts({
                distDir: "dist",
                productName: "Comando",
                version: "v1.2.3",
            }),
        ).toEqual({
            dmgFileName: "Comando-1.2.3-universal.dmg",
            dmgPath: path.join("dist", "Comando-1.2.3-universal.dmg"),
            metadataPath: path.join("dist", "latest-mac.yml"),
            zipFileName: "Comando-1.2.3-universal.zip",
            zipPath: path.join("dist", "Comando-1.2.3-universal.zip"),
        });
    });

    it("resolves packaged updater config from package metadata", () => {
        expect(
            resolvePackagedMacUpdaterConfig({
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
            ensurePackagedMacUpdaterConfig({
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

    it("preserves existing packaged updater config", () => {
        const tempDir = createTempDir();
        const appUpdateConfigPath = path.join(tempDir, "app-update.yml");
        fs.writeFileSync(
            appUpdateConfigPath,
            [
                "channel: latest",
                "owner: jsgrrchg",
                "provider: github",
                "repo: Comando",
                "updaterCacheDirName: custom-cache",
            ].join("\n"),
            "utf8",
        );

        expect(
            ensurePackagedMacUpdaterConfig({
                appUpdateConfigPath,
                packageJson: {
                    name: "comando",
                    repository: "git@github.com:jsgrrchg/Comando.git",
                },
            }),
        ).toBe(false);
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
            verifyPackagedMacUpdaterConfig({
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
            verifyPackagedMacUpdaterConfig({
                appUpdateConfigPath,
                packageJson: {
                    name: "comando",
                    repository: "git@github.com:jsgrrchg/Comando.git",
                },
            }),
        ).toThrow(/owner: jsgrrchg/u);
    });

    it("verifies final macOS release artifacts", () => {
        const distDir = createTempDir();
        const artifacts = resolveMacReleaseArtifacts({
            distDir,
            productName: "Comando",
            version: "1.2.3",
        });
        fs.writeFileSync(artifacts.dmgPath, "", "utf8");
        fs.writeFileSync(artifacts.zipPath, "", "utf8");
        fs.writeFileSync(
            artifacts.metadataPath,
            [
                "version: 1.2.3",
                "files:",
                "  - url: Comando-1.2.3-universal.zip",
                "path: Comando-1.2.3-universal.zip",
            ].join("\n"),
            "utf8",
        );

        expect(() =>
            verifyMacReleaseArtifacts({
                distDir,
                productName: "Comando",
                version: "v1.2.3",
            }),
        ).not.toThrow();
    });

    it("requires latest-mac.yml for final macOS release artifacts", () => {
        const distDir = createTempDir();
        const artifacts = resolveMacReleaseArtifacts({
            distDir,
            productName: "Comando",
            version: "1.2.3",
        });
        fs.writeFileSync(artifacts.dmgPath, "", "utf8");
        fs.writeFileSync(artifacts.zipPath, "", "utf8");

        expect(() =>
            verifyMacReleaseArtifacts({
                distDir,
                productName: "Comando",
                version: "1.2.3",
            }),
        ).toThrow(/latest-mac\.yml/u);
    });

    it("rejects macOS updater metadata that does not reference the zip", () => {
        const distDir = createTempDir();
        const artifacts = resolveMacReleaseArtifacts({
            distDir,
            productName: "Comando",
            version: "1.2.3",
        });
        fs.writeFileSync(artifacts.dmgPath, "", "utf8");
        fs.writeFileSync(artifacts.zipPath, "", "utf8");
        fs.writeFileSync(
            artifacts.metadataPath,
            "path: Comando-1.2.3-universal.dmg\n",
            "utf8",
        );

        expect(() =>
            verifyMacReleaseArtifacts({
                distDir,
                productName: "Comando",
                version: "1.2.3",
            }),
        ).toThrow(/does not reference Comando-1\.2\.3-universal\.zip/u);
    });
});

function createTempDir() {
    const directoryPath = fs.mkdtempSync(
        path.join(os.tmpdir(), "comando-mac-release-test-"),
    );
    temporaryDirectories.add(directoryPath);
    return directoryPath;
}
