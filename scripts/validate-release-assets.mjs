import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    RELEASE_TARGETS,
    resolveReleaseTargetArtifacts,
} from "./release-target-metadata.mjs";
import { verifyLinuxReleaseArtifacts } from "./linux-release-metadata.mjs";
import { verifyMacReleaseArtifacts } from "./mac-release-metadata.mjs";
import { verifyWindowsReleaseArtifacts } from "./windows-release-metadata.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const defaultPackageJsonPath = path.join(repoRoot, "package.json");
const forbiddenSharedMetadataNames = new Set([
    "latest.yml",
    "latest-linux.yml",
    "latest-linux-arm64.yml",
]);

export function validateReleaseAssets({
    assetsDir,
    packageJson,
    version,
}) {
    const rootDir = path.resolve(assetsDir);
    assertDirectory(rootDir, "release assets directory");

    const productName = packageJson.build?.productName ?? packageJson.name;
    if (!productName) {
        throw new Error("package.json must define build.productName or name.");
    }

    const targetByArtifactName = new Map(
        RELEASE_TARGETS.map((target) => [target.artifactName, target]),
    );
    const actualArtifactNames = new Set(
        fs.readdirSync(rootDir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name),
    );

    for (const target of RELEASE_TARGETS) {
        if (!actualArtifactNames.has(target.artifactName)) {
            throw new Error(
                `Missing staged release artifact directory: ${target.artifactName}.`,
            );
        }
    }

    for (const artifactName of actualArtifactNames) {
        if (!targetByArtifactName.has(artifactName)) {
            throw new Error(
                `Unexpected staged release artifact directory: ${artifactName}.`,
            );
        }
    }

    assertNoDuplicateAssetNames(rootDir);
    assertNoForbiddenSharedMetadata(rootDir);

    const validatedTargets = [];
    for (const target of RELEASE_TARGETS) {
        const distDir = path.join(rootDir, target.artifactName);
        assertDirectory(distDir, target.artifactName);

        const targetArtifacts = resolveReleaseTargetArtifacts({
            distDir,
            packageJson,
            target,
            version,
        });

        for (const filePath of targetArtifacts.files) {
            assertFile(filePath, rootDir, `Missing expected ${target.id} asset`);
        }

        if (target.platform === "darwin") {
            verifyMacReleaseArtifacts({
                distDir,
                productName,
                relativePath: (filePath) => path.relative(rootDir, filePath),
                version: stripTagPrefix(version),
            });
        } else if (target.platform === "win32") {
            verifyWindowsReleaseArtifacts({
                distDir,
                productName,
                relativePath: (filePath) => path.relative(rootDir, filePath),
                targetArch: target.targetArch,
                version: stripTagPrefix(version),
            });
        } else if (target.platform === "linux") {
            verifyLinuxReleaseArtifacts({
                distDir,
                productName,
                relativePath: (filePath) => path.relative(rootDir, filePath),
                targetArch: target.targetArch,
                version: stripTagPrefix(version),
            });
        }

        validatedTargets.push(target.id);
    }

    return {
        targets: validatedTargets,
    };
}

function assertNoDuplicateAssetNames(rootDir) {
    const seen = new Map();
    for (const filePath of listFiles(rootDir)) {
        const basename = path.basename(filePath);
        const existingPath = seen.get(basename);
        if (existingPath) {
            throw new Error(
                `Duplicate staged release asset name ${basename}: ${path.relative(rootDir, existingPath)} and ${path.relative(rootDir, filePath)}.`,
            );
        }
        seen.set(basename, filePath);
    }
}

function assertNoForbiddenSharedMetadata(rootDir) {
    for (const filePath of listFiles(rootDir)) {
        const basename = path.basename(filePath);
        if (forbiddenSharedMetadataNames.has(basename)) {
            throw new Error(
                `Release assets must not include shared updater metadata: ${path.relative(rootDir, filePath)}.`,
            );
        }
    }
}

function listFiles(rootDir) {
    const files = [];
    const entries = fs.readdirSync(rootDir, { withFileTypes: true });
    for (const entry of entries) {
        const entryPath = path.join(rootDir, entry.name);
        if (entry.isDirectory()) {
            files.push(...listFiles(entryPath));
        } else if (entry.isFile()) {
            files.push(entryPath);
        }
    }
    return files;
}

function assertDirectory(directoryPath, label) {
    const stats = fs.existsSync(directoryPath) ? fs.statSync(directoryPath) : null;
    if (!stats?.isDirectory()) {
        throw new Error(`Missing ${label}: ${directoryPath}.`);
    }
}

function assertFile(filePath, rootDir, message) {
    const stats = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
    if (!stats?.isFile()) {
        throw new Error(`${message}: ${path.relative(rootDir, filePath)}.`);
    }
}

function stripTagPrefix(version) {
    return String(version).replace(/^v/u, "");
}

function parseArgs(argv) {
    const args = {
        assetsDir: path.join(repoRoot, ".artifacts", "release-assets"),
        packageJsonPath: defaultPackageJsonPath,
        version: null,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = argv[index + 1] ?? null;

        if (arg === "--assets-dir") {
            args.assetsDir = path.resolve(requireValue(arg, next));
            index += 1;
            continue;
        }
        if (arg === "--package-json") {
            args.packageJsonPath = path.resolve(requireValue(arg, next));
            index += 1;
            continue;
        }
        if (arg === "--version") {
            args.version = requireValue(arg, next);
            index += 1;
            continue;
        }

        throw new Error(
            `Unknown argument "${arg}". Supported args: --assets-dir, --package-json, --version.`,
        );
    }

    if (!args.version) {
        throw new Error("Missing required argument --version <X.Y.Z-or-tag>.");
    }

    return args;
}

function requireValue(arg, value) {
    if (!value) {
        throw new Error(`Missing value for ${arg}.`);
    }
    return value;
}

function main() {
    try {
        const args = parseArgs(process.argv.slice(2));
        const packageJson = JSON.parse(
            fs.readFileSync(args.packageJsonPath, "utf8"),
        );
        const result = validateReleaseAssets({
            assetsDir: args.assetsDir,
            packageJson,
            version: args.version,
        });

        console.log(
            `Validated staged release assets for ${result.targets.join(", ")}.`,
        );
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main();
}
