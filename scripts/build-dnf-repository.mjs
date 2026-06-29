import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
    DNF_REPO_EXAMPLE_FILE_NAME,
    DNF_SUPPORTED_ARCHITECTURES,
    buildComandoRepoExample,
    buildDnfRepoRoot,
    buildGitHubReleaseRpmLocationPrefix,
    buildRpmReleaseAssetName,
} from "./dnf-repo-lib.mjs";
import {
    listFilesRecursively,
    normalizeReleaseVersion,
    parseGitHubRepoSlug,
} from "./apt-repo-lib.mjs";

function parseArgs(argv) {
    const args = {
        pagesDir: null,
        releaseAssetsDir: null,
        repoSlug: null,
        tag: null,
        version: null,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = argv[index + 1] ?? null;

        if (arg === "--version") {
            args.version = next;
            index += 1;
            continue;
        }
        if (arg === "--tag") {
            args.tag = next;
            index += 1;
            continue;
        }
        if (arg === "--release-assets-dir") {
            args.releaseAssetsDir = path.resolve(next);
            index += 1;
            continue;
        }
        if (arg === "--pages-dir") {
            args.pagesDir = path.resolve(next);
            index += 1;
            continue;
        }
        if (arg === "--repo-slug") {
            args.repoSlug = next;
            index += 1;
            continue;
        }

        throw new Error(
            `Unknown argument "${arg}". Supported args: --version, --tag, --release-assets-dir, --pages-dir, --repo-slug.`,
        );
    }

    if (!args.version) {
        throw new Error("Missing required argument --version <X.Y.Z-or-tag>.");
    }
    if (!args.tag) {
        throw new Error("Missing required argument --tag <vX.Y.Z>.");
    }
    if (!args.releaseAssetsDir) {
        throw new Error("Missing required argument --release-assets-dir <path>.");
    }
    if (!args.pagesDir) {
        throw new Error("Missing required argument --pages-dir <path>.");
    }
    if (!args.repoSlug) {
        throw new Error("Missing required argument --repo-slug <owner/repo>.");
    }

    parseGitHubRepoSlug(args.repoSlug);

    return {
        ...args,
        version: normalizeReleaseVersion(args.version),
    };
}

function runCommand(command, args) {
    const result = childProcess.spawnSync(command, args, {
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 16,
        stdio: ["ignore", "pipe", "pipe"],
    });

    if (result.status !== 0) {
        throw new Error(
            [
                `Command failed: ${command} ${args.join(" ")}`,
                result.error?.message,
                result.stderr?.trim(),
                result.stdout?.trim(),
            ]
                .filter(Boolean)
                .join("\n"),
        );
    }

    return result.stdout ?? "";
}

function assertCreaterepoAvailable() {
    try {
        runCommand("createrepo_c", ["--version"]);
    } catch (error) {
        throw new Error(
            `createrepo_c is required to build DNF metadata from real RPM headers.\n${error.message}`,
        );
    }
}

function findSingleReleaseAsset(releaseAssetsDir, assetName) {
    const matches = listFilesRecursively(releaseAssetsDir).filter(
        (filePath) => path.basename(filePath) === assetName,
    );
    if (matches.length !== 1) {
        throw new Error(
            `Expected exactly one release asset named ${assetName} in ${releaseAssetsDir}, found ${matches.length}.`,
        );
    }
    return matches[0];
}

function buildCreaterepoArgs({ locationPrefix, repositoryDir }) {
    return [
        "--checksum",
        "sha256",
        "--general-compress-type",
        "gz",
        "--no-database",
        "--simple-md-filenames",
        "--location-prefix",
        locationPrefix,
        repositoryDir,
    ];
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    assertCreaterepoAvailable();

    const dnfDir = buildDnfRepoRoot(args.pagesDir);
    fs.rmSync(dnfDir, { force: true, recursive: true });
    fs.mkdirSync(dnfDir, { recursive: true });

    const tempRepositoryDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "comando-dnf-repo-"),
    );
    const indexedPackages = [];

    try {
        // createrepo_c reads RPM headers locally, then DNF downloads packages from GitHub Releases.
        const locationPrefix = buildGitHubReleaseRpmLocationPrefix(
            args.repoSlug,
            args.tag,
        );

        for (const architecture of DNF_SUPPORTED_ARCHITECTURES) {
            const assetName = buildRpmReleaseAssetName(
                args.version,
                architecture,
            );
            const sourcePath = findSingleReleaseAsset(
                args.releaseAssetsDir,
                assetName,
            );
            fs.copyFileSync(sourcePath, path.join(tempRepositoryDir, assetName));
            indexedPackages.push(`${assetName} (${architecture})`);
        }

        runCommand(
            "createrepo_c",
            buildCreaterepoArgs({
                locationPrefix,
                repositoryDir: tempRepositoryDir,
            }),
        );

        fs.cpSync(
            path.join(tempRepositoryDir, "repodata"),
            path.join(dnfDir, "repodata"),
            { recursive: true },
        );
    } finally {
        fs.rmSync(tempRepositoryDir, { force: true, recursive: true });
    }

    fs.writeFileSync(
        path.join(dnfDir, DNF_REPO_EXAMPLE_FILE_NAME),
        buildComandoRepoExample(),
        "utf8",
    );

    console.log(`DNF repository built at ${dnfDir}`);
    console.log(`Packages indexed from RPM headers: ${indexedPackages.join(", ")}`);
}

main();
