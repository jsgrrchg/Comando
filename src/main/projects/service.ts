import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

import type Database from "better-sqlite3";
import { simpleGit } from "simple-git";

import type {
    CreateProjectEntryInput,
    DeleteProjectEntryInput,
    GitStatusBadge,
    ListProjectTreeInput,
    OpenProjectFileInput,
    ProjectEntryMutationResult,
    ProjectFileDocument,
    ProjectSummary,
    ProjectTreeNode,
    ProjectTreeInvalidation,
    RenameProjectEntryInput,
    SaveProjectFileInput,
    SearchProjectEntriesInput,
} from "@shared/ipc";

import {
    createProjectEntry,
    deleteProjectEntry,
    listProjectTreeChildren,
    normalizeRelativePath,
    readProjectFile,
    renameProjectEntry,
    resolveProjectPath,
    writeProjectFile,
} from "./tree";
import { shouldIgnoreEntry } from "./ignore";

interface PersistedProjectRow {
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

interface ResolvedProjectScope {
    readonly canonicalRootPath: string;
    readonly id: string;
    readonly rootPath: string;
    readonly worktreeId: string | null;
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
    readonly onProjectTouched?: (projectPath: string) => void;
}

export class ProjectService {
    readonly #connection: Database.Database;
    readonly #onProjectTreeInvalidated: (
        payload: ProjectTreeInvalidation,
    ) => void;
    readonly #onProjectTouched?: (projectPath: string) => void;
    readonly #watchers = new Map<string, fs.FSWatcher>();
    readonly #gitSnapshots = new Map<string, GitSnapshot>();
    readonly #pendingInvalidations = new Map<string, NodeJS.Timeout>();

    constructor(options: ProjectServiceOptions) {
        this.#connection = options.connection;
        this.#onProjectTreeInvalidated = options.onProjectTreeInvalidated;
        this.#onProjectTouched = options.onProjectTouched;
    }

    listProjects(): ProjectSummary[] {
        const rows = this.#connection
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
                ORDER BY
                    recent_projects.last_opened_at IS NULL,
                    recent_projects.last_opened_at DESC,
                    projects.name COLLATE NOCASE ASC
                `,
            )
            .all();

        for (const row of rows) {
            this.#ensureWatcher(row.id, row.canonical_root_path);
        }

        return rows.map((row) => ({
            createdAt: row.created_at,
            id: row.id,
            lastOpenedAt: row.last_opened_at,
            name: row.name,
            rootPath: row.canonical_root_path,
            updatedAt: row.updated_at,
        }));
    }

    addProjectPaths(projectPaths: readonly string[]): ProjectSummary[] {
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
                        ensureProjectRoots({
                            canonicalRootPath:
                                projectPathMeta.canonicalRootPath,
                            connection: this.#connection,
                            insertRoot,
                            projectId: existing.id,
                            selectedRootPath: projectPathMeta.worktreeRootPath,
                        });
                        ensureProjectWorktree({
                            connection: this.#connection,
                            findExistingWorktree,
                            insertWorktree,
                            now,
                            projectId: existing.id,
                            rootPath: projectPathMeta.worktreeRootPath,
                        });
                        touchRecent.run(existing.id, now);
                        this.#onProjectTouched?.(
                            projectPathMeta.worktreeRootPath,
                        );
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
                        connection: this.#connection,
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
                            connection: this.#connection,
                            findExistingWorktree,
                            insertWorktree,
                            now,
                            projectId,
                            rootPath: projectPathMeta.worktreeRootPath,
                        });
                    }
                    touchRecent.run(projectId, now);
                    this.#onProjectTouched?.(projectPathMeta.worktreeRootPath);
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
        for (const worktree of this.listProjectWorktrees(projectId)) {
            this.#gitSnapshots.delete(worktree.rootPath);
        }

        this.#connection
            .prepare<[string], void>("DELETE FROM projects WHERE id = ?")
            .run(projectId);
    }

    touchProject(projectId: string): void {
        const now = new Date().toISOString();
        const project = this.#getProjectById(projectId);

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
        this.#onProjectTouched?.(project.rootPath);
    }

    async listProjectTreeChildren(
        input: ListProjectTreeInput,
    ): Promise<ProjectTreeNode[]> {
        const project = this.#resolveProjectScope(
            input.projectId,
            input.worktreeId ?? null,
        );
        this.#ensureWatcher(project.id, project.rootPath);
        const gitSnapshot = await this.#getGitSnapshot(project.rootPath);

        return listProjectTreeChildren({
            gitSnapshot,
            parentRelativePath: input.parentRelativePath,
            projectId: input.projectId,
            rootPath: project.rootPath,
        });
    }

    async openProjectFile(
        input: OpenProjectFileInput,
    ): Promise<ProjectFileDocument> {
        const project = this.#resolveProjectScope(
            input.projectId,
            input.worktreeId ?? null,
        );
        this.touchProject(input.projectId);

        return readProjectFile({
            projectId: input.projectId,
            relativePath: input.relativePath,
            rootPath: project.rootPath,
        });
    }

    async searchProjectEntries(
        input: SearchProjectEntriesInput,
    ): Promise<ProjectTreeNode[]> {
        const normalizedQuery = input.query.trim().toLowerCase();
        if (!normalizedQuery) {
            return [];
        }

        const project = this.#resolveProjectScope(
            input.projectId,
            input.worktreeId ?? null,
        );
        this.#ensureWatcher(project.id, project.rootPath);
        const gitSnapshot = await this.#getGitSnapshot(project.rootPath);
        const limit = Math.max(1, input.limit ?? 20);
        const scoredEntries: {
            readonly node: ProjectTreeNode;
            readonly score: number;
        }[] = [];
        const queue = [project.rootPath];

        while (queue.length > 0) {
            const currentDirectory = queue.shift();
            if (!currentDirectory) {
                break;
            }

            let entries: fs.Dirent[] = [];
            try {
                entries = fs.readdirSync(currentDirectory, {
                    withFileTypes: true,
                });
            } catch {
                continue;
            }

            for (const entry of entries) {
                if (shouldIgnoreEntry(entry.name, entry.isDirectory())) {
                    continue;
                }

                const absolutePath = path.join(currentDirectory, entry.name);
                const relativePath = normalizeRelativePath(
                    path.relative(project.rootPath, absolutePath),
                );
                const score = scoreProjectEntry(
                    entry.name,
                    relativePath,
                    normalizedQuery,
                );

                if (entry.isDirectory()) {
                    queue.push(absolutePath);
                }

                if (score <= 0) {
                    continue;
                }

                const kind = entry.isDirectory() ? "directory" : "file";
                scoredEntries.push({
                    node: {
                        id: `${input.projectId}:${relativePath}`,
                        extension:
                            kind === "file"
                                ? path.extname(entry.name).slice(1) || null
                                : null,
                        gitStatus:
                            kind === "directory"
                                ? getDirectoryBadge(relativePath, gitSnapshot)
                                : (gitSnapshot.exactBadges.get(relativePath) ??
                                  null),
                        hasChildren:
                            kind === "directory"
                                ? directoryHasVisibleChildren(absolutePath)
                                : false,
                        kind,
                        name: entry.name,
                        parentRelativePath:
                            path.posix.dirname(relativePath) === "."
                                ? null
                                : path.posix.dirname(relativePath),
                        relativePath,
                    },
                    score,
                });
            }
        }

        return scoredEntries
            .sort(
                (left, right) =>
                    right.score - left.score ||
                    left.node.relativePath.length -
                        right.node.relativePath.length ||
                    left.node.relativePath.localeCompare(
                        right.node.relativePath,
                    ),
            )
            .slice(0, limit)
            .map((entry) => entry.node);
    }

    async saveProjectFile(
        input: SaveProjectFileInput,
    ): Promise<ProjectFileDocument> {
        const project = this.#resolveProjectScope(
            input.projectId,
            input.worktreeId ?? null,
        );
        this.touchProject(input.projectId);
        this.#gitSnapshots.delete(project.rootPath);

        return writeProjectFile({
            content: input.content,
            expectedModifiedAtMs: input.expectedModifiedAtMs ?? null,
            projectId: input.projectId,
            relativePath: input.relativePath,
            rootPath: project.rootPath,
        }).then((document) => {
            this.#scheduleInvalidation(
                input.projectId,
                this.#normalizeWorktreeIdForInvalidation(
                    input.projectId,
                    project.worktreeId,
                ),
            );
            return document;
        });
    }

    async createProjectEntry(
        input: CreateProjectEntryInput,
    ): Promise<ProjectEntryMutationResult> {
        const project = this.#resolveProjectScope(
            input.projectId,
            input.worktreeId ?? null,
        );
        this.touchProject(input.projectId);
        this.#gitSnapshots.delete(project.rootPath);

        const entry = await createProjectEntry({
            kind: input.kind,
            name: input.name,
            parentRelativePath: input.parentRelativePath,
            rootPath: project.rootPath,
        });

        this.#scheduleInvalidation(
            input.projectId,
            this.#normalizeWorktreeIdForInvalidation(
                input.projectId,
                project.worktreeId,
            ),
        );
        return entry;
    }

    async renameProjectEntry(
        input: RenameProjectEntryInput,
    ): Promise<ProjectEntryMutationResult> {
        const project = this.#resolveProjectScope(
            input.projectId,
            input.worktreeId ?? null,
        );
        this.touchProject(input.projectId);
        this.#gitSnapshots.delete(project.rootPath);

        const entry = await renameProjectEntry({
            nextName: input.nextName,
            nextParentRelativePath: input.nextParentRelativePath,
            relativePath: input.relativePath,
            rootPath: project.rootPath,
        });

        this.#scheduleInvalidation(
            input.projectId,
            this.#normalizeWorktreeIdForInvalidation(
                input.projectId,
                project.worktreeId,
            ),
        );
        return entry;
    }

    async deleteProjectEntry(input: DeleteProjectEntryInput): Promise<void> {
        const project = this.#resolveProjectScope(
            input.projectId,
            input.worktreeId ?? null,
        );
        this.touchProject(input.projectId);
        this.#gitSnapshots.delete(project.rootPath);

        await deleteProjectEntry({
            relativePath: input.relativePath,
            rootPath: project.rootPath,
        });

        this.#scheduleInvalidation(
            input.projectId,
            this.#normalizeWorktreeIdForInvalidation(
                input.projectId,
                project.worktreeId,
            ),
        );
    }

    getProjectRootPath(
        projectId: string,
        worktreeId: string | null = null,
    ): string {
        return this.#resolveProjectScope(projectId, worktreeId).rootPath;
    }

    getProjectCanonicalRootPath(projectId: string): string {
        return this.#getProjectById(projectId).canonicalRootPath;
    }

    getPrimaryWorktreeId(projectId: string): string | null {
        return (
            this.listProjectWorktrees(projectId).find(
                (worktree) => worktree.isPrimary,
            )?.id ?? null
        );
    }

    listProjectWorktrees(projectId: string): readonly {
        readonly branchName: string | null;
        readonly headSha: string | null;
        readonly id: string;
        readonly isPrimary: boolean;
        readonly projectId: string;
        readonly rootPath: string;
        readonly updatedAt: string;
    }[] {
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
            .map((row) => ({
                branchName: row.branch_name,
                headSha: row.head_sha,
                id: row.id,
                isPrimary: row.is_primary === 1,
                projectId: row.project_id,
                rootPath: row.root_path,
                updatedAt: row.updated_at,
            }));
    }

    syncProjectWorktrees(
        projectId: string,
        worktrees: readonly {
            readonly branchName: string | null;
            readonly headSha: string | null;
            readonly rootPath: string;
        }[],
    ): readonly {
        readonly branchName: string | null;
        readonly headSha: string | null;
        readonly id: string;
        readonly isPrimary: boolean;
        readonly projectId: string;
        readonly rootPath: string;
        readonly updatedAt: string;
    }[] {
        const canonicalRootPath = this.getProjectCanonicalRootPath(projectId);
        const desiredWorktrees = new Map(
            worktrees.map((worktree) => [
                path.resolve(worktree.rootPath),
                {
                    branchName: worktree.branchName,
                    headSha: worktree.headSha,
                    rootPath: path.resolve(worktree.rootPath),
                },
            ]),
        );

        if (!desiredWorktrees.has(canonicalRootPath)) {
            desiredWorktrees.set(canonicalRootPath, {
                branchName: null,
                headSha: null,
                rootPath: canonicalRootPath,
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
        const existingByPath = new Map(
            existingRows.map((row) => [path.resolve(row.root_path), row]),
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
                const normalizedRootPath = path.resolve(existingRow.root_path);
                if (desiredWorktrees.has(normalizedRootPath)) {
                    continue;
                }

                if (existingRow.is_primary === 1) {
                    continue;
                }

                deleteWorktree.run(existingRow.id);
            }

            for (const desiredWorktree of desiredWorktrees.values()) {
                const existingRow = existingByPath.get(
                    desiredWorktree.rootPath,
                );
                const isPrimary =
                    desiredWorktree.rootPath === canonicalRootPath;
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

    resolveProjectEntryPath(
        projectId: string,
        relativePath: string | null,
        worktreeId: string | null = null,
    ): string {
        const project = this.#resolveProjectScope(projectId, worktreeId);
        return resolveProjectPath(project.rootPath, relativePath);
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

    #getProjectById(projectId: string): {
        readonly canonicalRootPath: string;
        readonly id: string;
        readonly rootPath: string;
    } {
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
                `,
            )
            .get(projectId);

        if (!row) {
            throw new Error("The requested project does not exist anymore.");
        }

        return {
            canonicalRootPath: row.canonical_root_path,
            id: row.id,
            rootPath: row.root_path ?? row.canonical_root_path,
        };
    }

    #resolveProjectScope(
        projectId: string,
        worktreeId: string | null,
    ): ResolvedProjectScope {
        const project = this.#getProjectById(projectId);

        if (!worktreeId) {
            return {
                ...project,
                worktreeId: this.getPrimaryWorktreeId(projectId),
            };
        }

        const worktree = this.#getProjectWorktreeById(worktreeId);
        if (worktree.project_id !== projectId) {
            throw new Error(
                "The requested worktree does not belong to this project.",
            );
        }

        return {
            canonicalRootPath: project.canonicalRootPath,
            id: project.id,
            rootPath: worktree.root_path,
            worktreeId: worktree.id,
        };
    }

    #getProjectWorktreeById(worktreeId: string): PersistedProjectWorktreeRow {
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

        if (!row) {
            throw new Error("The requested worktree does not exist anymore.");
        }

        return row;
    }

    async #getGitSnapshot(rootPath: string): Promise<GitSnapshot> {
        const cachedSnapshot = this.#gitSnapshots.get(rootPath);
        if (cachedSnapshot) {
            return cachedSnapshot;
        }

        try {
            const status = await createBackgroundSafeGit(rootPath).status();
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

            this.#gitSnapshots.set(rootPath, snapshot);
            return snapshot;
        } catch {
            const emptySnapshot = {
                changedPaths: [],
                exactBadges: new Map<string, GitStatusBadge>(),
            } satisfies GitSnapshot;

            this.#gitSnapshots.set(rootPath, emptySnapshot);
            return emptySnapshot;
        }
    }

    #ensureWatcher(projectId: string, rootPath: string): void {
        const watcherKey = `${projectId}:${rootPath}`;
        if (this.#watchers.has(watcherKey)) {
            return;
        }

        try {
            const watcher = fs.watch(
                rootPath,
                { recursive: process.platform !== "linux" },
                (_eventType, relativePath) => {
                    if (shouldIgnoreProjectWatchPath(relativePath)) {
                        return;
                    }

                    this.#gitSnapshots.delete(rootPath);
                    this.#scheduleInvalidation(
                        projectId,
                        this.#findWorktreeIdByRootPath(projectId, rootPath),
                    );
                },
            );

            this.#watchers.set(watcherKey, watcher);
        } catch {
            // Some file systems do not support recursive watching. The tree still
            // works, only live refresh is reduced until a stronger watcher lands.
        }
    }

    #scheduleInvalidation(
        projectId: string,
        worktreeId: string | null = null,
    ): void {
        const invalidationKey = `${projectId}:${worktreeId ?? "primary"}`;
        const existingTimeout = this.#pendingInvalidations.get(invalidationKey);
        if (existingTimeout) {
            clearTimeout(existingTimeout);
        }

        const timeout = setTimeout(() => {
            this.#pendingInvalidations.delete(invalidationKey);
            this.#onProjectTreeInvalidated({
                occurredAt: new Date().toISOString(),
                projectId,
                worktreeId,
            });
        }, 140);

        this.#pendingInvalidations.set(invalidationKey, timeout);
    }

    #closeWatcher(projectId: string): void {
        for (const [watcherKey, watcher] of this.#watchers.entries()) {
            if (!watcherKey.startsWith(`${projectId}:`)) {
                continue;
            }

            watcher.close();
            this.#watchers.delete(watcherKey);
        }

        for (const [invalidationKey, timeout] of this.#pendingInvalidations) {
            if (!invalidationKey.startsWith(`${projectId}:`)) {
                continue;
            }

            clearTimeout(timeout);
            this.#pendingInvalidations.delete(invalidationKey);
        }
    }

    #findWorktreeIdByRootPath(
        projectId: string,
        rootPath: string,
    ): string | null {
        const normalizedRootPath = path.resolve(rootPath);
        const matchedWorktree = this.listProjectWorktrees(projectId).find(
            (worktree) =>
                path.resolve(worktree.rootPath) === normalizedRootPath,
        );

        return matchedWorktree && !matchedWorktree.isPrimary
            ? matchedWorktree.id
            : null;
    }

    #normalizeWorktreeIdForInvalidation(
        projectId: string,
        worktreeId: string | null,
    ): string | null {
        if (!worktreeId) {
            return null;
        }

        const matchedWorktree = this.listProjectWorktrees(projectId).find(
            (worktree) => worktree.id === worktreeId,
        );

        return matchedWorktree?.isPrimary ? null : worktreeId;
    }
}

function normalizeGitPath(filePath: string): string {
    return filePath.split(path.sep).join("/");
}

function ensureProjectRoots(options: {
    readonly canonicalRootPath: string;
    readonly connection: Database.Database;
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
    readonly connection: Database.Database;
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
    } catch {
        return null;
    }
}

export function shouldIgnoreProjectWatchPath(
    relativePath: string | Buffer | null,
): boolean {
    if (relativePath == null) {
        return false;
    }

    const normalizedPath = relativePath
        .toString()
        .replaceAll("\\", "/")
        .replace(/^\.\/+/, "")
        .toLowerCase();

    return (
        normalizedPath === ".git/index" || normalizedPath === ".git/index.lock"
    );
}

function createBackgroundSafeGit(rootPath: string) {
    return simpleGit(rootPath).env({ GIT_OPTIONAL_LOCKS: "0" });
}

function directoryHasVisibleChildren(directoryPath: string): boolean {
    try {
        return fs
            .readdirSync(directoryPath, { withFileTypes: true })
            .some(
                (entry) => !shouldIgnoreEntry(entry.name, entry.isDirectory()),
            );
    } catch {
        return false;
    }
}

function getDirectoryBadge(
    directoryRelativePath: string,
    gitSnapshot: GitSnapshot,
): GitStatusBadge | null {
    for (const changedPath of gitSnapshot.changedPaths) {
        if (changedPath.startsWith(`${directoryRelativePath}/`)) {
            return "mixed";
        }
    }

    return gitSnapshot.exactBadges.get(directoryRelativePath) ?? null;
}

function scoreProjectEntry(
    name: string,
    relativePath: string,
    normalizedQuery: string,
): number {
    const normalizedName = name.toLowerCase();
    const normalizedPath = relativePath.toLowerCase();

    if (normalizedName === normalizedQuery) {
        return 120;
    }

    if (normalizedName.startsWith(normalizedQuery)) {
        return 90;
    }

    if (normalizedPath.startsWith(normalizedQuery)) {
        return 75;
    }

    if (normalizedName.includes(normalizedQuery)) {
        return 55;
    }

    if (normalizedPath.includes(normalizedQuery)) {
        return 35;
    }

    return 0;
}
