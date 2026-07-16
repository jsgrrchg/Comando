import { describe, expect, it } from "vitest";

import {
    MAX_ADDITIONAL_HOT_CHAT_TAB_VIEWS,
    resolveHotChatTabIds,
} from "./chatViewResourceBudget";
import { createChatPerformanceWorkspaceFixture } from "./chat/chatPerformanceFixtures";

describe("resolveHotChatTabIds", () => {
    it("keeps only visible active chats mounted from the four-pane fixture", () => {
        const fixture = createChatPerformanceWorkspaceFixture();
        const hotTabIds = resolveHotChatTabIds({
            focusedPaneId: fixture.panes[0]?.id ?? "",
            panes: fixture.panes.map((pane) => ({
                activeTabId: pane.activeSessionId,
                chatTabIds: pane.retainedSessionIds,
                id: pane.id,
                visible: true,
            })),
            recentActiveTabIds: fixture.panes.flatMap(
                (pane) => pane.retainedSessionIds,
            ),
        });

        expect(hotTabIds.size).toBe(4 + MAX_ADDITIONAL_HOT_CHAT_TAB_VIEWS);
        expect(
            fixture.panes.every((pane) => hotTabIds.has(pane.activeSessionId)),
        ).toBe(true);
    });

    it("does not retain inactive transcript trees across panes", () => {
        const panes = Array.from({ length: 4 }, (_, index) => ({
            activeTabId: `chat-${index + 1}`,
            chatTabIds: [
                `chat-${index + 1}`,
                ...Array.from(
                    { length: 3 },
                    (_, tabIndex) => `chat-${index * 3 + tabIndex + 5}`,
                ),
            ],
            id: `pane-${index + 1}`,
            visible: true,
        }));

        const hotTabIds = resolveHotChatTabIds({
            focusedPaneId: "pane-1",
            panes,
            recentActiveTabIds: Array.from(
                { length: 16 },
                (_, index) => `chat-${index + 1}`,
            ),
        });

        expect(hotTabIds).toEqual(
            new Set(["chat-1", "chat-2", "chat-3", "chat-4"]),
        );
        expect(hotTabIds.size).toBe(4 + MAX_ADDITIONAL_HOT_CHAT_TAB_VIEWS);
    });

    it("keeps recent inactive chats warm without mounting them", () => {
        const recentlyVisited = ["recent-1", "recent-2"];
        const initial = resolveHotChatTabIds({
            focusedPaneId: "pane-a",
            panes: [
                {
                    activeTabId: "focused",
                    chatTabIds: ["focused", ...recentlyVisited, "old"],
                    id: "pane-a",
                    visible: true,
                },
                {
                    activeTabId: null,
                    chatTabIds: [],
                    id: "pane-b",
                    visible: true,
                },
            ],
            recentActiveTabIds: ["focused", ...recentlyVisited, "old"],
        });
        const afterActivation = resolveHotChatTabIds({
            focusedPaneId: "pane-b",
            panes: [
                {
                    activeTabId: "focused",
                    chatTabIds: ["focused", ...recentlyVisited, "old"],
                    id: "pane-a",
                    visible: true,
                },
                {
                    activeTabId: "new-active",
                    chatTabIds: ["new-active"],
                    id: "pane-b",
                    visible: true,
                },
            ],
            recentActiveTabIds: ["new-active", "focused", ...recentlyVisited],
        });

        expect(initial).toEqual(new Set(["focused"]));
        expect(afterActivation).toEqual(new Set(["new-active", "focused"]));
        expect(afterActivation.has("old")).toBe(false);
    });

    it("does not heat a chat whose pane is still deferred", () => {
        const hotTabIds = resolveHotChatTabIds({
            focusedPaneId: "pane-visible",
            panes: [
                {
                    activeTabId: "visible",
                    chatTabIds: ["visible"],
                    id: "pane-visible",
                    visible: true,
                },
                {
                    activeTabId: "deferred",
                    chatTabIds: ["deferred"],
                    id: "pane-deferred",
                    visible: false,
                },
            ],
            recentActiveTabIds: ["deferred", "visible"],
        });

        expect(hotTabIds).toEqual(new Set(["visible"]));
    });
});
