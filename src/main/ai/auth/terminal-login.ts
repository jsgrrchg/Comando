import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface LaunchTerminalLoginCommandInput {
    readonly commandParts: readonly string[];
    readonly cwd?: string | null;
    readonly exitOnCommandError?: boolean;
    readonly missingTerminalMessage: string;
    readonly scriptPrefix: string;
}

export function launchTerminalLoginCommand(
    input: LaunchTerminalLoginCommandInput,
): Promise<void> {
    if (process.platform === "win32") {
        const scriptPath = buildWindowsLoginScript(input);
        return spawnDetached("cmd", [
            "/C",
            "start",
            "",
            "cmd",
            "/K",
            scriptPath,
        ]);
    }

    if (process.platform === "darwin") {
        const scriptPath = buildPosixLoginScript(input);
        return spawnDetached("open", ["-a", "Terminal", scriptPath]);
    }

    const scriptPath = buildPosixLoginScript(input);
    const candidates: Array<readonly [string, readonly string[]]> = [
        ["x-terminal-emulator", ["-e", scriptPath]],
        ["gnome-terminal", ["--", "bash", scriptPath]],
        ["konsole", ["-e", "bash", scriptPath]],
        ["xterm", ["-e", "bash", scriptPath]],
    ];

    for (const [program, args] of candidates) {
        const resolvedProgram = resolveFromPath(program);
        if (!resolvedProgram) {
            continue;
        }

        return spawnDetached(resolvedProgram, args);
    }

    return Promise.reject(new Error(input.missingTerminalMessage));
}

export function buildWindowsLoginScript(
    input: Pick<
        LaunchTerminalLoginCommandInput,
        "commandParts" | "cwd" | "exitOnCommandError" | "scriptPrefix"
    >,
): string {
    const scriptPath = path.join(
        os.tmpdir(),
        `${input.scriptPrefix}-${Date.now()}.cmd`,
    );
    const lines = [
        "@echo off",
        ...(input.cwd ? [`cd /d ${quoteWindowsArg(input.cwd)}`] : []),
        input.commandParts.map(quoteWindowsArg).join(" "),
        "pause",
    ];
    fs.writeFileSync(scriptPath, lines.join("\r\n"), "utf8");
    return scriptPath;
}

export function buildPosixLoginScript(
    input: Pick<
        LaunchTerminalLoginCommandInput,
        "commandParts" | "cwd" | "exitOnCommandError" | "scriptPrefix"
    >,
): string {
    const scriptPath = path.join(
        os.tmpdir(),
        `${input.scriptPrefix}-${Date.now()}.sh`,
    );
    const lines = [
        "#!/bin/sh",
        ...(input.exitOnCommandError ? ["set -e"] : []),
        ...(input.cwd ? [`cd ${quoteShellArg(input.cwd)}`] : []),
        input.commandParts.map(quoteShellArg).join(" "),
        'printf "\\nPress Enter to close... "',
        "read _ignored",
    ];
    fs.writeFileSync(scriptPath, lines.join("\n"), "utf8");
    fs.chmodSync(scriptPath, 0o755);
    return scriptPath;
}

export function quoteShellArg(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function quoteWindowsArg(value: string): string {
    return `"${escapeWindowsBatchArgument(value)}"`;
}

function escapeWindowsBatchArgument(value: string): string {
    return value
        .replace(/%/g, "%%")
        .replace(/\^/g, "^^")
        .replace(/!/g, "^!")
        .replace(/"/g, '^"')
        .replace(/([&|<>()])/g, "^$1");
}

function spawnDetached(
    program: string,
    args: readonly string[],
): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(program, [...args], {
            detached: true,
            stdio: "ignore",
        });

        child.once("error", reject);
        child.once("spawn", () => {
            child.unref();
            resolve();
        });
    });
}

function resolveFromPath(command: string): string | null {
    const pathValue = process.env.PATH ?? "";
    const extensions =
        process.platform === "win32"
            ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
                  .split(";")
                  .filter(Boolean)
            : [""];

    for (const directory of pathValue.split(path.delimiter)) {
        if (!directory) {
            continue;
        }

        for (const extension of extensions) {
            const candidate = path.join(directory, `${command}${extension}`);
            if (isExecutable(candidate)) {
                return candidate;
            }
        }
    }

    return null;
}

function isExecutable(candidate: string): boolean {
    try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}
