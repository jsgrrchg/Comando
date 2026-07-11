import fs from "node:fs";

const DEFAULT_SCAN_CHUNK_SIZE = 1024 * 1024;
const MINIMUM_VERSION_OCCURRENCES = 2;

export function resolveExpectedCodexRuntimeVersion(cargoTomlPath) {
    const cargoToml = fs.readFileSync(cargoTomlPath, "utf8");
    const versions = new Set();

    for (const line of cargoToml.split(/\r?\n/u)) {
        if (!line.includes("github.com/openai/codex")) {
            continue;
        }

        const match = line.match(/tag\s*=\s*"rust-v([^"]+)"/u);
        if (match?.[1]) {
            versions.add(match[1]);
        }
    }

    if (versions.size !== 1) {
        throw new Error(
            `Expected one aligned OpenAI Codex runtime version in ${cargoTomlPath}, found: ${[...versions].join(", ") || "none"}.`,
        );
    }

    return [...versions][0];
}

export function countBinaryVersionOccurrences(
    binaryPath,
    version,
    chunkSize = DEFAULT_SCAN_CHUNK_SIZE,
) {
    const needle = Buffer.from(version, "utf8");
    const chunk = Buffer.alloc(Math.max(chunkSize, needle.length));
    const fileDescriptor = fs.openSync(binaryPath, "r");
    let carry = Buffer.alloc(0);
    let count = 0;

    try {
        while (true) {
            const bytesRead = fs.readSync(
                fileDescriptor,
                chunk,
                0,
                chunk.length,
                null,
            );
            if (bytesRead === 0) {
                break;
            }

            const data = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
            let searchOffset = 0;
            while (true) {
                const matchOffset = data.indexOf(needle, searchOffset);
                if (matchOffset === -1) {
                    break;
                }
                count += 1;
                searchOffset = matchOffset + needle.length;
            }

            const carryLength = Math.min(needle.length - 1, data.length);
            carry = Buffer.from(data.subarray(data.length - carryLength));
        }
    } finally {
        fs.closeSync(fileDescriptor);
    }

    return count;
}

export function assertCodexRuntimeBinaryVersion({
    binaryPath,
    expectedVersion,
    minimumOccurrences = MINIMUM_VERSION_OCCURRENCES,
}) {
    const occurrences = countBinaryVersionOccurrences(
        binaryPath,
        expectedVersion,
    );
    if (occurrences >= minimumOccurrences) {
        return;
    }

    throw new Error(
        `Codex ACP binary ${binaryPath} does not match the vendored Codex runtime ${expectedVersion}. ` +
            "Rebuild or replace the prebuilt binary before packaging.",
    );
}

export function assertCodexRuntimeBundleVersion({
    codeModeHostBinaryPath,
    codexBinaryPath,
    expectedVersion,
}) {
    assertCodexRuntimeBinaryVersion({
        binaryPath: codexBinaryPath,
        expectedVersion,
    });
    assertCodexRuntimeBinaryVersion({
        binaryPath: codeModeHostBinaryPath,
        expectedVersion,
        minimumOccurrences: 1,
    });
}
