import type { ProjectEntryKind, ProjectEntryMutationResult, ProjectSummary, ProjectTreeNode } from "@shared/ipc";
type ParentKey = string;
interface ProjectsState {
    readonly activeProjectId: string | null;
    readonly error: string | null;
    readonly expandedDirectories: Record<string, readonly string[]>;
    readonly fullyLoadedTreeProjects: Record<string, boolean>;
    readonly loadingNodeKeys: readonly string[];
    readonly projects: readonly ProjectSummary[];
    readonly treeNodes: Record<string, Record<ParentKey, readonly ProjectTreeNode[]>>;
    addProjectPath: (projectPath: string) => Promise<void>;
    addProjects: () => Promise<void>;
    createEntry: (projectId: string, parentRelativePath: string | null, name: string, kind: ProjectEntryKind) => Promise<ProjectEntryMutationResult>;
    deleteEntry: (projectId: string, relativePath: string) => Promise<void>;
    hydrate: (preferredProjectId?: string | null) => Promise<void>;
    loadEntireProjectTree: (projectId: string) => Promise<void>;
    refreshProjectTree: (projectId: string) => Promise<void>;
    renameEntry: (projectId: string, relativePath: string, nextName: string) => Promise<ProjectEntryMutationResult>;
    removeProject: (projectId: string) => Promise<void>;
    revealEntry: (projectId: string, relativePath: string | null) => Promise<void>;
    setActiveProject: (projectId: string) => Promise<void>;
    toggleDirectory: (projectId: string, node: ProjectTreeNode) => Promise<void>;
}
export declare const useProjectsStore: import("zustand").UseBoundStore<import("zustand").StoreApi<ProjectsState>>;
export {};
