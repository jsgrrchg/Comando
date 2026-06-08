import type { SpawnOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    isWindowsBatchCommand,
    prepareCommandForExecFile,
    prepareCommandForSpawn,
} from "./command-launch";

const tempDirs: string[] = [];

afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
        fs.rmSync(tempDir, { force: true, recursive: true });
    }
});

describe("command launch helpers", () => {
    it("wraps Windows .cmd files through cmd.exe", () => {
        const prepared = prepareCommandForSpawn(
            "C:\\Program Files\\nodejs\\pnpm.cmd",
            ["run", "test suite"],
            undefined,
            { platform: "win32" },
        );

        expect(prepared).toEqual({
            args: [
                "/d",
                "/s",
                "/c",
                '""C:\\Program Files\\nodejs\\pnpm.cmd" "run" "test suite""',
            ],
            command: "cmd.exe",
            options: undefined,
            wrappedByWindowsShell: true,
        });
    });

    it("wraps Windows .bat files case-insensitively for execFile", () => {
        const prepared = prepareCommandForExecFile(
            "C:\\Tools\\setup.BAT",
            ["--flag"],
            { cwd: "C:\\Workspaces\\Project" },
            { platform: "win32" },
        );

        expect(prepared.command).toBe("cmd.exe");
        expect(prepared.args).toEqual([
            "/d",
            "/s",
            "/c",
            '""C:\\Tools\\setup.BAT" "--flag""',
        ]);
        expect(prepared.options).toEqual({ cwd: "C:\\Workspaces\\Project" });
        expect(prepared.wrappedByWindowsShell).toBe(true);
    });

    it("escapes cmd metacharacters before launching a batch command", () => {
        const prepared = prepareCommandForSpawn(
            "C:\\Tools\\run.cmd",
            ["A&B", "(group)", "100%", "has^caret", "say \"hi\""],
            undefined,
            { platform: "win32" },
        );

        expect(prepared.args[3]).toBe(
            '""C:\\Tools\\run.cmd" "A^&B" "^(group^)" "100^%" "has^^caret" "say \\"hi\\"""',
        );
    });

    it("preserves spawn options without mutating them", () => {
        const controller = new AbortController();
        const stdio: SpawnOptions["stdio"] = ["ignore", "pipe", "pipe"];
        const options: SpawnOptions = {
            cwd: "C:\\Workspaces\\Project With Spaces",
            env: { PATH: "C:\\Tools", TEST_VALUE: "1" },
            signal: controller.signal,
            stdio,
        };

        const prepared = prepareCommandForSpawn(
            "C:\\Tools\\runner.cmd",
            ["--watch"],
            options,
            { platform: "win32" },
        );

        expect(prepared.options).toBe(options);
        expect(prepared.options.cwd).toBe(
            "C:\\Workspaces\\Project With Spaces",
        );
        expect(prepared.options.env).toBe(options.env);
        expect(prepared.options.signal).toBe(controller.signal);
        expect(prepared.options.stdio).toBe(stdio);
    });

    it("does not wrap non-batch commands on Windows", () => {
        const prepared = prepareCommandForSpawn(
            "C:\\Program Files\\nodejs\\node.exe",
            ["script.js"],
            undefined,
            { platform: "win32" },
        );

        expect(prepared).toEqual({
            args: ["script.js"],
            command: "C:\\Program Files\\nodejs\\node.exe",
            options: undefined,
            wrappedByWindowsShell: false,
        });
    });

    it("wraps bare Windows commands resolved through PATHEXT", () => {
        const binDir = createTempDir();
        const executablePath = writeExecutable(binDir, "pnpm.CMD");

        const prepared = prepareCommandForSpawn(
            "pnpm",
            ["test"],
            undefined,
            {
                env: {
                    PATHEXT: ".EXE;.CMD",
                },
                pathEntries: [binDir],
                platform: "win32",
            },
        );

        expect(prepared).toEqual({
            args: ["/d", "/s", "/c", `""${executablePath}" "test""`],
            command: "cmd.exe",
            options: undefined,
            wrappedByWindowsShell: true,
        });
    });

    it("keeps bare Windows commands unchanged when PATHEXT resolves a non-batch executable", () => {
        const binDir = createTempDir();
        writeExecutable(binDir, "node.EXE");

        const prepared = prepareCommandForSpawn(
            "node",
            ["script.js"],
            undefined,
            {
                env: {
                    PATHEXT: ".EXE;.CMD",
                },
                pathEntries: [binDir],
                platform: "win32",
            },
        );

        expect(prepared).toEqual({
            args: ["script.js"],
            command: "node",
            options: undefined,
            wrappedByWindowsShell: false,
        });
    });

    it("does not wrap batch-looking commands on POSIX platforms", () => {
        const prepared = prepareCommandForSpawn(
            "C:\\Program Files\\nodejs\\pnpm.cmd",
            ["test"],
            undefined,
            { platform: "darwin" },
        );

        expect(prepared).toEqual({
            args: ["test"],
            command: "C:\\Program Files\\nodejs\\pnpm.cmd",
            options: undefined,
            wrappedByWindowsShell: false,
        });
    });

    it("detects Windows batch command extensions", () => {
        expect(isWindowsBatchCommand("C:\\Tools\\run.cmd")).toBe(true);
        expect(isWindowsBatchCommand("C:\\Tools\\run.BAT")).toBe(true);
        expect(isWindowsBatchCommand("C:\\Tools\\run.exe")).toBe(false);
        expect(isWindowsBatchCommand("pnpm")).toBe(false);
    });
});

function createTempDir(): string {
    const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "comando-command-launch-"),
    );
    tempDirs.push(tempDir);
    return tempDir;
}

function writeExecutable(directory: string, name: string): string {
    const executablePath = path.join(directory, name);
    fs.writeFileSync(executablePath, "", { mode: 0o755 });
    fs.chmodSync(executablePath, 0o755);
    return executablePath;
}
