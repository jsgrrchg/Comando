import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { simpleGit } from "simple-git";
import { createProjectEntry, deleteProjectEntry, listProjectTreeChildren, normalizeRelativePath, readProjectFile, renameProjectEntry, resolveProjectPath, writeProjectFile, } from "./tree";
import { shouldIgnoreEntry } from "./ignore";
export class ProjectService {
    #connection;
    #onProjectTreeInvalidated;
    #watchers = new Map();
    #gitSnapshots = new Map();
    #pendingInvalidations = new Map();
    constructor(options) {
        this.#connection = options.connection;
        this.#onProjectTreeInvalidated = options.onProjectTreeInvalidated;
    }
    listProjects() {
        const rows = this.#connection
            .prepare(`
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
                `)
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
    addProjectPaths(projectPaths) {
        const insertProject = this.#connection.prepare(`
            INSERT INTO projects (id, name, created_at, updated_at)
            VALUES (?, ?, ?, ?)
            `);
        const insertRoot = this.#connection.prepare(`
            INSERT INTO project_roots (project_id, root_path, is_primary)
            VALUES (?, ?, ?)
            `);
        const touchRecent = this.#connection.prepare(`
            INSERT INTO recent_projects (project_id, last_opened_at)
            VALUES (?, ?)
            ON CONFLICT(project_id) DO UPDATE SET
                last_opened_at = excluded.last_opened_at
            `);
        const findExisting = this.#connection.prepare(`
            SELECT project_id
            FROM project_roots
            WHERE root_path = ?
            `);
        const transaction = this.#connection.transaction((normalizedPaths) => {
            for (const normalizedPath of normalizedPaths) {
                const now = new Date().toISOString();
                const existing = findExisting.get(normalizedPath);
                if (existing) {
                    touchRecent.run(existing.project_id, now);
                    continue;
                }
                const projectId = randomUUID();
                insertProject.run(projectId, path.basename(normalizedPath), now, now);
                insertRoot.run(projectId, normalizedPath, 1);
                touchRecent.run(projectId, now);
            }
        });
        const normalizedPaths = projectPaths
            .map((projectPath) => path.resolve(projectPath))
            .filter((projectPath) => {
            try {
                return fs.statSync(projectPath).isDirectory();
            }
            catch {
                return false;
            }
        });
        transaction(normalizedPaths);
        return this.listProjects();
    }
    removeProject(projectId) {
        this.#closeWatcher(projectId);
        this.#gitSnapshots.delete(projectId);
        this.#connection
            .prepare("DELETE FROM projects WHERE id = ?")
            .run(projectId);
    }
    touchProject(projectId) {
        const now = new Date().toISOString();
        this.#connection
            .prepare(`
                INSERT INTO recent_projects (project_id, last_opened_at)
                VALUES (?, ?)
                ON CONFLICT(project_id) DO UPDATE SET
                    last_opened_at = excluded.last_opened_at
                `)
            .run(projectId, now);
        this.#connection
            .prepare("UPDATE projects SET updated_at = ? WHERE id = ?")
            .run(now, projectId);
    }
    async listProjectTreeChildren(input) {
        const project = this.#getProjectById(input.projectId);
        const gitSnapshot = await this.#getGitSnapshot(project.id, project.rootPath);
        return listProjectTreeChildren({
            gitSnapshot,
            parentRelativePath: input.parentRelativePath,
            projectId: input.projectId,
            rootPath: project.rootPath,
        });
    }
    async openProjectFile(input) {
        const project = this.#getProjectById(input.projectId);
        this.touchProject(input.projectId);
        return readProjectFile({
            projectId: input.projectId,
            relativePath: input.relativePath,
            rootPath: project.rootPath,
        });
    }
    async searchProjectEntries(input) {
        const normalizedQuery = input.query.trim().toLowerCase();
        if (!normalizedQuery) {
            return [];
        }
        const project = this.#getProjectById(input.projectId);
        const gitSnapshot = await this.#getGitSnapshot(project.id, project.rootPath);
        const limit = Math.max(1, input.limit ?? 20);
        const scoredEntries = [];
        const queue = [project.rootPath];
        while (queue.length > 0) {
            const currentDirectory = queue.shift();
            if (!currentDirectory) {
                break;
            }
            let entries = [];
            try {
                entries = fs.readdirSync(currentDirectory, {
                    withFileTypes: true,
                });
            }
            catch {
                continue;
            }
            for (const entry of entries) {
                if (shouldIgnoreEntry(entry.name, entry.isDirectory())) {
                    continue;
                }
                const absolutePath = path.join(currentDirectory, entry.name);
                const relativePath = normalizeRelativePath(path.relative(project.rootPath, absolutePath));
                const score = scoreProjectEntry(entry.name, relativePath, normalizedQuery);
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
                        extension: kind === "file"
                            ? path.extname(entry.name).slice(1) || null
                            : null,
                        gitStatus: kind === "directory"
                            ? getDirectoryBadge(relativePath, gitSnapshot)
                            : (gitSnapshot.exactBadges.get(relativePath) ??
                                null),
                        hasChildren: kind === "directory"
                            ? directoryHasVisibleChildren(absolutePath)
                            : false,
                        kind,
                        name: entry.name,
                        parentRelativePath: path.posix.dirname(relativePath) === "."
                            ? null
                            : path.posix.dirname(relativePath),
                        relativePath,
                    },
                    score,
                });
            }
        }
        return scoredEntries
            .sort((left, right) => right.score - left.score ||
            left.node.relativePath.length -
                right.node.relativePath.length ||
            left.node.relativePath.localeCompare(right.node.relativePath))
            .slice(0, limit)
            .map((entry) => entry.node);
    }
    async saveProjectFile(input) {
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
    async createProjectEntry(input) {
        const project = this.#getProjectById(input.projectId);
        this.touchProject(input.projectId);
        this.#gitSnapshots.delete(input.projectId);
        const entry = await createProjectEntry({
            kind: input.kind,
            name: input.name,
            parentRelativePath: input.parentRelativePath,
            rootPath: project.rootPath,
        });
        this.#scheduleInvalidation(input.projectId);
        return entry;
    }
    async renameProjectEntry(input) {
        const project = this.#getProjectById(input.projectId);
        this.touchProject(input.projectId);
        this.#gitSnapshots.delete(input.projectId);
        const entry = await renameProjectEntry({
            nextName: input.nextName,
            relativePath: input.relativePath,
            rootPath: project.rootPath,
        });
        this.#scheduleInvalidation(input.projectId);
        return entry;
    }
    async deleteProjectEntry(input) {
        const project = this.#getProjectById(input.projectId);
        this.touchProject(input.projectId);
        this.#gitSnapshots.delete(input.projectId);
        await deleteProjectEntry({
            relativePath: input.relativePath,
            rootPath: project.rootPath,
        });
        this.#scheduleInvalidation(input.projectId);
    }
    getProjectRootPath(projectId) {
        return this.#getProjectById(projectId).rootPath;
    }
    resolveProjectEntryPath(projectId, relativePath) {
        const project = this.#getProjectById(projectId);
        return resolveProjectPath(project.rootPath, relativePath);
    }
    close() {
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
    #getProjectById(projectId) {
        const row = this.#connection
            .prepare(`
                SELECT projects.id, project_roots.root_path
                FROM projects
                INNER JOIN project_roots
                    ON project_roots.project_id = projects.id
                    AND project_roots.is_primary = 1
                WHERE projects.id = ?
                `)
            .get(projectId);
        if (!row) {
            throw new Error("The requested project does not exist anymore.");
        }
        return {
            id: row.id,
            rootPath: row.root_path,
        };
    }
    async #getGitSnapshot(projectId, rootPath) {
        const cachedSnapshot = this.#gitSnapshots.get(projectId);
        if (cachedSnapshot) {
            return cachedSnapshot;
        }
        try {
            const status = await simpleGit(rootPath).status();
            const exactBadges = new Map();
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
            };
            this.#gitSnapshots.set(projectId, snapshot);
            return snapshot;
        }
        catch {
            const emptySnapshot = {
                changedPaths: [],
                exactBadges: new Map(),
            };
            this.#gitSnapshots.set(projectId, emptySnapshot);
            return emptySnapshot;
        }
    }
    #ensureWatcher(projectId, rootPath) {
        if (this.#watchers.has(projectId)) {
            return;
        }
        try {
            const watcher = fs.watch(rootPath, { recursive: process.platform !== "linux" }, () => {
                this.#gitSnapshots.delete(projectId);
                this.#scheduleInvalidation(projectId);
            });
            this.#watchers.set(projectId, watcher);
        }
        catch {
            // Some file systems do not support recursive watching. The tree still
            // works, only live refresh is reduced until a stronger watcher lands.
        }
    }
    #scheduleInvalidation(projectId) {
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
    #closeWatcher(projectId) {
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
function normalizeGitPath(filePath) {
    return filePath.split(path.sep).join("/");
}
function directoryHasVisibleChildren(directoryPath) {
    try {
        return fs
            .readdirSync(directoryPath, { withFileTypes: true })
            .some((entry) => !shouldIgnoreEntry(entry.name, entry.isDirectory()));
    }
    catch {
        return false;
    }
}
function getDirectoryBadge(directoryRelativePath, gitSnapshot) {
    for (const changedPath of gitSnapshot.changedPaths) {
        if (changedPath.startsWith(`${directoryRelativePath}/`)) {
            return "mixed";
        }
    }
    return gitSnapshot.exactBadges.get(directoryRelativePath) ?? null;
}
function scoreProjectEntry(name, relativePath, normalizedQuery) {
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
