import type {
    CreateProjectEntryInput,
    ProjectEntryMutationResult,
    ProjectFileDocument,
    ProjectTreeInvalidation,
    ProjectTreeNode,
} from "@shared/ipc";

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
    readonly includeAncestorDirectories?: boolean;
    readonly limit?: number;
    readonly query: string;
    readonly searchContext?: string | null;
}

export type ProjectRuntimeListEntriesInput = ProjectRuntimeScopeInput;

export interface ProjectRuntimeSearchResponse {
    readonly entries: readonly ProjectTreeNode[];
    readonly truncated?: boolean;
}

export interface ProjectRuntimeGateway {
    syncRegistry(snapshot: ProjectRuntimeRegistrySnapshot): Promise<void> | void;
    listProjectTreeChildren(
        input: ProjectRuntimeTreeInput,
    ): Promise<readonly ProjectTreeNode[]> | readonly ProjectTreeNode[];
    listProjectEntries(
        input: ProjectRuntimeListEntriesInput,
    ): Promise<ProjectRuntimeSearchResponse>;
    openProjectFile(
        input: ProjectRuntimeOpenFileInput,
    ): Promise<ProjectFileDocument>;
    saveProjectFile(
        input: ProjectRuntimeSaveFileInput,
    ): Promise<ProjectFileDocument>;
    createProjectEntry(
        input: ProjectRuntimeCreateEntryInput,
    ): Promise<ProjectEntryMutationResult>;
    copyProjectEntries(
        input: ProjectRuntimeCopyEntriesInput,
    ): Promise<readonly ProjectEntryMutationResult[]>;
    copyExternalProjectEntries(
        input: ProjectRuntimeCopyExternalEntriesInput,
    ): Promise<readonly ProjectEntryMutationResult[]>;
    renameProjectEntry(
        input: ProjectRuntimeRenameEntryInput,
    ): Promise<ProjectEntryMutationResult>;
    deleteProjectEntry(input: ProjectRuntimeDeleteEntryInput): Promise<void>;
    recordProjectEntryMutation(
        input: ProjectRuntimeEntryMutationInput,
    ): Promise<void> | void;
    searchProjectEntries(
        input: ProjectRuntimeSearchInput,
    ): Promise<ProjectRuntimeSearchResponse>;
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

export function shouldIgnoreProjectWatchPath(
    relativePath: string | Buffer | null,
): boolean {
    const normalizedPath = normalizeProjectWatchRelativePath(relativePath);
    if (normalizedPath === null) {
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

function normalizeProjectWatchRelativePath(
    relativePath: string | Buffer | null,
): string | null {
    if (relativePath === null) {
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

    return normalizedPath.split("/").filter(Boolean).join("/");
}
