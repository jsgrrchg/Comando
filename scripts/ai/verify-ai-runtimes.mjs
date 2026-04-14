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
            "[verify:ai-runtimes] Falta vendor/codex-acp. La app no podrá stagear el runtime bundleado.",
        );
        process.exit(1);
    }

    if (!codexBundledReady) {
        console.error(
            `[verify:ai-runtimes] Falta ${relativeToRepo(codexBundledBinary)}. Corre pnpm run stage:ai.`,
        );
        process.exit(1);
    }

    if (!codexEmbeddedReady) {
        console.warn(
            `[verify:ai-runtimes] Aún no existe ${relativeToRepo(codexEmbeddedDir)} con un release compilado. Se puede regenerar con pnpm run stage:ai.`,
        );
    }

    if (!claudeVendorExists) {
        console.error(
            "[verify:ai-runtimes] Falta vendor/Claude-agent-acp-upstream. La app no podrá stagear Claude.",
        );
        process.exit(1);
    }

    if (!embeddedNodeReady || !claudeEmbeddedReady || !claudeModulesReady) {
        console.error(
            "[verify:ai-runtimes] Claude no quedó stageado correctamente. Corre pnpm run stage:ai.",
        );
        process.exit(1);
    }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    verifyAiRuntimes();
}
