import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    ensurePackagedLinuxUpdaterConfig,
    resolveLinuxReleaseArtifacts,
    resolveLinuxUpdaterChannel,
    resolvePackagedLinuxUpdaterConfig,
    verifyLinuxPackageArtifacts,
    verifyLinuxReleaseArtifacts,
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
    it("uses a separate updater channel per Linux architecture", () => {
        expect(resolveLinuxUpdaterChannel("x64")).toBe("latest-x64");
        expect(resolveLinuxUpdaterChannel("arm64")).toBe("latest-arm64");
    });

    it("resolves the expected package and metadata names", () => {
        expect(
            resolveLinuxReleaseArtifacts({
                distDir: "dist",
                productName: "Comando",
                targetArch: "x64",
                version: "1.2.3",
            }),
        ).toEqual({
            appImageBlockmapPath: path.join(
                "dist",
                "Comando-1.2.3-linux-x86_64.AppImage.blockmap",
            ),
            appImagePath: path.join(
                "dist",
                "Comando-1.2.3-linux-x86_64.AppImage",
            ),
            debPath: path.join("dist", "Comando-1.2.3-linux-amd64.deb"),
            forbiddenSharedMetadataPath: path.join("dist", "latest-linux.yml"),
            metadataPath: path.join("dist", "latest-x64-linux.yml"),
            rpmPath: path.join("dist", "Comando-1.2.3-linux-x86_64.rpm"),
            updaterChannel: "latest-x64",
        });
        expect(
            resolveLinuxReleaseArtifacts({
                distDir: "dist",
                productName: "Comando",
                targetArch: "arm64",
                version: "1.2.3",
            }),
        ).toEqual({
            appImageBlockmapPath: path.join(
                "dist",
                "Comando-1.2.3-linux-arm64.AppImage.blockmap",
            ),
            appImagePath: path.join(
                "dist",
                "Comando-1.2.3-linux-arm64.AppImage",
            ),
            debPath: path.join("dist", "Comando-1.2.3-linux-arm64.deb"),
            forbiddenSharedMetadataPath: path.join(
                "dist",
                "latest-linux-arm64.yml",
            ),
            metadataPath: path.join(
                "dist",
                "latest-arm64-linux-arm64.yml",
            ),
            rpmPath: path.join("dist", "Comando-1.2.3-linux-aarch64.rpm"),
            updaterChannel: "latest-arm64",
        });
    });

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
            ensurePackagedLinuxUpdaterConfig({
                appUpdateConfigPath,
                packageJson: {
                    name: "comando",
                    repository: "git@github.com:jsgrrchg/Comando.git",
                },
                targetArch: "x64",
            }),
        ).toBe(true);

        expect(fs.readFileSync(appUpdateConfigPath, "utf8")).toBe(
            [
                "channel: latest-x64",
                "owner: jsgrrchg",
                "provider: github",
                "repo: Comando",
                "updaterCacheDirName: comando-updater",
                "",
            ].join("\n"),
        );
    });

    it("verifies that the packaged app points at the architecture channel", () => {
        const tempDir = createTempDir();
        const appUpdateConfigPath = path.join(tempDir, "app-update.yml");
        fs.writeFileSync(
            appUpdateConfigPath,
            [
                "channel: latest-x64",
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
                targetArch: "x64",
            }),
        ).not.toThrow();
    });

    it("rejects packaged updater config that points at another repository", () => {
        const tempDir = createTempDir();
        const appUpdateConfigPath = path.join(tempDir, "app-update.yml");
        fs.writeFileSync(
            appUpdateConfigPath,
            [
                "channel: latest-x64",
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
                targetArch: "x64",
            }),
        ).toThrow(/owner: jsgrrchg/u);
    });

    it("rejects packaged updater config that points at the shared Linux channel", () => {
        const tempDir = createTempDir();
        const appUpdateConfigPath = path.join(tempDir, "app-update.yml");
        fs.writeFileSync(
            appUpdateConfigPath,
            "provider: github\nchannel: latest\nowner: jsgrrchg\nrepo: Comando\nupdaterCacheDirName: comando-updater\n",
            "utf8",
        );

        expect(() =>
            verifyPackagedLinuxUpdaterConfig({
                appUpdateConfigPath,
                packageJson: {
                    name: "comando",
                    repository: "git@github.com:jsgrrchg/Comando.git",
                },
                targetArch: "x64",
            }),
        ).toThrow(/latest-x64/u);
    });

    it("verifies final Linux release artifacts for one architecture", () => {
        const distDir = createTempDir();
        writeReleaseArtifactSet(distDir, "x64");

        expect(() =>
            verifyLinuxReleaseArtifacts({
                distDir,
                productName: "Comando",
                targetArch: "x64",
                version: "1.2.3",
            }),
        ).not.toThrow();
    });

    it("verifies Linux package artifacts without updater metadata", () => {
        const distDir = createTempDir();
        writePackageArtifactSet(distDir, "arm64");

        expect(() =>
            verifyLinuxPackageArtifacts({
                distDir,
                productName: "Comando",
                targetArch: "arm64",
                version: "1.2.3",
            }),
        ).not.toThrow();
    });

    it("keeps updater metadata required for final Linux releases", () => {
        const distDir = createTempDir();
        writePackageArtifactSet(distDir, "x64");

        expect(() =>
            verifyLinuxReleaseArtifacts({
                distDir,
                productName: "Comando",
                targetArch: "x64",
                version: "1.2.3",
            }),
        ).toThrow(/AppImage\.blockmap/u);
    });

    it("rejects shared Linux updater metadata", () => {
        const distDir = createTempDir();
        writeReleaseArtifactSet(distDir, "arm64");
        fs.writeFileSync(path.join(distDir, "latest-linux-arm64.yml"), "", "utf8");

        expect(() =>
            verifyLinuxReleaseArtifacts({
                distDir,
                productName: "Comando",
                targetArch: "arm64",
                version: "1.2.3",
            }),
        ).toThrow(/latest-linux-arm64\.yml/u);
    });

    it("rejects metadata that points at the other architecture", () => {
        const distDir = createTempDir();
        writeReleaseArtifactSet(distDir, "x64", {
            metadataAppImageName: "Comando-1.2.3-linux-arm64.AppImage",
        });

        expect(() =>
            verifyLinuxReleaseArtifacts({
                distDir,
                productName: "Comando",
                targetArch: "x64",
                version: "1.2.3",
            }),
        ).toThrow(/does not reference Comando-1\.2\.3-linux-x86_64\.AppImage/u);
    });
});

function createTempDir() {
    const directoryPath = fs.mkdtempSync(
        path.join(os.tmpdir(), "comando-linux-release-test-"),
    );
    temporaryDirectories.add(directoryPath);
    return directoryPath;
}

function writeReleaseArtifactSet(
    distDir,
    targetArch,
    { metadataAppImageName = null } = {},
) {
    const artifacts = resolveLinuxReleaseArtifacts({
        distDir,
        productName: "Comando",
        targetArch,
        version: "1.2.3",
    });

    for (const filePath of [
        artifacts.appImagePath,
        artifacts.debPath,
        artifacts.rpmPath,
    ]) {
        fs.writeFileSync(filePath, "", "utf8");
    }

    fs.writeFileSync(artifacts.appImageBlockmapPath, "", "utf8");

    const appImageName = metadataAppImageName ?? path.basename(artifacts.appImagePath);
    fs.writeFileSync(
        artifacts.metadataPath,
        [
            "version: 1.2.3",
            "files:",
            `  - url: ${appImageName}`,
            `path: ${appImageName}`,
        ].join("\n"),
        "utf8",
    );
}

function writePackageArtifactSet(distDir, targetArch) {
    const artifacts = resolveLinuxReleaseArtifacts({
        distDir,
        productName: "Comando",
        targetArch,
        version: "1.2.3",
    });

    for (const filePath of [
        artifacts.appImagePath,
        artifacts.debPath,
        artifacts.rpmPath,
    ]) {
        fs.writeFileSync(filePath, "", "utf8");
    }
}
