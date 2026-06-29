import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import {
    APT_DEFAULT_COMPONENT,
    APT_DEFAULT_SUITE,
    APT_EXACT_PATH_SUITE,
    APT_LAYOUT_FLAT_RELEASE,
    APT_PACKAGE_NAME,
    APT_SOURCES_EXAMPLE_FILE_NAME,
    APT_SUPPORTED_ARCHITECTURES,
    buildAptReleaseContent,
    buildComandoSourcesExample,
    buildDebianReleaseAssetName,
    buildGitHubReleaseDownloadBaseUrl,
    getDebianControlField,
    getFileHashes,
    listFilesRecursively,
    normalizeAptComponent,
    normalizeAptLayout,
    normalizeAptSuite,
    normalizeReleaseVersion,
    parseDebianControlStanza,
    renderPackagesStanza,
} from "./apt-repo-lib.mjs";

function parseArgs(argv) {
    const args = {
        component: APT_DEFAULT_COMPONENT,
        layout: APT_LAYOUT_FLAT_RELEASE,
        outputDir: null,
        releaseAssetsDir: null,
        repoSlug: "jsgrrchg/Comando",
        suite: APT_DEFAULT_SUITE,
        version: null,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = argv[index + 1] ?? null;

        if (arg === "--layout") {
            args.layout = next;
            index += 1;
            continue;
        }
        if (arg === "--version") {
            args.version = next;
            index += 1;
            continue;
        }
        if (arg === "--release-assets-dir") {
            args.releaseAssetsDir = path.resolve(next);
            index += 1;
            continue;
        }
        if (arg === "--output-dir") {
            args.outputDir = path.resolve(next);
            index += 1;
            continue;
        }
        if (arg === "--repo-slug") {
            args.repoSlug = next;
            index += 1;
            continue;
        }
        if (arg === "--suite") {
            args.suite = next;
            index += 1;
            continue;
        }
        if (arg === "--component") {
            args.component = next;
            index += 1;
            continue;
        }

        throw new Error(
            `Unknown argument "${arg}". Supported args: --layout, --version, --release-assets-dir, --output-dir, --repo-slug, --suite, --component.`,
        );
    }

    if (!args.version) {
        throw new Error("Missing required argument --version <X.Y.Z-or-tag>.");
    }
    if (!args.releaseAssetsDir) {
        throw new Error(
            "Missing required argument --release-assets-dir <path>.",
        );
    }
    if (!args.outputDir) {
        throw new Error("Missing required argument --output-dir <path>.");
    }

    return {
        ...args,
        component: normalizeAptComponent(args.component),
        layout: normalizeAptLayout(args.layout),
        suite: normalizeAptSuite(args.suite),
        version: normalizeReleaseVersion(args.version),
    };
}

function runCommand(command, args, options = {}) {
    const result = childProcess.spawnSync(command, args, {
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 16,
        ...options,
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

function readDebianControlFields(packagePath) {
    const output = runCommand("dpkg-deb", ["-f", packagePath]);
    const fields = parseDebianControlStanza(output);
    if (fields.length === 0) {
        throw new Error(`dpkg-deb returned no control fields for ${packagePath}.`);
    }
    return fields;
}

function validateDebianPackageFields({
    architecture,
    assetName,
    fields,
    version,
}) {
    const expected = {
        Architecture: architecture,
        Package: APT_PACKAGE_NAME,
        Version: version,
    };

    for (const [fieldName, expectedValue] of Object.entries(expected)) {
        const actualValue = getDebianControlField(fields, fieldName);
        if (actualValue !== expectedValue) {
            throw new Error(
                `${assetName} ${fieldName} mismatch: expected "${expectedValue}", received "${actualValue ?? "missing"}".`,
            );
        }
    }
}

function buildPackageStanzas({ releaseAssetsDir, version }) {
    return APT_SUPPORTED_ARCHITECTURES.map((architecture) => {
        const assetName = buildDebianReleaseAssetName(version, architecture);
        const packagePath = findSingleReleaseAsset(releaseAssetsDir, assetName);
        const fields = readDebianControlFields(packagePath);

        validateDebianPackageFields({
            architecture,
            assetName,
            fields,
            version,
        });

        return renderPackagesStanza({
            controlFields: fields,
            filename: assetName,
            hashes: getFileHashes(packagePath),
            sizeBytes: fs.statSync(packagePath).size,
        });
    });
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const outputDir = args.outputDir;
    fs.rmSync(outputDir, { force: true, recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });

    const packagesContent = `${buildPackageStanzas({
        releaseAssetsDir: args.releaseAssetsDir,
        version: args.version,
    }).join("\n")}\n`;
    fs.writeFileSync(path.join(outputDir, "Packages"), packagesContent, "utf8");
    fs.writeFileSync(
        path.join(outputDir, "Packages.gz"),
        zlib.gzipSync(Buffer.from(packagesContent, "utf8")),
    );

    const releaseFiles = ["Packages", "Packages.gz"].map((relativePath) => {
        const filePath = path.join(outputDir, relativePath);
        return {
            hashes: getFileHashes(filePath),
            relativePath,
            sizeBytes: fs.statSync(filePath).size,
        };
    });

    fs.writeFileSync(
        path.join(outputDir, "Release"),
        buildAptReleaseContent({
            component: null,
            files: releaseFiles,
            suite: args.suite,
        }),
        "utf8",
    );
    fs.writeFileSync(
        path.join(outputDir, APT_SOURCES_EXAMPLE_FILE_NAME),
        buildComandoSourcesExample(
            buildGitHubReleaseDownloadBaseUrl(args.repoSlug, "latest"),
            {
                component: null,
                suite: APT_EXACT_PATH_SUITE,
            },
        ),
        "utf8",
    );

    console.log(`Wrote APT metadata: ${outputDir}`);
}

main();
