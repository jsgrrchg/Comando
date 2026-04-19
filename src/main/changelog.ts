import fs from "node:fs";
import path from "node:path";

import { app } from "electron";

import type { AppChangelogRelease } from "@shared/ipc";

const CHANGELOG_FILE_NAME = "CHANGELOG.md";

export function loadAppChangelog(): readonly AppChangelogRelease[] {
    const changelogPath = resolveAppChangelogPath();
    const markdown = fs.readFileSync(changelogPath, "utf8");
    return parseChangelogMarkdown(markdown);
}

export function parseChangelogMarkdown(
    markdown: string,
): readonly AppChangelogRelease[] {
    const lines = markdown.split(/\r?\n/u);
    const releases: AppChangelogRelease[] = [];
    let currentRelease: {
        date: string | null;
        highlights: string[];
        version: string;
    } | null = null;

    for (const line of lines) {
        const releaseMatch =
            /^## \[(?<version>[^\]]+)\](?: - (?<date>\d{4}-\d{2}-\d{2}))?$/u.exec(
                line.trim(),
            );
        if (releaseMatch?.groups) {
            if (currentRelease) {
                releases.push(currentRelease);
            }

            currentRelease = {
                date: releaseMatch.groups.date ?? null,
                highlights: [],
                version: releaseMatch.groups.version.trim(),
            };
            continue;
        }

        if (!currentRelease) {
            continue;
        }

        const bulletMatch = /^- (?<text>.+)$/u.exec(line.trim());
        if (bulletMatch?.groups?.text) {
            currentRelease.highlights.push(bulletMatch.groups.text.trim());
        }
    }

    if (currentRelease) {
        releases.push(currentRelease);
    }

    return releases;
}

function resolveAppChangelogPath(): string {
    return path.join(app.getAppPath(), CHANGELOG_FILE_NAME);
}
