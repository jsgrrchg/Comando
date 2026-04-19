import { describe, expect, it } from "vitest";

import type { RuntimeWorkspaceTab } from "@renderer/app/workspace/tree";

import { getWorkspaceTabCloseConfirmationMessage } from "./workspaceCloseGuard";

function createChatTab(
    id: string,
    sessionId: string,
): Extract<RuntimeWorkspaceTab, { kind: "chat" }> {
    return {
        createdAt: "2026-04-19T00:00:00.000Z",
        draft: "",
        id,
        kind: "chat",
        projectId: "project-1",
        runtimeId: "codex",
        sessionId,
        title: `Chat ${id}`,
        worktreeId: null,
    };
}

describe("getWorkspaceTabCloseConfirmationMessage", () => {
    it("returns a confirmation message for a busy chat tab", () => {
        expect(
            getWorkspaceTabCloseConfirmationMessage({
                sessions: {
                    "session-1": {
                        localError: null,
                        snapshot: { status: "streaming" },
                    },
                },
                tabIds: ["chat-1"],
                tabsById: {
                    "chat-1": createChatTab("chat-1", "session-1"),
                },
            }),
        ).toBe("This thread is working. Stop the agent and close anyway?");
    });

    it("counts only busy chat tabs when closing multiple tabs", () => {
        expect(
            getWorkspaceTabCloseConfirmationMessage({
                sessions: {
                    "session-1": {
                        localError: null,
                        snapshot: { status: "starting" },
                    },
                    "session-2": {
                        localError: null,
                        snapshot: { status: "idle" },
                    },
                },
                tabIds: ["chat-1", "chat-2", "file-1"],
                tabsById: {
                    "chat-1": createChatTab("chat-1", "session-1"),
                    "chat-2": createChatTab("chat-2", "session-2"),
                    "file-1": {
                        createdAt: "2026-04-19T00:00:00.000Z",
                        document: null,
                        draftContent: "",
                        hasExternalChange: false,
                        id: "file-1",
                        isDirty: false,
                        isLoading: false,
                        isSaving: false,
                        kind: "file",
                        loadError: null,
                        projectId: "project-1",
                        relativePath: "src/app.tsx",
                        reviewContext: null,
                        saveError: null,
                        savedContent: "",
                        title: "app.tsx",
                        worktreeId: null,
                    },
                },
            }),
        ).toBe("This thread is working. Stop the agent and close anyway?");
    });

    it("returns null when no busy chat tabs are being closed", () => {
        expect(
            getWorkspaceTabCloseConfirmationMessage({
                sessions: {
                    "session-1": {
                        localError: null,
                        snapshot: { status: "idle" },
                    },
                },
                tabIds: ["chat-1"],
                tabsById: {
                    "chat-1": createChatTab("chat-1", "session-1"),
                },
            }),
        ).toBeNull();
    });
});
