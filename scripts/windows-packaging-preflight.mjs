import fs from "node:fs";
import path from "node:path";

const SUPPORTED_TARGET_ARCHES = Object.freeze(["x64", "arm64"]);

export function resolveWindowsPackagingPreflight({
    env = process.env,
    isDirectory = defaultIsDirectory,
    isExecutableFile = defaultIsExecutableFile,
    isFile = defaultIsFile,
    nodeBinDir = path.dirname(process.execPath),
    platform = process.platform,
    relativePath = defaultRelativePath,
    repoRoot,
    targetArch,
}) {
    if (platform !== "win32") {
        throw new Error("The Windows packaging workflow can only run on Windows.");
    }

    if (!SUPPORTED_TARGET_ARCHES.includes(targetArch)) {
        throw new Error(
            `Unsupported Windows package architecture: ${targetArch}. Expected one of ${SUPPORTED_TARGET_ARCHES.join(", ")}.`,
        );
    }

    const resolveCommand = (command) =>
        resolveCommandFromPath(command, {
            env,
            extraPathEntries: [nodeBinDir],
            isExecutableFile,
            platform,
        });

    const paths = resolveWindowsPackagingPaths(repoRoot);
    const pnpmCommand = requireCommand("pnpm.cmd", resolveCommand);
    const powerShellCommand =
        resolveCommand("pwsh.exe") ??
        resolveCommand("pwsh") ??
        resolveCommand("powershell.exe") ??
        resolveCommand("powershell");
    if (!powerShellCommand) {
        throw new Error(
            "Required PowerShell was not found. Install PowerShell or make powershell.exe available on PATH before packaging Windows.",
        );
    }

    assertFile(paths.electronBuilderCli, {
        label: "electron-builder CLI",
        relativePath,
        suggestion: "Run pnpm install --frozen-lockfile before packaging Windows.",
        isFile,
    });
    assertFile(paths.electronBuilderInstallAppDepsCli, {
        label: "electron-builder install-app-deps CLI",
        relativePath,
        suggestion: "Run pnpm install --frozen-lockfile before packaging Windows.",
        isFile,
    });
    assertFile(paths.windowsIconPath, {
        label: "Windows icon",
        relativePath,
        suggestion: "Run pnpm run icons:build before packaging Windows.",
        isFile,
    });

    const pythonBinary = resolveRequiredPythonBinary({
        env,
        isExecutableFile,
        resolveCommand,
    });
    const visualStudioToolchain = resolveRequiredVisualStudioToolchain({
        env,
        isExecutableFile,
        isFile,
        resolveCommand,
    });
    const rceditPath = resolveRequiredRcedit({
        env,
        isExecutableFile,
        isFile,
        relativePath,
        repoRoot,
    });
    const aiPayload = resolveRequiredWindowsAiPayload({
        isDirectory,
        isExecutableFile,
        isFile,
        relativePath,
        repoRoot,
        targetArch,
    });

    return {
        aiPayload,
        electronBuilderCli: paths.electronBuilderCli,
        electronBuilderInstallAppDepsCli: paths.electronBuilderInstallAppDepsCli,
        powerShellCommand,
        pnpmCommand,
        rceditPath,
        toolchainEnv: createWindowsBuildEnv({
            basePath: env.PATH,
            pathDelimiter: platform === "win32" ? ";" : path.delimiter,
            pythonBinary,
        }),
        visualStudioToolchain,
        windowsIconPath: paths.windowsIconPath,
    };
}

export function resolveWindowsPackagingPaths(repoRoot) {
    return {
        electronBuilderCli: path.join(
            repoRoot,
            "node_modules",
            "electron-builder",
            "cli.js",
        ),
        electronBuilderInstallAppDepsCli: path.join(
            repoRoot,
            "node_modules",
            "electron-builder",
            "install-app-deps.js",
        ),
        windowsIconPath: path.join(repoRoot, "resources", "icons", "windows.ico"),
    };
}

export function resolveRequiredRcedit({
    env = process.env,
    isExecutableFile = defaultIsExecutableFile,
    isFile = defaultIsFile,
    relativePath = defaultRelativePath,
    repoRoot,
}) {
    const explicitPath = env.ELECTRON_BUILDER_RCEDIT_PATH?.trim();
    if (explicitPath) {
        if (isExecutableFile(explicitPath)) {
            return explicitPath;
        }

        throw new Error(
            `ELECTRON_BUILDER_RCEDIT_PATH points to a missing or non-executable file: ${explicitPath}.`,
        );
    }

    const directDependencyPath = path.join(
        repoRoot,
        "node_modules",
        "rcedit",
        "bin",
        "rcedit.exe",
    );
    if (isExecutableFile(directDependencyPath) || isFile(directDependencyPath)) {
        return directDependencyPath;
    }

    throw new Error(
        `Required rcedit.exe was not found at ${relativePath(directDependencyPath)}. Run pnpm install --frozen-lockfile or set ELECTRON_BUILDER_RCEDIT_PATH.`,
    );
}

export function resolveCommandFromPath(
    command,
    {
        env = process.env,
        extraPathEntries = [],
        isExecutableFile = defaultIsExecutableFile,
        platform = process.platform,
    } = {},
) {
    const pathDelimiter = platform === "win32" ? ";" : path.delimiter;
    const pathEntries = [
        ...extraPathEntries,
        ...(env.PATH ?? "").split(pathDelimiter),
    ].filter(Boolean);
    const pathExtEntries =
        platform === "win32"
            ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
            : [""];

    for (const entry of pathEntries) {
        for (const extension of pathExtEntries) {
            const candidate = path.join(
                entry,
                platform === "win32" &&
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

function resolveRequiredPythonBinary({ env, isExecutableFile, resolveCommand }) {
    const explicit = env.PYTHON?.trim();
    if (explicit) {
        if (isExecutableFile(explicit)) {
            return explicit;
        }

        throw new Error(
            `PYTHON points to a missing or non-executable file: ${explicit}.`,
        );
    }

    const pythonBinary =
        resolveCommand("python.exe") ??
        resolveCommand("python") ??
        resolveCommand("py.exe") ??
        resolveCommand("py");

    if (pythonBinary) {
        return pythonBinary;
    }

    throw new Error(
        "Required Python was not found. Install Python or set PYTHON before packaging Windows native modules.",
    );
}

function resolveRequiredVisualStudioToolchain({
    env,
    isExecutableFile,
    isFile,
    resolveCommand,
}) {
    for (const [name, value] of [
        ["VCINSTALLDIR", env.VCINSTALLDIR],
        ["VSINSTALLDIR", env.VSINSTALLDIR],
        ["VisualStudioVersion", env.VisualStudioVersion],
    ]) {
        if (value?.trim()) {
            return { source: name, value };
        }
    }

    const vswhereCandidates = [
        resolveCommand("vswhere.exe"),
        env["ProgramFiles(x86)"]
            ? path.join(
                  env["ProgramFiles(x86)"],
                  "Microsoft Visual Studio",
                  "Installer",
                  "vswhere.exe",
              )
            : null,
        env.ProgramFiles
            ? path.join(
                  env.ProgramFiles,
                  "Microsoft Visual Studio",
                  "Installer",
                  "vswhere.exe",
              )
            : null,
    ].filter(Boolean);

    for (const candidate of vswhereCandidates) {
        if (isExecutableFile(candidate) || isFile(candidate)) {
            return { source: "vswhere.exe", value: candidate };
        }
    }

    throw new Error(
        "Required Visual Studio Build Tools were not detected. Install VS Build Tools 2022 with the C++ workload before packaging Windows native modules.",
    );
}

function resolveRequiredWindowsAiPayload({
    isDirectory,
    isExecutableFile,
    isFile,
    relativePath,
    repoRoot,
    targetArch,
}) {
    const sourceRoot = resolveWindowsAiSourceRoot({
        isDirectory,
        repoRoot,
        targetArch,
    });
    const claudeRoot = path.join(
        sourceRoot,
        "embedded",
        "claude-agent-acp",
    );
    const requiredFiles = [
        path.join(sourceRoot, "binaries", "codex-acp.exe"),
        path.join(sourceRoot, "embedded", "node", "bin", "node.exe"),
        path.join(claudeRoot, "dist", "index.js"),
        path.join(claudeRoot, "package.json"),
    ];

    for (const filePath of requiredFiles) {
        if (!isFile(filePath) && !isExecutableFile(filePath)) {
            throw new Error(
                `Missing Windows ACP payload for ${targetArch}: ${relativePath(filePath)}. Run pnpm run build:windows-acp:${targetArch} before packaging Windows.`,
            );
        }
    }

    const nodeModulesPath = path.join(claudeRoot, "node_modules");
    if (!isDirectory(nodeModulesPath)) {
        throw new Error(
            `Missing Windows ACP payload for ${targetArch}: ${relativePath(nodeModulesPath)}. Run pnpm run build:windows-acp:${targetArch} before packaging Windows.`,
        );
    }

    return {
        claudeRoot,
        codexBinary: requiredFiles[0],
        nodeBinary: requiredFiles[1],
        sourceRoot,
    };
}

function resolveWindowsAiSourceRoot({ isDirectory, repoRoot, targetArch }) {
    const bundledPayloadRoot = path.join(
        repoRoot,
        "build",
        "windows-acp",
        `win-${targetArch}`,
        "ai",
    );
    if (isDirectory(bundledPayloadRoot)) {
        return bundledPayloadRoot;
    }

    return path.join(repoRoot, "resources", "ai");
}

function requireCommand(command, resolveCommand) {
    const resolved = resolveCommand(command);
    if (resolved) {
        return resolved;
    }

    throw new Error(
        `Required command was not found: ${command}. Run pnpm install --frozen-lockfile and make sure Node's bin directory is on PATH.`,
    );
}

function assertFile(filePath, { isFile, label, relativePath, suggestion }) {
    if (isFile(filePath)) {
        return;
    }

    throw new Error(
        `Missing ${label}: ${relativePath(filePath)}. ${suggestion}`,
    );
}

function createWindowsBuildEnv({ basePath, pathDelimiter, pythonBinary }) {
    return {
        GYP_MSVS_VERSION: "2022",
        PATH: [path.dirname(pythonBinary), basePath ?? ""]
            .filter(Boolean)
            .join(pathDelimiter),
        PYTHON: pythonBinary,
        npm_config_python: pythonBinary,
    };
}

function defaultIsDirectory(candidatePath) {
    try {
        return fs.statSync(candidatePath).isDirectory();
    } catch {
        return false;
    }
}

function defaultIsExecutableFile(candidatePath) {
    try {
        fs.accessSync(candidatePath, fs.constants.X_OK);
        return fs.statSync(candidatePath).isFile();
    } catch {
        return false;
    }
}

function defaultIsFile(candidatePath) {
    try {
        return fs.statSync(candidatePath).isFile();
    } catch {
        return false;
    }
}

function defaultRelativePath(filePath) {
    return filePath;
}
