import type { ProjectAppDataSummary, ProjectSummary } from "@shared/ipc";

type Awaitable<T> = T | Promise<T>;

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
    removeProject(projectId: string): Awaitable<void>;
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
