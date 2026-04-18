import { describe, expect, it } from "vitest";

import {
    compactProjectSearchValue,
    getProjectSearchDepth,
    normalizeProjectSearchQuery,
    scoreProjectSearchCandidate,
    type ProjectSearchCandidate,
} from "./project-search";

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
