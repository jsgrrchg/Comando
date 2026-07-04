import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { DNF_PUBLIC_KEY_FILE_NAME } from "./dnf-repo-lib.mjs";
import { resolveLinuxRepoGpgPassphrase } from "./linux-repo-signing-env.mjs";

function parseArgs(argv) {
    const args = {
        dnfDir: null,
        keyId: null,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = argv[index + 1] ?? null;

        if (arg === "--dnf-dir") {
            args.dnfDir = path.resolve(next);
            index += 1;
            continue;
        }
        if (arg === "--key-id") {
            args.keyId = next?.trim();
            index += 1;
            continue;
        }

        throw new Error(
            `Unknown argument "${arg}". Supported args: --dnf-dir, --key-id.`,
        );
    }

    if (!args.dnfDir) {
        throw new Error("Missing required argument --dnf-dir <path>.");
    }
    if (!args.keyId) {
        throw new Error("Missing required argument --key-id <fingerprint>.");
    }

    return args;
}

function runGpg(args, { input = null, stdoutFile = null } = {}) {
    const result = childProcess.spawnSync("gpg", args, {
        encoding: stdoutFile ? null : "utf8",
        input,
        maxBuffer: 1024 * 1024 * 16,
    });

    if (result.status !== 0) {
        throw new Error(
            [
                `gpg command failed: gpg ${args.join(" ")}`,
                result.error?.message,
                result.stderr?.toString().trim(),
                result.stdout?.toString().trim(),
            ]
                .filter(Boolean)
                .join("\n"),
        );
    }

    if (stdoutFile) {
        fs.writeFileSync(stdoutFile, result.stdout);
    }

    return result.stdout;
}

function signingPassphraseArgs(passphrase) {
    return passphrase
        ? ["--pinentry-mode", "loopback", "--passphrase-fd", "0"]
        : ["--pinentry-mode", "loopback"];
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const repomdPath = path.join(args.dnfDir, "repodata", "repomd.xml");
    const repomdSignaturePath = path.join(
        args.dnfDir,
        "repodata",
        "repomd.xml.asc",
    );
    const publicKeyPath = path.join(args.dnfDir, DNF_PUBLIC_KEY_FILE_NAME);
    const passphrase = resolveLinuxRepoGpgPassphrase();

    if (!fs.existsSync(repomdPath)) {
        throw new Error(`Cannot sign missing DNF repomd.xml file: ${repomdPath}`);
    }

    runGpg(
        [
            "--batch",
            "--yes",
            "--export-options",
            "export-minimal",
            "--armor",
            "--export",
            args.keyId,
        ],
        { stdoutFile: publicKeyPath },
    );

    runGpg(
        [
            "--batch",
            "--yes",
            ...signingPassphraseArgs(passphrase),
            "--local-user",
            args.keyId,
            "--armor",
            "--detach-sign",
            "--output",
            repomdSignaturePath,
            repomdPath,
        ],
        { input: passphrase ? `${passphrase}\n` : null },
    );

    console.log(`Wrote DNF public key: ${publicKeyPath}`);
    console.log(`Wrote signed DNF metadata: ${repomdSignaturePath}`);
}

main();
