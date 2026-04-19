import { describe, expect, it } from "vitest";

import { parseChangelogMarkdown } from "./changelog";

describe("parseChangelogMarkdown", () => {
    it("extracts releases, dates, and bullet highlights", () => {
        const releases = parseChangelogMarkdown(`
# Changelog

## [0.1.0] - 2026-04-19

### Added

- First highlight
- Second highlight

## [0.0.9] - 2026-04-05

- Older highlight
        `);

        expect(releases).toEqual([
            {
                date: "2026-04-19",
                highlights: ["First highlight", "Second highlight"],
                version: "0.1.0",
            },
            {
                date: "2026-04-05",
                highlights: ["Older highlight"],
                version: "0.0.9",
            },
        ]);
    });

    it("ignores text outside release sections", () => {
        const releases = parseChangelogMarkdown(`
- Ignore me

## [0.1.0]

### Fixed

- Keep me
        `);

        expect(releases).toEqual([
            {
                date: null,
                highlights: ["Keep me"],
                version: "0.1.0",
            },
        ]);
    });
});
