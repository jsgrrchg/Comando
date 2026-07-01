import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
    buildRceditExecutableMetadataArgs,
    buildReadWindowsExecutableMetadataPowerShellArgs,
    createWindowsExecutableMetadataSpec,
    parseWindowsExecutableMetadataJson,
    shouldRequireWindowsExecutableSignature,
    verifyWindowsExecutableMetadataSnapshot,
} from "./windows-executable-metadata.mjs";
import {
    ensurePackagedWindowsUpdaterConfig,
    verifyPackagedWindowsUpdaterChannel,
    verifyWindowsReleaseArtifacts,
} from "./windows-release-metadata.mjs";
import { resolveWindowsPackagingPreflight } from "./windows-packaging-preflight.mjs";
import {
    claudeVendorDir,
    copyExecutable,
    copyTree,
    ensureDir,
    isExecutableFile,
    isFile,
    prepareCommandForSpawnSync,
    relativeToRepo,
    repoRoot,
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
const windowsAcpPayloadEnvKey = "COMANDO_WINDOWS_ACP_PAYLOAD_DIR";
const windowsIconPath = path.join(repoRoot, "resources", "icons", "windows.ico");
const packageJson = readJson(path.join(repoRoot, "package.json"));
const productName = packageJson.build?.productName ?? packageJson.name ?? "Comando";
const appVersion = packageJson.version;
const executableMetadata = createWindowsExecutableMetadataSpec({
    productName,
    version: appVersion,
});
const nodeBinDir = path.dirname(process.execPath);

if (process.platform !== "win32") {
    throw new Error("The Windows packaging workflow can only run on Windows.");
}

main();

function main() {
    const electronBuilderArgs = resolveElectronBuilderArgs(process.argv.slice(2));
    const targetArch = resolveTargetArch(electronBuilderArgs);
    const preflight = resolveWindowsPackagingPreflight({
        nodeBinDir,
        relativePath: relativeToRepo,
        repoRoot,
        targetArch,
    });

    console.log(`[package:win] Preflight passed for ${targetArch}.`);

    const preparedAiPayloadRoot = resolvePreparedWindowsAiPayloadRoot(targetArch);
    console.log("[package:win] Building Electron production bundles.");
    prepareWorkspace();
    run(preflight.pnpmCommand, [
        "run",
        preparedAiPayloadRoot ? "build:ci" : "build",
    ]);

    console.log(`[package:win] Staging Windows AI payload for ${targetArch}.`);
    stageWindowsAiPayload(targetArch);
    verifyWindowsAiPayload();
    stageWindowsNativeBackendPayload(targetArch, preflight);

    console.log(
        `[package:win] Packaging Windows app with ${electronBuilderArgs.join(" ")}.`,
    );
    packageWindowsApp(electronBuilderArgs, targetArch, preflight);
}

function packageWindowsApp(
    electronBuilderArgs,
    targetArch,
    preflight,
) {
    const unpackedAppDir = resolveUnpackedAppDir(targetArch);
    const dirArgs = withoutPublishArgs([
        ...electronBuilderArgs.filter((arg) => arg !== "--dir"),
        "--dir",
    ]);

    run(process.execPath, [preflight.electronBuilderCli, ...dirArgs]);

    const appUpdateConfigPath = path.join(
        unpackedAppDir,
        "resources",
        "app-update.yml",
    );
    if (
        ensurePackagedWindowsUpdaterConfig({
            appUpdateConfigPath,
            packageJson,
            targetArch,
        })
    ) {
        console.log(
            `[package:win] Wrote ${relativeToRepo(appUpdateConfigPath)} for ${targetArch}.`,
        );
    }
    verifyPackagedWindowsUpdaterChannel({
        appUpdateConfigPath,
        relativePath: relativeToRepo,
        targetArch,
    });
    setAndVerifyWindowsExecutableMetadata(unpackedAppDir, preflight);

    if (electronBuilderArgs.includes("--dir")) {
        return;
    }

    run(
        process.execPath,
        [
            preflight.electronBuilderCli,
            ...electronBuilderArgs,
            "--config.win.target.target=nsis",
            `--config.win.target.arch=${targetArch}`,
            "--prepackaged",
            unpackedAppDir,
        ],
        {
        env: process.env,
        },
    );

    const artifacts = verifyWindowsReleaseArtifacts({
        distDir: path.join(repoRoot, "dist"),
        productName,
        relativePath: relativeToRepo,
        targetArch,
        version: appVersion,
    });
    console.log(
        `[package:win] Verified ${relativeToRepo(artifacts.metadataPath)} for ${targetArch}.`,
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

function setAndVerifyWindowsExecutableMetadata(unpackedAppDir, preflight) {
    const executablePath = path.join(unpackedAppDir, "Comando.exe");

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
        `[package:win] Applying executable metadata to ${relativeToRepo(executablePath)}.`,
    );
    run(
        preflight.rceditPath,
        buildRceditExecutableMetadataArgs({
            executablePath,
            iconPath: windowsIconPath,
            metadata: executableMetadata,
        }),
    );

    const metadata = parseWindowsExecutableMetadataJson(
        runCaptured(
            preflight.powerShellCommand,
            buildReadWindowsExecutableMetadataPowerShellArgs(executablePath),
        ),
    );
    const requireSignature = shouldRequireWindowsExecutableSignature(process.env);
    verifyWindowsExecutableMetadataSnapshot({
        executablePath,
        expected: executableMetadata,
        metadata,
        relativePath: relativeToRepo,
        requireSignature,
    });
    console.log(
        requireSignature
            ? `[package:win] Verified executable metadata, icon, and signature for ${relativeToRepo(executablePath)}.`
            : `[package:win] Verified executable metadata and icon for ${relativeToRepo(executablePath)}.`,
    );
}

function stageWindowsAiPayload(targetArch) {
    stageCodexBinary(targetArch);
    stageEmbeddedNodeBinary(targetArch);
    stageClaudeRuntime(targetArch);
}

function stageWindowsNativeBackendPayload(targetArch, preflight) {
    console.log(
        `[package:win] Building and staging native backend sidecar for ${targetArch}.`,
    );
    run(preflight.pnpmCommand, ["run", "native:build"]);
    run(preflight.pnpmCommand, [
        "run",
        "native:stage",
        "--",
        "--platform",
        "win32",
        "--arch",
        targetArch,
    ]);
}

function resolveAiSourceRoot(targetArch) {
    return resolvePreparedWindowsAiPayloadRoot(targetArch) ?? appAiRoot;
}

function resolvePreparedWindowsAiPayloadRoot(targetArch) {
    const configuredRoot = process.env[windowsAcpPayloadEnvKey]?.trim();
    if (configuredRoot) {
        if (!fs.existsSync(configuredRoot)) {
            throw new Error(
                `${windowsAcpPayloadEnvKey} points to a missing Windows ACP payload: ${configuredRoot}.`,
            );
        }

        return path.resolve(configuredRoot);
    }

    const bundleRoot = path.join(
        repoRoot,
        "build",
        "windows-acp",
        `win-${targetArch}`,
        "ai",
    );
    if (fs.existsSync(bundleRoot)) {
        return bundleRoot;
    }

    return null;
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
    const sourceNodeBinary = path.join(
        aiSourceRoot,
        "embedded",
        "node",
        "bin",
        "node.exe",
    );

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

function runCaptured(command, args, options = {}) {
    const spawnOptions = {
        cwd: repoRoot,
        env: {
            ...process.env,
            PATH: [nodeBinDir, process.env.PATH ?? ""]
                .filter(Boolean)
                .join(path.delimiter),
            ...options.env,
        },
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
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
        const stderr = result.stderr ? `\n${result.stderr}` : "";
        throw new Error(
            `Command failed with exit code ${result.status ?? 1}: ${command}${stderr}`,
        );
    }

    return result.stdout;
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
