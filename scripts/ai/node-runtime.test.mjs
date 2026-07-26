import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    assertFileSha256,
    EMBEDDED_NODE_VERSION,
    readNodeVersion,
    resolveOfficialNodeDistribution,
} from "./node-runtime.mjs";

const temporaryDirectories = new Set();

afterEach(() => {
    for (const directoryPath of temporaryDirectories) {
        fs.rmSync(directoryPath, { force: true, recursive: true });
    }
    temporaryDirectories.clear();
});

describe("embedded Node runtime", () => {
    it("pins the official archive and checksum for every supported target", () => {
        const targets = [
            ["darwin", "arm64", "tar.gz"],
            ["darwin", "x64", "tar.gz"],
            ["linux", "arm64", "tar.gz"],
            ["linux", "x64", "tar.gz"],
            ["win32", "arm64", "zip"],
            ["win32", "x64", "zip"],
        ];

        for (const [platform, arch, extension] of targets) {
            const distribution = resolveOfficialNodeDistribution(
                platform,
                arch,
            );
            expect(distribution.archiveName).toBe(
                `node-${EMBEDDED_NODE_VERSION}-${distribution.nodeTarget}.${extension}`,
            );
            expect(distribution.archiveUrl).toBe(
                `https://nodejs.org/dist/${EMBEDDED_NODE_VERSION}/${distribution.archiveName}`,
            );
            expect(distribution.archiveSha256).toMatch(/^[a-f0-9]{64}$/u);
        }
    });

    it("rejects unsupported platform and architecture pairs", () => {
        expect(() =>
            resolveOfficialNodeDistribution("darwin", "riscv64"),
        ).toThrow(/COMANDO_EMBEDDED_NODE_BIN/u);
    });

    it("rejects archives whose checksum differs from the pinned digest", () => {
        const tempDir = createTempDir();
        const archivePath = path.join(tempDir, "node.tar.gz");
        fs.writeFileSync(archivePath, "unexpected archive");

        expect(() =>
            assertFileSha256(archivePath, "0".repeat(64), "node.tar.gz"),
        ).toThrow(/SHA-256 mismatch/u);
    });

    it.runIf(process.platform !== "win32")(
        "executes the staged binary when reading its version",
        () => {
            const tempDir = createTempDir();
            const binaryPath = path.join(tempDir, "node");
            fs.writeFileSync(binaryPath, "#!/bin/sh\nprintf 'v22.23.1\\n'\n");
            fs.chmodSync(binaryPath, 0o755);

            expect(readNodeVersion(binaryPath)).toEqual({
                major: 22,
                version: "v22.23.1",
            });
        },
    );

    it.runIf(process.platform !== "win32")(
        "rejects an executable that cannot start after staging",
        () => {
            const tempDir = createTempDir();
            const binaryPath = path.join(tempDir, "node");
            fs.writeFileSync(
                binaryPath,
                "#!/bin/sh\nprintf 'missing shared library\\n' >&2\nexit 127\n",
            );
            fs.chmodSync(binaryPath, 0o755);

            expect(() => readNodeVersion(binaryPath)).toThrow(
                /missing shared library/u,
            );
        },
    );
});

function createTempDir() {
    const directoryPath = fs.mkdtempSync(
        path.join(os.tmpdir(), "comando-node-runtime-test-"),
    );
    temporaryDirectories.add(directoryPath);
    return directoryPath;
}
