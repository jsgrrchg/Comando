import { describe, expect, it, vi } from "vitest";

import { persistChatDraftForTab } from "./chatDraftPersistence";

describe("persistChatDraftForTab", () => {
    it("persists the draft into the originating chat tab", () => {
        const updateChatDraft = vi.fn(async () => {});

        persistChatDraftForTab(
            updateChatDraft,
            "chat-tab-origin",
            "Unsaved draft",
        );

        expect(updateChatDraft).toHaveBeenCalledTimes(1);
        expect(updateChatDraft).toHaveBeenCalledWith(
            "chat-tab-origin",
            "Unsaved draft",
        );
    });
});
