import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { checkCommandAvailability } from "./command-availability";

const tempDirs: string[] = [];

afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
        fs.rmSync(tempDir, { force: true, recursive: true });
    }
});

describe("checkCommandAvailability", () => {
    it("finds an allowed executable in PATH entries without running it", () => {
        const binDir = createTempDir();
        const executablePath = writeExecutable(
            binDir,
            "claude",
            [
                "#!/bin/sh",
                `touch ${JSON.stringify(path.join(binDir, "ran"))}`,
            ].join("\n"),
        );

        const result = checkCommandAvailability(
            { name: "claude" },
            { pathEntries: [binDir] },
        );

        expect(result).toEqual({
            found: true,
            path: executablePath,
        });
        expect(fs.existsSync(path.join(binDir, "ran"))).toBe(false);
    });

    it("rejects unsafe or non-allowed command names", () => {
        const binDir = createTempDir();
        writeExecutable(binDir, "claude");

        for (const name of [
            "claude code",
            "./claude",
            "claude;rm",
            "'claude'",
            "codex",
        ]) {
            expect(
                checkCommandAvailability(
                    { name },
                    { pathEntries: [binDir] },
                ),
            ).toEqual({
                found: false,
                path: null,
            });
        }
    });

    it("respects PATHEXT when resolving on Windows", () => {
        const binDir = createTempDir();
        const executablePath = writeExecutable(binDir, "claude.CMD");

        expect(
            checkCommandAvailability(
                { name: "claude" },
                {
                    env: { PATHEXT: ".CMD" },
                    pathEntries: [binDir],
                    platform: "win32",
                },
            ),
        ).toEqual({
            found: true,
            path: executablePath,
        });
    });
});

function createTempDir(): string {
    const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "comando-command-availability-"),
    );
    tempDirs.push(tempDir);
    return tempDir;
}

function writeExecutable(
    directory: string,
    name: string,
    content = "",
): string {
    const executablePath = path.join(directory, name);
    fs.writeFileSync(executablePath, content, { mode: 0o755 });
    fs.chmodSync(executablePath, 0o755);
    return executablePath;
}
