import { describe, expect, it } from "vitest";

import {
    attachTabToPane,
    closeOtherWorkspaceTabs,
    closeWorkspaceTab,
    closeWorkspacePane,
    closeWorkspaceTabsForProjectPath,
    closeWorkspaceTabsToRight,
    createDefaultWorkspaceState,
    moveTabToPaneAtIndex,
    moveTabToSplit,
    moveActiveTabBetweenPanes,
    moveWorkspaceTabBetweenPanes,
    pinTabInPane,
    reorderTabInPane,
    renameWorkspaceTabsForProjectPath,
    replaceFileDocument,
    selectAdjacentPaneTab,
    selectPaneTab,
    setFileTabExternalChange,
    setFileTabMarkdownPreviewScrollTop,
    setFileTabSaving,
    setFileTabViewState,
    splitPaneInDirection,
    unpinTabInPane,
    updateFileDraft,
    type RuntimeWorkspaceFileTab,
    type RuntimeWorkspaceTab,
    type WorkspaceTreeState,
    workspaceStateFromSnapshot,
    workspaceStateFromSerializedSnapshot,
    workspaceStateToSnapshot,
} from "./tree";

function makeChatTab(id: string): RuntimeWorkspaceTab {
    return {
        createdAt: "2026-04-12T00:00:00.000Z",
        draft: "",
        id,
        kind: "chat",
        projectId: null,
        runtimeId: "codex",
        sessionId: `session-${id}`,
        title: `Chat ${id}`,
    };
}

function makeFileTab(
    id: string,
    relativePath: string,
    projectId = "project-1",
): RuntimeWorkspaceFileTab {
    return {
        createdAt: "2026-04-12T00:00:00.000Z",
        contentRevision: 0,
        document: {
            absolutePath: `/tmp/${relativePath}`,
            content: "",
            imageDataBase64: null,
            isBinary: false,
            isTooLarge: false,
            kind: "text",
            languageId: "markdown",
            languageLabel: "Markdown",
            modifiedAtMs: 1,
            mimeType: "text/markdown",
            name: relativePath.split("/").at(-1) ?? relativePath,
            projectId,
            relativePath,
            sizeBytes: 0,
        },
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
        savedContent: "",
        saveError: null,
        title: relativePath.split("/").at(-1) ?? relativePath,
    };
}

describe("workspace tree helpers", () => {
    it("splits a pane and activates the new pane", () => {
        const state = splitPaneInDirection(
            createDefaultWorkspaceState(),
            "pane-root",
            "right",
            {
                paneId: "pane-2",
                splitId: "split-1",
            },
        );

        expect(state.activePaneId).toBe("pane-2");
        expect(state.rootNode.type).toBe("split");
        if (state.rootNode.type === "split") {
            expect(state.rootNode.axis).toBe("horizontal");
            expect(state.rootNode.children[0]?.id).toBe("pane-root");
            expect(state.rootNode.children[1]?.id).toBe("pane-2");
        }
    });

    it("creates a vertical split when splitting down", () => {
        const state = splitPaneInDirection(
            createDefaultWorkspaceState(),
            "pane-root",
            "down",
            {
                paneId: "pane-2",
                splitId: "split-1",
            },
        );

        expect(state.activePaneId).toBe("pane-2");
        expect(state.rootNode.type).toBe("split");
        if (state.rootNode.type === "split") {
            expect(state.rootNode.axis).toBe("vertical");
            expect(state.rootNode.children[0]?.id).toBe("pane-root");
            expect(state.rootNode.children[1]?.id).toBe("pane-2");
        }
    });

    it("persists chat history tabs when serializing the workspace snapshot", () => {
        const state = attachTabToPane(createDefaultWorkspaceState(), "pane-root", {
            createdAt: "2026-04-17T00:00:00.000Z",
            id: "history-tab-1",
            kind: "chat_history",
            projectId: "project-1",
            title: "History",
            worktreeId: "worktree-1",
        });

        expect(workspaceStateToSnapshot(state)).toEqual({
            activePaneId: "pane-root",
            rootNode: {
                activeTabId: "history-tab-1",
                id: "pane-root",
                tabIds: ["history-tab-1"],
                type: "pane",
            },
            tabs: [
                {
                    createdAt: "2026-04-17T00:00:00.000Z",
                    id: "history-tab-1",
                    kind: "chat_history",
                    projectId: "project-1",
                    title: "History",
                    worktreeId: "worktree-1",
                },
            ],
        });
    });

    it("places the new pane before the current pane when splitting up", () => {
        const state = splitPaneInDirection(
            createDefaultWorkspaceState(),
            "pane-root",
            "up",
            {
                paneId: "pane-2",
                splitId: "split-1",
            },
        );

        expect(state.activePaneId).toBe("pane-2");
        expect(state.rootNode.type).toBe("split");
        if (state.rootNode.type === "split") {
            expect(state.rootNode.axis).toBe("vertical");
            expect(state.rootNode.children[0]?.id).toBe("pane-2");
            expect(state.rootNode.children[1]?.id).toBe("pane-root");
        }
    });

    it("moves the active tab to the next pane", () => {
        const splitState = splitPaneInDirection(
            createDefaultWorkspaceState(),
            "pane-root",
            "right",
            {
                paneId: "pane-2",
                splitId: "split-1",
            },
        );
        const withTab = attachTabToPane(
            splitState,
            "pane-root",
            makeChatTab("tab-1"),
        );
        const moved = moveActiveTabBetweenPanes(withTab, "pane-root", "next");

        expect(moved.activePaneId).toBe("pane-2");
        const rootNode = moved.rootNode;
        expect(rootNode.type).toBe("pane");
        if (rootNode.type !== "pane") {
            return;
        }

        expect(rootNode.id).toBe("pane-2");
        expect(rootNode.tabIds).toEqual(["tab-1"]);
        expect(rootNode.activeTabId).toBe("tab-1");
    });

    it("moves a specific inactive tab to the previous pane", () => {
        const splitState = splitPaneInDirection(
            createDefaultWorkspaceState(),
            "pane-root",
            "right",
            {
                paneId: "pane-2",
                splitId: "split-1",
            },
        );
        const withFirstTab = attachTabToPane(
            splitState,
            "pane-root",
            makeChatTab("tab-1"),
        );
        const withSecondTab = attachTabToPane(
            withFirstTab,
            "pane-root",
            makeChatTab("tab-2"),
        );
        const withThirdTab = attachTabToPane(
            withSecondTab,
            "pane-2",
            makeChatTab("tab-3"),
        );
        const moved = moveWorkspaceTabBetweenPanes(
            withThirdTab,
            "tab-2",
            "next",
        );

        expect(moved.rootNode.type).toBe("split");
        if (moved.rootNode.type !== "split") {
            return;
        }

        const [leftPane, rightPane] = moved.rootNode.children;
        expect(leftPane.type).toBe("pane");
        expect(rightPane.type).toBe("pane");
        if (leftPane.type === "pane") {
            expect(leftPane.tabIds).toEqual(["tab-1"]);
        }
        if (rightPane.type === "pane") {
            expect(rightPane.tabIds).toEqual(["tab-3", "tab-2"]);
            expect(rightPane.activeTabId).toBe("tab-2");
        }
    });

    it("selects the next tab in the same pane with wrap-around", () => {
        const withFirstTab = attachTabToPane(
            createDefaultWorkspaceState(),
            "pane-root",
            makeChatTab("tab-1"),
        );
        const withSecondTab = attachTabToPane(
            withFirstTab,
            "pane-root",
            makeChatTab("tab-2"),
        );
        const withThirdTab = attachTabToPane(
            withSecondTab,
            "pane-root",
            makeChatTab("tab-3"),
        );

        const selected = selectAdjacentPaneTab(
            withThirdTab,
            "pane-root",
            "next",
        );

        expect(selected.rootNode.type).toBe("pane");
        if (selected.rootNode.type !== "pane") {
            return;
        }

        expect(selected.rootNode.activeTabId).toBe("tab-1");
        expect(selected.activePaneId).toBe("pane-root");
    });

    it("selects the previous tab in the same pane with wrap-around", () => {
        const withFirstTab = attachTabToPane(
            createDefaultWorkspaceState(),
            "pane-root",
            makeChatTab("tab-1"),
        );
        const withSecondTab = attachTabToPane(
            withFirstTab,
            "pane-root",
            makeChatTab("tab-2"),
        );
        const selectedSecond = selectAdjacentPaneTab(
            withSecondTab,
            "pane-root",
            "next",
        );

        const selected = selectAdjacentPaneTab(
            selectedSecond,
            "pane-root",
            "previous",
        );

        expect(selected.rootNode.type).toBe("pane");
        if (selected.rootNode.type !== "pane") {
            return;
        }

        expect(selected.rootNode.activeTabId).toBe("tab-2");
        expect(selected.activePaneId).toBe("pane-root");
    });

    it("preserves untouched split branches when selecting a tab", () => {
        const targetPane = {
            activeTabId: "tab-1",
            id: "pane-target",
            tabIds: ["tab-1", "tab-2"],
            type: "pane" as const,
        };
        const targetBranch = {
            axis: "vertical" as const,
            children: [targetPane],
            id: "split-target",
            sizes: [1],
            type: "split" as const,
        };
        const untouchedBranch = {
            axis: "vertical" as const,
            children: [
                {
                    activeTabId: "tab-3",
                    id: "pane-untouched",
                    tabIds: ["tab-3"],
                    type: "pane" as const,
                },
            ],
            id: "split-untouched",
            sizes: [1],
            type: "split" as const,
        };
        const state: WorkspaceTreeState = {
            activePaneId: targetPane.id,
            rootNode: {
                axis: "horizontal",
                children: [targetBranch, untouchedBranch],
                id: "split-root",
                sizes: [0.5, 0.5],
                type: "split",
            },
            tabsById: {
                "tab-1": makeChatTab("tab-1"),
                "tab-2": makeChatTab("tab-2"),
                "tab-3": makeChatTab("tab-3"),
            },
        };

        const selected = selectPaneTab(state, targetPane.id, "tab-2");

        expect(selected.rootNode.type).toBe("split");
        if (selected.rootNode.type !== "split") {
            return;
        }

        expect(selected.rootNode.children[1]).toBe(untouchedBranch);
    });

    it("omits transient file tabs from the persisted snapshot", () => {
        const state = attachTabToPane(
            attachTabToPane(
                createDefaultWorkspaceState(),
                "pane-root",
                makeChatTab("chat-1"),
            ),
            "pane-root",
            {
                ...makeFileTab("image-1", ".comando/chat-images/shot.png"),
                isTransient: true,
                title: "shot.png",
            },
        );

        const snapshot = workspaceStateToSnapshot(state);

        expect(snapshot.tabs).toEqual([
            {
                createdAt: "2026-04-12T00:00:00.000Z",
                draft: "",
                id: "chat-1",
                kind: "chat",
                projectId: null,
                runtimeId: "codex",
                sessionId: "session-chat-1",
                title: "Chat chat-1",
            },
        ]);
        expect(snapshot.rootNode).toEqual({
            activeTabId: "chat-1",
            id: "pane-root",
            tabIds: ["chat-1"],
            type: "pane",
        });
    });

    it("syncs shared file draft and save state across duplicate tabs", () => {
        const sourceTab = makeFileTab("file-1", "src/app.ts");
        const sourceViewState = {
            contributionsState: [],
            cursorState: [],
            viewState: { scrollTop: 120 },
        } as never;
        const duplicateViewState = {
            contributionsState: [],
            cursorState: [],
            viewState: { scrollTop: 360 },
        } as never;
        const duplicateTab: RuntimeWorkspaceFileTab = {
            ...makeFileTab("file-2", "src/app.ts"),
            reviewContext: {
                path: "src/app.ts",
                sessionId: "session-2",
            },
            viewState: duplicateViewState,
        };
        const baseState = {
            ...createDefaultWorkspaceState(),
            tabsById: {
                "file-1": {
                    ...sourceTab,
                    viewState: sourceViewState,
                },
                "file-2": duplicateTab,
            },
        };

        const withDraft = updateFileDraft(baseState, "file-1", "next draft");

        expect(withDraft.tabsById["file-1"]).toMatchObject({
            contentRevision: 1,
            draftContent: "next draft",
            isDirty: true,
            viewState: sourceViewState,
        });
        expect(withDraft.tabsById["file-2"]).toMatchObject({
            contentRevision: 1,
            draftContent: "next draft",
            isDirty: true,
            reviewContext: {
                path: "src/app.ts",
                sessionId: "session-2",
            },
            viewState: duplicateViewState,
        });

        const withSaving = setFileTabSaving(withDraft, "file-2", true, null);
        expect(withSaving.tabsById["file-1"]).toMatchObject({
            isSaving: true,
        });
        expect(withSaving.tabsById["file-2"]).toMatchObject({
            isSaving: true,
            reviewContext: {
                path: "src/app.ts",
                sessionId: "session-2",
            },
        });

        const sourceDocument = sourceTab.document!;
        const withSavedDocument = replaceFileDocument(withSaving, "file-2", {
            ...sourceDocument,
            content: "saved content",
            modifiedAtMs: 2,
        });

        expect(withSavedDocument.tabsById["file-1"]).toMatchObject({
            contentRevision: 2,
            document: { content: "saved content", modifiedAtMs: 2 },
            draftContent: "saved content",
            isDirty: false,
            isSaving: false,
            savedContent: "saved content",
            viewState: sourceViewState,
        });
        expect(withSavedDocument.tabsById["file-2"]).toMatchObject({
            contentRevision: 2,
            document: { content: "saved content", modifiedAtMs: 2 },
            draftContent: "saved content",
            isDirty: false,
            isSaving: false,
            reviewContext: {
                path: "src/app.ts",
                sessionId: "session-2",
            },
            viewState: duplicateViewState,
        });
    });

    it("updates view state only for the target duplicate file tab", () => {
        const firstViewState = {
            contributionsState: [],
            cursorState: [],
            viewState: { scrollTop: 120 },
        } as never;
        const secondViewState = {
            contributionsState: [],
            cursorState: [],
            viewState: { scrollTop: 360 },
        } as never;
        const nextSecondViewState = {
            contributionsState: [],
            cursorState: [],
            viewState: { scrollTop: 720 },
        } as never;
        const baseState = {
            ...createDefaultWorkspaceState(),
            tabsById: {
                "file-1": {
                    ...makeFileTab("file-1", "src/app.ts"),
                    viewState: firstViewState,
                },
                "file-2": {
                    ...makeFileTab("file-2", "src/app.ts"),
                    viewState: secondViewState,
                },
            },
        };

        const nextState = setFileTabViewState(
            baseState,
            "file-2",
            nextSecondViewState,
        );

        expect(nextState.tabsById["file-1"]).toMatchObject({
            draftContent: "",
            relativePath: "src/app.ts",
            viewState: firstViewState,
        });
        expect(nextState.tabsById["file-2"]).toMatchObject({
            draftContent: "",
            relativePath: "src/app.ts",
            viewState: nextSecondViewState,
        });
    });

    it("updates Markdown preview scroll only for the target duplicate file tab", () => {
        const baseState = {
            ...createDefaultWorkspaceState(),
            tabsById: {
                "file-1": {
                    ...makeFileTab("file-1", "README.md"),
                    markdownPreviewScrollTop: 120,
                    markdownViewMode: "preview" as const,
                },
                "file-2": {
                    ...makeFileTab("file-2", "README.md"),
                    markdownPreviewScrollTop: 360,
                    markdownViewMode: "preview" as const,
                },
            },
        };

        const nextState = setFileTabMarkdownPreviewScrollTop(
            baseState,
            "file-2",
            720,
        );

        expect(nextState.tabsById["file-1"]).toMatchObject({
            markdownPreviewScrollTop: 120,
        });
        expect(nextState.tabsById["file-2"]).toMatchObject({
            markdownPreviewScrollTop: 720,
        });
    });

    it("syncs external change flags across duplicate tabs while preserving per-tab view state", () => {
        const firstViewState = {
            contributionsState: [],
            cursorState: [],
            viewState: { first: true },
        } as never;
        const secondViewState = {
            contributionsState: [],
            cursorState: [],
            viewState: { second: true },
        } as never;
        const baseState = {
            ...createDefaultWorkspaceState(),
            tabsById: {
                "file-1": {
                    ...makeFileTab("file-1", "src/app.ts"),
                    viewState: firstViewState,
                },
                "file-2": {
                    ...makeFileTab("file-2", "src/app.ts"),
                    viewState: secondViewState,
                },
            },
        };

        const nextState = setFileTabExternalChange(
            baseState,
            "file-1",
            true,
            "Conflict on disk",
        );

        expect(nextState.tabsById["file-1"]).toMatchObject({
            hasExternalChange: true,
            saveError: "Conflict on disk",
            viewState: firstViewState,
        });
        expect(nextState.tabsById["file-2"]).toMatchObject({
            hasExternalChange: true,
            saveError: "Conflict on disk",
            viewState: secondViewState,
        });
    });

    it("reorders tabs within the same pane by insertion index", () => {
        const withFirstTab = attachTabToPane(
            createDefaultWorkspaceState(),
            "pane-root",
            makeChatTab("tab-1"),
        );
        const withSecondTab = attachTabToPane(
            withFirstTab,
            "pane-root",
            makeChatTab("tab-2"),
        );
        const withThirdTab = attachTabToPane(
            withSecondTab,
            "pane-root",
            makeChatTab("tab-3"),
        );

        const reordered = reorderTabInPane(
            withThirdTab,
            "pane-root",
            "tab-1",
            2,
        );

        expect(reordered.rootNode.type).toBe("pane");
        if (reordered.rootNode.type === "pane") {
            expect(reordered.rootNode.tabIds).toEqual([
                "tab-2",
                "tab-3",
                "tab-1",
            ]);
            expect(reordered.rootNode.activeTabId).toBe("tab-3");
        }
        expect(reordered.activePaneId).toBe("pane-root");
    });

    it("keeps pinned tabs at the front of the pane", () => {
        const withFirstTab = attachTabToPane(
            createDefaultWorkspaceState(),
            "pane-root",
            makeChatTab("tab-1"),
        );
        const withSecondTab = attachTabToPane(
            withFirstTab,
            "pane-root",
            makeChatTab("tab-2"),
        );
        const withThirdTab = attachTabToPane(
            withSecondTab,
            "pane-root",
            makeChatTab("tab-3"),
        );

        const withPinnedThird = pinTabInPane(
            withThirdTab,
            "pane-root",
            "tab-3",
        );
        const withPinnedSecond = pinTabInPane(
            withPinnedThird,
            "pane-root",
            "tab-2",
        );

        expect(withPinnedSecond.rootNode.type).toBe("pane");
        if (withPinnedSecond.rootNode.type === "pane") {
            expect(withPinnedSecond.rootNode.tabIds).toEqual([
                "tab-3",
                "tab-2",
                "tab-1",
            ]);
            expect(withPinnedSecond.rootNode.pinnedTabIds).toEqual([
                "tab-3",
                "tab-2",
            ]);
        }
    });

    it("keeps pinned and unpinned tabs inside their reorder regions", () => {
        const withTabs = ["tab-1", "tab-2", "tab-3", "tab-4"].reduce(
            (state, tabId) =>
                attachTabToPane(state, "pane-root", makeChatTab(tabId)),
            createDefaultWorkspaceState(),
        );
        const withPins = pinTabInPane(
            pinTabInPane(withTabs, "pane-root", "tab-3"),
            "pane-root",
            "tab-2",
        );

        const unpinnedBeforePinned = reorderTabInPane(
            withPins,
            "pane-root",
            "tab-1",
            0,
        );
        const pinnedAfterUnpinned = reorderTabInPane(
            unpinnedBeforePinned,
            "pane-root",
            "tab-3",
            3,
        );

        expect(pinnedAfterUnpinned.rootNode.type).toBe("pane");
        if (pinnedAfterUnpinned.rootNode.type === "pane") {
            expect(pinnedAfterUnpinned.rootNode.tabIds).toEqual([
                "tab-2",
                "tab-3",
                "tab-1",
                "tab-4",
            ]);
            expect(pinnedAfterUnpinned.rootNode.pinnedTabIds).toEqual([
                "tab-2",
                "tab-3",
            ]);
        }
    });

    it("does not carry pinned state when moving a tab to another pane", () => {
        const splitState = splitPaneInDirection(
            createDefaultWorkspaceState(),
            "pane-root",
            "right",
            {
                paneId: "pane-2",
                splitId: "split-1",
            },
        );
        const withTabs = attachTabToPane(
            attachTabToPane(splitState, "pane-root", makeChatTab("tab-1")),
            "pane-2",
            makeChatTab("tab-2"),
        );
        const withPinnedTab = pinTabInPane(withTabs, "pane-root", "tab-1");

        const moved = moveTabToPaneAtIndex(
            withPinnedTab,
            "tab-1",
            "pane-root",
            "pane-2",
            0,
        );

        expect(moved.rootNode.type).toBe("pane");
        if (moved.rootNode.type === "pane") {
            expect(moved.rootNode.id).toBe("pane-2");
            expect(moved.rootNode.tabIds).toEqual(["tab-1", "tab-2"]);
            expect(moved.rootNode.pinnedTabIds).toBeUndefined();
        }
    });

    it("unpinned tabs keep their visual position behind remaining pins", () => {
        const withTabs = ["tab-1", "tab-2", "tab-3"].reduce(
            (state, tabId) =>
                attachTabToPane(state, "pane-root", makeChatTab(tabId)),
            createDefaultWorkspaceState(),
        );
        const withPins = pinTabInPane(
            pinTabInPane(withTabs, "pane-root", "tab-3"),
            "pane-root",
            "tab-2",
        );

        const unpinned = unpinTabInPane(withPins, "pane-root", "tab-3");

        expect(unpinned.rootNode.type).toBe("pane");
        if (unpinned.rootNode.type === "pane") {
            expect(unpinned.rootNode.tabIds).toEqual([
                "tab-2",
                "tab-3",
                "tab-1",
            ]);
            expect(unpinned.rootNode.pinnedTabIds).toEqual(["tab-2"]);
        }
    });

    it("normalizes pinned tab ids when restoring and serializing snapshots", () => {
        const firstTab = makeChatTab("tab-1");
        const pinnedTab = makeChatTab("tab-2");
        const transientTab: RuntimeWorkspaceTab = {
            ...makeFileTab("tab-transient", "scratch.ts"),
            isTransient: true,
        };
        const restored = workspaceStateFromSnapshot(
            {
                activePaneId: "pane-root",
                rootNode: {
                    activeTabId: "tab-1",
                    id: "pane-root",
                    pinnedTabIds: ["tab-2", "missing-tab", "tab-2"],
                    tabIds: ["tab-1", "tab-2", "tab-transient"],
                    type: "pane",
                },
                tabs: [firstTab, pinnedTab, transientTab],
            },
            {
                "tab-1": firstTab,
                "tab-2": pinnedTab,
                "tab-transient": transientTab,
            },
        );

        expect(restored.rootNode.type).toBe("pane");
        if (restored.rootNode.type === "pane") {
            expect(restored.rootNode.tabIds).toEqual([
                "tab-2",
                "tab-1",
                "tab-transient",
            ]);
            expect(restored.rootNode.pinnedTabIds).toEqual(["tab-2"]);
        }

        expect(workspaceStateToSnapshot(restored).rootNode).toEqual({
            activeTabId: "tab-1",
            id: "pane-root",
            pinnedTabIds: ["tab-2"],
            tabIds: ["tab-2", "tab-1"],
            type: "pane",
        });
    });

    it("keeps host snapshots serialized without constructing runtime tabs", () => {
        const state = workspaceStateFromSerializedSnapshot({
            activePaneId: "pane-root",
            rootNode: {
                activeTabId: "terminal-1",
                id: "pane-root",
                tabIds: ["terminal-1"],
                type: "pane",
            },
            tabs: [
                {
                    createdAt: "2026-07-31T12:00:00.000Z",
                    id: "terminal-1",
                    kind: "terminal",
                    projectId: "project-1",
                    sessionId: "session-1",
                    title: "Terminal",
                    worktreeId: null,
                },
            ],
        });

        expect(state.tabsById["terminal-1"]).toEqual({
            createdAt: "2026-07-31T12:00:00.000Z",
            id: "terminal-1",
            kind: "terminal",
            projectId: "project-1",
            sessionId: "session-1",
            title: "Terminal",
            worktreeId: null,
        });
        expect(state.tabsById["terminal-1"]).not.toHaveProperty("output");
        expect(state.tabsById["terminal-1"]).not.toHaveProperty("isReady");
    });

    it("moves a tab to another pane at a specific index", () => {
        const splitState = splitPaneInDirection(
            createDefaultWorkspaceState(),
            "pane-root",
            "right",
            {
                paneId: "pane-2",
                splitId: "split-1",
            },
        );
        const withSourceTabs = attachTabToPane(
            attachTabToPane(splitState, "pane-root", makeChatTab("tab-1")),
            "pane-root",
            makeChatTab("tab-2"),
        );
        const withTargetTabs = attachTabToPane(
            attachTabToPane(withSourceTabs, "pane-2", makeChatTab("tab-3")),
            "pane-2",
            makeChatTab("tab-4"),
        );

        const moved = moveTabToPaneAtIndex(
            withTargetTabs,
            "tab-2",
            "pane-root",
            "pane-2",
            1,
        );

        expect(moved.rootNode.type).toBe("split");
        if (moved.rootNode.type !== "split") {
            return;
        }

        const [leftPane, rightPane] = moved.rootNode.children;
        expect(leftPane.type).toBe("pane");
        expect(rightPane.type).toBe("pane");
        if (leftPane.type === "pane") {
            expect(leftPane.tabIds).toEqual(["tab-1"]);
            expect(leftPane.activeTabId).toBe("tab-1");
        }
        if (rightPane.type === "pane") {
            expect(rightPane.tabIds).toEqual(["tab-3", "tab-2", "tab-4"]);
            expect(rightPane.activeTabId).toBe("tab-2");
        }
        expect(moved.activePaneId).toBe("pane-2");
    });

    it("creates a split from a drop target and moves the tab into the new pane", () => {
        const splitState = splitPaneInDirection(
            createDefaultWorkspaceState(),
            "pane-root",
            "right",
            {
                paneId: "pane-2",
                splitId: "split-1",
            },
        );
        const withSourceTab = attachTabToPane(
            splitState,
            "pane-root",
            makeChatTab("tab-1"),
        );
        const withTargetTab = attachTabToPane(
            withSourceTab,
            "pane-2",
            makeChatTab("tab-2"),
        );

        const moved = moveTabToSplit(
            withTargetTab,
            "tab-1",
            "pane-root",
            "pane-2",
            "down",
            {
                paneId: "pane-3",
                splitId: "split-2",
            },
        );

        expect(moved.activePaneId).toBe("pane-3");
        expect(moved.rootNode.type).toBe("split");
        if (moved.rootNode.type !== "split") {
            return;
        }

        expect(moved.rootNode.axis).toBe("vertical");
        expect(moved.rootNode.children[0]?.type).toBe("pane");
        expect(moved.rootNode.children[1]?.type).toBe("pane");
        if (moved.rootNode.children[0]?.type === "pane") {
            expect(moved.rootNode.children[0].id).toBe("pane-2");
            expect(moved.rootNode.children[0].tabIds).toEqual(["tab-2"]);
        }
        if (moved.rootNode.children[1]?.type === "pane") {
            expect(moved.rootNode.children[1].id).toBe("pane-3");
            expect(moved.rootNode.children[1].tabIds).toEqual(["tab-1"]);
            expect(moved.rootNode.children[1].activeTabId).toBe("tab-1");
        }
    });

    it("preserves the original pane when splitting the only tab from the same pane", () => {
        const withSourceTab = attachTabToPane(
            createDefaultWorkspaceState(),
            "pane-root",
            makeChatTab("tab-1"),
        );

        const moved = moveTabToSplit(
            withSourceTab,
            "tab-1",
            "pane-root",
            "pane-root",
            "right",
            {
                paneId: "pane-2",
                splitId: "split-1",
            },
        );

        expect(moved.activePaneId).toBe("pane-2");
        expect(moved.rootNode.type).toBe("split");
        if (moved.rootNode.type !== "split") {
            return;
        }

        const [leftPane, rightPane] = moved.rootNode.children;
        expect(leftPane.type).toBe("pane");
        expect(rightPane.type).toBe("pane");
        if (leftPane.type === "pane") {
            expect(leftPane.id).toBe("pane-root");
            expect(leftPane.tabIds).toEqual([]);
            expect(leftPane.activeTabId).toBeNull();
        }
        if (rightPane.type === "pane") {
            expect(rightPane.id).toBe("pane-2");
            expect(rightPane.tabIds).toEqual(["tab-1"]);
            expect(rightPane.activeTabId).toBe("tab-1");
        }
    });

    it("closes other tabs in the same pane", () => {
        const withFirstTab = attachTabToPane(
            createDefaultWorkspaceState(),
            "pane-root",
            makeChatTab("tab-1"),
        );
        const withSecondTab = attachTabToPane(
            withFirstTab,
            "pane-root",
            makeChatTab("tab-2"),
        );
        const withThirdTab = attachTabToPane(
            withSecondTab,
            "pane-root",
            makeChatTab("tab-3"),
        );
        const closed = closeOtherWorkspaceTabs(withThirdTab, "tab-2");

        expect(closed.rootNode.type).toBe("pane");
        if (closed.rootNode.type === "pane") {
            expect(closed.rootNode.tabIds).toEqual(["tab-2"]);
            expect(closed.rootNode.activeTabId).toBe("tab-2");
        }
        expect(Object.keys(closed.tabsById)).toEqual(["tab-2"]);
    });

    it("closes an empty pane after closing its last tab", () => {
        const splitState = splitPaneInDirection(
            createDefaultWorkspaceState(),
            "pane-root",
            "right",
            {
                paneId: "pane-2",
                splitId: "split-1",
            },
        );
        const withLeftTab = attachTabToPane(
            splitState,
            "pane-root",
            makeChatTab("tab-1"),
        );
        const withRightTab = attachTabToPane(
            withLeftTab,
            "pane-2",
            makeChatTab("tab-2"),
        );

        const closed = closeWorkspaceTab(withRightTab, "tab-1");

        expect(closed.activePaneId).toBe("pane-2");
        expect(closed.rootNode.type).toBe("pane");
        if (closed.rootNode.type !== "pane") {
            return;
        }

        expect(closed.rootNode.id).toBe("pane-2");
        expect(closed.rootNode.tabIds).toEqual(["tab-2"]);
        expect(closed.rootNode.activeTabId).toBe("tab-2");
        expect(closed.tabsById["tab-1"]).toBeUndefined();
    });

    it("closes tabs to the right within the same pane", () => {
        const withFirstTab = attachTabToPane(
            createDefaultWorkspaceState(),
            "pane-root",
            makeChatTab("tab-1"),
        );
        const withSecondTab = attachTabToPane(
            withFirstTab,
            "pane-root",
            makeChatTab("tab-2"),
        );
        const withThirdTab = attachTabToPane(
            withSecondTab,
            "pane-root",
            makeChatTab("tab-3"),
        );
        const closed = closeWorkspaceTabsToRight(withThirdTab, "tab-2");

        expect(closed.rootNode.type).toBe("pane");
        if (closed.rootNode.type === "pane") {
            expect(closed.rootNode.tabIds).toEqual(["tab-1", "tab-2"]);
            expect(closed.rootNode.activeTabId).toBe("tab-2");
        }
        expect(Object.keys(closed.tabsById).sort()).toEqual(["tab-1", "tab-2"]);
    });

    it("closes a pane and merges its tabs into the fallback pane", () => {
        const splitState = splitPaneInDirection(
            createDefaultWorkspaceState(),
            "pane-root",
            "right",
            {
                paneId: "pane-2",
                splitId: "split-1",
            },
        );
        const withFirstTab = attachTabToPane(
            splitState,
            "pane-root",
            makeChatTab("tab-1"),
        );
        const withSecondTab = attachTabToPane(
            withFirstTab,
            "pane-2",
            makeChatTab("tab-2"),
        );
        const closed = closeWorkspacePane(withSecondTab, "pane-2");

        expect(closed.rootNode.type).toBe("pane");
        if (closed.rootNode.type === "pane") {
            expect(closed.rootNode.tabIds).toEqual(["tab-1", "tab-2"]);
        }
    });

    it("closes every file tab that matches a deleted directory", () => {
        const withReadme = attachTabToPane(
            createDefaultWorkspaceState(),
            "pane-root",
            makeFileTab("tab-1", "docs/readme.md"),
        );
        const withGuide = attachTabToPane(
            withReadme,
            "pane-root",
            makeFileTab("tab-2", "docs/guides/getting-started.md"),
        );
        const withOtherFile = attachTabToPane(
            withGuide,
            "pane-root",
            makeFileTab("tab-3", "src/index.ts"),
        );

        const closed = closeWorkspaceTabsForProjectPath(
            withOtherFile,
            "project-1",
            null,
            "docs",
            "directory",
        );

        expect(Object.keys(closed.tabsById).sort()).toEqual(["tab-3"]);
    });

    it("matches primary file tabs when an operation uses the canonical worktree id", () => {
        const withReadme = attachTabToPane(
            createDefaultWorkspaceState(),
            "pane-root",
            makeFileTab("tab-primary", "docs/readme.md"),
        );

        const closed = closeWorkspaceTabsForProjectPath(
            withReadme,
            "project-1",
            "project-1:primary",
            "docs/readme.md",
            "file",
        );

        expect(closed.tabsById).toEqual({});
    });

    it("renames every matching open tab when a directory moves", () => {
        const withReadme = attachTabToPane(
            createDefaultWorkspaceState(),
            "pane-root",
            makeFileTab("tab-1", "docs/readme.md"),
        );
        const withGuide = attachTabToPane(
            withReadme,
            "pane-root",
            makeFileTab("tab-2", "docs/guides/getting-started.md"),
        );

        const renamed = renameWorkspaceTabsForProjectPath(
            withGuide,
            "project-1",
            null,
            "docs",
            "knowledge-base",
            "directory",
        );

        const readmeTab = renamed.tabsById["tab-1"];
        const guideTab = renamed.tabsById["tab-2"];
        if (readmeTab?.kind !== "file" || guideTab?.kind !== "file") {
            throw new Error("Expected file tabs after rename.");
        }

        expect(readmeTab.relativePath).toBe("knowledge-base/readme.md");
        expect(readmeTab.document?.relativePath).toBe(
            "knowledge-base/readme.md",
        );
        expect(readmeTab.title).toBe("readme.md");
        expect(guideTab.relativePath).toBe(
            "knowledge-base/guides/getting-started.md",
        );
        expect(guideTab.document?.absolutePath).toContain(
            "knowledge-base/guides/getting-started.md",
        );
    });

    it("marks file tabs with external disk changes", () => {
        const state = attachTabToPane(
            createDefaultWorkspaceState(),
            "pane-root",
            makeFileTab("file-1", "src/readme.md"),
        );

        const nextState = setFileTabExternalChange(
            state,
            "file-1",
            true,
            "Changed on disk.",
        );
        const tab = nextState.tabsById["file-1"];

        expect(tab?.kind).toBe("file");
        if (!tab || tab.kind !== "file") {
            return;
        }

        expect(tab.hasExternalChange).toBe(true);
        expect(tab.saveError).toBe("Changed on disk.");
    });

    it("clears external change state when replacing the file document", () => {
        const state = attachTabToPane(
            createDefaultWorkspaceState(),
            "pane-root",
            {
                ...makeFileTab("file-1", "src/readme.md"),
                hasExternalChange: true,
                saveError: "Changed on disk.",
            },
        );

        const nextState = replaceFileDocument(state, "file-1", {
            absolutePath: "/tmp/src/readme.md",
            content: "updated",
            imageDataBase64: null,
            isBinary: false,
            isTooLarge: false,
            kind: "text",
            languageId: "markdown",
            languageLabel: "Markdown",
            modifiedAtMs: 2,
            mimeType: "text/markdown",
            name: "readme.md",
            projectId: "project-1",
            relativePath: "src/readme.md",
            sizeBytes: 7,
        });
        const tab = nextState.tabsById["file-1"];

        expect(tab?.kind).toBe("file");
        if (!tab || tab.kind !== "file") {
            return;
        }

        expect(tab.hasExternalChange).toBe(false);
        expect(tab.isDirty).toBe(false);
        expect(tab.saveError).toBeNull();
    });

    it("keeps file editor view state in runtime tabs without persisting it", () => {
        const state = attachTabToPane(
            createDefaultWorkspaceState(),
            "pane-root",
            makeFileTab("file-1", "notes/today.md"),
        );
        const viewState: NonNullable<RuntimeWorkspaceFileTab["viewState"]> = {
            contributionsState: {},
            cursorState: [],
            viewState: {
                firstPosition: {
                    column: 1,
                    lineNumber: 18,
                },
                firstPositionDeltaTop: 0,
                scrollLeft: 12,
                scrollTop: 420,
                scrollTopWithoutViewZones: 420,
            },
        };

        const nextState = setFileTabViewState(state, "file-1", viewState);
        const tab = nextState.tabsById["file-1"];

        expect(tab?.kind).toBe("file");
        if (!tab || tab.kind !== "file") {
            return;
        }

        expect(tab.viewState).toEqual(viewState);

        const snapshot = workspaceStateToSnapshot(nextState);
        const snapshotTab = snapshot.tabs[0];

        expect(snapshotTab?.kind).toBe("file");
        expect("viewState" in (snapshotTab ?? {})).toBe(false);
    });

    it("keeps Markdown preview scroll position in runtime tabs without persisting it", () => {
        const state = attachTabToPane(
            createDefaultWorkspaceState(),
            "pane-root",
            makeFileTab("file-1", "notes/today.md"),
        );

        const nextState = setFileTabMarkdownPreviewScrollTop(
            state,
            "file-1",
            420.4,
        );
        const tab = nextState.tabsById["file-1"];

        expect(tab?.kind).toBe("file");
        if (!tab || tab.kind !== "file") {
            return;
        }

        expect(tab.markdownPreviewScrollTop).toBe(420);

        const snapshot = workspaceStateToSnapshot(nextState);
        const snapshotTab = snapshot.tabs[0];

        expect(snapshotTab?.kind).toBe("file");
        expect("markdownPreviewScrollTop" in (snapshotTab ?? {})).toBe(false);
    });
});
