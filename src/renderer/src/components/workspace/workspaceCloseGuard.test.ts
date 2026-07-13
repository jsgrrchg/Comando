import { describe, expect, it } from "vitest";

import type { RuntimeWorkspaceTab } from "@renderer/app/workspace/tree";

import {
    closeWorkspaceTabsWithConfirmation,
    getWorkspaceTabCloseConfirmationMessage,
} from "./workspaceCloseGuard";

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

function createFileTab(
    id: string,
    isDirty: boolean,
): Extract<RuntimeWorkspaceTab, { kind: "file" }> {
    return {
        createdAt: "2026-04-19T00:00:00.000Z",
        document: null,
        draftContent: isDirty ? "unsaved" : "",
        hasExternalChange: false,
        id,
        isDirty,
        isLoading: false,
        isSaving: false,
        kind: "file",
        loadError: null,
        projectId: "project-1",
        relativePath: `${id}.ts`,
        reviewContext: null,
        saveError: null,
        savedContent: "",
        title: `${id}.ts`,
        worktreeId: null,
    };
}

describe("getWorkspaceTabCloseConfirmationMessage", () => {
    it("does not ask for confirmation when closing a busy chat tab", () => {
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
        ).toBeNull();
    });

    it("does not treat closing multiple tabs as stopping live agents", () => {
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
        ).toBeNull();
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

    it("warns before a workspace discards dirty files", async () => {
        const tabsById = {
            "file-1": createFileTab("file-1", true),
            "file-2": createFileTab("file-2", false),
        };
        let closed = false;

        expect(
            getWorkspaceTabCloseConfirmationMessage({
                sessions: {},
                tabIds: Object.keys(tabsById),
                tabsById,
            }),
        ).toBe(
            "This workspace contains an unsaved file. Close it and discard the changes?",
        );

        await closeWorkspaceTabsWithConfirmation(
            Object.keys(tabsById),
            () => {
                closed = true;
                return Promise.resolve();
            },
            {
                confirm: () => false,
                tabsById,
            },
        );

        expect(closed).toBe(false);
    });
});
