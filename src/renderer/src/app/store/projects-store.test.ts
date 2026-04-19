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

    it("prioritizes the newly added project when it is present", () => {
        expect(
            resolveNextActiveProjectId({
                activatedProjectId: "project-b",
                currentActiveProjectId: "project-a",
                projects,
            }),
        ).toBe("project-b");
    });

    it("keeps the current project when no new project was activated", () => {
        expect(
            resolveNextActiveProjectId({
                activatedProjectId: null,
                currentActiveProjectId: "project-a",
                projects,
            }),
        ).toBe("project-a");
    });

    it("falls back to the first project when nothing is active", () => {
        expect(
            resolveNextActiveProjectId({
                activatedProjectId: null,
                currentActiveProjectId: null,
                projects,
            }),
        ).toBe("project-a");
    });
});
