import path from "node:path";
import type {
    ExecFileOptions,
    SpawnOptions,
} from "node:child_process";

type CommandLaunchOptions = SpawnOptions | ExecFileOptions;

export interface PrepareCommandLaunchOptions {
    readonly platform?: NodeJS.Platform;
}

export interface PreparedCommandLaunch<
    TOptions extends CommandLaunchOptions | undefined =
        | CommandLaunchOptions
        | undefined,
> {
    readonly command: string;
    readonly args: string[];
    readonly options: TOptions;
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
    if (platform !== "win32" || !isWindowsBatchCommand(command)) {
        return {
            args: [...args],
            command,
            options,
            wrappedByWindowsShell: false,
        };
    }

    return {
        args: ["/d", "/s", "/c", buildWindowsBatchCommandLine(command, args)],
        command: "cmd.exe",
        options,
        wrappedByWindowsShell: true,
    };
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
