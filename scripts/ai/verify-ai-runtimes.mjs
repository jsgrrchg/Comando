import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import {
    claudeEmbeddedDist,
    claudeEmbeddedNodeModules,
    claudeEmbeddedRoot,
    claudeVendorDir,
    codexEmbeddedDir,
    codexBundledBinary,
    codexBundledCodeModeHostBinary,
    codexLegacyVendorTargetDir,
    codexTargetDebugBinary,
    codexTargetDebugCodeModeHostBinary,
    codexTargetReleaseBinary,
    codexTargetReleaseCodeModeHostBinary,
    codexVendorDir,
    embeddedNodeBin,
    isExecutableFile,
    isFile,
    relativeToRepo,
} from "./_shared.mjs";
import {
    assertCodexRuntimeBundleVersion,
    resolveExpectedCodexRuntimeVersion,
} from "./codex-runtime-version.mjs";

export function verifyAiRuntimes() {
    const codexVendorExists = fs.existsSync(codexVendorDir);
    const codexBundledReady = [
        codexBundledBinary,
        codexBundledCodeModeHostBinary,
    ].every(isExecutableFile);
    const codexEmbeddedReady = [
        codexTargetReleaseBinary,
        codexTargetReleaseCodeModeHostBinary,
    ].every(isExecutableFile);
    const codexEmbeddedDebugReady = [
        codexTargetDebugBinary,
        codexTargetDebugCodeModeHostBinary,
    ].every(isExecutableFile);
    const legacyTargetExists = fs.existsSync(codexLegacyVendorTargetDir);
    const claudeVendorExists = fs.existsSync(claudeVendorDir);
    const embeddedNodeReady = isExecutableFile(embeddedNodeBin);
    const claudeEmbeddedReady = isFile(`${claudeEmbeddedDist}/index.js`);
    const claudeModulesReady = fs.existsSync(claudeEmbeddedNodeModules);
    const claudeRuntimeDependencies = verifyClaudeRuntimeDependencies();

    console.log(
        `[verify:ai-runtimes] codexVendor=${codexVendorExists ? "yes" : "no"} codexBundled=${codexBundledReady ? "yes" : "no"} codexEmbedded=${codexEmbeddedReady ? "yes" : "no"} codexEmbeddedDebug=${codexEmbeddedDebugReady ? "yes" : "no"} legacyTarget=${legacyTargetExists ? "yes" : "no"} claudeVendor=${claudeVendorExists ? "yes" : "no"} embeddedNode=${embeddedNodeReady ? "yes" : "no"} claudeEmbedded=${claudeEmbeddedReady ? "yes" : "no"} claudeModules=${claudeModulesReady ? "yes" : "no"} claudeRuntimeDeps=${claudeRuntimeDependencies.ok ? "yes" : "no"}`,
    );

    if (!codexVendorExists) {
        console.error(
            "[verify:ai-runtimes] Missing vendor/codex-acp. The app cannot stage the bundled runtime.",
        );
        process.exit(1);
    }

    if (!codexBundledReady) {
        console.error(
            `[verify:ai-runtimes] The Codex runtime bundle is incomplete. Expected ${relativeToRepo(codexBundledBinary)} and ${relativeToRepo(codexBundledCodeModeHostBinary)}. Run pnpm run stage:ai.`,
        );
        process.exit(1);
    }

    assertCodexRuntimeBundleVersion({
        codeModeHostBinaryPath: codexBundledCodeModeHostBinary,
        codexBinaryPath: codexBundledBinary,
        expectedVersion: resolveExpectedCodexRuntimeVersion(
            path.join(codexVendorDir, "Cargo.toml"),
        ),
    });

    if (!codexEmbeddedReady) {
        console.warn(
            `[verify:ai-runtimes] ${relativeToRepo(codexEmbeddedDir)} does not yet have a compiled release. You can regenerate it with pnpm run stage:ai.`,
        );
    }

    if (!claudeVendorExists) {
        console.error(
            "[verify:ai-runtimes] Missing vendor/Claude-agent-acp-upstream. The app cannot stage Claude.",
        );
        process.exit(1);
    }

    if (!embeddedNodeReady || !claudeEmbeddedReady || !claudeModulesReady) {
        console.error(
            "[verify:ai-runtimes] Claude is not staged correctly. Run pnpm run stage:ai.",
        );
        process.exit(1);
    }

    if (!claudeRuntimeDependencies.ok) {
        console.error(
            `[verify:ai-runtimes] Claude embedded runtime dependencies are incomplete: ${claudeRuntimeDependencies.missing.join(", ")}. Run pnpm run stage:ai.`,
        );
        process.exit(1);
    }
}

function verifyClaudeRuntimeDependencies() {
    const packageNames = [
        "@agentclientprotocol/sdk",
        "@anthropic-ai/claude-agent-sdk",
        "zod",
    ];
    const runtimeRequire = createRequire(
        path.join(claudeEmbeddedRoot, "package.json"),
    );
    const missing = [];

    for (const packageName of packageNames) {
        const packageDir = path.join(
            claudeEmbeddedNodeModules,
            ...packageName.split("/"),
        );
        if (!isFile(path.join(packageDir, "package.json"))) {
            missing.push(packageName);
            continue;
        }

        try {
            runtimeRequire.resolve(packageName);
        } catch {
            missing.push(packageName);
        }
    }

    return {
        missing,
        ok: missing.length === 0,
    };
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    verifyAiRuntimes();
}
