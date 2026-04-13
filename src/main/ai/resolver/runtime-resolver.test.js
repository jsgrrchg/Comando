import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCodexRuntime } from "./runtime-resolver";
const originalPath = process.env.PATH;
const originalLegacyEnv = process.env.COMANDO_CODEX_ACP_BIN;
afterEach(() => {
    process.env.PATH = originalPath;
    if (typeof originalLegacyEnv === "string") {
        process.env.COMANDO_CODEX_ACP_BIN = originalLegacyEnv;
    }
    else {
        delete process.env.COMANDO_CODEX_ACP_BIN;
    }
});
describe("resolveCodexRuntime", () => {
    it("resuelve codex-acp desde PATH sin argumentos extra", () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "comando-codex-acp-"));
        try {
            const executablePath = path.join(tempDir, "codex-acp");
            fs.writeFileSync(executablePath, "#!/bin/sh\nexit 0\n", "utf8");
            fs.chmodSync(executablePath, 0o755);
            process.env.PATH = tempDir;
            const resolved = resolveCodexRuntime({
                binaryPath: null,
            });
            expect(resolved.executable).toBe(executablePath);
            expect(resolved.args).toEqual([]);
            expect(resolved.command).toBe(executablePath);
            expect(resolved.status.state).toBe("ready");
        }
        finally {
            fs.rmSync(tempDir, {
                force: true,
                recursive: true,
            });
        }
    });
    it("marca codex como incompatible cuando solo existe el CLI moderno", () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "comando-codex-cli-"));
        try {
            const executablePath = path.join(tempDir, "codex");
            fs.writeFileSync(executablePath, "#!/bin/sh\nexit 0\n", "utf8");
            fs.chmodSync(executablePath, 0o755);
            process.env.PATH = tempDir;
            const resolved = resolveCodexRuntime({
                binaryPath: null,
            });
            expect(resolved.executable).toBe(executablePath);
            expect(resolved.args).toEqual([]);
            expect(resolved.command).toBe(executablePath);
            expect(resolved.status.state).toBe("error");
            expect(resolved.status.message).toContain("no un runtime ACP");
        }
        finally {
            fs.rmSync(tempDir, {
                force: true,
                recursive: true,
            });
        }
    });
});
