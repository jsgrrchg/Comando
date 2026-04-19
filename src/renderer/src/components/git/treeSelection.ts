import type { GitTreeNode } from "./types";

export function flattenVisibleGitTreeNodes(
    nodes: readonly GitTreeNode[],
): GitTreeNode[] {
    const flattened: GitTreeNode[] = [];

    const visit = (entries: readonly GitTreeNode[]) => {
        for (const entry of entries) {
            flattened.push(entry);
            if (entry.children?.length) {
                visit(entry.children);
            }
        }
    };

    visit(nodes);
    return flattened;
}

export function toggleGitTreePathSelection(
    selectedPaths: readonly string[],
    targetPath: string,
): string[] {
    const selectedPathSet = new Set(selectedPaths);
    if (selectedPathSet.has(targetPath)) {
        return selectedPaths.filter((path) => path !== targetPath);
    }

    return [...selectedPaths, targetPath];
}

export function selectGitTreeRange(
    visiblePaths: readonly string[],
    anchorPath: string | null,
    targetPath: string,
): string[] {
    const targetIndex = visiblePaths.indexOf(targetPath);
    if (targetIndex < 0) {
        return [targetPath];
    }

    const anchorIndex =
        anchorPath === null ? -1 : visiblePaths.indexOf(anchorPath);
    if (anchorIndex < 0) {
        return [targetPath];
    }

    const start = Math.min(anchorIndex, targetIndex);
    const end = Math.max(anchorIndex, targetIndex);
    return visiblePaths.slice(start, end + 1);
}

export function orderGitTreePathsByVisibility(
    paths: readonly string[],
    visiblePaths: readonly string[],
): string[] {
    const selectedPathSet = new Set(paths);
    return visiblePaths.filter((path) => selectedPathSet.has(path));
}

export function resolveGitTreeDragPaths(
    nodePath: string,
    selectedPaths: readonly string[],
    visiblePaths: readonly string[],
): string[] {
    if (!selectedPaths.includes(nodePath)) {
        return [nodePath];
    }

    const orderedSelectedPaths = orderGitTreePathsByVisibility(
        selectedPaths,
        visiblePaths,
    );
    return orderedSelectedPaths.length > 0 ? orderedSelectedPaths : [nodePath];
}
