import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
    aiResourcesDir,
    copyExecutable,
    ensureDir,
    isExecutableFile,
    isFile,
    relativeToRepo,
    resetDir,
} from "./_shared.mjs";

export const EMBEDDED_NODE_VERSION = "v22.23.1";

const CACHE_SCHEMA_VERSION = 1;
const NODE_DOWNLOAD_ROOT = `https://nodejs.org/dist/${EMBEDDED_NODE_VERSION}`;
const prebuiltNodeRoot = path.join(aiResourcesDir, "prebuilt", "node");
const distributions = new Map([
    [
        "darwin-arm64",
        {
            archiveSha256:
                "ef28d8fab2c0e4314522d4bb1b7173270aa3937e93b92cb7de79c112ac1fa953",
            extension: "tar.gz",
            nodeTarget: "darwin-arm64",
        },
    ],
    [
        "darwin-x64",
        {
            archiveSha256:
                "b8da981b8a0b1241b70249204916da76c63573ddf5814dbd2d1e41069105cb81",
            extension: "tar.gz",
            nodeTarget: "darwin-x64",
        },
    ],
    [
        "linux-arm64",
        {
            archiveSha256:
                "543fa39e57d4c07855939459a323f4deb9a79dd1bb45e6e99458b0f2de10db8d",
            extension: "tar.gz",
            nodeTarget: "linux-arm64",
        },
    ],
    [
        "linux-x64",
        {
            archiveSha256:
                "7a8cb04b4a1df4eaf432125324b81b29a088e73570a23259a8de1c65d07fc129",
            extension: "tar.gz",
            nodeTarget: "linux-x64",
        },
    ],
    [
        "win32-arm64",
        {
            archiveSha256:
                "b470fdfe3502c05151656e06d495e3f47544f2ee8b1d9c8705090f2dd5996bd0",
            extension: "zip",
            nodeTarget: "win-arm64",
        },
    ],
    [
        "win32-x64",
        {
            archiveSha256:
                "7df0bc9375723f4a86b3aa1b7cc73342423d9677a8df4538aca31a049e309c29",
            extension: "zip",
            nodeTarget: "win-x64",
        },
    ],
]);

export function resolveOfficialNodeDistribution(platform, arch) {
    const key = `${platform}-${arch}`;
    const target = distributions.get(key);

    if (!target) {
        throw new Error(
            `No official embedded Node distribution is configured for ${key}. Set COMANDO_EMBEDDED_NODE_BIN to a compatible standalone Node binary.`,
        );
    }

    const archiveName = `node-${EMBEDDED_NODE_VERSION}-${target.nodeTarget}.${target.extension}`;
    return {
        ...target,
        archiveName,
        archiveUrl: `${NODE_DOWNLOAD_ROOT}/${archiveName}`,
        cacheKey: key,
        extractedDirectoryName: `node-${EMBEDDED_NODE_VERSION}-${target.nodeTarget}`,
        nodeBinaryName: platform === "win32" ? "node.exe" : "node",
    };
}

export async function prepareOfficialNodeRuntime({
    arch = process.arch,
    fetchImpl = globalThis.fetch,
    platform = process.platform,
    targetRoot = prebuiltNodeRoot,
} = {}) {
    const distribution = resolveOfficialNodeDistribution(platform, arch);
    const runtimeRoot = path.join(targetRoot, distribution.cacheKey);
    const binaryPath = path.join(
        runtimeRoot,
        "bin",
        distribution.nodeBinaryName,
    );

    if (isCachedRuntimeValid(runtimeRoot, binaryPath, distribution)) {
        return {
            binaryPath,
            distribution,
            runtimeRoot,
        };
    }

    if (typeof fetchImpl !== "function") {
        throw new Error(
            "No fetch implementation is available to download the official embedded Node runtime.",
        );
    }

    const temporaryRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "comando-node-runtime-"),
    );
    const archivePath = path.join(temporaryRoot, distribution.archiveName);

    try {
        await downloadFile(distribution.archiveUrl, archivePath, fetchImpl);
        assertFileSha256(
            archivePath,
            distribution.archiveSha256,
            distribution.archiveName,
        );
        extractArchive(archivePath, temporaryRoot, distribution.extension);

        const extractedRoot = path.join(
            temporaryRoot,
            distribution.extractedDirectoryName,
        );
        const extractedBinary =
            platform === "win32"
                ? path.join(extractedRoot, distribution.nodeBinaryName)
                : path.join(extractedRoot, "bin", distribution.nodeBinaryName);
        const extractedLicense = path.join(extractedRoot, "LICENSE");

        if (!isFile(extractedBinary) || !isFile(extractedLicense)) {
            throw new Error(
                `The official Node archive ${distribution.archiveName} is incomplete.`,
            );
        }

        resetDir(runtimeRoot);
        copyExecutable(extractedBinary, binaryPath);
        fs.copyFileSync(extractedLicense, path.join(runtimeRoot, "LICENSE"));

        const extractedReadme = path.join(extractedRoot, "README.md");
        if (isFile(extractedReadme)) {
            fs.copyFileSync(
                extractedReadme,
                path.join(runtimeRoot, "README.md"),
            );
        }

        writeCacheMetadata(runtimeRoot, binaryPath, distribution);
    } finally {
        fs.rmSync(temporaryRoot, { force: true, recursive: true });
    }

    return {
        binaryPath,
        distribution,
        runtimeRoot,
    };
}

export function readNodeVersion(binaryPath) {
    const result = spawnSync(binaryPath, ["--version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });

    if (result.error) {
        throw new Error(
            `Unable to run embedded Node at ${binaryPath}: ${result.error.message}`,
        );
    }

    if (result.status !== 0) {
        throw new Error(
            `Unable to run embedded Node at ${binaryPath}: ${result.stderr.trim() || `exit code ${result.status}`}`,
        );
    }

    const version = result.stdout.trim();
    const match = version.match(/^v?(\d+)\./u);
    if (!match) {
        throw new Error(
            `Unable to parse Node version "${version}" from ${binaryPath}.`,
        );
    }

    return {
        major: Number.parseInt(match[1], 10),
        version,
    };
}

export function assertFileSha256(filePath, expectedSha256, displayName) {
    const actualSha256 = sha256File(filePath);
    if (actualSha256 !== expectedSha256) {
        throw new Error(
            `SHA-256 mismatch for ${displayName}: expected ${expectedSha256}, received ${actualSha256}.`,
        );
    }
}

async function downloadFile(url, destinationPath, fetchImpl) {
    const response = await fetchImpl(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok || !response.body) {
        throw new Error(
            `Unable to download official Node runtime from ${url}: HTTP ${response.status}.`,
        );
    }

    ensureDir(path.dirname(destinationPath));
    await pipeline(
        Readable.fromWeb(response.body),
        fs.createWriteStream(destinationPath, { flags: "wx" }),
    );
}

function extractArchive(archivePath, destinationRoot, extension) {
    const command =
        extension === "zip"
            ? {
                  args: [
                      "-NoProfile",
                      "-NonInteractive",
                      "-Command",
                      `Expand-Archive -LiteralPath ${quotePowerShellLiteral(archivePath)} -DestinationPath ${quotePowerShellLiteral(destinationRoot)} -Force`,
                  ],
                  executable: "powershell.exe",
              }
            : {
                  args: ["-xzf", archivePath, "-C", destinationRoot],
                  executable: "tar",
              };
    const result = spawnSync(command.executable, command.args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });

    if (result.error) {
        throw new Error(
            `Unable to extract ${path.basename(archivePath)}: ${result.error.message}`,
        );
    }
    if (result.status !== 0) {
        throw new Error(
            `Unable to extract ${path.basename(archivePath)}: ${result.stderr.trim() || `exit code ${result.status}`}`,
        );
    }
}

function quotePowerShellLiteral(value) {
    return `'${value.replaceAll("'", "''")}'`;
}

function isCachedRuntimeValid(runtimeRoot, binaryPath, distribution) {
    const metadataPath = path.join(runtimeRoot, "runtime.json");
    const licensePath = path.join(runtimeRoot, "LICENSE");

    if (
        !isExecutableFile(binaryPath) ||
        !isFile(metadataPath) ||
        !isFile(licensePath)
    ) {
        return false;
    }

    try {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
        return (
            metadata.schemaVersion === CACHE_SCHEMA_VERSION &&
            metadata.nodeVersion === EMBEDDED_NODE_VERSION &&
            metadata.archiveName === distribution.archiveName &&
            metadata.archiveSha256 === distribution.archiveSha256 &&
            metadata.binarySha256 === sha256File(binaryPath)
        );
    } catch {
        return false;
    }
}

function writeCacheMetadata(runtimeRoot, binaryPath, distribution) {
    fs.writeFileSync(
        path.join(runtimeRoot, "runtime.json"),
        `${JSON.stringify(
            {
                archiveName: distribution.archiveName,
                archiveSha256: distribution.archiveSha256,
                binarySha256: sha256File(binaryPath),
                nodeVersion: EMBEDDED_NODE_VERSION,
                schemaVersion: CACHE_SCHEMA_VERSION,
            },
            null,
            4,
        )}\n`,
        "utf8",
    );
}

function sha256File(filePath) {
    const hash = crypto.createHash("sha256");
    const fileDescriptor = fs.openSync(filePath, "r");
    const buffer = Buffer.allocUnsafe(1024 * 1024);

    try {
        let bytesRead;
        do {
            bytesRead = fs.readSync(
                fileDescriptor,
                buffer,
                0,
                buffer.length,
                null,
            );
            if (bytesRead > 0) {
                hash.update(buffer.subarray(0, bytesRead));
            }
        } while (bytesRead > 0);
    } finally {
        fs.closeSync(fileDescriptor);
    }

    return hash.digest("hex");
}

function parseCliArgs(args) {
    let platform = process.platform;
    const arches = [];

    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === "--platform") {
            platform = args[index + 1] ?? "";
            index += 1;
            continue;
        }
        if (argument === "--arch") {
            arches.push(args[index + 1] ?? "");
            index += 1;
            continue;
        }
        throw new Error(`Unknown Node runtime preparation argument: ${argument}`);
    }

    return {
        arches: arches.length > 0 ? arches : [process.arch],
        platform,
    };
}

async function main() {
    const { arches, platform } = parseCliArgs(process.argv.slice(2));
    for (const arch of arches) {
        const prepared = await prepareOfficialNodeRuntime({ arch, platform });
        console.log(
            `[prepare:node-runtime] ${EMBEDDED_NODE_VERSION} ${platform}-${arch} -> ${relativeToRepo(prepared.runtimeRoot)}`,
        );
    }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}
