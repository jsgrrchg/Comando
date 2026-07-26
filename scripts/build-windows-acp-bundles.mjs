import fs from "node:fs";
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
import { prepareOfficialNodeRuntime } from "./ai/node-runtime.mjs";

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
const cargoTargetRoot = path.join(buildRoot, ".cargo-target");

async function main() {
    if (process.platform !== "win32") {
        throw new Error("This Windows ACP build only runs on Windows.");
    }

    const targets = resolveTargets(process.argv.slice(2));

    ensureClaudeVendorReady();

    for (const target of targets) {
        await buildTargetBundle(target);
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

async function buildTargetBundle(target) {
    const config = supportedTargets.get(target);
    const outputRoot = path.join(buildRoot, `win-${config.outputArch}`);
    const tempOutputRoot = path.join(buildRoot, `.tmp-win-${config.outputArch}`);
    const aiRoot = path.join(tempOutputRoot, "ai");
    const binariesRoot = path.join(aiRoot, "binaries");
    const embeddedRoot = path.join(aiRoot, "embedded");
    const codexOutput = path.join(binariesRoot, "codex-acp.exe");
    const codeModeHostOutput = path.join(
        binariesRoot,
        "codex-code-mode-host.exe",
    );
    const nodeOutput = path.join(embeddedRoot, "node", "bin", "node.exe");
    const claudeOutputRoot = path.join(embeddedRoot, "claude-agent-acp");

    console.log(`[build:windows-acp] Preparing win-${config.outputArch}.`);
    resetDir(tempOutputRoot);

    try {
        const codexRuntime = buildCodexRuntime(config.rustTarget);
        const nodeRuntime = await prepareOfficialNodeRuntime({
            arch: config.nodeArch,
            platform: "win32",
        });

        copyExecutable(codexRuntime.codex, codexOutput);
        copyExecutable(codexRuntime.codeModeHost, codeModeHostOutput);
        copyExecutable(nodeRuntime.binaryPath, nodeOutput);
        copyNodeNotices(
            nodeRuntime.runtimeRoot,
            path.dirname(path.dirname(nodeOutput)),
        );
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

function copyNodeNotices(sourceRoot, destinationRoot) {
    for (const fileName of ["LICENSE", "README.md"]) {
        const sourcePath = path.join(sourceRoot, fileName);
        if (isFile(sourcePath)) {
            fs.copyFileSync(sourcePath, path.join(destinationRoot, fileName));
        }
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

    const npmCliPath = resolveRequiredNpmCliPath();

    if (!fs.existsSync(nodeModulesDir)) {
        console.log("[build:windows-acp] Installing Claude ACP vendor dependencies.");
        run(process.execPath, [npmCliPath, "ci"], { cwd: claudeVendorDir });
    }

    if (!isFile(distEntry) || isNewerThan(packageJsonPath, distEntry)) {
        console.log("[build:windows-acp] Building Claude ACP vendor dist.");
        run(process.execPath, [npmCliPath, "run", "build"], {
            cwd: claudeVendorDir,
        });
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

function buildCodexRuntime(rustTarget) {
    ensureRustTarget(rustTarget);

    console.log(`[build:windows-acp] Building Codex ACP for ${rustTarget}.`);
    run(
        "cargo",
        ["build", "--release", "--locked", "--bins", "--target", rustTarget],
        {
            cwd: path.join(repoRoot, "vendor", "codex-acp"),
            env: {
                CARGO_TARGET_DIR: cargoTargetRoot,
            },
        },
    );

    const outputRoot = path.join(cargoTargetRoot, rustTarget, "release");
    const binaries = {
        codex: path.join(outputRoot, "codex-acp.exe"),
        codeModeHost: path.join(outputRoot, "codex-code-mode-host.exe"),
    };

    for (const binaryPath of Object.values(binaries)) {
        if (!isExecutableFile(binaryPath)) {
            throw new Error(
                `Cargo finished but ${relativeToRepo(binaryPath)} is missing.`,
            );
        }
    }

    return binaries;
}

function ensureRustTarget(rustTarget) {
    const installedTargets = capture("rustup", ["target", "list", "--installed"]);
    if (installedTargets.split(/\r?\n/).includes(rustTarget)) {
        return;
    }

    console.log(`[build:windows-acp] Installing Rust target ${rustTarget}.`);
    run("rustup", ["target", "add", rustTarget]);
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

function resolveRequiredNpmCliPath() {
    const npmCommand = resolveFromPath("npm.cmd");
    if (!npmCommand) {
        throw new Error("Required command was not found: npm.cmd");
    }

    const npmCliPath = path.join(
        path.dirname(npmCommand),
        "node_modules",
        "npm",
        "bin",
        "npm-cli.js",
    );
    if (isFile(npmCliPath)) {
        return npmCliPath;
    }

    throw new Error(
        `Required npm CLI was not found next to npm.cmd: ${npmCliPath}`,
    );
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
    await main();
}
