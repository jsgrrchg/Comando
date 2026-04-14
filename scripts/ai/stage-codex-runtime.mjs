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
            `${envName} apunta a un binario no ejecutable: ${absolutePath}`,
        );
    }

    return absolutePath;
}

function ensureVendoredSourceExists() {
    if (!fs.existsSync(codexVendorDir)) {
        throw new Error(
            "No existe vendor/codex-acp. Corre la importación del vendor antes de stagear el runtime.",
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
            `[stage:codex-runtime] no se pudo migrar el target legacy (${message}). Se seguirá usando mientras exista.`,
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
            `No se pudo ejecutar ${cargoCommand}. Instala Rust/Cargo o define COMANDO_CODEX_ACP_BUNDLE_BIN con un binario ya compilado.`,
        );
    }

    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }

    if (!isExecutableFile(codexTargetReleaseBinary)) {
        throw new Error(
            `Cargo terminó, pero no apareció el binario esperado en ${codexTargetReleaseBinary}.`,
        );
    }

    return codexTargetReleaseBinary;
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
