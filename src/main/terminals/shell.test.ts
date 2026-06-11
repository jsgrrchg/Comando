import { describe, expect, it } from "vitest";

import { resolveTerminalShell, resolveTerminalShellArgs } from "./shell";

describe("resolveTerminalShell", () => {
    it("uses COMSPEC for the default Windows shell", () => {
        expect(
            resolveTerminalShell({
                env: {
                    COMSPEC: "C:\\Windows\\System32\\cmd.exe",
                },
                platform: "win32",
                windowsShell: "default",
            }),
        ).toEqual({
            args: [],
            command: "C:\\Windows\\System32\\cmd.exe",
        });
    });

    it("falls back to Windows PowerShell when COMSPEC is absent", () => {
        expect(
            resolveTerminalShell({
                env: {},
                platform: "win32",
                windowsShell: "default",
            }),
        ).toEqual({
            args: ["-NoLogo"],
            command: "powershell.exe",
        });
    });

    it.each([
        ["cmd", "cmd.exe", []],
        ["powershell", "powershell.exe", ["-NoLogo"]],
        ["pwsh", "pwsh.exe", ["-NoLogo"]],
    ])(
        "resolves the configured Windows %s shell",
        (windowsShell, command, args) => {
            expect(
                resolveTerminalShell({
                    env: {},
                    platform: "win32",
                    windowsShell,
                }),
            ).toEqual({ args, command });
        },
    );

    it("resolves Windows shell args from absolute paths on any host OS", () => {
        expect(
            resolveTerminalShellArgs(
                "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
                "win32",
            ),
        ).toEqual(["-NoLogo"]);
        expect(
            resolveTerminalShellArgs(
                "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
                "win32",
            ),
        ).toEqual(["-NoLogo"]);
        expect(
            resolveTerminalShellArgs("C:\\Windows\\System32\\cmd.exe", "win32"),
        ).toEqual([]);
    });

    it("resolves POSIX shells from SHELL and platform defaults", () => {
        expect(
            resolveTerminalShell({
                env: {
                    SHELL: "/opt/homebrew/bin/fish",
                },
                platform: "darwin",
                windowsShell: "pwsh",
            }),
        ).toEqual({
            args: [],
            command: "/opt/homebrew/bin/fish",
        });
        expect(
            resolveTerminalShell({
                env: {},
                platform: "darwin",
                windowsShell: "pwsh",
            }),
        ).toEqual({
            args: ["-l"],
            command: "zsh",
        });
        expect(
            resolveTerminalShell({
                env: {},
                platform: "linux",
                windowsShell: "pwsh",
            }),
        ).toEqual({
            args: ["-l"],
            command: "bash",
        });
    });
});
