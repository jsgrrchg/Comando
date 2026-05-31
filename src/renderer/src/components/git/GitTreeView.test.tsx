import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { getGitTreeDragLabel, GitTreeView } from "./GitTreeView";
import type { GitTreeNode } from "./types";

function createFileNode(overrides: Partial<GitTreeNode> = {}): GitTreeNode {
    return {
        id: "file-1",
        kind: "file",
        name: "notes.md",
        path: "notes.md",
        status: "modified",
        ...overrides,
    };
}

describe("GitTreeView", () => {
    it("renders children for expanded directories", () => {
        const markup = renderToStaticMarkup(
            <GitTreeView
                expandedPaths={["src"]}
                nodes={[
                    createFileNode({
                        children: [
                            createFileNode({
                                id: "file-2",
                                name: "App.tsx",
                                path: "src/App.tsx",
                            }),
                        ],
                        hasChildren: true,
                        id: "dir-1",
                        kind: "directory",
                        name: "src",
                        path: "src",
                        status: "modified",
                    }),
                ]}
            />,
        );

        expect(markup).toContain("src");
        expect(markup).toContain("App.tsx");
        expect(markup).toContain('data-path="src/App.tsx"');
    });

    it("does not render children for collapsed directories", () => {
        const markup = renderToStaticMarkup(
            <GitTreeView
                expandedPaths={[]}
                nodes={[
                    createFileNode({
                        children: [
                            createFileNode({
                                id: "file-2",
                                name: "App.tsx",
                                path: "src/App.tsx",
                            }),
                        ],
                        hasChildren: true,
                        id: "dir-1",
                        kind: "directory",
                        name: "src",
                        path: "src",
                        status: "modified",
                    }),
                ]}
            />,
        );

        expect(markup).toContain("src");
        expect(markup).not.toContain("App.tsx");
        expect(markup).not.toContain('data-path="src/App.tsx"');
    });

    it("uses git status color on file title without rendering the status letter when disabled", () => {
        const markup = renderToStaticMarkup(
            <GitTreeView
                nodes={[createFileNode()]}
                showStatusIndicator={false}
            />,
        );

        expect(markup).toContain("var(--diff-warn)");
        expect(markup).toContain("notes.md");
        expect(markup).not.toContain(">M</span>");
    });

    it("colors changed folders with the same minimal status tint", () => {
        const markup = renderToStaticMarkup(
            <GitTreeView
                nodes={[
                    createFileNode({
                        children: [],
                        hasChildren: true,
                        id: "dir-1",
                        kind: "directory",
                        name: "src",
                        path: "src",
                        status: "mixed",
                    }),
                ]}
                showStatusIndicator={false}
            />,
        );

        expect(markup).toContain("src");
        expect(markup).toContain("var(--diff-warn)");
        expect(markup).not.toContain(">±</span>");
    });

    it("renders an inline editor for the node being renamed", () => {
        const markup = renderToStaticMarkup(
            <GitTreeView
                editingDraftName="renamed-notes.md"
                editingPath="notes.md"
                nodes={[createFileNode()]}
            />,
        );

        expect(markup).toContain('data-inline-tree-editor="true"');
        expect(markup).toContain('value="renamed-notes.md"');
        expect(markup).not.toContain(">notes.md</span>");
    });

    it("marks selected rows independently from the active file", () => {
        const markup = renderToStaticMarkup(
            <GitTreeView
                activePath="notes.md"
                nodes={[createFileNode(), createFileNode({
                    id: "file-2",
                    name: "todo.md",
                    path: "todo.md",
                })]}
                selectedPaths={new Set(["todo.md"])}
            />,
        );

        expect(markup).toContain('data-active="true"');
        expect(markup).toContain('data-selected="true"');
    });

    it("renders a focusable tree with an initial keyboard cursor", () => {
        const markup = renderToStaticMarkup(
            <GitTreeView nodes={[createFileNode()]} />,
        );

        expect(markup).toContain('role="tree"');
        expect(markup).toContain('tabindex="0"');
        expect(markup).toContain('aria-activedescendant=');
        expect(markup).toContain('role="treeitem"');
        expect(markup).toContain('data-keyboard-cursor="true"');
    });

    it("can suppress the keyboard cursor while focus is outside the tree", () => {
        const markup = renderToStaticMarkup(
            <GitTreeView nodes={[createFileNode()]} suppressKeyboardCursor />,
        );

        expect(markup).toContain('role="tree"');
        expect(markup).not.toContain('aria-activedescendant=');
        expect(markup).not.toContain('data-keyboard-cursor="true"');
    });

    it("initializes the keyboard cursor from the active path when visible", () => {
        const markup = renderToStaticMarkup(
            <GitTreeView
                activePath="todo.md"
                nodes={[
                    createFileNode(),
                    createFileNode({
                        id: "file-2",
                        name: "todo.md",
                        path: "todo.md",
                    }),
                ]}
            />,
        );

        expect(markup).toMatch(
            /data-keyboard-cursor="true"[^>]*data-path="todo\.md"/,
        );
    });

    it("initializes the keyboard cursor from selection when no active path is visible", () => {
        const markup = renderToStaticMarkup(
            <GitTreeView
                nodes={[
                    createFileNode(),
                    createFileNode({
                        id: "file-2",
                        name: "todo.md",
                        path: "todo.md",
                    }),
                ]}
                selectedPaths={new Set(["todo.md"])}
            />,
        );

        expect(markup).toMatch(
            /data-keyboard-cursor="true"[^>]*data-path="todo\.md"[^>]*data-selected="true"/,
        );
    });

    it("exposes root drag and context state hooks for background interactions", () => {
        const markup = renderToStaticMarkup(
            <GitTreeView
                nodes={[createFileNode()]}
                onBackgroundContextMenu={() => undefined}
                onBackgroundDrop={() => undefined}
            />,
        );

        expect(markup).toContain("git-tree-root");
        expect(markup).toContain('data-background-drop-target="false"');
        expect(markup).toContain('data-dragging="false"');
        expect(markup).toContain('data-context-target="false"');
    });

    it("keeps row interaction states distinct in markup", () => {
        const markup = renderToStaticMarkup(
            <GitTreeView
                activePath="notes.md"
                nodes={[createFileNode()]}
                selectedPaths={new Set(["notes.md"])}
            />,
        );

        expect(markup).toContain('data-active="true"');
        expect(markup).toContain('data-selected="true"');
        expect(markup).toContain('data-drop-target="false"');
        expect(markup).toContain('data-dragging="false"');
        expect(markup).toContain('data-context-target="false"');
    });

    it("builds useful drag ghost labels for single and multi-entry drags", () => {
        expect(
            getGitTreeDragLabel({
                kind: "file",
                name: "notes.md",
                relativePath: "notes.md",
            }),
        ).toBe("notes.md");

        expect(
            getGitTreeDragLabel([
                {
                    kind: "directory",
                    name: "src",
                    relativePath: "src",
                },
                {
                    kind: "file",
                    name: "App.tsx",
                    relativePath: "src/App.tsx",
                },
                {
                    kind: "file",
                    name: "README.md",
                    relativePath: "README.md",
                },
            ]),
        ).toBe("1 folder, 2 files");
    });
});
