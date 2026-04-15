import type { GitTreeNode, GitViewLayout } from "./types";

export interface FlatRowEntry {
    readonly path: string;
    readonly depth: number;
    readonly kind: "directory" | "file";
    readonly node: GitTreeNode;
}

export function flattenVisibleTree(
    nodes: readonly GitTreeNode[],
    expandedPaths: readonly string[] | undefined,
    layout: GitViewLayout,
): FlatRowEntry[] {
    const result: FlatRowEntry[] = [];

    function walk(children: readonly GitTreeNode[], depth: number): void {
        for (const node of children) {
            result.push({ path: node.path, depth, kind: node.kind, node });

            if (layout !== "tree" || node.kind !== "directory") {
                continue;
            }

            const isExpanded = node.isProjectRoot
                ? Boolean(node.children)
                : expandedPaths
                  ? expandedPaths.includes(node.path)
                  : true;

            if (isExpanded && node.children?.length) {
                walk(node.children, depth + 1);
            }
        }
    }

    walk(nodes, 0);
    return result;
}

export function computeFolderLastDescendant(
    flatRows: readonly FlatRowEntry[],
): Map<number, number> {
    const map = new Map<number, number>();
    const stack: number[] = [];

    for (let i = 0; i < flatRows.length; i++) {
        while (
            stack.length > 0 &&
            flatRows[stack[stack.length - 1]].depth >= flatRows[i].depth
        ) {
            map.set(stack.pop()!, i - 1);
        }
        if (flatRows[i].kind === "directory") {
            stack.push(i);
        }
    }

    while (stack.length > 0) {
        map.set(stack.pop()!, flatRows.length - 1);
    }

    return map;
}
