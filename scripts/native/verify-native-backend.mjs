import path from "node:path";
import { spawnSync } from "node:child_process";

import {
    isExecutableFile,
    relativeToRepo,
    repoRoot,
} from "../ai/_shared.mjs";

const binaryName =
    process.platform === "win32"
        ? "comando-native-backend.exe"
        : "comando-native-backend";
const stagedBinaryPath = path.join(
    repoRoot,
    "build",
    "package-resources",
    "native",
    process.platform,
    process.arch,
    binaryName,
);

if (!isExecutableFile(stagedBinaryPath)) {
    throw new Error(
        `Missing staged native backend binary at ${relativeToRepo(stagedBinaryPath)}. Run pnpm run native:stage first.`,
    );
}

const requests = [
    { id: 1, command: "backend_ping", args: {} },
    { id: 2, command: "backend_capabilities", args: {} },
    { id: 3, command: "backend_shutdown", args: {} },
]
    .map((request) => JSON.stringify(request))
    .join("\n")
    .concat("\n");
const result = spawnSync(stagedBinaryPath, [], {
    cwd: repoRoot,
    encoding: "utf8",
    input: requests,
    maxBuffer: 1024 * 1024,
});

if (result.error) {
    throw result.error;
}

if (result.status !== 0) {
    throw new Error(
        `Native backend smoke check exited with ${result.status ?? 1}: ${result.stderr}`,
    );
}

const outputs = result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

if (outputs.length !== 3) {
    throw new Error(
        `Expected 3 JSONL outputs from native backend, received ${outputs.length}.`,
    );
}

assertOkResponse(outputs[0], 1);
assertOkResponse(outputs[1], 2);
assertOkResponse(outputs[2], 3);

if (outputs[0].result?.backend !== "comando-native-backend") {
    throw new Error("Native backend ping returned the wrong backend name.");
}

if (outputs[1].result?.protocolVersion !== 1) {
    throw new Error("Native backend capabilities returned the wrong protocol.");
}

console.log(
    `[native:verify] Verified staged native backend at ${relativeToRepo(stagedBinaryPath)}.`,
);

function assertOkResponse(output, id) {
    if (output?.type !== "response" || output.id !== id || output.ok !== true) {
        throw new Error(`Unexpected native backend response: ${JSON.stringify(output)}`);
    }
}
