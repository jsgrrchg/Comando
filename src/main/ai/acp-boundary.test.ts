import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("AI ACP boundary", () => {
    it("does not import the TypeScript ACP SDK from Electron main AI code", () => {
        const forbiddenPackage = "@agentclientprotocol/" + "sdk";
        const matches = findSourceMatches(
            path.join(process.cwd(), "src", "main", "ai"),
            forbiddenPackage,
        );

        expect(matches).toEqual([]);
    });
});

function findSourceMatches(root: string, needle: string): string[] {
    const matches: string[] = [];
    const entries = fs.readdirSync(root, { withFileTypes: true });

    for (const entry of entries) {
        const entryPath = path.join(root, entry.name);
        if (entry.isDirectory()) {
            matches.push(...findSourceMatches(entryPath, needle));
            continue;
        }

        if (!/\.(ts|tsx)$/.test(entry.name)) {
            continue;
        }

        const content = fs.readFileSync(entryPath, "utf8");
        if (content.includes(needle)) {
            matches.push(path.relative(process.cwd(), entryPath));
        }
    }

    return matches;
}
