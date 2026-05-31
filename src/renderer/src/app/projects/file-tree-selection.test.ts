import { describe, expect, it } from "vitest";

import type { RuntimeWorkspaceFileTab } from "../workspace/tree";
import {
    reconcileFileTreeSelection,
    resolveActiveFileTreePath,
    resolveFileTreeNodeClickSelection,
} from "./file-tree-selection";

function createFileTab(
    overrides: Partial<RuntimeWorkspaceFileTab> = {},
): RuntimeWorkspaceFileTab {
    return {
        createdAt: "2026-04-14T00:00:00.000Z",
        document: null,
        draftContent: "",
        hasExternalChange: false,
        id: "tab-file",
        isDirty: false,
        isLoading: false,
        isSaving: false,
        kind: "file",
        loadError: null,
        projectId: "project-1",
        relativePath: "docs/guide.md",
        reviewContext: null,
        saveError: null,
        savedContent: "",
        title: "guide.md",
        worktreeId: null,
        ...overrides,
    };
}

describe("file tree selection", () => {
    it("returns the active file path only for the visible project context", () => {
        expect(
            resolveActiveFileTreePath({
                activeProjectId: "project-1",
                activeWorkspaceTab: createFileTab(),
                activeWorktreeId: null,
            }),
        ).toBe("docs/guide.md");
    });

    it("ignores active file tabs from another project or worktree", () => {
        expect(
            resolveActiveFileTreePath({
                activeProjectId: "project-1",
                activeWorkspaceTab: createFileTab({
                    projectId: "project-2",
                }),
                activeWorktreeId: null,
            }),
        ).toBeNull();

        expect(
            resolveActiveFileTreePath({
                activeProjectId: "project-1",
                activeWorkspaceTab: createFileTab({
                    worktreeId: "feature-x",
                }),
                activeWorktreeId: null,
            }),
        ).toBeNull();
    });

    it("uses the active file when there is no manual tree selection", () => {
        expect(
            reconcileFileTreeSelection({
                activeFileTreePath: "docs/todo.md",
                anchorPath: null,
                selectedPaths: [],
            }),
        ).toEqual({
            anchorPath: "docs/todo.md",
            selectedPaths: ["docs/todo.md"],
        });
    });

    it("can suppress the active file fallback after focus leaves the tree", () => {
        expect(
            reconcileFileTreeSelection({
                activeFileTreePath: "docs/todo.md",
                anchorPath: null,
                includeActivePathFallback: false,
                selectedPaths: [],
            }),
        ).toEqual({
            anchorPath: null,
            selectedPaths: [],
        });
    });

    it("preserves manual selection while an active file exists", () => {
        const selection = ["docs/guide.md", "docs/todo.md"];

        expect(
            reconcileFileTreeSelection({
                activeFileTreePath: "docs/todo.md",
                anchorPath: "docs/guide.md",
                selectedPaths: selection,
            }),
        ).toEqual({
            anchorPath: "docs/guide.md",
            selectedPaths: selection,
        });
    });

    it("leaves manual selection untouched when there is no active file", () => {
        expect(
            reconcileFileTreeSelection({
                activeFileTreePath: null,
                anchorPath: "docs/guide.md",
                selectedPaths: ["docs/guide.md", "docs/todo.md"],
            }),
        ).toEqual({
            anchorPath: "docs/guide.md",
            selectedPaths: ["docs/guide.md", "docs/todo.md"],
        });
    });

    it("clears manual selection on a normal tree row click", () => {
        expect(
            resolveFileTreeNodeClickSelection({
                anchorPath: "docs",
                isRangeSelection: false,
                isToggleSelection: false,
                nodePath: "docs",
                selectedPaths: ["docs"],
                visiblePaths: ["docs", "docs/guide.md", "docs/todo.md"],
            }),
        ).toEqual({
            anchorPath: null,
            selectedPaths: [],
        });
    });

    it("preserves modifier-based tree selection", () => {
        const visiblePaths = ["docs", "docs/guide.md", "docs/todo.md"];

        expect(
            resolveFileTreeNodeClickSelection({
                anchorPath: "docs",
                isRangeSelection: true,
                isToggleSelection: false,
                nodePath: "docs/todo.md",
                selectedPaths: [],
                visiblePaths,
            }),
        ).toEqual({
            anchorPath: "docs",
            selectedPaths: ["docs", "docs/guide.md", "docs/todo.md"],
        });

        expect(
            resolveFileTreeNodeClickSelection({
                anchorPath: null,
                isRangeSelection: false,
                isToggleSelection: true,
                nodePath: "docs/guide.md",
                selectedPaths: ["docs"],
                visiblePaths,
            }),
        ).toEqual({
            anchorPath: "docs/guide.md",
            selectedPaths: ["docs", "docs/guide.md"],
        });
    });
});
