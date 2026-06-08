import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

import type Database from "better-sqlite3";

import type { ProjectAppDataSummary, ProjectSummary } from "@shared/ipc";

import type { Awaitable } from "../db/awaitable";
import { debugBenignError } from "../observability/logging";

interface PersistedProjectRow {
    readonly is_hidden?: number;
    readonly id: string;
    readonly name: string;
    readonly canonical_root_path: string;
    readonly created_at: string;
    readonly updated_at: string;
    readonly last_opened_at: string | null;
}

interface PersistedProjectWorktreeRow {
    readonly branch_name: string | null;
    readonly head_sha: string | null;
    readonly id: string;
    readonly is_primary: number;
    readonly project_id: string;
    readonly root_path: string;
    readonly updated_at: string;
}

export interface ProjectRecord {
    readonly canonicalRootPath: string;
    readonly id: string;
    readonly rootPath: string;
}

export interface ProjectStoreProjectRecord extends ProjectSummary {
    readonly canonicalRootPath: string;
}

export interface ProjectStoreWorktreeRecord {
    readonly branchName: string | null;
    readonly headSha: string | null;
    readonly id: string;
    readonly isPrimary: boolean;
    readonly projectId: string;
    readonly rootPath: string;
    readonly updatedAt: string;
}

export interface ProjectStoreAddPathsResult {
    readonly projects: readonly ProjectSummary[];
    readonly touchedProjectIds: readonly string[];
    readonly touchedRootPaths: readonly string[];
}

export interface ProjectStore {
    loadState(): ProjectStoreStateSnapshot;
    addProjectPaths(
        projectPaths: readonly string[],
    ): Awaitable<ProjectStoreAddPathsResult>;
    clearProjectAppData(projectId: string): Awaitable<ProjectAppDataSummary>;
    getProject(projectId: string): ProjectRecord | null;
    getProjectAppDataSummary(
        projectId: string,
    ): Awaitable<ProjectAppDataSummary>;
    getProjectWorktree(worktreeId: string): ProjectStoreWorktreeRecord | null;
    listProjects(): readonly ProjectSummary[];
    listProjectWorktrees(
        projectId: string,
    ): readonly ProjectStoreWorktreeRecord[];
    removeProject(projectId: string): void;
    relocateProject(
        projectId: string,
        projectPath: string,
    ): Awaitable<ProjectSummary>;
    syncProjectWorktrees(
        projectId: string,
        worktrees: readonly {
            readonly branchName: string | null;
            readonly headSha: string | null;
            readonly rootPath: string;
        }[],
    ): Awaitable<readonly ProjectStoreWorktreeRecord[]>;
    touchProject(projectId: string): void;
}

export interface ProjectStoreStateSnapshot {
    readonly projects: readonly ProjectStoreProjectRecord[];
    readonly worktrees: readonly ProjectStoreWorktreeRecord[];
}

export class SqliteProjectStore implements ProjectStore {
    readonly #connection: Database.Database;

    constructor(connection: Database.Database) {
        this.#connection = connection;
    }

    loadState(): ProjectStoreStateSnapshot {
        return {
            projects: this.#listProjectRecords(),
            worktrees: this.#listAllVisibleWorktrees(),
        };
    }

    listProjects(): readonly ProjectSummary[] {
        return this.#listProjectRecords().map((project) => ({
            createdAt: project.createdAt,
            id: project.id,
            lastOpenedAt: project.lastOpenedAt,
            name: project.name,
            rootPath: project.rootPath,
            updatedAt: project.updatedAt,
        }));
    }

    addProjectPaths(
        projectPaths: readonly string[],
    ): ProjectStoreAddPathsResult {
        const insertProject = this.#connection.prepare<
            [string, string, string, string, string],
            void
        >(
            `
            INSERT INTO projects (id, name, canonical_root_path, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            `,
        );
        const insertRoot = this.#connection.prepare<
            [string, string, number],
            void
        >(
            `
            INSERT OR IGNORE INTO project_roots (project_id, root_path, is_primary)
            VALUES (?, ?, ?)
            `,
        );
        const insertWorktree = this.#connection.prepare<
            [
                string,
                string,
                string,
                string | null,
                string | null,
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
        );
        const touchRecent = this.#connection.prepare<[string, string], void>(
            `
            INSERT INTO recent_projects (project_id, last_opened_at)
            VALUES (?, ?)
            ON CONFLICT(project_id) DO UPDATE SET
                last_opened_at = excluded.last_opened_at
            `,
        );
        const findExisting = this.#connection.prepare<
            [string],
            { id: string } | undefined
        >(
            `
            SELECT id
            FROM projects
            WHERE canonical_root_path = ?
            `,
        );
        const reviveProject = this.#connection.prepare<
            [string, string, string, string],
            void
        >(
            `
            UPDATE projects
            SET name = ?,
                updated_at = ?,
                is_hidden = 0
            WHERE id = ?
              AND canonical_root_path = ?
            `,
        );
        const findExistingWorktree = this.#connection.prepare<
            [string],
            { id: string } | undefined
        >(
            `
            SELECT id
            FROM project_worktrees
            WHERE root_path = ?
            `,
        );
        const touchedProjectIds: string[] = [];
        const touchedRootPaths: string[] = [];

        const transaction = this.#connection.transaction(
            (normalizedPaths: readonly string[]) => {
                for (const normalizedPath of normalizedPaths) {
                    const projectPathMeta =
                        resolveProjectPathMetadata(normalizedPath);
                    const now = new Date().toISOString();
                    const existing = findExisting.get(
                        projectPathMeta.canonicalRootPath,
                    );

                    if (existing) {
                        reviveProject.run(
                            path.basename(projectPathMeta.canonicalRootPath),
                            now,
                            existing.id,
                            projectPathMeta.canonicalRootPath,
                        );
                        ensureProjectRoots({
                            canonicalRootPath:
                                projectPathMeta.canonicalRootPath,
                            insertRoot,
                            projectId: existing.id,
                            selectedRootPath: projectPathMeta.worktreeRootPath,
                        });
                        ensureProjectWorktree({
                            findExistingWorktree,
                            insertWorktree,
                            now,
                            projectId: existing.id,
                            rootPath: projectPathMeta.worktreeRootPath,
                        });
                        touchRecent.run(existing.id, now);
                        touchedProjectIds.push(existing.id);
                        touchedRootPaths.push(projectPathMeta.worktreeRootPath);
                        continue;
                    }

                    const projectId = randomUUID();
                    insertProject.run(
                        projectId,
                        path.basename(projectPathMeta.canonicalRootPath),
                        projectPathMeta.canonicalRootPath,
                        now,
                        now,
                    );
                    ensureProjectRoots({
                        canonicalRootPath: projectPathMeta.canonicalRootPath,
                        insertRoot,
                        projectId,
                        selectedRootPath: projectPathMeta.worktreeRootPath,
                    });
                    insertWorktree.run(
                        `${projectId}:primary`,
                        projectId,
                        projectPathMeta.canonicalRootPath,
                        null,
                        null,
                        1,
                        now,
                        now,
                    );
                    if (
                        projectPathMeta.worktreeRootPath !==
                        projectPathMeta.canonicalRootPath
                    ) {
                        ensureProjectWorktree({
                            findExistingWorktree,
                            insertWorktree,
                            now,
                            projectId,
                            rootPath: projectPathMeta.worktreeRootPath,
                        });
                    }
                    touchRecent.run(projectId, now);
                    touchedProjectIds.push(projectId);
                    touchedRootPaths.push(projectPathMeta.worktreeRootPath);
                }
            },
        );

        const normalizedPaths = projectPaths
            .map((projectPath) => path.resolve(projectPath))
            .filter(isDirectoryPath);

        transaction(normalizedPaths);

        return {
            projects: this.listProjects(),
            touchedProjectIds,
            touchedRootPaths,
        };
    }

    clearProjectAppData(projectId: string): ProjectAppDataSummary {
        const summary = this.getProjectAppDataSummary(projectId);
        const worktreeIds = this.#listProjectWorktreeIds(projectId);
        const workspaceLayoutIds = this.#listProjectWorkspaceLayoutIds(
            projectId,
            worktreeIds,
        );
        const deleteReviewArtifacts = this.#connection.prepare<
            [string],
            void
        >(
            `
            DELETE FROM review_artifacts
            WHERE session_id IN (
                SELECT id
                FROM chat_sessions
                WHERE project_id = ?
            )
            `,
        );
        const deleteSessionEvents = this.#connection.prepare<[string], void>(
            `
            DELETE FROM chat_session_events
            WHERE session_id IN (
                SELECT id
                FROM chat_sessions
                WHERE project_id = ?
            )
            `,
        );
        const deleteTranscripts = this.#connection.prepare<[string], void>(
            `
            DELETE FROM chat_transcripts
            WHERE session_id IN (
                SELECT id
                FROM chat_sessions
                WHERE project_id = ?
            )
            `,
        );
        const deleteSessions = this.#connection.prepare<[string], void>(
            "DELETE FROM chat_sessions WHERE project_id = ?",
        );
        const deleteProjectSettings = this.#connection.prepare<[string], void>(
            "DELETE FROM project_settings WHERE project_id = ?",
        );
        const deleteRecentProject = this.#connection.prepare<[string], void>(
            "DELETE FROM recent_projects WHERE project_id = ?",
        );
        const deleteWorkspaceTabsByProject = this.#connection.prepare<
            [string],
            void
        >(
            `
            DELETE FROM workspace_tabs
            WHERE json_valid(payload_json)
              AND json_extract(payload_json, '$.projectId') = ?
            `,
        );
        const clearWorkspaceSessionsByProject = this.#connection.prepare<
            [string],
            void
        >(
            `
            UPDATE workspace_sessions
            SET active_project_id = NULL,
                active_worktree_id = NULL,
                shell_state_json = NULL
            WHERE active_project_id = ?
            `,
        );
        const deleteWorkspaceTabsByWorktree =
            worktreeIds.length > 0
                ? this.#connection.prepare(
                      `
                      DELETE FROM workspace_tabs
                      WHERE worktree_id IN (${createPlaceholders(worktreeIds.length)})
                      `,
                  )
                : null;
        const clearWorkspaceSessionsByWorktree =
            worktreeIds.length > 0
                ? this.#connection.prepare(
                      `
                      UPDATE workspace_sessions
                      SET active_project_id = NULL,
                          active_worktree_id = NULL,
                          shell_state_json = NULL
                      WHERE active_worktree_id IN (${createPlaceholders(worktreeIds.length)})
                      `,
                  )
                : null;
        const deleteWorkspaceLayouts =
            workspaceLayoutIds.length > 0
                ? this.#connection.prepare(
                      `
                      DELETE FROM workspace_layouts
                      WHERE id IN (${createPlaceholders(workspaceLayoutIds.length)})
                      `,
                  )
                : null;

        const transaction = this.#connection.transaction(() => {
            deleteReviewArtifacts.run(projectId);
            deleteSessionEvents.run(projectId);
            deleteTranscripts.run(projectId);
            deleteSessions.run(projectId);
            deleteProjectSettings.run(projectId);
            deleteRecentProject.run(projectId);
            deleteWorkspaceTabsByProject.run(projectId);
            deleteWorkspaceTabsByWorktree?.run(...worktreeIds);
            deleteWorkspaceLayouts?.run(...workspaceLayoutIds);
            clearWorkspaceSessionsByProject.run(projectId);
            clearWorkspaceSessionsByWorktree?.run(...worktreeIds);
        });

        transaction();
        return summary;
    }

    getProjectAppDataSummary(projectId: string): ProjectAppDataSummary {
        const worktreeIds = this.#listProjectWorktreeIds(projectId);
        const chatSessionCount = getCount(
            this.#connection
                .prepare<[string], { count: number }>(
                    "SELECT COUNT(*) AS count FROM chat_sessions WHERE project_id = ?",
                )
                .get(projectId),
        );
        const projectSettingsCount = getCount(
            this.#connection
                .prepare<[string], { count: number }>(
                    "SELECT COUNT(*) AS count FROM project_settings WHERE project_id = ?",
                )
                .get(projectId),
        );
        const recentProjectCount = getCount(
            this.#connection
                .prepare<[string], { count: number }>(
                    "SELECT COUNT(*) AS count FROM recent_projects WHERE project_id = ?",
                )
                .get(projectId),
        );
        const workspaceTabCount = this.#countWorkspaceTabs(
            projectId,
            worktreeIds,
        );
        const workspaceSessionCount = this.#countWorkspaceSessions(
            projectId,
            worktreeIds,
        );
        const workspaceLayoutCount = this.#listProjectWorkspaceLayoutIds(
            projectId,
            worktreeIds,
        ).length;

        return {
            chatSessionCount,
            projectSettingsCount,
            recentProjectCount,
            workspaceLayoutCount,
            workspaceSessionCount,
            workspaceTabCount,
        };
    }

    removeProject(projectId: string): void {
        this.#connection
            .prepare<[string], void>(
                `
                UPDATE projects
                SET is_hidden = 1
                WHERE id = ?
                `,
            )
            .run(projectId);
        this.#connection
            .prepare<
                [string],
                void
            >("DELETE FROM recent_projects WHERE project_id = ?")
            .run(projectId);
    }

    relocateProject(projectId: string, projectPath: string): ProjectSummary {
        const project = this.getProject(projectId);
        if (!project) {
            throw new Error("The requested project does not exist anymore.");
        }

        const normalizedPath = path.resolve(projectPath);
        if (!isDirectoryPath(normalizedPath)) {
            throw new Error("Choose an existing folder for this project.");
        }

        const projectPathMeta = resolveProjectPathMetadata(normalizedPath);
        this.#assertRelocationDoesNotConflict(projectId, projectPathMeta);

        const updateProject = this.#connection.prepare<
            [string, string, string, string],
            void
        >(
            `
            UPDATE projects
            SET name = ?,
                canonical_root_path = ?,
                updated_at = ?,
                is_hidden = 0
            WHERE id = ?
            `,
        );
        const deleteRoots = this.#connection.prepare<[string], void>(
            "DELETE FROM project_roots WHERE project_id = ?",
        );
        const releaseHiddenProjectRoots = this.#connection.prepare<
            [string, string, string],
            void
        >(
            `
            DELETE FROM project_roots
            WHERE root_path IN (?, ?)
              AND project_id IN (
                  SELECT id
                  FROM projects
                  WHERE is_hidden = 1
                    AND id <> ?
              )
            `,
        );
        const releaseHiddenProjectWorktrees = this.#connection.prepare<
            [string, string, string],
            void
        >(
            `
            DELETE FROM project_worktrees
            WHERE root_path IN (?, ?)
              AND project_id IN (
                  SELECT id
                  FROM projects
                  WHERE is_hidden = 1
                    AND id <> ?
              )
            `,
        );
        const retireHiddenCanonicalProject = this.#connection.prepare<
            [string, string, string],
            void
        >(
            `
            UPDATE projects
            SET canonical_root_path = 'hidden:' || id || ':' || canonical_root_path,
                updated_at = ?
            WHERE canonical_root_path = ?
              AND id <> ?
              AND is_hidden = 1
            `,
        );
        const insertRoot = this.#connection.prepare<
            [string, string, number],
            void
        >(
            `
            INSERT INTO project_roots (project_id, root_path, is_primary)
            VALUES (?, ?, ?)
            `,
        );
        const deleteDuplicatePrimaryRootWorktree = this.#connection.prepare<
            [string, string, string],
            void
        >(
            `
            DELETE FROM project_worktrees
            WHERE project_id = ?
              AND root_path = ?
              AND id <> ?
            `,
        );
        const upsertPrimaryWorktree = this.#connection.prepare<
            [string, string, string, string, string],
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
            VALUES (?, ?, ?, NULL, NULL, 1, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                root_path = excluded.root_path,
                branch_name = excluded.branch_name,
                head_sha = excluded.head_sha,
                is_primary = 1,
                updated_at = excluded.updated_at
            `,
        );
        const findExistingWorktree = this.#connection.prepare<
            [string],
            { id: string } | undefined
        >(
            `
            SELECT id
            FROM project_worktrees
            WHERE root_path = ?
            `,
        );
        const insertWorktree = this.#connection.prepare<
            [
                string,
                string,
                string,
                string | null,
                string | null,
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
        );
        const touchRecent = this.#connection.prepare<[string, string], void>(
            `
            INSERT INTO recent_projects (project_id, last_opened_at)
            VALUES (?, ?)
            ON CONFLICT(project_id) DO UPDATE SET
                last_opened_at = excluded.last_opened_at
            `,
        );
        const now = new Date().toISOString();

        const transaction = this.#connection.transaction(() => {
            releaseHiddenProjectRoots.run(
                projectPathMeta.canonicalRootPath,
                projectPathMeta.worktreeRootPath,
                projectId,
            );
            releaseHiddenProjectWorktrees.run(
                projectPathMeta.canonicalRootPath,
                projectPathMeta.worktreeRootPath,
                projectId,
            );
            retireHiddenCanonicalProject.run(
                now,
                projectPathMeta.canonicalRootPath,
                projectId,
            );
            updateProject.run(
                path.basename(projectPathMeta.canonicalRootPath),
                projectPathMeta.canonicalRootPath,
                now,
                projectId,
            );
            deleteRoots.run(projectId);
            ensureProjectRoots({
                canonicalRootPath: projectPathMeta.canonicalRootPath,
                insertRoot,
                projectId,
                selectedRootPath: projectPathMeta.worktreeRootPath,
            });
            deleteDuplicatePrimaryRootWorktree.run(
                projectId,
                projectPathMeta.canonicalRootPath,
                `${projectId}:primary`,
            );
            upsertPrimaryWorktree.run(
                `${projectId}:primary`,
                projectId,
                projectPathMeta.canonicalRootPath,
                now,
                now,
            );

            if (
                projectPathMeta.worktreeRootPath !==
                projectPathMeta.canonicalRootPath
            ) {
                ensureProjectWorktree({
                    findExistingWorktree,
                    insertWorktree,
                    now,
                    projectId,
                    rootPath: projectPathMeta.worktreeRootPath,
                });
            }

            touchRecent.run(projectId, now);
        });

        transaction();

        const relocated = this.listProjects().find(
            (candidate) => candidate.id === projectId,
        );
        if (!relocated) {
            throw new Error("The relocated project could not be loaded.");
        }

        return relocated;
    }

    touchProject(projectId: string): void {
        const now = new Date().toISOString();

        this.#connection
            .prepare<[string, string], void>(
                `
                INSERT INTO recent_projects (project_id, last_opened_at)
                VALUES (?, ?)
                ON CONFLICT(project_id) DO UPDATE SET
                    last_opened_at = excluded.last_opened_at
                `,
            )
            .run(projectId, now);

        this.#connection
            .prepare<
                [string, string],
                void
            >("UPDATE projects SET updated_at = ? WHERE id = ?")
            .run(now, projectId);
    }

    getProject(projectId: string): ProjectRecord | null {
        const row = this.#connection
            .prepare<
                [string],
                | {
                      canonical_root_path: string;
                      id: string;
                      root_path: string | null;
                  }
                | undefined
            >(
                `
                SELECT
                    projects.id,
                    projects.canonical_root_path,
                    project_worktrees.root_path
                FROM projects
                LEFT JOIN project_worktrees
                    ON project_worktrees.project_id = projects.id
                    AND project_worktrees.is_primary = 1
                WHERE projects.id = ?
                  AND projects.is_hidden = 0
                `,
            )
            .get(projectId);

        if (!row) {
            return null;
        }

        return {
            canonicalRootPath: row.canonical_root_path,
            id: row.id,
            rootPath: row.root_path ?? row.canonical_root_path,
        };
    }

    getProjectWorktree(worktreeId: string): ProjectStoreWorktreeRecord | null {
        const row = this.#connection
            .prepare<[string], PersistedProjectWorktreeRow | undefined>(
                `
                SELECT
                    id,
                    project_id,
                    root_path,
                    branch_name,
                    head_sha,
                    is_primary,
                    updated_at
                FROM project_worktrees
                WHERE id = ?
                `,
            )
            .get(worktreeId);

        return row ? mapWorktreeRow(row) : null;
    }

    listProjectWorktrees(
        projectId: string,
    ): readonly ProjectStoreWorktreeRecord[] {
        return this.#connection
            .prepare<[string], PersistedProjectWorktreeRow>(
                `
                SELECT
                    id,
                    project_id,
                    root_path,
                    branch_name,
                    head_sha,
                    is_primary,
                    updated_at
                FROM project_worktrees
                WHERE project_id = ?
                ORDER BY is_primary DESC, root_path COLLATE NOCASE ASC
                `,
            )
            .all(projectId)
            .map(mapWorktreeRow);
    }

    syncProjectWorktrees(
        projectId: string,
        worktrees: readonly {
            readonly branchName: string | null;
            readonly headSha: string | null;
            readonly rootPath: string;
        }[],
    ): readonly ProjectStoreWorktreeRecord[] {
        const project = this.getProject(projectId);
        if (!project) {
            throw new Error("The requested project does not exist anymore.");
        }

        const projectRootPath = path.resolve(project.canonicalRootPath);
        const projectRootKey = normalizeWorktreePathKey(projectRootPath);
        const desiredWorktrees = new Map(
            worktrees.map((worktree) => {
                const rootPath = path.resolve(worktree.rootPath);
                return [
                    normalizeWorktreePathKey(rootPath),
                    {
                        branchName: worktree.branchName,
                        headSha: worktree.headSha,
                        rootPath,
                    },
                ];
            }),
        );

        if (!desiredWorktrees.has(projectRootKey)) {
            desiredWorktrees.set(projectRootKey, {
                branchName: null,
                headSha: null,
                rootPath: projectRootPath,
            });
        }

        const existingRows = this.#connection
            .prepare<[string], PersistedProjectWorktreeRow>(
                `
                SELECT
                    id,
                    project_id,
                    root_path,
                    branch_name,
                    head_sha,
                    is_primary,
                    updated_at
                FROM project_worktrees
                WHERE project_id = ?
                `,
            )
            .all(projectId);
        const existingByPath = createPreferredExistingWorktreeMap({
            desiredWorktrees,
            existingRows,
            primaryWorktreeId: `${projectId}:primary`,
            projectRootKey,
        });
        const retainedExistingIds = new Set(
            [...existingByPath]
                .filter(([rootKey]) => desiredWorktrees.has(rootKey))
                .map(([, row]) => row.id),
        );
        const upsertWorktree = this.#connection.prepare<
            [
                string,
                string,
                string,
                string | null,
                string | null,
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
            ON CONFLICT(id) DO UPDATE SET
                root_path = excluded.root_path,
                branch_name = excluded.branch_name,
                head_sha = excluded.head_sha,
                is_primary = excluded.is_primary,
                updated_at = excluded.updated_at
            `,
        );
        const deleteWorktree = this.#connection.prepare<[string], void>(
            "DELETE FROM project_worktrees WHERE id = ?",
        );
        const now = new Date().toISOString();

        const transaction = this.#connection.transaction(() => {
            for (const existingRow of existingRows) {
                const normalizedRootKey = normalizeWorktreePathKey(
                    existingRow.root_path,
                );
                if (retainedExistingIds.has(existingRow.id)) {
                    continue;
                }

                if (
                    existingRow.is_primary === 1 &&
                    !desiredWorktrees.has(normalizedRootKey)
                ) {
                    continue;
                }

                deleteWorktree.run(existingRow.id);
            }

            for (const desiredWorktree of desiredWorktrees.values()) {
                const existingRow = existingByPath.get(
                    normalizeWorktreePathKey(desiredWorktree.rootPath),
                );
                const isPrimary =
                    normalizeWorktreePathKey(desiredWorktree.rootPath) ===
                    projectRootKey;
                upsertWorktree.run(
                    existingRow?.id ??
                        (isPrimary ? `${projectId}:primary` : randomUUID()),
                    projectId,
                    desiredWorktree.rootPath,
                    desiredWorktree.branchName,
                    desiredWorktree.headSha,
                    isPrimary ? 1 : 0,
                    existingRow?.updated_at ?? now,
                    now,
                );
            }
        });

        transaction();
        return this.listProjectWorktrees(projectId);
    }

    getWorktreeRootPath(worktreeId: string): string {
        const row = this.#connection
            .prepare<[string], { root_path: string } | undefined>(
                `
                SELECT root_path
                FROM project_worktrees
                WHERE id = ?
                `,
            )
            .get(worktreeId);

        if (!row) {
            throw new Error("The requested worktree does not exist anymore.");
        }

        return row.root_path;
    }

    #listAllVisibleWorktrees(): readonly ProjectStoreWorktreeRecord[] {
        return this.#connection
            .prepare<[], PersistedProjectWorktreeRow>(
                `
                SELECT
                    project_worktrees.id,
                    project_worktrees.project_id,
                    project_worktrees.root_path,
                    project_worktrees.branch_name,
                    project_worktrees.head_sha,
                    project_worktrees.is_primary,
                    project_worktrees.updated_at
                FROM project_worktrees
                INNER JOIN projects
                    ON projects.id = project_worktrees.project_id
                WHERE projects.is_hidden = 0
                ORDER BY
                    project_worktrees.project_id,
                    project_worktrees.is_primary DESC,
                    project_worktrees.root_path COLLATE NOCASE ASC
                `,
            )
            .all()
            .map(mapWorktreeRow);
    }

    #listProjectRecords(): readonly ProjectStoreProjectRecord[] {
        return this.#connection
            .prepare<[], PersistedProjectRow>(
                `
                SELECT
                    projects.id,
                    projects.name,
                    projects.canonical_root_path,
                    projects.created_at,
                    projects.updated_at,
                    recent_projects.last_opened_at
                FROM projects
                LEFT JOIN recent_projects
                    ON recent_projects.project_id = projects.id
                WHERE projects.is_hidden = 0
                ORDER BY
                    recent_projects.last_opened_at IS NULL,
                    recent_projects.last_opened_at DESC,
                    projects.name COLLATE NOCASE ASC
                `,
            )
            .all()
            .map((row) => ({
                canonicalRootPath: row.canonical_root_path,
                createdAt: row.created_at,
                id: row.id,
                lastOpenedAt: row.last_opened_at,
                name: row.name,
                rootPath: row.canonical_root_path,
                updatedAt: row.updated_at,
            }));
    }

    #assertRelocationDoesNotConflict(
        projectId: string,
        projectPathMeta: {
            readonly canonicalRootPath: string;
            readonly worktreeRootPath: string;
        },
    ): void {
        const conflictingProject = this.#connection
            .prepare<
                [string, string],
                { id: string; name: string } | undefined
            >(
                `
                SELECT id, name
                FROM projects
                WHERE canonical_root_path = ?
                  AND id <> ?
                  AND is_hidden = 0
                LIMIT 1
                `,
            )
            .get(projectPathMeta.canonicalRootPath, projectId);

        if (conflictingProject) {
            throw new Error(
                `This folder is already registered as "${conflictingProject.name}".`,
            );
        }

        const pathsToCheck = [
            projectPathMeta.canonicalRootPath,
            projectPathMeta.worktreeRootPath,
        ];
        const conflictingWorktree = this.#connection.prepare<
            [string, string],
            { project_id: string } | undefined
        >(
            `
            SELECT project_worktrees.project_id
            FROM project_worktrees
            INNER JOIN projects
                ON projects.id = project_worktrees.project_id
            WHERE root_path = ?
              AND project_worktrees.project_id <> ?
              AND projects.is_hidden = 0
            LIMIT 1
            `,
        );

        for (const rootPath of pathsToCheck) {
            if (conflictingWorktree.get(rootPath, projectId)) {
                throw new Error(
                    "This folder is already used by another project.",
                );
            }
        }
    }

    #countWorkspaceSessions(
        projectId: string,
        worktreeIds: readonly string[],
    ): number {
        const worktreeFilter =
            worktreeIds.length > 0
                ? `OR active_worktree_id IN (${createPlaceholders(worktreeIds.length)})`
                : "";
        const row = this.#connection
            .prepare(
                `
                SELECT COUNT(*) AS count
                FROM workspace_sessions
                WHERE active_project_id = ?
                   ${worktreeFilter}
                `,
            )
            .get(projectId, ...worktreeIds) as { count: number } | undefined;

        return getCount(row);
    }

    #countWorkspaceTabs(
        projectId: string,
        worktreeIds: readonly string[],
    ): number {
        const worktreeFilter =
            worktreeIds.length > 0
                ? `OR worktree_id IN (${createPlaceholders(worktreeIds.length)})`
                : "";
        const row = this.#connection
            .prepare(
                `
                SELECT COUNT(*) AS count
                FROM workspace_tabs
                WHERE (
                    json_valid(payload_json)
                    AND json_extract(payload_json, '$.projectId') = ?
                )
                ${worktreeFilter}
                `,
            )
            .get(projectId, ...worktreeIds) as { count: number } | undefined;

        return getCount(row);
    }

    #listProjectWorkspaceLayoutIds(
        projectId: string,
        worktreeIds: readonly string[],
    ): readonly string[] {
        const worktreeFilter =
            worktreeIds.length > 0
                ? `OR workspace_sessions.active_worktree_id IN (${createPlaceholders(worktreeIds.length)})`
                : "";
        return this.#connection
            .prepare(
                `
                SELECT DISTINCT workspace_sessions.workspace_id AS id
                FROM workspace_sessions
                INNER JOIN workspace_layouts
                    ON workspace_layouts.id = workspace_sessions.workspace_id
                WHERE workspace_sessions.active_project_id = ?
                   ${worktreeFilter}
                `,
            )
            .all(projectId, ...worktreeIds)
            .map((row) => (row as { id: string }).id);
    }

    #listProjectWorktreeIds(projectId: string): readonly string[] {
        return this.#connection
            .prepare<[string], { id: string }>(
                `
                SELECT id
                FROM project_worktrees
                WHERE project_id = ?
                `,
            )
            .all(projectId)
            .map((row) => row.id);
    }
}

function mapWorktreeRow(
    row: PersistedProjectWorktreeRow,
): ProjectStoreWorktreeRecord {
    return {
        branchName: row.branch_name,
        headSha: row.head_sha,
        id: row.id,
        isPrimary: row.is_primary === 1,
        projectId: row.project_id,
        rootPath: row.root_path,
        updatedAt: row.updated_at,
    };
}

function ensureProjectRoots(options: {
    readonly canonicalRootPath: string;
    readonly insertRoot: Database.Statement<[string, string, number]>;
    readonly projectId: string;
    readonly selectedRootPath: string;
}): void {
    options.insertRoot.run(options.projectId, options.canonicalRootPath, 1);

    if (options.selectedRootPath !== options.canonicalRootPath) {
        options.insertRoot.run(options.projectId, options.selectedRootPath, 0);
    }
}

function ensureProjectWorktree(options: {
    readonly findExistingWorktree: Database.Statement<
        [string],
        { id: string } | undefined
    >;
    readonly insertWorktree: Database.Statement<
        [
            string,
            string,
            string,
            string | null,
            string | null,
            number,
            string,
            string,
        ]
    >;
    readonly now: string;
    readonly projectId: string;
    readonly rootPath: string;
}): string {
    const existing = options.findExistingWorktree.get(options.rootPath);
    if (existing) {
        return existing.id;
    }

    const worktreeId = randomUUID();
    options.insertWorktree.run(
        worktreeId,
        options.projectId,
        options.rootPath,
        null,
        null,
        0,
        options.now,
        options.now,
    );
    return worktreeId;
}

function resolveProjectPathMetadata(projectPath: string): {
    readonly canonicalRootPath: string;
    readonly worktreeRootPath: string;
} {
    const resolvedPath = path.resolve(projectPath);
    const worktreeRootPath =
        runGitPathCommand(resolvedPath, ["rev-parse", "--show-toplevel"]) ??
        resolvedPath;
    const commonDir = runGitPathCommand(resolvedPath, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
    ]);
    const canonicalRootPath =
        commonDir && path.basename(commonDir) === ".git"
            ? path.dirname(commonDir)
            : worktreeRootPath;

    return {
        canonicalRootPath: path.resolve(canonicalRootPath),
        worktreeRootPath: path.resolve(worktreeRootPath),
    };
}

function runGitPathCommand(
    cwd: string,
    args: readonly string[],
): string | null {
    try {
        const output = execFileSync("git", args, {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();

        return output.length > 0 ? output : null;
    } catch (error) {
        debugBenignError("projects.store.runGit", error);
        return null;
    }
}

function isDirectoryPath(projectPath: string): boolean {
    try {
        return fs.statSync(projectPath).isDirectory();
    } catch (error) {
        debugBenignError("projects.store.isDirectoryPath", error);
        return false;
    }
}

function normalizeWorktreePathKey(rootPath: string): string {
    const resolvedPath = path.resolve(rootPath);
    return process.platform === "win32"
        ? resolvedPath.toLowerCase()
        : resolvedPath;
}

function createPreferredExistingWorktreeMap({
    desiredWorktrees,
    existingRows,
    primaryWorktreeId,
    projectRootKey,
}: {
    readonly desiredWorktrees: ReadonlyMap<
        string,
        {
            readonly rootPath: string;
        }
    >;
    readonly existingRows: readonly PersistedProjectWorktreeRow[];
    readonly primaryWorktreeId: string;
    readonly projectRootKey: string;
}): Map<string, PersistedProjectWorktreeRow> {
    const existingByPath = new Map<string, PersistedProjectWorktreeRow>();

    for (const row of existingRows) {
        const rootKey = normalizeWorktreePathKey(row.root_path);
        const current = existingByPath.get(rootKey);
        if (
            !current ||
            getExistingWorktreePreferenceScore({
                desiredRootPath: desiredWorktrees.get(rootKey)?.rootPath ?? null,
                primaryWorktreeId,
                projectRootKey,
                rootKey,
                row,
            }) >
                getExistingWorktreePreferenceScore({
                    desiredRootPath:
                        desiredWorktrees.get(rootKey)?.rootPath ?? null,
                    primaryWorktreeId,
                    projectRootKey,
                    rootKey,
                    row: current,
                })
        ) {
            existingByPath.set(rootKey, row);
        }
    }

    return existingByPath;
}

function getExistingWorktreePreferenceScore({
    desiredRootPath,
    primaryWorktreeId,
    projectRootKey,
    rootKey,
    row,
}: {
    readonly desiredRootPath: string | null;
    readonly primaryWorktreeId: string;
    readonly projectRootKey: string;
    readonly rootKey: string;
    readonly row: PersistedProjectWorktreeRow;
}): number {
    let score = 0;

    if (rootKey === projectRootKey && row.id === primaryWorktreeId) {
        score += 100;
    }
    if (rootKey === projectRootKey && row.is_primary === 1) {
        score += 50;
    }
    if (desiredRootPath && path.resolve(row.root_path) === desiredRootPath) {
        score += 10;
    }

    return score;
}

function createPlaceholders(count: number): string {
    return Array.from({ length: count }, () => "?").join(", ");
}

function getCount(row: { readonly count: number } | undefined): number {
    return Math.max(0, row?.count ?? 0);
}
