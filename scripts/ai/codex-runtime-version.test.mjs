import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    assertCodexRuntimeBundleVersion,
    assertCodexRuntimeBinaryVersion,
    countBinaryVersionOccurrences,
    resolveExpectedCodexRuntimeVersion,
} from "./codex-runtime-version.mjs";

const temporaryDirectories = new Set();

afterEach(() => {
    for (const directoryPath of temporaryDirectories) {
        fs.rmSync(directoryPath, { force: true, recursive: true });
    }
    temporaryDirectories.clear();
});

describe("Codex runtime version verification", () => {
    it("reads the aligned Codex tag from the vendored Cargo manifest", () => {
        const tempDir = createTempDir();
        const cargoTomlPath = path.join(tempDir, "Cargo.toml");
        fs.writeFileSync(
            cargoTomlPath,
            [
                '[package]',
                'name = "codex-acp"',
                'codex-core = { git = "https://github.com/openai/codex", tag = "rust-v0.144.0" }',
                'codex-login = { git = "https://github.com/openai/codex", tag = "rust-v0.144.0" }',
            ].join("\n"),
        );

        expect(resolveExpectedCodexRuntimeVersion(cargoTomlPath)).toBe(
            "0.144.0",
        );
    });

    it("counts version markers split across read chunks", () => {
        const tempDir = createTempDir();
        const binaryPath = path.join(tempDir, "codex-acp");
        fs.writeFileSync(binaryPath, "abc0.144.0def0.144.0ghi");

        expect(countBinaryVersionOccurrences(binaryPath, "0.144.0", 6)).toBe(
            2,
        );
    });

    it("rejects a stale prebuilt runtime", () => {
        const tempDir = createTempDir();
        const binaryPath = path.join(tempDir, "codex-acp");
        fs.writeFileSync(binaryPath, "0.137.0\u00000.137.0");

        expect(() =>
            assertCodexRuntimeBinaryVersion({
                binaryPath,
                expectedVersion: "0.144.0",
            }),
        ).toThrow(/does not match the vendored Codex runtime 0\.144\.0/u);
    });

    it("accepts a runtime with repeated matching version markers", () => {
        const tempDir = createTempDir();
        const binaryPath = path.join(tempDir, "codex-acp");
        fs.writeFileSync(binaryPath, "0.144.0\u00000.144.0");

        expect(() =>
            assertCodexRuntimeBinaryVersion({
                binaryPath,
                expectedVersion: "0.144.0",
            }),
        ).not.toThrow();
    });

    it("requires the ACP sidecar and code mode host to share the same version", () => {
        const tempDir = createTempDir();
        const codexBinaryPath = path.join(tempDir, "codex-acp");
        const codeModeHostBinaryPath = path.join(
            tempDir,
            "codex-code-mode-host",
        );
        fs.writeFileSync(codexBinaryPath, "0.144.0\u00000.144.0");
        fs.writeFileSync(codeModeHostBinaryPath, "host\u00000.137.0");

        expect(() =>
            assertCodexRuntimeBundleVersion({
                codeModeHostBinaryPath,
                codexBinaryPath,
                expectedVersion: "0.144.0",
            }),
        ).toThrow(/codex-code-mode-host.*0\.144\.0/u);

        fs.writeFileSync(codeModeHostBinaryPath, "host\u00000.144.0");
        expect(() =>
            assertCodexRuntimeBundleVersion({
                codeModeHostBinaryPath,
                codexBinaryPath,
                expectedVersion: "0.144.0",
            }),
        ).not.toThrow();
    });
});

function createTempDir() {
    const directoryPath = fs.mkdtempSync(
        path.join(os.tmpdir(), "comando-codex-runtime-version-"),
    );
    temporaryDirectories.add(directoryPath);
    return directoryPath;
}
