import fs from "node:fs";
import path from "node:path";

export const NATIVE_BACKEND_PATH_ENV = "COMANDO_NATIVE_BACKEND_PATH";

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

export function resolveNativeBackendPath(
    options: NativeBackendPathOptions = {},
): NativeBackendPathResolution {
    const env = options.env ?? process.env;
    const exists = options.exists ?? fs.existsSync;
    const overridePath = env[NATIVE_BACKEND_PATH_ENV]?.trim();
    if (overridePath) {
        const overrideExists = exists(overridePath);
        return {
            attemptedPaths: [overridePath],
            binaryPath: overrideExists ? overridePath : null,
            source: overrideExists ? "override" : "missing",
        };
    }

    const cwd = options.cwd ?? process.cwd();
    const platform = options.platform ?? process.platform;
    const arch = options.arch ?? process.arch;
    const devPaths = devCandidatePaths(cwd);
    const packagedPaths = packagedCandidatePaths({
        arch,
        platform,
        resourcesPath: options.resourcesPath ?? process.resourcesPath,
    });

    if (options.isPackaged === true) {
        for (const candidatePath of packagedPaths) {
            if (!exists(candidatePath)) {
                continue;
            }

            return {
                attemptedPaths: packagedPaths,
                binaryPath: candidatePath,
                source: "packaged",
            };
        }

        return {
            attemptedPaths: packagedPaths,
            binaryPath: null,
            source: "missing",
        };
    }

    for (const candidatePath of devPaths) {
        if (!exists(candidatePath)) {
            continue;
        }

        return {
            attemptedPaths: devPaths,
            binaryPath: candidatePath,
            source: candidatePath.includes(`${path.sep}target${path.sep}debug${path.sep}`)
                ? "dev-debug"
                : "dev-release",
        };
    }

    return {
        attemptedPaths: devPaths,
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
