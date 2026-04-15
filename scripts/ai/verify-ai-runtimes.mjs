import fs from "node:fs";
import { pathToFileURL } from "node:url";

import {
    claudeEmbeddedDist,
    claudeEmbeddedNodeModules,
    claudeVendorDir,
    codexEmbeddedDir,
    codexBundledBinary,
    codexLegacyVendorTargetDir,
    codexTargetDebugBinary,
    codexTargetReleaseBinary,
    codexVendorDir,
    embeddedNodeBin,
    isExecutableFile,
    isFile,
    relativeToRepo,
} from "./_shared.mjs";

export function verifyAiRuntimes() {
    const codexVendorExists = fs.existsSync(codexVendorDir);
    const codexBundledReady = isExecutableFile(codexBundledBinary);
    const codexEmbeddedReady = isExecutableFile(codexTargetReleaseBinary);
    const codexEmbeddedDebugReady = isExecutableFile(codexTargetDebugBinary);
    const legacyTargetExists = fs.existsSync(codexLegacyVendorTargetDir);
    const claudeVendorExists = fs.existsSync(claudeVendorDir);
    const embeddedNodeReady = isExecutableFile(embeddedNodeBin);
    const claudeEmbeddedReady = isFile(`${claudeEmbeddedDist}/index.js`);
    const claudeModulesReady = fs.existsSync(claudeEmbeddedNodeModules);

    console.log(
        `[verify:ai-runtimes] codexVendor=${codexVendorExists ? "yes" : "no"} codexBundled=${codexBundledReady ? "yes" : "no"} codexEmbedded=${codexEmbeddedReady ? "yes" : "no"} codexEmbeddedDebug=${codexEmbeddedDebugReady ? "yes" : "no"} legacyTarget=${legacyTargetExists ? "yes" : "no"} claudeVendor=${claudeVendorExists ? "yes" : "no"} embeddedNode=${embeddedNodeReady ? "yes" : "no"} claudeEmbedded=${claudeEmbeddedReady ? "yes" : "no"} claudeModules=${claudeModulesReady ? "yes" : "no"}`,
    );

    if (!codexVendorExists) {
        console.error(
            "[verify:ai-runtimes] Missing vendor/codex-acp. The app cannot stage the bundled runtime.",
        );
        process.exit(1);
    }

    if (!codexBundledReady) {
        console.error(
            `[verify:ai-runtimes] ${relativeToRepo(codexBundledBinary)} is missing. Run pnpm run stage:ai.`,
        );
        process.exit(1);
    }

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
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    verifyAiRuntimes();
}
