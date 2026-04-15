import { describe, expect, it } from "vitest";

import type { WorkspaceTreeState } from "../workspace/tree";
import { resolveAppearanceProjectId } from "./use-system-theme";

function createWorkspaceState(
    overrides: Partial<WorkspaceTreeState> = {},
): WorkspaceTreeState {
    return {
        activePaneId: "pane-root",
        rootNode: {
            activeTabId: null,
            id: "pane-root",
            tabIds: [],
            type: "pane",
        },
        tabsById: {},
        ...overrides,
    };
}

describe("resolveAppearanceProjectId", () => {
    it("uses the active tab project when available", () => {
        const workspaceState = createWorkspaceState({
            rootNode: {
                activeTabId: "file-1",
                id: "pane-root",
                tabIds: ["file-1"],
                type: "pane",
            },
            tabsById: {
                "file-1": {
                    createdAt: "2026-04-15T00:00:00.000Z",
                    document: null,
                    draftContent: "",
                    hasExternalChange: false,
                    id: "file-1",
                    isDirty: false,
                    isLoading: false,
                    isSaving: false,
                    kind: "file",
                    loadError: null,
                    projectId: "project-b",
                    relativePath: "src/index.ts",
                    reviewContext: null,
                    saveError: null,
                    savedContent: "",
                    title: "index.ts",
                },
            },
        });

        expect(resolveAppearanceProjectId("project-a", workspaceState)).toBe(
            "project-b",
        );
    });

    it("falls back to the active project when the tab has no project", () => {
        const workspaceState = createWorkspaceState({
            rootNode: {
                activeTabId: "chat-1",
                id: "pane-root",
                tabIds: ["chat-1"],
                type: "pane",
            },
            tabsById: {
                "chat-1": {
                    createdAt: "2026-04-15T00:00:00.000Z",
                    draft: "",
                    id: "chat-1",
                    kind: "chat",
                    projectId: null,
                    runtimeId: "codex",
                    sessionId: "session-1",
                    title: "Chat",
                },
            },
        });

        expect(resolveAppearanceProjectId("project-a", workspaceState)).toBe(
            "project-a",
        );
    });

    it("keeps fallback when no active tab exists", () => {
        const workspaceState = createWorkspaceState();

        expect(resolveAppearanceProjectId("project-a", workspaceState)).toBe(
            "project-a",
        );
    });
});
