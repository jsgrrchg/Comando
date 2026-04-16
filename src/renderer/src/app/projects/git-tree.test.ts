import { describe, expect, it } from "vitest";

import type { ProjectTreeNode } from "@shared/ipc";

import {
    buildFlatGitTreeNodesFromProjectEntries,
    buildGitTreeNodesFromProjectTree,
    findProjectTreeNodeByPath,
} from "./git-tree";

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

describe("buildGitTreeNodesFromProjectTree", () => {
    it("only materializes children for expanded directories", () => {
        const srcDirectory = makeNode("src", "directory", null);
        const nestedDirectory = makeNode("src/app", "directory", "src");
        const fileNode = makeNode("src/app/main.ts", "file", "src/app");

        const nodes = buildGitTreeNodesFromProjectTree(
            [srcDirectory],
            {
                __root__: [srcDirectory],
                src: [nestedDirectory],
                "src/app": [fileNode],
            },
            ["src"],
        );

        expect(nodes).toHaveLength(1);
        expect(nodes[0]?.children).toEqual([
            expect.objectContaining({
                path: "src/app",
                children: undefined,
            }),
        ]);
    });

    it("keeps descending into expanded nested branches", () => {
        const srcDirectory = makeNode("src", "directory", null);
        const nestedDirectory = makeNode("src/app", "directory", "src");
        const fileNode = makeNode("src/app/main.ts", "file", "src/app");

        const nodes = buildGitTreeNodesFromProjectTree(
            [srcDirectory],
            {
                __root__: [srcDirectory],
                src: [nestedDirectory],
                "src/app": [fileNode],
            },
            ["src", "src/app"],
        );

        expect(nodes[0]?.children?.[0]?.children).toEqual([
            expect.objectContaining({
                path: "src/app/main.ts",
            }),
        ]);
    });
});

describe("findProjectTreeNodeByPath", () => {
    it("finds nested nodes inside the loaded project tree", () => {
        const srcDirectory = makeNode("src", "directory", null);
        const nestedDirectory = makeNode("src/app", "directory", "src");
        const fileNode = makeNode("src/app/main.ts", "file", "src/app");

        const found = findProjectTreeNodeByPath(
            {
                __root__: [srcDirectory],
                src: [nestedDirectory],
                "src/app": [fileNode],
            },
            "src/app/main.ts",
        );

        expect(found).toEqual(fileNode);
    });
});

describe("buildFlatGitTreeNodesFromProjectEntries", () => {
    it("keeps parent context in flat search results", () => {
        const nodes = buildFlatGitTreeNodesFromProjectEntries([
            makeNode("src/components/App.tsx", "file", "src/components"),
            makeNode("src/components", "directory", "src"),
        ]);

        expect(nodes).toEqual([
            expect.objectContaining({
                path: "src/components/App.tsx",
                secondaryText: "src/components",
            }),
            expect.objectContaining({
                path: "src/components",
                secondaryText: "src",
            }),
        ]);
    });
});
