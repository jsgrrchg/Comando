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
    {
        id: "verify_handshake",
        command: "backend_handshake",
        args: {
            clientName: "comando-native-verify",
            clientVersion: "0.1.0",
            protocolVersion: 1,
            supportedProtocolVersions: [1],
        },
    },
    { id: "verify_ping", command: "backend_ping", args: {} },
    { id: "verify_capabilities", command: "backend_capabilities", args: {} },
    { id: "verify_shutdown", command: "backend_shutdown", args: {} },
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

if (outputs.length !== 4) {
    throw new Error(
        `Expected 4 JSONL outputs from native backend, received ${outputs.length}.`,
    );
}

assertOkResponse(outputs[0], "verify_handshake");
assertOkResponse(outputs[1], "verify_ping");
assertOkResponse(outputs[2], "verify_capabilities");
assertOkResponse(outputs[3], "verify_shutdown");

if (outputs[0].result?.protocolVersion !== 1) {
    throw new Error("Native backend handshake returned the wrong protocol.");
}

if (outputs[1].result?.backend !== "comando-native-backend") {
    throw new Error("Native backend ping returned the wrong backend name.");
}

if (outputs[2].result?.protocolVersion !== 1) {
    throw new Error("Native backend capabilities returned the wrong protocol.");
}

if (!outputs[2].result?.capabilities?.commands?.includes("backend_handshake")) {
    throw new Error("Native backend capabilities did not include backend_handshake.");
}

console.log(
    `[native:verify] Verified staged native backend at ${relativeToRepo(stagedBinaryPath)}.`,
);

function assertOkResponse(output, id) {
    if (output?.type !== "response" || output.id !== id || output.ok !== true) {
        throw new Error(`Unexpected native backend response: ${JSON.stringify(output)}`);
    }
}
