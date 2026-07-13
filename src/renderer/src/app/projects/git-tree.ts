import type {
    GitChangeEntry,
    GitStatusBadge,
    ProjectTreeNode,
} from "@shared/ipc";

import type { GitNodeStatus, GitTreeNode } from "@renderer/components/git";

const ROOT_NODE_KEY = "__root__";

type ParentKey = string;

interface GitTreeStatuses {
    readonly changedDirectories: ReadonlySet<string>;
    readonly exact: ReadonlyMap<string, GitNodeStatus>;
}

export function buildGitTreeNodesFromProjectTree(
    rootNodes: readonly ProjectTreeNode[],
    nodesByParent: Record<ParentKey, readonly ProjectTreeNode[]>,
    expandedPaths: readonly string[] = [],
    gitChanges: readonly GitChangeEntry[] = [],
): readonly GitTreeNode[] {
    const expandedPathSet = new Set(expandedPaths);
    const gitStatuses = buildGitStatuses(gitChanges);

    return rootNodes.map((node) =>
        convertProjectTreeNode(
            node,
            nodesByParent,
            expandedPathSet,
            gitStatuses,
        ),
    );
}

interface HierarchicalBuildNode {
    readonly id: string;
    readonly isGitIgnored: boolean;
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
    metadataEntries: readonly ProjectTreeNode[] = entries,
    gitChanges: readonly GitChangeEntry[] = [],
): HierarchicalGitTreeFromEntries {
    const byPath = new Map<string, HierarchicalBuildNode>();
    const gitStatuses = buildGitStatuses(gitChanges);
    const directoryMetadataByPath = new Map(
        metadataEntries
            .filter((entry) => entry.kind === "directory")
            .map((entry) => [entry.relativePath, entry]),
    );

    const ensureDirectory = (path: string): HierarchicalBuildNode => {
        const existing = byPath.get(path);
        if (existing) {
            if (existing.kind === "directory" && !existing.children) {
                existing.children = [];
            }
            return existing;
        }

        const name = path.split("/").at(-1) ?? path;
        const metadata = directoryMetadataByPath.get(path);
        const synthetic: HierarchicalBuildNode = {
            children: [],
            hasChildren: metadata?.hasChildren ?? true,
            id: metadata?.id ?? `project-search-dir:${path}`,
            isGitIgnored: metadata?.isGitIgnored ?? false,
            kind: "directory",
            name: metadata?.name ?? name,
            path,
            status: resolveProjectTreeStatus(
                "directory",
                path,
                metadata?.gitStatus ?? null,
                gitStatuses,
            ),
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
            isGitIgnored: entry.isGitIgnored,
            kind: entry.kind,
            name: entry.name,
            path: entry.relativePath,
            status: resolveProjectTreeStatus(
                entry.kind,
                entry.relativePath,
                entry.gitStatus,
                gitStatuses,
            ),
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
    gitStatuses: GitTreeStatuses,
): readonly GitTreeNode[] | undefined {
    if (node.kind !== "directory" || !expandedPaths.has(node.relativePath)) {
        return undefined;
    }

    const children = nodesByParent[node.relativePath] ?? [];
    if (children.length === 0) {
        return undefined;
    }

    return children.map((child) =>
        convertProjectTreeNode(
            child,
            nodesByParent,
            expandedPaths,
            gitStatuses,
        ),
    );
}

function convertProjectTreeNode(
    node: ProjectTreeNode,
    nodesByParent: Record<ParentKey, readonly ProjectTreeNode[]>,
    expandedPaths: ReadonlySet<string>,
    gitStatuses: GitTreeStatuses,
): GitTreeNode {
    return {
        children: buildGitTreeNodeChildren(
            node,
            nodesByParent,
            expandedPaths,
            gitStatuses,
        ),
        hasChildren: node.hasChildren,
        id: node.id,
        isGitIgnored: node.isGitIgnored,
        kind: node.kind,
        name: node.name,
        path: node.relativePath,
        status: resolveProjectTreeStatus(
            node.kind,
            node.relativePath,
            node.gitStatus,
            gitStatuses,
        ),
    };
}

function buildGitStatuses(
    changes: readonly GitChangeEntry[],
): GitTreeStatuses {
    const exact = new Map<string, GitNodeStatus>();
    const changedDirectories = new Set<string>();

    for (const change of changes) {
        const path = change.path.replace(/\/+$/, "");
        if (!path) {
            continue;
        }

        exact.set(path, mapGitChangeStatus(change));

        let ancestor = path;
        while (true) {
            const separatorIndex = ancestor.lastIndexOf("/");
            if (separatorIndex < 0) {
                break;
            }
            ancestor = ancestor.slice(0, separatorIndex);
            changedDirectories.add(ancestor);
        }
    }

    return { changedDirectories, exact };
}

function resolveProjectTreeStatus(
    kind: ProjectTreeNode["kind"],
    relativePath: string,
    fallbackStatus: GitStatusBadge | null,
    gitStatuses: GitTreeStatuses,
): GitNodeStatus | null {
    if (kind === "directory") {
        return gitStatuses.changedDirectories.has(relativePath)
            ? "mixed"
            : (gitStatuses.exact.get(relativePath) ??
                  mapGitNodeStatus(fallbackStatus));
    }

    return gitStatuses.exact.get(relativePath) ?? mapGitNodeStatus(fallbackStatus);
}

function mapGitChangeStatus(change: GitChangeEntry): GitNodeStatus {
    switch (change.kind) {
        case "conflicted":
            return "conflict";
        case "added":
            return change.scope === "staged" ? "staged" : "added";
        case "deleted":
            return "deleted";
        case "renamed":
            return "renamed";
        case "untracked":
            return "untracked";
        case "copied":
        case "modified":
        case "typechange":
        default:
            return change.scope === "staged" ? "staged" : "modified";
    }
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
