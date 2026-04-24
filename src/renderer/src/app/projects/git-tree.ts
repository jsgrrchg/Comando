import type { GitStatusBadge, ProjectTreeNode } from "@shared/ipc";

import type { GitNodeStatus, GitTreeNode } from "@renderer/components/git";

const ROOT_NODE_KEY = "__root__";

type ParentKey = string;

export function buildGitTreeNodesFromProjectTree(
    rootNodes: readonly ProjectTreeNode[],
    nodesByParent: Record<ParentKey, readonly ProjectTreeNode[]>,
    expandedPaths: readonly string[] = [],
): readonly GitTreeNode[] {
    const expandedPathSet = new Set(expandedPaths);

    return rootNodes.map((node) =>
        convertProjectTreeNode(node, nodesByParent, expandedPathSet),
    );
}

interface HierarchicalBuildNode {
    readonly id: string;
    readonly kind: "directory" | "file";
    readonly name: string;
    readonly path: string;
    readonly status: GitNodeStatus | null;
    readonly hasChildren: boolean;
    children?: HierarchicalBuildNode[];
}

export interface HierarchicalGitTreeFromEntries {
    readonly expandedDirectoryPaths: readonly string[];
    readonly nodes: readonly GitTreeNode[];
}

export function buildHierarchicalGitTreeNodesFromProjectEntries(
    entries: readonly ProjectTreeNode[],
): HierarchicalGitTreeFromEntries {
    const byPath = new Map<string, HierarchicalBuildNode>();

    const ensureDirectory = (path: string): HierarchicalBuildNode => {
        const existing = byPath.get(path);
        if (existing) {
            if (existing.kind === "directory" && !existing.children) {
                existing.children = [];
            }
            return existing;
        }

        const name = path.split("/").at(-1) ?? path;
        const synthetic: HierarchicalBuildNode = {
            children: [],
            hasChildren: true,
            id: `project-search-dir:${path}`,
            kind: "directory",
            name,
            path,
            status: null,
        };
        byPath.set(path, synthetic);
        return synthetic;
    };

    // Ensure every ancestor directory of every entry exists so files
    // under collapsed folders still reveal their hierarchy.
    for (const entry of entries) {
        const segments = entry.relativePath.split("/");
        let cursor = "";
        for (let index = 0; index < segments.length - 1; index += 1) {
            const segment = segments[index] ?? "";
            cursor = cursor ? `${cursor}/${segment}` : segment;
            ensureDirectory(cursor);
        }
    }

    // Insert/overwrite real entries, preserving any synthetic children list.
    for (const entry of entries) {
        const existing = byPath.get(entry.relativePath);
        const previousChildren =
            existing?.kind === "directory" ? existing.children : undefined;

        byPath.set(entry.relativePath, {
            children:
                entry.kind === "directory"
                    ? (previousChildren ?? [])
                    : undefined,
            hasChildren: entry.hasChildren,
            id: entry.id,
            kind: entry.kind,
            name: entry.name,
            path: entry.relativePath,
            status: mapGitNodeStatus(entry.gitStatus),
        });
    }

    // Attach each node to its parent directory.
    const rootNodes: HierarchicalBuildNode[] = [];
    for (const node of byPath.values()) {
        const lastSlash = node.path.lastIndexOf("/");
        if (lastSlash < 0) {
            rootNodes.push(node);
            continue;
        }

        const parentPath = node.path.slice(0, lastSlash);
        const parent = byPath.get(parentPath);
        if (parent?.kind === "directory") {
            parent.children = parent.children ?? [];
            parent.children.push(node);
        } else {
            rootNodes.push(node);
        }
    }

    const sortNodes = (nodes: HierarchicalBuildNode[]) => {
        nodes.sort((left, right) => {
            if (left.kind !== right.kind) {
                return left.kind === "directory" ? -1 : 1;
            }
            return left.name.localeCompare(right.name, undefined, {
                sensitivity: "base",
            });
        });
        for (const node of nodes) {
            if (node.children) {
                sortNodes(node.children);
            }
        }
    };
    sortNodes(rootNodes);

    const expandedDirectoryPaths: string[] = [];
    const collectDirectoryPaths = (nodes: readonly HierarchicalBuildNode[]) => {
        for (const node of nodes) {
            if (node.kind === "directory") {
                expandedDirectoryPaths.push(node.path);
                if (node.children) {
                    collectDirectoryPaths(node.children);
                }
            }
        }
    };
    collectDirectoryPaths(rootNodes);

    return {
        expandedDirectoryPaths,
        nodes: rootNodes,
    };
}

export function findProjectTreeNodeByPath(
    nodesByParent: Record<ParentKey, readonly ProjectTreeNode[]>,
    relativePath: string,
): ProjectTreeNode | null {
    const roots = nodesByParent[ROOT_NODE_KEY] ?? [];
    return findProjectTreeNodeByPathInNodes(roots, nodesByParent, relativePath);
}

function buildGitTreeNodeChildren(
    node: ProjectTreeNode,
    nodesByParent: Record<ParentKey, readonly ProjectTreeNode[]>,
    expandedPaths: ReadonlySet<string>,
): readonly GitTreeNode[] | undefined {
    if (node.kind !== "directory" || !expandedPaths.has(node.relativePath)) {
        return undefined;
    }

    const children = nodesByParent[node.relativePath] ?? [];
    if (children.length === 0) {
        return undefined;
    }

    return children.map((child) =>
        convertProjectTreeNode(child, nodesByParent, expandedPaths),
    );
}

function convertProjectTreeNode(
    node: ProjectTreeNode,
    nodesByParent: Record<ParentKey, readonly ProjectTreeNode[]>,
    expandedPaths: ReadonlySet<string>,
): GitTreeNode {
    return {
        children: buildGitTreeNodeChildren(node, nodesByParent, expandedPaths),
        hasChildren: node.hasChildren,
        id: node.id,
        kind: node.kind,
        name: node.name,
        path: node.relativePath,
        status: mapGitNodeStatus(node.gitStatus),
    };
}

function mapGitNodeStatus(status: GitStatusBadge | null): GitNodeStatus | null {
    if (!status) {
        return null;
    }

    switch (status) {
        case "added":
            return "added";
        case "deleted":
            return "deleted";
        case "mixed":
            return "mixed";
        case "modified":
            return "modified";
        case "untracked":
            return "untracked";
        default:
            return null;
    }
}

function findProjectTreeNodeByPathInNodes(
    nodes: readonly ProjectTreeNode[],
    nodesByParent: Record<ParentKey, readonly ProjectTreeNode[]>,
    relativePath: string,
): ProjectTreeNode | null {
    for (const node of nodes) {
        if (node.relativePath === relativePath) {
            return node;
        }

        if (node.kind !== "directory") {
            continue;
        }

        const childNodes = nodesByParent[node.relativePath] ?? [];
        const nested = findProjectTreeNodeByPathInNodes(
            childNodes,
            nodesByParent,
            relativePath,
        );
        if (nested) {
            return nested;
        }
    }

    return null;
}
