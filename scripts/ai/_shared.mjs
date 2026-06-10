import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));

export const repoRoot = path.resolve(scriptDir, "../..");
export const isWindows = process.platform === "win32";
export const codexBinaryName = isWindows ? "codex-acp.exe" : "codex-acp";
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
export const codexTargetDebugBinary = path.join(
    codexTargetDir,
    "debug",
    codexBinaryName,
);
export const codexLegacyVendorTargetDir = path.join(codexVendorDir, "target");
export const codexLegacyVendorReleaseBinary = path.join(
    codexLegacyVendorTargetDir,
    "release",
    codexBinaryName,
);
export const codexLegacyVendorDebugBinary = path.join(
    codexLegacyVendorTargetDir,
    "debug",
    codexBinaryName,
);
export const codexBundledBinary = path.join(aiBinariesDir, codexBinaryName);
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

    return {
        args: [
            "/d",
            "/s",
            "/v:off",
            "/c",
            buildWindowsBatchCommandLine(command, args),
        ],
        command: launchOptions.comSpec ?? process.env.ComSpec ?? "cmd.exe",
        options: withWindowsVerbatimArguments(options),
    };
}

export function isWindowsBatchCommand(command) {
    const extension = path.win32.extname(command).toLowerCase();
    return extension === ".cmd" || extension === ".bat";
}

function buildWindowsBatchCommandLine(command, args) {
    const innerCommandLine = [command, ...args]
        .map(quoteWindowsCmdArgument)
        .join(" ");

    return `"${innerCommandLine}"`;
}

function quoteWindowsCmdArgument(value) {
    let escapedValue = "";
    let backslashCount = 0;

    for (const character of String(value)) {
        if (character === "\\") {
            backslashCount += 1;
            continue;
        }

        if (character === '"') {
            escapedValue += `${"\\".repeat(backslashCount * 2 + 1)}"`;
            backslashCount = 0;
            continue;
        }

        escapedValue += `${"\\".repeat(backslashCount)}${character}`;
        backslashCount = 0;
    }

    escapedValue += "\\".repeat(backslashCount * 2);

    return `"${escapedValue}"`;
}

function withWindowsVerbatimArguments(options) {
    return {
        ...options,
        windowsVerbatimArguments: true,
    };
}
