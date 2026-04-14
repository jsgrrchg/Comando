import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
    applyMigrations,
    createSqliteCompatConnection,
} from "@main/testing/sqlite-compat";

import { databaseMigrations } from "./migrations";

describe("databaseMigrations", () => {
    it("definen la base local y el soporte Git para worktrees", () => {
        const [
            foundationMigration,
            projectsMigration,
            workspaceMigration,
            persistenceMigration,
            projectSettingsMigration,
            shellStateMigration,
            gitWorktreesMigration,
        ] = databaseMigrations;

        expect(databaseMigrations).toHaveLength(7);
        expect(foundationMigration?.id).toBe("0001-foundation");
        expect(foundationMigration?.sql).toContain(
            "CREATE TABLE IF NOT EXISTS app_settings",
        );
        expect(foundationMigration?.sql).toContain("app.bundle_id_placeholder");
        expect(projectsMigration?.id).toBe("0002-projects");
        expect(projectsMigration?.sql).toContain(
            "CREATE TABLE IF NOT EXISTS projects",
        );
        expect(projectsMigration?.sql).toContain(
            "CREATE TABLE IF NOT EXISTS project_roots",
        );
        expect(projectsMigration?.sql).toContain(
            "CREATE TABLE IF NOT EXISTS recent_projects",
        );
        expect(workspaceMigration?.id).toBe("0003-workspace");
        expect(workspaceMigration?.sql).toContain(
            "CREATE TABLE IF NOT EXISTS workspace_layouts",
        );
        expect(workspaceMigration?.sql).toContain(
            "CREATE TABLE IF NOT EXISTS workspace_tabs",
        );
        expect(persistenceMigration?.id).toBe("0004-persistence");
        expect(persistenceMigration?.sql).toContain(
            "CREATE TABLE IF NOT EXISTS app_windows",
        );
        expect(persistenceMigration?.sql).toContain(
            "CREATE TABLE IF NOT EXISTS workspace_sessions",
        );
        expect(persistenceMigration?.sql).toContain(
            "CREATE TABLE IF NOT EXISTS chat_sessions",
        );
        expect(persistenceMigration?.sql).toContain(
            "CREATE TABLE IF NOT EXISTS chat_transcripts",
        );
        expect(persistenceMigration?.sql).toContain(
            "CREATE TABLE IF NOT EXISTS chat_session_events",
        );
        expect(persistenceMigration?.sql).toContain(
            "CREATE TABLE IF NOT EXISTS review_artifacts",
        );
        expect(projectSettingsMigration?.id).toBe("0005-project-settings");
        expect(projectSettingsMigration?.sql).toContain(
            "CREATE TABLE IF NOT EXISTS project_settings",
        );
        expect(shellStateMigration?.id).toBe(
            "0006-workspace-session-shell-state",
        );
        expect(shellStateMigration?.sql).toContain(
            "ALTER TABLE workspace_sessions",
        );
        expect(gitWorktreesMigration?.id).toBe("0007-git-worktrees");
        expect(gitWorktreesMigration?.sql).toContain("ALTER TABLE projects");
        expect(gitWorktreesMigration?.sql).toContain(
            "CREATE TABLE IF NOT EXISTS project_worktrees",
        );
        expect(gitWorktreesMigration?.sql).toContain(
            "ALTER TABLE workspace_sessions",
        );
        expect(gitWorktreesMigration?.sql).toContain(
            "ALTER TABLE chat_sessions",
        );
        expect(gitWorktreesMigration?.sql).toContain(
            "ALTER TABLE workspace_tabs",
        );
        expect(gitWorktreesMigration?.sql).toContain(
            "json_extract(payload_json, '$.projectId')",
        );
    });

    it("backfillea canonical_root_path y worktree_id desde un esquema previo", () => {
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "comando-db-"));
        const databaseFile = path.join(dataDir, "comando.sqlite3");

        try {
            const legacyDb = createSqliteCompatConnection(databaseFile);
            legacyDb.pragma("foreign_keys = ON");
            applyMigrations(legacyDb, databaseMigrations.slice(0, 6));

            legacyDb.exec(`
                INSERT INTO projects (id, name, created_at, updated_at)
                VALUES ('project-1', 'Alpha', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

                INSERT INTO project_roots (project_id, root_path, is_primary)
                VALUES ('project-1', '/workspace/alpha', 1);

                INSERT INTO app_windows (id, kind, title, width, height, is_maximized, is_full_screen, created_at, updated_at, last_seen_at)
                VALUES ('window-1', 'main', 'Main', 1200, 900, 0, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

                INSERT INTO workspace_layouts (id, root_node_json, active_pane_id, created_at, updated_at)
                VALUES ('workspace-1', '{"id":"pane-root","type":"pane","tabIds":[],"activeTabId":null}', 'pane-root', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

                INSERT INTO workspace_sessions (id, window_id, workspace_id, active_project_id, created_at, updated_at, last_opened_at, shell_state_json, is_open)
                VALUES ('session-1', 'window-1', 'workspace-1', 'project-1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, 1);

                INSERT INTO chat_sessions (id, project_id, title, runtime, status, draft, created_at, updated_at, last_opened_at)
                VALUES ('chat-1', 'project-1', 'Chat 1', 'codex', 'idle', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

                INSERT INTO chat_transcripts (id, session_id, transcript_json, message_count, created_at, updated_at)
                VALUES ('transcript:chat-1', 'chat-1', '{"version":1,"sessionId":"chat-1","messages":[]}', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

                INSERT INTO workspace_tabs (id, workspace_id, kind, title, payload_json, created_at, position)
                VALUES ('tab-1', 'workspace-1', 'file', 'Alpha', '{"kind":"file","projectId":"project-1","relativePath":"src/index.ts"}', '2026-01-01T00:00:00.000Z', 0);
            `);

            legacyDb.close();

            const migratedDb = createSqliteCompatConnection(databaseFile);
            migratedDb.pragma("foreign_keys = ON");

            try {
                applyMigrations(migratedDb, databaseMigrations.slice(6));

                const projectRow = migratedDb
                    .prepare<
                        [],
                        { canonical_root_path: string }
                    >("SELECT canonical_root_path FROM projects WHERE id = 'project-1'")
                    .get();
                expect(projectRow?.canonical_root_path).toBe(
                    "/workspace/alpha",
                );

                const worktreeRow = migratedDb
                    .prepare<
                        [],
                        { id: string; root_path: string; is_primary: number }
                    >("SELECT id, root_path, is_primary FROM project_worktrees WHERE project_id = 'project-1'")
                    .get();
                expect(worktreeRow).toEqual({
                    id: "project-1:primary",
                    is_primary: 1,
                    root_path: "/workspace/alpha",
                });

                const sessionRow = migratedDb
                    .prepare<
                        [],
                        { active_worktree_id: string | null }
                    >("SELECT active_worktree_id FROM workspace_sessions WHERE id = 'session-1'")
                    .get();
                expect(sessionRow?.active_worktree_id).toBe(
                    "project-1:primary",
                );

                const chatRow = migratedDb
                    .prepare<
                        [],
                        { worktree_id: string | null }
                    >("SELECT worktree_id FROM chat_sessions WHERE id = 'chat-1'")
                    .get();
                expect(chatRow?.worktree_id).toBe("project-1:primary");

                const tabRow = migratedDb
                    .prepare<
                        [],
                        { worktree_id: string | null }
                    >("SELECT worktree_id FROM workspace_tabs WHERE id = 'tab-1'")
                    .get();
                expect(tabRow?.worktree_id).toBe("project-1:primary");
            } finally {
                migratedDb.close();
            }
        } finally {
            fs.rmSync(dataDir, { recursive: true, force: true });
        }
    });
});
