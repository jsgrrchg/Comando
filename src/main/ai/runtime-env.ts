import fs from "node:fs";
import path from "node:path";

const DEFAULT_PATH_ENTRIES = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] as const;
const MACOS_COMMON_PATH_ENTRIES = [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
] as const;
const USER_COMMON_PATH_ENTRIES = [
    "bin",
    ".grok/bin",
    ".opencode/bin",
    ".local/bin",
    ".npm-global/bin",
    ".yarn/bin",
    ".bun/bin",
    ".deno/bin",
    ".cargo/bin",
    "Library/pnpm",
    ".volta/bin",
    ".asdf/shims",
    ".local/share/mise/shims",
] as const;

export function buildRuntimeSpawnEnv(
    baseEnv: NodeJS.ProcessEnv,
    executable: string,
): NodeJS.ProcessEnv {
    const nextEnv = { ...baseEnv };
    const pathEntries = buildRuntimePathEntries(
        baseEnv.PATH,
        executable,
        baseEnv,
    );

    if (pathEntries.length > 0) {
        nextEnv.PATH = pathEntries.join(path.delimiter);
    }

    return nextEnv;
}

export function buildRuntimePathEntries(
    currentPath: string | undefined,
    executable: string,
    env: NodeJS.ProcessEnv = process.env,
): string[] {
    const entries = [
        ...resolveExecutableDir(executable),
        ...(process.platform === "darwin" ? MACOS_COMMON_PATH_ENTRIES : []),
        ...resolveUserPathEntries(env),
        ...DEFAULT_PATH_ENTRIES,
        ...(currentPath?.split(path.delimiter).filter(Boolean) ?? []),
    ];

    return [...new Set(entries)];
}

export function resolveExecutableFromRuntimePath(
    command: string,
    env: NodeJS.ProcessEnv = process.env,
): string | null {
    const inheritedPathResolved = resolveExecutableInEntries(
        command,
        splitPathEntries(env.PATH),
        env,
    );
    if (inheritedPathResolved) {
        return inheritedPathResolved;
    }

    const fallbackResolved = resolveExecutableInEntries(
        command,
        buildRuntimePathEntries(undefined, command, env),
        env,
    );
    if (fallbackResolved) {
        return fallbackResolved;
    }

    return null;
}

function resolveExecutableInEntries(
    command: string,
    pathEntries: readonly string[],
    env: NodeJS.ProcessEnv,
): string | null {
    const pathExtEntries =
        process.platform === "win32"
            ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
                  .split(";")
                  .filter(Boolean)
            : [""];

    for (const entry of pathEntries) {
        for (const extension of pathExtEntries) {
            const candidate = path.join(
                entry,
                process.platform === "win32" &&
                    !command.toLowerCase().endsWith(extension.toLowerCase())
                    ? `${command}${extension}`
                    : command,
            );
            if (isExecutableFile(candidate)) {
                return candidate;
            }
        }
    }

    return null;
}

function splitPathEntries(value: string | undefined): string[] {
    return value?.split(path.delimiter).filter(Boolean) ?? [];
}

function resolveExecutableDir(executable: string): string[] {
    if (!path.isAbsolute(executable)) {
        return [];
    }

    return [path.dirname(executable)];
}

function resolveUserPathEntries(env: NodeJS.ProcessEnv): string[] {
    const homeDir = env.HOME?.trim() || env.USERPROFILE?.trim() || "";
    if (!homeDir) {
        return [];
    }

    return USER_COMMON_PATH_ENTRIES.map((entry) => path.join(homeDir, entry));
}

function isExecutableFile(candidate: string): boolean {
    try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return fs.statSync(candidate).isFile();
    } catch {
        return false;
    }
}
