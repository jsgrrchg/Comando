import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
    codexBundledBinary,
    codexLegacyVendorDebugBinary,
    codexLegacyVendorReleaseBinary,
    codexLegacyVendorTargetDir,
    codexTargetDebugBinary,
    codexTargetDir,
    codexTargetReleaseBinary,
    codexVendorDir,
    copyExecutable,
    ensureDir,
    isExecutableFile,
    relativeToRepo,
    resolveFromPath,
} from "./_shared.mjs";

function resolveExplicitCandidate(rawCandidate, envName) {
    const candidate = rawCandidate?.trim() ?? "";
    if (!candidate) {
        return null;
    }

    const absolutePath =
        path.isAbsolute(candidate) || candidate.includes(path.sep)
            ? path.resolve(candidate)
            : (resolveFromPath(candidate) ?? path.resolve(candidate));
    if (!isExecutableFile(absolutePath)) {
        throw new Error(
            `${envName} points to a non-executable binary: ${absolutePath}`,
        );
    }

    return absolutePath;
}

function ensureVendoredSourceExists() {
    if (!fs.existsSync(codexVendorDir)) {
        throw new Error(
            "vendor/codex-acp does not exist. Import the vendor before staging the runtime.",
        );
    }
}

function migrateLegacyTargetDir() {
    if (
        fs.existsSync(codexTargetDir) ||
        !fs.existsSync(codexLegacyVendorTargetDir)
    ) {
        return;
    }

    ensureDir(path.dirname(codexTargetDir));

    try {
        fs.renameSync(codexLegacyVendorTargetDir, codexTargetDir);
        console.log(
            `[stage:codex-runtime] migrated legacy target cache -> ${relativeToRepo(codexTargetDir)}`,
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
            `[stage:codex-runtime] Could not migrate legacy target (${message}). Existing one will be used while it exists.`,
        );
    }
}

function buildVendoredReleaseBinary() {
    ensureVendoredSourceExists();
    migrateLegacyTargetDir();

    const cargoCommand = process.env.CARGO?.trim() || "cargo";
    const result = spawnSync(cargoCommand, ["build", "--release", "--locked"], {
        cwd: codexVendorDir,
        env: {
            ...process.env,
            CARGO_TARGET_DIR: codexTargetDir,
        },
        stdio: "inherit",
    });

    if (result.error) {
        throw new Error(
            `Failed to run ${cargoCommand}. Install Rust/Cargo or set COMANDO_CODEX_ACP_BUNDLE_BIN to a prebuilt binary.`,
        );
    }

    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }

    if (!isExecutableFile(codexTargetReleaseBinary)) {
        throw new Error(
            `Cargo finished, but the expected binary was not found at ${codexTargetReleaseBinary}.`,
        );
    }

    return codexTargetReleaseBinary;
}

function collectVendoredSourceFiles(directory, collected = []) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (
            entry.name === "target" ||
            entry.name === ".git" ||
            entry.name === "node_modules"
        ) {
            continue;
        }

        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            collectVendoredSourceFiles(absolutePath, collected);
            continue;
        }

        if (entry.isFile()) {
            collected.push(absolutePath);
        }
    }

    return collected;
}

function shouldRebuildVendoredReleaseBinary() {
    if (!isExecutableFile(codexTargetReleaseBinary)) {
        return true;
    }

    const binaryMtimeMs = fs.statSync(codexTargetReleaseBinary).mtimeMs;
    const sourceFiles = collectVendoredSourceFiles(codexVendorDir);

    return sourceFiles.some((sourceFile) => {
        try {
            return fs.statSync(sourceFile).mtimeMs > binaryMtimeMs;
        } catch {
            return true;
        }
    });
}

function resolveStageSource() {
    migrateLegacyTargetDir();

    const bundleOverride = resolveExplicitCandidate(
        process.env.COMANDO_CODEX_ACP_BUNDLE_BIN,
        "COMANDO_CODEX_ACP_BUNDLE_BIN",
    );
    if (bundleOverride) {
        return {
            path: bundleOverride,
            source: "bundle-env",
        };
    }

    const runtimeOverride = resolveExplicitCandidate(
        process.env.COMANDO_CODEX_ACP_BIN,
        "COMANDO_CODEX_ACP_BIN",
    );
    if (runtimeOverride) {
        return {
            path: runtimeOverride,
            source: "runtime-env",
        };
    }

    if (fs.existsSync(codexVendorDir) && shouldRebuildVendoredReleaseBinary()) {
        return {
            path: buildVendoredReleaseBinary(),
            source: "embedded-release-built",
        };
    }

    if (isExecutableFile(codexTargetReleaseBinary)) {
        return {
            path: codexTargetReleaseBinary,
            source: "embedded-release",
        };
    }

    if (isExecutableFile(codexTargetDebugBinary)) {
        return {
            path: codexTargetDebugBinary,
            source: "embedded-debug",
        };
    }

    if (isExecutableFile(codexLegacyVendorReleaseBinary)) {
        return {
            path: codexLegacyVendorReleaseBinary,
            source: "legacy-vendor-release",
        };
    }

    if (isExecutableFile(codexLegacyVendorDebugBinary)) {
        return {
            path: codexLegacyVendorDebugBinary,
            source: "legacy-vendor-debug",
        };
    }

    return {
        path: buildVendoredReleaseBinary(),
        source: "embedded-release-built",
    };
}

export function stageCodexRuntime() {
    const resolved = resolveStageSource();
    copyExecutable(resolved.path, codexBundledBinary);

    console.log(
        `[stage:codex-runtime] ${resolved.source} -> ${relativeToRepo(codexBundledBinary)}`,
    );

    return codexBundledBinary;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    stageCodexRuntime();
}
