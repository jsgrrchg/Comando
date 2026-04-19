import { describe, expect, it } from "vitest";

import {
    getAncestorDirectoryPaths,
    resolveNextActiveProjectId,
} from "./projects-store";

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

describe("resolveNextActiveProjectId", () => {
    const projects = [
        {
            createdAt: "2026-04-19T00:00:00.000Z",
            id: "project-a",
            lastOpenedAt: "2026-04-19T00:00:00.000Z",
            name: "Project A",
            rootPath: "/tmp/project-a",
            updatedAt: "2026-04-19T00:00:00.000Z",
        },
        {
            createdAt: "2026-04-19T00:00:00.000Z",
            id: "project-b",
            lastOpenedAt: "2026-04-19T00:00:00.000Z",
            name: "Project B",
            rootPath: "/tmp/project-b",
            updatedAt: "2026-04-19T00:00:00.000Z",
        },
    ] as const;

    it("keeps the current project instead of switching to the newly added one", () => {
        expect(
            resolveNextActiveProjectId({
                currentActiveProjectId: "project-a",
                projects,
            }),
        ).toBe("project-a");
    });

    it("keeps the current project when it is still present", () => {
        expect(
            resolveNextActiveProjectId({
                currentActiveProjectId: "project-a",
                projects,
            }),
        ).toBe("project-a");
    });

    it("leaves the current window without active project when none was active", () => {
        expect(
            resolveNextActiveProjectId({
                currentActiveProjectId: null,
                projects,
            }),
        ).toBeNull();
    });

    it("clears the active project if it no longer exists", () => {
        expect(
            resolveNextActiveProjectId({
                currentActiveProjectId: "missing-project",
                projects,
            }),
        ).toBeNull();
    });
});
