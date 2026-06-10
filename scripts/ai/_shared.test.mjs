import { describe, expect, it } from "vitest";

import {
    isWindowsBatchCommand,
    prepareCommandForSpawnSync,
} from "./_shared.mjs";

describe("script command launch helpers", () => {
    it.each(["pnpm.cmd", "npm.cmd"])(
        "wraps %s paths with spaces through cmd.exe",
        (commandName) => {
            const command = `C:\\Program Files\\nodejs\\${commandName}`;
            const options = {
                cwd: "C:\\Workspaces\\Project With Spaces",
                env: {
                    PATH: "C:\\Program Files\\nodejs",
                },
                stdio: "inherit",
            };

            const prepared = prepareCommandForSpawnSync(
                command,
                ["run", "build & package", "%TEMP%"],
                options,
                {
                    comSpec: "C:\\Windows\\System32\\cmd.exe",
                    platform: "win32",
                },
            );

            expect(prepared).toEqual({
                args: [
                    "/d",
                    "/s",
                    "/v:off",
                    "/c",
                    `""${command}" "run" "build & package" ""^%"TEMP"^%"""`,
                ],
                command: "C:\\Windows\\System32\\cmd.exe",
                options: {
                    ...options,
                    windowsVerbatimArguments: true,
                },
            });
            expect(prepared.options).not.toBe(options);
            expect(options.windowsVerbatimArguments).toBeUndefined();
        },
    );

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

    it("quotes cmd metacharacters before launching a batch command", () => {
        // Keep this mirrored with src/main/shell/command-launch.test.ts so runtime and packaging quoting stay aligned.
        const prepared = prepareCommandForSpawnSync(
            "C:\\Tools\\run.cmd",
            ["A&B", "(group)", "100%", "has^caret", "say \"hi\""],
            undefined,
            { platform: "win32" },
        );

        expect(prepared.args[4]).toBe(
            '""C:\\Tools\\run.cmd" "A&B" "(group)" "100"^%"" "has^caret" "say \\"hi\\"""',
        );
        expect(prepared.options.windowsVerbatimArguments).toBe(true);
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

    it("detects Windows batch command extensions", () => {
        expect(isWindowsBatchCommand("C:\\Tools\\run.cmd")).toBe(true);
        expect(isWindowsBatchCommand("C:\\Tools\\run.BAT")).toBe(true);
        expect(isWindowsBatchCommand("C:\\Tools\\node.exe")).toBe(false);
        expect(isWindowsBatchCommand("pnpm")).toBe(false);
    });
});
