import { describe, expect, it } from "vitest";

import type { ProjectTreeNode } from "@shared/ipc";

import type { GitTreeDragData } from "../../components/git/types";
import {
    buildFileTreeMoveDestinations,
    findNextFileTreeMoveDestinationIndex,
    resolveFileTreeMovePickerSelectedIndex,
    type FileTreeMoveDestination,
} from "./file-tree-move-destinations";

function makeProjectTreeNode(
    relativePath: string,
    kind: "directory" | "file",
): ProjectTreeNode {
    const parentRelativePath = relativePath.includes("/")
        ? relativePath.split("/").slice(0, -1).join("/")
        : null;

    return {
        extension:
            kind === "file" ? (relativePath.split(".").at(-1) ?? null) : null,
        gitStatus: null,
        hasChildren: kind === "directory",
        id: `project:${relativePath}`,
        isGitIgnored: false,
        kind,
        name: relativePath.split("/").at(-1) ?? relativePath,
        parentRelativePath,
        relativePath,
    };
}

function makeDragEntry(
    relativePath: string,
    kind: "directory" | "file",
): GitTreeDragData {
    return {
        kind,
        name: relativePath.split("/").at(-1) ?? relativePath,
        relativePath,
    };
}

function makeDestination(
    canMove: boolean,
    path: string,
): FileTreeMoveDestination {
    return {
        canMove,
        depth: 1,
        invalidReason: canMove ? null : "Cannot move to this folder.",
        name: path,
        path,
        pathLabel: path,
    };
}

describe("buildFileTreeMoveDestinations", () => {
    it("includes the project root and sorted directories", () => {
        const destinations = buildFileTreeMoveDestinations({
            activeProjectName: "Comando",
            entries: [makeDragEntry("notes/todo.md", "file")],
            projectEntryIndex: [
                makeProjectTreeNode("src/components", "directory"),
                makeProjectTreeNode("README.md", "file"),
                makeProjectTreeNode("docs", "directory"),
                makeProjectTreeNode("src", "directory"),
            ],
            query: "",
            treeNodesByParent: {},
        });

        expect(
            destinations.map(({ depth, name, path, pathLabel }) => ({
                depth,
                name,
                path,
                pathLabel,
            })),
        ).toEqual([
            {
                depth: 0,
                name: "Comando",
                path: null,
                pathLabel: "Project root",
            },
            { depth: 1, name: "docs", path: "docs", pathLabel: "docs" },
            { depth: 1, name: "src", path: "src", pathLabel: "src" },
            {
                depth: 2,
                name: "components",
                path: "src/components",
                pathLabel: "src/components",
            },
        ]);
    });

    it("falls back to loaded tree nodes when the full project index is unavailable", () => {
        const destinations = buildFileTreeMoveDestinations({
            activeProjectName: "Comando",
            entries: [makeDragEntry("notes/todo.md", "file")],
            projectEntryIndex: null,
            query: "",
            treeNodesByParent: {
                __root__: [
                    makeProjectTreeNode("src", "directory"),
                    makeProjectTreeNode("README.md", "file"),
                ],
                src: [
                    makeProjectTreeNode("src/components", "directory"),
                    makeProjectTreeNode("src/App.tsx", "file"),
                ],
            },
        });

        expect(destinations.map((destination) => destination.path)).toEqual([
            null,
            "src",
            "src/components",
        ]);
    });

    it("filters by query against name and path label", () => {
        const options = {
            activeProjectName: "Comando",
            entries: [makeDragEntry("notes/todo.md", "file")],
            projectEntryIndex: [
                makeProjectTreeNode("docs", "directory"),
                makeProjectTreeNode("src/components", "directory"),
            ],
            treeNodesByParent: {},
        };

        expect(
            buildFileTreeMoveDestinations({
                ...options,
                query: "Project root",
            }).map((destination) => destination.path),
        ).toEqual([null]);

        expect(
            buildFileTreeMoveDestinations({
                ...options,
                query: "src/",
            }).map((destination) => destination.path),
        ).toEqual(["src/components"]);
    });

    it("marks invalid destinations for self, descendant, and same-parent moves", () => {
        const destinations = buildFileTreeMoveDestinations({
            activeProjectName: "Comando",
            entries: [makeDragEntry("src", "directory")],
            projectEntryIndex: [
                makeProjectTreeNode("docs", "directory"),
                makeProjectTreeNode("src", "directory"),
                makeProjectTreeNode("src/components", "directory"),
            ],
            query: "",
            treeNodesByParent: {},
        });

        expect(destinations.find((destination) => destination.path === "src"))
            .toMatchObject({
                canMove: false,
                invalidReason: "Cannot move a folder into itself.",
            });
        expect(
            destinations.find(
                (destination) => destination.path === "src/components",
            ),
        ).toMatchObject({
            canMove: false,
            invalidReason: "Cannot move a folder into one of its subfolders.",
        });

        const sameParentDestination = buildFileTreeMoveDestinations({
            activeProjectName: "Comando",
            entries: [makeDragEntry("docs/guide.md", "file")],
            projectEntryIndex: [makeProjectTreeNode("docs", "directory")],
            query: "",
            treeNodesByParent: {},
        }).find((destination) => destination.path === "docs");

        expect(sameParentDestination).toMatchObject({
            canMove: false,
            invalidReason: "Already in this folder.",
        });
    });
});

describe("resolveFileTreeMovePickerSelectedIndex", () => {
    it("uses the first movable destination when the current selection is invalid", () => {
        expect(
            resolveFileTreeMovePickerSelectedIndex(
                [
                    makeDestination(false, "docs"),
                    makeDestination(true, "src"),
                    makeDestination(true, "tests"),
                ],
                0,
            ),
        ).toBe(1);
    });
});

describe("findNextFileTreeMoveDestinationIndex", () => {
    it("skips invalid destinations while navigating to the next movable one", () => {
        expect(
            findNextFileTreeMoveDestinationIndex(
                [
                    makeDestination(true, "docs"),
                    makeDestination(false, "src"),
                    makeDestination(true, "tests"),
                ],
                0,
                1,
            ),
        ).toBe(2);
    });
});
