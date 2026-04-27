import { describe, expect, it } from "vitest";

import type { ProjectTreeNode } from "@shared/ipc";

import {
    buildFilteredProjectTree,
    filterProjectEntriesBySubstring,
} from "./tree-filter";

function makeNode(
    relativePath: string,
    kind: "directory" | "file",
    parentRelativePath: string | null,
): ProjectTreeNode {
    return {
        extension:
            kind === "file" ? (relativePath.split(".").at(-1) ?? null) : null,
        gitStatus: null,
        hasChildren: kind === "directory",
        id: `project:${relativePath}`,
        kind,
        name: relativePath.split("/").at(-1) ?? relativePath,
        parentRelativePath,
        relativePath,
    };
}

describe("buildFilteredProjectTree", () => {
    it("preserves matching branches and auto-expands parents", () => {
        const srcDirectory = makeNode("src", "directory", null);
        const docsDirectory = makeNode("docs", "directory", null);
        const appDirectory = makeNode("src/app", "directory", "src");
        const readmeFile = makeNode("README.md", "file", null);
        const notesFile = makeNode("docs/notes.md", "file", "docs");
        const appFile = makeNode("src/app/main.ts", "file", "src/app");

        const filtered = buildFilteredProjectTree(
            {
                __root__: [srcDirectory, docsDirectory, readmeFile],
                docs: [notesFile],
                src: [appDirectory],
                "src/app": [appFile],
            },
            "main",
        );

        expect(filtered.rootNodes).toEqual([srcDirectory]);
        expect(filtered.nodesByParent.src).toEqual([appDirectory]);
        expect(filtered.nodesByParent["src/app"]).toEqual([appFile]);
        expect(filtered.expandedDirectories).toEqual(["src/app", "src"]);
        expect(filtered.matchCount).toBe(1);
    });

    it("matches directories by path even if children do not match", () => {
        const srcDirectory = makeNode("src", "directory", null);
        const docsDirectory = makeNode("docs", "directory", null);
        const notesFile = makeNode("docs/notes.md", "file", "docs");

        const filtered = buildFilteredProjectTree(
            {
                __root__: [srcDirectory, docsDirectory],
                docs: [notesFile],
            },
            "doc",
        );

        expect(filtered.rootNodes).toEqual([docsDirectory]);
        expect(filtered.nodesByParent.docs).toEqual([notesFile]);
        expect(filtered.expandedDirectories).toEqual(["docs"]);
        expect(filtered.matchCount).toBe(2);
    });

    it("returns an empty tree when there are no matches", () => {
        const filtered = buildFilteredProjectTree(
            {
                __root__: [makeNode("src", "directory", null)],
            },
            "missing",
        );

        expect(filtered.rootNodes).toEqual([]);
        expect(filtered.matchCount).toBe(0);
    });
});

describe("filterProjectEntriesBySubstring", () => {
    it("matches file and directory paths case-insensitively", () => {
        const entries = [
            makeNode("src/App.tsx", "file", "src"),
            makeNode("src/components/sidebar/Sidebar.tsx", "file", "src/components/sidebar"),
            makeNode("docs/README.md", "file", "docs"),
        ];

        expect(
            filterProjectEntriesBySubstring(entries, "SIDEBAR").map(
                (entry) => entry.relativePath,
            ),
        ).toEqual(["src/components/sidebar/Sidebar.tsx"]);
    });

    it("returns no entries for blank filters", () => {
        expect(
            filterProjectEntriesBySubstring(
                [makeNode("src/App.tsx", "file", "src")],
                "   ",
            ),
        ).toEqual([]);
    });
});
