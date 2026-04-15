import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { WorkspaceSnapshot } from "@shared/ipc";

import { databaseMigrations } from "@main/db/migrations";
import {
    applyMigrations,
    createSqliteCompatConnection,
} from "@main/testing/sqlite-compat";
import { WorkspaceService } from "@main/workspace/service";

import { ProjectService, shouldIgnoreProjectWatchPath } from "./service";

describe("project watcher filtering", () => {
    it("ignores git index updates triggered by status refreshes", () => {
        expect(shouldIgnoreProjectWatchPath(".git/index")).toBe(true);
        expect(shouldIgnoreProjectWatchPath(".git/index.lock")).toBe(true);
        expect(shouldIgnoreProjectWatchPath(".git\\index")).toBe(true);
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

        const [firstProject] = projectService.addProjectPaths([projectRoot]);
        expect(firstProject).toBeDefined();

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
                    projectId: firstProject!.id,
                    relativePath: "src/index.ts",
                    title: "index.ts",
                    worktreeId: `${firstProject!.id}:primary`,
                },
            ],
        };

        workspaceService.saveSnapshot("workspace-1", snapshot);

        projectService.removeProject(firstProject!.id);
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
            id: firstProject!.id,
            is_hidden: 1,
        });

        const [reopenedProject] = projectService.addProjectPaths([projectRoot]);
        expect(reopenedProject?.id).toBe(firstProject!.id);

        const restoredSnapshot = workspaceService.loadSnapshot("workspace-1");
        expect(restoredSnapshot).toEqual(snapshot);

        await expect(
            projectService.openProjectFile({
                projectId: reopenedProject!.id,
                relativePath: "src/index.ts",
                worktreeId: `${reopenedProject!.id}:primary`,
            }),
        ).resolves.toMatchObject({
            absolutePath: projectFilePath,
            projectId: reopenedProject!.id,
        });
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
        connection,
        onProjectTreeInvalidated: () => {},
    });
}

function createTempProject(tempDirs: string[], name: string): string {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "comando-project-"));
    const projectRoot = path.join(tempDir, name);
    fs.mkdirSync(projectRoot, { recursive: true });
    tempDirs.push(tempDir);
    return projectRoot;
}
