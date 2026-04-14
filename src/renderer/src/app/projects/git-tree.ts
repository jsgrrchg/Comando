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
