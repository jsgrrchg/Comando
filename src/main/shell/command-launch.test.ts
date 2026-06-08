import type { SpawnOptions } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
    isWindowsBatchCommand,
    prepareCommandForExecFile,
    prepareCommandForSpawn,
} from "./command-launch";

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
