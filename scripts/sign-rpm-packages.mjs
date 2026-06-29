import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { listFilesRecursively } from "./apt-repo-lib.mjs";

function parseArgs(argv) {
    const args = {
        keyId: null,
        rpmDir: null,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = argv[index + 1] ?? null;

        if (arg === "--rpm-dir") {
            args.rpmDir = path.resolve(next);
            index += 1;
            continue;
        }
        if (arg === "--key-id") {
            args.keyId = next?.trim();
            index += 1;
            continue;
        }

        throw new Error(
            `Unknown argument "${arg}". Supported args: --rpm-dir, --key-id.`,
        );
    }

    if (!args.rpmDir) {
        throw new Error("Missing required argument --rpm-dir <path>.");
    }
    if (!args.keyId) {
        throw new Error("Missing required argument --key-id <fingerprint>.");
    }

    return args;
}

function runCommand(command, args, options = {}) {
    const result = childProcess.spawnSync(command, args, {
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 16,
        ...options,
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

function listRpmFiles(rootDir) {
    return listFilesRecursively(rootDir)
        .filter((filePath) => filePath.endsWith(".rpm"))
        .sort();
}

function writePassphraseFile(tempDir) {
    const passphrase = process.env.APT_REPO_GPG_PASSPHRASE ?? "";
    if (!passphrase) {
        return null;
    }

    const passphrasePath = path.join(tempDir, "rpm-signing-passphrase");
    fs.writeFileSync(passphrasePath, passphrase, { mode: 0o600 });
    return passphrasePath;
}

function buildRpmSignDefines({ keyId, passphrasePath }) {
    const extraGpgArgs = [
        "--batch",
        "--pinentry-mode",
        "loopback",
        ...(passphrasePath ? ["--passphrase-file", passphrasePath] : []),
    ].join(" ");

    return [
        "--define",
        `_gpg_name ${keyId}`,
        "--define",
        `_gpg_path ${process.env.GNUPGHOME}`,
        "--define",
        "_signature gpg",
        "--define",
        `_gpg_sign_cmd_extra_args ${extraGpgArgs}`,
    ];
}

function assertRpmSignature(rpmPath) {
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
    const rpmFiles = listRpmFiles(args.rpmDir);
    if (rpmFiles.length === 0) {
        throw new Error(`No RPM packages found in ${args.rpmDir}.`);
    }

    if (!process.env.GNUPGHOME) {
        throw new Error("GNUPGHOME must point to the imported release signing keyring.");
    }

    runCommand("rpmsign", ["--version"]);
    runCommand("rpm", ["--version"]);

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "comando-rpm-sign-"));
    try {
        const passphrasePath = writePassphraseFile(tempDir);
        const rpmSignDefines = buildRpmSignDefines({
            keyId: args.keyId,
            passphrasePath,
        });

        for (const rpmPath of rpmFiles) {
            runCommand("rpmsign", [...rpmSignDefines, "--addsign", rpmPath]);
            assertRpmSignature(rpmPath);
            console.log(`Signed RPM package: ${rpmPath}`);
        }
    } finally {
        fs.rmSync(tempDir, { force: true, recursive: true });
    }
}

main();
