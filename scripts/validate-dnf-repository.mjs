import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import {
    DNF_DEFAULT_BASE_URL,
    DNF_PACKAGE_NAME,
    DNF_PUBLIC_KEY_FILE_NAME,
    DNF_REPO_EXAMPLE_FILE_NAME,
    DNF_SUPPORTED_ARCHITECTURES,
    buildRpmReleaseAssetName,
} from "./dnf-repo-lib.mjs";
import {
    listFilesRecursively,
    normalizeReleaseVersion,
} from "./apt-repo-lib.mjs";

function parseArgs(argv) {
    const args = {
        dnfDir: null,
        skipSignatureCheck: false,
        version: null,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = argv[index + 1] ?? null;

        if (arg === "--dnf-dir") {
            args.dnfDir = path.resolve(next);
            index += 1;
            continue;
        }
        if (arg === "--version") {
            args.version = next;
            index += 1;
            continue;
        }
        if (arg === "--skip-signature-check") {
            args.skipSignatureCheck = true;
            continue;
        }

        throw new Error(
            `Unknown argument "${arg}". Supported args: --dnf-dir, --version, --skip-signature-check.`,
        );
    }

    if (!args.dnfDir) {
        throw new Error("Missing required argument --dnf-dir <path>.");
    }

    return {
        ...args,
        version: args.version ? normalizeReleaseVersion(args.version) : null,
    };
}

function assertFileExists(filePath, label = filePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`Missing ${label}: ${filePath}`);
    }
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function validateNoPackageBinaries(dnfDir) {
    const packageBinary = listFilesRecursively(dnfDir).find((filePath) =>
        [".AppImage", ".deb", ".dmg", ".exe", ".rpm"].some((extension) =>
            filePath.endsWith(extension),
        ),
    );

    if (packageBinary) {
        throw new Error(
            `DNF repository must keep package binaries on GitHub Releases, not in gh-pages metadata: ${packageBinary}`,
        );
    }
}

function validateRepomd(dnfDir) {
    const repomdPath = path.join(dnfDir, "repodata", "repomd.xml");
    assertFileExists(repomdPath, "repomd.xml");

    const content = fs.readFileSync(repomdPath, "utf8");
    if (!content.includes('<repomd xmlns="http://linux.duke.edu/metadata/repo"')) {
        throw new Error("repomd.xml has an invalid root element.");
    }
    if (!content.includes('<data type="primary">')) {
        throw new Error("repomd.xml is missing primary metadata.");
    }
    if (!/<location href="repodata\/[^"]+"/u.test(content)) {
        throw new Error("repomd.xml is missing a repodata location href.");
    }
    if (!/<checksum type="sha256">[a-f0-9]{64}<\/checksum>/u.test(content)) {
        throw new Error("repomd.xml is missing a SHA256 checksum.");
    }
}

function validatePrimaryXml(dnfDir, version) {
    const primaryPath = path.join(dnfDir, "repodata", "primary.xml.gz");
    assertFileExists(primaryPath, "primary.xml.gz");

    const content = zlib.gunzipSync(fs.readFileSync(primaryPath)).toString("utf8");
    if (!content.includes('<package type="rpm">')) {
        throw new Error("primary.xml is missing RPM package entries.");
    }
    if (!content.includes(`<name>${DNF_PACKAGE_NAME}</name>`)) {
        throw new Error(`primary.xml is missing package name "${DNF_PACKAGE_NAME}".`);
    }
    if (!content.includes("<rpm:provides>")) {
        throw new Error("primary.xml is missing RPM provides metadata.");
    }
    if (!content.includes("<rpm:requires>")) {
        throw new Error("primary.xml is missing RPM requires metadata.");
    }
    if (!content.includes("<rpm:header-range ")) {
        throw new Error("primary.xml is missing RPM header range metadata.");
    }

    const packageCount = (content.match(/<package type="rpm">/gu) ?? []).length;
    if (packageCount !== DNF_SUPPORTED_ARCHITECTURES.length) {
        throw new Error(
            `primary.xml must contain exactly ${DNF_SUPPORTED_ARCHITECTURES.length} RPM packages, found ${packageCount}.`,
        );
    }

    for (const architecture of DNF_SUPPORTED_ARCHITECTURES) {
        if (!content.includes(`<arch>${architecture}</arch>`)) {
            throw new Error(`primary.xml is missing ${architecture} package metadata.`);
        }
        if (version && !content.includes(`<version epoch="0" ver="${version}"`)) {
            throw new Error(`primary.xml is missing version ${version}.`);
        }

        const expectedAssetName = version
            ? buildRpmReleaseAssetName(version, architecture)
            : null;
        const assetPattern = expectedAssetName
            ? escapeRegExp(expectedAssetName)
            : "[^/]+\\.rpm";
        const locationPattern = new RegExp(
            `<location href="(https?:\\/\\/[^"]*\\/releases\\/download\\/[^"]*\\/${assetPattern})"`,
            "u",
        );
        const locationMatch = content.match(locationPattern);
        if (!locationMatch) {
            throw new Error(
                expectedAssetName
                    ? `primary.xml is missing GitHub Release location for ${expectedAssetName}.`
                    : "primary.xml is missing GitHub Release location href.",
            );
        }
        try {
            new URL(locationMatch[1]);
        } catch {
            throw new Error(`primary.xml has an invalid location URL: ${locationMatch[1]}`);
        }
    }
}

function validateFilelistsXml(dnfDir) {
    const filelistsPath = path.join(dnfDir, "repodata", "filelists.xml.gz");
    assertFileExists(filelistsPath, "filelists.xml.gz");

    const content = zlib
        .gunzipSync(fs.readFileSync(filelistsPath))
        .toString("utf8");
    if (!content.includes(`name="${DNF_PACKAGE_NAME}"`)) {
        throw new Error(`filelists.xml is missing package name "${DNF_PACKAGE_NAME}".`);
    }
    if (!/<file(?:\s|>)/u.test(content)) {
        throw new Error("filelists.xml is missing installed file entries.");
    }
}

function validateRepoExample(dnfDir) {
    const examplePath = path.join(dnfDir, DNF_REPO_EXAMPLE_FILE_NAME);
    assertFileExists(examplePath, "repo example file");

    const content = fs.readFileSync(examplePath, "utf8");
    const expectedLines = [
        "[comando]",
        "gpgcheck=1",
        "repo_gpgcheck=1",
        `gpgkey=${DNF_DEFAULT_BASE_URL}/${DNF_PUBLIC_KEY_FILE_NAME}`,
    ];

    for (const line of expectedLines) {
        if (!content.includes(line)) {
            throw new Error(`repo example is missing "${line}".`);
        }
    }
}

function validateRepomdSignature(dnfDir) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "comando-dnf-gpg-"));
    const keyringPath = path.join(tempDir, "comando-keyring.gpg");
    const publicKeyPath = path.join(dnfDir, DNF_PUBLIC_KEY_FILE_NAME);
    const repomdPath = path.join(dnfDir, "repodata", "repomd.xml");
    const repomdSignaturePath = path.join(
        dnfDir,
        "repodata",
        "repomd.xml.asc",
    );

    try {
        childProcess.spawnSync(
            "gpg",
            [
                "--batch",
                "--yes",
                "--no-default-keyring",
                "--keyring",
                keyringPath,
                "--import",
                publicKeyPath,
            ],
            { encoding: "utf8" },
        );
        const verifyResult = childProcess.spawnSync(
            "gpg",
            [
                "--batch",
                "--no-default-keyring",
                "--keyring",
                keyringPath,
                "--verify",
                repomdSignaturePath,
                repomdPath,
            ],
            { encoding: "utf8" },
        );
        if (verifyResult.status !== 0) {
            throw new Error(
                `GPG signature verification failed:\n${verifyResult.stderr}`,
            );
        }
    } finally {
        fs.rmSync(tempDir, { force: true, recursive: true });
    }
}

function main() {
    const args = parseArgs(process.argv.slice(2));

    assertFileExists(args.dnfDir, "DNF repository root");
    assertFileExists(path.join(args.dnfDir, "repodata"), "repodata directory");
    assertFileExists(path.join(args.dnfDir, "repodata", "repomd.xml.asc"), "repomd.xml.asc");
    assertFileExists(
        path.join(args.dnfDir, DNF_PUBLIC_KEY_FILE_NAME),
        DNF_PUBLIC_KEY_FILE_NAME,
    );

    validateNoPackageBinaries(args.dnfDir);
    validateRepoExample(args.dnfDir);
    validateRepomd(args.dnfDir);
    validatePrimaryXml(args.dnfDir, args.version);
    validateFilelistsXml(args.dnfDir);

    if (!args.skipSignatureCheck) {
        validateRepomdSignature(args.dnfDir);
    }

    console.log(
        `DNF repository is valid${args.version ? ` for version ${args.version}` : ""}.`,
    );
}

main();
