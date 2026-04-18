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
const electronBuilderCli = path.join(
    repoRoot,
    "node_modules",
    "electron-builder",
    "cli.js",
);
const nodeBinDir = path.dirname(process.execPath);
const pnpmCommand = resolveRequiredCommand("pnpm.cmd");

if (process.platform !== "win32") {
    throw new Error("The Windows packaging workflow can only run on Windows.");
}

main();

function main() {
    const electronBuilderArgs = resolveElectronBuilderArgs(process.argv.slice(2));

    console.log("[package:win] Building Electron production bundles.");
    prepareWorkspace();
    run(pnpmCommand, ["run", "build"]);

    console.log("[package:win] Staging Windows AI payload.");
    stageWindowsAiPayload();
    verifyWindowsAiPayload();

    console.log(
        `[package:win] Packaging Windows app with ${electronBuilderArgs.join(" ")}.`,
    );
    run(process.execPath, [electronBuilderCli, ...electronBuilderArgs]);
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

function stageWindowsAiPayload() {
    stageCodexBinary();
    stageEmbeddedNodeBinary();
    stageClaudeRuntime();
}

function stageCodexBinary() {
    if (!isExecutableFile(codexBundledBinary)) {
        throw new Error(
            "Missing staged Codex ACP binary at resources/ai/binaries/codex-acp.exe. Run pnpm run stage:ai on the target Windows architecture or provide COMANDO_CODEX_ACP_BUNDLE_BIN before packaging.",
        );
    }

    copyExecutable(codexBundledBinary, packagedCodexBinary);
    console.log(
        `[package:win] Staged Codex ACP from ${relativeToRepo(codexBundledBinary)}.`,
    );
}

function stageEmbeddedNodeBinary() {
    if (!isExecutableFile(embeddedNodeBin)) {
        throw new Error(
            "Missing staged embedded Node at resources/ai/embedded/node/bin/node.exe. Run pnpm run stage:ai on the target Windows architecture or provide COMANDO_EMBEDDED_NODE_BIN before packaging.",
        );
    }

    copyExecutable(embeddedNodeBin, packagedNodeBinary);
    console.log(
        `[package:win] Staged embedded Node from ${relativeToRepo(embeddedNodeBin)}.`,
    );
}

function stageClaudeRuntime() {
    const sourceRoot = resolveClaudeProjectRoot();
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

function resolveClaudeProjectRoot() {
    const candidates = [bundledClaudeRoot, claudeVendorDir];

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
    const result = spawnSync(command, args, {
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
    });

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}
