import { describe, expect, it } from "vitest";

import type { RuntimeWorkspaceChatTab } from "@renderer/app/workspace/tree";

import { getChatSessionPreparationKey } from "./chatSessionPreparation";

function createTab(
    overrides: Partial<RuntimeWorkspaceChatTab> = {},
): RuntimeWorkspaceChatTab {
    return {
        createdAt: "2026-07-09T20:00:00.000Z",
        draft: "",
        id: "chat-tab-1",
        kind: "chat",
        projectId: "project-1",
        runtimeId: "codex",
        sessionId: "session-1",
        sessionOpenMode: "live",
        title: "Original title",
        worktreeId: null,
        ...overrides,
    };
}

describe("getChatSessionPreparationKey", () => {
    it("does not treat a title rename as a session lifecycle change", () => {
        expect(
            getChatSessionPreparationKey(createTab()),
        ).toBe(
            getChatSessionPreparationKey(
                createTab({ title: "Renamed while streaming" }),
            ),
        );
    });

    it("changes when the session launch identity changes", () => {
        const currentKey = getChatSessionPreparationKey(createTab());

        expect(
            getChatSessionPreparationKey(
                createTab({ sessionOpenMode: "history" }),
            ),
        ).not.toBe(currentKey);
        expect(
            getChatSessionPreparationKey(createTab({ sessionId: "session-2" })),
        ).not.toBe(currentKey);
    });
});
