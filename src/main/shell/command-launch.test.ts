import { spawn, type SpawnOptions } from "node:child_process";
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
                "/v:off",
                "/c",
                '""C:\\Program Files\\nodejs\\pnpm.cmd" "run" "test suite""',
            ],
            command: "cmd.exe",
            options: { windowsVerbatimArguments: true },
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
            "/v:off",
            "/c",
            '""C:\\Tools\\setup.BAT" "--flag""',
        ]);
        expect(prepared.options).toEqual({
            cwd: "C:\\Workspaces\\Project",
            windowsVerbatimArguments: true,
        });
        expect(prepared.wrappedByWindowsShell).toBe(true);
    });

    it("quotes cmd metacharacters before launching a batch command", () => {
        // Keep this mirrored with scripts/ai/_shared.test.mjs so runtime and packaging quoting stay aligned.
        const prepared = prepareCommandForSpawn(
            "C:\\Tools\\run.cmd",
            ["A&B", "(group)", "100%", "has^caret", "say \"hi\""],
            undefined,
            { platform: "win32" },
        );

        expect(prepared.args[4]).toBe(
            '""C:\\Tools\\run.cmd" "A&B" "(group)" "100%" "has^caret" "say \\"hi\\"""',
        );
    });

    it.skipIf(process.platform !== "win32")(
        "launches a real .cmd file with cmd metacharacter arguments",
        async () => {
            const tempDir = createTempDir();
            const commandPath = path.join(tempDir, "launch target.cmd");
            const captureScriptPath = path.join(tempDir, "capture-args.mjs");
            const captureOutputPath = path.join(tempDir, "captured-args.json");
            const expandedTempPath = path.join(tempDir, "Temp Value");
            const expandedComSpec =
                process.env.ComSpec ??
                process.env.COMSPEC ??
                "C:\\Windows\\System32\\cmd.exe";
            const inputArgs = [
                "space value",
                "A&B",
                "%TEMP%",
                "%COMSPEC%",
                "bang!value",
                "caret^value",
                'say "hi"',
                "(group)",
                "C:\\Path With Spaces\\",
            ];
            const expectedReceivedArgs = [
                "space value",
                "A&B",
                // Percent environment references are expanded by cmd.exe before the batch file receives argv.
                expandedTempPath,
                expandedComSpec,
                "bang!value",
                "caret^value",
                'say "hi"',
                "(group)",
                "C:\\Path With Spaces\\",
            ];

            fs.mkdirSync(expandedTempPath);
            fs.writeFileSync(
                captureScriptPath,
                [
                    'import fs from "node:fs";',
                    "fs.writeFileSync(",
                    "    process.env.COMANDO_CAPTURE_OUTPUT,",
                    "    JSON.stringify(process.argv.slice(2)),",
                    '    "utf8",',
                    ");",
                ].join("\n"),
                "utf8",
            );
            fs.writeFileSync(
                commandPath,
                [
                    "@echo off",
                    "setlocal DisableDelayedExpansion",
                    '"%COMANDO_TEST_NODE%" "%~dp0capture-args.mjs" %*',
                    "exit /b %ERRORLEVEL%",
                ].join("\r\n"),
                "utf8",
            );

            const prepared = prepareCommandForSpawn(
                commandPath,
                inputArgs,
                {
                    cwd: tempDir,
                    env: {
                        ...process.env,
                        COMANDO_CAPTURE_OUTPUT: captureOutputPath,
                        COMANDO_TEST_NODE: process.execPath,
                        ComSpec: expandedComSpec,
                        TEMP: expandedTempPath,
                    },
                    stdio: ["ignore", "pipe", "pipe"],
                },
            );

            expect(prepared.wrappedByWindowsShell).toBe(true);

            const result = await runPreparedCommand(prepared);
            if (result.code !== 0) {
                throw new Error(
                    [
                        `Expected command to exit 0, got ${result.code}.`,
                        result.stdout,
                        result.stderr,
                    ]
                        .filter(Boolean)
                        .join("\n"),
                );
            }

            expect(
                JSON.parse(fs.readFileSync(captureOutputPath, "utf8")),
            ).toEqual(expectedReceivedArgs);
        },
    );

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

        expect(prepared.options).not.toBe(options);
        expect(prepared.options.cwd).toBe(
            "C:\\Workspaces\\Project With Spaces",
        );
        expect(prepared.options.env).toBe(options.env);
        expect(prepared.options.signal).toBe(controller.signal);
        expect(prepared.options.stdio).toBe(stdio);
        expect(prepared.options.windowsVerbatimArguments).toBe(true);
        expect(options.windowsVerbatimArguments).toBeUndefined();
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
            args: [
                "/d",
                "/s",
                "/v:off",
                "/c",
                `""${executablePath}" "test""`,
            ],
            command: "cmd.exe",
            options: { windowsVerbatimArguments: true },
            wrappedByWindowsShell: true,
        });
    });

    it("resolves Windows PATH and PATHEXT case-insensitively", () => {
        const binDir = createTempDir();
        const executablePath = writeExecutable(binDir, "pnpm.CMD");

        const prepared = prepareCommandForSpawn(
            "pnpm",
            ["test"],
            undefined,
            {
                env: {
                    Path: binDir,
                    PathExt: ".EXE;.CMD",
                },
                platform: "win32",
            },
        );

        expect(prepared).toEqual({
            args: [
                "/d",
                "/s",
                "/v:off",
                "/c",
                `""${executablePath}" "test""`,
            ],
            command: "cmd.exe",
            options: { windowsVerbatimArguments: true },
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

function runPreparedCommand(
    prepared: ReturnType<typeof prepareCommandForSpawn<SpawnOptions>>,
): Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stderr: string;
    readonly stdout: string;
}> {
    return new Promise((resolve, reject) => {
        const child = spawn(prepared.command, prepared.args, prepared.options);
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];

        child.stdout?.on("data", (chunk: Buffer) => {
            stdout.push(chunk);
        });
        child.stderr?.on("data", (chunk: Buffer) => {
            stderr.push(chunk);
        });
        child.on("error", reject);
        child.on("close", (code, signal) => {
            resolve({
                code,
                signal,
                stderr: Buffer.concat(stderr).toString("utf8"),
                stdout: Buffer.concat(stdout).toString("utf8"),
            });
        });
    });
}
