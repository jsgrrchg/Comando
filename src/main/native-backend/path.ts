import fs from "node:fs";
import path from "node:path";

export const NATIVE_BACKEND_ENABLED_ENV = "COMANDO_NATIVE_BACKEND";
export const NATIVE_BACKEND_PATH_ENV = "COMANDO_NATIVE_BACKEND_PATH";
export const NATIVE_BACKEND_STRICT_ENV = "COMANDO_NATIVE_BACKEND_STRICT";
const NATIVE_TERMINAL_ENABLED_ENV = "COMANDO_NATIVE_TERMINAL";

export type NativeBackendPathSource =
    | "override"
    | "dev-debug"
    | "dev-release"
    | "packaged"
    | "missing";

export type NativeBackendPathResolution = {
    readonly attemptedPaths: readonly string[];
    readonly binaryPath: string | null;
    readonly source: NativeBackendPathSource;
};

export type NativeBackendPathOptions = {
    readonly arch?: NodeJS.Architecture;
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly exists?: (candidatePath: string) => boolean;
    readonly isPackaged?: boolean;
    readonly platform?: NodeJS.Platform;
    readonly resourcesPath?: string;
};

const BASE_EXECUTABLE_NAME = "comando-native-backend";

export function isNativeBackendEnabled(
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    return (
        env[NATIVE_BACKEND_ENABLED_ENV] === "1" ||
        env[NATIVE_TERMINAL_ENABLED_ENV] === "1"
    );
}

export function isNativeBackendStrict(
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    return env[NATIVE_BACKEND_STRICT_ENV] === "1";
}

export function resolveNativeBackendPath(
    options: NativeBackendPathOptions = {},
): NativeBackendPathResolution {
    const env = options.env ?? process.env;
    const overridePath = env[NATIVE_BACKEND_PATH_ENV]?.trim();
    if (overridePath) {
        return {
            attemptedPaths: [overridePath],
            binaryPath: overridePath,
            source: "override",
        };
    }

    const exists = options.exists ?? fs.existsSync;
    const cwd = options.cwd ?? process.cwd();
    const platform = options.platform ?? process.platform;
    const arch = options.arch ?? process.arch;
    const attemptedPaths = [
        ...devCandidatePaths(cwd),
        ...packagedCandidatePaths({
            arch,
            platform,
            resourcesPath: options.resourcesPath ?? process.resourcesPath,
        }),
    ];

    for (const candidatePath of attemptedPaths) {
        if (!exists(candidatePath)) {
            continue;
        }

        return {
            attemptedPaths,
            binaryPath: candidatePath,
            source: candidatePath.includes(`${path.sep}target${path.sep}debug${path.sep}`)
                ? "dev-debug"
                : candidatePath.includes(`${path.sep}target${path.sep}release${path.sep}`)
                  ? "dev-release"
                  : "packaged",
        };
    }

    return {
        attemptedPaths,
        binaryPath: null,
        source: "missing",
    };
}

export function getNativeBackendExecutableName(
    platform: NodeJS.Platform = process.platform,
): string {
    return platform === "win32"
        ? `${BASE_EXECUTABLE_NAME}.exe`
        : BASE_EXECUTABLE_NAME;
}

function devCandidatePaths(cwd: string): readonly string[] {
    return [
        path.join(cwd, "target", "debug", BASE_EXECUTABLE_NAME),
        path.join(cwd, "target", "debug", `${BASE_EXECUTABLE_NAME}.exe`),
        path.join(cwd, "target", "release", BASE_EXECUTABLE_NAME),
        path.join(cwd, "target", "release", `${BASE_EXECUTABLE_NAME}.exe`),
    ];
}

function packagedCandidatePaths(input: {
    readonly arch: NodeJS.Architecture;
    readonly platform: NodeJS.Platform;
    readonly resourcesPath: string;
}): readonly string[] {
    return [
        path.join(
            input.resourcesPath,
            "native",
            input.platform,
            input.arch,
            getNativeBackendExecutableName(input.platform),
        ),
    ];
}
