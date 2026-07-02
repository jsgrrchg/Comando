import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    resolveCommandFromPath,
    resolveRequiredRcedit,
    resolveWindowsPackagingPreflight,
} from "./windows-packaging-preflight.mjs";

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

describe("Windows packaging preflight", () => {
    it("resolves pnpm.cmd through Windows PATHEXT", () => {
        const tempDir = createTempDir();
        const pnpmPath = writeExecutable(tempDir, "pnpm.cmd");

        expect(
            resolveCommandFromPath("pnpm.cmd", {
                env: {
                    PATH: tempDir,
                    PATHEXT: ".EXE;.CMD",
                },
                platform: "win32",
            }),
        ).toBe(pnpmPath);
    });

    it("prefers ELECTRON_BUILDER_RCEDIT_PATH when provided", () => {
        const tempDir = createTempDir();
        const explicitRcedit = writeExecutable(tempDir, "custom-rcedit.exe");
        createDirectRceditDependency(tempDir);

        expect(
            resolveRequiredRcedit({
                env: {
                    ELECTRON_BUILDER_RCEDIT_PATH: explicitRcedit,
                },
                repoRoot: tempDir,
            }),
        ).toBe(explicitRcedit);
    });

    it("resolves rcedit from the direct dependency", () => {
        const repoRoot = createTempDir();
        const directRcedit = createDirectRceditDependency(repoRoot);

        expect(
            resolveRequiredRcedit({
                env: {},
                repoRoot,
            }),
        ).toBe(directRcedit);
    });

    it("fails clearly when rcedit is missing", () => {
        const repoRoot = createTempDir();

        expect(() =>
            resolveRequiredRcedit({
                env: {},
                repoRoot,
            }),
        ).toThrow(/ELECTRON_BUILDER_RCEDIT_PATH/u);
    });

    it("validates all early Windows packaging inputs", () => {
        const repoRoot = createTempDir();
        const nodeBinDir = path.join(repoRoot, "node-bin");
        const powerShellDir = path.join(repoRoot, "powershell");

        writeExecutable(nodeBinDir, "pnpm.cmd");
        writeExecutable(powerShellDir, "pwsh.exe");
        writeFile(path.join(repoRoot, "node_modules", "electron-builder", "cli.js"));
        writeFile(path.join(repoRoot, "resources", "icons", "windows.ico"));
        createDirectRceditDependency(repoRoot);
        createWindowsAcpPayload(repoRoot, "x64");

        const preflight = resolveWindowsPackagingPreflight({
            env: {
                PATH: powerShellDir,
                PATHEXT: ".EXE;.CMD",
            },
            nodeBinDir,
            platform: "win32",
            repoRoot,
            targetArch: "x64",
        });

        expect(preflight.pnpmCommand).toBe("pnpm.cmd");
        expect(preflight.powerShellCommand).toBe(
            path.join(powerShellDir, "pwsh.exe"),
        );
        expect(preflight.rceditPath).toBe(
            path.join(repoRoot, "node_modules", "rcedit", "bin", "rcedit.exe"),
        );
        expect(preflight.aiPayload.sourceRoot).toBe(
            path.join(repoRoot, "build", "windows-acp", "win-x64", "ai"),
        );
    });

    it("fails before building when the target Windows ACP payload is missing", () => {
        const repoRoot = createTempDir();
        const nodeBinDir = path.join(repoRoot, "node-bin");
        const powerShellDir = path.join(repoRoot, "powershell");

        writeExecutable(nodeBinDir, "pnpm.cmd");
        writeExecutable(powerShellDir, "powershell.exe");
        writeFile(path.join(repoRoot, "node_modules", "electron-builder", "cli.js"));
        writeFile(path.join(repoRoot, "resources", "icons", "windows.ico"));
        createDirectRceditDependency(repoRoot);

        expect(() =>
            resolveWindowsPackagingPreflight({
                env: {
                    PATH: powerShellDir,
                    PATHEXT: ".EXE;.CMD",
                },
                nodeBinDir,
                platform: "win32",
                repoRoot,
                targetArch: "arm64",
            }),
        ).toThrow(/build:windows-acp:arm64/u);
    });
});

function createTempDir() {
    const directoryPath = fs.mkdtempSync(
        path.join(os.tmpdir(), "comando-windows-preflight-test-"),
    );
    temporaryDirectories.add(directoryPath);
    return directoryPath;
}

function createDirectRceditDependency(repoRoot) {
    return writeExecutable(
        path.join(repoRoot, "node_modules", "rcedit", "bin"),
        "rcedit.exe",
    );
}

function createWindowsAcpPayload(repoRoot, targetArch) {
    const sourceRoot = path.join(
        repoRoot,
        "build",
        "windows-acp",
        `win-${targetArch}`,
        "ai",
    );
    writeExecutable(path.join(sourceRoot, "binaries"), "codex-acp.exe");
    writeExecutable(path.join(sourceRoot, "embedded", "node", "bin"), "node.exe");
    writeFile(
        path.join(
            sourceRoot,
            "embedded",
            "claude-agent-acp",
            "dist",
            "index.js",
        ),
    );
    writeFile(
        path.join(
            sourceRoot,
            "embedded",
            "claude-agent-acp",
            "package.json",
        ),
    );
    fs.mkdirSync(
        path.join(sourceRoot, "embedded", "claude-agent-acp", "node_modules"),
        { recursive: true },
    );
}

function writeExecutable(directoryPath, fileName) {
    const filePath = path.join(directoryPath, fileName);
    writeFile(filePath);
    fs.chmodSync(filePath, 0o755);
    return filePath;
}

function writeFile(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "", "utf8");
    return filePath;
}
