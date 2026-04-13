import { describe, expect, it } from "vitest";

import { databaseMigrations } from "./migrations";

describe("databaseMigrations", () => {
    it("define una migracion fundacional para la base local", () => {
        const [
            foundationMigration,
            projectsMigration,
            workspaceMigration,
            persistenceMigration,
        ] = databaseMigrations;

        expect(databaseMigrations).toHaveLength(4);
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
    });
});
