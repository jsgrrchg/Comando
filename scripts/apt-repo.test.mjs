import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import { describe, expect, it } from "vitest";

import {
    APT_EXACT_PATH_SUITE,
    APT_PUBLIC_KEY_FILE_NAME,
    APT_RELEASE_DOWNLOAD_BASE_URL,
    APT_SOURCES_EXAMPLE_FILE_NAME,
    APT_SUPPORTED_ARCHITECTURES,
    buildAptReleaseContent,
    buildComandoSourcesExample,
    buildDebianReleaseAssetName,
    getFileHashes,
    parseDebianControlStanza,
    renderPackagesStanza,
} from "./apt-repo-lib.mjs";

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const VALIDATE_APT_REPOSITORY_SCRIPT = path.join(
    SCRIPTS_DIR,
    "validate-apt-repository.mjs",
);

function writeFixtureFlatAptRepository({ filenamesByArchitecture = {} } = {}) {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "comando-apt-test-"));
    const aptDir = path.join(rootDir, "apt-release");
    const packageAssetsDir = path.join(rootDir, "release-assets");
    const releaseFiles = [];

    fs.mkdirSync(aptDir, { recursive: true });
    fs.mkdirSync(packageAssetsDir, { recursive: true });
    fs.writeFileSync(
        path.join(aptDir, APT_PUBLIC_KEY_FILE_NAME),
        "fixture public key\n",
        "utf8",
    );
    fs.writeFileSync(
        path.join(aptDir, APT_SOURCES_EXAMPLE_FILE_NAME),
        buildComandoSourcesExample(APT_RELEASE_DOWNLOAD_BASE_URL, {
            component: null,
            suite: APT_EXACT_PATH_SUITE,
        }),
        "utf8",
    );

    const stanzas = [];
    for (const architecture of APT_SUPPORTED_ARCHITECTURES) {
        const assetName = buildDebianReleaseAssetName("0.1.0", architecture);
        const assetPath = path.join(packageAssetsDir, assetName);
        const assetBytes = Buffer.from(`fixture package ${architecture}\n`);
        fs.writeFileSync(assetPath, assetBytes);

        stanzas.push(
            renderPackagesStanza({
                controlFields: parseDebianControlStanza(
                    [
                        "Package: comando",
                        "Version: 0.1.0",
                        `Architecture: ${architecture}`,
                        "Description: Comando desktop",
                        "",
                    ].join("\n"),
                ),
                filename: filenamesByArchitecture[architecture] ?? assetName,
                hashes: getFileHashes(assetPath),
                sizeBytes: assetBytes.length,
            }),
        );
    }

    const packagesContent = `${stanzas.join("\n")}\n`;
    fs.writeFileSync(path.join(aptDir, "Packages"), packagesContent, "utf8");
    fs.writeFileSync(
        path.join(aptDir, "Packages.gz"),
        zlib.gzipSync(Buffer.from(packagesContent, "utf8")),
    );

    for (const relativePath of ["Packages", "Packages.gz"]) {
        const absolutePath = path.join(aptDir, relativePath);
        releaseFiles.push({
            hashes: getFileHashes(absolutePath),
            relativePath,
            sizeBytes: fs.statSync(absolutePath).size,
        });
    }

    fs.writeFileSync(
        path.join(aptDir, "Release"),
        buildAptReleaseContent({
            component: null,
            date: new Date("2026-06-29T00:00:00Z"),
            files: releaseFiles,
        }),
        "utf8",
    );
    fs.writeFileSync(path.join(aptDir, "InRelease"), "fixture inrelease\n", "utf8");
    fs.writeFileSync(path.join(aptDir, "Release.gpg"), "fixture signature\n", "utf8");

    return { aptDir, packageAssetsDir, rootDir };
}

function validateFixtureFlatAptRepository(aptDir, packageAssetsDir) {
    return childProcess.spawnSync(
        process.execPath,
        [
            VALIDATE_APT_REPOSITORY_SCRIPT,
            "--layout",
            "flat-release",
            "--apt-dir",
            aptDir,
            "--package-assets-dir",
            packageAssetsDir,
            "--version",
            "0.1.0",
            "--skip-signature-check",
        ],
        { encoding: "utf8" },
    );
}

describe("APT repository metadata", () => {
    it("maps Debian architectures to release asset names", () => {
        expect(buildDebianReleaseAssetName("0.1.0", "amd64")).toBe(
            "Comando-0.1.0-linux-x64.deb",
        );
        expect(buildDebianReleaseAssetName("0.1.0", "arm64")).toBe(
            "Comando-0.1.0-linux-arm64.deb",
        );
    });

    it("renders the flat release Deb822 source", () => {
        const source = buildComandoSourcesExample(APT_RELEASE_DOWNLOAD_BASE_URL, {
            component: null,
            suite: APT_EXACT_PATH_SUITE,
        });

        expect(source).toContain(
            `URIs: ${APT_RELEASE_DOWNLOAD_BASE_URL}`,
        );
        expect(source).toContain("Suites: ./");
        expect(source).not.toContain("Components:");
        expect(source).toContain("Architectures: amd64 arm64");
        expect(source).toContain("Signed-By: /etc/apt/keyrings/comando.asc");
    });

    it("renders Packages stanzas with flat release asset filenames", () => {
        const stanza = renderPackagesStanza({
            controlFields: parseDebianControlStanza(
                [
                    "Package: comando",
                    "Version: 0.1.0",
                    "Architecture: amd64",
                    "Description: Comando desktop",
                    "",
                ].join("\n"),
            ),
            filename: "Comando-0.1.0-linux-x64.deb",
            hashes: {
                MD5Sum: "a".repeat(32),
                SHA1: "b".repeat(40),
                SHA256: "c".repeat(64),
            },
            sizeBytes: 1234,
        });

        expect(stanza).toContain("Filename: Comando-0.1.0-linux-x64.deb");
        expect(stanza).toContain("Size: 1234");
        expect(stanza).toContain(`SHA256: ${"c".repeat(64)}`);
    });

    it("validates a flat release fixture", () => {
        const { aptDir, packageAssetsDir } = writeFixtureFlatAptRepository();
        const result = validateFixtureFlatAptRepository(
            aptDir,
            packageAssetsDir,
        );

        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
    });

    it("rejects flat release filenames that are URLs", () => {
        const { aptDir, packageAssetsDir } = writeFixtureFlatAptRepository({
            filenamesByArchitecture: {
                amd64: "https://github.com/jsgrrchg/Comando/releases/latest/download/Comando-0.1.0-linux-x64.deb",
            },
        });
        const result = validateFixtureFlatAptRepository(
            aptDir,
            packageAssetsDir,
        );

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("invalid Filename");
    });

    it("rejects flat release filenames that include paths", () => {
        const { aptDir, packageAssetsDir } = writeFixtureFlatAptRepository({
            filenamesByArchitecture: {
                amd64: "pool/main/comando/Comando-0.1.0-linux-x64.deb",
            },
        });
        const result = validateFixtureFlatAptRepository(
            aptDir,
            packageAssetsDir,
        );

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("invalid Filename");
    });

    it("rejects flat release filenames that escape the repository root", () => {
        const { aptDir, packageAssetsDir } = writeFixtureFlatAptRepository({
            filenamesByArchitecture: {
                amd64: "../Comando-0.1.0-linux-x64.deb",
            },
        });
        const result = validateFixtureFlatAptRepository(
            aptDir,
            packageAssetsDir,
        );

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("invalid Filename");
    });
});
