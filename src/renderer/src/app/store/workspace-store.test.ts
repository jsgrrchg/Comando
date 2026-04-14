import { describe, expect, it } from "vitest";

import type { WorkspaceTreeState } from "../workspace/tree";
import {
    getBestMatchingChatTabId,
    getPaneChatTabId,
    getPaneRuntimeId,
    getWorkspaceChatTabId,
    getWorkspaceTabRuntimeId,
} from "./workspace-store";

describe("workspace runtime focus helpers", () => {
    it("returns the runtime for chat and review tabs only", () => {
        expect(
            getWorkspaceTabRuntimeId({
                createdAt: "2026-04-14T00:00:00.000Z",
                draft: "",
                id: "chat-1",
                kind: "chat",
                projectId: null,
                runtimeId: "claude",
                sessionId: "session-1",
                title: "Claude 1",
                worktreeId: null,
            }),
        ).toBe("claude");

        expect(
            getWorkspaceTabRuntimeId({
                createdAt: "2026-04-14T00:00:00.000Z",
                id: "review-1",
                kind: "review",
                projectId: null,
                runtimeId: "gemini",
                sessionId: "session-2",
                title: "Review",
                worktreeId: null,
            }),
        ).toBe("gemini");

        expect(
            getWorkspaceTabRuntimeId({
                createdAt: "2026-04-14T00:00:00.000Z",
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
                relativePath: "notes.md",
                reviewContext: null,
                saveError: null,
                savedContent: "",
                title: "notes.md",
                worktreeId: null,
            }),
        ).toBeNull();
    });

    it("returns the chat tab id for chat tabs only", () => {
        expect(
            getWorkspaceChatTabId({
                createdAt: "2026-04-14T00:00:00.000Z",
                draft: "",
                id: "chat-1",
                kind: "chat",
                projectId: null,
                runtimeId: "claude",
                sessionId: "session-1",
                title: "Claude 1",
                worktreeId: null,
            }),
        ).toBe("chat-1");

        expect(
            getWorkspaceChatTabId({
                createdAt: "2026-04-14T00:00:00.000Z",
                id: "review-1",
                kind: "review",
                projectId: null,
                runtimeId: "gemini",
                sessionId: "session-2",
                title: "Review",
                worktreeId: null,
            }),
        ).toBeNull();
    });

    it("finds the runtime from the active tab in a pane", () => {
        const state: WorkspaceTreeState = {
            activePaneId: "pane-a",
            rootNode: {
                axis: "horizontal",
                children: [
                    {
                        activeTabId: "chat-1",
                        id: "pane-a",
                        tabIds: ["chat-1"],
                        type: "pane",
                    },
                    {
                        activeTabId: "file-1",
                        id: "pane-b",
                        tabIds: ["file-1"],
                        type: "pane",
                    },
                ],
                id: "split-1",
                sizes: [0.5, 0.5],
                type: "split",
            },
            tabsById: {
                "chat-1": {
                    createdAt: "2026-04-14T00:00:00.000Z",
                    draft: "",
                    id: "chat-1",
                    kind: "chat",
                    projectId: null,
                    runtimeId: "kilo",
                    sessionId: "session-1",
                    title: "Kilo 1",
                    worktreeId: null,
                },
                "file-1": {
                    createdAt: "2026-04-14T00:00:00.000Z",
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
                    relativePath: "README.md",
                    reviewContext: null,
                    saveError: null,
                    savedContent: "",
                    title: "README.md",
                    worktreeId: null,
                },
            },
        };

        expect(getPaneRuntimeId(state, "pane-a")).toBe("kilo");
        expect(getPaneRuntimeId(state, "pane-b")).toBeNull();
        expect(getPaneRuntimeId(state, "missing-pane")).toBeNull();
    });

    it("finds the active chat tab id in a pane", () => {
        const state: WorkspaceTreeState = {
            activePaneId: "pane-a",
            rootNode: {
                axis: "horizontal",
                children: [
                    {
                        activeTabId: "chat-1",
                        id: "pane-a",
                        tabIds: ["chat-1"],
                        type: "pane",
                    },
                    {
                        activeTabId: "file-1",
                        id: "pane-b",
                        tabIds: ["file-1"],
                        type: "pane",
                    },
                ],
                id: "split-1",
                sizes: [0.5, 0.5],
                type: "split",
            },
            tabsById: {
                "chat-1": {
                    createdAt: "2026-04-14T00:00:00.000Z",
                    draft: "",
                    id: "chat-1",
                    kind: "chat",
                    projectId: null,
                    runtimeId: "kilo",
                    sessionId: "session-1",
                    title: "Kilo 1",
                    worktreeId: null,
                },
                "file-1": {
                    createdAt: "2026-04-14T00:00:00.000Z",
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
                    relativePath: "README.md",
                    reviewContext: null,
                    saveError: null,
                    savedContent: "",
                    title: "README.md",
                    worktreeId: null,
                },
            },
        };

        expect(getPaneChatTabId(state, "pane-a")).toBe("chat-1");
        expect(getPaneChatTabId(state, "pane-b")).toBeNull();
        expect(getPaneChatTabId(state, "missing-pane")).toBeNull();
    });

    it("ignores the last focused chat when it belongs to another worktree", () => {
        const state: WorkspaceTreeState = {
            activePaneId: "pane-file",
            rootNode: {
                axis: "horizontal",
                children: [
                    {
                        activeTabId: "file-1",
                        id: "pane-file",
                        tabIds: ["file-1", "chat-root"],
                        type: "pane",
                    },
                    {
                        activeTabId: "chat-worktree",
                        id: "pane-chat",
                        tabIds: ["chat-worktree"],
                        type: "pane",
                    },
                ],
                id: "split-1",
                sizes: [0.5, 0.5],
                type: "split",
            },
            tabsById: {
                "chat-root": {
                    createdAt: "2026-04-14T00:00:00.000Z",
                    draft: "",
                    id: "chat-root",
                    kind: "chat",
                    projectId: "project-1",
                    runtimeId: "codex",
                    sessionId: "session-root",
                    title: "Codex Root",
                    worktreeId: null,
                },
                "chat-worktree": {
                    createdAt: "2026-04-14T00:00:00.000Z",
                    draft: "",
                    id: "chat-worktree",
                    kind: "chat",
                    projectId: "project-1",
                    runtimeId: "codex",
                    sessionId: "session-worktree",
                    title: "Codex Worktree",
                    worktreeId: "worktree-1",
                },
                "file-1": {
                    createdAt: "2026-04-14T00:00:00.000Z",
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
                    relativePath: "README.md",
                    reviewContext: null,
                    saveError: null,
                    savedContent: "",
                    title: "README.md",
                    worktreeId: "worktree-1",
                },
            },
        };

        expect(
            getBestMatchingChatTabId(state, {
                currentPaneId: "pane-file",
                lastFocusedChatTabId: "chat-root",
                projectId: "project-1",
                worktreeId: "worktree-1",
            }),
        ).toBe("chat-worktree");
    });
});
