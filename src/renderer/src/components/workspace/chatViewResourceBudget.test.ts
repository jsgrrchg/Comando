import { describe, expect, it } from "vitest";

import {
    MAX_ADDITIONAL_HOT_CHAT_TAB_VIEWS,
    resolveHotChatTabIds,
} from "./chatViewResourceBudget";

describe("resolveHotChatTabIds", () => {
    it("shares retained views across panes instead of multiplying the local limit", () => {
        const chatTabIds = new Set(
            Array.from({ length: 16 }, (_, index) => `chat-${index + 1}`),
        );
        const panes = Array.from({ length: 4 }, (_, index) => ({
            activeTabId: `chat-${index + 1}`,
            id: `pane-${index + 1}`,
            visible: true,
        }));

        const hotTabIds = resolveHotChatTabIds({
            chatTabIds,
            focusedPaneId: "pane-1",
            panes,
            recentActiveTabIds: Array.from(
                { length: 16 },
                (_, index) => `chat-${index + 1}`,
            ),
        });

        expect(hotTabIds).toEqual(
            new Set([
                "chat-1",
                "chat-2",
                "chat-3",
                "chat-4",
                "chat-5",
                "chat-6",
                "chat-7",
                "chat-8",
                "chat-9",
                "chat-10",
                "chat-11",
                "chat-12",
            ]),
        );
        expect(hotTabIds.size).toBe(4 + MAX_ADDITIONAL_HOT_CHAT_TAB_VIEWS);
    });

    it("protects visible active chats and ejects the least recent hidden view", () => {
        const recentlyVisited = Array.from(
            { length: MAX_ADDITIONAL_HOT_CHAT_TAB_VIEWS - 1 },
            (_, index) => `recent-${index + 1}`,
        );
        const chatTabIds = new Set([
            "focused",
            "new-active",
            ...recentlyVisited,
            "old",
        ]);
        const initial = resolveHotChatTabIds({
            chatTabIds,
            focusedPaneId: "pane-a",
            panes: [
                { activeTabId: "focused", id: "pane-a", visible: true },
                { activeTabId: null, id: "pane-b", visible: true },
            ],
            recentActiveTabIds: ["focused", ...recentlyVisited, "old"],
        });
        const afterActivation = resolveHotChatTabIds({
            chatTabIds,
            focusedPaneId: "pane-b",
            panes: [
                { activeTabId: "focused", id: "pane-a", visible: true },
                { activeTabId: "new-active", id: "pane-b", visible: true },
            ],
            recentActiveTabIds: ["new-active", "focused", ...recentlyVisited],
        });

        expect(initial).toEqual(
            new Set(["focused", ...recentlyVisited, "old"]),
        );
        expect(afterActivation).toEqual(
            new Set(["new-active", "focused", ...recentlyVisited]),
        );
        expect(afterActivation.has("old")).toBe(false);
    });

    it("does not heat a chat whose pane is still deferred", () => {
        const hotTabIds = resolveHotChatTabIds({
            chatTabIds: new Set(["visible", "deferred"]),
            focusedPaneId: "pane-visible",
            panes: [
                { activeTabId: "visible", id: "pane-visible", visible: true },
                { activeTabId: "deferred", id: "pane-deferred", visible: false },
            ],
            recentActiveTabIds: ["visible"],
        });

        expect(hotTabIds).toEqual(new Set(["visible"]));
    });
});
