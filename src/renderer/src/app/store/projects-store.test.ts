import { describe, expect, it } from "vitest";

import {
    getAncestorDirectoryPaths,
    resolveProjectTreeRefresh,
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

describe("resolveProjectTreeRefresh", () => {
    it("prunes expanded directories that disappeared during refresh", () => {
        const resolution = resolveProjectTreeRefresh({
            currentTree: {
                __root__: [
                    {
                        extension: null,
                        gitStatus: null,
                        hasChildren: true,
                        id: "project-1:assets",
                        isGitIgnored: false,
                        kind: "directory",
                        name: "assets",
                        parentRelativePath: null,
                        relativePath: "assets",
                    },
                ],
                assets: [
                    {
                        extension: "png",
                        gitStatus: null,
                        hasChildren: false,
                        id: "project-1:assets/logo.png",
                        isGitIgnored: false,
                        kind: "file",
                        name: "logo.png",
                        parentRelativePath: "assets",
                        relativePath: "assets/logo.png",
                    },
                ],
            },
            expandedDirectories: ["assets"],
            parentPaths: [null, "assets"],
            results: [
                {
                    status: "fulfilled",
                    value: {
                        nodes: [],
                        parentRelativePath: null,
                    },
                },
                {
                    reason: new Error(
                        "Error invoking remote method 'projects:list-tree': Error: ENOENT: no such file or directory, scandir '/tmp/project/assets'",
                    ),
                    status: "rejected",
                },
            ],
        });

        expect(resolution.error).toBeNull();
        expect(resolution.expandedDirectories).toEqual([]);
        expect(resolution.treeNodes).toEqual({
            __root__: [],
        });
    });

    it("keeps the first non-missing-path error so the caller can surface it", () => {
        const resolution = resolveProjectTreeRefresh({
            currentTree: {
                __root__: [],
            },
            expandedDirectories: ["assets"],
            parentPaths: [null, "assets"],
            results: [
                {
                    status: "fulfilled",
                    value: {
                        nodes: [],
                        parentRelativePath: null,
                    },
                },
                {
                    reason: new Error("EACCES: permission denied"),
                    status: "rejected",
                },
            ],
        });

        expect(resolution.error).toBeInstanceOf(Error);
        expect((resolution.error as Error).message).toContain("EACCES");
    });
});
