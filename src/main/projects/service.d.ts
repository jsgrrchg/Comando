import type Database from "better-sqlite3";
import type { CreateProjectEntryInput, DeleteProjectEntryInput, ProjectEntryMutationResult, ProjectFileDocument, ProjectSummary, ProjectTreeNode, ProjectTreeInvalidation, RenameProjectEntryInput, SearchProjectEntriesInput } from "@shared/ipc";
interface ProjectServiceOptions {
    readonly connection: Database.Database;
    readonly onProjectTreeInvalidated: (payload: ProjectTreeInvalidation) => void;
}
export declare class ProjectService {
    #private;
    constructor(options: ProjectServiceOptions);
    listProjects(): ProjectSummary[];
    addProjectPaths(projectPaths: readonly string[]): ProjectSummary[];
    removeProject(projectId: string): void;
    touchProject(projectId: string): void;
    listProjectTreeChildren(input: {
        readonly projectId: string;
        readonly parentRelativePath: string | null;
    }): Promise<ProjectTreeNode[]>;
    openProjectFile(input: {
        readonly projectId: string;
        readonly relativePath: string;
    }): Promise<ProjectFileDocument>;
    searchProjectEntries(input: SearchProjectEntriesInput): Promise<ProjectTreeNode[]>;
    saveProjectFile(input: {
        readonly projectId: string;
        readonly relativePath: string;
        readonly content: string;
    }): Promise<ProjectFileDocument>;
    createProjectEntry(input: CreateProjectEntryInput): Promise<ProjectEntryMutationResult>;
    renameProjectEntry(input: RenameProjectEntryInput): Promise<ProjectEntryMutationResult>;
    deleteProjectEntry(input: DeleteProjectEntryInput): Promise<void>;
    getProjectRootPath(projectId: string): string;
    resolveProjectEntryPath(projectId: string, relativePath: string | null): string;
    close(): void;
}
export {};
