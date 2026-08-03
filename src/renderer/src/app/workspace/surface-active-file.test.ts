import { describe, expect, it } from "vitest";

import type {
    RuntimeWorkspaceFileTab,
    RuntimeWorkspaceTab,
    WorkspaceTreeState,
} from "./tree";
import {
    resolveWorkspaceSurfaceActiveFileState,
    updateWorkspaceActiveFilePaths,
} from "./surface-active-file";

const context = {
    key: "project-1::__primary__",
    projectId: "project-1",
    worktreeId: null,
} as const;

describe("workspace surface active file", () => {
    it("follows the active pane and clears for a non-file tab", () => {
        const leftFile = createFileTab("file-left", "src/left.ts");
        const rightFile = createFileTab("file-right", "src/right.ts");
        const chat = createChatTab("chat-right");
        const workspace = createSplitWorkspace(leftFile, rightFile, chat);

        expect(
            resolveWorkspaceSurfaceActiveFileState(workspace, context),
        ).toEqual({
            contextKey: context.key,
            projectId: context.projectId,
            relativePath: leftFile.relativePath,
            worktreeId: null,
        });

        const focusedRight = { ...workspace, activePaneId: "pane-right" };
        expect(
            resolveWorkspaceSurfaceActiveFileState(focusedRight, context)
                .relativePath,
        ).toBe(rightFile.relativePath);

        if (focusedRight.rootNode.type !== "split") {
            throw new Error("Expected a split workspace.");
        }
        const chatFocused: WorkspaceTreeState = {
            ...focusedRight,
            rootNode: {
                ...focusedRight.rootNode,
                children: [
                    focusedRight.rootNode.children[0],
                    {
                        activeTabId: chat.id,
                        id: "pane-right",
                        tabIds: [rightFile.id, chat.id],
                        type: "pane",
                    },
                ],
            },
        };
        expect(
            resolveWorkspaceSurfaceActiveFileState(chatFocused, context)
                .relativePath,
        ).toBeNull();
    });

    it("ignores a file from another project and updates host state by context", () => {
        const foreignFile = createFileTab(
            "foreign-file",
            "src/foreign.ts",
            "project-2",
        );
        const workspace: WorkspaceTreeState = {
            activePaneId: "pane-root",
            rootNode: {
                activeTabId: foreignFile.id,
                id: "pane-root",
                tabIds: [foreignFile.id],
                type: "pane",
            },
            tabsById: { [foreignFile.id]: foreignFile },
        };
        const cleared = resolveWorkspaceSurfaceActiveFileState(workspace, context);

        expect(cleared.relativePath).toBeNull();
        const current = { [context.key]: "src/old.ts" };
        const updated = updateWorkspaceActiveFilePaths(current, cleared);
        expect(updated).toEqual({ [context.key]: null });
        expect(updateWorkspaceActiveFilePaths(updated, cleared)).toBe(updated);
    });
});

function createSplitWorkspace(
    leftFile: RuntimeWorkspaceFileTab,
    rightFile: RuntimeWorkspaceFileTab,
    chat: RuntimeWorkspaceTab,
): WorkspaceTreeState {
    return {
        activePaneId: "pane-left",
        rootNode: {
            axis: "horizontal",
            children: [
                {
                    activeTabId: leftFile.id,
                    id: "pane-left",
                    tabIds: [leftFile.id],
                    type: "pane",
                },
                {
                    activeTabId: rightFile.id,
                    id: "pane-right",
                    tabIds: [rightFile.id, chat.id],
                    type: "pane",
                },
            ],
            id: "split-root",
            sizes: [0.5, 0.5],
            type: "split",
        },
        tabsById: {
            [chat.id]: chat,
            [leftFile.id]: leftFile,
            [rightFile.id]: rightFile,
        },
    };
}

function createChatTab(id: string): RuntimeWorkspaceTab {
    return {
        createdAt: "2026-08-03T00:00:00.000Z",
        draft: "",
        id,
        kind: "chat",
        projectId: "project-1",
        runtimeId: "codex",
        sessionId: `session-${id}`,
        title: "Chat",
        worktreeId: null,
    };
}

function createFileTab(
    id: string,
    relativePath: string,
    projectId = "project-1",
): RuntimeWorkspaceFileTab {
    return {
        createdAt: "2026-08-03T00:00:00.000Z",
        document: null,
        draftContent: "",
        hasExternalChange: false,
        id,
        isDirty: false,
        isLoading: false,
        isSaving: false,
        kind: "file",
        loadError: null,
        projectId,
        relativePath,
        reviewContext: null,
        saveError: null,
        savedContent: "",
        title: relativePath,
        worktreeId: null,
    };
}
