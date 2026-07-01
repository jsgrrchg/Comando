import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
    claudeVendorDir,
    copyExecutable,
    copyTree,
    ensureDir,
    isExecutableFile,
    isFile,
    relativeToRepo,
    repoRoot,
    resetDir,
    resolveFromPath,
    spawnPreparedSync,
} from "./ai/_shared.mjs";

const supportedTargets = new Map([
    [
        "x64",
        {
            rustTarget: "x86_64-pc-windows-msvc",
            nodeArch: "x64",
            outputArch: "x64",
        },
    ],
    [
        "arm64",
        {
            rustTarget: "aarch64-pc-windows-msvc",
            nodeArch: "arm64",
            outputArch: "arm64",
        },
    ],
]);

const buildRoot = path.join(repoRoot, "build", "windows-acp");
const nodeCacheRoot = path.join(buildRoot, ".cache", "node");
const cargoTargetRoot = path.join(buildRoot, ".cargo-target");
const nodeVersion = process.version.replace(/^v/, "");

function main() {
    if (process.platform !== "win32") {
        throw new Error("This Windows ACP build only runs on Windows.");
    }

    const targets = resolveTargets(process.argv.slice(2));

    ensureClaudeVendorReady();

    for (const target of targets) {
        buildTargetBundle(target);
    }
}

function resolveTargets(args) {
    const targetFlags = args.filter((arg) => arg.startsWith("--"));
    if (targetFlags.length === 0) {
        return [...supportedTargets.keys()];
    }

    const resolvedTargets = [];

    for (const flag of targetFlags) {
        const normalized = flag.replace(/^--/, "");
        if (normalized === "all") {
            return [...supportedTargets.keys()];
        }

        if (!supportedTargets.has(normalized)) {
            throw new Error(`Unsupported target "${flag}". Use --x64, --arm64 or --all.`);
        }

        resolvedTargets.push(normalized);
    }

    return [...new Set(resolvedTargets)];
}

function buildTargetBundle(target) {
    const config = supportedTargets.get(target);
    const outputRoot = path.join(buildRoot, `win-${config.outputArch}`);
    const tempOutputRoot = path.join(buildRoot, `.tmp-win-${config.outputArch}`);
    const aiRoot = path.join(tempOutputRoot, "ai");
    const binariesRoot = path.join(aiRoot, "binaries");
    const embeddedRoot = path.join(aiRoot, "embedded");
    const codexOutput = path.join(binariesRoot, "codex-acp.exe");
    const nodeOutput = path.join(embeddedRoot, "node", "bin", "node.exe");
    const claudeOutputRoot = path.join(embeddedRoot, "claude-agent-acp");

    console.log(`[build:windows-acp] Preparing win-${config.outputArch}.`);
    resetDir(tempOutputRoot);

    try {
        const codexBinary = buildCodexBinary(config.rustTarget);
        const nodeBinary = resolveNodeBinary(config.nodeArch);

        copyExecutable(codexBinary, codexOutput);
        copyExecutable(nodeBinary, nodeOutput);
        stageClaudeProject(claudeOutputRoot);

        fs.rmSync(outputRoot, { force: true, recursive: true });
        fs.renameSync(tempOutputRoot, outputRoot);

        console.log(
            `[build:windows-acp] win-${config.outputArch} ready at ${relativeToRepo(outputRoot)}.`,
        );
    } catch (error) {
        fs.rmSync(tempOutputRoot, { force: true, recursive: true });
        throw error;
    }
}

function ensureClaudeVendorReady() {
    const packageJsonPath = path.join(claudeVendorDir, "package.json");
    const packageLockPath = path.join(claudeVendorDir, "package-lock.json");
    const distEntry = path.join(claudeVendorDir, "dist", "index.js");
    const nodeModulesDir = path.join(claudeVendorDir, "node_modules");

    if (!isFile(packageJsonPath) || !isFile(packageLockPath)) {
        throw new Error(
            "Claude ACP vendor is incomplete. Expected package.json and package-lock.json.",
        );
    }

    const npmCommand = resolveRequiredCommand("npm.cmd");

    if (!fs.existsSync(nodeModulesDir)) {
        console.log("[build:windows-acp] Installing Claude ACP vendor dependencies.");
        run(npmCommand, ["ci"], { cwd: claudeVendorDir });
    }

    if (!isFile(distEntry) || isNewerThan(packageJsonPath, distEntry)) {
        console.log("[build:windows-acp] Building Claude ACP vendor dist.");
        run(npmCommand, ["run", "build"], { cwd: claudeVendorDir });
    }
}

function stageClaudeProject(destinationRoot) {
    const sourceDist = path.join(claudeVendorDir, "dist");
    const sourceNodeModules = path.join(claudeVendorDir, "node_modules");
    const passthroughFiles = ["package.json", "LICENSE", "README.md"];

    if (!isFile(path.join(sourceDist, "index.js"))) {
        throw new Error("Claude ACP dist/index.js is missing after the build.");
    }

    if (!fs.existsSync(sourceNodeModules)) {
        throw new Error(
            "Claude ACP node_modules is missing after npm ci. The vendor build is incomplete.",
        );
    }

    copyTree(sourceDist, path.join(destinationRoot, "dist"));
    copyTree(sourceNodeModules, path.join(destinationRoot, "node_modules"), {
        dereference: true,
    });

    for (const fileName of passthroughFiles) {
        const sourceFile = path.join(claudeVendorDir, fileName);
        if (!isFile(sourceFile)) {
            continue;
        }

        ensureDir(destinationRoot);
        fs.copyFileSync(sourceFile, path.join(destinationRoot, fileName));
    }
}

function buildCodexBinary(rustTarget) {
    ensureRustTarget(rustTarget);

    console.log(`[build:windows-acp] Building Codex ACP for ${rustTarget}.`);
    run("cargo", ["build", "--release", "--locked", "--target", rustTarget], {
        cwd: path.join(repoRoot, "vendor", "codex-acp"),
        env: {
            CARGO_TARGET_DIR: cargoTargetRoot,
        },
    });

    const builtBinary = path.join(
        cargoTargetRoot,
        rustTarget,
        "release",
        "codex-acp.exe",
    );

    if (!isExecutableFile(builtBinary)) {
        throw new Error(
            `Cargo finished but ${relativeToRepo(builtBinary)} is missing.`,
        );
    }

    return builtBinary;
}

function ensureRustTarget(rustTarget) {
    const installedTargets = capture("rustup", ["target", "list", "--installed"]);
    if (installedTargets.split(/\r?\n/).includes(rustTarget)) {
        return;
    }

    console.log(`[build:windows-acp] Installing Rust target ${rustTarget}.`);
    run("rustup", ["target", "add", rustTarget]);
}

function resolveNodeBinary(nodeArch) {
    if (nodeArch === "x64" && isExecutableFile(process.execPath)) {
        return process.execPath;
    }

    const cachedBinary = path.join(
        nodeCacheRoot,
        `node-v${nodeVersion}-win-${nodeArch}`,
        "node.exe",
    );
    if (isExecutableFile(cachedBinary)) {
        return cachedBinary;
    }

    ensureDir(nodeCacheRoot);

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "comando-node-"));
    const zipPath = path.join(tempRoot, `node-v${nodeVersion}-win-${nodeArch}.zip`);
    const extractRoot = path.join(tempRoot, "extract");
    const downloadUrl = `https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-win-${nodeArch}.zip`;

    console.log(`[build:windows-acp] Downloading Node ${nodeVersion} for ${nodeArch}.`);
    downloadFile(downloadUrl, zipPath);
    ensureDir(extractRoot);
    extractZip(zipPath, extractRoot);

    const extractedBinary = path.join(
        extractRoot,
        `node-v${nodeVersion}-win-${nodeArch}`,
        "node.exe",
    );
    if (!isExecutableFile(extractedBinary)) {
        throw new Error(
            `Downloaded Node archive did not contain ${path.basename(extractedBinary)}.`,
        );
    }

    ensureDir(path.dirname(cachedBinary));
    copyExecutable(extractedBinary, cachedBinary);
    fs.rmSync(tempRoot, { force: true, recursive: true });

    return cachedBinary;
}

function downloadFile(url, destinationPath) {
    const curlCommand = resolveFromPath("curl.exe") ?? resolveFromPath("curl");
    if (!curlCommand) {
        throw new Error("curl is required to download Node runtime archives.");
    }

    run(curlCommand, ["-fsSL", url, "-o", destinationPath]);
}

function extractZip(zipPath, destinationDir) {
    const powershellCommand =
        resolveFromPath("powershell.exe") ?? resolveFromPath("powershell");
    if (!powershellCommand) {
        throw new Error("PowerShell is required to extract Node runtime archives.");
    }

    run(powershellCommand, [
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destinationDir.replace(/'/g, "''")}' -Force`,
    ]);
}

function isNewerThan(sourcePath, outputPath) {
    try {
        return fs.statSync(sourcePath).mtimeMs > fs.statSync(outputPath).mtimeMs;
    } catch {
        return true;
    }
}

function resolveRequiredCommand(command) {
    const resolved = resolveFromPath(command);
    if (resolved) {
        return resolved;
    }

    throw new Error(`Required command was not found: ${command}`);
}

function capture(command, args, options = {}) {
    const spawnOptions = {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
            ...process.env,
            ...options.env,
        },
        stdio: ["ignore", "pipe", "inherit"],
        ...options,
    };
    const result = spawnPreparedSync(command, args, spawnOptions);

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }

    return result.stdout ?? "";
}

function run(command, args, options = {}) {
    const spawnOptions = {
        cwd: repoRoot,
        env: {
            ...process.env,
            ...options.env,
        },
        stdio: "inherit",
        ...options,
    };
    const result = spawnPreparedSync(command, args, spawnOptions);

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}
