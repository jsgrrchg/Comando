import path from "node:path";

import type {
    CopyExternalProjectEntriesInput,
    CopyExternalProjectEntriesResult,
    CopyProjectEntriesInput,
    CopyProjectEntriesResult,
    CreateProjectEntryInput,
    DeleteProjectEntryInput,
    ListProjectEntriesInput,
    ListProjectTreeInput,
    ProjectAppDataSummary,
    ProjectAddResult,
    OpenProjectFileInput,
    ProjectEntryMutationResult,
    ProjectFileDocument,
    ProjectSummary,
    ProjectTreeInvalidation,
    ProjectTreeNode,
    RenameProjectEntryInput,
    SaveProjectFileInput,
    SearchProjectEntriesInput,
} from "@shared/ipc";
import { normalizeProjectSearchQuery } from "@shared/project-search";
import { normalizePathKey } from "@shared/path-identity";

import { mainProcessPerformance } from "../observability/performance";
import { debugBenignError } from "../observability/logging";
import {
    NativeFsGateway,
    resolveNativeFsMode,
    shouldUseNativeFsReads,
    shouldUseNativeFsWrites,
    shouldUseNativeProjectTree,
    shouldUseNativeWatchers,
} from "../native-backend/fs";
import {
    recordFilesystemAccessFailure,
    recordFilesystemAccessSuccess,
} from "../privacy-access";
import type { ProjectStore, ProjectStoreWorktreeRecord } from "./store";
import {
    createLocalProjectWorkerClient,
    type ProjectWorkerGateway,
} from "./client";
import {
    type ProjectRuntimeRegistrySnapshot,
    shouldIgnoreProjectWatchPath,
} from "./runtime";
import { resolveProjectPath } from "./tree";

interface ResolvedProjectScope {
    readonly canonicalRootPath: string;
    readonly id: string;
    readonly rootPath: string;
    readonly worktreeId: string | null;
}

interface ProjectServiceOptions {
    readonly env?: NodeJS.ProcessEnv;
    readonly nativeFs?: NativeFsGateway | null;
    readonly onProjectTreeInvalidated: (
        payload: ProjectTreeInvalidation,
    ) => void;
    readonly onProjectTouched?: (projectPath: string) => void;
    readonly store: ProjectStore;
    readonly worker?: ProjectWorkerGateway;
}

export class ProjectService {
    readonly #indexedRoots = new Set<string>();
    readonly #nativeFs: NativeFsGateway | null;
    readonly #nativeFsReadsEnabled: boolean;
    readonly #nativeFsWritesEnabled: boolean;
    readonly #nativeProjectTreeEnabled: boolean;
    readonly #nativeWatchersEnabled: boolean;
    readonly #onProjectTouched?: (projectPath: string) => void;
    readonly #onProjectTreeInvalidated: (
        payload: ProjectTreeInvalidation,
    ) => void;
    readonly #store: ProjectStore;
    readonly #worker: ProjectWorkerGateway;
    #nativeWatcherRegistryVersion = 1;
    #pendingNativeWatcherRegistrySync: Promise<void> | null = null;
    #syncedNativeWatcherRegistryVersion = 0;
    #pendingWorkerRegistrySync: Promise<void> | null = null;
    #syncedWorkerRegistryVersion = 0;
    #workerRegistryVersion = 1;

    constructor(options: ProjectServiceOptions) {
        const env = options.env ?? process.env;
        this.#nativeFs = options.nativeFs ?? null;
        const nativeFsMode = resolveNativeFsMode(env);
        if (nativeFsMode === "write" && this.#nativeFs === null) {
            throw new Error(
                "Native filesystem write mode requires the native backend sidecar.",
            );
        }
        this.#nativeFsReadsEnabled =
            this.#nativeFs !== null && shouldUseNativeFsReads(env);
        this.#nativeFsWritesEnabled =
            this.#nativeFs !== null && shouldUseNativeFsWrites(env);
        this.#nativeProjectTreeEnabled =
            this.#nativeFs !== null && shouldUseNativeProjectTree(env);
        this.#nativeWatchersEnabled =
            this.#nativeFs !== null && shouldUseNativeWatchers(env);
        this.#onProjectTouched = options.onProjectTouched;
        this.#onProjectTreeInvalidated = options.onProjectTreeInvalidated;
        this.#store = options.store;
        this.#worker =
            options.worker ??
            createLocalProjectWorkerClient({
                onProjectTreeInvalidated: (payload) => {
                    this.handleProjectTreeInvalidation(payload);
                },
            });
    }

    listProjects(): ProjectSummary[] {
        return mainProcessPerformance.measureSync(
            "db.projects.listProjects",
            () => {
                const projects = [...this.#store.listProjects()];
                this.#scheduleActiveWatcherRegistrySync();
                return projects;
            },
        );
    }

    async addProjectPaths(
        projectPaths: readonly string[],
    ): Promise<ProjectAddResult> {
        const result = await this.#store.addProjectPaths(projectPaths);
        this.#markWorkerRegistryDirty();
        this.#markNativeWatcherRegistryDirty();
        await this.#ensureActiveWatcherRegistry();

        for (const rootPath of result.touchedRootPaths) {
            this.#onProjectTouched?.(rootPath);
        }

        return {
            projectIdsToOpen: [...result.touchedProjectIds],
            projects: [...result.projects],
        };
    }

    async clearProjectAppData(projectId: string): Promise<{
        readonly cleared: ProjectAppDataSummary;
        readonly projects: readonly ProjectSummary[];
    }> {
        this.#getProjectById(projectId);
        const cleared = await this.#store.clearProjectAppData(projectId);

        return {
            cleared,
            projects: this.listProjects(),
        };
    }

    async getProjectAppDataSummary(
        projectId: string,
    ): Promise<ProjectAppDataSummary> {
        this.#getProjectById(projectId);
        return await this.#store.getProjectAppDataSummary(projectId);
    }

    async relocateProject(
        projectId: string,
        projectPath: string,
    ): Promise<{
        readonly project: ProjectSummary;
        readonly projects: readonly ProjectSummary[];
    }> {
        const rootPaths = this.listProjectWorktrees(projectId).map(
            (worktree) => worktree.rootPath,
        );
        rootPaths.push(this.#getProjectById(projectId).rootPath);
        for (const rootPath of rootPaths) {
            this.#indexedRoots.delete(normalizeRootPathKey(rootPath));
        }

        const project = await this.#store.relocateProject(
            projectId,
            projectPath,
        );
        await this.#worker.removeProject(projectId);
        this.#indexedRoots.delete(normalizeRootPathKey(project.rootPath));
        this.#markWorkerRegistryDirty();
        this.#markNativeWatcherRegistryDirty();
        await this.#ensureActiveWatcherRegistry();
        this.#onProjectTouched?.(project.rootPath);
        this.#onProjectTreeInvalidated({
            projectId,
            occurredAt: new Date().toISOString(),
            relativePaths: null,
            worktreeId: null,
        });

        return {
            project,
            projects: this.listProjects(),
        };
    }

    async removeProject(projectId: string): Promise<void> {
        const rootPaths = this.listProjectWorktrees(projectId).map(
            (worktree) => worktree.rootPath,
        );
        rootPaths.push(this.#getProjectById(projectId).rootPath);
        for (const rootPath of rootPaths) {
            this.#indexedRoots.delete(normalizeRootPathKey(rootPath));
        }

        this.#markWorkerRegistryDirty();
        await this.#worker.removeProject(projectId);
        this.#store.removeProject(projectId);
        this.#markNativeWatcherRegistryDirty();
        await this.#ensureActiveWatcherRegistry();
    }

    touchProject(projectId: string): void {
        const project = this.#getProjectById(projectId);
        this.#store.touchProject(projectId);
        this.#onProjectTouched?.(project.rootPath);
    }

    async listProjectTreeChildren(
        input: ListProjectTreeInput,
    ): Promise<ProjectTreeNode[]> {
        const project = this.#resolveProjectScope(
            input.projectId,
            input.worktreeId ?? null,
        );
        const useNative = this.#nativeProjectTreeEnabled && this.#nativeFs;
        if (!useNative) {
            await this.#ensureWorkerRegistry();
        }

        return await mainProcessPerformance
            .measureAsync(
                "projects.listProjectTreeChildren",
                async () =>
                    await this.#trackFilesystemAccess(
                        resolveProjectPath(
                            project.rootPath,
                            input.parentRelativePath,
                        ),
                        async () =>
                            useNative
                                ? await this.#nativeFs!.listProjectTreeChildren({
                                      parentRelativePath:
                                          input.parentRelativePath,
                                      projectId: input.projectId,
                                      rootPath: project.rootPath,
                                      worktreeId: project.worktreeId,
                                  })
                                : await this.#worker.listProjectTreeChildren({
                                      parentRelativePath:
                                          input.parentRelativePath,
                                      projectId: input.projectId,
                                      rootPath: project.rootPath,
                                      worktreeId: project.worktreeId,
                                  }),
                    ),
                {
                    parentRelativePath: input.parentRelativePath ?? ".",
                    projectId: input.projectId,
                    transport: useNative ? "native" : "worker",
                    worktreeId: input.worktreeId ?? "primary",
                },
            )
            .then((nodes) => [...nodes]);
    }

    async listProjectEntries(
        input: ListProjectEntriesInput,
    ): Promise<ProjectTreeNode[]> {
        const project = this.#resolveProjectScope(
            input.projectId,
            input.worktreeId ?? null,
        );

        await this.#ensureWorkerRegistry();
        const rootPathKey = normalizeRootPathKey(project.rootPath);
        const listEntries = async () =>
            await this.#worker.listProjectEntries({
                projectId: input.projectId,
                rootPath: project.rootPath,
                worktreeId: project.worktreeId,
            });
        const response = this.#indexedRoots.has(rootPathKey)
            ? await this.#trackFilesystemAccess(project.rootPath, listEntries)
            : await mainProcessPerformance.measureAsync(
                  "projects.buildSearchIndex",
                  async () =>
                      await this.#trackFilesystemAccess(
                          project.rootPath,
                          listEntries,
                      ),
                  {
                      projectId: input.projectId,
                      rootPath: resolveRootPath(project.rootPath),
                      transport: "worker",
                      worktreeId: input.worktreeId ?? "primary",
                  },
              );

        this.#indexedRoots.add(rootPathKey);
        return [...response.nodes];
    }

    async openProjectFile(
        input: OpenProjectFileInput,
    ): Promise<ProjectFileDocument> {
        const project = this.#resolveProjectScope(
            input.projectId,
            input.worktreeId ?? null,
        );
        this.touchProject(input.projectId);
        if (!this.#nativeFsReadsEnabled) {
            await this.#ensureWorkerRegistry();
        }

        return await this.#trackFilesystemAccess(
            resolveProjectPath(project.rootPath, input.relativePath),
            async () =>
                this.#nativeFsReadsEnabled && this.#nativeFs
                    ? await this.#nativeFs.openProjectFile({
                          projectId: input.projectId,
                          relativePath: input.relativePath,
                          rootPath: project.rootPath,
                          worktreeId: project.worktreeId,
                      })
                    : await this.#worker.openProjectFile({
                          projectId: input.projectId,
                          relativePath: input.relativePath,
                          rootPath: project.rootPath,
                          worktreeId: project.worktreeId,
                      }),
        );
    }

    async searchProjectEntries(
        input: SearchProjectEntriesInput,
    ): Promise<ProjectTreeNode[]> {
        const normalizedQuery = normalizeProjectSearchQuery(input.query);
        if (!normalizedQuery) {
            return [];
        }

        await this.#ensureWorkerRegistry();
        const project = this.#resolveProjectScope(
            input.projectId,
            input.worktreeId ?? null,
        );
        const rootPathKey = normalizeRootPathKey(project.rootPath);
        const search = async () =>
            await this.#worker.searchProjectEntries({
                includeAncestorDirectories: input.includeAncestorDirectories,
                limit: input.limit,
                projectId: input.projectId,
                query: normalizedQuery,
                rootPath: project.rootPath,
                worktreeId: project.worktreeId,
            });
        const response = this.#indexedRoots.has(rootPathKey)
            ? await this.#trackFilesystemAccess(project.rootPath, search)
            : await mainProcessPerformance.measureAsync(
                  "projects.buildSearchIndex",
                  async () =>
                      await this.#trackFilesystemAccess(
                          project.rootPath,
                          search,
                      ),
                  {
                      projectId: input.projectId,
                      rootPath: resolveRootPath(project.rootPath),
                      transport: "worker",
                      worktreeId: input.worktreeId ?? "primary",
                  },
              );

        this.#indexedRoots.add(rootPathKey);
        return [...response.nodes];
    }

    async saveProjectFile(
        input: SaveProjectFileInput,
    ): Promise<ProjectFileDocument> {
        const project = this.#resolveProjectScope(
            input.projectId,
            input.worktreeId ?? null,
        );
        this.touchProject(input.projectId);
        if (!this.#nativeFsWritesEnabled) {
            await this.#ensureWorkerRegistry();
        }

        return await this.#trackFilesystemAccess(
            resolveProjectPath(project.rootPath, input.relativePath),
            async () =>
                this.#nativeFsWritesEnabled && this.#nativeFs
                    ? await this.#nativeFs.saveProjectFile({
                          content: input.content,
                          expectedModifiedAtMs:
                              input.expectedModifiedAtMs ?? null,
                          projectId: input.projectId,
                          relativePath: input.relativePath,
                          rootPath: project.rootPath,
                          worktreeId: project.worktreeId,
                      })
                    : await this.#worker.saveProjectFile({
                          content: input.content,
                          expectedModifiedAtMs:
                              input.expectedModifiedAtMs ?? null,
                          projectId: input.projectId,
                          relativePath: input.relativePath,
                          rootPath: project.rootPath,
                          worktreeId: project.worktreeId,
                      }),
        );
    }

    async createProjectEntry(
        input: CreateProjectEntryInput,
    ): Promise<ProjectEntryMutationResult> {
        const project = this.#resolveProjectScope(
            input.projectId,
            input.worktreeId ?? null,
        );
        this.touchProject(input.projectId);
        if (!this.#nativeFsWritesEnabled) {
            await this.#ensureWorkerRegistry();
        }

        return await this.#trackFilesystemAccess(
            resolveProjectPath(project.rootPath, input.parentRelativePath),
            async () =>
                this.#nativeFsWritesEnabled && this.#nativeFs
                    ? await this.#nativeFs.createProjectEntry({
                          kind: input.kind,
                          name: input.name,
                          parentRelativePath: input.parentRelativePath,
                          projectId: input.projectId,
                          rootPath: project.rootPath,
                          worktreeId: project.worktreeId,
                      })
                    : await this.#worker.createProjectEntry({
                          kind: input.kind,
                          name: input.name,
                          parentRelativePath: input.parentRelativePath,
                          projectId: input.projectId,
                          rootPath: project.rootPath,
                          worktreeId: project.worktreeId,
                      }),
        );
    }

    async copyProjectEntries(
        input: CopyProjectEntriesInput,
    ): Promise<CopyProjectEntriesResult> {
        const project = this.#resolveProjectScope(
            input.projectId,
            input.worktreeId ?? null,
        );
        this.touchProject(input.projectId);
        if (!this.#nativeFsWritesEnabled) {
            await this.#ensureWorkerRegistry();
        }

        const entries = await this.#trackFilesystemAccess(
            resolveProjectPath(
                project.rootPath,
                input.destinationParentRelativePath,
            ),
            async () =>
                this.#nativeFsWritesEnabled && this.#nativeFs
                    ? await this.#nativeFs.copyProjectEntries({
                          destinationParentRelativePath:
                              input.destinationParentRelativePath,
                          projectId: input.projectId,
                          rootPath: project.rootPath,
                          sourceRelativePaths: input.sourceRelativePaths,
                          worktreeId: project.worktreeId,
                      })
                    : await this.#worker.copyProjectEntries({
                          destinationParentRelativePath:
                              input.destinationParentRelativePath,
                          projectId: input.projectId,
                          rootPath: project.rootPath,
                          sourceRelativePaths: input.sourceRelativePaths,
                          worktreeId: project.worktreeId,
                      }),
        );

        return { entries: [...entries] };
    }

    async copyExternalProjectEntries(
        input: CopyExternalProjectEntriesInput,
    ): Promise<CopyExternalProjectEntriesResult> {
        const project = this.#resolveProjectScope(
            input.projectId,
            input.worktreeId ?? null,
        );
        this.touchProject(input.projectId);
        if (!this.#nativeFsWritesEnabled) {
            await this.#ensureWorkerRegistry();
        }

        const entries = await this.#trackFilesystemAccess(
            resolveProjectPath(
                project.rootPath,
                input.destinationParentRelativePath,
            ),
            async () =>
                this.#nativeFsWritesEnabled && this.#nativeFs
                    ? await this.#nativeFs.copyExternalProjectEntries({
                          destinationParentRelativePath:
                              input.destinationParentRelativePath,
                          projectId: input.projectId,
                          rootPath: project.rootPath,
                          sourcePaths: input.sourcePaths,
                          worktreeId: project.worktreeId,
                      })
                    : await this.#worker.copyExternalProjectEntries({
                          destinationParentRelativePath:
                              input.destinationParentRelativePath,
                          projectId: input.projectId,
                          rootPath: project.rootPath,
                          sourcePaths: input.sourcePaths,
                          worktreeId: project.worktreeId,
                      }),
        );

        return { entries: [...entries] };
    }

    async renameProjectEntry(
        input: RenameProjectEntryInput,
    ): Promise<ProjectEntryMutationResult> {
        const project = this.#resolveProjectScope(
            input.projectId,
            input.worktreeId ?? null,
        );
        this.touchProject(input.projectId);
        if (!this.#nativeFsWritesEnabled) {
            await this.#ensureWorkerRegistry();
        }

        return await this.#trackFilesystemAccess(
            resolveProjectPath(project.rootPath, input.relativePath),
            async () =>
                this.#nativeFsWritesEnabled && this.#nativeFs
                    ? await this.#nativeFs.renameProjectEntry({
                          nextName: input.nextName,
                          nextParentRelativePath: input.nextParentRelativePath,
                          projectId: input.projectId,
                          relativePath: input.relativePath,
                          rootPath: project.rootPath,
                          worktreeId: project.worktreeId,
                      })
                    : await this.#worker.renameProjectEntry({
                          nextName: input.nextName,
                          nextParentRelativePath: input.nextParentRelativePath,
                          projectId: input.projectId,
                          relativePath: input.relativePath,
                          rootPath: project.rootPath,
                          worktreeId: project.worktreeId,
                      }),
        );
    }

    async deleteProjectEntry(input: DeleteProjectEntryInput): Promise<void> {
        const project = this.#resolveProjectScope(
            input.projectId,
            input.worktreeId ?? null,
        );
        this.touchProject(input.projectId);
        if (!this.#nativeFsWritesEnabled) {
            await this.#ensureWorkerRegistry();
        }

        await this.#trackFilesystemAccess(
            resolveProjectPath(project.rootPath, input.relativePath),
            async () => {
                if (this.#nativeFsWritesEnabled && this.#nativeFs) {
                    await this.#nativeFs.deleteProjectEntry({
                        projectId: input.projectId,
                        relativePath: input.relativePath,
                        rootPath: project.rootPath,
                        worktreeId: project.worktreeId,
                    });
                    return;
                }

                await this.#worker.deleteProjectEntry({
                    projectId: input.projectId,
                    relativePath: input.relativePath,
                    rootPath: project.rootPath,
                    worktreeId: project.worktreeId,
                });
            },
        );
    }

    async recordProjectEntryMutation(
        projectId: string,
        relativePath: string,
        worktreeId: string | null = null,
    ): Promise<void> {
        const project = this.#resolveProjectScope(projectId, worktreeId);
        this.touchProject(projectId);
        if (this.#nativeFsWritesEnabled && this.#nativeFs) {
            await this.#nativeFs.recordProjectEntryMutation({
                projectId,
                relativePaths: [relativePath],
                rootPath: project.rootPath,
                worktreeId: project.worktreeId,
            });
            return;
        }

        await this.#ensureWorkerRegistry();
        await this.#worker.recordProjectEntryMutation({
            projectId,
            relativePaths: [relativePath],
            rootPath: project.rootPath,
            worktreeId: project.worktreeId,
        });
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

    listProjectWorktrees(
        projectId: string,
    ): readonly ProjectStoreWorktreeRecord[] {
        return [...this.#store.listProjectWorktrees(projectId)];
    }

    async syncProjectWorktrees(
        projectId: string,
        worktrees: readonly {
            readonly branchName: string | null;
            readonly headSha: string | null;
            readonly rootPath: string;
        }[],
    ): Promise<readonly ProjectStoreWorktreeRecord[]> {
        const existingWorktrees = this.listProjectWorktrees(projectId);
        const syncedWorktrees = await this.#store.syncProjectWorktrees(
            projectId,
            worktrees,
        );

        for (const existingWorktree of existingWorktrees) {
            this.#indexedRoots.delete(
                normalizeRootPathKey(existingWorktree.rootPath),
            );
        }
        for (const syncedWorktree of syncedWorktrees) {
            this.#indexedRoots.delete(
                normalizeRootPathKey(syncedWorktree.rootPath),
            );
        }

        this.#markWorkerRegistryDirty();
        this.#markNativeWatcherRegistryDirty();
        await this.#ensureActiveWatcherRegistry();

        return [...syncedWorktrees];
    }

    getWorktreeRootPath(worktreeId: string): string {
        const worktree = this.#store.getProjectWorktree(worktreeId);
        if (!worktree) {
            throw new Error("The requested worktree does not exist anymore.");
        }

        return worktree.rootPath;
    }

    resolveProjectEntryPath(
        projectId: string,
        relativePath: string | null,
        worktreeId: string | null = null,
    ): string {
        const project = this.#resolveProjectScope(projectId, worktreeId);
        return resolveProjectPath(project.rootPath, relativePath);
    }

    async close(): Promise<void> {
        this.#indexedRoots.clear();
        await this.#worker.close().catch(() => undefined);
    }

    handleProjectTreeInvalidation(payload: ProjectTreeInvalidation): void {
        try {
            const project = this.#resolveProjectScope(
                payload.projectId,
                payload.worktreeId ?? null,
            );
            this.#indexedRoots.delete(normalizeRootPathKey(project.rootPath));
        } catch (error) {
            // Watchers can flush after a project or worktree has already been
            // removed. Dropping the stale event prevents downstream refreshes
            // from resolving ids that no longer exist.
            debugBenignError("projects.handleTreeInvalidation", error);
            return;
        }

        this.#onProjectTreeInvalidated(payload);
    }

    handleProjectWorkerRestarted(): void {
        this.#indexedRoots.clear();
        this.#syncedWorkerRegistryVersion = 0;
        this.#pendingWorkerRegistrySync = null;
        void this.#worker
            .refreshAfterRestart()
            .then(() => {
                this.#scheduleWorkerRegistrySync();
            })
            .catch(() => undefined);
    }

    async #trackFilesystemAccess<T>(
        attemptedPath: string,
        operation: () => Promise<T>,
    ): Promise<T> {
        try {
            const result = await operation();
            recordFilesystemAccessSuccess(attemptedPath);
            return result;
        } catch (error) {
            recordFilesystemAccessFailure(attemptedPath, error);
            throw error;
        }
    }

    #getProjectById(projectId: string): {
        readonly canonicalRootPath: string;
        readonly id: string;
        readonly rootPath: string;
    } {
        const project = this.#store.getProject(projectId);
        if (!project) {
            throw new Error("The requested project does not exist anymore.");
        }

        return {
            canonicalRootPath: project.canonicalRootPath,
            id: project.id,
            rootPath: project.rootPath,
        };
    }

    #resolveProjectScope(
        projectId: string,
        worktreeId: string | null,
    ): ResolvedProjectScope {
        const project = this.#getProjectById(projectId);

        if (!worktreeId || worktreeId.endsWith(":primary")) {
            return {
                ...project,
                worktreeId: this.getPrimaryWorktreeId(projectId),
            };
        }

        const worktree = this.#getProjectWorktreeById(worktreeId);
        if (worktree.projectId !== projectId) {
            throw new Error(
                "The requested worktree does not belong to this project.",
            );
        }

        return {
            canonicalRootPath: project.canonicalRootPath,
            id: project.id,
            rootPath: worktree.rootPath,
            worktreeId: worktree.id,
        };
    }

    #getProjectWorktreeById(worktreeId: string): ProjectStoreWorktreeRecord {
        const worktree = this.#store.getProjectWorktree(worktreeId);
        if (!worktree) {
            throw new Error("The requested worktree does not exist anymore.");
        }

        return worktree;
    }

    #markWorkerRegistryDirty(): void {
        this.#workerRegistryVersion += 1;
    }

    #markNativeWatcherRegistryDirty(): void {
        if (!this.#nativeWatchersEnabled) {
            return;
        }

        this.#nativeWatcherRegistryVersion += 1;
    }

    #scheduleActiveWatcherRegistrySync(): void {
        if (this.#nativeWatchersEnabled) {
            void this.#ensureNativeWatcherRegistry().catch(() => undefined);
            return;
        }

        this.#scheduleWorkerRegistrySync();
    }

    async #ensureActiveWatcherRegistry(): Promise<void> {
        if (this.#nativeWatchersEnabled) {
            await this.#ensureNativeWatcherRegistry();
            return;
        }

        await this.#ensureWorkerRegistry();
    }

    #scheduleWorkerRegistrySync(): void {
        void this.#ensureWorkerRegistry().catch(() => undefined);
    }

    async #ensureNativeWatcherRegistry(): Promise<void> {
        if (!this.#nativeWatchersEnabled || !this.#nativeFs) {
            return;
        }

        if (
            this.#syncedNativeWatcherRegistryVersion ===
            this.#nativeWatcherRegistryVersion
        ) {
            return;
        }

        if (this.#pendingNativeWatcherRegistrySync) {
            await this.#pendingNativeWatcherRegistrySync;
            if (
                this.#syncedNativeWatcherRegistryVersion ===
                this.#nativeWatcherRegistryVersion
            ) {
                return;
            }
        }

        const targetVersion = this.#nativeWatcherRegistryVersion;
        const syncPromise = this.#nativeFs
            .watchSyncRegistry()
            .then(() => {
                this.#syncedNativeWatcherRegistryVersion = targetVersion;
            })
            .finally(() => {
                if (this.#pendingNativeWatcherRegistrySync === syncPromise) {
                    this.#pendingNativeWatcherRegistrySync = null;
                }
            });
        this.#pendingNativeWatcherRegistrySync = syncPromise;
        await syncPromise;

        if (
            this.#syncedNativeWatcherRegistryVersion !==
            this.#nativeWatcherRegistryVersion
        ) {
            await this.#ensureNativeWatcherRegistry();
        }
    }

    async #ensureWorkerRegistry(): Promise<void> {
        if (this.#syncedWorkerRegistryVersion === this.#workerRegistryVersion) {
            return;
        }

        if (this.#pendingWorkerRegistrySync) {
            await this.#pendingWorkerRegistrySync;
            if (
                this.#syncedWorkerRegistryVersion ===
                this.#workerRegistryVersion
            ) {
                return;
            }
        }

        const targetVersion = this.#workerRegistryVersion;
        const snapshot = this.#buildWorkerRegistrySnapshot();
        const syncPromise = this.#worker
            .syncRegistry(snapshot)
            .then(() => {
                this.#syncedWorkerRegistryVersion = targetVersion;
            })
            .finally(() => {
                if (this.#pendingWorkerRegistrySync === syncPromise) {
                    this.#pendingWorkerRegistrySync = null;
                }
            });
        this.#pendingWorkerRegistrySync = syncPromise;
        await syncPromise;

        if (this.#syncedWorkerRegistryVersion !== this.#workerRegistryVersion) {
            await this.#ensureWorkerRegistry();
        }
    }

    #buildWorkerRegistrySnapshot(): ProjectRuntimeRegistrySnapshot {
        const projects = this.#store.listProjects().map((project) => ({
            id: project.id,
            rootPath: project.rootPath,
        }));
        const worktrees = projects.flatMap((project) =>
            this.#store.listProjectWorktrees(project.id).map((worktree) => ({
                id: worktree.id,
                isPrimary: worktree.isPrimary,
                projectId: worktree.projectId,
                rootPath: worktree.rootPath,
            })),
        );

        return {
            projects,
            worktrees,
        };
    }
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

export { shouldIgnoreProjectWatchPath };
