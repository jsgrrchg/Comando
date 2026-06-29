import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import {
    APT_DEFAULT_CODENAME,
    APT_DEFAULT_COMPONENT,
    APT_DEFAULT_SUITE,
    APT_LAYOUT_FLAT_RELEASE,
    APT_LABEL,
    APT_ORIGIN,
    APT_PACKAGE_CHECKSUMS,
    APT_PACKAGE_NAME,
    APT_PUBLIC_KEY_FILE_NAME,
    APT_RELEASE_CHECKSUMS,
    APT_SOURCES_EXAMPLE_FILE_NAME,
    APT_SUPPORTED_ARCHITECTURES,
    getDebianControlField,
    hashFile,
    listFilesRecursively,
    normalizeAptComponent,
    normalizeAptLayout,
    normalizeAptSuite,
    normalizeDebianArchitecture,
    normalizeReleaseVersion,
    parseDebianControlFile,
    parseDebianControlStanza,
    parseDebianReleaseAssetName,
} from "./apt-repo-lib.mjs";

function parseArgs(argv) {
    const args = {
        aptDir: null,
        component: APT_DEFAULT_COMPONENT,
        layout: APT_LAYOUT_FLAT_RELEASE,
        packageAssetsDir: null,
        skipSignatureCheck: false,
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
        if (arg === "--apt-dir") {
            args.aptDir = path.resolve(next);
            index += 1;
            continue;
        }
        if (arg === "--package-assets-dir") {
            args.packageAssetsDir = path.resolve(next);
            index += 1;
            continue;
        }
        if (arg === "--version") {
            args.version = next;
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
        if (arg === "--skip-signature-check") {
            args.skipSignatureCheck = true;
            continue;
        }

        throw new Error(
            `Unknown argument "${arg}". Supported args: --layout, --apt-dir, --package-assets-dir, --version, --suite, --component, --skip-signature-check.`,
        );
    }

    if (!args.aptDir) {
        throw new Error("Missing required argument --apt-dir <path>.");
    }

    return {
        ...args,
        component: normalizeAptComponent(args.component),
        layout: normalizeAptLayout(args.layout),
        suite: normalizeAptSuite(args.suite),
        version: args.version ? normalizeReleaseVersion(args.version) : null,
    };
}

function assertFileExists(filePath, label = filePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`Missing ${label}: ${filePath}`);
    }
}

function parseReleaseChecksums(releaseFields, fieldName) {
    const value = getDebianControlField(releaseFields, fieldName);
    if (!value) {
        throw new Error(`APT Release file is missing ${fieldName}.`);
    }

    return value
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            const [hash, size, relativePath] = line.split(/\s+/u);
            if (!hash || !size || !relativePath) {
                throw new Error(`Invalid ${fieldName} line: ${line}`);
            }
            return {
                hash,
                relativePath,
                sizeBytes: Number.parseInt(size, 10),
            };
        });
}

function validateReleaseFile({ aptDir, suite }) {
    const releasePath = path.join(aptDir, "Release");
    const releaseFields = parseDebianControlStanza(
        fs.readFileSync(releasePath, "utf8"),
    );
    const expectedFields = {
        Architectures: APT_SUPPORTED_ARCHITECTURES.join(" "),
        Codename: APT_DEFAULT_CODENAME,
        Label: APT_LABEL,
        Origin: APT_ORIGIN,
        Suite: suite,
    };

    for (const [fieldName, expectedValue] of Object.entries(expectedFields)) {
        const actualValue = getDebianControlField(releaseFields, fieldName);
        if (actualValue !== expectedValue) {
            throw new Error(
                `APT Release ${fieldName} mismatch: expected "${expectedValue}", received "${actualValue ?? "missing"}".`,
            );
        }
    }

    for (const { fieldName, algorithm } of APT_RELEASE_CHECKSUMS) {
        for (const entry of parseReleaseChecksums(releaseFields, fieldName)) {
            const filePath = path.join(aptDir, entry.relativePath);
            assertFileExists(filePath, `Release ${fieldName} target`);

            const actualSize = fs.statSync(filePath).size;
            if (actualSize !== entry.sizeBytes) {
                throw new Error(
                    `${entry.relativePath} size mismatch in ${fieldName}: expected ${entry.sizeBytes}, received ${actualSize}.`,
                );
            }

            const actualHash = hashFile(filePath, algorithm);
            if (actualHash !== entry.hash) {
                throw new Error(
                    `${entry.relativePath} hash mismatch in ${fieldName}: expected ${entry.hash}, received ${actualHash}.`,
                );
            }
        }
    }
}

function findPackageAsset(packageAssetsDir, filename) {
    if (!packageAssetsDir) {
        return null;
    }

    const matches = listFilesRecursively(packageAssetsDir).filter(
        (filePath) => path.basename(filePath) === filename,
    );
    if (matches.length !== 1) {
        throw new Error(
            `Expected exactly one package asset named ${filename} in ${packageAssetsDir}, found ${matches.length}.`,
        );
    }
    return matches[0];
}

function resolveFlatPackageFilename({
    arch,
    filename,
    packageAssetsDir,
    version,
}) {
    const normalizedFilename = path.posix.normalize(filename);
    if (
        filename !== normalizedFilename ||
        filename.includes("\\") ||
        filename.includes("/") ||
        /^https?:\/\//iu.test(filename) ||
        path.posix.isAbsolute(normalizedFilename)
    ) {
        throw new Error(
            `${arch} Packages contains invalid Filename "${filename}". Expected a GitHub Release asset file name without URL or path separators.`,
        );
    }

    const metadata = parseDebianReleaseAssetName(normalizedFilename);
    if (!metadata) {
        throw new Error(
            `${arch} Packages contains invalid Filename "${filename}". Expected a Comando Debian release asset name.`,
        );
    }
    if (metadata.architecture !== arch) {
        throw new Error(
            `${arch} Packages Filename "${filename}" targets ${metadata.architecture}.`,
        );
    }
    if (version && metadata.version !== version) {
        throw new Error(
            `${arch} Packages Filename "${filename}" does not match version ${version}.`,
        );
    }

    return findPackageAsset(packageAssetsDir, normalizedFilename);
}

function validatePackageStanza({
    architecture,
    packageAssetsDir,
    stanza,
    version,
}) {
    const arch = normalizeDebianArchitecture(architecture);
    const packageName = getDebianControlField(stanza, "Package");
    const packageVersion = getDebianControlField(stanza, "Version");
    const packageArchitecture = getDebianControlField(stanza, "Architecture");
    const filename = getDebianControlField(stanza, "Filename");
    const size = Number.parseInt(getDebianControlField(stanza, "Size"), 10);

    if (packageName !== APT_PACKAGE_NAME) {
        throw new Error(
            `${arch} Packages contains unexpected package "${packageName}".`,
        );
    }
    if (packageArchitecture !== arch) {
        throw new Error(
            `${arch} Packages contains unexpected Architecture "${packageArchitecture}".`,
        );
    }
    if (version && packageVersion !== version) {
        throw new Error(
            `${arch} Packages contains version "${packageVersion}", expected "${version}".`,
        );
    }
    if (!filename) {
        throw new Error(`${arch} Packages contains package with missing Filename.`);
    }

    const packagePath = resolveFlatPackageFilename({
        arch,
        filename,
        packageAssetsDir,
        version: packageVersion,
    });

    if (packagePath) {
        if (fs.statSync(packagePath).size !== size) {
            throw new Error(`${filename} Size does not match package file.`);
        }

        for (const { fieldName, algorithm } of APT_PACKAGE_CHECKSUMS) {
            const expectedHash = getDebianControlField(stanza, fieldName);
            if (!expectedHash) {
                throw new Error(`${filename} is missing ${fieldName}.`);
            }
            const actualHash = hashFile(packagePath, algorithm);
            if (actualHash !== expectedHash) {
                throw new Error(
                    `${filename} ${fieldName} mismatch: expected ${expectedHash}, received ${actualHash}.`,
                );
            }
        }
    }
}

function validatePackages({ aptDir, packageAssetsDir, version }) {
    const packagesPath = path.join(aptDir, "Packages");
    const packagesGzipPath = path.join(aptDir, "Packages.gz");
    assertFileExists(packagesPath, "Packages");
    assertFileExists(packagesGzipPath, "Packages.gz");

    const packagesContent = fs.readFileSync(packagesPath, "utf8");
    const gzippedContent = zlib.gunzipSync(
        fs.readFileSync(packagesGzipPath),
    ).toString("utf8");
    if (packagesContent !== gzippedContent) {
        throw new Error("Packages.gz does not match Packages.");
    }

    const stanzas = parseDebianControlFile(packagesContent);
    if (stanzas.length !== APT_SUPPORTED_ARCHITECTURES.length) {
        throw new Error(
            `Expected ${APT_SUPPORTED_ARCHITECTURES.length} package stanzas, found ${stanzas.length}.`,
        );
    }

    const stanzasByArchitecture = new Map(
        stanzas.map((stanza) => [
            getDebianControlField(stanza, "Architecture"),
            stanza,
        ]),
    );

    for (const architecture of APT_SUPPORTED_ARCHITECTURES) {
        const stanza = stanzasByArchitecture.get(architecture);
        if (!stanza) {
            throw new Error(`Packages is missing ${architecture} stanza.`);
        }
        validatePackageStanza({
            architecture,
            packageAssetsDir,
            stanza,
            version,
        });
    }
}

function runGpg(args) {
    const result = childProcess.spawnSync("gpg", args, {
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 16,
    });
    if (result.status !== 0) {
        throw new Error(
            [
                `gpg command failed: gpg ${args.join(" ")}`,
                result.error?.message,
                result.stderr?.trim(),
                result.stdout?.trim(),
            ]
                .filter(Boolean)
                .join("\n"),
        );
    }
}

function validateSignatures(aptDir) {
    runGpg(["--batch", "--verify", path.join(aptDir, "InRelease")]);
    runGpg([
        "--batch",
        "--verify",
        path.join(aptDir, "Release.gpg"),
        path.join(aptDir, "Release"),
    ]);
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    assertFileExists(path.join(args.aptDir, "Release"), "Release");
    assertFileExists(path.join(args.aptDir, APT_SOURCES_EXAMPLE_FILE_NAME));

    if (!args.skipSignatureCheck) {
        assertFileExists(path.join(args.aptDir, "InRelease"), "InRelease");
        assertFileExists(path.join(args.aptDir, "Release.gpg"), "Release.gpg");
        assertFileExists(
            path.join(args.aptDir, APT_PUBLIC_KEY_FILE_NAME),
            APT_PUBLIC_KEY_FILE_NAME,
        );
        validateSignatures(args.aptDir);
    }

    validateReleaseFile({
        aptDir: args.aptDir,
        suite: args.suite,
    });
    validatePackages({
        aptDir: args.aptDir,
        packageAssetsDir: args.packageAssetsDir,
        version: args.version,
    });

    console.log(`Validated APT repository: ${args.aptDir}`);
}

main();
