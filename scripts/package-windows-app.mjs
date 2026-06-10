import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
    claudeVendorDir,
    codexBundledBinary,
    copyExecutable,
    copyTree,
    embeddedNodeBin,
    ensureDir,
    isExecutableFile,
    isFile,
    prepareCommandForSpawnSync,
    relativeToRepo,
    repoRoot,
    resolveFromPath,
    resetDir,
} from "./ai/_shared.mjs";

const buildRoot = path.join(repoRoot, "build");
const packageResourcesRoot = path.join(buildRoot, "package-resources");
const packagedAiRoot = path.join(packageResourcesRoot, "ai");
const packagedCodexBinary = path.join(packagedAiRoot, "binaries", "codex-acp.exe");
const packagedClaudeRoot = path.join(
    packagedAiRoot,
    "embedded",
    "claude-agent-acp",
);
const packagedNodeBinary = path.join(
    packagedAiRoot,
    "embedded",
    "node",
    "bin",
    "node.exe",
);
const appAiRoot = path.join(repoRoot, "resources", "ai");
const bundledClaudeRoot = path.join(appAiRoot, "embedded", "claude-agent-acp");
const windowsIconPath = path.join(repoRoot, "resources", "icons", "windows.ico");
const electronBuilderCli = path.join(
    repoRoot,
    "node_modules",
    "electron-builder",
    "cli.js",
);
const electronBuilderInstallAppDepsCli = path.join(
    repoRoot,
    "node_modules",
    "electron-builder",
    "install-app-deps.js",
);
const nodeBinDir = path.dirname(process.execPath);
const pnpmCommand = resolveRequiredCommand("pnpm.cmd");

if (process.platform !== "win32") {
    throw new Error("The Windows packaging workflow can only run on Windows.");
}

main();

function main() {
    const electronBuilderArgs = resolveElectronBuilderArgs(process.argv.slice(2));
    const targetArch = resolveTargetArch(electronBuilderArgs);
    const toolchainEnv = resolveWindowsBuildEnv();

    console.log("[package:win] Building Electron production bundles.");
    prepareWorkspace();
    run(pnpmCommand, ["run", "build"]);

    console.log(`[package:win] Rebuilding native modules for ${targetArch}.`);
    rebuildNativeModules(targetArch, toolchainEnv);

    console.log(`[package:win] Staging Windows AI payload for ${targetArch}.`);
    stageWindowsAiPayload(targetArch);
    verifyWindowsAiPayload();

    console.log(
        `[package:win] Packaging Windows app with ${electronBuilderArgs.join(" ")}.`,
    );
    packageWindowsApp(electronBuilderArgs, targetArch, toolchainEnv);
}

function packageWindowsApp(electronBuilderArgs, targetArch, toolchainEnv) {
    const unpackedAppDir = resolveUnpackedAppDir(targetArch);
    const dirArgs = withoutPublishArgs([
        ...electronBuilderArgs.filter((arg) => arg !== "--dir"),
        "--dir",
    ]);

    run(process.execPath, [electronBuilderCli, ...dirArgs], {
        env: toolchainEnv,
    });

    verifyPackagedNodePtyPayload(unpackedAppDir, targetArch);
    patchWindowsExecutableIcon(unpackedAppDir);

    if (electronBuilderArgs.includes("--dir")) {
        return;
    }

    run(
        process.execPath,
        [
            electronBuilderCli,
            ...electronBuilderArgs,
            "--config.win.target.target=nsis",
            `--config.win.target.arch=${targetArch}`,
            "--prepackaged",
            unpackedAppDir,
        ],
        {
            env: toolchainEnv,
        },
    );
}

function prepareWorkspace() {
    ensureDir(buildRoot);
    resetDir(packageResourcesRoot);
}

function resolveElectronBuilderArgs(rawArgs) {
    const hasArchFlag = rawArgs.some((arg) =>
        ["--x64", "--arm64", "--ia32", "--universal"].includes(arg),
    );
    const args = ["--win", ...rawArgs.filter((arg) => arg !== "--win")];

    if (hasArchFlag) {
        return args;
    }

    return [...args, process.arch === "arm64" ? "--arm64" : "--x64"];
}

function resolveTargetArch(electronBuilderArgs) {
    if (electronBuilderArgs.includes("--arm64")) {
        return "arm64";
    }

    if (electronBuilderArgs.includes("--ia32")) {
        return "ia32";
    }

    return "x64";
}

function resolveUnpackedAppDir(targetArch) {
    const dirName = targetArch === "x64"
        ? "win-unpacked"
        : `win-${targetArch}-unpacked`;

    return path.join(repoRoot, "dist", dirName);
}

function withoutPublishArgs(args) {
    const result = [];

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--publish" || arg === "-p") {
            index += 1;
            continue;
        }

        if (arg.startsWith("--publish=") || arg.startsWith("-p=")) {
            continue;
        }

        result.push(arg);
    }

    return result;
}

function patchWindowsExecutableIcon(unpackedAppDir) {
    const executablePath = path.join(unpackedAppDir, "Comando.exe");
    const rceditPath = resolveBundledRcedit();

    if (!isExecutableFile(executablePath)) {
        throw new Error(
            `Missing packaged executable. Expected ${relativeToRepo(executablePath)}.`,
        );
    }

    if (!isFile(windowsIconPath)) {
        throw new Error(
            `Missing Windows icon. Expected ${relativeToRepo(windowsIconPath)}.`,
        );
    }

    console.log(
        `[package:win] Applying ${relativeToRepo(windowsIconPath)} to ${relativeToRepo(executablePath)}.`,
    );
    run(rceditPath, [executablePath, "--set-icon", windowsIconPath]);
}

function verifyPackagedNodePtyPayload(unpackedAppDir, targetArch) {
    const nodePtyArch = targetArch === "arm64" ? "arm64" : "x64";
    const nodePtyRoot = path.join(
        unpackedAppDir,
        "resources",
        "app.asar.unpacked",
        "node_modules",
        "node-pty",
        "prebuilds",
        `win32-${nodePtyArch}`,
    );
    const requiredFiles = [
        path.join(nodePtyRoot, "conpty.node"),
        path.join(nodePtyRoot, "pty.node"),
        path.join(nodePtyRoot, "conpty", "conpty.dll"),
        path.join(nodePtyRoot, "conpty", "OpenConsole.exe"),
        path.join(nodePtyRoot, "winpty-agent.exe"),
        path.join(nodePtyRoot, "winpty.dll"),
    ];

    for (const requiredFile of requiredFiles) {
        if (!isFile(requiredFile) && !isExecutableFile(requiredFile)) {
            throw new Error(
                `The packaged node-pty payload is incomplete: ${relativeToRepo(requiredFile)} is missing.`,
            );
        }
    }
}

function resolveBundledRcedit() {
    const candidates = findFiles(path.join(repoRoot, "node_modules"), "rcedit.exe");

    for (const candidate of candidates) {
        if (
            isExecutableFile(candidate) &&
            candidate.split(path.sep).includes("electron-winstaller")
        ) {
            return candidate;
        }
    }

    for (const candidate of candidates) {
        if (isExecutableFile(candidate)) {
            return candidate;
        }
    }

    throw new Error("Required rcedit.exe was not found in node_modules.");
}

function findFiles(root, fileName) {
    if (!fs.existsSync(root)) {
        return [];
    }

    const matches = [];
    const entries = fs.readdirSync(root, { withFileTypes: true });

    for (const entry of entries) {
        const entryPath = path.join(root, entry.name);

        if (entry.isFile() && entry.name === fileName) {
            matches.push(entryPath);
            continue;
        }

        if (entry.isDirectory()) {
            matches.push(...findFiles(entryPath, fileName));
        }
    }

    return matches;
}

function rebuildNativeModules(targetArch, extraEnv) {
    run(process.execPath, [
        electronBuilderInstallAppDepsCli,
        "--platform",
        "win32",
        "--arch",
        targetArch,
    ], {
        env: extraEnv,
    });
}

function resolveWindowsBuildEnv() {
    const pythonBinary = resolvePythonBinary();
    const extraEnv = {
        GYP_MSVS_VERSION: "2022",
    };

    if (pythonBinary) {
        extraEnv.PYTHON = pythonBinary;
        extraEnv.npm_config_python = pythonBinary;
        extraEnv.PATH = [
            path.dirname(pythonBinary),
            process.env.PATH ?? "",
        ]
            .filter(Boolean)
            .join(path.delimiter);
    }

    return extraEnv;
}

function stageWindowsAiPayload(targetArch) {
    stageCodexBinary(targetArch);
    stageEmbeddedNodeBinary(targetArch);
    stageClaudeRuntime(targetArch);
}

function resolveAiSourceRoot(targetArch) {
    const bundleRoot = path.join(repoRoot, "build", "windows-acp", `win-${targetArch}`, "ai");
    if (fs.existsSync(bundleRoot)) {
        return bundleRoot;
    }

    return appAiRoot;
}

function stageCodexBinary(targetArch) {
    const aiSourceRoot = resolveAiSourceRoot(targetArch);
    const sourceBinary = path.join(aiSourceRoot, "binaries", "codex-acp.exe");

    if (!isExecutableFile(sourceBinary)) {
        throw new Error(
            `Missing staged Codex ACP binary for ${targetArch}. Expected ${relativeToRepo(sourceBinary)}.`,
        );
    }

    copyExecutable(sourceBinary, packagedCodexBinary);
    console.log(
        `[package:win] Staged Codex ACP from ${relativeToRepo(sourceBinary)}.`,
    );
}

function stageEmbeddedNodeBinary(targetArch) {
    const aiSourceRoot = resolveAiSourceRoot(targetArch);
    const sourceNodeBinary = path.join(aiSourceRoot, "embedded", "node", "bin", "node.exe");

    if (!isExecutableFile(sourceNodeBinary)) {
        throw new Error(
            `Missing staged embedded Node for ${targetArch}. Expected ${relativeToRepo(sourceNodeBinary)}.`,
        );
    }

    copyExecutable(sourceNodeBinary, packagedNodeBinary);
    console.log(
        `[package:win] Staged embedded Node from ${relativeToRepo(sourceNodeBinary)}.`,
    );
}

function stageClaudeRuntime(targetArch) {
    const sourceRoot = resolveClaudeProjectRoot(targetArch);
    const filesToCopy = ["package.json", "LICENSE", "README.md"];

    console.log(
        `[package:win] Staging Claude ACP from ${relativeToRepo(sourceRoot)}.`,
    );

    resetDir(packagedClaudeRoot);
    copyTree(
        path.join(sourceRoot, "dist"),
        path.join(packagedClaudeRoot, "dist"),
    );
    copyTree(
        path.join(sourceRoot, "node_modules"),
        path.join(packagedClaudeRoot, "node_modules"),
        { dereference: true },
    );

    for (const fileName of filesToCopy) {
        const sourcePath = path.join(sourceRoot, fileName);
        if (!isFile(sourcePath)) {
            continue;
        }

        fs.copyFileSync(sourcePath, path.join(packagedClaudeRoot, fileName));
    }

    pruneClaudeCliArtifacts(path.join(packagedClaudeRoot, "node_modules"));
}

function resolveClaudeProjectRoot(targetArch) {
    const bundleRoot = resolveAiSourceRoot(targetArch);
    const bundledRoot = path.join(bundleRoot, "embedded", "claude-agent-acp");
    const candidates = [bundledRoot, bundledClaudeRoot, claudeVendorDir];

    for (const candidate of candidates) {
        if (
            isFile(path.join(candidate, "dist", "index.js")) &&
            fs.existsSync(path.join(candidate, "node_modules")) &&
            isFile(path.join(candidate, "package.json"))
        ) {
            return candidate;
        }
    }

    throw new Error(
        "No staged Claude ACP project was found. Run pnpm run stage:ai before packaging Windows.",
    );
}

function verifyWindowsAiPayload() {
    const requiredFiles = [
        packagedCodexBinary,
        packagedNodeBinary,
        path.join(packagedClaudeRoot, "dist", "index.js"),
        path.join(packagedClaudeRoot, "package.json"),
    ];

    for (const requiredFile of requiredFiles) {
        if (!isFile(requiredFile) && !isExecutableFile(requiredFile)) {
            throw new Error(
                `The packaged AI payload is incomplete: ${relativeToRepo(requiredFile)} is missing.`,
            );
        }
    }
}

function pruneClaudeCliArtifacts(nodeModulesRoot) {
    if (!fs.existsSync(nodeModulesRoot)) {
        return;
    }

    for (const entry of fs.readdirSync(nodeModulesRoot, {
        withFileTypes: true,
    })) {
        const entryPath = path.join(nodeModulesRoot, entry.name);

        if (!entry.isDirectory()) {
            continue;
        }

        if (entry.name === ".bin" || entry.name === "bin") {
            fs.rmSync(entryPath, { force: true, recursive: true });
            continue;
        }

        pruneClaudeCliArtifacts(entryPath);
    }
}

function resolveRequiredCommand(command) {
    const resolved = resolveFromPath(command);
    if (resolved) {
        return resolved;
    }

    throw new Error(`Required command was not found: ${command}`);
}

function run(command, args, options = {}) {
    const spawnOptions = {
        cwd: repoRoot,
        env: {
            ...process.env,
            PATH: [nodeBinDir, process.env.PATH ?? ""]
                .filter(Boolean)
                .join(path.delimiter),
            ...options.env,
        },
        stdio: "inherit",
        ...options,
    };
    const prepared = prepareCommandForSpawnSync(command, args, spawnOptions);
    const result = spawnSync(
        prepared.command,
        prepared.args,
        prepared.options,
    );

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}

function resolvePythonBinary() {
    const explicit = process.env.PYTHON?.trim();
    if (explicit && isExecutableFile(explicit)) {
        return explicit;
    }

    const pythonFromPath =
        resolveFromPath("python.exe") ??
        resolveFromPath("python") ??
        resolveFromPath("py.exe") ??
        resolveFromPath("py");
    if (pythonFromPath && isExecutableFile(pythonFromPath)) {
        return pythonFromPath;
    }

    const localPython = path.join(
        process.env.LOCALAPPDATA ?? "",
        "Programs",
        "Python",
        "Python312",
        "python.exe",
    );

    if (isExecutableFile(localPython)) {
        return localPython;
    }

    return null;
}
