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
            fallbackReason: null,
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
            fallbackReason: null,
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
            ).toEqual({ args, command, fallbackReason: null });
        },
    );

    it("falls back to Windows PowerShell when PowerShell 7 is unavailable", () => {
        expect(
            resolveTerminalShell({
                env: {},
                isCommandAvailable: (command) => command !== "pwsh",
                platform: "win32",
                windowsShell: "pwsh",
            }),
        ).toEqual({
            args: ["-NoLogo"],
            command: "powershell.exe",
            fallbackReason:
                "PowerShell 7 (pwsh) was not found. Falling back to Windows PowerShell.",
        });
    });

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
            fallbackReason: null,
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
            fallbackReason: null,
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
            fallbackReason: null,
        });
    });
});
