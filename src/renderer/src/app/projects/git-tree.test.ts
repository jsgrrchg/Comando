import { describe, expect, it } from "vitest";

import type { ProjectTreeNode } from "@shared/ipc";

import {
    buildGitTreeNodesFromProjectTree,
    buildHierarchicalGitTreeNodesFromProjectEntries,
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

describe("buildHierarchicalGitTreeNodesFromProjectEntries", () => {
    it("synthesizes ancestor folders for file matches and nests them", () => {
        const { expandedDirectoryPaths, nodes } =
            buildHierarchicalGitTreeNodesFromProjectEntries([
                makeNode(
                    "src/components/App.tsx",
                    "file",
                    "src/components",
                ),
                makeNode(
                    "src/hooks/useThing.ts",
                    "file",
                    "src/hooks",
                ),
            ]);

        expect(nodes).toHaveLength(1);
        expect(nodes[0]?.path).toBe("src");
        expect(nodes[0]?.kind).toBe("directory");
        expect(nodes[0]?.children?.map((child) => child.path)).toEqual([
            "src/components",
            "src/hooks",
        ]);
        expect(expandedDirectoryPaths).toEqual(
            expect.arrayContaining(["src", "src/components", "src/hooks"]),
        );
    });

    it("places directories above files at each level and sorts alphabetically", () => {
        const { nodes } = buildHierarchicalGitTreeNodesFromProjectEntries([
            makeNode("README.md", "file", null),
            makeNode("docs/intro.md", "file", "docs"),
            makeNode("assets/logo.png", "file", "assets"),
        ]);

        expect(nodes.map((node) => node.path)).toEqual([
            "assets",
            "docs",
            "README.md",
        ]);
    });

    it("keeps real directory metadata when the search returns both the folder and its file", () => {
        const { nodes } = buildHierarchicalGitTreeNodesFromProjectEntries([
            makeNode("src/components", "directory", "src"),
            makeNode("src/components/App.tsx", "file", "src/components"),
        ]);

        const srcDirectory = nodes[0];
        expect(srcDirectory?.path).toBe("src");
        const componentsDirectory = srcDirectory?.children?.[0];
        expect(componentsDirectory?.id).toBe("project:src/components");
        expect(componentsDirectory?.children?.[0]?.path).toBe(
            "src/components/App.tsx",
        );
    });
});
