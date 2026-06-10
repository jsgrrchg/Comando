import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeTestExecutable } from "@main/testing/executable-fixture";

import { resolveCodexRuntime } from "./runtime-resolver";

const originalPath = process.env.PATH;
const originalLegacyEnv = process.env.COMANDO_CODEX_ACP_BIN;

beforeEach(() => {
    delete process.env.COMANDO_CODEX_ACP_BIN;
});

afterEach(() => {
    process.env.PATH = originalPath;

    if (typeof originalLegacyEnv === "string") {
        process.env.COMANDO_CODEX_ACP_BIN = originalLegacyEnv;
    } else {
        delete process.env.COMANDO_CODEX_ACP_BIN;
    }
});

describe("resolveCodexRuntime", () => {
    it("resolves codex-acp from PATH without extra arguments", () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-codex-acp-"),
        );

        try {
            delete process.env.COMANDO_CODEX_ACP_BIN;
            const executablePath = writeTestExecutable(tempDir, "codex-acp");
            process.env.PATH = tempDir;

            const resolved = resolveCodexRuntime(
                {
                    authMethod: null,
                    binaryPath: null,
                    hasCodexApiKey: false,
                    hasOpenAiApiKey: false,
                },
                {
                    appRoot: tempDir,
                    packagedResourcesPath: null,
                },
            );

            expect(resolved.executable).toBe(executablePath);
            expect(resolved.args).toEqual([]);
            expect(resolved.command).toBe(executablePath);
            expect(resolved.status.state).toBe("ready");
        } finally {
            fs.rmSync(tempDir, {
                force: true,
                recursive: true,
            });
        }
    });

    it("prefers the bundled binary over vendor or PATH", () => {
        const tempRoot = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-codex-bundled-"),
        );
        const tempPathDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-codex-path-"),
        );

        try {
            delete process.env.COMANDO_CODEX_ACP_BIN;
            const bundledPath = path.join(
                tempRoot,
                "resources",
                "ai",
                "binaries",
                getCodexBundledExecutableName(),
            );
            const vendorPath = path.join(
                tempRoot,
                "vendor",
                "codex-acp",
                "target",
                "release",
                getCodexBundledExecutableName(),
            );
            writeTestExecutable(tempPathDir, "codex-acp");

            fs.mkdirSync(path.dirname(bundledPath), { recursive: true });
            fs.mkdirSync(path.dirname(vendorPath), { recursive: true });
            writeTestExecutable(
                path.dirname(bundledPath),
                path.basename(bundledPath),
            );
            writeTestExecutable(
                path.dirname(vendorPath),
                path.basename(vendorPath),
            );
            process.env.PATH = tempPathDir;

            const resolved = resolveCodexRuntime(
                {
                    authMethod: null,
                    binaryPath: null,
                    hasCodexApiKey: false,
                    hasOpenAiApiKey: false,
                },
                {
                    appRoot: tempRoot,
                    packagedResourcesPath: null,
                },
            );

            expect(resolved.executable).toBe(bundledPath);
            expect(resolved.status.source).toBe("bundled");
        } finally {
            fs.rmSync(tempRoot, { force: true, recursive: true });
            fs.rmSync(tempPathDir, { force: true, recursive: true });
        }
    });

    it("uses the vendor release when no bundled build exists", () => {
        const tempRoot = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-codex-vendor-"),
        );

        try {
            delete process.env.COMANDO_CODEX_ACP_BIN;
            const vendorPath = path.join(
                tempRoot,
                "vendor",
                "codex-acp",
                "target",
                "release",
                getCodexBundledExecutableName(),
            );
            fs.mkdirSync(path.dirname(vendorPath), { recursive: true });
            writeTestExecutable(
                path.dirname(vendorPath),
                path.basename(vendorPath),
            );
            process.env.PATH = "";

            const resolved = resolveCodexRuntime(
                {
                    authMethod: null,
                    binaryPath: null,
                    hasCodexApiKey: false,
                    hasOpenAiApiKey: false,
                },
                {
                    allowPathFallback: false,
                    appRoot: tempRoot,
                    packagedResourcesPath: null,
                },
            );

            expect(resolved.executable).toBe(vendorPath);
            expect(resolved.status.source).toBe("vendor");
        } finally {
            fs.rmSync(tempRoot, { force: true, recursive: true });
        }
    });

    it.runIf(process.platform === "darwin")(
        "uses the packaged architecture-specific bundled binary on macOS",
        () => {
            const tempRoot = fs.mkdtempSync(
                path.join(os.tmpdir(), "comando-codex-packaged-"),
            );
            const packagedResourcesPath = path.join(tempRoot, "packaged");

            try {
                delete process.env.COMANDO_CODEX_ACP_BIN;
                process.env.PATH = "";

                const packagedBinary = path.join(
                    packagedResourcesPath,
                    "ai",
                    "binaries",
                    `darwin-${process.arch}`,
                    getCodexBundledExecutableName(),
                );
                fs.mkdirSync(path.dirname(packagedBinary), {
                    recursive: true,
                });
                fs.writeFileSync(
                    packagedBinary,
                    "#!/bin/sh\nexit 0\n",
                    "utf8",
                );
                fs.chmodSync(packagedBinary, 0o755);

                const resolved = resolveCodexRuntime(
                    {
                        authMethod: null,
                        binaryPath: null,
                        hasCodexApiKey: false,
                        hasOpenAiApiKey: false,
                    },
                    {
                        allowPathFallback: false,
                        appRoot: tempRoot,
                        packagedResourcesPath,
                    },
                );

                expect(resolved.executable).toBe(packagedBinary);
                expect(resolved.status.source).toBe("bundled");
            } finally {
                fs.rmSync(tempRoot, { force: true, recursive: true });
            }
        },
    );

    it("marks codex as incompatible when only modern CLI exists", () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-codex-cli-"),
        );

        try {
            delete process.env.COMANDO_CODEX_ACP_BIN;
            const executablePath = writeTestExecutable(
                tempDir,
                process.platform === "win32" ? "codex.EXE" : "codex",
            );
            process.env.PATH = tempDir;

            const resolved = resolveCodexRuntime(
                {
                    authMethod: null,
                    binaryPath: null,
                    hasCodexApiKey: false,
                    hasOpenAiApiKey: false,
                },
                {
                    appRoot: tempDir,
                    packagedResourcesPath: null,
                },
            );

            expect(resolved.executable).toBe(executablePath);
            expect(resolved.args).toEqual([]);
            expect(resolved.command).toBe(executablePath);
            expect(resolved.status.state).toBe("error");
            expect(resolved.status.message).toContain(
                "instead of an ACP runtime",
            );
        } finally {
            fs.rmSync(tempDir, {
                force: true,
                recursive: true,
            });
        }
        },
    );
});

function getCodexBundledExecutableName(): string {
    return process.platform === "win32" ? "codex-acp.exe" : "codex-acp";
}
