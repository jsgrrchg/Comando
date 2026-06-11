import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeTestExecutable } from "@main/testing/executable-fixture";

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
        const executablePath = writeTestExecutable(
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
        writeTestExecutable(binDir, "claude");

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
        const executablePath = writeTestExecutable(binDir, "claude.CMD");

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

    it("allows PowerShell 7 availability checks", () => {
        const binDir = createTempDir();
        const executablePath = writeTestExecutable(binDir, "pwsh.EXE");

        expect(
            checkCommandAvailability(
                { name: "pwsh" },
                {
                    env: { PATHEXT: ".EXE" },
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
