import { describe, expect, it } from "vitest";

import { getAncestorDirectoryPaths } from "./projects-store";

describe("getAncestorDirectoryPaths", () => {
    it("returns all parent directories for nested files", () => {
        expect(
            getAncestorDirectoryPaths("src/components/sidebar/Sidebar.tsx"),
        ).toEqual([
            "src",
            "src/components",
            "src/components/sidebar",
        ]);
    });

    it("returns an empty array for files at the project root", () => {
        expect(getAncestorDirectoryPaths("README.md")).toEqual([]);
    });

    it("ignores repeated path separators around the file path", () => {
        expect(getAncestorDirectoryPaths("/src//app///main.ts")).toEqual([
            "src",
            "src/app",
        ]);
    });
});
