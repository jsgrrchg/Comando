import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));

export const repoRoot = path.resolve(scriptDir, "../..");
export const isWindows = process.platform === "win32";
export const codexBinaryName = isWindows ? "codex-acp.exe" : "codex-acp";
export const codexCodeModeHostBinaryName = isWindows
    ? "codex-code-mode-host.exe"
    : "codex-code-mode-host";
export const claudeBinaryName = isWindows
    ? "claude-agent-acp.exe"
    : "claude-agent-acp";
export const nodeBinaryName = isWindows ? "node.exe" : "node";
export const codexVendorDir = path.join(repoRoot, "vendor", "codex-acp");
export const claudeVendorDir = path.join(
    repoRoot,
    "vendor",
    "Claude-agent-acp-upstream",
);
export const aiResourcesDir = path.join(repoRoot, "resources", "ai");
export const aiBinariesDir = path.join(aiResourcesDir, "binaries");
export const aiEmbeddedDir = path.join(aiResourcesDir, "embedded");
export const codexEmbeddedDir = path.join(aiEmbeddedDir, "codex-acp");
export const codexTargetDir = path.join(codexEmbeddedDir, "target");
export const codexTargetReleaseBinary = path.join(
    codexTargetDir,
    "release",
    codexBinaryName,
);
export const codexTargetReleaseCodeModeHostBinary = path.join(
    codexTargetDir,
    "release",
    codexCodeModeHostBinaryName,
);
export const codexTargetDebugBinary = path.join(
    codexTargetDir,
    "debug",
    codexBinaryName,
);
export const codexTargetDebugCodeModeHostBinary = path.join(
    codexTargetDir,
    "debug",
    codexCodeModeHostBinaryName,
);
export const codexLegacyVendorTargetDir = path.join(codexVendorDir, "target");
export const codexLegacyVendorReleaseBinary = path.join(
    codexLegacyVendorTargetDir,
    "release",
    codexBinaryName,
);
export const codexLegacyVendorReleaseCodeModeHostBinary = path.join(
    codexLegacyVendorTargetDir,
    "release",
    codexCodeModeHostBinaryName,
);
export const codexLegacyVendorDebugBinary = path.join(
    codexLegacyVendorTargetDir,
    "debug",
    codexBinaryName,
);
export const codexLegacyVendorDebugCodeModeHostBinary = path.join(
    codexLegacyVendorTargetDir,
    "debug",
    codexCodeModeHostBinaryName,
);
export const codexBundledBinary = path.join(aiBinariesDir, codexBinaryName);
export const codexBundledCodeModeHostBinary = path.join(
    aiBinariesDir,
    codexCodeModeHostBinaryName,
);
export const claudeBundledBinary = path.join(aiBinariesDir, claudeBinaryName);
export const claudeEmbeddedRoot = path.join(aiEmbeddedDir, "claude-agent-acp");
export const claudeEmbeddedDist = path.join(claudeEmbeddedRoot, "dist");
export const claudeEmbeddedNodeModules = path.join(
    claudeEmbeddedRoot,
    "node_modules",
);
export const embeddedNodeRoot = path.join(aiEmbeddedDir, "node");
export const embeddedNodeBin = path.join(
    embeddedNodeRoot,
    "bin",
    nodeBinaryName,
);

export function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

export function isExecutableFile(candidatePath) {
    try {
        fs.accessSync(candidatePath, fs.constants.X_OK);
        return fs.statSync(candidatePath).isFile();
    } catch {
        return false;
    }
}

export function isFile(candidatePath) {
    try {
        return fs.statSync(candidatePath).isFile();
    } catch {
        return false;
    }
}

export function copyExecutable(fromPath, toPath) {
    ensureDir(path.dirname(toPath));

    if (path.resolve(fromPath) === path.resolve(toPath)) {
        if (!isWindows) {
            fs.chmodSync(toPath, 0o755);
        }
        return;
    }

    if (isWindows) {
        fs.copyFileSync(fromPath, toPath);
        return;
    }

    const temporaryPath = `${toPath}.${process.pid}.tmp`;
    try {
        fs.copyFileSync(fromPath, temporaryPath);
        fs.chmodSync(temporaryPath, 0o755);
        fs.renameSync(temporaryPath, toPath);
    } catch (error) {
        fs.rmSync(temporaryPath, { force: true });
        throw error;
    }
}

export function resetDir(dirPath) {
    fs.rmSync(dirPath, { force: true, recursive: true });
    ensureDir(dirPath);
}

export function copyTree(fromPath, toPath, options = {}) {
    ensureDir(path.dirname(toPath));
    fs.cpSync(fromPath, toPath, {
        dereference: false,
        errorOnExist: false,
        force: true,
        preserveTimestamps: true,
        recursive: true,
        ...options,
    });
}

export function relativeToRepo(targetPath) {
    return path.relative(repoRoot, targetPath) || ".";
}

export function resolveFromPath(command) {
    const pathEntries = (process.env.PATH ?? "")
        .split(path.delimiter)
        .filter(Boolean);
    const pathextEntries =
        process.platform === "win32"
            ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
                  .split(";")
                  .filter(Boolean)
            : [""];

    for (const entry of pathEntries) {
        for (const ext of pathextEntries) {
            const candidate = path.join(
                entry,
                process.platform === "win32" &&
                    !command.toLowerCase().endsWith(ext.toLowerCase())
                    ? `${command}${ext}`
                    : command,
            );

            if (isExecutableFile(candidate)) {
                return candidate;
            }
        }
    }

    return null;
}

export function prepareCommandForSpawnSync(
    command,
    args = [],
    options = {},
    launchOptions = {},
) {
    const platform = launchOptions.platform ?? process.platform;

    if (platform !== "win32" || !isWindowsBatchCommand(command)) {
        return {
            args: [...args],
            command,
            options,
        };
    }

    const cli = resolveKnownWindowsNodeCli(command, options, launchOptions);

    return {
        args: [cli.entrypointPath, ...args],
        command: cli.nodeCommand,
        options,
    };
}

export function spawnPreparedSync(command, args = [], options = {}, launchOptions = {}) {
    const platform = launchOptions.platform ?? process.platform;

    if (platform !== "win32" || !isWindowsBatchCommand(command)) {
        return spawnSync(command, args, options);
    }

    const prepared = prepareCommandForSpawnSync(command, args, options, {
        ...launchOptions,
        platform,
    });

    return spawnSync(prepared.command, prepared.args, prepared.options);
}

export function isWindowsBatchCommand(command) {
    const extension = path.win32.extname(command).toLowerCase();
    return extension === ".cmd" || extension === ".bat";
}

function resolveKnownWindowsNodeCli(command, options = {}, launchOptions = {}) {
    if (path.win32.isAbsolute(command)) {
        throw new Error(
            `Refusing to prepare an absolute Windows batch command: ${command}`,
        );
    }

    const commandName = command.toLowerCase();
    const commandPath =
        launchOptions.commandPath ??
        resolveFromPathForPlatform(command, {
            env: options.env,
            platform: "win32",
        });

    if (!commandPath) {
        throw new Error(
            `Required Windows batch command was not found on PATH: ${command}`,
        );
    }

    const entrypointPath = resolveKnownWindowsNodeCliEntrypoint(
        commandName,
        commandPath,
        launchOptions,
    );

    return {
        entrypointPath,
        nodeCommand: launchOptions.nodeCommand ?? process.execPath,
    };
}

function resolveKnownWindowsNodeCliEntrypoint(
    commandName,
    commandPath,
    launchOptions = {},
) {
    switch (commandName) {
        case "npm.cmd":
            return resolveExistingFile(
                [
                    launchOptions.npmCliPath,
                    path.win32.join(
                        path.win32.dirname(commandPath),
                        "node_modules",
                        "npm",
                        "bin",
                        "npm-cli.js",
                    ),
                ],
                "npm CLI",
            );
        case "pnpm.cmd":
            return resolveExistingFile(
                [
                    launchOptions.pnpmCliPath,
                    path.win32.join(
                        path.win32.dirname(commandPath),
                        "node_modules",
                        "pnpm",
                        "bin",
                        "pnpm.cjs",
                    ),
                    path.win32.join(
                        path.win32.dirname(commandPath),
                        "node_modules",
                        "pnpm",
                        "bin",
                        "pnpm.js",
                    ),
                    parseWindowsCmdNodeEntrypoint(commandPath),
                ],
                "pnpm CLI",
            );
        default:
            throw new Error(`Unsupported Windows batch command: ${commandName}`);
    }
}

function resolveFromPathForPlatform(command, { env = process.env, platform }) {
    const pathValue = env?.PATH ?? env?.Path ?? env?.path ?? "";
    const pathEntries = pathValue
        .split(platform === "win32" ? path.win32.delimiter : path.delimiter)
        .filter(Boolean);
    const pathextEntries =
        platform === "win32"
            ? (env?.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
                  .split(";")
                  .filter(Boolean)
            : [""];

    for (const entry of pathEntries) {
        for (const ext of pathextEntries) {
            const candidate = path.win32.join(
                entry,
                platform === "win32" &&
                    !command.toLowerCase().endsWith(ext.toLowerCase())
                    ? `${command}${ext}`
                    : command,
            );

            if (isFile(candidate)) {
                return candidate;
            }
        }
    }

    return null;
}

function resolveExistingFile(candidates, label) {
    const candidate = candidates
        .filter(Boolean)
        .find((filePath) => isFile(filePath));
    if (!candidate) {
        throw new Error(`Required ${label} entrypoint was not found.`);
    }
    return candidate;
}

function parseWindowsCmdNodeEntrypoint(commandPath) {
    if (!isFile(commandPath)) {
        return null;
    }

    const content = fs.readFileSync(commandPath, "utf8");
    const commandDir = path.win32.dirname(commandPath);
    const match = content.match(/"%dp0%\\([^"]+\.(?:cjs|js))"/iu);
    if (!match) {
        return null;
    }

    return path.win32.join(commandDir, match[1]);
}
