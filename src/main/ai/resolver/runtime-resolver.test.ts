import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
    it("resuelve codex-acp desde PATH sin argumentos extra", () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-codex-acp-"),
        );

        try {
            delete process.env.COMANDO_CODEX_ACP_BIN;
            const executablePath = path.join(tempDir, "codex-acp");
            fs.writeFileSync(executablePath, "#!/bin/sh\nexit 0\n", "utf8");
            fs.chmodSync(executablePath, 0o755);
            process.env.PATH = tempDir;

            const resolved = resolveCodexRuntime(
                {
                    binaryPath: null,
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

    it("prefiere el binario bundleado antes que vendor o PATH", () => {
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
                "codex-acp",
            );
            const vendorPath = path.join(
                tempRoot,
                "vendor",
                "codex-acp",
                "target",
                "release",
                "codex-acp",
            );
            const pathExecutable = path.join(tempPathDir, "codex-acp");

            fs.mkdirSync(path.dirname(bundledPath), { recursive: true });
            fs.mkdirSync(path.dirname(vendorPath), { recursive: true });
            fs.writeFileSync(bundledPath, "#!/bin/sh\nexit 0\n", "utf8");
            fs.writeFileSync(vendorPath, "#!/bin/sh\nexit 0\n", "utf8");
            fs.writeFileSync(pathExecutable, "#!/bin/sh\nexit 0\n", "utf8");
            fs.chmodSync(bundledPath, 0o755);
            fs.chmodSync(vendorPath, 0o755);
            fs.chmodSync(pathExecutable, 0o755);
            process.env.PATH = tempPathDir;

            const resolved = resolveCodexRuntime(
                {
                    binaryPath: null,
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

    it("usa el vendor release cuando todavía no existe el bundle stageado", () => {
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
                "codex-acp",
            );
            fs.mkdirSync(path.dirname(vendorPath), { recursive: true });
            fs.writeFileSync(vendorPath, "#!/bin/sh\nexit 0\n", "utf8");
            fs.chmodSync(vendorPath, 0o755);
            process.env.PATH = "";

            const resolved = resolveCodexRuntime(
                {
                    binaryPath: null,
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

    it("marca codex como incompatible cuando solo existe el CLI moderno", () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-codex-cli-"),
        );

        try {
            delete process.env.COMANDO_CODEX_ACP_BIN;
            const executablePath = path.join(tempDir, "codex");
            fs.writeFileSync(executablePath, "#!/bin/sh\nexit 0\n", "utf8");
            fs.chmodSync(executablePath, 0o755);
            process.env.PATH = tempDir;

            const resolved = resolveCodexRuntime(
                {
                    binaryPath: null,
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
            expect(resolved.status.message).toContain("no un runtime ACP");
        } finally {
            fs.rmSync(tempDir, {
                force: true,
                recursive: true,
            });
        }
    });
});
