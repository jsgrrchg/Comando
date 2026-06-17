import { describe, expect, it } from "vitest";

import type { ProjectTreeNode } from "@shared/ipc";

import {
    collectProjectQuickOpenFiles,
    searchProjectQuickOpenEntries,
    searchProjectQuickOpenFiles,
} from "./quick-open";

describe("project quick open", () => {
    it("collects unique file nodes from the loaded tree", () => {
        const nodesByParent: Record<string, readonly ProjectTreeNode[]> = {
            __root__: [
                createNode("src", "directory"),
                createNode("README.md", "file"),
            ],
            src: [
                createNode("src/App.tsx", "file"),
                createNode("src/utils", "directory"),
            ],
            "src/utils": [
                createNode("src/utils/format.ts", "file"),
                createNode("src/utils/format.ts", "file"),
            ],
        };

        expect(collectProjectQuickOpenFiles(nodesByParent)).toEqual([
            expect.objectContaining({ relativePath: "README.md" }),
            expect.objectContaining({ relativePath: "src/App.tsx" }),
            expect.objectContaining({ relativePath: "src/utils/format.ts" }),
        ]);
    });

    it("prioritizes direct filename matches over broader path matches", () => {
        const files = collectProjectQuickOpenFiles({
            __root__: [
                createNode("src/components/QuickOpenFilePalette.tsx", "file"),
                createNode("src/components/quick-actions/index.ts", "file"),
                createNode("src/workspace/open-quick-history.ts", "file"),
            ],
        });

        const matches = searchProjectQuickOpenFiles(files, "quick");

        expect(matches[0]?.relativePath).toBe(
            "src/components/QuickOpenFilePalette.tsx",
        );
        expect(matches.map((entry) => entry.relativePath)).toEqual(
            expect.arrayContaining([
                "src/components/QuickOpenFilePalette.tsx",
                "src/components/quick-actions/index.ts",
                "src/workspace/open-quick-history.ts",
            ]),
        );
    });

    it("supports fuzzy subsequence matches across path separators", () => {
        const files = collectProjectQuickOpenFiles({
            __root__: [
                createNode(
                    "src/components/workspace/WorkspaceView.tsx",
                    "file",
                ),
                createNode("src/components/sidebar/SidebarSection.tsx", "file"),
            ],
        });

        const matches = searchProjectQuickOpenFiles(files, "wsv");

        expect(matches[0]?.relativePath).toBe(
            "src/components/workspace/WorkspaceView.tsx",
        );
    });

    it("can rank quick open results from backend search entries", () => {
        const matches = searchProjectQuickOpenEntries(
            [
                createNode(
                    "src/components/workspace/WorkspaceView.tsx",
                    "file",
                ),
                createNode("src/components/sidebar/SidebarSection.tsx", "file"),
            ],
            "wsv",
        );

        expect(matches[0]?.relativePath).toBe(
            "src/components/workspace/WorkspaceView.tsx",
        );
    });
});

function createNode(
    relativePath: string,
    kind: ProjectTreeNode["kind"],
): ProjectTreeNode {
    const name = relativePath.split("/").at(-1) ?? relativePath;

    return {
        extension:
            kind === "file" && name.includes(".")
                ? (name.split(".").at(-1) ?? null)
                : null,
        gitStatus: null,
        hasChildren: false,
        id: relativePath,
        isGitIgnored: false,
        kind,
        name,
        parentRelativePath: relativePath.includes("/")
            ? (relativePath.split("/").slice(0, -1).join("/") ?? null)
            : null,
        relativePath,
    };
}
