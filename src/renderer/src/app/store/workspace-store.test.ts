import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectFileDocument } from "@shared/ipc";

import {
    createDefaultWorkspaceState,
    type WorkspaceTreeState,
} from "../workspace/tree";
import { useAiStore } from "./ai-store";
import {
    flushWorkspacePersistenceForTests,
    getBestMatchingChatTabId,
    getPaneChatTabId,
    getPaneRuntimeId,
    getWorkspaceChatTabId,
    getWorkspaceTabRuntimeId,
    resetWorkspacePersistenceForTests,
    useWorkspaceStore,
} from "./workspace-store";

const saveWorkspaceSnapshotMock = vi.fn(async () => {});
const closeAiSessionMock = vi.fn(async () => {});
const closeTerminalSessionMock = vi.fn(async () => {});
const ensureSessionMock = vi.fn(async () => {});
const notifyFileBufferMock = vi.fn(async () => {});
const openProjectFileMock =
    vi.fn<
        (input: {
            readonly projectId: string;
            readonly relativePath: string;
            readonly worktreeId?: string | null;
        }) => Promise<ProjectFileDocument>
    >();
const originalEnsureSession = useAiStore.getState().ensureSession;

function createWorkspaceFileTab(id: string, relativePath: string) {
    return {
        createdAt: "2026-04-14T00:00:00.000Z",
        document: null,
        draftContent: "",
        hasExternalChange: false,
        id,
        isDirty: false,
        isLoading: false,
        isSaving: false,
        kind: "file" as const,
        loadError: null,
        projectId: "project-1",
        relativePath,
        reviewContext: null,
        saveError: null,
        savedContent: "",
        title: relativePath,
        worktreeId: null,
    };
}

function findWorkspacePane(
    node: WorkspaceTreeState["rootNode"],
    paneId: string,
) {
    if (node.type === "pane") {
        return node.id === paneId ? node : null;
    }

    for (const child of node.children) {
        const pane = findWorkspacePane(child, paneId);
        if (pane) {
            return pane;
        }
    }

    return null;
}

describe("workspace file opening", () => {
    beforeEach(() => {
        resetWorkspacePersistenceForTests();
        saveWorkspaceSnapshotMock.mockClear();
        closeAiSessionMock.mockClear();
        closeTerminalSessionMock.mockClear();
        ensureSessionMock.mockClear();
        notifyFileBufferMock.mockClear();
        openProjectFileMock.mockReset();
        openProjectFileMock.mockImplementation((input) =>
            Promise.resolve({
                absolutePath: `/tmp/${input.relativePath}`,
                content: "export const value = 1;\n",
                imageDataBase64: null,
                isBinary: false,
                isTooLarge: false,
                kind: "text",
                languageId: "typescript",
                languageLabel: "TypeScript",
                mimeType: "text/typescript",
                modifiedAtMs: 1,
                name:
                    input.relativePath.split("/").at(-1) ?? input.relativePath,
                projectId: input.projectId,
                relativePath: input.relativePath,
                sizeBytes: 24,
            }),
        );

        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    closeAiSession: closeAiSessionMock,
                    closeTerminalSession: closeTerminalSessionMock,
                    notifyFileBuffer: notifyFileBufferMock,
                    openProjectFile: openProjectFileMock,
                    saveWorkspaceSnapshot: saveWorkspaceSnapshotMock,
                },
            },
            writable: true,
        });
        Object.defineProperty(globalThis, "localStorage", {
            configurable: true,
            value: {
                getItem: vi.fn(() => null),
                removeItem: vi.fn(),
                setItem: vi.fn(),
            },
            writable: true,
        });

        useAiStore.setState(
            (state) => ({
                ...state,
                ensureSession: ensureSessionMock,
                runtimeCatalogById: {},
                runtimeStatusById: {},
                sessions: {},
            }),
            true,
        );
        Object.assign(useAiStore.getState(), {
            ensureSession: ensureSessionMock,
        });

        useWorkspaceStore.setState((state) => ({
            ...state,
            ...createDefaultWorkspaceState(),
            error: null,
            hydrated: true,
            lastFocusedChatTabId: null,
            lastFocusedRuntimeId: "codex",
            lastQuickCreateAction: "codex",
            recentActiveTabIds: [],
            recentClosedTabs: [],
            recentFocusedChatTabIds: [],
        }), true);
    });

    afterEach(() => {
        resetWorkspacePersistenceForTests();
        useAiStore.setState(
            (state) => ({
                ...state,
                ensureSession: originalEnsureSession,
                runtimeCatalogById: {},
                runtimeStatusById: {},
                sessions: {},
            }),
            true,
        );
        vi.unstubAllGlobals();
    });

    it("opens a file in the requested pane instead of the globally active pane", async () => {
        useWorkspaceStore.setState((state) => ({
            ...state,
            activePaneId: "pane-left",
            rootNode: {
                axis: "horizontal",
                children: [
                    {
                        activeTabId: null,
                        id: "pane-left",
                        tabIds: [],
                        type: "pane",
                    },
                    {
                        activeTabId: null,
                        id: "pane-right",
                        tabIds: [],
                        type: "pane",
                    },
                ],
                id: "split-root",
                sizes: [0.5, 0.5],
                type: "split",
            },
            tabsById: {},
        }));

        await useWorkspaceStore.getState().openFileTab(
            "project-1",
            "src/app.ts",
            "worktree-1",
            {
                path: "src/app.ts",
                sessionId: "session-1",
            },
            "pane-right",
        );

        const state = useWorkspaceStore.getState();
        const rightPane =
            state.rootNode.type === "split" ? state.rootNode.children[1] : null;
        const leftPane =
            state.rootNode.type === "split" ? state.rootNode.children[0] : null;

        if (leftPane?.type !== "pane" || rightPane?.type !== "pane") {
            throw new Error("Expected a split workspace with pane children.");
        }

        expect(state.activePaneId).toBe("pane-right");
        expect(leftPane.tabIds).toEqual([]);
        expect(rightPane.tabIds).toHaveLength(1);
        expect(rightPane.activeTabId).toBe(rightPane.tabIds[0]);

        const openedTabId = rightPane.tabIds[0];
        expect(openedTabId).toBeTruthy();
        expect(openedTabId ? state.tabsById[openedTabId] : null).toMatchObject({
            kind: "file",
            projectId: "project-1",
            relativePath: "src/app.ts",
            reviewContext: {
                path: "src/app.ts",
                sessionId: "session-1",
            },
            worktreeId: "worktree-1",
        });
        expect(openProjectFileMock).toHaveBeenCalledWith({
            projectId: "project-1",
            relativePath: "src/app.ts",
            worktreeId: "worktree-1",
        });
        await flushWorkspacePersistenceForTests();
        expect(saveWorkspaceSnapshotMock).toHaveBeenCalled();
    });

    it("duplicates an existing file tab into the requested pane when the file is already open elsewhere", async () => {
        useWorkspaceStore.setState((state) => ({
            ...state,
            activePaneId: "pane-left",
            rootNode: {
                axis: "horizontal",
                children: [
                    {
                        activeTabId: "file-tab-1",
                        id: "pane-left",
                        tabIds: ["file-tab-1", "helper-tab"],
                        type: "pane",
                    },
                    {
                        activeTabId: null,
                        id: "pane-right",
                        tabIds: [],
                        type: "pane",
                    },
                ],
                id: "split-root",
                sizes: [0.5, 0.5],
                type: "split",
            },
            tabsById: {
                "file-tab-1": {
                    createdAt: "2026-04-14T00:00:00.000Z",
                    document: {
                        absolutePath: "/tmp/src/app.ts",
                        content: "export const value = 1;\n",
                        imageDataBase64: null,
                        isBinary: false,
                        isTooLarge: false,
                        kind: "text",
                        languageId: "typescript",
                        languageLabel: "TypeScript",
                        mimeType: "text/typescript",
                        modifiedAtMs: 1,
                        name: "app.ts",
                        projectId: "project-1",
                        relativePath: "src/app.ts",
                        sizeBytes: 24,
                    },
                    draftContent: "export const value = 1;\n",
                    hasExternalChange: false,
                    id: "file-tab-1",
                    isDirty: false,
                    isLoading: false,
                    isSaving: false,
                    kind: "file",
                    loadError: null,
                    projectId: "project-1",
                    relativePath: "src/app.ts",
                    reviewContext: null,
                    saveError: null,
                    savedContent: "export const value = 1;\n",
                    title: "app.ts",
                    viewState: null,
                    worktreeId: "worktree-1",
                },
                "helper-tab": {
                    createdAt: "2026-04-14T00:00:00.000Z",
                    draft: "",
                    id: "helper-tab",
                    kind: "chat",
                    projectId: "project-1",
                    runtimeId: "codex",
                    sessionId: "session-helper",
                    title: "Helper",
                    worktreeId: "worktree-1",
                },
            },
        }));

        await useWorkspaceStore
            .getState()
            .openFileTab(
                "project-1",
                "src/app.ts",
                "worktree-1",
                undefined,
                "pane-right",
            );

        const state = useWorkspaceStore.getState();
        const rightPane =
            state.rootNode.type === "split" ? state.rootNode.children[1] : null;
        const leftPane =
            state.rootNode.type === "split" ? state.rootNode.children[0] : null;

        if (leftPane?.type !== "pane" || rightPane?.type !== "pane") {
            throw new Error("Expected a split workspace with pane children.");
        }

        expect(state.activePaneId).toBe("pane-right");
        expect(leftPane.tabIds).toEqual(["file-tab-1", "helper-tab"]);
        expect(leftPane.activeTabId).toBe("file-tab-1");
        expect(rightPane.tabIds).toHaveLength(1);
        expect(rightPane.activeTabId).toBe(rightPane.tabIds[0]);
        expect(openProjectFileMock).not.toHaveBeenCalled();
        await flushWorkspacePersistenceForTests();
        expect(saveWorkspaceSnapshotMock).toHaveBeenCalled();

        const duplicatedTabId = rightPane.tabIds[0];
        expect(duplicatedTabId).toBeTruthy();
        expect(duplicatedTabId).not.toBe("file-tab-1");
        expect(
            duplicatedTabId ? state.tabsById[duplicatedTabId] : null,
        ).toMatchObject({
            document: {
                absolutePath: "/tmp/src/app.ts",
                relativePath: "src/app.ts",
            },
            draftContent: "export const value = 1;\n",
            isDirty: false,
            kind: "file",
            projectId: "project-1",
            relativePath: "src/app.ts",
            reviewContext: null,
            savedContent: "export const value = 1;\n",
            worktreeId: "worktree-1",
        });
    });

    it("opens chat images in a transient file tab and omits them from persisted snapshots", async () => {
        await useWorkspaceStore.getState().openChatImageTab({
            attachment: {
                dataBase64: "aGVsbG8=",
                id: "message-1:image:1",
                mimeType: "image/png",
                name: "Example capture.png",
                sizeBytes: 5,
            },
        });

        const state = useWorkspaceStore.getState();
        const rootPane = state.rootNode.type === "pane" ? state.rootNode : null;
        if (!rootPane) {
            throw new Error("Expected the default workspace root pane.");
        }

        expect(rootPane.tabIds).toHaveLength(1);
        const openedTabId = rootPane.tabIds[0];
        expect(openedTabId).toBeTruthy();
        expect(openedTabId ? state.tabsById[openedTabId] : null).toMatchObject({
            document: {
                absolutePath:
                    "comando://chat-attachments/.comando/chat-images/message-1-image-1-Example-capture.png",
                kind: "image",
                mimeType: "image/png",
                name: "Example capture.png",
            },
            isDirty: false,
            isLoading: false,
            isTransient: true,
            kind: "file",
            projectId: "__comando_chat_images__",
            relativePath:
                ".comando/chat-images/message-1-image-1-Example-capture.png",
            title: "Example capture.png",
            worktreeId: null,
        });

        await flushWorkspacePersistenceForTests();

        expect(saveWorkspaceSnapshotMock).toHaveBeenCalledWith({
            activePaneId: "pane-root",
            rootNode: {
                activeTabId: null,
                id: "pane-root",
                tabIds: [],
                type: "pane",
            },
            tabs: [],
        });
    });

    it("buffers multiple workspace mutations into a single snapshot save", async () => {
        useWorkspaceStore.setState((state) => ({
            ...state,
            activePaneId: "pane-a",
            rootNode: {
                axis: "horizontal",
                children: [
                    {
                        activeTabId: "chat-1",
                        id: "pane-a",
                        tabIds: ["chat-1", "file-1"],
                        type: "pane",
                    },
                    {
                        activeTabId: "chat-2",
                        id: "pane-b",
                        tabIds: ["chat-2"],
                        type: "pane",
                    },
                ],
                id: "split-root",
                sizes: [0.5, 0.5],
                type: "split",
            },
            tabsById: {
                "chat-1": {
                    createdAt: "2026-04-14T00:00:00.000Z",
                    draft: "",
                    id: "chat-1",
                    kind: "chat",
                    projectId: "project-1",
                    runtimeId: "codex",
                    sessionId: "session-1",
                    title: "Chat 1",
                    worktreeId: null,
                },
                "chat-2": {
                    createdAt: "2026-04-14T00:00:00.000Z",
                    draft: "",
                    id: "chat-2",
                    kind: "chat",
                    projectId: "project-1",
                    runtimeId: "claude",
                    sessionId: "session-2",
                    title: "Chat 2",
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
                    viewState: null,
                    worktreeId: null,
                },
            },
        }));

        await useWorkspaceStore.getState().selectTab("pane-a", "file-1");
        await useWorkspaceStore.getState().selectTab("pane-b", "chat-2");
        await useWorkspaceStore.getState().setActivePane("pane-b");

        expect(saveWorkspaceSnapshotMock).not.toHaveBeenCalled();

        await flushWorkspacePersistenceForTests();

        expect(saveWorkspaceSnapshotMock).toHaveBeenCalledTimes(1);
    });

    it("flushes split resize immediately when the drag is committed", async () => {
        useWorkspaceStore.setState((state) => ({
            ...state,
            activePaneId: "pane-left",
            rootNode: {
                axis: "horizontal",
                children: [
                    {
                        activeTabId: null,
                        id: "pane-left",
                        tabIds: [],
                        type: "pane",
                    },
                    {
                        activeTabId: null,
                        id: "pane-right",
                        tabIds: [],
                        type: "pane",
                    },
                ],
                id: "split-root",
                sizes: [0.5, 0.5],
                type: "split",
            },
            tabsById: {},
        }));

        await useWorkspaceStore
            .getState()
            .resizeSplit("split-root", [0.68, 0.32]);

        expect(saveWorkspaceSnapshotMock).toHaveBeenCalledTimes(1);
        expect(saveWorkspaceSnapshotMock).toHaveBeenCalledWith({
            activePaneId: "pane-left",
            rootNode: {
                axis: "horizontal",
                children: [
                    {
                        activeTabId: null,
                        id: "pane-left",
                        tabIds: [],
                        type: "pane",
                    },
                    {
                        activeTabId: null,
                        id: "pane-right",
                        tabIds: [],
                        type: "pane",
                    },
                ],
                id: "split-root",
                sizes: [0.68, 0.32],
                type: "split",
            },
            tabs: [],
        });
    });

    it("refreshes only clean tabs affected by the invalidated paths", async () => {
        useWorkspaceStore.setState((state) => ({
            ...state,
            activePaneId: "pane-root",
            rootNode: {
                activeTabId: "file-clean-match",
                id: "pane-root",
                tabIds: [
                    "file-clean-match",
                    "file-clean-other",
                    "file-dirty-match",
                ],
                type: "pane",
            },
            tabsById: {
                "file-clean-match": {
                    createdAt: "2026-04-14T00:00:00.000Z",
                    document: {
                        absolutePath: "/tmp/src/app.ts",
                        content: "export const app = 1;\n",
                        imageDataBase64: null,
                        isBinary: false,
                        isTooLarge: false,
                        kind: "text",
                        languageId: "typescript",
                        languageLabel: "TypeScript",
                        mimeType: "text/typescript",
                        modifiedAtMs: 1,
                        name: "app.ts",
                        projectId: "project-1",
                        relativePath: "src/app.ts",
                        sizeBytes: 22,
                    },
                    draftContent: "export const app = 1;\n",
                    hasExternalChange: false,
                    id: "file-clean-match",
                    isDirty: false,
                    isLoading: false,
                    isSaving: false,
                    kind: "file",
                    loadError: null,
                    projectId: "project-1",
                    relativePath: "src/app.ts",
                    reviewContext: null,
                    saveError: null,
                    savedContent: "export const app = 1;\n",
                    title: "app.ts",
                    viewState: null,
                    worktreeId: null,
                },
                "file-clean-other": {
                    createdAt: "2026-04-14T00:00:00.000Z",
                    document: {
                        absolutePath: "/tmp/src/other.ts",
                        content: "export const other = 1;\n",
                        imageDataBase64: null,
                        isBinary: false,
                        isTooLarge: false,
                        kind: "text",
                        languageId: "typescript",
                        languageLabel: "TypeScript",
                        mimeType: "text/typescript",
                        modifiedAtMs: 1,
                        name: "other.ts",
                        projectId: "project-1",
                        relativePath: "src/other.ts",
                        sizeBytes: 24,
                    },
                    draftContent: "export const other = 1;\n",
                    hasExternalChange: false,
                    id: "file-clean-other",
                    isDirty: false,
                    isLoading: false,
                    isSaving: false,
                    kind: "file",
                    loadError: null,
                    projectId: "project-1",
                    relativePath: "src/other.ts",
                    reviewContext: null,
                    saveError: null,
                    savedContent: "export const other = 1;\n",
                    title: "other.ts",
                    viewState: null,
                    worktreeId: null,
                },
                "file-dirty-match": {
                    createdAt: "2026-04-14T00:00:00.000Z",
                    document: {
                        absolutePath: "/tmp/docs/guide.md",
                        content: "# Guide\n",
                        imageDataBase64: null,
                        isBinary: false,
                        isTooLarge: false,
                        kind: "text",
                        languageId: "markdown",
                        languageLabel: "Markdown",
                        mimeType: "text/markdown",
                        modifiedAtMs: 1,
                        name: "guide.md",
                        projectId: "project-1",
                        relativePath: "docs/guide.md",
                        sizeBytes: 8,
                    },
                    draftContent: "# Guide\nDraft note\n",
                    hasExternalChange: false,
                    id: "file-dirty-match",
                    isDirty: true,
                    isLoading: false,
                    isSaving: false,
                    kind: "file",
                    loadError: null,
                    projectId: "project-1",
                    relativePath: "docs/guide.md",
                    reviewContext: null,
                    saveError: null,
                    savedContent: "# Guide\n",
                    title: "guide.md",
                    viewState: null,
                    worktreeId: null,
                },
            },
        }));

        await useWorkspaceStore
            .getState()
            .refreshProjectTabs("project-1", null, [
                "src/app.ts",
                "docs/guide.md",
            ]);

        const state = useWorkspaceStore.getState();
        expect(openProjectFileMock).toHaveBeenCalledTimes(1);
        expect(openProjectFileMock).toHaveBeenCalledWith({
            projectId: "project-1",
            relativePath: "src/app.ts",
            worktreeId: null,
        });
        expect(state.tabsById["file-dirty-match"]).toMatchObject({
            hasExternalChange: false,
            isDirty: true,
            saveError: null,
        });
        expect(state.tabsById["file-clean-other"]).toMatchObject({
            draftContent: "export const other = 1;\n",
            isDirty: false,
        });
    });

    it("skips dirty tabs during broad project invalidations", async () => {
        useWorkspaceStore.setState((state) => ({
            ...state,
            activePaneId: "pane-root",
            rootNode: {
                activeTabId: "file-clean",
                id: "pane-root",
                tabIds: ["file-clean", "file-dirty"],
                type: "pane",
            },
            tabsById: {
                "file-clean": {
                    createdAt: "2026-04-14T00:00:00.000Z",
                    document: {
                        absolutePath: "/tmp/src/main.ts",
                        content: "export const main = 1;\n",
                        imageDataBase64: null,
                        isBinary: false,
                        isTooLarge: false,
                        kind: "text",
                        languageId: "typescript",
                        languageLabel: "TypeScript",
                        mimeType: "text/typescript",
                        modifiedAtMs: 1,
                        name: "main.ts",
                        projectId: "project-1",
                        relativePath: "src/main.ts",
                        sizeBytes: 23,
                    },
                    draftContent: "export const main = 1;\n",
                    hasExternalChange: false,
                    id: "file-clean",
                    isDirty: false,
                    isLoading: false,
                    isSaving: false,
                    kind: "file",
                    loadError: null,
                    projectId: "project-1",
                    relativePath: "src/main.ts",
                    reviewContext: null,
                    saveError: null,
                    savedContent: "export const main = 1;\n",
                    title: "main.ts",
                    viewState: null,
                    worktreeId: null,
                },
                "file-dirty": {
                    createdAt: "2026-04-14T00:00:00.000Z",
                    document: {
                        absolutePath: "/tmp/src/notes.md",
                        content: "Notes\n",
                        imageDataBase64: null,
                        isBinary: false,
                        isTooLarge: false,
                        kind: "text",
                        languageId: "markdown",
                        languageLabel: "Markdown",
                        mimeType: "text/markdown",
                        modifiedAtMs: 1,
                        name: "notes.md",
                        projectId: "project-1",
                        relativePath: "src/notes.md",
                        sizeBytes: 6,
                    },
                    draftContent: "Notes\nDraft\n",
                    hasExternalChange: false,
                    id: "file-dirty",
                    isDirty: true,
                    isLoading: false,
                    isSaving: false,
                    kind: "file",
                    loadError: null,
                    projectId: "project-1",
                    relativePath: "src/notes.md",
                    reviewContext: null,
                    saveError: null,
                    savedContent: "Notes\n",
                    title: "notes.md",
                    viewState: null,
                    worktreeId: null,
                },
            },
        }));

        await useWorkspaceStore.getState().refreshProjectTabs("project-1");

        const state = useWorkspaceStore.getState();
        expect(openProjectFileMock).toHaveBeenCalledTimes(1);
        expect(openProjectFileMock).toHaveBeenCalledWith({
            projectId: "project-1",
            relativePath: "src/main.ts",
            worktreeId: null,
        });
        expect(state.tabsById["file-dirty"]).toMatchObject({
            hasExternalChange: false,
            isDirty: true,
            saveError: null,
        });
    });

    it("opens a singleton chat history tab per project and worktree", async () => {
        await useWorkspaceStore
            .getState()
            .openChatHistoryTab("project-1", "worktree-1");

        let state = useWorkspaceStore.getState();
        const rootPane = state.rootNode.type === "pane" ? state.rootNode : null;

        if (!rootPane) {
            throw new Error("Expected the default workspace root pane.");
        }

        expect(rootPane.tabIds).toHaveLength(1);
        expect(rootPane.activeTabId).toBe(rootPane.tabIds[0]);
        expect(state.tabsById[rootPane.tabIds[0]]).toMatchObject({
            kind: "chat_history",
            projectId: "project-1",
            title: "History",
            worktreeId: "worktree-1",
        });

        const initialTabId = rootPane.tabIds[0];

        await useWorkspaceStore
            .getState()
            .openChatHistoryTab("project-1", "worktree-1");

        state = useWorkspaceStore.getState();
        const paneAfterDuplicate =
            state.rootNode.type === "pane" ? state.rootNode : null;

        if (!paneAfterDuplicate) {
            throw new Error("Expected the default workspace root pane.");
        }

        expect(paneAfterDuplicate.tabIds).toEqual([initialTabId]);
        expect(paneAfterDuplicate.activeTabId).toBe(initialTabId);

        await useWorkspaceStore
            .getState()
            .openChatHistoryTab("project-1", "worktree-2");

        state = useWorkspaceStore.getState();
        const paneAfterScopeChange =
            state.rootNode.type === "pane" ? state.rootNode : null;

        if (!paneAfterScopeChange) {
            throw new Error("Expected the default workspace root pane.");
        }

        expect(paneAfterScopeChange.tabIds).toHaveLength(2);
        expect(paneAfterScopeChange.activeTabId).toBe(
            paneAfterScopeChange.tabIds[1],
        );
        expect(state.tabsById[paneAfterScopeChange.tabIds[1]]).toMatchObject({
            kind: "chat_history",
            projectId: "project-1",
            worktreeId: "worktree-2",
        });
        await flushWorkspacePersistenceForTests();
        expect(saveWorkspaceSnapshotMock).toHaveBeenCalled();
    });

    it("reuses an existing chat tab when opening a persisted session by session id", async () => {
        useWorkspaceStore.setState((state) => ({
            ...state,
            activePaneId: "pane-left",
            rootNode: {
                axis: "horizontal",
                children: [
                    {
                        activeTabId: "chat-existing",
                        id: "pane-left",
                        tabIds: ["chat-existing"],
                        type: "pane",
                    },
                    {
                        activeTabId: null,
                        id: "pane-right",
                        tabIds: [],
                        type: "pane",
                    },
                ],
                id: "split-root",
                sizes: [0.5, 0.5],
                type: "split",
            },
            tabsById: {
                "chat-existing": {
                    createdAt: "2026-04-14T00:00:00.000Z",
                    draft: "",
                    id: "chat-existing",
                    kind: "chat",
                    projectId: null,
                    runtimeId: "claude",
                    sessionId: "session-persisted",
                    title: "Old title",
                    worktreeId: null,
                },
            },
        }));

        await useWorkspaceStore.getState().openChatSessionTab({
            projectId: "project-1",
            runtimeId: "codex",
            sessionId: "session-persisted",
            title: "Recovered session",
            worktreeId: "worktree-1",
        });

        const state = useWorkspaceStore.getState();
        const leftPane =
            state.rootNode.type === "split" ? state.rootNode.children[0] : null;
        const rightPane =
            state.rootNode.type === "split" ? state.rootNode.children[1] : null;

        if (leftPane?.type !== "pane" || rightPane?.type !== "pane") {
            throw new Error("Expected a split workspace with pane children.");
        }

        expect(Object.keys(state.tabsById)).toEqual(["chat-existing"]);
        expect(leftPane.tabIds).toEqual(["chat-existing"]);
        expect(rightPane.tabIds).toEqual([]);
        expect(state.activePaneId).toBe("pane-left");
        expect(leftPane.activeTabId).toBe("chat-existing");
        expect(state.tabsById["chat-existing"]).toMatchObject({
            kind: "chat",
            projectId: "project-1",
            runtimeId: "codex",
            sessionId: "session-persisted",
            title: "Recovered session",
            worktreeId: "worktree-1",
        });
        expect(ensureSessionMock).toHaveBeenCalledTimes(1);
        expect(ensureSessionMock).toHaveBeenCalledWith(
            expect.objectContaining({
                id: "chat-existing",
                kind: "chat",
                projectId: "project-1",
                runtimeId: "codex",
                sessionId: "session-persisted",
                title: "Recovered session",
                worktreeId: "worktree-1",
            }),
        );
        await flushWorkspacePersistenceForTests();
        expect(saveWorkspaceSnapshotMock).toHaveBeenCalled();
    });

    it("creates a chat tab and hydrates it when opening a persisted session that is not open yet", async () => {
        await useWorkspaceStore.getState().openChatSessionTab({
            projectId: "project-1",
            runtimeId: "gemini",
            sessionId: "session-new-history",
            title: "Recovered Gemini session",
            worktreeId: "worktree-9",
        });

        const state = useWorkspaceStore.getState();
        const rootPane = state.rootNode.type === "pane" ? state.rootNode : null;

        if (!rootPane) {
            throw new Error("Expected the default workspace root pane.");
        }

        expect(rootPane.tabIds).toHaveLength(1);
        expect(rootPane.activeTabId).toBe(rootPane.tabIds[0]);
        const openedTabId = rootPane.tabIds[0];
        expect(openedTabId).toBeTruthy();
        expect(openedTabId ? state.tabsById[openedTabId] : null).toMatchObject({
            kind: "chat",
            projectId: "project-1",
            runtimeId: "gemini",
            sessionId: "session-new-history",
            title: "Recovered Gemini session",
            worktreeId: "worktree-9",
        });
        expect(ensureSessionMock).toHaveBeenCalledTimes(1);
        expect(ensureSessionMock).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: "chat",
                projectId: "project-1",
                runtimeId: "gemini",
                sessionId: "session-new-history",
                title: "Recovered Gemini session",
                worktreeId: "worktree-9",
            }),
        );
        await flushWorkspacePersistenceForTests();
        expect(saveWorkspaceSnapshotMock).toHaveBeenCalled();
    });
});

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

    it("prefers the most recent scoped chat when the last focused chat is out of scope", () => {
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
                recentFocusedChatTabIds: ["chat-worktree", "chat-root"],
                worktreeId: "worktree-1",
            }),
        ).toBe("chat-worktree");
    });

    it("tracks chat focus recency without overwriting it when a file tab is selected", async () => {
        useWorkspaceStore.setState((state) => ({
            ...state,
            activePaneId: "pane-a",
            rootNode: {
                axis: "horizontal",
                children: [
                    {
                        activeTabId: "chat-1",
                        id: "pane-a",
                        tabIds: ["chat-1", "file-1"],
                        type: "pane",
                    },
                    {
                        activeTabId: "chat-2",
                        id: "pane-b",
                        tabIds: ["chat-2"],
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
                    projectId: "project-1",
                    runtimeId: "codex",
                    sessionId: "session-1",
                    title: "Codex 1",
                    worktreeId: null,
                },
                "chat-2": {
                    createdAt: "2026-04-14T00:00:00.000Z",
                    draft: "",
                    id: "chat-2",
                    kind: "chat",
                    projectId: "project-1",
                    runtimeId: "claude",
                    sessionId: "session-2",
                    title: "Claude 1",
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
        }));

        await useWorkspaceStore.getState().selectTab("pane-a", "chat-1");
        await useWorkspaceStore.getState().selectTab("pane-b", "chat-2");
        await useWorkspaceStore.getState().selectTab("pane-a", "file-1");

        const state = useWorkspaceStore.getState();

        expect(state.lastFocusedChatTabId).toBe("chat-2");
        expect(state.recentFocusedChatTabIds.slice(0, 2)).toEqual([
            "chat-2",
            "chat-1",
        ]);
    });

    it("falls back to the previous focused chat after closing the current favorite", async () => {
        useWorkspaceStore.setState((state) => ({
            ...state,
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
                        activeTabId: "chat-2",
                        id: "pane-b",
                        tabIds: ["chat-2"],
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
                    projectId: "project-1",
                    runtimeId: "codex",
                    sessionId: "session-1",
                    title: "Codex 1",
                    worktreeId: null,
                },
                "chat-2": {
                    createdAt: "2026-04-14T00:00:00.000Z",
                    draft: "",
                    id: "chat-2",
                    kind: "chat",
                    projectId: "project-1",
                    runtimeId: "claude",
                    sessionId: "session-2",
                    title: "Claude 1",
                    worktreeId: null,
                },
            },
        }));

        useWorkspaceStore.getState().markChatTabFocused("chat-1");
        useWorkspaceStore.getState().markChatTabFocused("chat-2");

        await useWorkspaceStore.getState().closeTab("chat-2");

        const state = useWorkspaceStore.getState();

        expect(state.lastFocusedChatTabId).toBe("chat-1");
        expect(state.lastFocusedRuntimeId).toBe("codex");
        expect(state.recentFocusedChatTabIds[0]).toBe("chat-1");
    });

    it("reactivates the most recently focused sibling tab when closing the active tab", async () => {
        useWorkspaceStore.setState((state) => ({
            ...state,
            activePaneId: "pane-a",
            rootNode: {
                activeTabId: "file-3",
                id: "pane-a",
                tabIds: ["file-1", "file-2", "file-3"],
                type: "pane",
            },
            tabsById: {
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
                    relativePath: "a.ts",
                    reviewContext: null,
                    saveError: null,
                    savedContent: "",
                    title: "a.ts",
                    worktreeId: null,
                },
                "file-2": {
                    createdAt: "2026-04-14T00:00:00.000Z",
                    document: null,
                    draftContent: "",
                    hasExternalChange: false,
                    id: "file-2",
                    isDirty: false,
                    isLoading: false,
                    isSaving: false,
                    kind: "file",
                    loadError: null,
                    projectId: "project-1",
                    relativePath: "b.ts",
                    reviewContext: null,
                    saveError: null,
                    savedContent: "",
                    title: "b.ts",
                    worktreeId: null,
                },
                "file-3": {
                    createdAt: "2026-04-14T00:00:00.000Z",
                    document: null,
                    draftContent: "",
                    hasExternalChange: false,
                    id: "file-3",
                    isDirty: false,
                    isLoading: false,
                    isSaving: false,
                    kind: "file",
                    loadError: null,
                    projectId: "project-1",
                    relativePath: "c.ts",
                    reviewContext: null,
                    saveError: null,
                    savedContent: "",
                    title: "c.ts",
                    worktreeId: null,
                },
            },
            recentActiveTabIds: ["file-3", "file-1", "file-2"],
        }));

        await useWorkspaceStore.getState().closeTab("file-3");

        const state = useWorkspaceStore.getState();
        if (state.rootNode.type !== "pane") {
            throw new Error("Expected a single pane workspace.");
        }

        expect(state.rootNode.tabIds).toEqual(["file-1", "file-2"]);
        expect(state.rootNode.activeTabId).toBe("file-1");
        expect(state.recentActiveTabIds).toEqual(["file-1", "file-2"]);
    });

    it("reactivates the most recently focused sibling tab when moving an active tab to another pane", async () => {
        useWorkspaceStore.setState((state) => ({
            ...state,
            activePaneId: "pane-b",
            rootNode: {
                axis: "horizontal",
                children: [
                    {
                        activeTabId: "file-3",
                        id: "pane-a",
                        tabIds: ["file-1", "file-2", "file-3"],
                        type: "pane",
                    },
                    {
                        activeTabId: "file-4",
                        id: "pane-b",
                        tabIds: ["file-4"],
                        type: "pane",
                    },
                ],
                id: "split-root",
                sizes: [0.5, 0.5],
                type: "split",
            },
            tabsById: {
                "file-1": createWorkspaceFileTab("file-1", "a.ts"),
                "file-2": createWorkspaceFileTab("file-2", "b.ts"),
                "file-3": createWorkspaceFileTab("file-3", "c.ts"),
                "file-4": createWorkspaceFileTab("file-4", "d.ts"),
            },
            recentActiveTabIds: ["file-3", "file-1", "file-2", "file-4"],
        }));

        await useWorkspaceStore.getState().moveTabToPane(
            "file-3",
            "pane-a",
            "pane-b",
            0,
        );

        const state = useWorkspaceStore.getState();
        const sourcePane = findWorkspacePane(state.rootNode, "pane-a");
        const targetPane = findWorkspacePane(state.rootNode, "pane-b");

        expect(sourcePane?.tabIds).toEqual(["file-1", "file-2"]);
        expect(sourcePane?.activeTabId).toBe("file-1");
        expect(targetPane?.tabIds).toEqual(["file-3", "file-4"]);
        expect(targetPane?.activeTabId).toBe("file-3");
        expect(state.activePaneId).toBe("pane-b");
    });

    it("falls back to the left sibling when moving an active tab without pane history", async () => {
        useWorkspaceStore.setState((state) => ({
            ...state,
            activePaneId: "pane-b",
            rootNode: {
                axis: "horizontal",
                children: [
                    {
                        activeTabId: "file-2",
                        id: "pane-a",
                        tabIds: ["file-1", "file-2", "file-3"],
                        type: "pane",
                    },
                    {
                        activeTabId: "file-4",
                        id: "pane-b",
                        tabIds: ["file-4"],
                        type: "pane",
                    },
                ],
                id: "split-root",
                sizes: [0.5, 0.5],
                type: "split",
            },
            tabsById: {
                "file-1": createWorkspaceFileTab("file-1", "a.ts"),
                "file-2": createWorkspaceFileTab("file-2", "b.ts"),
                "file-3": createWorkspaceFileTab("file-3", "c.ts"),
                "file-4": createWorkspaceFileTab("file-4", "d.ts"),
            },
            recentActiveTabIds: ["file-2", "file-4"],
        }));

        await useWorkspaceStore.getState().moveTabToPane(
            "file-2",
            "pane-a",
            "pane-b",
            0,
        );

        const state = useWorkspaceStore.getState();
        const sourcePane = findWorkspacePane(state.rootNode, "pane-a");

        expect(sourcePane?.tabIds).toEqual(["file-1", "file-3"]);
        expect(sourcePane?.activeTabId).toBe("file-1");
    });

    it("reopens the most recently closed tab in its original pane position", async () => {
        useWorkspaceStore.setState((state) => ({
            ...state,
            activePaneId: "pane-a",
            rootNode: {
                activeTabId: "file-3",
                id: "pane-a",
                tabIds: ["file-1", "file-2", "file-3"],
                type: "pane",
            },
            tabsById: {
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
                    relativePath: "a.ts",
                    reviewContext: null,
                    saveError: null,
                    savedContent: "",
                    title: "a.ts",
                    worktreeId: null,
                },
                "file-2": {
                    createdAt: "2026-04-14T00:00:00.000Z",
                    document: null,
                    draftContent: "",
                    hasExternalChange: false,
                    id: "file-2",
                    isDirty: false,
                    isLoading: false,
                    isSaving: false,
                    kind: "file",
                    loadError: null,
                    projectId: "project-1",
                    relativePath: "b.ts",
                    reviewContext: null,
                    saveError: null,
                    savedContent: "",
                    title: "b.ts",
                    worktreeId: null,
                },
                "file-3": {
                    createdAt: "2026-04-14T00:00:00.000Z",
                    document: null,
                    draftContent: "",
                    hasExternalChange: false,
                    id: "file-3",
                    isDirty: false,
                    isLoading: false,
                    isSaving: false,
                    kind: "file",
                    loadError: null,
                    projectId: "project-1",
                    relativePath: "c.ts",
                    reviewContext: null,
                    saveError: null,
                    savedContent: "",
                    title: "c.ts",
                    worktreeId: null,
                },
            },
        }));

        await useWorkspaceStore.getState().closeTab("file-2");
        await useWorkspaceStore.getState().reopenLastClosedTab();

        const state = useWorkspaceStore.getState();
        if (state.rootNode.type !== "pane") {
            throw new Error("Expected a single pane workspace.");
        }

        expect(state.rootNode.tabIds).toEqual(["file-1", "file-2", "file-3"]);
        expect(state.rootNode.activeTabId).toBe("file-2");
        expect(
            state.recentClosedTabs.some((entry) => entry.tab.id === "file-2"),
        ).toBe(false);
    });

    it("restores unsaved file buffers when reopening a closed dirty tab", async () => {
        useWorkspaceStore.setState((state) => ({
            ...state,
            activePaneId: "pane-a",
            rootNode: {
                activeTabId: "file-1",
                id: "pane-a",
                tabIds: ["file-1"],
                type: "pane",
            },
            tabsById: {
                "file-1": {
                    createdAt: "2026-04-14T00:00:00.000Z",
                    document: {
                        absolutePath: "/tmp/a.ts",
                        content: "export const value = 1;\n",
                        imageDataBase64: null,
                        isBinary: false,
                        isTooLarge: false,
                        kind: "text",
                        languageId: "typescript",
                        languageLabel: "TypeScript",
                        mimeType: "text/typescript",
                        modifiedAtMs: 1,
                        name: "a.ts",
                        projectId: "project-1",
                        relativePath: "a.ts",
                        sizeBytes: 24,
                    },
                    draftContent: "export const value = 2;\n",
                    hasExternalChange: false,
                    id: "file-1",
                    isDirty: true,
                    isLoading: false,
                    isSaving: false,
                    kind: "file",
                    loadError: null,
                    projectId: "project-1",
                    relativePath: "a.ts",
                    reviewContext: null,
                    saveError: null,
                    savedContent: "export const value = 1;\n",
                    title: "a.ts",
                    worktreeId: null,
                },
            },
        }));

        await useWorkspaceStore.getState().closeTab("file-1");
        await useWorkspaceStore.getState().reopenLastClosedTab();

        expect(notifyFileBufferMock).toHaveBeenNthCalledWith(1, {
            absolutePath: "/tmp/a.ts",
            content: null,
        });
        expect(notifyFileBufferMock).toHaveBeenNthCalledWith(2, {
            absolutePath: "/tmp/a.ts",
            content: "export const value = 2;\n",
        });
        expect(useWorkspaceStore.getState().tabsById["file-1"]).toMatchObject({
            draftContent: "export const value = 2;\n",
            isDirty: true,
        });
    });

    it("reopens a closed chat tab after closing its live session", async () => {
        closeAiSessionMock.mockClear();

        useWorkspaceStore.setState((state) => ({
            ...state,
            activePaneId: "pane-a",
            rootNode: {
                activeTabId: "chat-1",
                id: "pane-a",
                tabIds: ["chat-1"],
                type: "pane",
            },
            tabsById: {
                "chat-1": {
                    createdAt: "2026-04-14T00:00:00.000Z",
                    draft: "Hello again",
                    id: "chat-1",
                    kind: "chat",
                    projectId: "project-1",
                    runtimeId: "codex",
                    sessionId: "session-1",
                    title: "Codex 1",
                    worktreeId: null,
                },
            },
        }));

        await useWorkspaceStore.getState().closeTab("chat-1");
        await useWorkspaceStore.getState().reopenLastClosedTab();

        expect(closeAiSessionMock).toHaveBeenCalledWith("session-1");
        expect(useWorkspaceStore.getState().tabsById["chat-1"]).toMatchObject({
            id: "chat-1",
            sessionId: "session-1",
            title: "Codex 1",
        });
    });

    it("closes the live terminal session when a terminal tab is closed", async () => {
        resetWorkspacePersistenceForTests();
        closeTerminalSessionMock.mockClear();
        saveWorkspaceSnapshotMock.mockClear();

        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    closeTerminalSession: closeTerminalSessionMock,
                    saveWorkspaceSnapshot: saveWorkspaceSnapshotMock,
                },
            },
            writable: true,
        });

        useWorkspaceStore.setState((state) => ({
            ...state,
            ...createDefaultWorkspaceState(),
            error: null,
            hydrated: true,
            lastFocusedChatTabId: null,
            lastFocusedRuntimeId: "codex",
            lastQuickCreateAction: "codex",
            recentActiveTabIds: [],
            recentClosedTabs: [],
            recentFocusedChatTabIds: [],
        }), true);

        useWorkspaceStore.setState((state) => ({
            ...state,
            activePaneId: "pane-a",
            rootNode: {
                activeTabId: "terminal-1",
                id: "pane-a",
                tabIds: ["terminal-1"],
                type: "pane",
            },
            tabsById: {
                "terminal-1": {
                    createdAt: "2026-04-14T00:00:00.000Z",
                    exitCode: null,
                    id: "terminal-1",
                    isReady: true,
                    kind: "terminal",
                    launchError: null,
                    output: "",
                    projectId: "project-1",
                    session: {
                        cwd: "/tmp",
                        projectId: "project-1",
                        sessionId: "terminal-session-1",
                        worktreeId: null,
                    },
                    sessionId: "terminal-session-1",
                    signalCode: null,
                    title: "Terminal 1",
                    worktreeId: null,
                },
            },
        }));

        await useWorkspaceStore.getState().closeTab("terminal-1");

        expect(closeTerminalSessionMock).toHaveBeenCalledWith(
            "terminal-session-1",
        );
        expect(useWorkspaceStore.getState().tabsById["terminal-1"]).toBeUndefined();
    });
});
