import fs from "node:fs";
import path from "node:path";

import { simpleGit } from "simple-git";

import type {
    CreateProjectEntryInput,
    GitStatusBadge,
    ProjectEntryMutationResult,
    ProjectFileDocument,
    ProjectTreeInvalidation,
    ProjectTreeNode,
} from "@shared/ipc";
import {
    compactProjectSearchValue,
    getProjectSearchDepth,
    normalizeProjectSearchQuery,
    scoreProjectSearchCandidate,
    type ProjectSearchCandidate,
} from "@shared/project-search";
import { normalizePathKey } from "@shared/path-identity";

import { debugBenignError } from "../observability/logging";
import { createSafeGitEnvironment } from "../git/environment";
import { shouldIgnoreEntry } from "./ignore";
import {
    copyExternalProjectEntries,
    copyProjectEntries,
    createProjectEntry,
    deleteProjectEntry,
    listProjectTreeChildren,
    normalizeRelativePath,
    readProjectFile,
    renameProjectEntry,
    writeProjectFile,
} from "./tree";

interface GitSnapshot {
    readonly changedPaths: readonly string[];
    readonly exactBadges: ReadonlyMap<string, GitStatusBadge>;
}

interface IndexedProjectEntry extends ProjectSearchCandidate {
    readonly extension: string | null;
    readonly hasChildren: boolean;
    readonly kind: ProjectTreeNode["kind"];
    readonly name: string;
    readonly parentRelativePath: string | null;
    readonly relativePath: string;
}

interface ScoredProjectSearchEntry {
    readonly entry: IndexedProjectEntry;
    readonly score: number;
}

interface PendingProjectInvalidation {
    readonly relativePaths: ReadonlySet<string> | null;
    readonly timeout: NodeJS.Timeout;
}

interface RegisteredRootContext {
    readonly projectId: string;
    readonly rootPath: string;
    readonly worktreeId: string | null;
}

export interface ProjectRuntimeOptions {
    readonly onProjectTreeInvalidated: (
        payload: ProjectTreeInvalidation,
    ) => void;
}

export interface ProjectRuntimeProjectRecord {
    readonly id: string;
    readonly rootPath: string;
}

export interface ProjectRuntimeWorktreeRecord {
    readonly id: string;
    readonly isPrimary: boolean;
    readonly projectId: string;
    readonly rootPath: string;
}

export interface ProjectRuntimeRegistrySnapshot {
    readonly projects: readonly ProjectRuntimeProjectRecord[];
    readonly worktrees: readonly ProjectRuntimeWorktreeRecord[];
}

export interface ProjectRuntimeScopeInput {
    readonly projectId: string;
    readonly rootPath: string;
    readonly worktreeId?: string | null;
}

export interface ProjectRuntimeTreeInput extends ProjectRuntimeScopeInput {
    readonly parentRelativePath: string | null;
}

export interface ProjectRuntimeOpenFileInput extends ProjectRuntimeScopeInput {
    readonly relativePath: string;
}

export interface ProjectRuntimeSaveFileInput extends ProjectRuntimeOpenFileInput {
    readonly content: string;
    readonly expectedModifiedAtMs?: number | null;
}

export interface ProjectRuntimeCreateEntryInput extends ProjectRuntimeScopeInput {
    readonly kind: CreateProjectEntryInput["kind"];
    readonly name: string;
    readonly parentRelativePath: string | null;
}

export interface ProjectRuntimeCopyEntriesInput extends ProjectRuntimeScopeInput {
    readonly destinationParentRelativePath: string | null;
    readonly sourceRelativePaths: readonly string[];
}

export interface ProjectRuntimeCopyExternalEntriesInput
    extends ProjectRuntimeScopeInput {
    readonly destinationParentRelativePath: string | null;
    readonly sourcePaths: readonly string[];
}

export interface ProjectRuntimeRenameEntryInput extends ProjectRuntimeScopeInput {
    readonly nextName: string;
    readonly nextParentRelativePath?: string | null;
    readonly relativePath: string;
}

export interface ProjectRuntimeDeleteEntryInput extends ProjectRuntimeScopeInput {
    readonly relativePath: string;
}

export interface ProjectRuntimeEntryMutationInput
    extends ProjectRuntimeScopeInput {
    readonly relativePaths: readonly string[];
}

export interface ProjectRuntimeSearchInput extends ProjectRuntimeScopeInput {
    readonly limit?: number;
    readonly query: string;
}

export type ProjectRuntimeListEntriesInput = ProjectRuntimeScopeInput;

export interface ProjectRuntimeSearchResponse {
    readonly nodes: readonly ProjectTreeNode[];
    readonly searchIndexCacheState: "hit" | "miss";
}

export class ProjectRuntime {
    readonly #gitSnapshots = new Map<string, GitSnapshot>();
    readonly #onProjectTreeInvalidated: (
        payload: ProjectTreeInvalidation,
    ) => void;
    readonly #pendingInvalidations = new Map<
        string,
        PendingProjectInvalidation
    >();
    readonly #registeredRoots = new Map<string, RegisteredRootContext>();
    readonly #searchIndexes = new Map<string, readonly IndexedProjectEntry[]>();
    readonly #watchers = new Map<string, fs.FSWatcher>();

    constructor(options: ProjectRuntimeOptions) {
        this.#onProjectTreeInvalidated = options.onProjectTreeInvalidated;
    }

    syncRegistry(snapshot: ProjectRuntimeRegistrySnapshot): void {
        const desiredRoots = buildRegisteredRoots(snapshot);

        for (const [rootKey] of this.#registeredRoots) {
            if (desiredRoots.has(rootKey)) {
                continue;
            }

            this.#closeRegisteredRoot(rootKey);
        }

        this.#registeredRoots.clear();
        for (const [rootKey, context] of desiredRoots) {
            this.#registeredRoots.set(rootKey, context);
            this.#ensureWatcher(context);
        }
    }

    removeProject(projectId: string): void {
        for (const [rootKey, context] of this.#registeredRoots) {
            if (context.projectId !== projectId) {
                continue;
            }

            this.#closeRegisteredRoot(rootKey);
        }

        for (const [invalidationKey, pendingInvalidation] of this
            .#pendingInvalidations) {
            if (!invalidationKey.startsWith(`${projectId}:`)) {
                continue;
            }

            clearTimeout(pendingInvalidation.timeout);
            this.#pendingInvalidations.delete(invalidationKey);
        }
    }

    async listProjectTreeChildren(
        input: ProjectRuntimeTreeInput,
    ): Promise<ProjectTreeNode[]> {
        this.#ensureRootContext(input);
        const gitSnapshot = await this.#getGitSnapshot(input.rootPath);

        return listProjectTreeChildren({
            gitSnapshot,
            parentRelativePath: input.parentRelativePath,
            projectId: input.projectId,
            rootPath: input.rootPath,
        });
    }

    async openProjectFile(
        input: ProjectRuntimeOpenFileInput,
    ): Promise<ProjectFileDocument> {
        this.#ensureRootContext(input);

        return await readProjectFile({
            projectId: input.projectId,
            relativePath: input.relativePath,
            rootPath: input.rootPath,
        });
    }

    async saveProjectFile(
        input: ProjectRuntimeSaveFileInput,
    ): Promise<ProjectFileDocument> {
        this.#ensureRootContext(input);
        const document = await writeProjectFile({
            content: input.content,
            expectedModifiedAtMs: input.expectedModifiedAtMs ?? null,
            projectId: input.projectId,
            relativePath: input.relativePath,
            rootPath: input.rootPath,
        });

        this.#handleRootMutation(input, [input.relativePath]);
        return document;
    }

    async createProjectEntry(
        input: ProjectRuntimeCreateEntryInput,
    ): Promise<ProjectEntryMutationResult> {
        this.#ensureRootContext(input);
        const entry = await createProjectEntry({
            kind: input.kind,
            name: input.name,
            parentRelativePath: input.parentRelativePath,
            rootPath: input.rootPath,
        });

        this.#handleRootMutation(input, [entry.relativePath]);
        return entry;
    }

    async copyProjectEntries(
        input: ProjectRuntimeCopyEntriesInput,
    ): Promise<readonly ProjectEntryMutationResult[]> {
        this.#ensureRootContext(input);
        const entries = await copyProjectEntries({
            destinationParentRelativePath: input.destinationParentRelativePath,
            rootPath: input.rootPath,
            sourceRelativePaths: input.sourceRelativePaths,
        });

        this.#handleRootMutation(
            input,
            entries.map((entry) => entry.relativePath),
        );
        return entries;
    }

    async copyExternalProjectEntries(
        input: ProjectRuntimeCopyExternalEntriesInput,
    ): Promise<readonly ProjectEntryMutationResult[]> {
        this.#ensureRootContext(input);
        const entries = await copyExternalProjectEntries({
            destinationParentRelativePath: input.destinationParentRelativePath,
            rootPath: input.rootPath,
            sourcePaths: input.sourcePaths,
        });

        this.#handleRootMutation(
            input,
            entries.map((entry) => entry.relativePath),
        );
        return entries;
    }

    async renameProjectEntry(
        input: ProjectRuntimeRenameEntryInput,
    ): Promise<ProjectEntryMutationResult> {
        this.#ensureRootContext(input);
        const entry = await renameProjectEntry({
            nextName: input.nextName,
            nextParentRelativePath: input.nextParentRelativePath,
            relativePath: input.relativePath,
            rootPath: input.rootPath,
        });

        this.#handleRootMutation(input, [
            input.relativePath,
            entry.relativePath,
        ]);
        return entry;
    }

    async deleteProjectEntry(
        input: ProjectRuntimeDeleteEntryInput,
    ): Promise<void> {
        this.#ensureRootContext(input);
        await deleteProjectEntry({
            relativePath: input.relativePath,
            rootPath: input.rootPath,
        });

        this.#handleRootMutation(input, [input.relativePath]);
    }

    recordProjectEntryMutation(input: ProjectRuntimeEntryMutationInput): void {
        this.#ensureRootContext(input);
        this.#handleRootMutation(input, input.relativePaths);
    }

    async searchProjectEntries(
        input: ProjectRuntimeSearchInput,
    ): Promise<ProjectRuntimeSearchResponse> {
        const normalizedQuery = normalizeProjectSearchQuery(input.query);
        if (!normalizedQuery) {
            return {
                nodes: [],
                searchIndexCacheState: "hit",
            };
        }

        this.#ensureRootContext(input);
        const limit = Math.max(1, input.limit ?? 20);
        const { entries, cacheState } = this.#getProjectSearchIndex(
            input.rootPath,
        );
        const scoredEntries = collectTopProjectSearchEntries(
            entries,
            normalizedQuery,
            limit,
        );

        if (scoredEntries.length === 0) {
            return {
                nodes: [],
                searchIndexCacheState: cacheState,
            };
        }

        const gitSnapshot = await this.#getGitSnapshot(input.rootPath);

        return {
            nodes: scoredEntries.map((match) =>
                createProjectTreeNodeFromIndexEntry(
                    input.projectId,
                    match.entry,
                    gitSnapshot,
                ),
            ),
            searchIndexCacheState: cacheState,
        };
    }

    async listProjectEntries(
        input: ProjectRuntimeListEntriesInput,
    ): Promise<ProjectRuntimeSearchResponse> {
        this.#ensureRootContext(input);
        const gitSnapshot = await this.#getGitSnapshot(input.rootPath);
        const { entries, cacheState } = this.#getProjectSearchIndex(
            input.rootPath,
        );

        return {
            nodes: entries.map((entry) =>
                createProjectTreeNodeFromIndexEntry(
                    input.projectId,
                    entry,
                    gitSnapshot,
                ),
            ),
            searchIndexCacheState: cacheState,
        };
    }

    close(): void {
        for (const watcher of this.#watchers.values()) {
            watcher.close();
        }

        for (const pendingInvalidation of this.#pendingInvalidations.values()) {
            clearTimeout(pendingInvalidation.timeout);
        }

        this.#watchers.clear();
        this.#gitSnapshots.clear();
        this.#pendingInvalidations.clear();
        this.#registeredRoots.clear();
        this.#searchIndexes.clear();
    }

    #handleRootMutation(
        input: ProjectRuntimeScopeInput,
        relativePaths: readonly string[],
    ): void {
        this.#gitSnapshots.delete(normalizeRootPathKey(input.rootPath));
        this.#invalidateProjectSearchIndex(input.rootPath);
        this.#scheduleInvalidation(
            input.projectId,
            normalizeWorktreeId(input.worktreeId ?? null),
            relativePaths,
        );
    }

    #ensureRootContext(input: ProjectRuntimeScopeInput): void {
        const context = {
            projectId: input.projectId,
            rootPath: input.rootPath,
            worktreeId: normalizeWorktreeId(input.worktreeId ?? null),
        } satisfies RegisteredRootContext;
        const rootKey = buildRegisteredRootKey(
            context.projectId,
            context.rootPath,
        );

        if (!this.#registeredRoots.has(rootKey)) {
            this.#registeredRoots.set(rootKey, context);
        }

        this.#ensureWatcher(context);
    }

    async #getGitSnapshot(rootPath: string): Promise<GitSnapshot> {
        const resolvedRootPath = resolveRootPath(rootPath);
        const rootPathKey = normalizeRootPathKey(resolvedRootPath);
        const cachedSnapshot = this.#gitSnapshots.get(rootPathKey);
        if (cachedSnapshot) {
            return cachedSnapshot;
        }

        try {
            const status =
                await createBackgroundSafeGit(resolvedRootPath).status();
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

            this.#gitSnapshots.set(rootPathKey, snapshot);
            return snapshot;
        } catch (error) {
            debugBenignError("projects.runtime.computeGitSnapshot", error);
            const emptySnapshot = {
                changedPaths: [],
                exactBadges: new Map<string, GitStatusBadge>(),
            } satisfies GitSnapshot;

            this.#gitSnapshots.set(rootPathKey, emptySnapshot);
            return emptySnapshot;
        }
    }

    #ensureWatcher(context: RegisteredRootContext): void {
        const rootKey = buildRegisteredRootKey(
            context.projectId,
            context.rootPath,
        );
        if (this.#watchers.has(rootKey)) {
            return;
        }

        try {
            const watcher = fs.watch(
                context.rootPath,
                { recursive: process.platform !== "linux" },
                (_eventType, relativePath) => {
                    if (shouldIgnoreProjectWatchPath(relativePath)) {
                        return;
                    }

                    const normalizedRelativePath =
                        normalizeProjectWatchRelativePath(relativePath);

                    this.#gitSnapshots.delete(
                        normalizeRootPathKey(context.rootPath),
                    );
                    this.#invalidateProjectSearchIndex(context.rootPath);
                    this.#scheduleInvalidation(
                        context.projectId,
                        context.worktreeId,
                        normalizedRelativePath
                            ? [normalizedRelativePath]
                            : null,
                    );
                },
            );

            this.#watchers.set(rootKey, watcher);
        } catch (error) {
            // Some file systems do not support recursive watching. The tree still
            // works, only live refresh is reduced until a stronger watcher lands.
            debugBenignError("projects.runtime.ensureWatcher", error);
        }
    }

    #scheduleInvalidation(
        projectId: string,
        worktreeId: string | null = null,
        relativePaths: readonly string[] | null = null,
    ): void {
        const invalidationKey = `${projectId}:${worktreeId ?? "primary"}`;
        const existingInvalidation =
            this.#pendingInvalidations.get(invalidationKey);
        if (existingInvalidation) {
            clearTimeout(existingInvalidation.timeout);
        }

        const mergedRelativePaths = mergeProjectInvalidationRelativePaths(
            existingInvalidation?.relativePaths ?? null,
            normalizeProjectInvalidationRelativePaths(relativePaths),
        );

        const timeout = setTimeout(() => {
            this.#pendingInvalidations.delete(invalidationKey);
            this.#onProjectTreeInvalidated({
                occurredAt: new Date().toISOString(),
                projectId,
                relativePaths:
                    mergedRelativePaths === null
                        ? null
                        : Array.from(mergedRelativePaths),
                worktreeId,
            });
        }, 140);
        timeout.unref();

        this.#pendingInvalidations.set(invalidationKey, {
            relativePaths: mergedRelativePaths,
            timeout,
        });
    }

    #getProjectSearchIndex(rootPath: string): {
        readonly cacheState: "hit" | "miss";
        readonly entries: readonly IndexedProjectEntry[];
    } {
        const resolvedRootPath = resolveRootPath(rootPath);
        const rootPathKey = normalizeRootPathKey(resolvedRootPath);
        const cachedIndex = this.#searchIndexes.get(rootPathKey);
        if (cachedIndex) {
            return {
                cacheState: "hit",
                entries: cachedIndex,
            };
        }

        const entries = buildProjectSearchIndex(resolvedRootPath);
        this.#searchIndexes.set(rootPathKey, entries);
        return {
            cacheState: "miss",
            entries,
        };
    }

    #invalidateProjectSearchIndex(rootPath: string): void {
        this.#searchIndexes.delete(normalizeRootPathKey(rootPath));
    }

    #closeRegisteredRoot(rootKey: string): void {
        const context = this.#registeredRoots.get(rootKey);
        const watcher = this.#watchers.get(rootKey);
        if (watcher) {
            watcher.close();
            this.#watchers.delete(rootKey);
        }

        if (context) {
            const rootPathKey = normalizeRootPathKey(context.rootPath);
            this.#gitSnapshots.delete(rootPathKey);
            this.#searchIndexes.delete(rootPathKey);
        }

        this.#registeredRoots.delete(rootKey);
    }
}

function buildRegisteredRoots(
    snapshot: ProjectRuntimeRegistrySnapshot,
): Map<string, RegisteredRootContext> {
    const roots = new Map<string, RegisteredRootContext>();
    const worktreesByProjectId = new Map<
        string,
        readonly ProjectRuntimeWorktreeRecord[]
    >();

    for (const worktree of snapshot.worktrees) {
        const currentWorktrees =
            worktreesByProjectId.get(worktree.projectId) ?? [];
        worktreesByProjectId.set(worktree.projectId, [
            ...currentWorktrees,
            worktree,
        ]);
    }

    for (const project of snapshot.projects) {
        const worktrees = worktreesByProjectId.get(project.id) ?? [];
        if (worktrees.length === 0) {
            roots.set(buildRegisteredRootKey(project.id, project.rootPath), {
                projectId: project.id,
                rootPath: project.rootPath,
                worktreeId: null,
            });
            continue;
        }

        for (const worktree of worktrees) {
            roots.set(buildRegisteredRootKey(project.id, worktree.rootPath), {
                projectId: project.id,
                rootPath: worktree.rootPath,
                worktreeId: worktree.isPrimary ? null : worktree.id,
            });
        }
    }

    return roots;
}

function buildProjectSearchIndex(
    rootPath: string,
): readonly IndexedProjectEntry[] {
    const resolvedRootPath = resolveRootPath(rootPath);
    const queue = [resolvedRootPath];
    const pendingEntries: {
        readonly extension: string | null;
        readonly kind: ProjectTreeNode["kind"];
        readonly name: string;
        readonly parentRelativePath: string | null;
        readonly relativePath: string;
    }[] = [];
    const directoryChildren = new Map<string, boolean>();

    while (queue.length > 0) {
        const currentDirectory = queue.shift();
        if (!currentDirectory) {
            break;
        }

        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(currentDirectory, {
                withFileTypes: true,
            });
        } catch (error) {
            debugBenignError("projects.runtime.search.readdir", error);
            continue;
        }

        const visibleEntries = entries.filter(
            (entry) => !shouldIgnoreEntry(entry.name, entry.isDirectory()),
        );
        const currentRelativePath = normalizeRelativePath(
            path.relative(resolvedRootPath, currentDirectory),
        );

        if (currentRelativePath !== ".") {
            directoryChildren.set(
                currentRelativePath,
                visibleEntries.length > 0,
            );
        }

        for (const entry of visibleEntries) {
            const absolutePath = path.join(currentDirectory, entry.name);
            const relativePath = normalizeRelativePath(
                path.relative(resolvedRootPath, absolutePath),
            );
            const kind = entry.isDirectory() ? "directory" : "file";

            pendingEntries.push({
                extension:
                    kind === "file"
                        ? path.extname(entry.name).slice(1) || null
                        : null,
                kind,
                name: entry.name,
                parentRelativePath:
                    path.posix.dirname(relativePath) === "."
                        ? null
                        : path.posix.dirname(relativePath),
                relativePath,
            });

            if (entry.isDirectory()) {
                queue.push(absolutePath);
            }
        }
    }

    return pendingEntries.map((entry) => ({
        ...entry,
        compactPath: compactProjectSearchValue(entry.relativePath),
        depth: getProjectSearchDepth(entry.relativePath),
        hasChildren:
            entry.kind === "directory"
                ? (directoryChildren.get(entry.relativePath) ?? false)
                : false,
        lowerName: entry.name.toLowerCase(),
        lowerPath: entry.relativePath.toLowerCase(),
    }));
}

function collectTopProjectSearchEntries(
    entries: readonly IndexedProjectEntry[],
    normalizedQuery: string,
    limit: number,
): readonly ScoredProjectSearchEntry[] {
    const topEntries: ScoredProjectSearchEntry[] = [];

    for (const entry of entries) {
        const score = scoreProjectSearchCandidate(entry, normalizedQuery);
        if (score < 0) {
            continue;
        }

        const scoredEntry = { entry, score };
        const worstEntry = topEntries.at(-1);

        if (
            topEntries.length >= limit &&
            worstEntry &&
            compareScoredProjectSearchEntries(scoredEntry, worstEntry) >= 0
        ) {
            continue;
        }

        const insertIndex = findProjectSearchInsertIndex(
            topEntries,
            scoredEntry,
        );
        topEntries.splice(insertIndex, 0, scoredEntry);

        if (topEntries.length > limit) {
            topEntries.pop();
        }
    }

    return topEntries;
}

function findProjectSearchInsertIndex(
    entries: readonly ScoredProjectSearchEntry[],
    candidate: ScoredProjectSearchEntry,
): number {
    let low = 0;
    let high = entries.length;

    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        const current = entries[middle];
        if (compareScoredProjectSearchEntries(candidate, current) < 0) {
            high = middle;
        } else {
            low = middle + 1;
        }
    }

    return low;
}

function compareScoredProjectSearchEntries(
    left: ScoredProjectSearchEntry,
    right: ScoredProjectSearchEntry,
): number {
    return (
        right.score - left.score ||
        left.entry.relativePath.length - right.entry.relativePath.length ||
        left.entry.relativePath.localeCompare(right.entry.relativePath)
    );
}

function createProjectTreeNodeFromIndexEntry(
    projectId: string,
    entry: IndexedProjectEntry,
    gitSnapshot: GitSnapshot,
): ProjectTreeNode {
    return {
        id: `${projectId}:${entry.relativePath}`,
        extension: entry.extension,
        gitStatus:
            entry.kind === "directory"
                ? getDirectoryBadge(entry.relativePath, gitSnapshot)
                : (gitSnapshot.exactBadges.get(entry.relativePath) ?? null),
        hasChildren: entry.hasChildren,
        kind: entry.kind,
        name: entry.name,
        parentRelativePath: entry.parentRelativePath,
        relativePath: entry.relativePath,
    };
}

function buildRegisteredRootKey(projectId: string, rootPath: string): string {
    return `${projectId}:${normalizeRootPathKey(rootPath)}`;
}

function normalizeGitPath(filePath: string): string {
    return filePath.split(path.sep).join("/");
}

function resolveRootPath(rootPath: string): string {
    return path.resolve(rootPath);
}

function normalizeRootPathKey(rootPath: string): string {
    return normalizePathKey(resolveRootPath(rootPath), {
        platform: getNativePathIdentityPlatform(),
    });
}

function getNativePathIdentityPlatform(): "posix" | "win32" {
    return process.platform === "win32" ? "win32" : "posix";
}

function normalizeWorktreeId(worktreeId: string | null): string | null {
    if (!worktreeId || worktreeId.endsWith(":primary")) {
        return null;
    }

    return worktreeId;
}

export function shouldIgnoreProjectWatchPath(
    relativePath: string | Buffer | null,
): boolean {
    const normalizedPath = normalizeProjectWatchRelativePath(relativePath);
    if (normalizedPath == null) {
        return false;
    }

    const normalizedLowerPath = normalizedPath.toLowerCase();
    const segments = normalizedLowerPath.split("/");
    const fileName = segments.at(-1) ?? normalizedLowerPath;

    return (
        normalizedLowerPath === ".git/index" ||
        normalizedLowerPath === ".git/index.lock" ||
        segments.some((segment) =>
            ignoredProjectWatchDirectoryNames.has(segment),
        ) ||
        ignoredProjectWatchFileNames.has(fileName) ||
        fileName.endsWith(".tsbuildinfo")
    );
}

const ignoredProjectWatchDirectoryNames = new Set([
    "build",
    "coverage",
    "dist",
    "node_modules",
    "out",
    "target",
]);

const ignoredProjectWatchFileNames = new Set([".ds_store", "thumbs.db"]);

function normalizeProjectWatchRelativePath(
    relativePath: string | Buffer | null,
): string | null {
    if (relativePath == null) {
        return null;
    }

    const normalizedPath = relativePath
        .toString()
        .replaceAll("\\", "/")
        .replace(/^\.\/+/, "")
        .replace(/^\/+/, "")
        .trim();

    if (!normalizedPath || normalizedPath === ".") {
        return null;
    }

    return normalizeRelativePath(normalizedPath);
}

function normalizeProjectInvalidationRelativePaths(
    relativePaths: readonly string[] | null,
): ReadonlySet<string> | null {
    if (relativePaths === null) {
        return null;
    }

    const normalizedRelativePaths = new Set<string>();
    for (const relativePath of relativePaths) {
        const normalizedPath = normalizeProjectWatchRelativePath(relativePath);
        if (normalizedPath) {
            normalizedRelativePaths.add(normalizedPath);
        }
    }

    return normalizedRelativePaths.size > 0 ? normalizedRelativePaths : null;
}

function mergeProjectInvalidationRelativePaths(
    currentRelativePaths: ReadonlySet<string> | null,
    nextRelativePaths: ReadonlySet<string> | null,
): ReadonlySet<string> | null {
    if (currentRelativePaths === null || nextRelativePaths === null) {
        return null;
    }

    return new Set([...currentRelativePaths, ...nextRelativePaths]);
}

function createBackgroundSafeGit(rootPath: string) {
    return simpleGit(rootPath).env(
        createSafeGitEnvironment({
            GIT_OPTIONAL_LOCKS: "0",
        }),
    );
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
