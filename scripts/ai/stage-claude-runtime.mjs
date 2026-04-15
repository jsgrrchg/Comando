import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
    claudeBundledBinary,
    claudeEmbeddedDist,
    claudeEmbeddedNodeModules,
    claudeEmbeddedRoot,
    claudeVendorDir,
    copyExecutable,
    copyTree,
    embeddedNodeBin,
    embeddedNodeRoot,
    ensureDir,
    isExecutableFile,
    isFile,
    nodeBinaryName,
    relativeToRepo,
    resolveFromPath,
    resetDir,
} from "./_shared.mjs";

const CLAUDE_VENDOR_DIST_DIR = path.join(claudeVendorDir, "dist");
const CLAUDE_VENDOR_ENTRY = path.join(CLAUDE_VENDOR_DIST_DIR, "index.js");
const CLAUDE_VENDOR_NODE_MODULES = path.join(claudeVendorDir, "node_modules");
const CLAUDE_VENDOR_PACKAGE_JSON = path.join(claudeVendorDir, "package.json");
const CLAUDE_VENDOR_LICENSE = path.join(claudeVendorDir, "LICENSE");
const CLAUDE_VENDOR_README = path.join(claudeVendorDir, "README.md");

function resolveNodeBinary() {
    const override = process.env.COMANDO_EMBEDDED_NODE_BIN?.trim() ?? "";
    if (override) {
        const resolved = path.isAbsolute(override)
            ? override
            : (resolveFromPath(override) ?? path.resolve(override));

        if (!isExecutableFile(resolved)) {
            throw new Error(
                `COMANDO_EMBEDDED_NODE_BIN points to a non-executable binary: ${resolved}`,
            );
        }

        return resolved;
    }

    const fromPath = resolveFromPath("node");
    if (fromPath) {
        return fromPath;
    }

    if (isExecutableFile(process.execPath)) {
        return process.execPath;
    }

    throw new Error(
        "No Node binary found for embedding Claude. Install Node or define COMANDO_EMBEDDED_NODE_BIN.",
    );
}

function ensureClaudeVendorExists() {
    if (!fs.existsSync(claudeVendorDir)) {
        throw new Error(
            "vendor/Claude-agent-acp-upstream is missing. Import the vendor from reference app before staging Claude.",
        );
    }

    if (!isFile(CLAUDE_VENDOR_PACKAGE_JSON)) {
        throw new Error(
            "Missing vendor/Claude-agent-acp-upstream/package.json. The Claude vendor is incomplete.",
        );
    }

    if (!isFile(CLAUDE_VENDOR_ENTRY)) {
        throw new Error(
            "Missing vendor/Claude-agent-acp-upstream/dist/index.js. The Claude runtime is not built.",
        );
    }

    if (!fs.existsSync(CLAUDE_VENDOR_NODE_MODULES)) {
        throw new Error(
            "Missing vendor/Claude-agent-acp-upstream/node_modules. The Claude runtime requires vendored dependencies.",
        );
    }
}

function stageEmbeddedNodeRuntime() {
    const sourceNode = resolveNodeBinary();
    resetDir(embeddedNodeRoot);
    copyExecutable(sourceNode, embeddedNodeBin);

    console.log(
        `[stage:claude-runtime] node ${relativeToRepo(sourceNode)} -> ${relativeToRepo(embeddedNodeBin)}`,
    );
}

function stageEmbeddedClaudeProject() {
    ensureClaudeVendorExists();

    resetDir(claudeEmbeddedRoot);
    copyTree(CLAUDE_VENDOR_DIST_DIR, claudeEmbeddedDist);
    copyTree(CLAUDE_VENDOR_NODE_MODULES, claudeEmbeddedNodeModules);
    fs.copyFileSync(
        CLAUDE_VENDOR_PACKAGE_JSON,
        path.join(claudeEmbeddedRoot, "package.json"),
    );

    if (isFile(CLAUDE_VENDOR_LICENSE)) {
        fs.copyFileSync(
            CLAUDE_VENDOR_LICENSE,
            path.join(claudeEmbeddedRoot, "LICENSE"),
        );
    }

    if (isFile(CLAUDE_VENDOR_README)) {
        fs.copyFileSync(
            CLAUDE_VENDOR_README,
            path.join(claudeEmbeddedRoot, "README.md"),
        );
    }

    console.log(
        `[stage:claude-runtime] vendor -> ${relativeToRepo(claudeEmbeddedRoot)}`,
    );
}

function removeLegacyStandaloneBundle() {
    if (!isExecutableFile(claudeBundledBinary)) {
        return;
    }

    fs.rmSync(claudeBundledBinary, { force: true });
}

function validateStagedRuntime() {
    if (!isExecutableFile(embeddedNodeBin)) {
        throw new Error(
            `The embedded Node is not ready at ${relativeToRepo(embeddedNodeBin)}.`,
        );
    }

    if (!isFile(path.join(claudeEmbeddedRoot, "package.json"))) {
        throw new Error(
            `Missing package.json in ${relativeToRepo(claudeEmbeddedRoot)}.`,
        );
    }

    if (!isFile(path.join(claudeEmbeddedDist, "index.js"))) {
        throw new Error(
            `Missing dist/index.js in ${relativeToRepo(claudeEmbeddedRoot)}.`,
        );
    }

    if (!fs.existsSync(claudeEmbeddedNodeModules)) {
        throw new Error(
            `Missing node_modules in ${relativeToRepo(claudeEmbeddedRoot)}.`,
        );
    }
}

export function stageClaudeRuntime() {
    ensureDir(path.dirname(embeddedNodeBin));
    removeLegacyStandaloneBundle();
    stageEmbeddedNodeRuntime();
    stageEmbeddedClaudeProject();
    validateStagedRuntime();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    stageClaudeRuntime();
}
