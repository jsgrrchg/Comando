import { spawnSync } from "node:child_process";

import {
    prepareCommandForSpawnSync,
    repoRoot,
} from "../ai/_shared.mjs";

const args = process.argv.slice(2);
const profile = args.includes("--debug") ? "debug" : "release";
const cargoArgs = ["build", "-p", "comando-native-backend"];

if (profile === "release") {
    cargoArgs.push("--release");
}

console.log(`[native:build] Building comando-native-backend (${profile}).`);
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
