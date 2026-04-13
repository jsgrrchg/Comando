import type { GitStatusBadge, ProjectEntryKind, ProjectEntryMutationResult, ProjectFileDocument, ProjectTreeNode } from "@shared/ipc";
interface GitSnapshot {
    readonly changedPaths: readonly string[];
    readonly exactBadges: ReadonlyMap<string, GitStatusBadge>;
}
export declare function listProjectTreeChildren(options: {
    readonly projectId: string;
    readonly rootPath: string;
    readonly parentRelativePath: string | null;
    readonly gitSnapshot: GitSnapshot;
}): ProjectTreeNode[];
export declare function readProjectFile(options: {
    readonly projectId: string;
    readonly rootPath: string;
    readonly relativePath: string;
    readonly maxBytes?: number;
}): Promise<ProjectFileDocument>;
export declare function writeProjectFile(options: {
    readonly projectId: string;
    readonly rootPath: string;
    readonly relativePath: string;
    readonly content: string;
}): Promise<ProjectFileDocument>;
export declare function createProjectEntry(options: {
    readonly kind: ProjectEntryKind;
    readonly name: string;
    readonly parentRelativePath: string | null;
    readonly rootPath: string;
}): Promise<ProjectEntryMutationResult>;
export declare function renameProjectEntry(options: {
    readonly nextName: string;
    readonly relativePath: string;
    readonly rootPath: string;
}): Promise<ProjectEntryMutationResult>;
export declare function deleteProjectEntry(options: {
    readonly relativePath: string;
    readonly rootPath: string;
}): Promise<void>;
export declare function normalizeRelativePath(relativePath: string): string;
export declare function resolveProjectPath(rootPath: string, relativePath: string | null): string;
export {};
