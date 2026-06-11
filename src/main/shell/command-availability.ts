import fs from "node:fs";
import path from "node:path";

import type {
    CheckCommandAvailabilityInput,
    CheckCommandAvailabilityResult,
} from "@shared/ipc";

import { buildRuntimePathEntries } from "@main/ai/runtime-env";
import { debugBenignError } from "@main/observability/logging";

const ALLOWED_COMMANDS = new Set(["claude", "pwsh"]);
const SAFE_COMMAND_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const DEFAULT_WINDOWS_PATHEXT = ".EXE;.CMD;.BAT;.COM";

interface CheckCommandAvailabilityOptions {
    readonly env?: NodeJS.ProcessEnv;
    readonly pathEntries?: readonly string[];
    readonly platform?: NodeJS.Platform;
}

export function checkCommandAvailability(
    input: CheckCommandAvailabilityInput,
    options: CheckCommandAvailabilityOptions = {},
): CheckCommandAvailabilityResult {
    const name = normalizeAllowedCommandName(input?.name);
    if (!name) {
        return createMissingResult();
    }

    try {
        const env = options.env ?? process.env;
        const platform = options.platform ?? process.platform;
        const resolvedPath = resolveCommandFromPath(
            name,
            env,
            platform,
            options.pathEntries,
        );

        return {
            found: resolvedPath !== null,
            path: resolvedPath,
        };
    } catch (error) {
        debugBenignError("shell.commandAvailability", error);
        return createMissingResult();
    }
}

function normalizeAllowedCommandName(name: unknown): string | null {
    if (typeof name !== "string") {
        return null;
    }

    const normalized = name.trim();
    if (
        !SAFE_COMMAND_NAME_PATTERN.test(normalized) ||
        !ALLOWED_COMMANDS.has(normalized)
    ) {
        return null;
    }

    return normalized;
}

function resolveCommandFromPath(
    command: string,
    env: NodeJS.ProcessEnv,
    platform: NodeJS.Platform,
    inputPathEntries?: readonly string[],
): string | null {
    const pathEntries =
        inputPathEntries ?? buildRuntimePathEntries(env.PATH, command);
    const pathextEntries =
        platform === "win32" ? getWindowsPathExtensions(env.PATHEXT) : [""];

    for (const entry of pathEntries) {
        for (const ext of pathextEntries) {
            const candidate = path.join(
                entry,
                platform === "win32" &&
                    !command.toLowerCase().endsWith(ext.toLowerCase())
                    ? `${command}${ext}`
                    : command,
            );
            if (isExecutableFile(candidate)) {
                return path.resolve(candidate);
            }
        }
    }

    return null;
}

function getWindowsPathExtensions(value: string | undefined): string[] {
    return (value ?? DEFAULT_WINDOWS_PATHEXT)
        .split(";")
        .map((entry) => entry.trim())
        .filter(Boolean);
}

function isExecutableFile(candidatePath: string): boolean {
    try {
        fs.accessSync(candidatePath, fs.constants.X_OK);
        return fs.statSync(candidatePath).isFile();
    } catch (error) {
        debugBenignError("shell.commandAvailability.isExecutableFile", error);
        return false;
    }
}

function createMissingResult(): CheckCommandAvailabilityResult {
    return {
        found: false,
        path: null,
    };
}
