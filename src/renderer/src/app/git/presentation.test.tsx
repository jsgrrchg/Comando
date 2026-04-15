import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { GitChangeEntry } from "@shared/ipc";

import { buildGitChangeGroups } from "./presentation";

function createChange(overrides: Partial<GitChangeEntry> = {}): GitChangeEntry {
    return {
        additions: 5,
        deletions: 0,
        hasChildren: false,
        isBinary: false,
        isConflicted: false,
        isRenamed: false,
        kind: "modified",
        path: "src/example.ts",
        previousPath: null,
        scope: "staged",
        worktreeId: null,
        ...overrides,
    };
}

describe("buildGitChangeGroups", () => {
    it("sums +/- per group without showing zero values", () => {
        const groups = buildGitChangeGroups(
            [
                createChange({
                    additions: 5,
                    deletions: 0,
                    path: "src/example.ts",
                    scope: "staged",
                }),
                createChange({
                    additions: 0,
                    deletions: 2,
                    path: "src/other.ts",
                    scope: "staged",
                }),
            ],
            {
                onDiscardPath: () => undefined,
                onOpenDiff: () => undefined,
                onStagePath: () => undefined,
                onUnstagePath: () => undefined,
            },
        );

        expect(groups.find((group) => group.id === "staged")?.description).toBe(
            "+5 -2",
        );
    });

    it("preserves zero values in file metadata, like Zed", () => {
        const groups = buildGitChangeGroups(
            [
                createChange({
                    additions: 6,
                    deletions: 0,
                    path: "src/persistence.ts",
                    scope: "staged",
                }),
            ],
            {
                onDiscardPath: () => undefined,
                onOpenDiff: () => undefined,
                onStagePath: () => undefined,
                onUnstagePath: () => undefined,
            },
        );

        const stagedGroup = groups.find((group) => group.id === "staged");
        const fileNode = findNodeByPath(
            stagedGroup?.nodes ?? [],
            "src/persistence.ts",
        );
        const markup = renderToStaticMarkup(<>{fileNode?.meta}</>);

        expect(markup).toContain("+6");
        expect(markup).toContain("-0");
    });
});

function findNodeByPath(
    nodes: readonly TestTreeNode[],
    path: string,
): TestTreeNode | undefined {
    for (const node of nodes) {
        if (node.path === path) {
            return node;
        }

        if (!node.children?.length) {
            continue;
        }

        const match = findNodeByPath(node.children, path);
        if (match) {
            return match;
        }
    }

    return undefined;
}

type TestTreeNode = {
    readonly children?: readonly TestTreeNode[];
    readonly meta?: unknown;
    readonly path: string;
};
