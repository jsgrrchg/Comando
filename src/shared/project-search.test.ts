import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
    compactProjectSearchValue,
    getProjectSearchDepth,
    normalizeProjectSearchQuery,
    scoreProjectSearchCandidate,
    type ProjectSearchCandidate,
} from "./project-search";

interface ProjectSearchParityEntry extends ProjectSearchCandidate {
    readonly kind: "directory" | "file";
    readonly name: string;
    readonly relativePath: string;
}

interface ProjectSearchParityCase {
    readonly expected: readonly string[];
    readonly includeAncestorDirectories: boolean;
    readonly limit: number;
    readonly name: string;
    readonly query: string;
}

function candidate(
    partial: Partial<ProjectSearchCandidate> &
        Pick<ProjectSearchCandidate, "lowerName" | "lowerPath">,
): ProjectSearchCandidate {
    return {
        compactPath:
            partial.compactPath ?? compactProjectSearchValue(partial.lowerPath),
        depth: partial.depth ?? 0,
        lowerName: partial.lowerName,
        lowerPath: partial.lowerPath,
    };
}

function fixture<T>(relativePath: string): T {
    return JSON.parse(
        readFileSync(
            path.join(process.cwd(), "fixtures", "native-backend", relativePath),
            "utf8",
        ),
    ) as T;
}

describe("compactProjectSearchValue", () => {
    it("lowercases and removes typical separators", () => {
        expect(compactProjectSearchValue("Path/To_File.name")).toBe(
            "pathtofilename",
        );
    });
});

describe("getProjectSearchDepth", () => {
    it("counts separators", () => {
        expect(getProjectSearchDepth("")).toBe(0);
        expect(getProjectSearchDepth("src/index.ts")).toBe(1);
        expect(getProjectSearchDepth("src/a/b/c.ts")).toBe(3);
    });
});

describe("normalizeProjectSearchQuery", () => {
    it("trims and lowercases", () => {
        expect(normalizeProjectSearchQuery("  HELLO  ")).toBe("hello");
    });
});

describe("scoreProjectSearchCandidate", () => {
    it("returns zero for an empty query", () => {
        const c = candidate({ lowerName: "file.ts", lowerPath: "src/file.ts" });
        expect(scoreProjectSearchCandidate(c, "")).toBe(0);
        expect(scoreProjectSearchCandidate(c, "   ")).toBe(0);
    });

    it("rewards exact filename match highest", () => {
        const exact = candidate({
            lowerName: "index.ts",
            lowerPath: "src/index.ts",
        });
        const substring = candidate({
            lowerName: "indexer.ts",
            lowerPath: "src/indexer.ts",
        });
        expect(scoreProjectSearchCandidate(exact, "index.ts")).toBeGreaterThan(
            scoreProjectSearchCandidate(substring, "index.ts"),
        );
    });

    it("prefers shallower paths for the same name match", () => {
        const shallow = candidate({
            lowerName: "foo.ts",
            lowerPath: "foo.ts",
            depth: 0,
        });
        const deep = candidate({
            lowerName: "foo.ts",
            lowerPath: "a/b/c/d/foo.ts",
            depth: 4,
        });
        expect(scoreProjectSearchCandidate(shallow, "foo")).toBeGreaterThan(
            scoreProjectSearchCandidate(deep, "foo"),
        );
    });

    it("returns -1 when any token fails to match", () => {
        const c = candidate({
            lowerName: "file.ts",
            lowerPath: "src/file.ts",
        });
        expect(scoreProjectSearchCandidate(c, "file zzzzzzzzzzz")).toBe(-1);
    });

    it("rejects pathologically long tokens (> 200 chars) to protect ranking", () => {
        const c = candidate({
            lowerName: "file.ts",
            lowerPath: "src/file.ts",
        });
        const pathological = "a".repeat(400);
        expect(scoreProjectSearchCandidate(c, pathological)).toBe(-1);
    });
});

describe("project search parity fixture", () => {
    it("captures project runtime search ordering and ancestor behavior", () => {
        const parity = fixture<{
            readonly cases: readonly ProjectSearchParityCase[];
            readonly entries: readonly {
                readonly kind: "directory" | "file";
                readonly name: string;
                readonly relativePath: string;
            }[];
        }>("index/project-search.parity.json");
        const entries = parity.entries.map(toParityEntry);

        for (const testCase of parity.cases) {
            const result = collectParityEntries(
                entries,
                testCase.query,
                testCase.limit,
                testCase.includeAncestorDirectories,
            ).map((entry) => entry.relativePath);

            expect(result, testCase.name).toEqual(testCase.expected);
        }
    });
});

function toParityEntry(entry: {
    readonly kind: "directory" | "file";
    readonly name: string;
    readonly relativePath: string;
}): ProjectSearchParityEntry {
    return {
        compactPath: compactProjectSearchValue(entry.relativePath),
        depth: getProjectSearchDepth(entry.relativePath),
        kind: entry.kind,
        lowerName: entry.name.toLowerCase(),
        lowerPath: entry.relativePath.toLowerCase(),
        name: entry.name,
        relativePath: entry.relativePath,
    };
}

function collectParityEntries(
    entries: readonly ProjectSearchParityEntry[],
    query: string,
    limit: number,
    includeAncestorDirectories: boolean,
): readonly ProjectSearchParityEntry[] {
    const normalizedQuery = normalizeProjectSearchQuery(query);
    if (!normalizedQuery) {
        return [];
    }

    const matches = collectTopParityEntries(entries, normalizedQuery, limit);
    if (!includeAncestorDirectories) {
        return matches.map((match) => match.entry);
    }

    const entriesByPath = new Map(
        entries.map((entry) => [entry.relativePath, entry]),
    );
    const result: ProjectSearchParityEntry[] = [];
    const seen = new Set<string>();

    const push = (entry: ProjectSearchParityEntry) => {
        if (!seen.has(entry.relativePath)) {
            seen.add(entry.relativePath);
            result.push(entry);
        }
    };

    for (const match of matches) {
        for (const ancestorPath of getAncestorPaths(match.entry.relativePath)) {
            const ancestor = entriesByPath.get(ancestorPath);
            if (ancestor?.kind === "directory") {
                push(ancestor);
            }
        }
        push(match.entry);
    }

    return result;
}

function collectTopParityEntries(
    entries: readonly ProjectSearchParityEntry[],
    query: string,
    limit: number,
): readonly {
    readonly entry: ProjectSearchParityEntry;
    readonly score: number;
}[] {
    return entries
        .map((entry) => ({
            entry,
            score: scoreProjectSearchCandidate(entry, query),
        }))
        .filter((match) => match.score >= 0)
        .sort(compareParityEntries)
        .slice(0, limit);
}

function compareParityEntries(
    left: {
        readonly entry: ProjectSearchParityEntry;
        readonly score: number;
    },
    right: {
        readonly entry: ProjectSearchParityEntry;
        readonly score: number;
    },
): number {
    return (
        right.score - left.score ||
        left.entry.relativePath.length - right.entry.relativePath.length ||
        left.entry.relativePath.localeCompare(right.entry.relativePath)
    );
}

function getAncestorPaths(relativePath: string): readonly string[] {
    const ancestors: string[] = [];
    const segments = relativePath.split("/");
    let cursor = "";

    for (let index = 0; index < segments.length - 1; index += 1) {
        const segment = segments[index];
        if (!segment) {
            continue;
        }
        cursor = cursor ? `${cursor}/${segment}` : segment;
        ancestors.push(cursor);
    }

    return ancestors;
}
