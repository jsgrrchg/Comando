import { describe, expect, it } from "vitest";

import {
    canDropProjectEntriesIntoDirectory,
    canDropProjectEntryIntoDirectory,
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
});
