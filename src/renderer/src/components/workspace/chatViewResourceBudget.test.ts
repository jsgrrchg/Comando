import { describe, expect, it } from "vitest";

import {
    MAX_ADDITIONAL_HOT_CHAT_TAB_VIEWS,
    resolveHotChatTabIds,
} from "./chatViewResourceBudget";
import { createChatPerformanceWorkspaceFixture } from "./chat/chatPerformanceFixtures";

describe("resolveHotChatTabIds", () => {
    it("cools the retained tabs from the four-pane performance fixture", () => {
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

    it("shares retained views across panes instead of multiplying the local limit", () => {
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
