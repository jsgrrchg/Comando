import { describe, expect, it } from "vitest";

import {
    attachTabToPane,
    closeOtherWorkspaceTabs,
    closeWorkspaceTab,
    closeWorkspacePane,
    closeWorkspaceTabsForProjectPath,
    closeWorkspaceTabsToRight,
    createDefaultWorkspaceState,
    moveTabToPaneAtIndex,
    moveTabToSplit,
    moveActiveTabBetweenPanes,
    moveWorkspaceTabBetweenPanes,
    reorderTabInPane,
    renameWorkspaceTabsForProjectPath,
    replaceFileDocument,
    selectAdjacentPaneTab,
    setFileTabExternalChange,
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
        runtimeId: "codex",
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
            imageDataBase64: null,
            isBinary: false,
            isTooLarge: false,
            kind: "text",
            languageId: "markdown",
            languageLabel: "Markdown",
            modifiedAtMs: 1,
            mimeType: "text/markdown",
            name: relativePath.split("/").at(-1) ?? relativePath,
            projectId,
            relativePath,
            sizeBytes: 0,
        },
        draftContent: "",
        hasExternalChange: false,
        id,
        isDirty: false,
        isLoading: false,
        isSaving: false,
        kind: "file",
        loadError: null,
        projectId,
        relativePath,
        reviewContext: null,
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
        if (state.rootNode.type === "split") {
            expect(state.rootNode.axis).toBe("horizontal");
            expect(state.rootNode.children[0]?.id).toBe("pane-root");
            expect(state.rootNode.children[1]?.id).toBe("pane-2");
        }
    });

    it("creates a vertical split when splitting down", () => {
        const state = splitPaneInDirection(
            createDefaultWorkspaceState(),
            "pane-root",
            "down",
            {
                paneId: "pane-2",
                splitId: "split-1",
            },
        );

        expect(state.activePaneId).toBe("pane-2");
        expect(state.rootNode.type).toBe("split");
        if (state.rootNode.type === "split") {
            expect(state.rootNode.axis).toBe("vertical");
            expect(state.rootNode.children[0]?.id).toBe("pane-root");
            expect(state.rootNode.children[1]?.id).toBe("pane-2");
        }
    });

    it("places the new pane before the current pane when splitting up", () => {
        const state = splitPaneInDirection(
            createDefaultWorkspaceState(),
            "pane-root",
            "up",
            {
                paneId: "pane-2",
                splitId: "split-1",
            },
        );

        expect(state.activePaneId).toBe("pane-2");
        expect(state.rootNode.type).toBe("split");
        if (state.rootNode.type === "split") {
            expect(state.rootNode.axis).toBe("vertical");
            expect(state.rootNode.children[0]?.id).toBe("pane-2");
            expect(state.rootNode.children[1]?.id).toBe("pane-root");
        }
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

        expect(moved.activePaneId).toBe("pane-2");
        const rootNode = moved.rootNode;
        expect(rootNode.type).toBe("pane");
        if (rootNode.type !== "pane") {
            return;
        }

        expect(rootNode.id).toBe("pane-2");
        expect(rootNode.tabIds).toEqual(["tab-1"]);
        expect(rootNode.activeTabId).toBe("tab-1");
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

    it("selects the next tab in the same pane with wrap-around", () => {
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

        const selected = selectAdjacentPaneTab(
            withThirdTab,
            "pane-root",
            "next",
        );

        expect(selected.rootNode.type).toBe("pane");
        if (selected.rootNode.type !== "pane") {
            return;
        }

        expect(selected.rootNode.activeTabId).toBe("tab-1");
        expect(selected.activePaneId).toBe("pane-root");
    });

    it("selects the previous tab in the same pane with wrap-around", () => {
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
        const selectedSecond = selectAdjacentPaneTab(
            withSecondTab,
            "pane-root",
            "next",
        );

        const selected = selectAdjacentPaneTab(
            selectedSecond,
            "pane-root",
            "previous",
        );

        expect(selected.rootNode.type).toBe("pane");
        if (selected.rootNode.type !== "pane") {
            return;
        }

        expect(selected.rootNode.activeTabId).toBe("tab-2");
        expect(selected.activePaneId).toBe("pane-root");
    });

    it("reorders tabs within the same pane by insertion index", () => {
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

        const reordered = reorderTabInPane(
            withThirdTab,
            "pane-root",
            "tab-1",
            2,
        );

        expect(reordered.rootNode.type).toBe("pane");
        if (reordered.rootNode.type === "pane") {
            expect(reordered.rootNode.tabIds).toEqual([
                "tab-2",
                "tab-3",
                "tab-1",
            ]);
            expect(reordered.rootNode.activeTabId).toBe("tab-3");
        }
        expect(reordered.activePaneId).toBe("pane-root");
    });

    it("moves a tab to another pane at a specific index", () => {
        const splitState = splitPaneInDirection(
            createDefaultWorkspaceState(),
            "pane-root",
            "right",
            {
                paneId: "pane-2",
                splitId: "split-1",
            },
        );
        const withSourceTabs = attachTabToPane(
            attachTabToPane(splitState, "pane-root", makeChatTab("tab-1")),
            "pane-root",
            makeChatTab("tab-2"),
        );
        const withTargetTabs = attachTabToPane(
            attachTabToPane(withSourceTabs, "pane-2", makeChatTab("tab-3")),
            "pane-2",
            makeChatTab("tab-4"),
        );

        const moved = moveTabToPaneAtIndex(
            withTargetTabs,
            "tab-2",
            "pane-root",
            "pane-2",
            1,
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
            expect(leftPane.activeTabId).toBe("tab-1");
        }
        if (rightPane.type === "pane") {
            expect(rightPane.tabIds).toEqual(["tab-3", "tab-2", "tab-4"]);
            expect(rightPane.activeTabId).toBe("tab-2");
        }
        expect(moved.activePaneId).toBe("pane-2");
    });

    it("creates a split from a drop target and moves the tab into the new pane", () => {
        const splitState = splitPaneInDirection(
            createDefaultWorkspaceState(),
            "pane-root",
            "right",
            {
                paneId: "pane-2",
                splitId: "split-1",
            },
        );
        const withSourceTab = attachTabToPane(
            splitState,
            "pane-root",
            makeChatTab("tab-1"),
        );
        const withTargetTab = attachTabToPane(
            withSourceTab,
            "pane-2",
            makeChatTab("tab-2"),
        );

        const moved = moveTabToSplit(
            withTargetTab,
            "tab-1",
            "pane-root",
            "pane-2",
            "down",
            {
                paneId: "pane-3",
                splitId: "split-2",
            },
        );

        expect(moved.activePaneId).toBe("pane-3");
        expect(moved.rootNode.type).toBe("split");
        if (moved.rootNode.type !== "split") {
            return;
        }

        expect(moved.rootNode.axis).toBe("vertical");
        expect(moved.rootNode.children[0]?.type).toBe("pane");
        expect(moved.rootNode.children[1]?.type).toBe("pane");
        if (moved.rootNode.children[0]?.type === "pane") {
            expect(moved.rootNode.children[0].id).toBe("pane-2");
            expect(moved.rootNode.children[0].tabIds).toEqual(["tab-2"]);
        }
        if (moved.rootNode.children[1]?.type === "pane") {
            expect(moved.rootNode.children[1].id).toBe("pane-3");
            expect(moved.rootNode.children[1].tabIds).toEqual(["tab-1"]);
            expect(moved.rootNode.children[1].activeTabId).toBe("tab-1");
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

    it("closes an empty pane after closing its last tab", () => {
        const splitState = splitPaneInDirection(
            createDefaultWorkspaceState(),
            "pane-root",
            "right",
            {
                paneId: "pane-2",
                splitId: "split-1",
            },
        );
        const withLeftTab = attachTabToPane(
            splitState,
            "pane-root",
            makeChatTab("tab-1"),
        );
        const withRightTab = attachTabToPane(
            withLeftTab,
            "pane-2",
            makeChatTab("tab-2"),
        );

        const closed = closeWorkspaceTab(withRightTab, "tab-1");

        expect(closed.activePaneId).toBe("pane-2");
        expect(closed.rootNode.type).toBe("pane");
        if (closed.rootNode.type !== "pane") {
            return;
        }

        expect(closed.rootNode.id).toBe("pane-2");
        expect(closed.rootNode.tabIds).toEqual(["tab-2"]);
        expect(closed.rootNode.activeTabId).toBe("tab-2");
        expect(closed.tabsById["tab-1"]).toBeUndefined();
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
            null,
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
            null,
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

    it("marks file tabs with external disk changes", () => {
        const state = attachTabToPane(
            createDefaultWorkspaceState(),
            "pane-root",
            makeFileTab("file-1", "src/readme.md"),
        );

        const nextState = setFileTabExternalChange(
            state,
            "file-1",
            true,
            "Changed on disk.",
        );
        const tab = nextState.tabsById["file-1"];

        expect(tab?.kind).toBe("file");
        if (!tab || tab.kind !== "file") {
            return;
        }

        expect(tab.hasExternalChange).toBe(true);
        expect(tab.saveError).toBe("Changed on disk.");
    });

    it("clears external change state when replacing the file document", () => {
        const state = attachTabToPane(
            createDefaultWorkspaceState(),
            "pane-root",
            {
                ...makeFileTab("file-1", "src/readme.md"),
                hasExternalChange: true,
                saveError: "Changed on disk.",
            },
        );

        const nextState = replaceFileDocument(state, "file-1", {
            absolutePath: "/tmp/src/readme.md",
            content: "updated",
            imageDataBase64: null,
            isBinary: false,
            isTooLarge: false,
            kind: "text",
            languageId: "markdown",
            languageLabel: "Markdown",
            modifiedAtMs: 2,
            mimeType: "text/markdown",
            name: "readme.md",
            projectId: "project-1",
            relativePath: "src/readme.md",
            sizeBytes: 7,
        });
        const tab = nextState.tabsById["file-1"];

        expect(tab?.kind).toBe("file");
        if (!tab || tab.kind !== "file") {
            return;
        }

        expect(tab.hasExternalChange).toBe(false);
        expect(tab.isDirty).toBe(false);
        expect(tab.saveError).toBeNull();
    });
});
