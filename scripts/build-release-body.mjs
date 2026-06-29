import fs from "node:fs";
import path from "node:path";

import {
    buildReleaseBody,
    extractChangelogReleaseNotes,
} from "./release-notes-lib.mjs";

function parseArgs(argv) {
    const args = {
        notesFile: null,
        output: null,
        version: null,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = argv[index + 1] ?? null;

        if (arg === "--version") {
            args.version = requireValue(arg, next);
            index += 1;
            continue;
        }
        if (arg === "--notes-file") {
            args.notesFile = path.resolve(requireValue(arg, next));
            index += 1;
            continue;
        }
        if (arg === "--output") {
            args.output = path.resolve(requireValue(arg, next));
            index += 1;
            continue;
        }

        throw new Error(
            `Unknown argument "${arg}". Supported args: --version, --notes-file, --output.`,
        );
    }

    if (!args.version) {
        throw new Error("Missing required argument --version <X.Y.Z-or-tag>.");
    }

    return args;
}

function main() {
    try {
        const args = parseArgs(process.argv.slice(2));
        const notes = args.notesFile
            ? fs.readFileSync(args.notesFile, "utf8")
            : extractChangelogReleaseNotes({
                  version: args.version,
              });
        const body = buildReleaseBody({
            notes,
            version: args.version,
        });

        if (args.output) {
            fs.mkdirSync(path.dirname(args.output), { recursive: true });
            fs.writeFileSync(args.output, body, "utf8");
            console.log(`Release body written to ${args.output}`);
            return;
        }

        process.stdout.write(body);
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}

function requireValue(arg, value) {
    if (!value) {
        throw new Error(`Missing value for ${arg}.`);
    }

    return value;
}

main();
