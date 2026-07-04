import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RELEASE_TARGETS } from "./release-target-metadata.mjs";
import { resolveLinuxReleaseArtifacts } from "./linux-release-metadata.mjs";
import { validateReleaseAssets } from "./validate-release-assets.mjs";
import { resolveWindowsReleaseArtifacts } from "./windows-release-metadata.mjs";

const temporaryDirectories = new Set();
const packageJson = {
    build: {
        productName: "Comando",
    },
    name: "comando",
};

afterEach(() => {
    for (const directoryPath of temporaryDirectories) {
        fs.rmSync(directoryPath, {
            force: true,
            recursive: true,
        });
    }
    temporaryDirectories.clear();
});

describe("release asset coverage validation", () => {
    it("accepts the full staged release asset matrix", () => {
        const assetsDir = createCompleteAssetsDir();

        expect(
            validateReleaseAssets({
                assetsDir,
                packageJson,
                version: "v1.2.3",
            }),
        ).toEqual({
            targets: RELEASE_TARGETS.map((target) => target.id),
        });
    });

    it("rejects a missing target artifact directory", () => {
        const assetsDir = createCompleteAssetsDir();
        fs.rmSync(path.join(assetsDir, "release-assets-windows-arm64"), {
            force: true,
            recursive: true,
        });

        expect(() =>
            validateReleaseAssets({
                assetsDir,
                packageJson,
                version: "v1.2.3",
            }),
        ).toThrow(/release-assets-windows-arm64/u);
    });

    it("rejects duplicate asset names across staged artifacts", () => {
        const assetsDir = createCompleteAssetsDir();
        fs.writeFileSync(
            path.join(
                assetsDir,
                "release-assets-windows-arm64",
                "Comando-1.2.3-win-x64.exe",
            ),
            "",
            "utf8",
        );

        expect(() =>
            validateReleaseAssets({
                assetsDir,
                packageJson,
                version: "v1.2.3",
            }),
        ).toThrow(/Duplicate staged release asset name/u);
    });

    it("rejects shared updater metadata", () => {
        const assetsDir = createCompleteAssetsDir();
        fs.writeFileSync(
            path.join(assetsDir, "release-assets-linux-x64", "latest-linux.yml"),
            "",
            "utf8",
        );

        expect(() =>
            validateReleaseAssets({
                assetsDir,
                packageJson,
                version: "v1.2.3",
            }),
        ).toThrow(/shared updater metadata/u);
    });

    it("requires explicit macOS updater metadata", () => {
        const assetsDir = createCompleteAssetsDir();
        fs.rmSync(
            path.join(assetsDir, "release-assets-macos-universal", "latest-mac.yml"),
        );

        expect(() =>
            validateReleaseAssets({
                assetsDir,
                packageJson,
                version: "v1.2.3",
            }),
        ).toThrow(/latest-mac\.yml/u);
    });

    it("rejects macOS updater metadata that does not point at the zip", () => {
        const assetsDir = createCompleteAssetsDir();
        fs.writeFileSync(
            path.join(assetsDir, "release-assets-macos-universal", "latest-mac.yml"),
            "path: Comando-1.2.3-universal.dmg\n",
            "utf8",
        );

        expect(() =>
            validateReleaseAssets({
                assetsDir,
                packageJson,
                version: "v1.2.3",
            }),
        ).toThrow(/does not reference Comando-1\.2\.3-universal\.zip/u);
    });

    it("rejects Linux metadata that points at another architecture", () => {
        const assetsDir = createCompleteAssetsDir();
        const linuxX64Dir = path.join(assetsDir, "release-assets-linux-x64");
        const artifacts = resolveLinuxReleaseArtifacts({
            distDir: linuxX64Dir,
            productName: "Comando",
            targetArch: "x64",
            version: "1.2.3",
        });
        fs.writeFileSync(
            artifacts.metadataPath,
            "path: Comando-1.2.3-linux-arm64.AppImage\n",
            "utf8",
        );

        expect(() =>
            validateReleaseAssets({
                assetsDir,
                packageJson,
                version: "v1.2.3",
            }),
        ).toThrow(/linux-x86_64\.AppImage/u);
    });
});

function createCompleteAssetsDir() {
    const assetsDir = createTempDir();
    writeMacAssets(path.join(assetsDir, "release-assets-macos-universal"));
    writeWindowsAssets(path.join(assetsDir, "release-assets-windows-x64"), "x64");
    writeWindowsAssets(
        path.join(assetsDir, "release-assets-windows-arm64"),
        "arm64",
    );
    writeLinuxAssets(path.join(assetsDir, "release-assets-linux-x64"), "x64");
    writeLinuxAssets(path.join(assetsDir, "release-assets-linux-arm64"), "arm64");
    return assetsDir;
}

function writeMacAssets(distDir) {
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(
        path.join(distDir, "Comando-1.2.3-universal.dmg"),
        "",
        "utf8",
    );
    fs.writeFileSync(
        path.join(distDir, "Comando-1.2.3-universal.zip"),
        "",
        "utf8",
    );
    fs.writeFileSync(
        path.join(distDir, "latest-mac.yml"),
        "path: Comando-1.2.3-universal.zip\n",
        "utf8",
    );
}

function writeWindowsAssets(distDir, targetArch) {
    fs.mkdirSync(distDir, { recursive: true });
    const artifacts = resolveWindowsReleaseArtifacts({
        distDir,
        productName: "Comando",
        targetArch,
        version: "1.2.3",
    });

    fs.writeFileSync(artifacts.installerPath, "", "utf8");
    fs.writeFileSync(artifacts.blockmapPath, "", "utf8");
    fs.writeFileSync(
        artifacts.metadataPath,
        `path: ${artifacts.installerFileName}\n`,
        "utf8",
    );
}

function writeLinuxAssets(distDir, targetArch) {
    fs.mkdirSync(distDir, { recursive: true });
    const artifacts = resolveLinuxReleaseArtifacts({
        distDir,
        productName: "Comando",
        targetArch,
        version: "1.2.3",
    });

    fs.writeFileSync(artifacts.appImagePath, "", "utf8");
    fs.writeFileSync(artifacts.debPath, "", "utf8");
    fs.writeFileSync(artifacts.rpmPath, "", "utf8");
    fs.writeFileSync(
        artifacts.metadataPath,
        `path: ${path.basename(artifacts.appImagePath)}\n`,
        "utf8",
    );
}

function createTempDir() {
    const directoryPath = fs.mkdtempSync(
        path.join(os.tmpdir(), "comando-release-assets-test-"),
    );
    temporaryDirectories.add(directoryPath);
    return directoryPath;
}
