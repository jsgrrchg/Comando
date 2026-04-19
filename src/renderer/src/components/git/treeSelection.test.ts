import { describe, expect, it } from "vitest";

import type { GitTreeNode } from "./types";
import {
    flattenVisibleGitTreeNodes,
    orderGitTreePathsByVisibility,
    resolveGitTreeDragPaths,
    selectGitTreeRange,
    toggleGitTreePathSelection,
} from "./treeSelection";

const TREE: readonly GitTreeNode[] = [
    {
        children: [
            {
                id: "src-app",
                kind: "file",
                name: "app.ts",
                path: "src/app.ts",
                status: null,
            },
            {
                id: "src-lib",
                kind: "file",
                name: "lib.ts",
                path: "src/lib.ts",
                status: null,
            },
        ],
        id: "src",
        kind: "directory",
        name: "src",
        path: "src",
        status: null,
    },
    {
        id: "readme",
        kind: "file",
        name: "README.md",
        path: "README.md",
        status: null,
    },
];

describe("treeSelection", () => {
    it("flattens the visible tree in display order", () => {
        expect(flattenVisibleGitTreeNodes(TREE).map((node) => node.path)).toEqual(
            ["src", "src/app.ts", "src/lib.ts", "README.md"],
        );
    });

    it("toggles a selected path on and off", () => {
        expect(toggleGitTreePathSelection(["src/app.ts"], "README.md")).toEqual(
            ["src/app.ts", "README.md"],
        );
        expect(toggleGitTreePathSelection(["src/app.ts"], "src/app.ts")).toEqual(
            [],
        );
    });

    it("selects the range between anchor and target paths", () => {
        const visiblePaths = flattenVisibleGitTreeNodes(TREE).map(
            (node) => node.path,
        );

        expect(
            selectGitTreeRange(visiblePaths, "src", "src/lib.ts"),
        ).toEqual(["src", "src/app.ts", "src/lib.ts"]);
    });

    it("orders selected paths by their visible position", () => {
        const visiblePaths = flattenVisibleGitTreeNodes(TREE).map(
            (node) => node.path,
        );

        expect(
            orderGitTreePathsByVisibility(
                ["README.md", "src/app.ts"],
                visiblePaths,
            ),
        ).toEqual(["src/app.ts", "README.md"]);
    });

    it("uses the full ordered selection when dragging a selected node", () => {
        const visiblePaths = flattenVisibleGitTreeNodes(TREE).map(
            (node) => node.path,
        );

        expect(
            resolveGitTreeDragPaths(
                "README.md",
                ["README.md", "src/app.ts"],
                visiblePaths,
            ),
        ).toEqual(["src/app.ts", "README.md"]);
    });

    it("falls back to the dragged node when it is not part of the current selection", () => {
        const visiblePaths = flattenVisibleGitTreeNodes(TREE).map(
            (node) => node.path,
        );

        expect(
            resolveGitTreeDragPaths(
                "src/lib.ts",
                ["README.md", "src/app.ts"],
                visiblePaths,
            ),
        ).toEqual(["src/lib.ts"]);
    });
});
