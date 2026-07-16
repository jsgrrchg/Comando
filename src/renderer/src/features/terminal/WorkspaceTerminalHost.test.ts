import { describe, expect, it } from "vitest";

import type { WorkspaceNode } from "@shared/ipc";

import {
    getOpenContextTerminalIds,
    getReadyActiveWorkspaceTabIds,
} from "./WorkspaceTerminalHost";

describe("getReadyActiveWorkspaceTabIds", () => {
    it("excludes active tabs whose pane is still deferred", () => {
        const rootNode: WorkspaceNode = {
            axis: "horizontal",
            children: [
                {
                    activeTabId: "terminal-focused",
                    id: "pane-focused",
                    tabIds: ["terminal-focused"],
                    type: "pane",
                },
                {
                    activeTabId: "terminal-background",
                    id: "pane-background",
                    tabIds: ["terminal-background"],
                    type: "pane",
                },
            ],
            id: "split-root",
            sizes: [0.5, 0.5],
            type: "split",
        };

        expect(
            getReadyActiveWorkspaceTabIds(
                rootNode,
                new Set(["pane-background"]),
                "pane-focused",
            ),
        ).toEqual(new Set(["terminal-focused"]));
        expect(
            getReadyActiveWorkspaceTabIds(
                rootNode,
                new Set(["pane-background"]),
                "pane-background",
            ),
        ).toEqual(new Set(["terminal-focused", "terminal-background"]));
        expect(
            getReadyActiveWorkspaceTabIds(
                rootNode,
                new Set(),
                "pane-focused",
            ),
        ).toEqual(new Set(["terminal-focused", "terminal-background"]));
    });
});

describe("getOpenContextTerminalIds", () => {
    it("does not retain terminals from cached closed contexts", () => {
        const contextsByKey = {
            active: {
                workspace: {
                    tabsById: {
                        active: { kind: "terminal", terminalId: "terminal-active" },
                    },
                },
            },
            open: {
                workspace: {
                    tabsById: {
                        open: { kind: "terminal", terminalId: "terminal-open" },
                    },
                },
            },
            closed: {
                workspace: {
                    tabsById: {
                        closed: { kind: "terminal", terminalId: "terminal-closed" },
                    },
                },
            },
        };

        expect(getOpenContextTerminalIds(contextsByKey, ["active", "open"], "active")).toEqual([
            "terminal-open",
        ]);
    });
});
