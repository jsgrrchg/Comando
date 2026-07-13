import { describe, expect, it } from "vitest";

import type { RuntimeWorkspaceTab } from "@renderer/app/workspace/tree";

import {
    closeWorkspaceContextWithConfirmation,
    closeWorkspaceTabsWithConfirmation,
    getWorkspaceCloseSummary,
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

describe("getWorkspaceCloseSummary", () => {
    it("protects active agents that belong to the workspace, including subagents without tabs", () => {
        expect(
            getWorkspaceCloseSummary({
                projectId: "project-1",
                sessions: {
                    "session-1": {
                        meta: {
                            projectId: "project-1",
                            title: "Parent",
                            worktreeId: null,
                        },
                        snapshot: {
                            projectId: "project-1",
                            sessionId: "session-1",
                            status: "streaming",
                            title: "Parent",
                            worktreeId: null,
                        },
                    },
                    "subagent-1": {
                        meta: {
                            projectId: "project-1",
                            title: "Ada",
                            worktreeId: null,
                        },
                        snapshot: {
                            projectId: "project-1",
                            sessionId: "subagent-1",
                            status: "waiting_permission",
                            title: "Ada",
                            worktreeId: null,
                        },
                    },
                    "other-worktree": {
                        meta: {
                            projectId: "project-1",
                            title: "Other worktree",
                            worktreeId: "worktree-2",
                        },
                        snapshot: {
                            projectId: "project-1",
                            sessionId: "other-worktree",
                            status: "streaming",
                            title: "Other worktree",
                            worktreeId: "worktree-2",
                        },
                    },
                },
                tabsById: {
                    "chat-1": createChatTab("chat-1", "session-1"),
                    "file-1": createFileTab("file-1", true),
                },
                worktreeId: null,
            }),
        ).toEqual({
            activeAgentCount: 2,
            dirtyFileCount: 1,
        });
    });

    it("does not request confirmation when the workspace is safe to close", async () => {
        let closed = false;
        let confirmationRequested = false;

        await closeWorkspaceContextWithConfirmation(
            {
                projectId: "project-1",
                sessions: {},
                tabsById: { "file-1": createFileTab("file-1", false) },
                worktreeId: null,
            },
            () => {
                closed = true;
                return Promise.resolve();
            },
            {
                confirm: () => {
                    confirmationRequested = true;
                    return Promise.resolve(false);
                },
            },
        );

        expect(closed).toBe(true);
        expect(confirmationRequested).toBe(false);
    });

    it("keeps the workspace open when native confirmation is declined", async () => {
        let closed = false;

        await closeWorkspaceContextWithConfirmation(
            {
                projectId: "project-1",
                sessions: {
                    "session-1": {
                        meta: {
                            projectId: "project-1",
                            title: "Agent",
                            worktreeId: null,
                        },
                        snapshot: {
                            projectId: "project-1",
                            sessionId: "session-1",
                            status: "starting",
                            title: "Agent",
                            worktreeId: null,
                        },
                    },
                },
                tabsById: {},
                worktreeId: null,
            },
            () => {
                closed = true;
                return Promise.resolve();
            },
            { confirm: () => Promise.resolve(false) },
        );

        expect(closed).toBe(false);
    });
});
