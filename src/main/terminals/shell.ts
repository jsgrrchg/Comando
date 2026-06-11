import path from "node:path";

export interface ResolveTerminalShellInput {
    readonly env?: NodeJS.ProcessEnv;
    readonly platform?: NodeJS.Platform;
    readonly windowsShell: string;
}

export interface ResolvedTerminalShell {
    readonly args: readonly string[];
    readonly command: string;
}

export function resolveTerminalShell({
    env = process.env,
    platform = process.platform,
    windowsShell,
}: ResolveTerminalShellInput): ResolvedTerminalShell {
    const command =
        platform === "win32"
            ? resolveWindowsShell(windowsShell, env)
            : resolvePosixShell(platform, env);

    return {
        args: resolveTerminalShellArgs(command, platform),
        command,
    };
}

function resolveWindowsShell(
    windowsShell: string,
    env: NodeJS.ProcessEnv,
): string {
    switch (windowsShell) {
        case "cmd":
            return "cmd.exe";
        case "powershell":
            return "powershell.exe";
        case "pwsh":
            return "pwsh.exe";
        case "default":
        default:
            return env.COMSPEC ?? env.ComSpec ?? "powershell.exe";
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
