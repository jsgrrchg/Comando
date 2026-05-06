import type { ProjectTreeNode } from "@shared/ipc";

const ROOT_NODE_KEY = "__root__";

type ParentKey = string;

export type ProjectEntriesFilterStrategy = "backend-ranked" | "substring";

export interface FilteredProjectTree {
    readonly expandedDirectories: readonly string[];
    readonly matchCount: number;
    readonly nodesByParent: Record<ParentKey, readonly ProjectTreeNode[]>;
    readonly rootNodes: readonly ProjectTreeNode[];
}

export function buildFilteredProjectTree(
    nodesByParent: Record<ParentKey, readonly ProjectTreeNode[]>,
    query: string,
): FilteredProjectTree {
    const normalizedQuery = normalizeQuery(query);

    if (!normalizedQuery) {
        const rootNodes = nodesByParent[ROOT_NODE_KEY] ?? [];

        return {
            expandedDirectories: [],
            matchCount: rootNodes.length,
            nodesByParent,
            rootNodes,
        };
    }

    const expandedDirectories = new Set<string>();
    const filteredNodesByParent: Record<ParentKey, readonly ProjectTreeNode[]> =
        {};
    let matchCount = 0;

    const rootNodes = filterChildren(
        ROOT_NODE_KEY,
        normalizedQuery,
        nodesByParent,
        filteredNodesByParent,
        expandedDirectories,
        () => {
            matchCount += 1;
        },
    );

    return {
        expandedDirectories: [...expandedDirectories],
        matchCount,
        nodesByParent: filteredNodesByParent,
        rootNodes,
    };
}

export function filterProjectEntriesBySubstring(
    entries: readonly ProjectTreeNode[],
    query: string,
): readonly ProjectTreeNode[] {
    return filterProjectEntriesForTreeFilter(entries, query, "substring");
}

export function filterProjectEntriesForTreeFilter(
    entries: readonly ProjectTreeNode[],
    query: string,
    strategy: ProjectEntriesFilterStrategy,
): readonly ProjectTreeNode[] {
    const normalizedQuery = normalizeQuery(query);
    if (!normalizedQuery) {
        return [];
    }

    if (strategy === "backend-ranked") {
        return entries;
    }

    return entries.filter((entry) =>
        entry.relativePath.toLowerCase().includes(normalizedQuery),
    );
}

function filterChildren(
    parentKey: ParentKey,
    normalizedQuery: string,
    nodesByParent: Record<ParentKey, readonly ProjectTreeNode[]>,
    filteredNodesByParent: Record<ParentKey, readonly ProjectTreeNode[]>,
    expandedDirectories: Set<string>,
    onMatch: () => void,
): readonly ProjectTreeNode[] {
    const visibleNodes: ProjectTreeNode[] = [];
    const currentNodes = nodesByParent[parentKey] ?? [];

    for (const node of currentNodes) {
        const matchesSelf = matchesNode(node, normalizedQuery);

        if (node.kind === "directory") {
            const visibleChildren = filterChildren(
                node.relativePath,
                normalizedQuery,
                nodesByParent,
                filteredNodesByParent,
                expandedDirectories,
                onMatch,
            );

            if (!matchesSelf && visibleChildren.length === 0) {
                continue;
            }

            visibleNodes.push(node);

            if (matchesSelf) {
                onMatch();
            }

            if (visibleChildren.length > 0) {
                filteredNodesByParent[node.relativePath] = visibleChildren;
                expandedDirectories.add(node.relativePath);
            }

            continue;
        }

        if (!matchesSelf) {
            continue;
        }

        visibleNodes.push(node);
        onMatch();
    }

    if (visibleNodes.length > 0) {
        filteredNodesByParent[parentKey] = visibleNodes;
    }

    return visibleNodes;
}

function matchesNode(node: ProjectTreeNode, normalizedQuery: string): boolean {
    return `${node.name} ${node.relativePath}`
        .toLowerCase()
        .includes(normalizedQuery);
}

function normalizeQuery(query: string): string {
    return query.trim().toLowerCase();
}
