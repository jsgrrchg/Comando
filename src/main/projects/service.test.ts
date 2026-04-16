import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceSnapshot } from "@shared/ipc";

import { databaseMigrations } from "@main/db/migrations";
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

        const [firstProject] = await projectService.addProjectPaths([
            projectRoot,
        ]);
        expect(firstProject).toBeDefined();
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

        projectService.removeProject(firstProject.id);
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

        const [reopenedProject] = await projectService.addProjectPaths([
            projectRoot,
        ]);
        expect(reopenedProject?.id).toBe(firstProject.id);
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

        const [project] = await projectService.addProjectPaths([projectRoot]);
        expect(project).toBeDefined();
        if (!project) {
            throw new Error("Expected the project to be created.");
        }

        const readdirSpy = vi.spyOn(fs, "readdirSync");

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

        const initialDirectoryReads = readdirSpy.mock.calls.length;

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
        expect(readdirSpy.mock.calls.length).toBe(initialDirectoryReads);

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
        expect(readdirSpy.mock.calls.length).toBeGreaterThan(
            initialDirectoryReads,
        );
    });

    it("rebuilds worker registry and search caches after a worker restart", async () => {
        const connection = createTestConnection();
        const projectService = createProjectService(connection);
        const projectRoot = createTempProject(tempDirs, "restart-cache");

        fs.mkdirSync(path.join(projectRoot, "src"), {
            recursive: true,
        });
        fs.writeFileSync(
            path.join(projectRoot, "src", "RestartSignal.ts"),
            "export const RestartSignal = true;\n",
        );

        const [project] = await projectService.addProjectPaths([projectRoot]);
        expect(project).toBeDefined();
        if (!project) {
            throw new Error("Expected the project to be created.");
        }

        const readdirSpy = vi.spyOn(fs, "readdirSync");

        await expect(
            projectService.searchProjectEntries({
                limit: 10,
                projectId: project.id,
                query: "restartsignal",
            }),
        ).resolves.toEqual([
            expect.objectContaining({
                kind: "file",
                relativePath: "src/RestartSignal.ts",
            }),
        ]);

        const cachedReadCount = readdirSpy.mock.calls.length;

        await expect(
            projectService.searchProjectEntries({
                limit: 10,
                projectId: project.id,
                query: "restartsignal",
            }),
        ).resolves.toHaveLength(1);
        expect(readdirSpy.mock.calls.length).toBe(cachedReadCount);

        projectService.handleProjectWorkerRestarted();

        await expect(
            projectService.searchProjectEntries({
                limit: 10,
                projectId: project.id,
                query: "restartsignal",
            }),
        ).resolves.toHaveLength(1);
        expect(readdirSpy.mock.calls.length).toBeGreaterThan(cachedReadCount);
    });
});

function createTestConnection() {
    const connection = createSqliteCompatConnection();
    applyMigrations(connection, databaseMigrations);
    return connection;
}

function createProjectService(
    connection: ReturnType<typeof createTestConnection>,
) {
    return new ProjectService({
        onProjectTreeInvalidated: () => {},
        store: new SqliteProjectStore(connection),
    });
}

function createTempProject(tempDirs: string[], name: string): string {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "comando-project-"));
    const projectRoot = path.join(tempDir, name);
    fs.mkdirSync(projectRoot, { recursive: true });
    tempDirs.push(tempDir);
    return projectRoot;
}
