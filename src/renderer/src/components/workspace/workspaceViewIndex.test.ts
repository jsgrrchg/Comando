import { describe, expect, it } from "vitest";

import type { RuntimeWorkspaceTab } from "@renderer/app/workspace/tree";
import type { WorkspaceNode } from "@shared/ipc";

import {
    getIndexedWorkspaceHasChat,
    getIndexedWorkspaceNode,
    getIndexedWorkspacePaneCount,
} from "./workspaceViewIndex";

const ROOT: WorkspaceNode = {
    axis: "horizontal",
    children: [
        {
            activeTabId: "chat-1",
            id: "pane-left",
            pinnedTabIds: [],
            tabIds: ["chat-1"],
            type: "pane",
        },
        {
            axis: "vertical",
            children: [
                {
                    activeTabId: null,
                    id: "pane-top-right",
                    pinnedTabIds: [],
                    tabIds: [],
                    type: "pane",
                },
                {
                    activeTabId: null,
                    id: "pane-bottom-right",
                    pinnedTabIds: [],
                    tabIds: [],
                    type: "pane",
                },
            ],
            id: "split-right",
            sizes: [0.5, 0.5],
            type: "split",
        },
    ],
    id: "split-root",
    sizes: [0.5, 0.5],
    type: "split",
};

describe("workspaceViewIndex", () => {
    it("indexes nested workspace nodes and pane metadata", () => {
        expect(getIndexedWorkspaceNode(ROOT, "split-right")).toBe(
            ROOT.children[1],
        );
        expect(getIndexedWorkspaceNode(ROOT, "pane-bottom-right")).toBe(
            ROOT.children[1]?.type === "split"
                ? ROOT.children[1].children[1]
                : null,
        );
        expect(getIndexedWorkspaceNode(ROOT, "missing")).toBeNull();
        expect(getIndexedWorkspacePaneCount(ROOT)).toBe(3);
    });

    it("derives chat presence from a tabs snapshot", () => {
        const tabsWithoutChat = {
            terminal: { kind: "terminal" },
        } as unknown as Record<string, RuntimeWorkspaceTab>;
        const tabsWithChat = {
            ...tabsWithoutChat,
            chat: { kind: "chat" },
        } as unknown as Record<string, RuntimeWorkspaceTab>;

        expect(getIndexedWorkspaceHasChat(tabsWithoutChat)).toBe(false);
        expect(getIndexedWorkspaceHasChat(tabsWithChat)).toBe(true);
    });
});
