import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    isWindowsBatchCommand,
    prepareCommandForSpawnSync,
    spawnPreparedSync,
} from "./_shared.mjs";

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

describe("script command launch helpers", () => {
    it.each([
        {
            cliFileName: "pnpm.cjs",
            commandName: "pnpm.cmd",
            cliOptionName: "pnpmCliPath",
        },
        {
            cliFileName: "npm-cli.js",
            commandName: "npm.cmd",
            cliOptionName: "npmCliPath",
        },
    ])("runs $commandName through node instead of cmd.exe", (fixture) => {
        const tempDir = createTempDir();
        const commandPath = path.join(tempDir, fixture.commandName);
        const cliPath = path.join(tempDir, fixture.cliFileName);
        fs.writeFileSync(commandPath, "", "utf8");
        fs.writeFileSync(cliPath, "", "utf8");

        const options = {
            cwd: "C:\\Workspaces\\Project With Spaces",
            env: {
                PATH: tempDir,
                PATHEXT: ".CMD",
            },
            stdio: "inherit",
        };

        const prepared = prepareCommandForSpawnSync(
            fixture.commandName,
            ["run", "build & package", "%TEMP%"],
            options,
            {
                [fixture.cliOptionName]: cliPath,
                commandPath,
                nodeCommand: "node.exe",
                platform: "win32",
            },
        );

        expect(prepared).toEqual({
            args: [cliPath, "run", "build & package", "%TEMP%"],
            command: "node.exe",
            options,
        });
        expect(prepared.options).toBe(options);
    });

    it("does not wrap Windows non-batch executables", () => {
        const prepared = prepareCommandForSpawnSync(
            "C:\\Program Files\\nodejs\\node.exe",
            ["script.js"],
            undefined,
            { platform: "win32" },
        );

        expect(prepared).toEqual({
            args: ["script.js"],
            command: "C:\\Program Files\\nodejs\\node.exe",
            options: {},
        });
    });

    it("passes cmd metacharacters as node CLI arguments", () => {
        const tempDir = createTempDir();
        const commandPath = path.join(tempDir, "npm.cmd");
        const npmCliPath = path.join(tempDir, "npm-cli.js");
        fs.writeFileSync(commandPath, "", "utf8");
        fs.writeFileSync(npmCliPath, "", "utf8");

        const prepared = prepareCommandForSpawnSync(
            "npm.cmd",
            ["A&B", "(group)", "100%", "has^caret", "say \"hi\""],
            { env: { PATH: tempDir, PATHEXT: ".CMD" } },
            {
                commandPath,
                nodeCommand: "node.exe",
                npmCliPath,
                platform: "win32",
            },
        );

        expect(prepared).toEqual({
            args: [npmCliPath, "A&B", "(group)", "100%", "has^caret", "say \"hi\""],
            command: "node.exe",
            options: { env: { PATH: tempDir, PATHEXT: ".CMD" } },
        });
    });

    it("does not wrap batch commands outside Windows", () => {
        const prepared = prepareCommandForSpawnSync(
            "C:\\Program Files\\nodejs\\pnpm.cmd",
            ["run", "build"],
            { cwd: "/repo" },
            { platform: "darwin" },
        );

        expect(prepared).toEqual({
            args: ["run", "build"],
            command: "C:\\Program Files\\nodejs\\pnpm.cmd",
            options: { cwd: "/repo" },
        });
    });

    it("rejects absolute Windows batch commands before preparing", () => {
        expect(() =>
            prepareCommandForSpawnSync(
                "C:\\Program Files\\nodejs\\npm.cmd",
                ["ci"],
                undefined,
                { platform: "win32" },
            ),
        ).toThrow(/absolute Windows batch command/);
    });

    it("rejects unsupported Windows batch commands", () => {
        const tempDir = createTempDir();
        const commandPath = path.join(tempDir, "run.cmd");
        fs.writeFileSync(commandPath, "", "utf8");

        expect(() =>
            prepareCommandForSpawnSync("run.cmd", [], undefined, {
                commandPath,
                platform: "win32",
            }),
        ).toThrow(/Unsupported Windows batch command/);
    });

    it("rejects absolute Windows batch commands before spawning", () => {
        expect(() =>
            spawnPreparedSync(
                "C:\\Program Files\\nodejs\\npm.cmd",
                ["ci"],
                undefined,
                { platform: "win32" },
            ),
        ).toThrow(/absolute Windows batch command/);
    });

    it("detects Windows batch command extensions", () => {
        expect(isWindowsBatchCommand("C:\\Tools\\run.cmd")).toBe(true);
        expect(isWindowsBatchCommand("C:\\Tools\\run.BAT")).toBe(true);
        expect(isWindowsBatchCommand("C:\\Tools\\node.exe")).toBe(false);
        expect(isWindowsBatchCommand("pnpm")).toBe(false);
    });
});

function createTempDir() {
    const directoryPath = fs.mkdtempSync(
        path.join(os.tmpdir(), "comando-command-launch-test-"),
    );
    temporaryDirectories.add(directoryPath);
    return directoryPath;
}
