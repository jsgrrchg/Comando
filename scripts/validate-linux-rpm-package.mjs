import childProcess from "node:child_process";
import path from "node:path";

import { listFilesRecursively, normalizeReleaseVersion } from "./apt-repo-lib.mjs";
import { buildRpmReleaseAssetName } from "./dnf-repo-lib.mjs";

const RPM_ARCHITECTURE_BY_ELECTRON_BUILDER_ARCHITECTURE = {
    arm64: "aarch64",
    x64: "x86_64",
};

function parseArgs(argv) {
    const args = {
        arch: null,
        requireSignature: false,
        stagedAssetsDir: null,
        version: null,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = argv[index + 1] ?? null;

        if (arg === "--staged-assets-dir") {
            args.stagedAssetsDir = path.resolve(next);
            index += 1;
            continue;
        }
        if (arg === "--arch") {
            args.arch = next;
            index += 1;
            continue;
        }
        if (arg === "--version") {
            args.version = next;
            index += 1;
            continue;
        }
        if (arg === "--require-signature") {
            args.requireSignature = true;
            continue;
        }

        throw new Error(
            `Unknown argument "${arg}". Supported args: --staged-assets-dir, --arch, --version, --require-signature.`,
        );
    }

    if (!args.stagedAssetsDir) {
        throw new Error("Missing required argument --staged-assets-dir <path>.");
    }
    if (!args.arch) {
        throw new Error("Missing required argument --arch <x64|arm64>.");
    }
    if (!args.version) {
        throw new Error("Missing required argument --version <X.Y.Z-or-tag>.");
    }

    const rpmArchitecture = RPM_ARCHITECTURE_BY_ELECTRON_BUILDER_ARCHITECTURE[
        String(args.arch).trim()
    ];
    if (!rpmArchitecture) {
        throw new Error(`Unsupported Linux build architecture "${args.arch}".`);
    }

    return {
        ...args,
        rpmArchitecture,
        version: normalizeReleaseVersion(args.version),
    };
}

function runCommand(command, args) {
    const result = childProcess.spawnSync(command, args, {
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 16,
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

    return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function findSingleAsset(stagedAssetsDir, assetName) {
    const matches = listFilesRecursively(stagedAssetsDir).filter(
        (filePath) => path.basename(filePath) === assetName,
    );
    if (matches.length !== 1) {
        throw new Error(
            `Expected exactly one Linux RPM asset named ${assetName} in ${stagedAssetsDir}, found ${matches.length}.`,
        );
    }
    return matches[0];
}

function readRpmQueryFields(rpmPath) {
    const output = runCommand("rpm", [
        "-qp",
        "--queryformat",
        "%{NAME}\\n%{VERSION}\\n%{ARCH}\\n",
        rpmPath,
    ]);
    const [name, version, architecture] = output.trim().split("\n");
    return { architecture, name, version };
}

function validateRpmFields({ fields, rpmArchitecture, version }) {
    const expectedFields = {
        architecture: rpmArchitecture,
        name: "comando",
        version,
    };

    for (const [fieldName, expectedValue] of Object.entries(expectedFields)) {
        if (fields[fieldName] !== expectedValue) {
            throw new Error(
                `RPM ${fieldName} mismatch: expected "${expectedValue}", received "${fields[fieldName] ?? "missing"}".`,
            );
        }
    }
}

function validateSignature(rpmPath) {
    const output = runCommand("rpm", ["-Kv", rpmPath]);
    if (!/signature/iu.test(output)) {
        throw new Error(`RPM package is not signed: ${rpmPath}\n${output}`);
    }
    if (/(not ok|nokey|nottrusted|missing keys|bad)/iu.test(output)) {
        throw new Error(`RPM package signature check failed: ${rpmPath}\n${output}`);
    }
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const assetName = buildRpmReleaseAssetName(args.version, args.rpmArchitecture);
    const rpmPath = findSingleAsset(args.stagedAssetsDir, assetName);

    validateRpmFields({
        fields: readRpmQueryFields(rpmPath),
        rpmArchitecture: args.rpmArchitecture,
        version: args.version,
    });

    if (args.requireSignature) {
        validateSignature(rpmPath);
    }

    console.log(`Linux RPM package is valid: ${rpmPath}`);
}

main();
