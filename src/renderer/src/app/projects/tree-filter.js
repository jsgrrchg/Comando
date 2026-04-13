const ROOT_NODE_KEY = "__root__";
export function buildFilteredProjectTree(nodesByParent, query) {
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
    const expandedDirectories = new Set();
    const filteredNodesByParent = {};
    let matchCount = 0;
    const rootNodes = filterChildren(ROOT_NODE_KEY, normalizedQuery, nodesByParent, filteredNodesByParent, expandedDirectories, () => {
        matchCount += 1;
    });
    return {
        expandedDirectories: [...expandedDirectories],
        matchCount,
        nodesByParent: filteredNodesByParent,
        rootNodes,
    };
}
function filterChildren(parentKey, normalizedQuery, nodesByParent, filteredNodesByParent, expandedDirectories, onMatch) {
    const visibleNodes = [];
    const currentNodes = nodesByParent[parentKey] ?? [];
    for (const node of currentNodes) {
        const matchesSelf = matchesNode(node, normalizedQuery);
        if (node.kind === "directory") {
            const visibleChildren = filterChildren(node.relativePath, normalizedQuery, nodesByParent, filteredNodesByParent, expandedDirectories, onMatch);
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
function matchesNode(node, normalizedQuery) {
    return `${node.name} ${node.relativePath}`
        .toLowerCase()
        .includes(normalizedQuery);
}
function normalizeQuery(query) {
    return query.trim().toLowerCase();
}
