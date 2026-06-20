import type { ProjectAppDataSummary, ProjectSummary } from "@shared/ipc";
import type {
    NativeProjectAddResult,
    NativeProjectListResult,
    NativeProjectState,
    NativeProjectSummary,
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

export const NATIVE_PROJECT_REGISTRY_ENABLED_ENV =
    "COMANDO_NATIVE_PROJECT_REGISTRY";
export const NATIVE_PROJECT_REGISTRY_MODE_ENV =
    "COMANDO_NATIVE_PROJECT_REGISTRY_MODE";

export type NativeProjectRegistryMode = "shadow" | "write";
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
}

export async function createNativeProjectRegistryStore(options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly legacyStore: ProjectStore;
    readonly nativeClient: NativeBackendRequester | null;
    readonly onDiagnostic?: NativeProjectRegistryDiagnostic;
}): Promise<ProjectStore> {
    const mode = resolveNativeProjectRegistryMode(options.env);
    if (!mode || !options.nativeClient) {
        return options.legacyStore;
    }

    const gateway = new NativeProjectRegistryGateway(options.nativeClient);
    if (mode === "write") {
        const state = nativeProjectStateToStoreSnapshot(
            await gateway.listProjects(),
        );
        options.onDiagnostic?.(
            `[native-projects] write mode active projects=${state.projects.length} worktrees=${state.worktrees.length}.`,
        );
        return new NativeWriteProjectStore(options.legacyStore, gateway, state);
    }

    const store = new NativeShadowProjectStore(
        options.legacyStore,
        gateway,
        options.onDiagnostic,
    );
    void store.checkParity("startup");
    return store;
}

export function isNativeProjectRegistryEnabled(
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    return env[NATIVE_PROJECT_REGISTRY_ENABLED_ENV] === "1";
}

export function resolveNativeProjectRegistryMode(
    env: NodeJS.ProcessEnv = process.env,
): NativeProjectRegistryMode | null {
    if (!isNativeProjectRegistryEnabled(env)) {
        return null;
    }

    return env[NATIVE_PROJECT_REGISTRY_MODE_ENV] === "write"
        ? "write"
        : "shadow";
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

export function compareProjectRegistryStates(
    nativeState: ProjectStoreStateSnapshot,
    legacyState: ProjectStoreStateSnapshot,
): ProjectRegistryParityReport {
    const nativeProjectIds = nativeState.projects.map((project) => project.id);
    const legacyProjectIds = legacyState.projects.map((project) => project.id);
    const nativeWorktreeIds = nativeState.worktrees.map((worktree) => worktree.id);
    const legacyWorktreeIds = legacyState.worktrees.map((worktree) => worktree.id);
    const nativeProjectsById = new Map(
        nativeState.projects.map((project) => [project.id, project]),
    );
    const legacyProjectsById = new Map(
        legacyState.projects.map((project) => [project.id, project]),
    );
    const nativeWorktreesById = new Map(
        nativeState.worktrees.map((worktree) => [worktree.id, worktree]),
    );
    const legacyWorktreesById = new Map(
        legacyState.worktrees.map((worktree) => [worktree.id, worktree]),
    );
    const missingNativeProjectIds = difference(legacyProjectIds, nativeProjectIds);
    const extraNativeProjectIds = difference(nativeProjectIds, legacyProjectIds);
    const missingNativeWorktreeIds = difference(
        legacyWorktreeIds,
        nativeWorktreeIds,
    );
    const extraNativeWorktreeIds = difference(
        nativeWorktreeIds,
        legacyWorktreeIds,
    );
    const mismatchedProjectIds = intersection(nativeProjectIds, legacyProjectIds)
        .filter((projectId) => {
            const nativeProject = nativeProjectsById.get(projectId);
            const legacyProject = legacyProjectsById.get(projectId);
            return (
                nativeProject &&
                legacyProject &&
                !sameProjectRecord(nativeProject, legacyProject)
            );
        });
    const mismatchedWorktreeIds = intersection(nativeWorktreeIds, legacyWorktreeIds)
        .filter((worktreeId) => {
            const nativeWorktree = nativeWorktreesById.get(worktreeId);
            const legacyWorktree = legacyWorktreesById.get(worktreeId);
            return (
                nativeWorktree &&
                legacyWorktree &&
                !sameWorktreeRecord(nativeWorktree, legacyWorktree)
            );
        });
    const equal =
        missingNativeProjectIds.length === 0 &&
        extraNativeProjectIds.length === 0 &&
        missingNativeWorktreeIds.length === 0 &&
        extraNativeWorktreeIds.length === 0 &&
        mismatchedProjectIds.length === 0 &&
        mismatchedWorktreeIds.length === 0;

    return {
        equal,
        extraNativeProjectIds,
        extraNativeWorktreeIds,
        legacyProjectCount: legacyState.projects.length,
        legacyWorktreeCount: legacyState.worktrees.length,
        mismatchedProjectIds,
        mismatchedWorktreeIds,
        missingNativeProjectIds,
        missingNativeWorktreeIds,
        nativeProjectCount: nativeState.projects.length,
        nativeWorktreeCount: nativeState.worktrees.length,
    };
}

export interface ProjectRegistryParityReport {
    readonly equal: boolean;
    readonly extraNativeProjectIds: readonly string[];
    readonly extraNativeWorktreeIds: readonly string[];
    readonly legacyProjectCount: number;
    readonly legacyWorktreeCount: number;
    readonly mismatchedProjectIds: readonly string[];
    readonly mismatchedWorktreeIds: readonly string[];
    readonly missingNativeProjectIds: readonly string[];
    readonly missingNativeWorktreeIds: readonly string[];
    readonly nativeProjectCount: number;
    readonly nativeWorktreeCount: number;
}

class NativeShadowProjectStore implements ProjectStore {
    readonly #gateway: NativeProjectRegistryGateway;
    readonly #legacy: ProjectStore;
    readonly #onDiagnostic?: NativeProjectRegistryDiagnostic;

    constructor(
        legacy: ProjectStore,
        gateway: NativeProjectRegistryGateway,
        onDiagnostic?: NativeProjectRegistryDiagnostic,
    ) {
        this.#gateway = gateway;
        this.#legacy = legacy;
        this.#onDiagnostic = onDiagnostic;
    }

    loadState(): ProjectStoreStateSnapshot {
        return this.#legacy.loadState();
    }

    async checkParity(reason: string): Promise<void> {
        try {
            const nativeState = nativeProjectStateToStoreSnapshot(
                await this.#gateway.listProjects(),
            );
            const report = compareProjectRegistryStates(
                nativeState,
                this.#legacy.loadState(),
            );
            this.#onDiagnostic?.(formatParityReport(reason, report));
        } catch (error) {
            this.#onDiagnostic?.(
                `[native-projects] shadow parity ${reason} failed: ${formatError(error)}`,
            );
        }
    }

    async addProjectPaths(
        projectPaths: readonly string[],
    ): Promise<ProjectStoreAddPathsResult> {
        const result = await this.#legacy.addProjectPaths(projectPaths);
        await this.checkParity("after-add");
        return result;
    }

    async clearProjectAppData(
        projectId: string,
    ): Promise<ProjectAppDataSummary> {
        const result = await this.#legacy.clearProjectAppData(projectId);
        await this.checkParity("after-clear-app-data");
        return result;
    }

    getProject(projectId: string): ProjectRecord | null {
        return this.#legacy.getProject(projectId);
    }

    async getProjectAppDataSummary(
        projectId: string,
    ): Promise<ProjectAppDataSummary> {
        return await this.#legacy.getProjectAppDataSummary(projectId);
    }

    getProjectWorktree(worktreeId: string): ProjectStoreWorktreeRecord | null {
        return this.#legacy.getProjectWorktree(worktreeId);
    }

    listProjects(): readonly ProjectSummary[] {
        return this.#legacy.listProjects();
    }

    listProjectWorktrees(
        projectId: string,
    ): readonly ProjectStoreWorktreeRecord[] {
        return this.#legacy.listProjectWorktrees(projectId);
    }

    removeProject(projectId: string): void {
        this.#legacy.removeProject(projectId);
        void this.checkParity("after-remove");
    }

    async relocateProject(
        projectId: string,
        projectPath: string,
    ): Promise<ProjectSummary> {
        const result = await this.#legacy.relocateProject(projectId, projectPath);
        await this.checkParity("after-relocate");
        return result;
    }

    async syncProjectWorktrees(
        projectId: string,
        worktrees: readonly {
            readonly branchName: string | null;
            readonly headSha: string | null;
            readonly rootPath: string;
        }[],
    ): Promise<readonly ProjectStoreWorktreeRecord[]> {
        const result = await this.#legacy.syncProjectWorktrees(
            projectId,
            worktrees,
        );
        await this.checkParity("after-sync-worktrees");
        return result;
    }

    touchProject(projectId: string): void {
        this.#legacy.touchProject(projectId);
    }
}

class NativeWriteProjectStore implements ProjectStore {
    readonly #cache = new ProjectStateCache();
    readonly #gateway: NativeProjectRegistryGateway;
    readonly #legacy: ProjectStore;

    constructor(
        legacy: ProjectStore,
        gateway: NativeProjectRegistryGateway,
        initialState: ProjectStoreStateSnapshot,
    ) {
        this.#gateway = gateway;
        this.#legacy = legacy;
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
        const summary = await this.#legacy.clearProjectAppData(projectId);
        await this.#refresh();
        return summary;
    }

    getProject(projectId: string): ProjectRecord | null {
        return this.#cache.getProject(projectId);
    }

    async getProjectAppDataSummary(
        projectId: string,
    ): Promise<ProjectAppDataSummary> {
        return await this.#legacy.getProjectAppDataSummary(projectId);
    }

    getProjectWorktree(worktreeId: string): ProjectStoreWorktreeRecord | null {
        return this.#cache.getProjectWorktree(worktreeId);
    }

    listProjectWorktrees(
        projectId: string,
    ): readonly ProjectStoreWorktreeRecord[] {
        return this.#cache.listProjectWorktrees(projectId);
    }

    removeProject(projectId: string): void {
        this.#cache.removeProject(projectId);
        this.#legacy.removeProject(projectId);
    }

    async relocateProject(
        projectId: string,
        projectPath: string,
    ): Promise<ProjectSummary> {
        const project = await this.#legacy.relocateProject(projectId, projectPath);
        await this.#refresh();
        return project;
    }

    async syncProjectWorktrees(
        projectId: string,
        worktrees: readonly {
            readonly branchName: string | null;
            readonly headSha: string | null;
            readonly rootPath: string;
        }[],
    ): Promise<readonly ProjectStoreWorktreeRecord[]> {
        const synced = await this.#legacy.syncProjectWorktrees(
            projectId,
            worktrees,
        );
        await this.#refresh();
        return synced;
    }

    touchProject(projectId: string): void {
        this.#cache.touchProject(projectId);
        this.#legacy.touchProject(projectId);
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

function sameProjectRecord(
    nativeProject: ProjectStoreProjectRecord,
    legacyProject: ProjectStoreProjectRecord,
): boolean {
    return (
        nativeProject.name === legacyProject.name &&
        nativeProject.rootPath === legacyProject.rootPath &&
        nativeProject.canonicalRootPath === legacyProject.canonicalRootPath &&
        nativeProject.lastOpenedAt === legacyProject.lastOpenedAt
    );
}

function sameWorktreeRecord(
    nativeWorktree: ProjectStoreWorktreeRecord,
    legacyWorktree: ProjectStoreWorktreeRecord,
): boolean {
    return (
        nativeWorktree.projectId === legacyWorktree.projectId &&
        nativeWorktree.rootPath === legacyWorktree.rootPath &&
        nativeWorktree.branchName === legacyWorktree.branchName &&
        nativeWorktree.headSha === legacyWorktree.headSha &&
        nativeWorktree.isPrimary === legacyWorktree.isPrimary
    );
}

function formatParityReport(
    reason: string,
    report: ProjectRegistryParityReport,
): string {
    if (report.equal) {
        return `[native-projects] shadow parity ${reason} ok projects=${report.nativeProjectCount} worktrees=${report.nativeWorktreeCount}.`;
    }

    return [
        `[native-projects] shadow parity ${reason} mismatch`,
        `nativeProjects=${report.nativeProjectCount}`,
        `legacyProjects=${report.legacyProjectCount}`,
        `nativeWorktrees=${report.nativeWorktreeCount}`,
        `legacyWorktrees=${report.legacyWorktreeCount}`,
        `missingProjectIds=${report.missingNativeProjectIds.join(",") || "-"}`,
        `extraProjectIds=${report.extraNativeProjectIds.join(",") || "-"}`,
        `mismatchedProjectIds=${report.mismatchedProjectIds.join(",") || "-"}`,
        `missingWorktreeIds=${report.missingNativeWorktreeIds.join(",") || "-"}`,
        `extraWorktreeIds=${report.extraNativeWorktreeIds.join(",") || "-"}`,
        `mismatchedWorktreeIds=${report.mismatchedWorktreeIds.join(",") || "-"}`,
    ].join(" ");
}

function difference(left: readonly string[], right: readonly string[]): string[] {
    const rightSet = new Set(right);
    return left.filter((value) => !rightSet.has(value));
}

function intersection(left: readonly string[], right: readonly string[]): string[] {
    const rightSet = new Set(right);
    return left.filter((value) => rightSet.has(value));
}

function parseStringArray(value: unknown, fieldName: string): readonly string[] {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        throw new Error(`Native project field ${fieldName} must be string[].`);
    }
    return value;
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

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
