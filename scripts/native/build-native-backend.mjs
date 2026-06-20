import { spawnSync } from "node:child_process";

import {
    prepareCommandForSpawnSync,
    repoRoot,
} from "../ai/_shared.mjs";

const args = parseArgs(process.argv.slice(2));
const profile = args.profile ?? "release";
const cargoArgs = ["build", "-p", "comando-native-backend"];

if (profile === "release") {
    cargoArgs.push("--release");
}

if (args.target) {
    cargoArgs.push("--target", args.target);
}

console.log(
    `[native:build] Building comando-native-backend (${profile}${args.target ? `, target=${args.target}` : ""}).`,
);
run("cargo", cargoArgs);

function run(command, commandArgs) {
    const prepared = prepareCommandForSpawnSync(command, commandArgs, {
        cwd: repoRoot,
        env: process.env,
        stdio: "inherit",
    });
    const result = spawnSync(
        prepared.command,
        prepared.args,
        prepared.options,
    );

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}

function parseArgs(rawArgs) {
    const parsed = {};

    for (let index = 0; index < rawArgs.length; index += 1) {
        const arg = rawArgs[index];
        if (arg === "--") {
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

        if (arg === "--profile") {
            parsed.profile = requireValue(rawArgs, (index += 1), arg);
            continue;
        }

        if (arg === "--target") {
            parsed.target = requireValue(rawArgs, (index += 1), arg);
            continue;
        }

        throw new Error(`Unknown native build argument: ${arg}`);
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
