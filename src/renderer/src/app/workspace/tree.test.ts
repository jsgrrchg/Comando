import { describe, expect, it } from "vitest";

import {
    attachTabToPane,
    closeOtherWorkspaceTabs,
    closeWorkspacePane,
    closeWorkspaceTabsForProjectPath,
    closeWorkspaceTabsToRight,
    createDefaultWorkspaceState,
    moveActiveTabBetweenPanes,
    moveWorkspaceTabBetweenPanes,
    renameWorkspaceTabsForProjectPath,
    splitPaneInDirection,
    type RuntimeWorkspaceFileTab,
    type RuntimeWorkspaceTab,
} from "./tree";

function makeChatTab(id: string): RuntimeWorkspaceTab {
    return {
        createdAt: "2026-04-12T00:00:00.000Z",
        draft: "",
        id,
        kind: "chat",
        projectId: null,
        sessionId: `session-${id}`,
        title: `Chat ${id}`,
    };
}

function makeFileTab(
    id: string,
    relativePath: string,
    projectId = "project-1",
): RuntimeWorkspaceFileTab {
    return {
        createdAt: "2026-04-12T00:00:00.000Z",
        document: {
            absolutePath: `/tmp/${relativePath}`,
            content: "",
            isBinary: false,
            isTooLarge: false,
            languageId: "markdown",
            languageLabel: "Markdown",
            name: relativePath.split("/").at(-1) ?? relativePath,
            projectId,
            relativePath,
        },
        draftContent: "",
        id,
        isDirty: false,
        isLoading: false,
        isSaving: false,
        kind: "file",
        loadError: null,
        projectId,
        relativePath,
        savedContent: "",
        saveError: null,
        title: relativePath.split("/").at(-1) ?? relativePath,
    };
}

describe("workspace tree helpers", () => {
    it("splits a pane and activates the new pane", () => {
        const state = splitPaneInDirection(
            createDefaultWorkspaceState(),
            "pane-root",
            "right",
            {
                paneId: "pane-2",
                splitId: "split-1",
            },
        );

        expect(state.activePaneId).toBe("pane-2");
        expect(state.rootNode.type).toBe("split");
    });

    it("moves the active tab to the next pane", () => {
        const splitState = splitPaneInDirection(
            createDefaultWorkspaceState(),
            "pane-root",
            "right",
            {
                paneId: "pane-2",
                splitId: "split-1",
            },
        );
        const withTab = attachTabToPane(
            splitState,
            "pane-root",
            makeChatTab("tab-1"),
        );
        const moved = moveActiveTabBetweenPanes(withTab, "pane-root", "next");

        const rootNode = moved.rootNode;
        expect(rootNode.type).toBe("split");
        if (rootNode.type !== "split") {
            return;
        }

        expect(rootNode.children[0].type).toBe("pane");
        expect(rootNode.children[1].type).toBe("pane");
        if (rootNode.children[0].type === "pane") {
            expect(rootNode.children[0].tabIds).toEqual([]);
        }
        if (rootNode.children[1].type === "pane") {
            expect(rootNode.children[1].tabIds).toEqual(["tab-1"]);
        }
    });

    it("moves a specific inactive tab to the previous pane", () => {
        const splitState = splitPaneInDirection(
            createDefaultWorkspaceState(),
            "pane-root",
            "right",
            {
                paneId: "pane-2",
                splitId: "split-1",
            },
        );
        const withFirstTab = attachTabToPane(
            splitState,
            "pane-root",
            makeChatTab("tab-1"),
        );
        const withSecondTab = attachTabToPane(
            withFirstTab,
            "pane-root",
            makeChatTab("tab-2"),
        );
        const withThirdTab = attachTabToPane(
            withSecondTab,
            "pane-2",
            makeChatTab("tab-3"),
        );
        const moved = moveWorkspaceTabBetweenPanes(
            withThirdTab,
            "tab-2",
            "next",
        );

        expect(moved.rootNode.type).toBe("split");
        if (moved.rootNode.type !== "split") {
            return;
        }

        const [leftPane, rightPane] = moved.rootNode.children;
        expect(leftPane.type).toBe("pane");
        expect(rightPane.type).toBe("pane");
        if (leftPane.type === "pane") {
            expect(leftPane.tabIds).toEqual(["tab-1"]);
        }
        if (rightPane.type === "pane") {
            expect(rightPane.tabIds).toEqual(["tab-3", "tab-2"]);
            expect(rightPane.activeTabId).toBe("tab-2");
        }
    });

    it("closes other tabs in the same pane", () => {
        const withFirstTab = attachTabToPane(
            createDefaultWorkspaceState(),
            "pane-root",
            makeChatTab("tab-1"),
        );
        const withSecondTab = attachTabToPane(
            withFirstTab,
            "pane-root",
            makeChatTab("tab-2"),
        );
        const withThirdTab = attachTabToPane(
            withSecondTab,
            "pane-root",
            makeChatTab("tab-3"),
        );
        const closed = closeOtherWorkspaceTabs(withThirdTab, "tab-2");

        expect(closed.rootNode.type).toBe("pane");
        if (closed.rootNode.type === "pane") {
            expect(closed.rootNode.tabIds).toEqual(["tab-2"]);
            expect(closed.rootNode.activeTabId).toBe("tab-2");
        }
        expect(Object.keys(closed.tabsById)).toEqual(["tab-2"]);
    });

    it("closes tabs to the right within the same pane", () => {
        const withFirstTab = attachTabToPane(
            createDefaultWorkspaceState(),
            "pane-root",
            makeChatTab("tab-1"),
        );
        const withSecondTab = attachTabToPane(
            withFirstTab,
            "pane-root",
            makeChatTab("tab-2"),
        );
        const withThirdTab = attachTabToPane(
            withSecondTab,
            "pane-root",
            makeChatTab("tab-3"),
        );
        const closed = closeWorkspaceTabsToRight(withThirdTab, "tab-2");

        expect(closed.rootNode.type).toBe("pane");
        if (closed.rootNode.type === "pane") {
            expect(closed.rootNode.tabIds).toEqual(["tab-1", "tab-2"]);
            expect(closed.rootNode.activeTabId).toBe("tab-2");
        }
        expect(Object.keys(closed.tabsById).sort()).toEqual(["tab-1", "tab-2"]);
    });

    it("closes a pane and merges its tabs into the fallback pane", () => {
        const splitState = splitPaneInDirection(
            createDefaultWorkspaceState(),
            "pane-root",
            "right",
            {
                paneId: "pane-2",
                splitId: "split-1",
            },
        );
        const withFirstTab = attachTabToPane(
            splitState,
            "pane-root",
            makeChatTab("tab-1"),
        );
        const withSecondTab = attachTabToPane(
            withFirstTab,
            "pane-2",
            makeChatTab("tab-2"),
        );
        const closed = closeWorkspacePane(withSecondTab, "pane-2");

        expect(closed.rootNode.type).toBe("pane");
        if (closed.rootNode.type === "pane") {
            expect(closed.rootNode.tabIds).toEqual(["tab-1", "tab-2"]);
        }
    });

    it("closes every file tab that matches a deleted directory", () => {
        const withReadme = attachTabToPane(
            createDefaultWorkspaceState(),
            "pane-root",
            makeFileTab("tab-1", "docs/readme.md"),
        );
        const withGuide = attachTabToPane(
            withReadme,
            "pane-root",
            makeFileTab("tab-2", "docs/guides/getting-started.md"),
        );
        const withOtherFile = attachTabToPane(
            withGuide,
            "pane-root",
            makeFileTab("tab-3", "src/index.ts"),
        );

        const closed = closeWorkspaceTabsForProjectPath(
            withOtherFile,
            "project-1",
            "docs",
            "directory",
        );

        expect(Object.keys(closed.tabsById).sort()).toEqual(["tab-3"]);
    });

    it("renames every matching open tab when a directory moves", () => {
        const withReadme = attachTabToPane(
            createDefaultWorkspaceState(),
            "pane-root",
            makeFileTab("tab-1", "docs/readme.md"),
        );
        const withGuide = attachTabToPane(
            withReadme,
            "pane-root",
            makeFileTab("tab-2", "docs/guides/getting-started.md"),
        );

        const renamed = renameWorkspaceTabsForProjectPath(
            withGuide,
            "project-1",
            "docs",
            "knowledge-base",
            "directory",
        );

        const readmeTab = renamed.tabsById["tab-1"];
        const guideTab = renamed.tabsById["tab-2"];
        if (readmeTab?.kind !== "file" || guideTab?.kind !== "file") {
            throw new Error("Expected file tabs after rename.");
        }

        expect(readmeTab.relativePath).toBe("knowledge-base/readme.md");
        expect(readmeTab.document?.relativePath).toBe(
            "knowledge-base/readme.md",
        );
        expect(readmeTab.title).toBe("readme.md");
        expect(guideTab.relativePath).toBe(
            "knowledge-base/guides/getting-started.md",
        );
        expect(guideTab.document?.absolutePath).toContain(
            "knowledge-base/guides/getting-started.md",
        );
    });
});
