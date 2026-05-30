import { describe, expect, it } from "vitest";

import {
    canDropProjectEntriesIntoDirectory,
    canDropProjectEntryIntoDirectory,
    compactGitTreeDragEntriesByAncestor,
    getProjectEntryMoveValidation,
    getProjectEntryParentRelativePath,
} from "./tree-dnd";

describe("tree-dnd", () => {
    it("detects the parent relative path for nested entries", () => {
        expect(getProjectEntryParentRelativePath("src/components/App.tsx")).toBe(
            "src/components",
        );
        expect(getProjectEntryParentRelativePath("README.md")).toBeNull();
    });

    it("allows moving a file into a different directory", () => {
        expect(
            canDropProjectEntryIntoDirectory(
                {
                    kind: "file",
                    name: "App.tsx",
                    relativePath: "src/App.tsx",
                },
                "docs",
            ),
        ).toBe(true);
    });

    it("rejects dropping an entry into its current parent", () => {
        expect(
            canDropProjectEntryIntoDirectory(
                {
                    kind: "file",
                    name: "App.tsx",
                    relativePath: "src/App.tsx",
                },
                "src",
            ),
        ).toBe(false);

        expect(
            canDropProjectEntryIntoDirectory(
                {
                    kind: "file",
                    name: "README.md",
                    relativePath: "README.md",
                },
                null,
            ),
        ).toBe(false);
    });

    it("rejects dropping a folder into itself or one of its descendants", () => {
        expect(
            canDropProjectEntryIntoDirectory(
                {
                    kind: "directory",
                    name: "src",
                    relativePath: "src",
                },
                "src",
            ),
        ).toBe(false);

        expect(
            canDropProjectEntryIntoDirectory(
                {
                    kind: "directory",
                    name: "src",
                    relativePath: "src",
                },
                "src/components",
            ),
        ).toBe(false);
    });

    it("allows a multi-entry move when at least one selected item changes parent", () => {
        expect(
            canDropProjectEntriesIntoDirectory(
                [
                    {
                        kind: "file",
                        name: "intro.md",
                        relativePath: "docs/intro.md",
                    },
                    {
                        kind: "file",
                        name: "App.tsx",
                        relativePath: "src/App.tsx",
                    },
                ],
                "docs",
            ),
        ).toBe(true);
    });

    it("rejects a multi-entry move into a selected folder descendant", () => {
        expect(
            canDropProjectEntriesIntoDirectory(
                [
                    {
                        kind: "directory",
                        name: "src",
                        relativePath: "src",
                    },
                    {
                        kind: "file",
                        name: "README.md",
                        relativePath: "README.md",
                    },
                ],
                "src/components",
            ),
        ).toBe(false);
    });

    it("compacts nested drag entries before validating parent changes", () => {
        expect(
            getProjectEntryMoveValidation(
                [
                    {
                        kind: "directory",
                        name: "src",
                        relativePath: "src",
                    },
                    {
                        kind: "file",
                        name: "App.tsx",
                        relativePath: "src/App.tsx",
                    },
                ],
                null,
            ),
        ).toMatchObject({
            canMove: false,
            reason: "same-parent",
        });
    });

    it("returns only movable compacted entries for mixed parent moves", () => {
        const validation = getProjectEntryMoveValidation(
            [
                {
                    kind: "directory",
                    name: "src",
                    relativePath: "src",
                },
                {
                    kind: "file",
                    name: "App.tsx",
                    relativePath: "src/App.tsx",
                },
                {
                    kind: "file",
                    name: "README.md",
                    relativePath: "README.md",
                },
            ],
            "docs",
        );

        expect(validation.canMove).toBe(true);
        expect(validation.entries.map((entry) => entry.relativePath)).toEqual([
            "src",
            "README.md",
        ]);
    });

    it("deduplicates drag entries while compacting ancestors", () => {
        expect(
            compactGitTreeDragEntriesByAncestor([
                {
                    kind: "directory",
                    name: "src",
                    relativePath: "src",
                },
                {
                    kind: "directory",
                    name: "src",
                    relativePath: "src",
                },
                {
                    kind: "file",
                    name: "App.tsx",
                    relativePath: "src/App.tsx",
                },
            ]).map((entry) => entry.relativePath),
        ).toEqual(["src"]);
    });

    it("reports specific invalid folder move reasons", () => {
        expect(
            getProjectEntryMoveValidation(
                {
                    kind: "directory",
                    name: "src",
                    relativePath: "src",
                },
                "src",
            ).reason,
        ).toBe("directory-self");

        expect(
            getProjectEntryMoveValidation(
                {
                    kind: "directory",
                    name: "src",
                    relativePath: "src",
                },
                "src/components",
            ).reason,
        ).toBe("directory-descendant");
    });
});
