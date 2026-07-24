import fs from "node:fs";
import path from "node:path";

import type {
    AiRuntimeStatus,
    CustomAcpLaunchSpec,
    CustomAcpRuntimeDefinition,
    CustomAcpRuntimeId,
} from "@shared/ipc";

import type { ResolvedAcpRuntime } from "./contracts";
import {
    buildRuntimePathEntries,
    resolveExecutableFromControlledRuntimePath,
} from "./runtime-env";

const SAFE_PLATFORM_ENV_KEYS = [
    "APPDATA",
    "HOME",
    "LANG",
    "LC_ALL",
    "LOCALAPPDATA",
    "SystemRoot",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
] as const;

export function resolveCustomAcpRuntime(
    definition: CustomAcpRuntimeDefinition,
    baseEnv: NodeJS.ProcessEnv = process.env,
): ResolvedAcpRuntime {
    const executable = resolveCustomExecutable(definition.command, baseEnv);
    if (!executable) {
        return {
            args: definition.args,
            command: definition.command,
            env: {},
            executable: definition.command,
            status: createCustomAcpRuntimeStatus(
                definition.id,
                "missing",
                definition.command,
                `Custom ACP executable was not found: ${definition.command}`,
            ),
        };
    }
    if (!isExecutableFile(executable)) {
        return {
            args: definition.args,
            command: definition.command,
            env: {},
            executable,
            status: createCustomAcpRuntimeStatus(
                definition.id,
                "error",
                definition.command,
                `Custom ACP executable is not executable: ${definition.command}`,
            ),
        };
    }

    const env = buildIsolatedCustomAcpEnv(
        baseEnv,
        executable,
        definition.env,
    );
    const customAcpLaunch: CustomAcpLaunchSpec = {
        args: [...definition.args],
        authMode: "external",
        command: definition.command,
        configuredEnv: { ...definition.env },
        displayName: definition.displayName,
        env,
        executable,
        launchFingerprint: definition.launchFingerprint,
        productProfile: "conservative",
        protocolVersion: "acp-current14",
        revision: definition.revision,
        runtimeId: definition.id,
        state: "ready",
    };

    return {
        args: customAcpLaunch.args,
        command: definition.command,
        customAcpLaunch,
        env,
        executable,
        status: createCustomAcpRuntimeStatus(
            definition.id,
            "ready",
            definition.command,
            null,
        ),
    };
}

export function createMissingCustomAcpRuntimeStatus(
    runtimeId: CustomAcpRuntimeId,
): AiRuntimeStatus {
    return createCustomAcpRuntimeStatus(
        runtimeId,
        "missing",
        null,
        "This custom ACP runtime definition is no longer available.",
    );
}

export function buildIsolatedCustomAcpEnv(
    baseEnv: NodeJS.ProcessEnv,
    executable: string,
    configuredEnv: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
    const env: Record<string, string> = {};
    for (const key of SAFE_PLATFORM_ENV_KEYS) {
        const value = baseEnv[key];
        if (typeof value === "string" && value.length > 0) {
            env[key] = value;
        }
    }
    if (process.platform === "win32" && baseEnv.PATHEXT) {
        env.PATHEXT = baseEnv.PATHEXT;
    }

    // Custom launches receive a deterministic search path instead of the full
    // Electron environment, which may contain provider credentials.
    env.PATH = buildRuntimePathEntries(
        undefined,
        executable,
        baseEnv,
    ).join(path.delimiter);
    for (const [key, value] of Object.entries(configuredEnv)) {
        env[key] = value;
    }
    return env;
}

function resolveCustomExecutable(
    command: string,
    env: NodeJS.ProcessEnv,
): string | null {
    if (
        path.isAbsolute(command) ||
        command.includes("/") ||
        command.includes("\\")
    ) {
        return path.resolve(command);
    }
    return resolveExecutableFromControlledRuntimePath(command, env);
}

function isExecutableFile(candidate: string): boolean {
    try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return fs.statSync(candidate).isFile();
    } catch {
        return false;
    }
}

function createCustomAcpRuntimeStatus(
    runtimeId: CustomAcpRuntimeId,
    state: AiRuntimeStatus["state"],
    command: string | null,
    message: string | null,
): AiRuntimeStatus {
    return {
        authCredentialSource: "external-runtime",
        authCredentialSourceLabel: "Authentication managed by the runtime",
        authMethod: "external",
        authMethods: [],
        authReady: true,
        checkedAt: new Date().toISOString(),
        command,
        hasCustomBinaryPath: true,
        hasGatewayConfig: false,
        hasGatewayUrl: false,
        message,
        onboardingRequired: state !== "ready",
        runtimeId,
        source: "settings",
        state,
    };
}
