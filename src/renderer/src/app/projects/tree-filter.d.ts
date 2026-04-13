import type { ProjectTreeNode } from "@shared/ipc";
type ParentKey = string;
export interface FilteredProjectTree {
    readonly expandedDirectories: readonly string[];
    readonly matchCount: number;
    readonly nodesByParent: Record<ParentKey, readonly ProjectTreeNode[]>;
    readonly rootNodes: readonly ProjectTreeNode[];
}
export declare function buildFilteredProjectTree(nodesByParent: Record<ParentKey, readonly ProjectTreeNode[]>, query: string): FilteredProjectTree;
export {};
