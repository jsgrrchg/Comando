import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceSnapshot } from "@shared/ipc";

import { databaseMigrations } from "@main/db/migrations";
import { NativeFsGateway } from "@main/native-backend/fs";
import { NativeSearchGateway } from "@main/native-backend/index-search";
import type { NativeBackendRequester } from "@main/native-backend/persistence";
import {
    applyMigrations,
    createSqliteCompatConnection,
} from "@main/testing/sqlite-compat";
import { WorkspaceService } from "@main/workspace/service";
import { SqliteProjectStore } from "@main/projects/store";

import { ProjectService, shouldIgnoreProjectWatchPath } from "./service";

describe("project watcher filtering", () => {
    it("ignores git index updates triggered by status refreshes", () => {
        expect(shouldIgnoreProjectWatchPath(".git/index")).toBe(true);
        expect(shouldIgnoreProjectWatchPath(".git/index.lock")).toBe(true);
        expect(shouldIgnoreProjectWatchPath(".git\\index")).toBe(true);
    });

    it("ignores generated outputs that should not refresh the workspace", () => {
        expect(shouldIgnoreProjectWatchPath("dist/main.js")).toBe(true);
        expect(shouldIgnoreProjectWatchPath("build/output/app.js")).toBe(true);
        expect(shouldIgnoreProjectWatchPath("tsconfig.web.tsbuildinfo")).toBe(
            true,
        );
    });

    it("keeps invalidating for regular project files and unknown events", () => {
        expect(shouldIgnoreProjectWatchPath("src/main.ts")).toBe(false);
        expect(shouldIgnoreProjectWatchPath(".git/HEAD")).toBe(false);
        expect(shouldIgnoreProjectWatchPath(null)).toBe(false);
    });
});

describe("ProjectService", () => {
    const tempDirs: string[] = [];

    afterEach(() => {
        vi.restoreAllMocks();
        for (const tempDir of tempDirs.splice(0)) {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("reuses the same project id after removing and re-adding the same path", async () => {
        const connection = createTestConnection();
        const workspaceService = new WorkspaceService(connection);
        const projectService = createProjectService(connection);
        const projectRoot = createTempProject(tempDirs, "alpha");
        const projectFilePath = path.join(projectRoot, "src", "index.ts");

        fs.mkdirSync(path.dirname(projectFilePath), { recursive: true });
        fs.writeFileSync(projectFilePath, "export const value = 1;\n");

        const firstAddResult = await projectService.addProjectPaths([
            projectRoot,
        ]);
        const [firstProject] = firstAddResult.projects;
        expect(firstProject).toBeDefined();
        expect(firstAddResult.projectIdsToOpen).toEqual([
            firstProject?.id ?? null,
        ]);
        if (!firstProject) {
            throw new Error("Expected the first project to be created.");
        }

        const snapshot: WorkspaceSnapshot = {
            activePaneId: "pane-root",
            rootNode: {
                activeTabId: "file-tab-1",
                id: "pane-root",
                tabIds: ["file-tab-1"],
                type: "pane",
            },
            tabs: [
                {
                    createdAt: "2026-04-15T00:00:00.000Z",
                    id: "file-tab-1",
                    kind: "file",
                    projectId: firstProject.id,
                    relativePath: "src/index.ts",
                    title: "index.ts",
                    worktreeId: `${firstProject.id}:primary`,
                },
            ],
        };

        workspaceService.saveSnapshot("workspace-1", snapshot);

        await projectService.removeProject(firstProject.id);
        expect(projectService.listProjects()).toEqual([]);

        const hiddenProjectRow = connection
            .prepare<[string], { id: string; is_hidden: number } | undefined>(
                `
                SELECT id, is_hidden
                FROM projects
                WHERE canonical_root_path = ?
                `,
            )
            .get(projectRoot);
        expect(hiddenProjectRow).toEqual({
            id: firstProject.id,
            is_hidden: 1,
        });

        const reopenedAddResult = await projectService.addProjectPaths([
            projectRoot,
        ]);
        const [reopenedProject] = reopenedAddResult.projects;
        expect(reopenedProject?.id).toBe(firstProject.id);
        expect(reopenedAddResult.projectIdsToOpen).toEqual([
            reopenedProject?.id ?? null,
        ]);
        if (!reopenedProject) {
            throw new Error("Expected the project to be re-added.");
        }

        const restoredSnapshot = workspaceService.loadSnapshot("workspace-1");
        expect(restoredSnapshot).toEqual(snapshot);

        await expect(
            projectService.openProjectFile({
                projectId: reopenedProject.id,
                relativePath: "src/index.ts",
                worktreeId: `${reopenedProject.id}:primary`,
            }),
        ).resolves.toMatchObject({
            absolutePath: projectFilePath,
            projectId: reopenedProject.id,
        });
    });

    it("clears app-specific project data without removing project files or other projects", async () => {
        const connection = createTestConnection();
        const projectService = createProjectService(connection);
        const projectRoot = createTempProject(tempDirs, "clear-alpha");
        const otherRoot = createTempProject(tempDirs, "clear-beta");
        const projectFilePath = path.join(projectRoot, "README.md");

        fs.writeFileSync(projectFilePath, "keep me\n");

        const [project] = (
            await projectService.addProjectPaths([projectRoot])
        ).projects;
        const [otherProject] = (
            await projectService.addProjectPaths([otherRoot])
        ).projects.filter((candidate) => candidate.rootPath === otherRoot);
        if (!project || !otherProject) {
            throw new Error("Expected both projects to be created.");
        }

        seedProjectAppData(connection, project.id, `${project.id}:primary`);
        seedProjectAppData(
            connection,
            otherProject.id,
            `${otherProject.id}:primary`,
        );

        await expect(
            projectService.getProjectAppDataSummary(project.id),
        ).resolves.toEqual({
            chatSessionCount: 1,
            projectSettingsCount: 1,
            recentProjectCount: 1,
            workspaceLayoutCount: 1,
            workspaceSessionCount: 1,
            workspaceTabCount: 1,
        });

        const result = await projectService.clearProjectAppData(project.id);

        expect(result.cleared).toEqual({
            chatSessionCount: 1,
            projectSettingsCount: 1,
            recentProjectCount: 1,
            workspaceLayoutCount: 1,
            workspaceSessionCount: 1,
            workspaceTabCount: 1,
        });
        expect(fs.existsSync(projectFilePath)).toBe(true);
        expect(result.projects.some((candidate) => candidate.id === project.id))
            .toBe(true);
        expect(countRows(connection, "chat_sessions", project.id)).toBe(0);
        expect(countRows(connection, "chat_transcripts", project.id)).toBe(0);
        expect(countRows(connection, "project_settings", project.id)).toBe(0);
        expect(countRows(connection, "recent_projects", project.id)).toBe(0);
        expect(countRows(connection, "workspace_layouts", project.id)).toBe(0);
        expect(countRows(connection, "workspace_sessions", project.id)).toBe(0);
        expect(countRows(connection, "workspace_tabs", project.id)).toBe(0);
        expect(
            result.projects.find((candidate) => candidate.id === project.id)
                ?.lastOpenedAt,
        ).toBeNull();
        expect(countRows(connection, "chat_sessions", otherProject.id)).toBe(1);
        expect(countRows(connection, "project_settings", otherProject.id)).toBe(
            1,
        );
        expect(countRows(connection, "recent_projects", otherProject.id)).toBe(
            1,
        );
        expect(countRows(connection, "workspace_layouts", otherProject.id)).toBe(
            1,
        );
        expect(countRows(connection, "workspace_tabs", otherProject.id)).toBe(1);
    });

    it("relocates a project path while preserving the project id and chat history", async () => {
        const connection = createTestConnection();
        const invalidations: string[] = [];
        const projectService = createProjectService(connection, (payload) => {
            invalidations.push(payload.projectId);
        });
        const projectRoot = createTempProject(tempDirs, "relocate-old");
        const nextRoot = createTempProject(tempDirs, "relocate-new");
        const nextFilePath = path.join(nextRoot, "src", "index.ts");

        fs.mkdirSync(path.dirname(nextFilePath), { recursive: true });
        fs.writeFileSync(nextFilePath, "export const relocated = true;\n");

        const [project] = (
            await projectService.addProjectPaths([projectRoot])
        ).projects;
        if (!project) {
            throw new Error("Expected the project to be created.");
        }
        seedProjectAppData(connection, project.id, `${project.id}:primary`);

        const result = await projectService.relocateProject(
            project.id,
            nextRoot,
        );

        expect(result.project.id).toBe(project.id);
        expect(result.project.rootPath).toBe(nextRoot);
        expect(invalidations).toContain(project.id);
        expect(countRows(connection, "chat_sessions", project.id)).toBe(1);
        await expect(
            projectService.openProjectFile({
                projectId: project.id,
                relativePath: "src/index.ts",
                worktreeId: `${project.id}:primary`,
            }),
        ).resolves.toMatchObject({
            absolutePath: nextFilePath,
            projectId: project.id,
        });
    });

    it("can relocate to a path previously owned by a hidden project", async () => {
        const connection = createTestConnection();
        const projectService = createProjectService(connection);
        const hiddenRoot = createTempProject(tempDirs, "relocate-hidden");
        const visibleRoot = createTempProject(tempDirs, "relocate-visible");

        const [hiddenProject] = (
            await projectService.addProjectPaths([hiddenRoot])
        ).projects;
        const [visibleProject] = (
            await projectService.addProjectPaths([visibleRoot])
        ).projects.filter((candidate) => candidate.rootPath === visibleRoot);
        if (!hiddenProject || !visibleProject) {
            throw new Error("Expected both projects to be created.");
        }

        await projectService.removeProject(hiddenProject.id);
        const result = await projectService.relocateProject(
            visibleProject.id,
            hiddenRoot,
        );

        expect(result.project.id).toBe(visibleProject.id);
        expect(result.project.rootPath).toBe(hiddenRoot);
    });

    it("drops stale tree invalidations for worktrees removed during git sync", async () => {
        const connection = createTestConnection();
        const onProjectTreeInvalidated = vi.fn();
        const projectService = createProjectService(
            connection,
            onProjectTreeInvalidated,
        );
        const projectRoot = createTempProject(tempDirs, "worktree-primary");
        const worktreeRoot = createTempProject(tempDirs, "worktree-stale");

        const [project] = (
            await projectService.addProjectPaths([projectRoot])
        ).projects;
        if (!project) {
            throw new Error("Expected the project to be created.");
        }

        await projectService.syncProjectWorktrees(project.id, [
            {
                branchName: "main",
                headSha: "primary-head",
                rootPath: projectRoot,
            },
            {
                branchName: "stale-branch",
                headSha: "stale-head",
                rootPath: worktreeRoot,
            },
        ]);

        const staleWorktree = projectService
            .listProjectWorktrees(project.id)
            .find((worktree) => worktree.rootPath === worktreeRoot);
        expect(staleWorktree).toBeDefined();
        if (!staleWorktree) {
            throw new Error("Expected the secondary worktree to be synced.");
        }

        await projectService.syncProjectWorktrees(project.id, [
            {
                branchName: "main",
                headSha: "next-primary-head",
                rootPath: projectRoot,
            },
        ]);
        expect(
            projectService
                .listProjectWorktrees(project.id)
                .some((worktree) => worktree.id === staleWorktree.id),
        ).toBe(false);

        expect(() => {
            projectService.handleProjectTreeInvalidation({
                occurredAt: "2026-06-08T00:00:00.000Z",
                projectId: project.id,
                relativePaths: null,
                worktreeId: staleWorktree.id,
            });
        }).not.toThrow();
        expect(onProjectTreeInvalidated).not.toHaveBeenCalled();
    });

    it("keeps forwarding valid primary invalidations after a sibling worktree is removed", async () => {
        const connection = createTestConnection();
        const onProjectTreeInvalidated = vi.fn();
        const projectService = createProjectService(
            connection,
            onProjectTreeInvalidated,
        );
        const projectRoot = createTempProject(tempDirs, "valid-primary");
        const worktreeRoot = createTempProject(tempDirs, "removed-sibling");

        const [project] = (
            await projectService.addProjectPaths([projectRoot])
        ).projects;
        if (!project) {
            throw new Error("Expected the project to be created.");
        }

        await projectService.syncProjectWorktrees(project.id, [
            {
                branchName: "main",
                headSha: "primary-head",
                rootPath: projectRoot,
            },
            {
                branchName: "removed",
                headSha: "removed-head",
                rootPath: worktreeRoot,
            },
        ]);
        await projectService.syncProjectWorktrees(project.id, [
            {
                branchName: "main",
                headSha: "next-primary-head",
                rootPath: projectRoot,
            },
        ]);

        const payload = {
            occurredAt: "2026-06-08T00:00:00.000Z",
            projectId: project.id,
            relativePaths: ["src/index.ts"],
            worktreeId: `${project.id}:primary`,
        };
        projectService.handleProjectTreeInvalidation(payload);

        expect(onProjectTreeInvalidated).toHaveBeenCalledTimes(1);
        expect(onProjectTreeInvalidated).toHaveBeenCalledWith(payload);
    });

    it("preserves worktree ids on Windows when git returns paths with different casing", async () => {
        const connection = createTestConnection();
        const projectService = createProjectService(connection);
        const projectRoot = createTempProject(tempDirs, "windows-primary-case");
        const worktreeRoot = createTempProject(
            tempDirs,
            "windows-worktree-case",
        );

        const [project] = (
            await projectService.addProjectPaths([projectRoot])
        ).projects;
        if (!project) {
            throw new Error("Expected the project to be created.");
        }

        const originalPlatform = process.platform;
        Object.defineProperty(process, "platform", {
            configurable: true,
            value: "win32",
        });
        try {
            await projectService.syncProjectWorktrees(project.id, [
                {
                    branchName: "main",
                    headSha: "primary-head",
                    rootPath: projectRoot,
                },
                {
                    branchName: "feature/windows-case",
                    headSha: "feature-head",
                    rootPath: worktreeRoot,
                },
            ]);

            const before = projectService.listProjectWorktrees(project.id);
            const beforePrimary = before.find((worktree) => worktree.isPrimary);
            const beforeFeature = before.find(
                (worktree) => worktree.branchName === "feature/windows-case",
            );
            expect(beforePrimary?.id).toBe(`${project.id}:primary`);
            expect(beforeFeature).toBeDefined();
            if (!beforePrimary || !beforeFeature) {
                throw new Error("Expected both worktrees to be synced.");
            }

            await projectService.syncProjectWorktrees(project.id, [
                {
                    branchName: "main",
                    headSha: "next-primary-head",
                    rootPath: projectRoot.toUpperCase(),
                },
                {
                    branchName: "feature/windows-case",
                    headSha: "next-feature-head",
                    rootPath: worktreeRoot.toUpperCase(),
                },
            ]);

            const after = projectService.listProjectWorktrees(project.id);
            expect(after).toHaveLength(2);
            expect(after.find((worktree) => worktree.isPrimary)?.id).toBe(
                beforePrimary.id,
            );
            expect(
                after.find(
                    (worktree) =>
                        worktree.branchName === "feature/windows-case",
                )?.id,
            ).toBe(beforeFeature.id);
        } finally {
            Object.defineProperty(process, "platform", {
                configurable: true,
                value: originalPlatform,
            });
        }
    });

    it("removes legacy Windows worktree duplicates before syncing casing changes", async () => {
        const connection = createTestConnection();
        const projectService = createProjectService(connection);
        const projectRoot = createTempProject(tempDirs, "legacy-case-primary");

        const [project] = (
            await projectService.addProjectPaths([projectRoot])
        ).projects;
        if (!project) {
            throw new Error("Expected the project to be created.");
        }

        const originalPlatform = process.platform;
        Object.defineProperty(process, "platform", {
            configurable: true,
            value: "win32",
        });
        try {
            const duplicateRootPath = projectRoot.toUpperCase();
            const now = new Date().toISOString();
            connection
                .prepare<
                    [
                        string,
                        string,
                        string,
                        string,
                        string,
                        number,
                        string,
                        string,
                    ],
                    void
                >(
                    `
                    INSERT INTO project_worktrees (
                        id,
                        project_id,
                        root_path,
                        branch_name,
                        head_sha,
                        is_primary,
                        created_at,
                        updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    `,
                )
                .run(
                    `${project.id}:legacy-case-duplicate`,
                    project.id,
                    duplicateRootPath,
                    "legacy-case",
                    "legacy-head",
                    0,
                    now,
                    now,
                );

            expect(projectService.listProjectWorktrees(project.id)).toHaveLength(
                2,
            );

            await projectService.syncProjectWorktrees(project.id, [
                {
                    branchName: "main",
                    headSha: "next-primary-head",
                    rootPath: duplicateRootPath,
                },
            ]);

            const after = projectService.listProjectWorktrees(project.id);
            expect(after).toHaveLength(1);
            expect(after[0]).toMatchObject({
                branchName: "main",
                headSha: "next-primary-head",
                id: `${project.id}:primary`,
                isPrimary: true,
                rootPath: path.resolve(duplicateRootPath),
            });
        } finally {
            Object.defineProperty(process, "platform", {
                configurable: true,
                value: originalPlatform,
            });
        }
    });

    it("drops stale tree invalidations for projects removed while watchers flush", async () => {
        const connection = createTestConnection();
        const onProjectTreeInvalidated = vi.fn();
        const projectService = createProjectService(
            connection,
            onProjectTreeInvalidated,
        );
        const projectRoot = createTempProject(tempDirs, "removed-project");

        const [project] = (
            await projectService.addProjectPaths([projectRoot])
        ).projects;
        if (!project) {
            throw new Error("Expected the project to be created.");
        }

        await projectService.removeProject(project.id);

        expect(() => {
            projectService.handleProjectTreeInvalidation({
                occurredAt: "2026-06-08T00:00:00.000Z",
                projectId: project.id,
                relativePaths: null,
                worktreeId: null,
            });
        }).not.toThrow();
        expect(onProjectTreeInvalidated).not.toHaveBeenCalled();
    });

    it("reuses the cached search index until project contents change", async () => {
        const connection = createTestConnection();
        const projectService = createProjectService(connection);
        const projectRoot = createTempProject(tempDirs, "search-cache");

        fs.mkdirSync(path.join(projectRoot, "src", "workspace"), {
            recursive: true,
        });
        fs.writeFileSync(
            path.join(projectRoot, "src", "workspace", "WorkspaceView.tsx"),
            "export const WorkspaceView = () => null;\n",
        );
        fs.writeFileSync(
            path.join(projectRoot, "src", "helpers.ts"),
            "export const helper = true;\n",
        );

        const addResult = await projectService.addProjectPaths([projectRoot]);
        const [project] = addResult.projects;
        expect(project).toBeDefined();
        if (!project) {
            throw new Error("Expected the project to be created.");
        }

        await expect(
            projectService.searchProjectEntries({
                limit: 10,
                projectId: project.id,
                query: "wsv",
            }),
        ).resolves.toEqual([
            expect.objectContaining({
                kind: "file",
                relativePath: "src/workspace/WorkspaceView.tsx",
            }),
        ]);

        await expect(
            projectService.searchProjectEntries({
                limit: 10,
                projectId: project.id,
                query: "helper",
            }),
        ).resolves.toEqual([
            expect.objectContaining({
                kind: "file",
                relativePath: "src/helpers.ts",
            }),
        ]);

        await expect(
            projectService.listProjectEntries({
                projectId: project.id,
            }),
        ).resolves.toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    kind: "file",
                    relativePath: "src/helpers.ts",
                }),
                expect.objectContaining({
                    kind: "file",
                    relativePath: "src/workspace/WorkspaceView.tsx",
                }),
            ]),
        );

        fs.writeFileSync(
            path.join(projectRoot, "src", "workspace", "workspace-hints.ts"),
            "export const hints = true;\n",
        );

        await expect(
            projectService.searchProjectEntries({
                limit: 10,
                projectId: project.id,
                query: "hints",
            }),
        ).resolves.toEqual([]);

        await projectService.saveProjectFile({
            content: "export const hints = true;\n",
            projectId: project.id,
            relativePath: "src/workspace/workspace-hints.ts",
        });

        await expect(
            projectService.searchProjectEntries({
                limit: 10,
                projectId: project.id,
                query: "hints",
            }),
        ).resolves.toEqual([
            expect.objectContaining({
                kind: "file",
                relativePath: "src/workspace/workspace-hints.ts",
            }),
        ]);
        await expect(
            projectService.listProjectEntries({
                projectId: project.id,
            }),
        ).resolves.toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    kind: "file",
                    relativePath: "src/workspace/workspace-hints.ts",
                }),
            ]),
        );
    });

    it("returns the highest-ranked search entries when limiting broad matches", async () => {
        const connection = createTestConnection();
        const projectService = createProjectService(connection);
        const projectRoot = createTempProject(tempDirs, "search-top-k");

        fs.mkdirSync(path.join(projectRoot, "src", "a"), {
            recursive: true,
        });
        fs.mkdirSync(path.join(projectRoot, "src", "z"), {
            recursive: true,
        });
        for (let index = 0; index < 20; index += 1) {
            fs.writeFileSync(
                path.join(projectRoot, "src", "a", `target-${index}.ts`),
                `export const value${index} = true;\n`,
            );
        }
        fs.writeFileSync(
            path.join(projectRoot, "target.ts"),
            "export const rootTarget = true;\n",
        );
        fs.writeFileSync(
            path.join(projectRoot, "src", "z", "target.ts"),
            "export const nestedTarget = true;\n",
        );

        const addResult = await projectService.addProjectPaths([projectRoot]);
        const [project] = addResult.projects;
        expect(project).toBeDefined();
        if (!project) {
            throw new Error("Expected the project to be created.");
        }

        await expect(
            projectService.searchProjectEntries({
                limit: 2,
                projectId: project.id,
                query: "target.ts",
            }),
        ).resolves.toEqual([
            expect.objectContaining({
                relativePath: "target.ts",
            }),
            expect.objectContaining({
                relativePath: "src/z/target.ts",
            }),
        ]);
    });

    it("routes tree and file reads through native filesystem", async () => {
        const connection = createTestConnection();
        const requestMock = vi.fn((command: string) => {
            if (command === "project_list_tree_children") {
                return Promise.resolve({
                    entries: [
                        nativeTreeEntry({
                            name: "src",
                            relativePath: "src",
                            kind: "directory",
                            hasChildren: true,
                        }),
                    ],
                });
            }

            if (command === "fs_read_file") {
                return Promise.resolve(nativeReadFileResult({
                    content: "export const nativeRead = true;\n",
                    relativePath: "src/index.ts",
                }));
            }

            return Promise.reject(new Error(`Unexpected command ${command}`));
        });
        const projectService = createProjectService(connection, undefined, {
            nativeFs: gatewayWith(requestMock),
        });
        const projectRoot = createTempProject(tempDirs, "native-read");
        fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
        fs.writeFileSync(path.join(projectRoot, "src/index.ts"), "legacy\n");

        const [project] = (
            await projectService.addProjectPaths([projectRoot])
        ).projects;
        if (!project) {
            throw new Error("Expected the project to be created.");
        }

        await expect(
            projectService.listProjectTreeChildren({
                parentRelativePath: null,
                projectId: project.id,
                worktreeId: null,
            }),
        ).resolves.toEqual([
            expect.objectContaining({
                kind: "directory",
                relativePath: "src",
            }),
        ]);
        await expect(
            projectService.openProjectFile({
                projectId: project.id,
                relativePath: "src/index.ts",
                worktreeId: null,
            }),
        ).resolves.toMatchObject({
            content: "export const nativeRead = true;\n",
            languageId: "typescript",
        });
        expect(requestMock).toHaveBeenCalledWith(
            "project_list_tree_children",
            expect.any(Object),
        );
        expect(requestMock).toHaveBeenCalledWith("fs_read_file", {
            projectId: project.id,
            relativePath: "src/index.ts",
            worktreeId: `${project.id}:primary`,
        });
    });

    it("routes project list and search through native index", async () => {
        const connection = createTestConnection();
        const requestMock = vi.fn((command: string) => {
            if (command === "project_list_entries") {
                return Promise.resolve({
                    entries: [
                        nativeTreeEntry({
                            hasChildren: false,
                            kind: "file",
                            name: "native.ts",
                            relativePath: "src/native.ts",
                        }),
                    ],
                    truncated: false,
                });
            }

            if (command === "project_search_entries") {
                return Promise.resolve({
                    entries: [nativeIndexedEntry("src/native.ts")],
                    generation: 1,
                    matches: [
                        {
                            entry: nativeIndexedEntry("src/native.ts"),
                            score: 400,
                        },
                    ],
                    operationId: "operation_1",
                    stats: nativeIndexStats(),
                    status: "ready",
                });
            }

            return Promise.reject(new Error(`Unexpected command ${command}`));
        });
        const projectService = createProjectService(connection, undefined, {
            nativeSearch: searchGatewayWith(requestMock),
        });
        const projectRoot = createTempProject(tempDirs, "native-search-read");
        fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
        fs.writeFileSync(path.join(projectRoot, "src/native.ts"), "legacy\n");
        const [project] = (
            await projectService.addProjectPaths([projectRoot])
        ).projects;
        if (!project) {
            throw new Error("Expected the project to be created.");
        }

        await expect(
            projectService.listProjectEntries({
                projectId: project.id,
                worktreeId: null,
            }),
        ).resolves.toEqual([
            expect.objectContaining({ relativePath: "src/native.ts" }),
        ]);
        await expect(
            projectService.searchProjectEntries({
                limit: 20,
                projectId: project.id,
                query: "native",
                worktreeId: null,
            }),
        ).resolves.toEqual([
            expect.objectContaining({ relativePath: "src/native.ts" }),
        ]);
        expect(requestMock).toHaveBeenCalledWith("project_list_entries", {
            projectId: project.id,
            worktreeId: `${project.id}:primary`,
        });
        expect(requestMock).toHaveBeenCalledWith(
            "project_search_entries",
            expect.objectContaining({
                projectId: project.id,
                query: "native",
                worktreeId: `${project.id}:primary`,
            }),
        );
    });

    it("propagates native search failures without falling back", async () => {
        const connection = createTestConnection();
        const projectRoot = createTempProject(tempDirs, "native-search-failure");
        fs.writeFileSync(path.join(projectRoot, "failure.ts"), "failure\n");
        const failingSearch = searchGatewayWith(
            vi.fn(() => Promise.reject(new Error("native unavailable"))),
        );
        const projectService = createProjectService(connection, undefined, {
            nativeSearch: failingSearch,
        });
        const [project] = (
            await projectService.addProjectPaths([projectRoot])
        ).projects;
        if (!project) {
            throw new Error("Expected the project to be created.");
        }

        await expect(
            projectService.listProjectEntries({
                projectId: project.id,
                worktreeId: null,
            }),
        ).rejects.toThrow("native unavailable");
    });

    it("routes writes and mutations through native filesystem", async () => {
        const connection = createTestConnection();
        const requestMock = vi.fn((command: string, args: unknown) => {
            if (command === "fs_write_file") {
                return Promise.resolve({
                    conflict: null,
                    entry: nativeEntry("src/index.ts"),
                    file: nativeReadFileResult({
                        content: "export const nativeWrite = true;\n",
                        relativePath: "src/index.ts",
                    }),
                });
            }

            if (command === "fs_create_file") {
                return Promise.resolve(nativeMutationResult("src/new.ts"));
            }

            return Promise.reject(
                new Error(`Unexpected command ${command} ${JSON.stringify(args)}`),
            );
        });
        const projectService = createProjectService(connection, undefined, {
            nativeFs: gatewayWith(requestMock),
        });
        const projectRoot = createTempProject(tempDirs, "native-write");
        fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
        fs.writeFileSync(path.join(projectRoot, "src/index.ts"), "legacy\n");

        const [project] = (
            await projectService.addProjectPaths([projectRoot])
        ).projects;
        if (!project) {
            throw new Error("Expected the project to be created.");
        }

        await expect(
            projectService.saveProjectFile({
                content: "export const nativeWrite = true;\n",
                expectedModifiedAtMs: 100,
                projectId: project.id,
                relativePath: "src/index.ts",
                worktreeId: null,
            }),
        ).resolves.toMatchObject({
            content: "export const nativeWrite = true;\n",
        });
        await expect(
            projectService.createProjectEntry({
                kind: "file",
                name: "new.ts",
                parentRelativePath: "src",
                projectId: project.id,
                worktreeId: null,
            }),
        ).resolves.toEqual({
            kind: "file",
            name: "new.ts",
            parentRelativePath: "src",
            relativePath: "src/new.ts",
        });
        expect(requestMock).toHaveBeenCalledWith(
            "fs_write_file",
            expect.objectContaining({
                expectedModifiedAtMs: 100,
                origin: "user",
            }),
        );
        expect(requestMock).toHaveBeenCalledWith(
            "fs_create_file",
            expect.objectContaining({
                name: "new.ts",
                origin: "user",
            }),
        );
    });

});

function createTestConnection() {
    const connection = createSqliteCompatConnection();
    applyMigrations(connection, databaseMigrations);
    return connection;
}

function createProjectService(
    connection: ReturnType<typeof createTestConnection>,
    onProjectTreeInvalidated: ConstructorParameters<
        typeof ProjectService
    >[0]["onProjectTreeInvalidated"] = () => {},
    options: Partial<
        Pick<
            ConstructorParameters<typeof ProjectService>[0],
            "nativeFs" | "nativeSearch"
        >
    > = {},
) {
    const store = new SqliteProjectStore(connection);
    const nativeBackend = createNativeTestBackend(store);
    return new ProjectService({
        nativeFs: options.nativeFs ?? new NativeFsGateway(nativeBackend),
        nativeSearch:
            options.nativeSearch ?? new NativeSearchGateway(nativeBackend),
        ...options,
        onProjectTreeInvalidated,
        store,
    });
}

function createNativeTestBackend(store: SqliteProjectStore): NativeBackendRequester {
    const indexedEntriesByScope = new Map<
        string,
        ReturnType<typeof nativeTestTreeEntry>[]
    >();

    const request: NativeBackendRequester["request"] = async (
        command,
        args = {},
    ) => {
        const input = args as Record<string, unknown>;
        if (
            command === "fs_watch_sync_registry" ||
            command === "fs_watch_start" ||
            command === "fs_watch_stop"
        ) {
            return null as never;
        }

        if (command === "index_update_entries") {
            const scope = resolveNativeTestScope(store, input);
            const relativePaths = input.relativePaths;
            if (relativePaths === null) {
                indexedEntriesByScope.delete(scope.key);
            } else if (Array.isArray(relativePaths)) {
                const entries = ensureIndexedEntries(indexedEntriesByScope, scope);
                for (const relativePath of relativePaths) {
                    if (typeof relativePath === "string") {
                        upsertIndexedEntry(entries, scope, relativePath);
                    }
                }
            }
            return {
                status: nativeTestIndexStatus(
                    scope,
                    indexedEntriesByScope.get(scope.key)?.length ?? 0,
                ),
            } as never;
        }

        if (command === "project_list_tree_children") {
            const scope = resolveNativeTestScope(store, input);
            return {
                entries: listNativeTestTreeChildren(
                    scope,
                    requireNullableString(input.parentRelativePath),
                ),
            } as never;
        }

        if (command === "project_list_entries") {
            const scope = resolveNativeTestScope(store, input);
            return {
                entries: ensureIndexedEntries(indexedEntriesByScope, scope),
                truncated: false,
            } as never;
        }

        if (command === "project_search_entries") {
            const scope = resolveNativeTestScope(store, input);
            const query = String(input.query ?? "").toLowerCase();
            const limit =
                typeof input.limit === "number" && input.limit > 0
                    ? input.limit
                    : 20;
            const matches = ensureIndexedEntries(indexedEntriesByScope, scope)
                .map((entry) => ({
                    entry: {
                        ...entry,
                        policyState: "indexed",
                    },
                    score: scoreNativeTestSearchEntry(entry.relativePath, query),
                }))
                .filter((match) => match.score > 0)
                .sort(
                    (left, right) =>
                        right.score - left.score ||
                        left.entry.relativePath.localeCompare(
                            right.entry.relativePath,
                        ),
                )
                .slice(0, limit);
            return {
                entries: matches.map((match) => match.entry),
                generation: 1,
                matches,
                operationId: "test-search",
                stats: nativeTestIndexStats(
                    indexedEntriesByScope.get(scope.key)?.length ?? 0,
                ),
                status: "ready",
            } as never;
        }

        if (command === "fs_read_file") {
            const scope = resolveNativeTestScope(store, input);
            return nativeTestReadFileResult(
                scope,
                requireString(input.relativePath),
            ) as never;
        }

        if (command === "fs_write_file") {
            const scope = resolveNativeTestScope(store, input);
            const relativePath = requireString(input.relativePath);
            const absolutePath = resolveNativeTestPath(scope.rootPath, relativePath);
            fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
            fs.writeFileSync(absolutePath, String(input.content ?? ""));
            upsertIndexedEntry(
                ensureIndexedEntries(indexedEntriesByScope, scope),
                scope,
                relativePath,
            );
            return {
                conflict: null,
                entry: nativeTestFsEntry(scope, relativePath),
                file: nativeTestReadFileResult(scope, relativePath),
            } as never;
        }

        if (command === "fs_create_file" || command === "fs_create_directory") {
            const scope = resolveNativeTestScope(store, input);
            const parentRelativePath = requireNullableString(
                input.parentRelativePath,
            );
            const name = requireString(input.name);
            const relativePath = joinNativeRelativePath(parentRelativePath, name);
            const absolutePath = resolveNativeTestPath(scope.rootPath, relativePath);
            if (command === "fs_create_directory") {
                fs.mkdirSync(absolutePath, { recursive: true });
            } else {
                fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
                fs.writeFileSync(absolutePath, "");
            }
            upsertIndexedEntry(
                ensureIndexedEntries(indexedEntriesByScope, scope),
                scope,
                relativePath,
            );
            return nativeTestMutationResult(scope, relativePath) as never;
        }

        throw new Error(`Unexpected native test command ${command}`);
    };

    return { request };
}

function resolveNativeTestScope(
    store: SqliteProjectStore,
    input: Record<string, unknown>,
) {
    const projectId = requireString(input.projectId);
    const worktreeId = requireNullableString(input.worktreeId);
    if (worktreeId) {
        const worktree = store.getProjectWorktree(worktreeId);
        if (!worktree) {
            throw new Error(`Unknown native test worktree ${worktreeId}`);
        }
        return {
            key: `${projectId}:${worktreeId}`,
            projectId,
            rootPath: worktree.rootPath,
            worktreeId,
        };
    }

    const project = store.getProject(projectId);
    if (!project) {
        throw new Error(`Unknown native test project ${projectId}`);
    }
    return {
        key: `${projectId}:primary`,
        projectId,
        rootPath: project.rootPath,
        worktreeId,
    };
}

function ensureIndexedEntries(
    entriesByScope: Map<string, ReturnType<typeof nativeTestTreeEntry>[]>,
    scope: ReturnType<typeof resolveNativeTestScope>,
): ReturnType<typeof nativeTestTreeEntry>[] {
    const existing = entriesByScope.get(scope.key);
    if (existing) {
        return existing;
    }

    const entries = listNativeTestEntries(scope);
    entriesByScope.set(scope.key, entries);
    return entries;
}

function listNativeTestTreeChildren(
    scope: ReturnType<typeof resolveNativeTestScope>,
    parentRelativePath: string | null,
): ReturnType<typeof nativeTestTreeEntry>[] {
    const parentPath = resolveNativeTestPath(scope.rootPath, parentRelativePath);
    return fs
        .readdirSync(parentPath, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() || entry.isFile())
        .map((entry) =>
            nativeTestTreeEntry(
                scope,
                joinNativeRelativePath(parentRelativePath, entry.name),
            ),
        )
        .sort(compareNativeTestEntries);
}

function listNativeTestEntries(
    scope: ReturnType<typeof resolveNativeTestScope>,
): ReturnType<typeof nativeTestTreeEntry>[] {
    const entries: ReturnType<typeof nativeTestTreeEntry>[] = [];
    const visit = (directoryPath: string) => {
        for (const child of fs.readdirSync(directoryPath, { withFileTypes: true })) {
            if (!child.isDirectory() && !child.isFile()) {
                continue;
            }
            const absolutePath = path.join(directoryPath, child.name);
            const relativePath = toNativeRelativePath(scope.rootPath, absolutePath);
            entries.push(nativeTestTreeEntry(scope, relativePath));
            if (child.isDirectory()) {
                visit(absolutePath);
            }
        }
    };
    visit(scope.rootPath);
    return entries.sort(compareNativeTestEntries);
}

function upsertIndexedEntry(
    entries: ReturnType<typeof nativeTestTreeEntry>[],
    scope: ReturnType<typeof resolveNativeTestScope>,
    relativePath: string,
): void {
    const nextEntry = nativeTestTreeEntry(scope, relativePath);
    const index = entries.findIndex(
        (entry) => entry.relativePath === nextEntry.relativePath,
    );
    if (index >= 0) {
        entries[index] = nextEntry;
    } else {
        entries.push(nextEntry);
    }
    entries.sort(compareNativeTestEntries);
}

function nativeTestTreeEntry(
    scope: ReturnType<typeof resolveNativeTestScope>,
    relativePath: string,
) {
    const absolutePath = resolveNativeTestPath(scope.rootPath, relativePath);
    const stat = fs.statSync(absolutePath);
    const name = path.basename(relativePath);
    const parentRelativePath = path.posix.dirname(relativePath);
    const isDirectory = stat.isDirectory();
    return {
        absolutePath,
        extension: isDirectory ? null : resolveExtension(name),
        gitStatus: null,
        hasChildren: isDirectory && hasNativeTestChildren(absolutePath),
        id: `${scope.projectId}:${relativePath}`,
        isGitIgnored: false,
        kind: isDirectory ? "directory" : "file",
        name,
        parentRelativePath:
            parentRelativePath === "." ? null : parentRelativePath,
        projectId: scope.projectId,
        relativePath,
        worktreeId: scope.worktreeId,
    };
}

function nativeTestReadFileResult(
    scope: ReturnType<typeof resolveNativeTestScope>,
    relativePath: string,
) {
    const absolutePath = resolveNativeTestPath(scope.rootPath, relativePath);
    const content = fs.readFileSync(absolutePath, "utf8");
    const stat = fs.statSync(absolutePath);
    return {
        content,
        contentHash: "test-content",
        encoding: "utf8",
        imageDataBase64: null,
        isBinary: false,
        isTooLarge: false,
        kind: "text",
        lineEnding: content.includes("\r\n") ? "\r\n" : "\n",
        mimeType: "text/plain",
        mtimeMs: stat.mtimeMs,
        name: path.basename(relativePath),
        path: absolutePath,
        projectId: scope.projectId,
        relativePath,
        sizeBytes: Buffer.byteLength(content),
        worktreeId: scope.worktreeId,
    };
}

function nativeTestFsEntry(
    scope: ReturnType<typeof resolveNativeTestScope>,
    relativePath: string,
) {
    const absolutePath = resolveNativeTestPath(scope.rootPath, relativePath);
    const stat = fs.statSync(absolutePath);
    return {
        contentHash: null,
        isBinary: false,
        isDirectory: stat.isDirectory(),
        isSymlink: false,
        isTooLarge: false,
        kind: stat.isDirectory() ? "directory" : "file",
        mtimeMs: stat.mtimeMs,
        path: absolutePath,
        projectId: scope.projectId,
        relativePath,
        sizeBytes: stat.isFile() ? stat.size : null,
        status: "clean",
        worktreeId: scope.worktreeId,
    };
}

function nativeTestMutationResult(
    scope: ReturnType<typeof resolveNativeTestScope>,
    relativePath: string,
) {
    const entry = nativeTestFsEntry(scope, relativePath);
    const parentRelativePath = path.posix.dirname(relativePath);
    return {
        entry,
        kind: entry.kind,
        name: path.basename(relativePath),
        parentRelativePath:
            parentRelativePath === "." ? null : parentRelativePath,
        relativePath,
    };
}

function nativeTestIndexStatus(
    scope: ReturnType<typeof resolveNativeTestScope>,
    entryCount: number,
) {
    return {
        generation: 1,
        occurredAt: "2026-06-20T00:00:00.000Z",
        projectId: scope.projectId,
        stats: nativeTestIndexStats(entryCount),
        status: "ready",
        worktreeId: scope.worktreeId,
    };
}

function nativeTestIndexStats(entryCount: number) {
    return {
        durationMs: 1,
        entryCount,
        indexedDirectoryCount: 0,
        indexedFileCount: entryCount,
        reason: null,
        skippedCount: 0,
        truncated: false,
    };
}

function scoreNativeTestSearchEntry(relativePath: string, query: string): number {
    const lowerPath = relativePath.toLowerCase();
    const lowerName = path.posix.basename(lowerPath);
    const depthPenalty = lowerPath.split("/").length - 1;
    if (lowerName === query) {
        return 10_000 - depthPenalty;
    }
    if (lowerName.startsWith(query)) {
        return 9_000 - depthPenalty;
    }
    if (lowerName.includes(query)) {
        return 8_000 - depthPenalty;
    }
    if (lowerPath.includes(query)) {
        return 7_000 - depthPenalty;
    }
    if (isSubsequence(query, lowerName)) {
        return 6_000 - depthPenalty;
    }
    if (isSubsequence(query, lowerPath)) {
        return 5_000 - depthPenalty;
    }
    return 0;
}

function isSubsequence(query: string, value: string): boolean {
    let cursor = 0;
    for (const character of value) {
        if (character === query[cursor]) {
            cursor += 1;
        }
        if (cursor === query.length) {
            return true;
        }
    }
    return query.length === 0;
}

function hasNativeTestChildren(absolutePath: string): boolean {
    return fs
        .readdirSync(absolutePath, { withFileTypes: true })
        .some((entry) => entry.isDirectory() || entry.isFile());
}

function compareNativeTestEntries(
    left: ReturnType<typeof nativeTestTreeEntry>,
    right: ReturnType<typeof nativeTestTreeEntry>,
): number {
    return (
        Number(left.kind !== "directory") - Number(right.kind !== "directory") ||
        left.name.localeCompare(right.name, undefined, {
            sensitivity: "base",
        }) ||
        left.relativePath.localeCompare(right.relativePath)
    );
}

function resolveNativeTestPath(
    rootPath: string,
    relativePath: string | null,
): string {
    return relativePath
        ? path.join(rootPath, ...relativePath.split("/"))
        : rootPath;
}

function toNativeRelativePath(rootPath: string, absolutePath: string): string {
    return path.relative(rootPath, absolutePath).split(path.sep).join("/");
}

function joinNativeRelativePath(
    parentRelativePath: string | null,
    name: string,
): string {
    return parentRelativePath ? `${parentRelativePath}/${name}` : name;
}

function resolveExtension(name: string): string | null {
    const extension = path.extname(name).slice(1);
    return extension || null;
}

function requireString(value: unknown): string {
    if (typeof value !== "string") {
        throw new Error("Expected native test value to be a string.");
    }
    return value;
}

function requireNullableString(value: unknown): string | null {
    if (value === null || value === undefined) {
        return null;
    }
    return requireString(value);
}

function gatewayWith(
    requestMock: (command: string, args?: Record<string, unknown>) => Promise<unknown>,
): NativeFsGateway {
    const request: NativeBackendRequester["request"] = async (...args) => {
        const [command] = args;
        if (
            command === "fs_watch_sync_registry" ||
            command === "fs_watch_start" ||
            command === "fs_watch_stop"
        ) {
            return null as never;
        }
        return (await requestMock(...args)) as never;
    };
    return new NativeFsGateway({ request });
}

function searchGatewayWith(
    requestMock: (command: string, args?: Record<string, unknown>) => Promise<unknown>,
): NativeSearchGateway {
    const request: NativeBackendRequester["request"] = async (...args) =>
        (await requestMock(...args)) as never;
    return new NativeSearchGateway({ request });
}

function nativeTreeEntry(overrides: {
    readonly hasChildren: boolean;
    readonly kind: "directory" | "file";
    readonly name: string;
    readonly relativePath: string;
}) {
    return {
        extension: overrides.kind === "file" ? "ts" : null,
        gitStatus: null,
        hasChildren: overrides.hasChildren,
        id: `project-1:${overrides.relativePath}`,
        isGitIgnored: false,
        kind: overrides.kind,
        name: overrides.name,
        parentRelativePath: null,
        projectId: "project-1",
        relativePath: overrides.relativePath,
        worktreeId: "project-1:primary",
    };
}

function nativeIndexedEntry(relativePath: string) {
    return {
        ...nativeTreeEntry({
            hasChildren: false,
            kind: "file",
            name: relativePath.split("/").at(-1) ?? relativePath,
            relativePath,
        }),
        policyState: "indexed",
    };
}

function nativeIndexStats() {
    return {
        durationMs: 1,
        entryCount: 1,
        indexedDirectoryCount: 0,
        indexedFileCount: 1,
        reason: null,
        skippedCount: 0,
        truncated: false,
    };
}

function nativeReadFileResult(overrides: {
    readonly content: string;
    readonly relativePath: string;
}) {
    return {
        content: overrides.content,
        contentHash: "hash",
        encoding: "utf8",
        imageDataBase64: null,
        isBinary: false,
        isTooLarge: false,
        kind: "text",
        lineEnding: "\n",
        mimeType: "text/plain",
        mtimeMs: 100,
        name: path.basename(overrides.relativePath),
        path: `/tmp/project/${overrides.relativePath}`,
        projectId: "project-1",
        relativePath: overrides.relativePath,
        sizeBytes: overrides.content.length,
        worktreeId: "project-1:primary",
    };
}

function nativeMutationResult(relativePath: string) {
    return {
        entry: nativeEntry(relativePath),
        kind: "file",
        name: path.basename(relativePath),
        parentRelativePath: path.posix.dirname(relativePath),
        relativePath,
    };
}

function nativeEntry(relativePath: string) {
    return {
        contentHash: null,
        isBinary: false,
        isDirectory: false,
        isSymlink: false,
        isTooLarge: false,
        kind: "file",
        mtimeMs: 100,
        path: `/tmp/project/${relativePath}`,
        projectId: "project-1",
        relativePath,
        sizeBytes: 10,
        status: "clean",
        worktreeId: "project-1:primary",
    };
}

function createTempProject(tempDirs: string[], name: string): string {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "comando-project-"));
    const projectRoot = path.join(tempDir, name);
    fs.mkdirSync(projectRoot, { recursive: true });
    tempDirs.push(tempDir);
    return projectRoot;
}

function seedProjectAppData(
    connection: ReturnType<typeof createTestConnection>,
    projectId: string,
    worktreeId: string,
): void {
    const now = new Date().toISOString();
    const sessionId = `session:${projectId}`;
    const workspaceId = `workspace:${projectId}`;
    const windowId = `window:${projectId}`;

    connection
        .prepare(
            `
            INSERT INTO project_settings (project_id, key, value, updated_at)
            VALUES (?, 'ai.model', 'codex', ?)
            `,
        )
        .run(projectId, now);
    connection
        .prepare(
            `
            INSERT INTO chat_sessions (
                id,
                project_id,
                worktree_id,
                title,
                runtime,
                status,
                draft,
                created_at,
                updated_at,
                last_opened_at
            )
            VALUES (?, ?, ?, 'History', 'codex', 'idle', '', ?, ?, ?)
            `,
        )
        .run(sessionId, projectId, worktreeId, now, now, now);
    connection
        .prepare(
            `
            INSERT INTO chat_transcripts (
                id,
                session_id,
                transcript_json,
                message_count,
                created_at,
                updated_at
            )
            VALUES (?, ?, '{}', 1, ?, ?)
            `,
        )
        .run(`transcript:${projectId}`, sessionId, now, now);
    connection
        .prepare(
            `
            INSERT INTO chat_session_events (
                id,
                session_id,
                sequence,
                event_type,
                payload_json,
                created_at
            )
            VALUES (?, ?, 1, 'message', '{}', ?)
            `,
        )
        .run(`event:${projectId}`, sessionId, now);
    connection
        .prepare(
            `
            INSERT INTO review_artifacts (
                id,
                session_id,
                artifact_type,
                title,
                payload_json,
                created_at,
                updated_at
            )
            VALUES (?, ?, 'review', 'Review', '{}', ?, ?)
            `,
        )
        .run(`artifact:${projectId}`, sessionId, now, now);
    connection
        .prepare(
            `
            INSERT INTO workspace_layouts (
                id,
                root_node_json,
                active_pane_id,
                created_at,
                updated_at
            )
            VALUES (?, '{}', 'pane-root', ?, ?)
            `,
        )
        .run(workspaceId, now, now);
    connection
        .prepare(
            `
            INSERT INTO workspace_tabs (
                id,
                workspace_id,
                kind,
                title,
                payload_json,
                created_at,
                position,
                worktree_id
            )
            VALUES (?, ?, 'chat', 'History', ?, ?, 0, ?)
            `,
        )
        .run(
            `tab:${projectId}`,
            workspaceId,
            JSON.stringify({ projectId }),
            now,
            worktreeId,
        );
    connection
        .prepare(
            `
            INSERT INTO app_windows (
                id,
                kind,
                title,
                width,
                height,
                created_at,
                updated_at,
                last_seen_at
            )
            VALUES (?, 'main', 'Comando', 1200, 800, ?, ?, ?)
            `,
        )
        .run(windowId, now, now, now);
    connection
        .prepare(
            `
            INSERT INTO workspace_sessions (
                id,
                window_id,
                workspace_id,
                active_project_id,
                active_worktree_id,
                created_at,
                updated_at,
                last_opened_at,
                shell_state_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}')
            `,
        )
        .run(
            `workspace-session:${projectId}`,
            windowId,
            workspaceId,
            projectId,
            worktreeId,
            now,
            now,
            now,
        );
}

function countRows(
    connection: ReturnType<typeof createTestConnection>,
    tableName:
        | "chat_sessions"
        | "chat_transcripts"
        | "project_settings"
        | "recent_projects"
        | "workspace_layouts"
        | "workspace_sessions"
        | "workspace_tabs",
    projectId: string,
): number {
    if (tableName === "workspace_layouts") {
        const row = connection
            .prepare(
                `
                SELECT COUNT(*) AS count
                FROM workspace_layouts
                WHERE id = ?
                `,
            )
            .get(`workspace:${projectId}`) as { count: number } | undefined;
        return row?.count ?? 0;
    }

    if (tableName === "workspace_sessions") {
        const row = connection
            .prepare(
                `
                SELECT COUNT(*) AS count
                FROM workspace_sessions
                WHERE active_project_id = ?
                `,
            )
            .get(projectId) as { count: number } | undefined;
        return row?.count ?? 0;
    }

    if (tableName === "workspace_tabs") {
        const row = connection
            .prepare(
                `
                SELECT COUNT(*) AS count
                FROM workspace_tabs
                WHERE json_valid(payload_json)
                  AND json_extract(payload_json, '$.projectId') = ?
                `,
            )
            .get(projectId) as { count: number } | undefined;
        return row?.count ?? 0;
    }

    const row = connection
        .prepare(
            tableName === "chat_transcripts"
                ? `
                  SELECT COUNT(*) AS count
                  FROM chat_transcripts
                  INNER JOIN chat_sessions
                    ON chat_sessions.id = chat_transcripts.session_id
                  WHERE chat_sessions.project_id = ?
                `
                : `SELECT COUNT(*) AS count FROM ${tableName} WHERE project_id = ?`,
        )
        .get(projectId) as { count: number } | undefined;

    return row?.count ?? 0;
}
