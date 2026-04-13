import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import { simpleGit } from "simple-git";

import type {
    GitStatusBadge,
    ProjectFileDocument,
    ProjectSummary,
    ProjectTreeNode,
    ProjectTreeInvalidation,
} from "@shared/ipc";

import {
    listProjectTreeChildren,
    readProjectFile,
    writeProjectFile,
} from "./tree";

interface PersistedProjectRow {
    readonly id: string;
    readonly name: string;
    readonly root_path: string;
    readonly created_at: string;
    readonly updated_at: string;
    readonly last_opened_at: string | null;
}

interface GitSnapshot {
    readonly changedPaths: readonly string[];
    readonly exactBadges: ReadonlyMap<string, GitStatusBadge>;
}

interface ProjectServiceOptions {
    readonly connection: Database.Database;
    readonly onProjectTreeInvalidated: (
        payload: ProjectTreeInvalidation,
    ) => void;
}

export class ProjectService {
    readonly #connection: Database.Database;
    readonly #onProjectTreeInvalidated: (
        payload: ProjectTreeInvalidation,
    ) => void;
    readonly #watchers = new Map<string, fs.FSWatcher>();
    readonly #gitSnapshots = new Map<string, GitSnapshot>();
    readonly #pendingInvalidations = new Map<string, NodeJS.Timeout>();

    constructor(options: ProjectServiceOptions) {
        this.#connection = options.connection;
        this.#onProjectTreeInvalidated = options.onProjectTreeInvalidated;
    }

    listProjects(): ProjectSummary[] {
        const rows = this.#connection
            .prepare<[], PersistedProjectRow>(
                `
                SELECT
                    projects.id,
                    projects.name,
                    project_roots.root_path,
                    projects.created_at,
                    projects.updated_at,
                    recent_projects.last_opened_at
                FROM projects
                INNER JOIN project_roots
                    ON project_roots.project_id = projects.id
                    AND project_roots.is_primary = 1
                LEFT JOIN recent_projects
                    ON recent_projects.project_id = projects.id
                ORDER BY
                    recent_projects.last_opened_at IS NULL,
                    recent_projects.last_opened_at DESC,
                    projects.name COLLATE NOCASE ASC
                `,
            )
            .all();

        for (const row of rows) {
            this.#ensureWatcher(row.id, row.root_path);
        }

        return rows.map((row) => ({
            createdAt: row.created_at,
            id: row.id,
            lastOpenedAt: row.last_opened_at,
            name: row.name,
            rootPath: row.root_path,
            updatedAt: row.updated_at,
        }));
    }

    addProjectPaths(projectPaths: readonly string[]): ProjectSummary[] {
        const insertProject = this.#connection.prepare<
            [string, string, string, string],
            void
        >(
            `
            INSERT INTO projects (id, name, created_at, updated_at)
            VALUES (?, ?, ?, ?)
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
            { project_id: string } | undefined
        >(
            `
            SELECT project_id
            FROM project_roots
            WHERE root_path = ?
            `,
        );

        const transaction = this.#connection.transaction(
            (normalizedPaths: readonly string[]) => {
                for (const normalizedPath of normalizedPaths) {
                    const now = new Date().toISOString();
                    const existing = findExisting.get(normalizedPath);

                    if (existing) {
                        touchRecent.run(existing.project_id, now);
                        continue;
                    }

                    const projectId = randomUUID();
                    insertProject.run(
                        projectId,
                        path.basename(normalizedPath),
                        now,
                        now,
                    );
                    insertRoot.run(projectId, normalizedPath, 1);
                    touchRecent.run(projectId, now);
                }
            },
        );

        const normalizedPaths = projectPaths
            .map((projectPath) => path.resolve(projectPath))
            .filter((projectPath) => {
                try {
                    return fs.statSync(projectPath).isDirectory();
                } catch {
                    return false;
                }
            });

        transaction(normalizedPaths);
        return this.listProjects();
    }

    removeProject(projectId: string): void {
        this.#closeWatcher(projectId);
        this.#gitSnapshots.delete(projectId);

        this.#connection
            .prepare<[string], void>("DELETE FROM projects WHERE id = ?")
            .run(projectId);
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

    async listProjectTreeChildren(input: {
        readonly projectId: string;
        readonly parentRelativePath: string | null;
    }): Promise<ProjectTreeNode[]> {
        const project = this.#getProjectById(input.projectId);
        const gitSnapshot = await this.#getGitSnapshot(
            project.id,
            project.rootPath,
        );

        return listProjectTreeChildren({
            gitSnapshot,
            parentRelativePath: input.parentRelativePath,
            projectId: input.projectId,
            rootPath: project.rootPath,
        });
    }

    async openProjectFile(input: {
        readonly projectId: string;
        readonly relativePath: string;
    }): Promise<ProjectFileDocument> {
        const project = this.#getProjectById(input.projectId);
        this.touchProject(input.projectId);

        return readProjectFile({
            projectId: input.projectId,
            relativePath: input.relativePath,
            rootPath: project.rootPath,
        });
    }

    async saveProjectFile(input: {
        readonly projectId: string;
        readonly relativePath: string;
        readonly content: string;
    }): Promise<ProjectFileDocument> {
        const project = this.#getProjectById(input.projectId);
        this.touchProject(input.projectId);
        this.#gitSnapshots.delete(input.projectId);

        return writeProjectFile({
            content: input.content,
            projectId: input.projectId,
            relativePath: input.relativePath,
            rootPath: project.rootPath,
        });
    }

    getProjectRootPath(projectId: string): string {
        return this.#getProjectById(projectId).rootPath;
    }

    close(): void {
        for (const watcher of this.#watchers.values()) {
            watcher.close();
        }

        for (const timeout of this.#pendingInvalidations.values()) {
            clearTimeout(timeout);
        }

        this.#watchers.clear();
        this.#gitSnapshots.clear();
        this.#pendingInvalidations.clear();
    }

    #getProjectById(projectId: string): { id: string; rootPath: string } {
        const row = this.#connection
            .prepare<[string], { id: string; root_path: string } | undefined>(
                `
                SELECT projects.id, project_roots.root_path
                FROM projects
                INNER JOIN project_roots
                    ON project_roots.project_id = projects.id
                    AND project_roots.is_primary = 1
                WHERE projects.id = ?
                `,
            )
            .get(projectId);

        if (!row) {
            throw new Error("The requested project does not exist anymore.");
        }

        return {
            id: row.id,
            rootPath: row.root_path,
        };
    }

    async #getGitSnapshot(
        projectId: string,
        rootPath: string,
    ): Promise<GitSnapshot> {
        const cachedSnapshot = this.#gitSnapshots.get(projectId);
        if (cachedSnapshot) {
            return cachedSnapshot;
        }

        try {
            const status = await simpleGit(rootPath).status();
            const exactBadges = new Map<string, GitStatusBadge>();

            for (const filePath of status.modified) {
                exactBadges.set(normalizeGitPath(filePath), "modified");
            }

            for (const filePath of status.created) {
                exactBadges.set(normalizeGitPath(filePath), "added");
            }

            for (const filePath of status.deleted) {
                exactBadges.set(normalizeGitPath(filePath), "deleted");
            }

            for (const filePath of status.not_added) {
                exactBadges.set(normalizeGitPath(filePath), "untracked");
            }

            for (const rename of status.renamed) {
                exactBadges.set(normalizeGitPath(rename.to), "modified");
            }

            const snapshot = {
                changedPaths: [...exactBadges.keys()],
                exactBadges,
            } satisfies GitSnapshot;

            this.#gitSnapshots.set(projectId, snapshot);
            return snapshot;
        } catch {
            const emptySnapshot = {
                changedPaths: [],
                exactBadges: new Map<string, GitStatusBadge>(),
            } satisfies GitSnapshot;

            this.#gitSnapshots.set(projectId, emptySnapshot);
            return emptySnapshot;
        }
    }

    #ensureWatcher(projectId: string, rootPath: string): void {
        if (this.#watchers.has(projectId)) {
            return;
        }

        try {
            const watcher = fs.watch(
                rootPath,
                { recursive: process.platform !== "linux" },
                () => {
                    this.#gitSnapshots.delete(projectId);
                    this.#scheduleInvalidation(projectId);
                },
            );

            this.#watchers.set(projectId, watcher);
        } catch {
            // Some file systems do not support recursive watching. The tree still
            // works, only live refresh is reduced until a stronger watcher lands.
        }
    }

    #scheduleInvalidation(projectId: string): void {
        const existingTimeout = this.#pendingInvalidations.get(projectId);
        if (existingTimeout) {
            clearTimeout(existingTimeout);
        }

        const timeout = setTimeout(() => {
            this.#pendingInvalidations.delete(projectId);
            this.#onProjectTreeInvalidated({
                occurredAt: new Date().toISOString(),
                projectId,
            });
        }, 140);

        this.#pendingInvalidations.set(projectId, timeout);
    }

    #closeWatcher(projectId: string): void {
        const watcher = this.#watchers.get(projectId);
        watcher?.close();
        this.#watchers.delete(projectId);

        const timeout = this.#pendingInvalidations.get(projectId);
        if (timeout) {
            clearTimeout(timeout);
            this.#pendingInvalidations.delete(projectId);
        }
    }
}

function normalizeGitPath(filePath: string): string {
    return filePath.split(path.sep).join("/");
}
