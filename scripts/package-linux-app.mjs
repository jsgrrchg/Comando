import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
    ensurePackagedLinuxUpdaterConfig,
    resolveLinuxUpdaterChannel,
    verifyLinuxPackageArtifacts,
    verifyLinuxReleaseArtifacts,
    verifyPackagedLinuxUpdaterConfig,
} from "./linux-release-metadata.mjs";
import { codexVendorDir, isExecutableFile } from "./ai/_shared.mjs";
import {
    assertCodexRuntimeBundleVersion,
    resolveExpectedCodexRuntimeVersion,
} from "./ai/codex-runtime-version.mjs";
import { stageCodexRuntime } from "./ai/stage-codex-runtime.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const packageResourcesRoot = path.join(repoRoot, "build", "package-resources");
const stagedAiRoot = path.join(packageResourcesRoot, "ai");
const appUpdateConfigPath = path.join(packageResourcesRoot, "app-update.yml");
const linuxBuilderConfigPath = path.join(
    packageResourcesRoot,
    "electron-builder-linux.json",
);
const sourceAiRoot = path.join(repoRoot, "resources", "ai");
const packageJson = readJson(path.join(repoRoot, "package.json"));
const targetArch = process.arch;

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: repoRoot,
        env: process.env,
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

function stageLinuxPackageResources() {
    fs.rmSync(packageResourcesRoot, { force: true, recursive: true });
    fs.mkdirSync(stagedAiRoot, { recursive: true });

    copyAiPayload("binaries");
    copyAiPayload(path.join("embedded", "node"));
    copyAiPayload(path.join("embedded", "claude-agent-acp"));
    copyAiPayload("README.md");
    verifyStagedCodexRuntime();
    writeLinuxUpdaterConfig();
    writeLinuxBuilderConfig();
}

function verifyStagedCodexRuntime() {
    for (const binaryName of ["codex-acp", "codex-code-mode-host"]) {
        const binaryPath = path.join(stagedAiRoot, "binaries", binaryName);
        if (!isExecutableFile(binaryPath)) {
            throw new Error(
                `The staged Linux Codex runtime is incomplete: ${relativeToRepo(binaryPath)} is missing or not executable.`,
            );
        }
    }
    assertCodexRuntimeBundleVersion({
        codeModeHostBinaryPath: path.join(
            stagedAiRoot,
            "binaries",
            "codex-code-mode-host",
        ),
        codexBinaryPath: path.join(
            stagedAiRoot,
            "binaries",
            "codex-acp",
        ),
        expectedVersion: resolveExpectedCodexRuntimeVersion(
            path.join(codexVendorDir, "Cargo.toml"),
        ),
    });
}

function stageLinuxNativeBackendPayload(pnpmCommand) {
    console.log("[package:linux] Building and staging native backend sidecar.");
    run(pnpmCommand, ["run", "native:build"]);
    run(pnpmCommand, [
        "run",
        "native:stage",
        "--",
        "--platform",
        "linux",
        "--arch",
        process.arch,
    ]);
}

function copyAiPayload(relativePath) {
    const fromPath = path.join(sourceAiRoot, relativePath);
    if (!fs.existsSync(fromPath)) {
        return;
    }

    fs.cpSync(fromPath, path.join(stagedAiRoot, relativePath), {
        dereference: false,
        errorOnExist: false,
        force: true,
        preserveTimestamps: true,
        recursive: true,
    });
}

function main() {
    if (process.platform !== "linux") {
        throw new Error("Linux packaging must run on Linux.");
    }

    const packageArgs = process.argv.slice(2);
    const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    const nodeOptions = process.env.NODE_OPTIONS?.trim()
        ? process.env.NODE_OPTIONS
        : "--max-old-space-size=4096";

    run(pnpmCommand, ["run", "build"], {
        env: {
            ...process.env,
            NODE_OPTIONS: nodeOptions,
        },
    });
    stageCodexRuntime();
    stageLinuxPackageResources();
    stageLinuxNativeBackendPayload(pnpmCommand);
    run("electron-builder", [
        "--linux",
        ...packageArgs,
        "--config",
        linuxBuilderConfigPath,
    ]);
    if (isFullLinuxPackageBuild(packageArgs)) {
        const artifactArgs = {
            distDir: path.join(repoRoot, "dist"),
            productName: packageJson.build?.productName ?? packageJson.name,
            relativePath: relativeToRepo,
            targetArch,
            version: packageJson.version,
        };
        verifyLinuxPackageArtifacts(artifactArgs);
        if (shouldVerifyLinuxReleaseArtifacts(packageArgs)) {
            verifyLinuxReleaseArtifacts(artifactArgs);
        }
    }
}

function writeLinuxUpdaterConfig() {
    if (
        ensurePackagedLinuxUpdaterConfig({
            appUpdateConfigPath,
            packageJson,
            targetArch,
        })
    ) {
        console.log(`[package:linux] Wrote ${relativeToRepo(appUpdateConfigPath)}.`);
    }

    verifyPackagedLinuxUpdaterConfig({
        appUpdateConfigPath,
        packageJson,
        relativePath: relativeToRepo,
        targetArch,
    });
}

function writeLinuxBuilderConfig() {
    const buildConfig = packageJson.build ?? {};
    const linuxConfig =
        buildConfig.linux && typeof buildConfig.linux === "object"
            ? buildConfig.linux
            : {};
    const extraResources = [
        ...(Array.isArray(buildConfig.extraResources)
            ? buildConfig.extraResources
            : []),
        {
            from: appUpdateConfigPath,
            to: "app-update.yml",
        },
    ];

    fs.writeFileSync(
        linuxBuilderConfigPath,
        `${JSON.stringify(
            {
                ...buildConfig,
                extraResources,
                linux: {
                    ...linuxConfig,
                    publish: [
                        {
                            provider: "github",
                            channel: resolveLinuxUpdaterChannel(targetArch),
                        },
                    ],
                },
            },
            null,
            4,
        )}\n`,
        "utf8",
    );
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function isFullLinuxPackageBuild(packageArgs) {
    const explicitTargets = new Set(["AppImage", "deb", "rpm"]);
    return !packageArgs.some((arg) => explicitTargets.has(arg));
}

function shouldVerifyLinuxReleaseArtifacts(packageArgs) {
    const publishMode = resolvePublishMode(packageArgs);
    return publishMode !== "never";
}

function resolvePublishMode(packageArgs) {
    for (let index = 0; index < packageArgs.length; index += 1) {
        const arg = packageArgs[index];

        if (arg === "--publish" || arg === "-p") {
            return packageArgs[index + 1] ?? "";
        }

        if (arg.startsWith("--publish=")) {
            return arg.slice("--publish=".length);
        }

        if (arg.startsWith("-p=")) {
            return arg.slice("-p=".length);
        }
    }

    return "onTagOrDraft";
}

function relativeToRepo(filePath) {
    return path.relative(repoRoot, filePath);
}

main();
