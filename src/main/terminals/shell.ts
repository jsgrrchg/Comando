import path from "node:path";

export interface ResolveTerminalShellInput {
    readonly env?: NodeJS.ProcessEnv;
    readonly isCommandAvailable?: (command: string) => boolean;
    readonly platform?: NodeJS.Platform;
    readonly windowsShell: string;
}

export interface ResolvedTerminalShell {
    readonly args: readonly string[];
    readonly command: string;
    readonly fallbackReason: string | null;
}

export function resolveTerminalShell({
    env = process.env,
    isCommandAvailable,
    platform = process.platform,
    windowsShell,
}: ResolveTerminalShellInput): ResolvedTerminalShell {
    const resolved =
        platform === "win32"
            ? resolveWindowsShell(windowsShell, env, isCommandAvailable)
            : {
                  command: resolvePosixShell(platform, env),
                  fallbackReason: null,
              };

    return {
        args: resolveTerminalShellArgs(resolved.command, platform),
        command: resolved.command,
        fallbackReason: resolved.fallbackReason,
    };
}

function resolveWindowsShell(
    windowsShell: string,
    env: NodeJS.ProcessEnv,
    isCommandAvailable: ((command: string) => boolean) | undefined,
): Pick<ResolvedTerminalShell, "command" | "fallbackReason"> {
    switch (windowsShell) {
        case "cmd":
            return { command: "cmd.exe", fallbackReason: null };
        case "powershell":
            return { command: "powershell.exe", fallbackReason: null };
        case "pwsh":
            if (isCommandAvailable?.("pwsh") === false) {
                return {
                    command: "powershell.exe",
                    fallbackReason:
                        "PowerShell 7 (pwsh) was not found. Falling back to Windows PowerShell.",
                };
            }
            return { command: "pwsh.exe", fallbackReason: null };
        case "default":
        default:
            return {
                command: env.COMSPEC ?? env.ComSpec ?? "powershell.exe",
                fallbackReason: null,
            };
    }
}

function resolvePosixShell(
    platform: NodeJS.Platform,
    env: NodeJS.ProcessEnv,
): string {
    return env.SHELL ?? (platform === "darwin" ? "zsh" : "bash");
}

export function resolveTerminalShellArgs(
    shell: string,
    platform = process.platform,
): readonly string[] {
    if (platform === "win32") {
        const normalizedShell = shell.toLowerCase();
        const shellBaseName = getShellBaseName(normalizedShell, platform);
        return normalizedShell.includes("powershell") ||
            shellBaseName === "pwsh.exe"
            ? ["-NoLogo"]
            : [];
    }

    const shellBaseName = getShellBaseName(shell, platform).toLowerCase();
    if (shellBaseName === "zsh" || shellBaseName === "bash") {
        return ["-l"];
    }

    if (shellBaseName === "fish") {
        return [];
    }

    return ["-l"];
}

function getShellBaseName(shell: string, platform: NodeJS.Platform): string {
    return platform === "win32"
        ? path.win32.basename(shell)
        : path.basename(shell);
}
