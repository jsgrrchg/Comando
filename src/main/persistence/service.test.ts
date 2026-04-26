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

    it("finds the latest closed main session for a project", () => {
        const connection = createTestConnection();
        seedProject(connection, "project-1");
        seedProject(connection, "project-2");
        const service = new PersistenceService(connection);

        const olderSnapshot = service.createMainWindowSession({
            projectId: "project-1",
            shellState: {
                activeSurface: "workspace",
                leftWidth: 280,
            },
        });
        const newerSnapshot = service.createMainWindowSession({
            projectId: "project-1",
            shellState: {
                activeSurface: "composer",
                leftWidth: 320,
            },
        });
        const otherSnapshot = service.createMainWindowSession({
            projectId: "project-2",
        });

        service.markWindowClosed(olderSnapshot.windowContext!.windowId);
        service.markWindowClosed(newerSnapshot.windowContext!.windowId);
        service.markWindowClosed(otherSnapshot.windowContext!.windowId);
        setWorkspaceSessionUpdatedAt(
            connection,
            olderSnapshot.windowContext!.windowId,
            "2026-01-01T00:00:00.000Z",
        );
        setWorkspaceSessionUpdatedAt(
            connection,
            newerSnapshot.windowContext!.windowId,
            "2026-01-02T00:00:00.000Z",
        );
        setWorkspaceSessionUpdatedAt(
            connection,
            otherSnapshot.windowContext!.windowId,
            "2026-01-03T00:00:00.000Z",
        );

        const snapshot =
            service.findClosedMainWindowSnapshotForProject("project-1");

        expect(snapshot?.windowContext?.windowId).toBe(
            newerSnapshot.windowContext!.windowId,
        );
        expect(snapshot?.shellState).toEqual({
            activeSurface: "composer",
            leftWidth: 320,
        });
    });

    it("filters closed main sessions by requested worktree", () => {
        const connection = createTestConnection();
        seedProject(connection, "project-1");
        seedProjectWorktree(connection, {
            id: "project-1:feature",
            isPrimary: false,
            projectId: "project-1",
        });
        const service = new PersistenceService(connection);

        const primarySnapshot = service.createMainWindowSession({
            projectId: "project-1",
            worktreeId: null,
        });
        const worktreeSnapshot = service.createMainWindowSession({
            projectId: "project-1",
            worktreeId: "project-1:feature",
        });

        service.markWindowClosed(primarySnapshot.windowContext!.windowId);
        service.markWindowClosed(worktreeSnapshot.windowContext!.windowId);

        expect(
            service.findClosedMainWindowSnapshotForProject(
                "project-1",
                "project-1:feature",
            )?.windowContext?.windowId,
        ).toBe(worktreeSnapshot.windowContext!.windowId);
        expect(
            service.findClosedMainWindowSnapshotForProject("project-1", null)
                ?.windowContext?.windowId,
        ).toBe(primarySnapshot.windowContext!.windowId);
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

function seedProjectWorktree(
    connection: ReturnType<typeof createTestConnection>,
    input: {
        readonly id: string;
        readonly isPrimary: boolean;
        readonly projectId: string;
    },
): void {
    const now = new Date().toISOString();

    connection
        .prepare(
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
            VALUES (?, ?, ?, NULL, NULL, ?, ?, ?)
            `,
        )
        .run(
            input.id,
            input.projectId,
            `/tmp/${input.id}`,
            input.isPrimary ? 1 : 0,
            now,
            now,
        );
}

function setWorkspaceSessionUpdatedAt(
    connection: ReturnType<typeof createTestConnection>,
    windowId: string,
    updatedAt: string,
): void {
    connection
        .prepare(
            `
            UPDATE workspace_sessions
            SET updated_at = ?
            WHERE window_id = ?
            `,
        )
        .run(updatedAt, windowId);
}
