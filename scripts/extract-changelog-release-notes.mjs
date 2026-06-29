import { extractChangelogReleaseNotes } from "./release-notes-lib.mjs";

function main() {
    const rawVersion = process.argv[2];
    if (!rawVersion) {
        console.error(
            "Usage: node scripts/extract-changelog-release-notes.mjs <version-or-tag>",
        );
        process.exit(1);
    }

    try {
        process.stdout.write(
            extractChangelogReleaseNotes({
                version: rawVersion,
            }),
        );
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}

main();
