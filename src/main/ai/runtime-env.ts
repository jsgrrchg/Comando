import path from "node:path";

const DEFAULT_PATH_ENTRIES = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] as const;
const MACOS_COMMON_PATH_ENTRIES = [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
] as const;

export function buildRuntimeSpawnEnv(
    baseEnv: NodeJS.ProcessEnv,
    executable: string,
): NodeJS.ProcessEnv {
    const nextEnv = { ...baseEnv };
    const pathEntries = buildRuntimePathEntries(baseEnv.PATH, executable);

    if (pathEntries.length > 0) {
        nextEnv.PATH = pathEntries.join(path.delimiter);
    }

    return nextEnv;
}

export function buildRuntimePathEntries(
    currentPath: string | undefined,
    executable: string,
): string[] {
    const entries = [
        ...resolveExecutableDir(executable),
        ...(process.platform === "darwin" ? MACOS_COMMON_PATH_ENTRIES : []),
        ...DEFAULT_PATH_ENTRIES,
        ...(currentPath?.split(path.delimiter).filter(Boolean) ?? []),
    ];

    return [...new Set(entries)];
}

function resolveExecutableDir(executable: string): string[] {
    if (!path.isAbsolute(executable)) {
        return [];
    }

    return [path.dirname(executable)];
}
