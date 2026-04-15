import { describe, expect, it } from "vitest";

import { databaseMigrations } from "@main/db/migrations";
import {
    applyMigrations,
    createSqliteCompatConnection,
} from "@main/testing/sqlite-compat";

import { PersistenceService } from "./service";

describe("PersistenceService", () => {
    it("crea y restaura una sesion principal aislada por windowId", () => {
        const connection = createTestConnection();
        seedProject(connection, "project-1");

        const service = new PersistenceService(connection);
        const created = service.createMainWindowSession({
            projectId: "project-1",
            shellState: {
                activeSurface: "workspace",
                leftWidth: 280,
            },
        });
        const windowId = created.windowContext?.windowId;

        expect(windowId).toBeTruthy();

        service.saveWindowState({
            height: 900,
            id: windowId!,
            isFullScreen: false,
            isMaximized: true,
            width: 1440,
            x: 24,
            y: 32,
        });
        service.saveActiveProjectId(windowId!, "project-1");

        expect(service.loadSnapshot(windowId!)).toEqual({
            activeProjectId: "project-1",
            activeWorktreeId: null,
            shellState: {
                activeSurface: "workspace",
                leftWidth: 280,
            },
            windowContext: {
                projectId: "project-1",
                windowId,
                windowKind: "main",
                worktreeId: null,
                workspaceId: expect.any(String),
                workspaceSessionId: expect.any(String),
            },
            windowState: {
                height: 900,
                id: windowId!,
                isFullScreen: false,
                isMaximized: true,
                width: 1440,
                x: 24,
                y: 32,
            },
        });
    });

    it("no restaura sesiones marcadas como cerradas", () => {
        const connection = createTestConnection();
        const service = new PersistenceService(connection);

        const snapshotA = service.createMainWindowSession();
        const snapshotB = service.createMainWindowSession();

        service.markWindowClosed(snapshotA.windowContext!.windowId);

        expect(service.listRestorableMainWindowSnapshots()).toEqual([
            expect.objectContaining({
                windowContext: expect.objectContaining({
                    windowId: snapshotB.windowContext!.windowId,
                }),
            }),
        ]);
    });
});

function createTestConnection() {
    const connection = createSqliteCompatConnection();
    applyMigrations(connection, databaseMigrations);
    return connection;
}

function seedProject(
    connection: ReturnType<typeof createTestConnection>,
    projectId: string,
): void {
    const now = new Date().toISOString();

    connection
        .prepare(
            `
            INSERT INTO projects (id, name, created_at, updated_at)
            VALUES (?, ?, ?, ?)
            `,
        )
        .run(projectId, "Project", now, now);

    connection
        .prepare(
            `
            INSERT INTO project_roots (project_id, root_path, is_primary)
            VALUES (?, ?, 1)
            `,
        )
        .run(projectId, `/tmp/${projectId}`);
}
