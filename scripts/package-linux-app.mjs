import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
    ensurePackagedLinuxUpdaterConfig,
    verifyPackagedLinuxUpdaterConfig,
} from "./linux-release-metadata.mjs";

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
    writeLinuxUpdaterConfig();
    writeLinuxBuilderConfig();
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
    stageLinuxPackageResources();
    stageLinuxNativeBackendPayload(pnpmCommand);
    run("electron-builder", [
        "--linux",
        ...packageArgs,
        "--config",
        linuxBuilderConfigPath,
    ]);
}

function writeLinuxUpdaterConfig() {
    if (
        ensurePackagedLinuxUpdaterConfig({
            appUpdateConfigPath,
            packageJson,
        })
    ) {
        console.log(`[package:linux] Wrote ${relativeToRepo(appUpdateConfigPath)}.`);
    }

    verifyPackagedLinuxUpdaterConfig({
        appUpdateConfigPath,
        packageJson,
        relativePath: relativeToRepo,
    });
}

function writeLinuxBuilderConfig() {
    const buildConfig = packageJson.build ?? {};
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

function relativeToRepo(filePath) {
    return path.relative(repoRoot, filePath);
}

main();
