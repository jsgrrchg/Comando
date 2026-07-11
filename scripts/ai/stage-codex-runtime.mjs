import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
    codexBinaryName,
    codexBundledBinary,
    codexBundledCodeModeHostBinary,
    codexCodeModeHostBinaryName,
    codexLegacyVendorDebugBinary,
    codexLegacyVendorDebugCodeModeHostBinary,
    codexLegacyVendorReleaseBinary,
    codexLegacyVendorReleaseCodeModeHostBinary,
    codexLegacyVendorTargetDir,
    codexTargetDebugBinary,
    codexTargetDebugCodeModeHostBinary,
    codexTargetDir,
    codexTargetReleaseBinary,
    codexTargetReleaseCodeModeHostBinary,
    codexVendorDir,
    copyExecutable,
    ensureDir,
    isExecutableFile,
    relativeToRepo,
    resolveFromPath,
} from "./_shared.mjs";
import {
    assertCodexRuntimeBundleVersion,
    resolveExpectedCodexRuntimeVersion,
} from "./codex-runtime-version.mjs";

const codexVendorCargoToml = path.join(codexVendorDir, "Cargo.toml");

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

function buildVendoredReleaseBundle(rustTarget = null) {
    ensureVendoredSourceExists();
    migrateLegacyTargetDir();

    const cargoCommand = process.env.CARGO?.trim() || "cargo";
    const cargoArgs = ["build", "--release", "--locked", "--bins"];
    if (rustTarget) {
        cargoArgs.push("--target", rustTarget);
    }
    const result = spawnSync(cargoCommand, cargoArgs, {
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

    const outputRoot = rustTarget
        ? path.join(codexTargetDir, rustTarget, "release")
        : path.join(codexTargetDir, "release");
    const binaries = {
        codex: path.join(outputRoot, codexBinaryName),
        codeModeHost: path.join(outputRoot, codexCodeModeHostBinaryName),
    };
    for (const binaryPath of Object.values(binaries)) {
        if (!isExecutableFile(binaryPath)) {
            throw new Error(
                `Cargo finished, but the expected binary was not found at ${binaryPath}.`,
            );
        }
    }

    return binaries;
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

function shouldRebuildVendoredReleaseBundle(
    binaries = {
        codex: codexTargetReleaseBinary,
        codeModeHost: codexTargetReleaseCodeModeHostBinary,
    },
) {
    const binaryPaths = Object.values(binaries);
    if (binaryPaths.some((binaryPath) => !isExecutableFile(binaryPath))) {
        return true;
    }

    const binaryMtimeMs = Math.min(
        ...binaryPaths.map((binaryPath) => fs.statSync(binaryPath).mtimeMs),
    );
    const sourceFiles = collectVendoredSourceFiles(codexVendorDir);

    return sourceFiles.some((sourceFile) => {
        try {
            return fs.statSync(sourceFile).mtimeMs > binaryMtimeMs;
        } catch {
            return true;
        }
    });
}

export function resolveVendoredCodexRuntimeBundleForTarget(rustTarget) {
    const outputRoot = path.join(codexTargetDir, rustTarget, "release");
    const binaries = {
        codex: path.join(outputRoot, codexBinaryName),
        codeModeHost: path.join(outputRoot, codexCodeModeHostBinaryName),
    };
    if (shouldRebuildVendoredReleaseBundle(binaries)) {
        return buildVendoredReleaseBundle(rustTarget);
    }
    return binaries;
}

export function resolveVendoredCodexRuntimeForTarget(rustTarget) {
    return resolveVendoredCodexRuntimeBundleForTarget(rustTarget).codex;
}

function resolveExplicitBundle({
    codeModeHostEnvName,
    codeModeHostRawCandidate,
    codexEnvName,
    codexRawCandidate,
    source,
}) {
    const codex = resolveExplicitCandidate(codexRawCandidate, codexEnvName);
    if (!codex) {
        return null;
    }

    const configuredCodeModeHost = codeModeHostRawCandidate?.trim() ?? "";
    const codeModeHost = configuredCodeModeHost
        ? resolveExplicitCandidate(
              configuredCodeModeHost,
              codeModeHostEnvName,
          )
        : path.join(path.dirname(codex), codexCodeModeHostBinaryName);
    if (!isExecutableFile(codeModeHost)) {
        throw new Error(
            `${codexEnvName} requires a sibling ${codexCodeModeHostBinaryName}, or set ${codeModeHostEnvName} explicitly. Missing: ${codeModeHost}`,
        );
    }

    return {
        binaries: { codex, codeModeHost },
        source,
    };
}

function resolveStageSource() {
    migrateLegacyTargetDir();

    const bundleOverride = resolveExplicitBundle({
        codeModeHostEnvName: "COMANDO_CODEX_CODE_MODE_HOST_BUNDLE_BIN",
        codeModeHostRawCandidate:
            process.env.COMANDO_CODEX_CODE_MODE_HOST_BUNDLE_BIN,
        codexEnvName: "COMANDO_CODEX_ACP_BUNDLE_BIN",
        codexRawCandidate: process.env.COMANDO_CODEX_ACP_BUNDLE_BIN,
        source: "bundle-env",
    });
    if (bundleOverride) {
        return bundleOverride;
    }

    const runtimeOverride = resolveExplicitBundle({
        codeModeHostEnvName: "COMANDO_CODEX_CODE_MODE_HOST_BIN",
        codeModeHostRawCandidate: process.env.COMANDO_CODEX_CODE_MODE_HOST_BIN,
        codexEnvName: "COMANDO_CODEX_ACP_BIN",
        codexRawCandidate: process.env.COMANDO_CODEX_ACP_BIN,
        source: "runtime-env",
    });
    if (runtimeOverride) {
        return runtimeOverride;
    }

    if (fs.existsSync(codexVendorDir) && shouldRebuildVendoredReleaseBundle()) {
        return {
            binaries: buildVendoredReleaseBundle(),
            source: "embedded-release-built",
        };
    }

    if (
        isExecutableFile(codexTargetReleaseBinary) &&
        isExecutableFile(codexTargetReleaseCodeModeHostBinary)
    ) {
        return {
            binaries: {
                codex: codexTargetReleaseBinary,
                codeModeHost: codexTargetReleaseCodeModeHostBinary,
            },
            source: "embedded-release",
        };
    }

    if (
        isExecutableFile(codexTargetDebugBinary) &&
        isExecutableFile(codexTargetDebugCodeModeHostBinary)
    ) {
        return {
            binaries: {
                codex: codexTargetDebugBinary,
                codeModeHost: codexTargetDebugCodeModeHostBinary,
            },
            source: "embedded-debug",
        };
    }

    if (
        isExecutableFile(codexLegacyVendorReleaseBinary) &&
        isExecutableFile(codexLegacyVendorReleaseCodeModeHostBinary)
    ) {
        return {
            binaries: {
                codex: codexLegacyVendorReleaseBinary,
                codeModeHost: codexLegacyVendorReleaseCodeModeHostBinary,
            },
            source: "legacy-vendor-release",
        };
    }

    if (
        isExecutableFile(codexLegacyVendorDebugBinary) &&
        isExecutableFile(codexLegacyVendorDebugCodeModeHostBinary)
    ) {
        return {
            binaries: {
                codex: codexLegacyVendorDebugBinary,
                codeModeHost: codexLegacyVendorDebugCodeModeHostBinary,
            },
            source: "legacy-vendor-debug",
        };
    }

    return {
        binaries: buildVendoredReleaseBundle(),
        source: "embedded-release-built",
    };
}

export function stageCodexRuntime() {
    const resolved = resolveStageSource();
    assertCodexRuntimeBundleVersion({
        codeModeHostBinaryPath: resolved.binaries.codeModeHost,
        codexBinaryPath: resolved.binaries.codex,
        expectedVersion:
            resolveExpectedCodexRuntimeVersion(codexVendorCargoToml),
    });
    copyExecutable(resolved.binaries.codex, codexBundledBinary);
    copyExecutable(
        resolved.binaries.codeModeHost,
        codexBundledCodeModeHostBinary,
    );

    console.log(
        `[stage:codex-runtime] ${resolved.source} -> ${relativeToRepo(codexBundledBinary)}, ${relativeToRepo(codexBundledCodeModeHostBinary)}`,
    );

    return codexBundledBinary;
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    stageCodexRuntime();
}
