import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SIGN_RPM_PACKAGES_SCRIPT = path.join(
    SCRIPTS_DIR,
    "sign-rpm-packages.mjs",
);
const VALIDATE_LINUX_RPM_PACKAGE_SCRIPT = path.join(
    SCRIPTS_DIR,
    "validate-linux-rpm-package.mjs",
);

function withTempDir(callback) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "comando-rpm-test-"));
    try {
        return callback(tempDir);
    } finally {
        fs.rmSync(tempDir, { force: true, recursive: true });
    }
}

describe("RPM signing scripts", () => {
    it("fails clearly when no RPM packages exist to sign", () => {
        withTempDir((tempDir) => {
            const result = childProcess.spawnSync(
                process.execPath,
                [
                    SIGN_RPM_PACKAGES_SCRIPT,
                    "--rpm-dir",
                    tempDir,
                    "--key-id",
                    "fixture-key",
                ],
                { encoding: "utf8" },
            );

            expect(result.status).not.toBe(0);
            expect(`${result.stdout}\n${result.stderr}`).toContain(
                "No RPM packages found",
            );
        });
    });

    it("fails clearly when the expected RPM asset is missing", () => {
        withTempDir((tempDir) => {
            const result = childProcess.spawnSync(
                process.execPath,
                [
                    VALIDATE_LINUX_RPM_PACKAGE_SCRIPT,
                    "--staged-assets-dir",
                    tempDir,
                    "--arch",
                    "x64",
                    "--version",
                    "0.1.0",
                ],
                { encoding: "utf8" },
            );

            expect(result.status).not.toBe(0);
            expect(`${result.stdout}\n${result.stderr}`).toContain(
                "Comando-0.1.0-linux-x86_64.rpm",
            );
        });
    });
});
