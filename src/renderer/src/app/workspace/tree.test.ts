import { describe, expect, it } from "vitest";

import {
    attachTabToPane,
    closeOtherWorkspaceTabs,
    closeWorkspacePane,
    closeWorkspaceTabsToRight,
    createDefaultWorkspaceState,
    moveActiveTabBetweenPanes,
    moveWorkspaceTabBetweenPanes,
    splitPaneInDirection,
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
});
