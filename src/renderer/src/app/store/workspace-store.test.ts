import { describe, expect, it } from "vitest";

import type { WorkspaceTreeState } from "../workspace/tree";
import {
    getPaneRuntimeId,
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
});
