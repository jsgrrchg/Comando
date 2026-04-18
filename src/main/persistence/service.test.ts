import { describe, expect, it } from "vitest";

import { databaseMigrations } from "@main/db/migrations";
import {
    applyMigrations,
    createSqliteCompatConnection,
} from "@main/testing/sqlite-compat";

import { PersistenceService } from "./service";

describe("PersistenceService", () => {
    it("creates and restores an isolated main session per windowId", () => {
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

        const snapshot = service.loadSnapshot(windowId!);

        expect(snapshot?.activeProjectId).toBe("project-1");
        expect(snapshot?.activeWorktreeId).toBeNull();
        expect(snapshot?.shellState).toEqual({
            activeSurface: "workspace",
            leftWidth: 280,
        });
        expect(snapshot?.windowContext).toMatchObject({
            projectId: "project-1",
            windowId,
            windowKind: "main",
            worktreeId: null,
        });
        expect(typeof snapshot?.windowContext?.workspaceId).toBe("string");
        expect(typeof snapshot?.windowContext?.workspaceSessionId).toBe(
            "string",
        );
        expect(snapshot?.windowState).toEqual({
            height: 900,
            id: windowId!,
            isFullScreen: false,
            isMaximized: true,
            width: 1440,
            x: 24,
            y: 32,
        });
    });

    it("does not restore sessions marked as closed", () => {
        const connection = createTestConnection();
        const service = new PersistenceService(connection);

        const snapshotA = service.createMainWindowSession();
        const snapshotB = service.createMainWindowSession();

        service.markWindowClosed(snapshotA.windowContext!.windowId);

        const snapshots = service.listRestorableMainWindowSnapshots();

        expect(snapshots).toHaveLength(1);
        expect(snapshots[0]?.windowContext?.windowId).toBe(
            snapshotB.windowContext!.windowId,
        );
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
