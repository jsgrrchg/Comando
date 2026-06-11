import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    ensurePackagedWindowsUpdaterConfig,
    resolvePackagedWindowsUpdaterConfig,
    resolveWindowsReleaseArtifacts,
    resolveWindowsUpdaterChannel,
    verifyPackagedWindowsUpdaterChannel,
    verifyWindowsReleaseArtifacts,
} from "./windows-release-metadata.mjs";

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

describe("Windows updater metadata", () => {
    it("uses a separate updater channel per Windows architecture", () => {
        expect(resolveWindowsUpdaterChannel("x64")).toBe("latest-x64");
        expect(resolveWindowsUpdaterChannel("arm64")).toBe("latest-arm64");
    });

    it("resolves the expected installer, blockmap, and metadata names", () => {
        expect(
            resolveWindowsReleaseArtifacts({
                distDir: "dist",
                productName: "Comando",
                targetArch: "arm64",
                version: "1.2.3",
            }),
        ).toEqual({
            blockmapPath: path.join(
                "dist",
                "Comando-1.2.3-win-arm64.exe.blockmap",
            ),
            forbiddenSharedMetadataPath: path.join("dist", "latest.yml"),
            installerFileName: "Comando-1.2.3-win-arm64.exe",
            installerPath: path.join("dist", "Comando-1.2.3-win-arm64.exe"),
            metadataPath: path.join("dist", "latest-arm64.yml"),
            updaterChannel: "latest-arm64",
        });
    });

    it("resolves packaged updater config from package metadata", () => {
        expect(
            resolvePackagedWindowsUpdaterConfig({
                packageJson: {
                    name: "comando",
                    repository: {
                        type: "git",
                        url: "git+https://github.com/jsgrrchg/Comando.git",
                    },
                },
                targetArch: "arm64",
            }),
        ).toEqual({
            channel: "latest-arm64",
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
            ensurePackagedWindowsUpdaterConfig({
                appUpdateConfigPath,
                packageJson: {
                    name: "comando",
                    repository: "git@github.com:jsgrrchg/Comando.git",
                },
                targetArch: "x64",
            }),
        ).toBe(true);

        expect(fs.readFileSync(appUpdateConfigPath, "utf8")).toContain(
            "channel: latest-x64",
        );
    });

    it("preserves existing packaged updater config", () => {
        const tempDir = createTempDir();
        const appUpdateConfigPath = path.join(tempDir, "app-update.yml");
        fs.writeFileSync(
            appUpdateConfigPath,
            "provider: github\nchannel: latest-x64\npublisherName: Comando\n",
            "utf8",
        );

        expect(
            ensurePackagedWindowsUpdaterConfig({
                appUpdateConfigPath,
                packageJson: {
                    name: "comando",
                    repository: "git@github.com:jsgrrchg/Comando.git",
                },
                targetArch: "x64",
            }),
        ).toBe(false);
        expect(fs.readFileSync(appUpdateConfigPath, "utf8")).toContain(
            "publisherName: Comando",
        );
    });

    it("verifies that the packaged app points at the architecture channel", () => {
        const tempDir = createTempDir();
        const appUpdateConfigPath = path.join(tempDir, "app-update.yml");
        fs.writeFileSync(
            appUpdateConfigPath,
            "provider: github\nchannel: latest-x64\n",
            "utf8",
        );

        expect(() =>
            verifyPackagedWindowsUpdaterChannel({
                appUpdateConfigPath,
                targetArch: "x64",
            }),
        ).not.toThrow();
    });

    it("rejects packaged updater config that points at the shared channel", () => {
        const tempDir = createTempDir();
        const appUpdateConfigPath = path.join(tempDir, "app-update.yml");
        fs.writeFileSync(
            appUpdateConfigPath,
            "provider: github\nchannel: latest\n",
            "utf8",
        );

        expect(() =>
            verifyPackagedWindowsUpdaterChannel({
                appUpdateConfigPath,
                targetArch: "x64",
            }),
        ).toThrow(/latest-x64/u);
    });

    it("verifies final Windows release artifacts for one architecture", () => {
        const distDir = createTempDir();
        fs.writeFileSync(
            path.join(distDir, "Comando-1.2.3-win-x64.exe"),
            "",
            "utf8",
        );
        fs.writeFileSync(
            path.join(distDir, "Comando-1.2.3-win-x64.exe.blockmap"),
            "",
            "utf8",
        );
        fs.writeFileSync(
            path.join(distDir, "latest-x64.yml"),
            [
                "version: 1.2.3",
                "files:",
                "  - url: Comando-1.2.3-win-x64.exe",
                "path: Comando-1.2.3-win-x64.exe",
            ].join("\n"),
            "utf8",
        );

        expect(() =>
            verifyWindowsReleaseArtifacts({
                distDir,
                productName: "Comando",
                targetArch: "x64",
                version: "1.2.3",
            }),
        ).not.toThrow();
    });

    it("rejects shared Windows updater metadata", () => {
        const distDir = createTempDir();
        writeReleaseArtifactSet(distDir, "x64");
        fs.writeFileSync(path.join(distDir, "latest.yml"), "", "utf8");

        expect(() =>
            verifyWindowsReleaseArtifacts({
                distDir,
                productName: "Comando",
                targetArch: "x64",
                version: "1.2.3",
            }),
        ).toThrow(/latest\.yml/u);
    });

    it("rejects metadata that points at the other architecture", () => {
        const distDir = createTempDir();
        writeReleaseArtifactSet(distDir, "x64", {
            metadataInstallerName: "Comando-1.2.3-win-arm64.exe",
        });

        expect(() =>
            verifyWindowsReleaseArtifacts({
                distDir,
                productName: "Comando",
                targetArch: "x64",
                version: "1.2.3",
            }),
        ).toThrow(/does not reference Comando-1\.2\.3-win-x64\.exe/u);
    });
});

function createTempDir() {
    const directoryPath = fs.mkdtempSync(
        path.join(os.tmpdir(), "comando-windows-release-test-"),
    );
    temporaryDirectories.add(directoryPath);
    return directoryPath;
}

function writeReleaseArtifactSet(
    distDir,
    targetArch,
    { metadataInstallerName = `Comando-1.2.3-win-${targetArch}.exe` } = {},
) {
    fs.writeFileSync(
        path.join(distDir, `Comando-1.2.3-win-${targetArch}.exe`),
        "",
        "utf8",
    );
    fs.writeFileSync(
        path.join(distDir, `Comando-1.2.3-win-${targetArch}.exe.blockmap`),
        "",
        "utf8",
    );
    fs.writeFileSync(
        path.join(distDir, `latest-${targetArch}.yml`),
        `path: ${metadataInstallerName}\n`,
        "utf8",
    );
}
