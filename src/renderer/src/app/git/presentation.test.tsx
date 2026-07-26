import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
    GitBranchDiffResult,
    GitChangeEntry,
    GitWorktreeDiffResult,
} from "@shared/ipc";

import {
    buildGitBranchDiffSections,
    buildGitChangeGroups,
    buildGitDiffFileId,
    buildGitWorktreeDiffSections,
    parseGitDiffFileId,
} from "./presentation";

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

describe("buildGitBranchDiffSections", () => {
    it("exposes only the read-only open action", () => {
        const result: GitBranchDiffResult = {
            baseRef: "main",
            files: [
                {
                    additions: 1,
                    deletions: 0,
                    diff: null,
                    error: null,
                    isBinary: false,
                    kind: "modified",
                    path: "src/example.ts",
                    previousPath: null,
                },
            ],
            headRef: "feature",
            projectId: "project-1",
            unavailableReason: null,
            updatedAt: "2026-07-26T00:00:00.000Z",
            worktreeId: null,
        };

        const sections = buildGitBranchDiffSections(result, {
            onOpenFile: () => undefined,
        });

        expect(sections[0].files[0].actions?.map((action) => action.label)).toEqual([
            "Open",
        ]);
        expect(sections[0].files[0].reversible).toBe(false);
    });
});

describe("buildGitWorktreeDiffSections", () => {
    it("keeps staged and unstaged entries separate for the same path", () => {
        const result = createWorktreeDiffResult({
            sections: [
                {
                    scope: "staged",
                    files: [
                        createWorktreeDiffFile({
                            path: "src/example.ts",
                            scope: "staged",
                        }),
                    ],
                },
                {
                    scope: "unstaged",
                    files: [
                        createWorktreeDiffFile({
                            additions: 2,
                            path: "src/example.ts",
                            scope: "unstaged",
                        }),
                    ],
                },
            ],
        });

        const sections = buildGitWorktreeDiffSections(result, {
            onDiscardFile: () => undefined,
            onOpenFile: () => undefined,
            onStageFile: () => undefined,
            onUnstageFile: () => undefined,
        });
        const ids = sections.flatMap((section) =>
            section.files.map((file) => file.id),
        );

        expect(ids).toEqual([
            buildGitDiffFileId("staged", "src/example.ts"),
            buildGitDiffFileId("unstaged", "src/example.ts"),
        ]);
    });

    it("parses file ids for paths containing colons", () => {
        const fileId = buildGitDiffFileId(
            "unstaged",
            "src/routes/a:b/file.ts",
        );

        expect(parseGitDiffFileId(fileId)).toEqual({
            path: "src/routes/a:b/file.ts",
            scope: "unstaged",
        });
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

function createWorktreeDiffResult(
    overrides: Partial<GitWorktreeDiffResult> = {},
): GitWorktreeDiffResult {
    return {
        projectId: "project-1",
        sections: [],
        updatedAt: "2026-05-17T00:00:00.000Z",
        worktreeId: "worktree-1",
        ...overrides,
    };
}

function createWorktreeDiffFile(
    overrides: Partial<
        GitWorktreeDiffResult["sections"][number]["files"][number]
    > = {},
): GitWorktreeDiffResult["sections"][number]["files"][number] {
    return {
        additions: 1,
        deletions: 0,
        diff: null,
        error: null,
        isBinary: false,
        isConflicted: false,
        kind: "modified",
        path: "src/example.ts",
        previousPath: null,
        scope: "unstaged",
        ...overrides,
    };
}
