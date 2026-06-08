import fs from "node:fs";
import path from "node:path";
import type {
    ExecFileOptions,
    SpawnOptions,
} from "node:child_process";

type CommandLaunchOptions = SpawnOptions | ExecFileOptions;
type WindowsShellOptions<
    TOptions extends CommandLaunchOptions | undefined,
> = (TOptions extends undefined
    ? CommandLaunchOptions
    : Omit<TOptions, "windowsVerbatimArguments">) & {
    readonly windowsVerbatimArguments: true;
};
type PreparedLaunchOptions<
    TOptions extends CommandLaunchOptions | undefined,
> = TOptions | WindowsShellOptions<TOptions>;

export interface PrepareCommandLaunchOptions {
    readonly env?: NodeJS.ProcessEnv;
    readonly pathEntries?: readonly string[];
    readonly platform?: NodeJS.Platform;
}

export interface PreparedCommandLaunch<
    TOptions extends CommandLaunchOptions | undefined =
        | CommandLaunchOptions
        | undefined,
> {
    readonly command: string;
    readonly args: string[];
    readonly options: PreparedLaunchOptions<TOptions>;
    readonly wrappedByWindowsShell: boolean;
}

export function prepareCommandForSpawn<TOptions extends SpawnOptions>(
    command: string,
    args: readonly string[],
    options: TOptions,
    launchOptions?: PrepareCommandLaunchOptions,
): PreparedCommandLaunch<TOptions>;
export function prepareCommandForSpawn(
    command: string,
    args?: readonly string[],
    options?: undefined,
    launchOptions?: PrepareCommandLaunchOptions,
): PreparedCommandLaunch<undefined>;
export function prepareCommandForSpawn(
    command: string,
    args: readonly string[] = [],
    options?: SpawnOptions,
    launchOptions: PrepareCommandLaunchOptions = {},
): PreparedCommandLaunch<SpawnOptions | undefined> {
    return prepareCommandLaunch(command, args, options, launchOptions);
}

export function prepareCommandForExecFile<TOptions extends ExecFileOptions>(
    command: string,
    args: readonly string[],
    options: TOptions,
    launchOptions?: PrepareCommandLaunchOptions,
): PreparedCommandLaunch<TOptions>;
export function prepareCommandForExecFile(
    command: string,
    args?: readonly string[],
    options?: undefined,
    launchOptions?: PrepareCommandLaunchOptions,
): PreparedCommandLaunch<undefined>;
export function prepareCommandForExecFile(
    command: string,
    args: readonly string[] = [],
    options?: ExecFileOptions,
    launchOptions: PrepareCommandLaunchOptions = {},
): PreparedCommandLaunch<ExecFileOptions | undefined> {
    return prepareCommandLaunch(command, args, options, launchOptions);
}

export function isWindowsBatchCommand(command: string): boolean {
    const extension = path.win32.extname(command).toLowerCase();
    return extension === ".cmd" || extension === ".bat";
}

function prepareCommandLaunch<
    TOptions extends CommandLaunchOptions | undefined,
>(
    command: string,
    args: readonly string[],
    options: TOptions,
    launchOptions: PrepareCommandLaunchOptions,
): PreparedCommandLaunch<TOptions> {
    const platform = launchOptions.platform ?? process.platform;
    const resolvedCommand = resolveWindowsBatchCommand(command, launchOptions);
    if (platform !== "win32" || !resolvedCommand) {
        return {
            args: [...args],
            command,
            options,
            wrappedByWindowsShell: false,
        };
    }

    return {
        args: [
            "/d",
            "/s",
            "/c",
            buildWindowsBatchCommandLine(resolvedCommand, args),
        ],
        command: "cmd.exe",
        options: withWindowsVerbatimArguments(options),
        wrappedByWindowsShell: true,
    };
}

function withWindowsVerbatimArguments<
    TOptions extends CommandLaunchOptions | undefined,
>(options: TOptions): WindowsShellOptions<TOptions> {
    return {
        ...(options ?? {}),
        windowsVerbatimArguments: true,
    } as WindowsShellOptions<TOptions>;
}

function resolveWindowsBatchCommand(
    command: string,
    launchOptions: PrepareCommandLaunchOptions,
): string | null {
    const platform = launchOptions.platform ?? process.platform;
    if (platform !== "win32") {
        return null;
    }

    if (isWindowsBatchCommand(command)) {
        return command;
    }

    const resolvedCommand = resolveWindowsPathExtCommand(command, launchOptions);
    return resolvedCommand && isWindowsBatchCommand(resolvedCommand)
        ? resolvedCommand
        : null;
}

function resolveWindowsPathExtCommand(
    command: string,
    launchOptions: PrepareCommandLaunchOptions,
): string | null {
    const env = launchOptions.env ?? process.env;
    const pathEntries =
        launchOptions.pathEntries ??
        splitWindowsPathEntries(getWindowsEnvironmentValue(env, "PATH"));
    const extensions = getWindowsPathExtensions(
        getWindowsEnvironmentValue(env, "PATHEXT"),
    );
    const searchEntries = hasPathDirectory(command) ? [""] : pathEntries;

    for (const entry of searchEntries) {
        for (const extension of extensions) {
            if (path.win32.extname(command)) {
                continue;
            }
            const candidate = entry
                ? path.join(entry, `${command}${extension}`)
                : `${command}${extension}`;
            if (isFile(candidate)) {
                return candidate;
            }
        }
    }

    return null;
}

function hasPathDirectory(command: string): boolean {
    return (
        path.isAbsolute(command) ||
        path.win32.isAbsolute(command) ||
        command.includes("/") ||
        command.includes("\\")
    );
}

function splitWindowsPathEntries(value: string | undefined): string[] {
    return value?.split(";").filter(Boolean) ?? [];
}

function getWindowsPathExtensions(value: string | undefined): string[] {
    return (value ?? ".EXE;.CMD;.BAT;.COM")
        .split(";")
        .map((entry) => entry.trim())
        .filter(Boolean);
}

function getWindowsEnvironmentValue(
    env: NodeJS.ProcessEnv,
    name: string,
): string | undefined {
    return (
        env[name] ??
        Object.entries(env).find(
            ([key]) => key.toLowerCase() === name.toLowerCase(),
        )?.[1]
    );
}

function isFile(candidatePath: string): boolean {
    try {
        return fs.statSync(candidatePath).isFile();
    } catch {
        return false;
    }
}

function buildWindowsBatchCommandLine(
    command: string,
    args: readonly string[],
): string {
    const innerCommandLine = [command, ...args]
        .map(quoteWindowsCmdArgument)
        .join(" ");

    return `"${innerCommandLine}"`;
}

function quoteWindowsCmdArgument(value: string): string {
    const escapedValue = value
        .replace(/"/g, '\\"')
        .replace(/([&|<>()^%!])/g, "^$1");

    return `"${escapedValue}"`;
}
