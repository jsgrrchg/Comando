import type { ProjectAppDataSummary, ProjectSummary } from "@shared/ipc";
import type {
    NativeProjectAppDataSummary,
    NativeProjectAddResult,
    NativeProjectClearAppDataResult,
    NativeProjectListResult,
    NativeProjectMutationResult,
    NativeProjectRelocateResult,
    NativeProjectState,
    NativeProjectSummary,
    NativeProjectSyncWorktree,
    NativeWorktreeSummary,
} from "@shared/native-backend";

import type {
    ProjectRecord,
    ProjectStore,
    ProjectStoreAddPathsResult,
    ProjectStoreProjectRecord,
    ProjectStoreStateSnapshot,
    ProjectStoreWorktreeRecord,
} from "../projects/store";
import type { NativeBackendRequester } from "./persistence";

export type NativeProjectRegistryDiagnostic = (message: string) => void;

export class NativeProjectRegistryGateway {
    readonly #client: NativeBackendRequester;

    constructor(client: NativeBackendRequester) {
        this.#client = client;
    }

    async listProjects(): Promise<NativeProjectListResult> {
        return parseNativeProjectListResult(
            await this.#client.request("project_list"),
        );
    }

    async addProjectPaths(
        projectPaths: readonly string[],
    ): Promise<NativeProjectAddResult> {
        return parseNativeProjectAddResult(
            await this.#client.request("project_add", {
                ownerWindowId: null,
                projectPaths: [...projectPaths],
            }),
        );
    }

    async syncProjectWorktrees(
        projectId: string,
        worktrees: readonly NativeProjectSyncWorktree[],
    ): Promise<readonly NativeWorktreeSummary[]> {
        return parseWorktreeArray(
            await this.#client.request("project_sync_worktrees", {
                projectId,
                worktrees: [...worktrees],
            }),
            "project_sync_worktrees",
        );
    }

    async removeProject(projectId: string): Promise<NativeProjectMutationResult> {
        return parseNativeProjectMutationResult(
            await this.#client.request("project_remove", {
                projectId,
            }),
        );
    }

    async touchProject(projectId: string): Promise<NativeProjectMutationResult> {
        return parseNativeProjectMutationResult(
            await this.#client.request("project_touch", {
                projectId,
            }),
        );
    }

    async relocateProject(
        projectId: string,
        projectPath: string,
    ): Promise<NativeProjectRelocateResult> {
        return parseNativeProjectRelocateResult(
            await this.#client.request("project_relocate", {
                projectId,
                projectPath,
            }),
        );
    }

    async getProjectAppDataSummary(
        projectId: string,
    ): Promise<NativeProjectAppDataSummary> {
        return parseNativeProjectAppDataSummary(
            await this.#client.request("project_get_app_data_summary", {
                projectId,
            }),
        );
    }

    async clearProjectAppData(
        projectId: string,
    ): Promise<NativeProjectClearAppDataResult> {
        return parseNativeProjectClearAppDataResult(
            await this.#client.request("project_clear_app_data", {
                projectId,
            }),
        );
    }
}

export async function createNativeProjectRegistryStore(options: {
    readonly nativeClient: NativeBackendRequester;
    readonly onDiagnostic?: NativeProjectRegistryDiagnostic;
}): Promise<ProjectStore> {
    const gateway = new NativeProjectRegistryGateway(options.nativeClient);
    const state = nativeProjectStateToStoreSnapshot(
        await gateway.listProjects(),
    );
    options.onDiagnostic?.(
        `[native-projects] active projects=${state.projects.length} worktrees=${state.worktrees.length}.`,
    );
    return new NativeWriteProjectStore(gateway, state);
}

export function nativeProjectStateToStoreSnapshot(
    state: NativeProjectState,
): ProjectStoreStateSnapshot {
    return {
        projects: state.projects.map(nativeProjectSummaryToStoreProject),
        worktrees: state.worktrees.map(nativeWorktreeSummaryToStoreWorktree),
    };
}

export function nativeProjectAddResultToStoreResult(
    result: NativeProjectAddResult,
): ProjectStoreAddPathsResult {
    return {
        projects: result.projects.map(nativeProjectSummaryToIpcProject),
        touchedProjectIds: [...result.projectIdsToOpen],
        touchedRootPaths: [...result.touchedRootPaths],
    };
}

class NativeWriteProjectStore implements ProjectStore {
    readonly #cache = new ProjectStateCache();
    readonly #gateway: NativeProjectRegistryGateway;

    constructor(
        gateway: NativeProjectRegistryGateway,
        initialState: ProjectStoreStateSnapshot,
    ) {
        this.#gateway = gateway;
        this.#cache.hydrate(initialState);
    }

    loadState(): ProjectStoreStateSnapshot {
        return this.#cache.loadState();
    }

    listProjects(): readonly ProjectSummary[] {
        return this.#cache.listProjects();
    }

    async addProjectPaths(
        projectPaths: readonly string[],
    ): Promise<ProjectStoreAddPathsResult> {
        const nativeResult = await this.#gateway.addProjectPaths(projectPaths);
        this.#cache.hydrate(
            nativeProjectStateToStoreSnapshot(nativeResult.state),
        );
        return nativeProjectAddResultToStoreResult(nativeResult);
    }

    async clearProjectAppData(
        projectId: string,
    ): Promise<ProjectAppDataSummary> {
        const result = await this.#gateway.clearProjectAppData(projectId);
        this.#cache.hydrate(nativeProjectStateToStoreSnapshot(result.state));
        return nativeProjectAppDataSummaryToIpc(result.cleared);
    }

    getProject(projectId: string): ProjectRecord | null {
        return this.#cache.getProject(projectId);
    }

    async getProjectAppDataSummary(
        projectId: string,
    ): Promise<ProjectAppDataSummary> {
        return nativeProjectAppDataSummaryToIpc(
            await this.#gateway.getProjectAppDataSummary(projectId),
        );
    }

    getProjectWorktree(worktreeId: string): ProjectStoreWorktreeRecord | null {
        return this.#cache.getProjectWorktree(worktreeId);
    }

    listProjectWorktrees(
        projectId: string,
    ): readonly ProjectStoreWorktreeRecord[] {
        return this.#cache.listProjectWorktrees(projectId);
    }

    async removeProject(projectId: string): Promise<void> {
        const result = await this.#gateway.removeProject(projectId);
        this.#cache.hydrate(nativeProjectStateToStoreSnapshot(result.state));
    }

    async relocateProject(
        projectId: string,
        projectPath: string,
    ): Promise<ProjectSummary> {
        const result = await this.#gateway.relocateProject(projectId, projectPath);
        this.#cache.hydrate(nativeProjectStateToStoreSnapshot(result.state));
        return nativeProjectSummaryToIpcProject(result.project);
    }

    async syncProjectWorktrees(
        projectId: string,
        worktrees: readonly {
            readonly branchName: string | null;
            readonly headSha: string | null;
            readonly rootPath: string;
        }[],
    ): Promise<readonly ProjectStoreWorktreeRecord[]> {
        const nativeWorktrees = await this.#gateway.syncProjectWorktrees(
            projectId,
            worktrees,
        );
        const synced = nativeWorktrees.map(nativeWorktreeSummaryToStoreWorktree);
        await this.#refresh();
        this.#cache.replaceProjectWorktrees(projectId, synced);
        return synced;
    }

    touchProject(projectId: string): void {
        this.#cache.touchProject(projectId);
        void this.#gateway
            .touchProject(projectId)
            .then((result) => {
                this.#cache.hydrate(
                    nativeProjectStateToStoreSnapshot(result.state),
                );
            })
            .catch(() => undefined);
    }

    async #refresh(): Promise<void> {
        this.#cache.hydrate(
            nativeProjectStateToStoreSnapshot(await this.#gateway.listProjects()),
        );
    }
}

class ProjectStateCache {
    readonly #projectsById = new Map<string, ProjectStoreProjectRecord>();
    readonly #worktreeIdsByProjectId = new Map<string, readonly string[]>();
    readonly #worktreesById = new Map<string, ProjectStoreWorktreeRecord>();
    #projectOrder: readonly string[] = [];

    hydrate(snapshot: ProjectStoreStateSnapshot): void {
        this.#projectsById.clear();
        this.#worktreeIdsByProjectId.clear();
        this.#worktreesById.clear();

        for (const project of snapshot.projects) {
            this.#projectsById.set(project.id, project);
        }
        this.#projectOrder = snapshot.projects.map((project) => project.id);

        for (const worktree of snapshot.worktrees) {
            this.#worktreesById.set(worktree.id, worktree);
            this.#worktreeIdsByProjectId.set(worktree.projectId, [
                ...(this.#worktreeIdsByProjectId.get(worktree.projectId) ?? []),
                worktree.id,
            ]);
        }
    }

    loadState(): ProjectStoreStateSnapshot {
        return {
            projects: this.listProjects(),
            worktrees: [...this.#worktreesById.values()],
        };
    }

    listProjects(): readonly ProjectStoreProjectRecord[] {
        return this.#projectOrder.flatMap((projectId) => {
            const project = this.#projectsById.get(projectId);
            return project ? [project] : [];
        });
    }

    getProject(projectId: string): ProjectRecord | null {
        const project = this.#projectsById.get(projectId);
        return project
            ? {
                  canonicalRootPath: project.canonicalRootPath,
                  id: project.id,
                  rootPath: project.rootPath,
              }
            : null;
    }

    getProjectWorktree(worktreeId: string): ProjectStoreWorktreeRecord | null {
        return this.#worktreesById.get(worktreeId) ?? null;
    }

    listProjectWorktrees(
        projectId: string,
    ): readonly ProjectStoreWorktreeRecord[] {
        return (this.#worktreeIdsByProjectId.get(projectId) ?? []).flatMap(
            (worktreeId) => {
                const worktree = this.#worktreesById.get(worktreeId);
                return worktree ? [worktree] : [];
            },
        );
    }

    replaceProjectWorktrees(
        projectId: string,
        worktrees: readonly ProjectStoreWorktreeRecord[],
    ): void {
        for (const worktreeId of this.#worktreeIdsByProjectId.get(projectId) ??
            []) {
            this.#worktreesById.delete(worktreeId);
        }

        this.#worktreeIdsByProjectId.set(
            projectId,
            worktrees.map((worktree) => worktree.id),
        );
        for (const worktree of worktrees) {
            this.#worktreesById.set(worktree.id, worktree);
        }
    }

    removeProject(projectId: string): void {
        this.#projectsById.delete(projectId);
        this.#projectOrder = this.#projectOrder.filter(
            (candidate) => candidate !== projectId,
        );
        for (const worktreeId of this.#worktreeIdsByProjectId.get(projectId) ??
            []) {
            this.#worktreesById.delete(worktreeId);
        }
        this.#worktreeIdsByProjectId.delete(projectId);
    }

    touchProject(projectId: string): void {
        const project = this.#projectsById.get(projectId);
        if (!project) {
            return;
        }

        const now = new Date().toISOString();
        this.#projectsById.set(projectId, {
            ...project,
            lastOpenedAt: now,
            updatedAt: now,
        });
        this.#projectOrder = this.#sortProjectOrder();
    }

    #sortProjectOrder(): readonly string[] {
        return [...this.#projectsById.values()]
            .sort(
                (left, right) =>
                    Number(left.lastOpenedAt === null) -
                        Number(right.lastOpenedAt === null) ||
                    (right.lastOpenedAt ?? "").localeCompare(
                        left.lastOpenedAt ?? "",
                    ) ||
                    left.name.localeCompare(right.name, undefined, {
                        sensitivity: "base",
                    }),
            )
            .map((project) => project.id);
    }
}

function nativeProjectSummaryToStoreProject(
    project: NativeProjectSummary,
): ProjectStoreProjectRecord {
    const canonicalRootPath = project.canonicalRootPath ?? project.rootPath;
    return {
        canonicalRootPath,
        createdAt: project.createdAt,
        id: project.id,
        lastOpenedAt: project.lastOpenedAt,
        name: project.name,
        rootPath: project.rootPath,
        updatedAt: project.updatedAt,
    };
}

function nativeProjectSummaryToIpcProject(
    project: NativeProjectSummary,
): ProjectSummary {
    return {
        createdAt: project.createdAt,
        id: project.id,
        lastOpenedAt: project.lastOpenedAt,
        name: project.name,
        rootPath: project.rootPath,
        updatedAt: project.updatedAt,
    };
}

function nativeWorktreeSummaryToStoreWorktree(
    worktree: NativeWorktreeSummary,
): ProjectStoreWorktreeRecord {
    return {
        branchName: worktree.branchName,
        headSha: worktree.headSha,
        id: worktree.id,
        isPrimary: worktree.isPrimary,
        projectId: worktree.projectId,
        rootPath: worktree.rootPath,
        updatedAt: worktree.updatedAt,
    };
}

function nativeProjectAppDataSummaryToIpc(
    summary: NativeProjectAppDataSummary,
): ProjectAppDataSummary {
    return {
        chatSessionCount: summary.chatSessionCount,
        projectSettingsCount: summary.projectSettingsCount,
        recentProjectCount: summary.recentProjectCount,
        workspaceLayoutCount: summary.workspaceLayoutCount,
        workspaceSessionCount: summary.workspaceSessionCount,
        workspaceTabCount: summary.workspaceTabCount,
    };
}

function parseNativeProjectListResult(value: unknown): NativeProjectListResult {
    const state = parseNativeProjectState(value, "Native project list result");
    return {
        projects: state.projects,
        worktrees: state.worktrees,
    };
}

function parseNativeProjectAddResult(value: unknown): NativeProjectAddResult {
    const record = requireRecord(value, "Native project add result");
    const state = parseNativeProjectState(record.state, "Native project state");
    return {
        projectIdsToOpen: parseStringArray(
            record.projectIdsToOpen,
            "projectIdsToOpen",
        ),
        projects: parseProjectArray(record.projects, "projects"),
        state,
        touchedRootPaths: parseStringArray(
            record.touchedRootPaths,
            "touchedRootPaths",
        ),
    };
}

function parseNativeProjectMutationResult(
    value: unknown,
): NativeProjectMutationResult {
    const record = requireRecord(value, "Native project mutation result");
    return {
        state: parseNativeProjectState(record.state, "Native project state"),
    };
}

function parseNativeProjectRelocateResult(
    value: unknown,
): NativeProjectRelocateResult {
    const record = requireRecord(value, "Native project relocate result");
    return {
        project: parseProjectSummary(record.project),
        state: parseNativeProjectState(record.state, "Native project state"),
        touchedRootPaths: parseStringArray(
            record.touchedRootPaths,
            "touchedRootPaths",
        ),
    };
}

function parseNativeProjectAppDataSummary(
    value: unknown,
): NativeProjectAppDataSummary {
    const record = requireRecord(value, "Native project app data summary");
    return {
        chatSessionCount: requireNumber(
            record.chatSessionCount,
            "chatSessionCount",
        ),
        projectSettingsCount: requireNumber(
            record.projectSettingsCount,
            "projectSettingsCount",
        ),
        recentProjectCount: requireNumber(
            record.recentProjectCount,
            "recentProjectCount",
        ),
        workspaceLayoutCount: requireNumber(
            record.workspaceLayoutCount,
            "workspaceLayoutCount",
        ),
        workspaceSessionCount: requireNumber(
            record.workspaceSessionCount,
            "workspaceSessionCount",
        ),
        workspaceTabCount: requireNumber(
            record.workspaceTabCount,
            "workspaceTabCount",
        ),
    };
}

function parseNativeProjectClearAppDataResult(
    value: unknown,
): NativeProjectClearAppDataResult {
    const record = requireRecord(value, "Native project clear app data result");
    return {
        cleared: parseNativeProjectAppDataSummary(record.cleared),
        state: parseNativeProjectState(record.state, "Native project state"),
    };
}

function parseNativeProjectState(
    value: unknown,
    label: string,
): NativeProjectState {
    const record = requireRecord(value, label);
    return {
        projects: parseProjectArray(record.projects, "projects"),
        worktrees: parseWorktreeArray(record.worktrees, "worktrees"),
    };
}

function parseProjectArray(
    value: unknown,
    fieldName: string,
): readonly NativeProjectSummary[] {
    if (!Array.isArray(value)) {
        throw new Error(`Native project field ${fieldName} must be an array.`);
    }
    return value.map(parseProjectSummary);
}

function parseWorktreeArray(
    value: unknown,
    fieldName: string,
): readonly NativeWorktreeSummary[] {
    if (!Array.isArray(value)) {
        throw new Error(`Native project field ${fieldName} must be an array.`);
    }
    return value.map(parseWorktreeSummary);
}

function parseProjectSummary(value: unknown): NativeProjectSummary {
    const record = requireRecord(value, "Native project summary");
    return {
        canonicalRootPath: requireNullableString(
            record.canonicalRootPath,
            "canonicalRootPath",
        ),
        createdAt: requireString(record.createdAt, "createdAt"),
        id: requireString(record.id, "id"),
        lastOpenedAt: requireNullableString(
            record.lastOpenedAt,
            "lastOpenedAt",
        ),
        name: requireString(record.name, "name"),
        rootPath: requireString(record.rootPath, "rootPath"),
        updatedAt: requireString(record.updatedAt, "updatedAt"),
    };
}

function parseWorktreeSummary(value: unknown): NativeWorktreeSummary {
    const record = requireRecord(value, "Native worktree summary");
    return {
        branchName: requireNullableString(record.branchName, "branchName"),
        headSha: requireNullableString(record.headSha, "headSha"),
        id: requireString(record.id, "id"),
        isPrimary: requireBoolean(record.isPrimary, "isPrimary"),
        projectId: requireString(record.projectId, "projectId"),
        rootPath: requireString(record.rootPath, "rootPath"),
        updatedAt: requireString(record.updatedAt, "updatedAt"),
    };
}

function parseStringArray(value: unknown, fieldName: string): readonly string[] {
    if (!Array.isArray(value)) {
        throw new Error(`Native project field ${fieldName} must be string[].`);
    }

    return value.map((item: unknown) => {
        if (typeof item !== "string") {
            throw new Error(`Native project field ${fieldName} must be string[].`);
        }

        return item;
    });
}

function requireRecord(
    value: unknown,
    label: string,
): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${label} must be an object.`);
    }
    return value as Record<string, unknown>;
}

function requireBoolean(value: unknown, fieldName: string): boolean {
    if (typeof value !== "boolean") {
        throw new Error(`Native project field ${fieldName} must be a boolean.`);
    }
    return value;
}

function requireNumber(value: unknown, fieldName: string): number {
    if (typeof value !== "number") {
        throw new Error(`Native project field ${fieldName} must be a number.`);
    }
    return value;
}

function requireNullableString(
    value: unknown,
    fieldName: string,
): string | null {
    if (value === null) {
        return null;
    }
    return requireString(value, fieldName);
}

function requireString(value: unknown, fieldName: string): string {
    if (typeof value !== "string") {
        throw new Error(`Native project field ${fieldName} must be a string.`);
    }
    return value;
}
