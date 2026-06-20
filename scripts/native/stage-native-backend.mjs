import path from "node:path";

import {
    copyExecutable,
    isExecutableFile,
    relativeToRepo,
    repoRoot,
} from "../ai/_shared.mjs";

const binaryName = "comando-native-backend";
const args = parseArgs(process.argv.slice(2));
const targetPlatform = args.platform ?? process.platform;
const targetArch = args.arch ?? process.arch;
const targetBinaryName =
    targetPlatform === "win32" ? `${binaryName}.exe` : binaryName;
const stagedBinaryPath = path.join(
    repoRoot,
    "build",
    "package-resources",
    "native",
    targetPlatform,
    targetArch,
    targetBinaryName,
);

if (
    !args.binary &&
    (targetPlatform !== process.platform || targetArch !== process.arch)
) {
    throw new Error(
        [
            `Cannot stage ${targetPlatform}/${targetArch} from a ${process.platform}/${process.arch} host build.`,
            "Build that target separately and pass --binary /path/to/comando-native-backend.",
        ].join(" "),
    );
}

const sourceBinaryPath = args.binary ?? resolveBuiltBinary(targetBinaryName, args.profile);
if (!isExecutableFile(sourceBinaryPath)) {
    throw new Error(
        `Native backend binary is missing or not executable: ${relativeToRepo(sourceBinaryPath)}.`,
    );
}

copyExecutable(sourceBinaryPath, stagedBinaryPath);
console.log(
    `[native:stage] Staged ${targetPlatform}/${targetArch} from ${relativeToRepo(sourceBinaryPath)} to ${relativeToRepo(stagedBinaryPath)}.`,
);

function resolveBuiltBinary(targetBinaryName, profile) {
    const profiles = profile ? [profile] : ["release", "debug"];
    for (const candidateProfile of profiles) {
        const candidatePath = path.join(
            repoRoot,
            "target",
            candidateProfile,
            targetBinaryName,
        );
        if (isExecutableFile(candidatePath)) {
            return candidatePath;
        }
    }

    return path.join(repoRoot, "target", profiles[0], targetBinaryName);
}

function parseArgs(rawArgs) {
    const parsed = {};

    for (let index = 0; index < rawArgs.length; index += 1) {
        const arg = rawArgs[index];
        if (arg === "--") {
            continue;
        }

        if (arg === "--platform") {
            parsed.platform = requireValue(rawArgs, (index += 1), arg);
            continue;
        }

        if (arg === "--arch") {
            parsed.arch = requireValue(rawArgs, (index += 1), arg);
            continue;
        }

        if (arg === "--binary") {
            parsed.binary = path.resolve(
                requireValue(rawArgs, (index += 1), arg),
            );
            continue;
        }

        if (arg === "--profile") {
            parsed.profile = requireValue(rawArgs, (index += 1), arg);
            continue;
        }

        if (arg === "--debug") {
            parsed.profile = "debug";
            continue;
        }

        if (arg === "--release") {
            parsed.profile = "release";
            continue;
        }

        throw new Error(`Unknown native staging argument: ${arg}`);
    }

    return parsed;
}

function requireValue(rawArgs, index, flag) {
    const value = rawArgs[index];
    if (!value) {
        throw new Error(`Missing value for ${flag}.`);
    }

    return value;
}
