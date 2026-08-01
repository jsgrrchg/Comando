import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { editor as MonacoEditor } from "monaco-editor";

import type {
    ProjectFileDocument,
    WorkspacePaneNode,
    WorkspaceSnapshot,
} from "@shared/ipc";
import { buildAiRuntimeCatalog } from "@shared/ai-runtimes";

import {
    createDefaultWorkspaceState,
    type WorkspaceTreeState,
} from "../workspace/tree";
import { useAiStore } from "./ai-store";
import {
    resetSettingsStoreForTests,
    useSettingsStore,
} from "./settings-store";
import {
    flushWorkspacePersistenceForTests,
    flushWorkspacePersistenceNow,
    getBestMatchingChatTabId,
    getPaneChatTabId,
    getPaneRuntimeId,
    getWorkspaceChatTabId,
    getWorkspaceTabRuntimeId,
    resetWorkspacePersistenceForTests,
    useWorkspaceStore,
} from "./workspace-store";
import {
    resetWorkspaceSurfaceLayoutRuntimeForTests,
    setWorkspaceSurfaceLayoutPersistenceForTests,
} from "../workspace/workspace-surface-layout-runtime";

const persistWorkspaceLayoutMock = vi.fn<
    (input: {
        readonly layout: WorkspaceSnapshot;
        readonly scopeKey: string;
    }) => Promise<void>
>(() => Promise.resolve());
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
const saveProjectFileMock =
    vi.fn<
        (input: {
            readonly content: string;
            readonly expectedModifiedAtMs?: number | null;
            readonly projectId: string;
            readonly relativePath: string;
            readonly worktreeId?: string | null;
        }) => Promise<ProjectFileDocument>
    >();
const originalEnsureSession = useAiStore.getState().ensureSession;

function createWorkspaceFileTab(id: string, relativePath: string) {
    return {
        createdAt: "2026-04-14T00:00:00.000Z",
        contentRevision: 0,
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

function createProjectFileDocument(
    relativePath: string,
    content: string,
    modifiedAtMs = 1,
): ProjectFileDocument {
    return {
        absolutePath: `/tmp/${relativePath}`,
        content,
        imageDataBase64: null,
        isBinary: false,
        isTooLarge: false,
        kind: "text",
        languageId: "typescript",
        languageLabel: "TypeScript",
        mimeType: "text/typescript",
        modifiedAtMs,
        name: relativePath.split("/").at(-1) ?? relativePath,
        projectId: "project-1",
        relativePath,
        sizeBytes: content.length,
    };
}

function createLoadedWorkspaceFileTab(
    id: string,
    relativePath: string,
    content: string,
) {
    return {
        ...createWorkspaceFileTab(id, relativePath),
        document: createProjectFileDocument(relativePath, content),
        draftContent: content,
        savedContent: content,
        title: relativePath.split("/").at(-1) ?? relativePath,
    };
}

function createWorkspaceChatTab(
    id: string,
    sessionId: string,
    runtimeId: "claude" | "codex" | "grok" | "kilo" | "opencode",
) {
    return {
        createdAt: "2026-04-14T00:00:00.000Z",
        draft: "",
        id,
        kind: "chat" as const,
        projectId: "project-1",
        runtimeId,
        sessionId,
        title: `${runtimeId} chat`,
        worktreeId: null,
    };
}

function findWorkspacePane(
    node: WorkspaceTreeState["rootNode"],
    paneId: string,
): WorkspacePaneNode | null {
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

function getActivePersistedLayout(input: {
    readonly layout: WorkspaceSnapshot;
}) {
    return input.layout;
}

function createDeferred<T>() {
    let resolve: (value: T) => void = (_value: T): void => {
        void _value;
        throw new Error("Deferred promise was not initialized.");
    };
    const promise = new Promise<T>((nextResolve) => {
        resolve = nextResolve;
    });

    return {
        promise,
        resolve: (value: T) => resolve(value),
    };
}

function installActivationFrameQueue(): FrameRequestCallback[] {
    const activationFrames: FrameRequestCallback[] = [];
    Object.assign(window, {
        cancelAnimationFrame: vi.fn(),
        requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
            activationFrames.push(callback);
            return activationFrames.length;
        }),
    });
    return activationFrames;
}

beforeEach(() => {
    persistWorkspaceLayoutMock.mockClear();
    setWorkspaceSurfaceLayoutPersistenceForTests(persistWorkspaceLayoutMock);
});

afterEach(() => {
    resetWorkspaceSurfaceLayoutRuntimeForTests();
});

describe("workspace file opening", () => {
    beforeEach(() => {
        resetWorkspacePersistenceForTests();
        resetSettingsStoreForTests();
        persistWorkspaceLayoutMock.mockClear();
        closeAiSessionMock.mockClear();
        closeTerminalSessionMock.mockClear();
        ensureSessionMock.mockClear();
        notifyFileBufferMock.mockClear();
        openProjectFileMock.mockReset();
        saveProjectFileMock.mockReset();
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
        saveProjectFileMock.mockImplementation((input) =>
            Promise.resolve({
                absolutePath: `/tmp/${input.relativePath}`,
                content: input.content,
                imageDataBase64: null,
                isBinary: false,
                isTooLarge: false,
                kind: "text",
                languageId: "typescript",
                languageLabel: "TypeScript",
                mimeType: "text/typescript",
                modifiedAtMs: 2,
                name:
                    input.relativePath.split("/").at(-1) ?? input.relativePath,
                projectId: input.projectId,
                relativePath: input.relativePath,
                sizeBytes: input.content.length,
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
                    saveProjectFile: saveProjectFileMock,
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

        const defaultWorkspace = createDefaultWorkspaceState();
        const contextKey = "project-1::__primary__";
        useWorkspaceStore.setState((state) => ({
            ...state,
            ...defaultWorkspace,
            activeContextKey: contextKey,
            contextsByKey: {
                [contextKey]: {
                    key: contextKey,
                    lastActivatedAt: "2026-04-14T00:00:00.000Z",
                    projectId: "project-1",
                    workspace: defaultWorkspace,
                    worktreeId: null,
                },
            },
            error: null,
            deferredPaneIds: new Set(),
            hydrated: true,
            lastFocusedChatTabId: null,
            lastFocusedRuntimeId: "codex",
            lastQuickCreateAction: "codex",
            recentActiveTabIds: [],
            recentClosedTabs: [],
            recentFocusedChatTabIds: [],
            scopeEpoch: 0,
        }), true);
    });

    afterEach(() => {
        resetWorkspacePersistenceForTests();
        resetSettingsStoreForTests();
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

    it("restores a durable scope layout after switching away", async () => {
        const firstTab = createWorkspaceFileTab("file-project-1", "README.md");
        useWorkspaceStore.setState((state) => ({
            ...state,
            activePaneId: "pane-root",
            rootNode: {
                activeTabId: firstTab.id,
                id: "pane-root",
                tabIds: [firstTab.id],
                type: "pane",
            },
            tabsById: { [firstTab.id]: firstTab },
        }));

        await useWorkspaceStore.getState().requestWorkspaceNavigation("project-2", null, {
            emptyLayout: true,
        });
        expect(useWorkspaceStore.getState().tabsById).toEqual({});

        const secondTab = createWorkspaceFileTab(
            "file-project-2",
            "src/index.ts",
        );
        useWorkspaceStore.setState((state) => ({
            ...state,
            rootNode: {
                activeTabId: secondTab.id,
                id: "pane-root",
                tabIds: [secondTab.id],
                type: "pane",
            },
            tabsById: {
                [secondTab.id]: { ...secondTab, projectId: "project-2" },
            },
        }));

        await useWorkspaceStore
            .getState()
            .activateWorkspaceLayout("project-1::__primary__");
        expect(useWorkspaceStore.getState().tabsById[firstTab.id]).toBeTruthy();
        expect(
            useWorkspaceStore.getState().tabsById[secondTab.id],
        ).toBeUndefined();

        await useWorkspaceStore.getState().requestWorkspaceNavigation("project-2");
        await useWorkspaceStore.getState().requestWorkspaceNavigation("project-2");
        expect(Object.keys(useWorkspaceStore.getState().contextsByKey)).toEqual([
            "project-1::__primary__",
            "project-2::__primary__",
        ]);
        expect(useWorkspaceStore.getState().tabsById[secondTab.id]).toBeTruthy();

        await useWorkspaceStore
            .getState()
            .activateWorkspaceLayout("project-1::__primary__");
        expect(useWorkspaceStore.getState().activeContextKey).toBe(
            "project-1::__primary__",
        );

        await flushWorkspacePersistenceForTests();
        const persistedSnapshot =
            persistWorkspaceLayoutMock.mock.calls.at(-1)?.[0];
        expect(persistedSnapshot).toMatchObject({
            scopeKey: "project-1::__primary__",
        });
        expect(persistedSnapshot?.layout.tabs).toEqual([
            expect.objectContaining({ id: firstTab.id }),
        ]);

        await useWorkspaceStore.getState().requestWorkspaceNavigation("project-2");
        expect(Object.keys(useWorkspaceStore.getState().contextsByKey)).toEqual([
            "project-1::__primary__",
            "project-2::__primary__",
        ]);
        expect(useWorkspaceStore.getState().tabsById[secondTab.id]).toBeTruthy();
    });

    it("registers a catalog context without changing the committed host selection", async () => {
        const before = useWorkspaceStore.getState();
        const contextKey = await before.registerWorkspaceScope(
            "project-2",
            "worktree-feature",
        );
        const after = useWorkspaceStore.getState();

        expect(contextKey).toBe("project-2::worktree-feature");
        expect(after.activeContextKey).toBe("project-1::__primary__");
        expect(Object.keys(after.contextsByKey)).toContain(
            "project-2::worktree-feature",
        );
        expect(after.contextsByKey[contextKey]).toMatchObject({
            projectId: "project-2",
            worktreeId: "worktree-feature",
        });
        expect(after.tabsById).toEqual(before.tabsById);
    });

    it("exports every durable scope through the surface registry", () => {
        const tab = createWorkspaceFileTab("file-project-1", "README.md");
        useWorkspaceStore.setState((state) => ({
            ...state,
            activePaneId: "pane-root",
            rootNode: {
                activeTabId: tab.id,
                id: "pane-root",
                tabIds: [tab.id],
                type: "pane",
            },
            tabsById: { [tab.id]: tab },
        }));

        const registry = useWorkspaceStore
            .getState()
            .getWorkspaceSurfaceRegistry();

        expect(registry).toMatchObject({
            activeScopeKey: "project-1::__primary__",
        });
        expect(registry.workspaces).toHaveLength(1);
        expect(registry.workspaces[0]).toMatchObject({
            projectId: "project-1",
            scopeKey: "project-1::__primary__",
            worktreeId: null,
        });
        expect(registry.workspaces[0]?.initialLayout).toMatchObject({
            activePaneId: "pane-root",
            tabs: [
                expect.objectContaining({
                    id: tab.id,
                    relativePath: "README.md",
                }),
            ],
        });
    });

    it("retains every durable context without a closed-layout quota", () => {
        const workspace = createDefaultWorkspaceState();
        const contextsByKey = Object.fromEntries(
            Array.from({ length: 31 }, (_, index) => [
                `closed-${index}`,
                {
                    key: `closed-${index}`,
                    lastActivatedAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
                    projectId: `project-${index}`,
                    workspace,
                    worktreeId: null,
                },
            ]),
        );
        contextsByKey.open = {
            key: "open",
            lastActivatedAt: "2020-01-01T00:00:00.000Z",
            projectId: "open-project",
            workspace,
            worktreeId: null,
        };

        useWorkspaceStore.setState({ contextsByKey });

        expect(
            useWorkspaceStore.getState().getWorkspaceSurfaceRegistry().workspaces,
        ).toHaveLength(32);
    });

    it("removes cached layouts when a project is removed", async () => {
        const workspace = createDefaultWorkspaceState();
        const remainingContext = {
            key: "project-2::__primary__",
            lastActivatedAt: "2026-04-15T00:00:00.000Z",
            projectId: "project-2",
            workspace,
            worktreeId: null,
        };
        useWorkspaceStore.setState((state) => ({
            ...state,
            contextsByKey: {
                ...state.contextsByKey,
                [remainingContext.key]: remainingContext,
                "project-1::worktree-1": {
                    key: "project-1::worktree-1",
                    lastActivatedAt: "2026-04-16T00:00:00.000Z",
                    projectId: "project-1",
                    workspace,
                    worktreeId: "worktree-1",
                },
            },
        }));

        await useWorkspaceStore.getState().removeProjectTabs("project-1");

        expect(useWorkspaceStore.getState().contextsByKey).toEqual({
            [remainingContext.key]: remainingContext,
        });
        expect(useWorkspaceStore.getState().activeContextKey).toBe(remainingContext.key);
    });

    it("hydrates and prewarms each active durable chat session", async () => {
        const snapshot: WorkspaceSnapshot = {
            activePaneId: "pane-left",
            rootNode: {
                axis: "horizontal",
                children: [
                    {
                        activeTabId: "chat-left",
                        id: "pane-left",
                        tabIds: ["chat-left", "chat-inactive"],
                        type: "pane",
                    },
                    {
                        activeTabId: "chat-right",
                        id: "pane-right",
                        tabIds: ["chat-right"],
                        type: "pane",
                    },
                ],
                id: "split-root",
                sizes: [0.5, 0.5],
                type: "split",
            },
            tabs: [
                createWorkspaceChatTab("chat-left", "session-left", "codex"),
                createWorkspaceChatTab(
                    "chat-inactive",
                    "session-inactive",
                    "claude",
                ),
                createWorkspaceChatTab("chat-right", "session-right", "grok"),
            ],
        };
        await useWorkspaceStore.getState().hydrateSurfaceLayout({
            generation: "surface-1",
            lastActivatedAt: "2026-08-01T00:00:00.000Z",
            layout: snapshot,
            projectId: "project-1",
            revision: 1,
            scopeKey: "project-1::__primary__",
            worktreeId: null,
        });

        await vi.waitFor(() => {
            expect(ensureSessionMock).toHaveBeenCalledTimes(2);
        });
        expect(ensureSessionMock).toHaveBeenCalledWith(
            expect.objectContaining({ sessionId: "session-left" }),
        );
        expect(ensureSessionMock).toHaveBeenCalledWith(
            expect.objectContaining({ sessionId: "session-right" }),
        );
        expect(ensureSessionMock).not.toHaveBeenCalledWith(
            expect.objectContaining({ sessionId: "session-inactive" }),
        );
    });

    it("does not delay surface layout hydration on active file I/O", async () => {
        const pendingFile = createDeferred<ProjectFileDocument>();
        openProjectFileMock.mockReturnValueOnce(pendingFile.promise);
        const activeFile = createWorkspaceFileTab(
            "active-file",
            "src/active.ts",
        );
        const snapshot: WorkspaceSnapshot = {
            activePaneId: "pane-root",
            rootNode: {
                activeTabId: activeFile.id,
                id: "pane-root",
                tabIds: [activeFile.id],
                type: "pane",
            },
            tabs: [activeFile],
        };

        await expect(
            useWorkspaceStore.getState().hydrateSurfaceLayout({
                generation: "surface-1",
                lastActivatedAt: "2026-08-01T00:00:00.000Z",
                layout: snapshot,
                projectId: "project-1",
                revision: 1,
                scopeKey: "project-1::__primary__",
                worktreeId: null,
            }),
        ).resolves.toBeUndefined();
        expect(openProjectFileMock).toHaveBeenCalledOnce();
        expect(
            useWorkspaceStore.getState().tabsById[activeFile.id],
        ).toMatchObject({ isLoading: true });

        pendingFile.resolve(
            createProjectFileDocument(activeFile.relativePath, "ready\n"),
        );
        await vi.waitFor(() =>
            expect(
                useWorkspaceStore.getState().tabsById[activeFile.id],
            ).toMatchObject({ isLoading: false, savedContent: "ready\n" }),
        );
    });

    it("hydrates only active file tabs and loads inactive files on focus", async () => {
        const activeFile = createWorkspaceFileTab(
            "active-file",
            "src/active.ts",
        );
        const inactiveFile = createWorkspaceFileTab(
            "inactive-file",
            "src/inactive.ts",
        );
        const targetContextKey = "project-2::__primary__";
        const targetWorkspace: WorkspaceTreeState = {
            activePaneId: "pane-root",
            rootNode: {
                activeTabId: activeFile.id,
                id: "pane-root",
                tabIds: [activeFile.id, inactiveFile.id],
                type: "pane",
            },
            tabsById: {
                [activeFile.id]: {
                    ...activeFile,
                    projectId: "project-2",
                },
                [inactiveFile.id]: {
                    ...inactiveFile,
                    projectId: "project-2",
                },
            },
        };

        useWorkspaceStore.setState((state) => ({
            ...state,
            contextsByKey: {
                ...state.contextsByKey,
                [targetContextKey]: {
                    key: targetContextKey,
                    lastActivatedAt: "2026-04-14T00:00:00.000Z",
                    projectId: "project-2",
                    workspace: targetWorkspace,
                    worktreeId: null,
                },
            },
        }));

        await useWorkspaceStore.getState().activateWorkspaceLayout(targetContextKey);

        await vi.waitFor(() => {
            expect(openProjectFileMock).toHaveBeenCalledTimes(1);
        });
        expect(openProjectFileMock).toHaveBeenCalledWith({
            projectId: "project-2",
            relativePath: activeFile.relativePath,
            worktreeId: null,
        });

        await useWorkspaceStore
            .getState()
            .selectTab("pane-root", inactiveFile.id);

        await vi.waitFor(() => {
            expect(openProjectFileMock).toHaveBeenCalledTimes(2);
        });
        expect(openProjectFileMock).toHaveBeenLastCalledWith({
            projectId: "project-2",
            relativePath: inactiveFile.relativePath,
            worktreeId: null,
        });
    });

    it("defers secondary pane hydration until after the activation frame", async () => {
        const activationFrames = installActivationFrameQueue();

        const focusedFile = createWorkspaceFileTab(
            "focused-file",
            "src/focused.ts",
        );
        const secondaryFile = createWorkspaceFileTab(
            "secondary-file",
            "src/secondary.ts",
        );
        const tertiaryFile = createWorkspaceFileTab(
            "tertiary-file",
            "src/tertiary.ts",
        );
        const targetContextKey = "project-2::__primary__";
        const targetWorkspace: WorkspaceTreeState = {
            activePaneId: "pane-left",
            rootNode: {
                axis: "horizontal",
                children: [
                    {
                        activeTabId: focusedFile.id,
                        id: "pane-left",
                        tabIds: [focusedFile.id],
                        type: "pane",
                    },
                    {
                        activeTabId: secondaryFile.id,
                        id: "pane-right",
                        tabIds: [secondaryFile.id],
                        type: "pane",
                    },
                    {
                        activeTabId: tertiaryFile.id,
                        id: "pane-far-right",
                        tabIds: [tertiaryFile.id],
                        type: "pane",
                    },
                ],
                id: "split-root",
                sizes: [0.34, 0.33, 0.33],
                type: "split",
            },
            tabsById: {
                [focusedFile.id]: { ...focusedFile, projectId: "project-2" },
                [secondaryFile.id]: {
                    ...secondaryFile,
                    projectId: "project-2",
                },
                [tertiaryFile.id]: {
                    ...tertiaryFile,
                    projectId: "project-2",
                },
            },
        };

        useWorkspaceStore.setState((state) => ({
            ...state,
            contextsByKey: {
                ...state.contextsByKey,
                [targetContextKey]: {
                    key: targetContextKey,
                    lastActivatedAt: "2026-04-14T00:00:00.000Z",
                    projectId: "project-2",
                    workspace: targetWorkspace,
                    worktreeId: null,
                },
            },
        }));

        await useWorkspaceStore.getState().activateWorkspaceLayout(targetContextKey);

        expect(openProjectFileMock).toHaveBeenCalledTimes(1);
        expect(openProjectFileMock).toHaveBeenCalledWith({
            projectId: "project-2",
            relativePath: focusedFile.relativePath,
            worktreeId: null,
        });
        expect(useWorkspaceStore.getState().deferredPaneIds).toEqual(
            new Set(["pane-right", "pane-far-right"]),
        );

        activationFrames.shift()?.(performance.now());
        await vi.waitFor(() => {
            expect(openProjectFileMock).toHaveBeenCalledTimes(2);
        });
        expect(openProjectFileMock).toHaveBeenLastCalledWith({
            projectId: "project-2",
            relativePath: secondaryFile.relativePath,
            worktreeId: null,
        });
        expect(useWorkspaceStore.getState().deferredPaneIds).toEqual(
            new Set(["pane-far-right"]),
        );

        expect(activationFrames).toHaveLength(1);
        activationFrames.shift()?.(performance.now());
        await vi.waitFor(() => {
            expect(openProjectFileMock).toHaveBeenCalledTimes(3);
        });
        expect(openProjectFileMock).toHaveBeenLastCalledWith({
            projectId: "project-2",
            relativePath: tertiaryFile.relativePath,
            worktreeId: null,
        });
        expect(useWorkspaceStore.getState().deferredPaneIds.size).toBe(0);
    });

    it("does not promote a background tab when the focused pane is empty", async () => {
        const activationFrames = installActivationFrameQueue();
        const backgroundFile = createWorkspaceFileTab(
            "background-file",
            "src/background.ts",
        );
        const targetContextKey = "project-2::__primary__";
        const targetWorkspace: WorkspaceTreeState = {
            activePaneId: "pane-empty",
            rootNode: {
                axis: "horizontal",
                children: [
                    {
                        activeTabId: null,
                        id: "pane-empty",
                        tabIds: [],
                        type: "pane",
                    },
                    {
                        activeTabId: backgroundFile.id,
                        id: "pane-background",
                        tabIds: [backgroundFile.id],
                        type: "pane",
                    },
                ],
                id: "split-root",
                sizes: [0.5, 0.5],
                type: "split",
            },
            tabsById: {
                [backgroundFile.id]: {
                    ...backgroundFile,
                    projectId: "project-2",
                },
            },
        };

        useWorkspaceStore.setState((state) => ({
            ...state,
            contextsByKey: {
                ...state.contextsByKey,
                [targetContextKey]: {
                    key: targetContextKey,
                    lastActivatedAt: "2026-04-14T00:00:00.000Z",
                    projectId: "project-2",
                    workspace: targetWorkspace,
                    worktreeId: null,
                },
            },
        }));

        await useWorkspaceStore.getState().activateWorkspaceLayout(targetContextKey);

        expect(openProjectFileMock).not.toHaveBeenCalled();
        expect(useWorkspaceStore.getState().deferredPaneIds).toEqual(
            new Set(["pane-background"]),
        );

        activationFrames.shift()?.(performance.now());
        await vi.waitFor(() => {
            expect(openProjectFileMock).toHaveBeenCalledTimes(1);
        });
        expect(openProjectFileMock).toHaveBeenCalledWith({
            projectId: "project-2",
            relativePath: backgroundFile.relativePath,
            worktreeId: null,
        });
    });

    it("resolves the current pane tab when its deferred frame arrives", async () => {
        const activationFrames = installActivationFrameQueue();
        const focusedFile = createWorkspaceFileTab(
            "focused-file",
            "src/focused.ts",
        );
        const staleFile = createWorkspaceFileTab("stale-file", "src/stale.ts");
        const currentFile = createWorkspaceFileTab(
            "current-file",
            "src/current.ts",
        );
        const targetContextKey = "project-2::__primary__";
        const targetWorkspace: WorkspaceTreeState = {
            activePaneId: "pane-left",
            rootNode: {
                axis: "horizontal",
                children: [
                    {
                        activeTabId: focusedFile.id,
                        id: "pane-left",
                        tabIds: [focusedFile.id],
                        type: "pane",
                    },
                    {
                        activeTabId: staleFile.id,
                        id: "pane-right",
                        tabIds: [staleFile.id, currentFile.id],
                        type: "pane",
                    },
                ],
                id: "split-root",
                sizes: [0.5, 0.5],
                type: "split",
            },
            tabsById: Object.fromEntries(
                [focusedFile, staleFile, currentFile].map((tab) => [
                    tab.id,
                    { ...tab, projectId: "project-2" },
                ]),
            ),
        };

        useWorkspaceStore.setState((state) => ({
            ...state,
            contextsByKey: {
                ...state.contextsByKey,
                [targetContextKey]: {
                    key: targetContextKey,
                    lastActivatedAt: "2026-04-14T00:00:00.000Z",
                    projectId: "project-2",
                    workspace: targetWorkspace,
                    worktreeId: null,
                },
            },
        }));

        await useWorkspaceStore.getState().activateWorkspaceLayout(targetContextKey);
        await useWorkspaceStore
            .getState()
            .selectTab("pane-right", currentFile.id);
        activationFrames.shift()?.(performance.now());

        await vi.waitFor(() => {
            expect(openProjectFileMock).toHaveBeenCalledWith({
                projectId: "project-2",
                relativePath: currentFile.relativePath,
                worktreeId: null,
            });
        });
        expect(openProjectFileMock).not.toHaveBeenCalledWith(
            expect.objectContaining({ relativePath: staleFile.relativePath }),
        );
    });

    it("reveals and prepares a deferred pane immediately when it gains focus", async () => {
        const activationFrames = installActivationFrameQueue();
        const backgroundFile = createWorkspaceFileTab(
            "background-file",
            "src/background.ts",
        );
        const targetContextKey = "project-2::__primary__";
        const targetWorkspace: WorkspaceTreeState = {
            activePaneId: "pane-empty",
            rootNode: {
                axis: "horizontal",
                children: [
                    {
                        activeTabId: null,
                        id: "pane-empty",
                        tabIds: [],
                        type: "pane",
                    },
                    {
                        activeTabId: backgroundFile.id,
                        id: "pane-background",
                        tabIds: [backgroundFile.id],
                        type: "pane",
                    },
                ],
                id: "split-root",
                sizes: [0.5, 0.5],
                type: "split",
            },
            tabsById: {
                [backgroundFile.id]: {
                    ...backgroundFile,
                    projectId: "project-2",
                },
            },
        };

        useWorkspaceStore.setState((state) => ({
            ...state,
            contextsByKey: {
                ...state.contextsByKey,
                [targetContextKey]: {
                    key: targetContextKey,
                    lastActivatedAt: "2026-04-14T00:00:00.000Z",
                    projectId: "project-2",
                    workspace: targetWorkspace,
                    worktreeId: null,
                },
            },
        }));

        await useWorkspaceStore.getState().activateWorkspaceLayout(targetContextKey);
        await useWorkspaceStore.getState().setActivePane("pane-background");

        expect(useWorkspaceStore.getState().deferredPaneIds.size).toBe(0);
        await vi.waitFor(() => {
            expect(openProjectFileMock).toHaveBeenCalledTimes(1);
        });

        activationFrames.shift()?.(performance.now());
        await Promise.resolve();
        expect(openProjectFileMock).toHaveBeenCalledTimes(1);
    });

    it("keeps the active pane outside the deferred queue after any mutation", () => {
        useWorkspaceStore.setState({
            activePaneId: "pane-background",
            deferredPaneIds: new Set(["pane-background", "pane-other"]),
        });

        expect(useWorkspaceStore.getState().deferredPaneIds).toEqual(
            new Set(["pane-other"]),
        );
    });

    it("prepares a deferred fallback after closing the active pane", async () => {
        const activationFrames = installActivationFrameQueue();
        const fallbackFile = createWorkspaceFileTab(
            "fallback-file",
            "src/fallback.ts",
        );
        const targetContextKey = "project-2::__primary__";
        const targetWorkspace: WorkspaceTreeState = {
            activePaneId: "pane-empty",
            rootNode: {
                axis: "horizontal",
                children: [
                    {
                        activeTabId: null,
                        id: "pane-empty",
                        tabIds: [],
                        type: "pane",
                    },
                    {
                        activeTabId: fallbackFile.id,
                        id: "pane-fallback",
                        tabIds: [fallbackFile.id],
                        type: "pane",
                    },
                ],
                id: "split-root",
                sizes: [0.5, 0.5],
                type: "split",
            },
            tabsById: {
                [fallbackFile.id]: {
                    ...fallbackFile,
                    projectId: "project-2",
                },
            },
        };

        useWorkspaceStore.setState((state) => ({
            ...state,
            contextsByKey: {
                ...state.contextsByKey,
                [targetContextKey]: {
                    key: targetContextKey,
                    lastActivatedAt: "2026-04-14T00:00:00.000Z",
                    projectId: "project-2",
                    workspace: targetWorkspace,
                    worktreeId: null,
                },
            },
        }));

        await useWorkspaceStore.getState().activateWorkspaceLayout(targetContextKey);
        await useWorkspaceStore.getState().closePane("pane-empty");

        expect(useWorkspaceStore.getState().activePaneId).toBe("pane-fallback");
        expect(useWorkspaceStore.getState().deferredPaneIds.size).toBe(0);
        await vi.waitFor(() => {
            expect(openProjectFileMock).toHaveBeenCalledTimes(1);
        });
        expect(openProjectFileMock).toHaveBeenCalledWith({
            projectId: "project-2",
            relativePath: fallbackFile.relativePath,
            worktreeId: null,
        });

        activationFrames.shift()?.(performance.now());
        await Promise.resolve();
        expect(openProjectFileMock).toHaveBeenCalledTimes(1);
    });

    it("cancels a deferred pane queue after a rapid context switch", async () => {
        const activationFrames = installActivationFrameQueue();
        const backgroundFile = createWorkspaceFileTab(
            "background-file",
            "src/background.ts",
        );
        const targetContextKey = "project-2::__primary__";
        const targetWorkspace: WorkspaceTreeState = {
            activePaneId: "pane-empty",
            rootNode: {
                axis: "horizontal",
                children: [
                    {
                        activeTabId: null,
                        id: "pane-empty",
                        tabIds: [],
                        type: "pane",
                    },
                    {
                        activeTabId: backgroundFile.id,
                        id: "pane-background",
                        tabIds: [backgroundFile.id],
                        type: "pane",
                    },
                ],
                id: "split-root",
                sizes: [0.5, 0.5],
                type: "split",
            },
            tabsById: {
                [backgroundFile.id]: {
                    ...backgroundFile,
                    projectId: "project-2",
                },
            },
        };

        useWorkspaceStore.setState((state) => ({
            ...state,
            contextsByKey: {
                ...state.contextsByKey,
                [targetContextKey]: {
                    key: targetContextKey,
                    lastActivatedAt: "2026-04-14T00:00:00.000Z",
                    projectId: "project-2",
                    workspace: targetWorkspace,
                    worktreeId: null,
                },
            },
        }));

        await useWorkspaceStore.getState().activateWorkspaceLayout(targetContextKey);
        await useWorkspaceStore
            .getState()
            .activateWorkspaceLayout("project-1::__primary__");
        activationFrames.shift()?.(performance.now());
        await Promise.resolve();

        expect(openProjectFileMock).not.toHaveBeenCalled();
        expect(useWorkspaceStore.getState().activeContextKey).toBe(
            "project-1::__primary__",
        );
        expect(useWorkspaceStore.getState().deferredPaneIds.size).toBe(0);
    });

    it("retries a file load after a rapid context switch", async () => {
        const sourceContextKey = "project-1::__primary__";
        const targetContextKey = "project-2::__primary__";
        const fileTab = createWorkspaceFileTab("file-source", "src/app.ts");
        const sourceWorkspace: WorkspaceTreeState = {
            activePaneId: "pane-root",
            rootNode: {
                activeTabId: fileTab.id,
                id: "pane-root",
                tabIds: [fileTab.id],
                type: "pane",
            },
            tabsById: { [fileTab.id]: fileTab },
        };
        const initialLoad = createDeferred<ProjectFileDocument>();
        openProjectFileMock.mockImplementationOnce(
            () => initialLoad.promise,
        );

        useWorkspaceStore.setState((state) => ({
            ...state,
            ...sourceWorkspace,
            contextsByKey: {
                ...state.contextsByKey,
                [sourceContextKey]: {
                    ...state.contextsByKey[sourceContextKey],
                    workspace: sourceWorkspace,
                },
                [targetContextKey]: {
                    key: targetContextKey,
                    lastActivatedAt: "2026-04-14T00:00:00.000Z",
                    projectId: "project-2",
                    workspace: createDefaultWorkspaceState(),
                    worktreeId: null,
                },
            },
        }));

        await useWorkspaceStore.getState().selectTab("pane-root", fileTab.id);
        await vi.waitFor(() => {
            expect(openProjectFileMock).toHaveBeenCalledTimes(1);
        });

        await useWorkspaceStore.getState().activateWorkspaceLayout(targetContextKey);
        initialLoad.resolve({
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
            relativePath: fileTab.relativePath,
            sizeBytes: 24,
        });

        await vi.waitFor(() => {
            const storedTab =
                useWorkspaceStore.getState().contextsByKey[sourceContextKey]
                    ?.workspace.tabsById[fileTab.id];
            expect(storedTab).toMatchObject({ isLoading: false });
        });

        await useWorkspaceStore.getState().activateWorkspaceLayout(sourceContextKey);
        await vi.waitFor(() => {
            expect(openProjectFileMock).toHaveBeenCalledTimes(2);
        });
    });

    it("reuses the pending load when returning to a context before it resolves", async () => {
        const sourceContextKey = "project-1::__primary__";
        const targetContextKey = "project-2::__primary__";
        const fileTab = createWorkspaceFileTab("file-source", "src/app.ts");
        const sourceWorkspace: WorkspaceTreeState = {
            activePaneId: "pane-root",
            rootNode: {
                activeTabId: fileTab.id,
                id: "pane-root",
                tabIds: [fileTab.id],
                type: "pane",
            },
            tabsById: { [fileTab.id]: fileTab },
        };
        const initialLoad = createDeferred<ProjectFileDocument>();
        openProjectFileMock.mockImplementationOnce(() => initialLoad.promise);

        useWorkspaceStore.setState((state) => ({
            ...state,
            ...sourceWorkspace,
            contextsByKey: {
                ...state.contextsByKey,
                [sourceContextKey]: {
                    ...state.contextsByKey[sourceContextKey],
                    workspace: sourceWorkspace,
                },
                [targetContextKey]: {
                    key: targetContextKey,
                    lastActivatedAt: "2026-04-14T00:00:00.000Z",
                    projectId: "project-2",
                    workspace: createDefaultWorkspaceState(),
                    worktreeId: null,
                },
            },
        }));

        await useWorkspaceStore.getState().selectTab("pane-root", fileTab.id);
        await vi.waitFor(() => {
            expect(openProjectFileMock).toHaveBeenCalledTimes(1);
        });

        await useWorkspaceStore.getState().activateWorkspaceLayout(targetContextKey);
        await useWorkspaceStore.getState().activateWorkspaceLayout(sourceContextKey);
        initialLoad.resolve({
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
            relativePath: fileTab.relativePath,
            sizeBytes: 24,
        });

        await vi.waitFor(() => {
            const currentTab = useWorkspaceStore.getState().tabsById[fileTab.id];
            expect(
                currentTab?.kind === "file"
                    ? currentTab.document?.content
                    : null,
            ).toBe("export const value = 1;\n");
        });
        expect(openProjectFileMock).toHaveBeenCalledTimes(1);
    });

    it("shares a pending file load between active duplicate tabs", async () => {
        const firstFile = createWorkspaceFileTab("file-left", "src/app.ts");
        const secondFile = createWorkspaceFileTab("file-right", "src/app.ts");
        const targetContextKey = "project-2::__primary__";
        const targetWorkspace: WorkspaceTreeState = {
            activePaneId: "pane-left",
            rootNode: {
                axis: "horizontal",
                children: [
                    {
                        activeTabId: firstFile.id,
                        id: "pane-left",
                        tabIds: [firstFile.id],
                        type: "pane",
                    },
                    {
                        activeTabId: secondFile.id,
                        id: "pane-right",
                        tabIds: [secondFile.id],
                        type: "pane",
                    },
                ],
                id: "split-root",
                sizes: [0.5, 0.5],
                type: "split",
            },
            tabsById: {
                [firstFile.id]: { ...firstFile, projectId: "project-2" },
                [secondFile.id]: { ...secondFile, projectId: "project-2" },
            },
        };
        const sharedLoad = createDeferred<ProjectFileDocument>();
        openProjectFileMock.mockImplementationOnce(
            () => sharedLoad.promise,
        );

        useWorkspaceStore.setState((state) => ({
            ...state,
            contextsByKey: {
                ...state.contextsByKey,
                [targetContextKey]: {
                    key: targetContextKey,
                    lastActivatedAt: "2026-04-14T00:00:00.000Z",
                    projectId: "project-2",
                    workspace: targetWorkspace,
                    worktreeId: null,
                },
            },
        }));

        await useWorkspaceStore.getState().activateWorkspaceLayout(targetContextKey);
        await vi.waitFor(() => {
            expect(openProjectFileMock).toHaveBeenCalledTimes(1);
        });

        sharedLoad.resolve({
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
            projectId: "project-2",
            relativePath: firstFile.relativePath,
            sizeBytes: 24,
        });

        await vi.waitFor(() => {
            const tabs = useWorkspaceStore.getState().tabsById;
            const firstTab = tabs[firstFile.id];
            const secondTab = tabs[secondFile.id];
            expect(
                firstTab?.kind === "file"
                    ? firstTab.document?.content
                    : null,
            ).toBe("export const value = 1;\n");
            expect(
                secondTab?.kind === "file"
                    ? secondTab.document?.content
                    : null,
            ).toBe("export const value = 1;\n");
        });
    });

    it("hydrates durable restored chat tabs in history mode", async () => {
        const restoredTab = createWorkspaceChatTab(
            "restored-chat",
            "restored-session",
            "codex",
        );
        const snapshot = {
            activePaneId: "pane-root",
            rootNode: {
                activeTabId: restoredTab.id,
                id: "pane-root",
                tabIds: [restoredTab.id],
                type: "pane" as const,
            },
            tabs: [restoredTab],
        };
        await useWorkspaceStore.getState().hydrateSurfaceLayout({
            generation: "surface-1",
            lastActivatedAt: "2026-08-01T00:00:00.000Z",
            layout: snapshot,
            projectId: "project-1",
            revision: 1,
            scopeKey: "project-1::__primary__",
            worktreeId: null,
        });

        expect(
            useWorkspaceStore.getState().tabsById[restoredTab.id],
        ).toMatchObject({ sessionOpenMode: "history" });
        expect(ensureSessionMock).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: restoredTab.sessionId,
                sessionOpenMode: "history",
            }),
        );
    });

    it("silently prewarms historical chat tabs after they gain focus", async () => {
        const tab = {
            ...createWorkspaceChatTab(
                "chat-history",
                "session-history",
                "codex",
            ),
            sessionOpenMode: "history" as const,
        };
        useWorkspaceStore.setState((state) => ({
            ...state,
            activePaneId: "pane-root",
            rootNode: {
                activeTabId: tab.id,
                id: "pane-root",
                tabIds: [tab.id],
                type: "pane",
            },
            tabsById: { [tab.id]: tab },
        }));

        await useWorkspaceStore.getState().selectTab("pane-root", tab.id);

        expect(ensureSessionMock).toHaveBeenCalledTimes(1);
        expect(ensureSessionMock.mock.calls[0]).toEqual([tab]);
    });

    it("creates OpenCode chat tabs with OpenCode titles", async () => {
        await useWorkspaceStore
            .getState()
            .createChatTab("project-1", null, "opencode");

        const state = useWorkspaceStore.getState();
        const chatTab = Object.values(state.tabsById).find(
            (tab) => tab.kind === "chat" && tab.runtimeId === "opencode",
        );

        expect(chatTab).toMatchObject({
            kind: "chat",
            runtimeId: "opencode",
            title: "OpenCode 1",
        });
        expect(state.lastFocusedRuntimeId).toBe("opencode");
        expect(state.lastQuickCreateAction).toBe("opencode");
    });

    it("creates Grok chat tabs with Grok titles", async () => {
        await useWorkspaceStore
            .getState()
            .createChatTab("project-1", null, "grok");

        const state = useWorkspaceStore.getState();
        const chatTab = Object.values(state.tabsById).find(
            (tab) => tab.kind === "chat" && tab.runtimeId === "grok",
        );

        expect(chatTab).toMatchObject({
            kind: "chat",
            runtimeId: "grok",
            title: "Grok 1",
        });
        expect(state.lastFocusedRuntimeId).toBe("grok");
        expect(state.lastQuickCreateAction).toBe("grok");
    });

    it("creates custom runtime tabs with their configured display name", async () => {
        const runtimeId =
            "custom:550e8400-e29b-41d4-a716-446655440000" as const;
        useSettingsStore.setState({
            runtimeCatalog: buildAiRuntimeCatalog([
                { displayName: "Pi development", id: runtimeId },
            ]),
        });

        await useWorkspaceStore
            .getState()
            .createChatTab("project-1", null, runtimeId);

        const state = useWorkspaceStore.getState();
        const chatTab = Object.values(state.tabsById).find(
            (tab) => tab.kind === "chat" && tab.runtimeId === runtimeId,
        );

        expect(chatTab).toMatchObject({
            kind: "chat",
            runtimeId,
            title: "Pi development 1",
        });
        expect(state.lastFocusedRuntimeId).toBe(runtimeId);
        expect(state.lastQuickCreateAction).toBe(runtimeId);
    });

    it("falls back to Codex when a new chat requests a deleted custom runtime", async () => {
        const deletedRuntimeId =
            "custom:550e8400-e29b-41d4-a716-446655440000" as const;

        await useWorkspaceStore
            .getState()
            .createChatTab("project-1", null, deletedRuntimeId);

        const state = useWorkspaceStore.getState();
        const chatTab = Object.values(state.tabsById).find(
            (tab) => tab.kind === "chat",
        );

        expect(chatTab).toMatchObject({
            kind: "chat",
            runtimeId: "codex",
            title: "Codex 1",
        });
        expect(state.lastFocusedRuntimeId).toBe("codex");
        expect(state.lastQuickCreateAction).toBe("codex");
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
        expect(persistWorkspaceLayoutMock).toHaveBeenCalled();
    });

    it("stores file open locations as runtime-only tab intent", async () => {
        await useWorkspaceStore.getState().openFileTab(
            "project-1",
            "src/app.ts",
            null,
            undefined,
            undefined,
            undefined,
            {
                endLine: 14,
                startLine: 12,
            },
        );

        const state = useWorkspaceStore.getState();
        const openedTab = Object.values(state.tabsById).find(
            (tab) => tab.kind === "file" && tab.relativePath === "src/app.ts",
        );
        expect(openedTab).toMatchObject({
            kind: "file",
            pendingOpenLocation: {
                endLine: 14,
                startLine: 12,
            },
            relativePath: "src/app.ts",
        });

        await flushWorkspacePersistenceForTests();
        const persistedSnapshot =
            persistWorkspaceLayoutMock.mock.calls.at(-1)?.[0];
        if (!persistedSnapshot) {
            throw new Error("Expected workspace snapshot to be persisted.");
        }
        const persistedFileTab = getActivePersistedLayout(
            persistedSnapshot,
        )?.tabs.find(
            (tab) => tab.kind === "file" && tab.relativePath === "src/app.ts",
        );
        expect(persistedFileTab).toBeTruthy();
        expect(persistedFileTab).not.toHaveProperty("pendingOpenLocation");
    });

    it("updates only the pending location when opening an existing file tab at a line", async () => {
        const viewState: MonacoEditor.ICodeEditorViewState = {
            contributionsState: {},
            cursorState: [],
            viewState: {
                firstPosition: {
                    column: 1,
                    lineNumber: 1,
                },
                firstPositionDeltaTop: 0,
                scrollLeft: 0,
            },
        };
        const existingTab = createWorkspaceFileTab("file-tab-1", "src/app.ts");
        useWorkspaceStore.setState((state) => ({
            ...state,
            rootNode: {
                activeTabId: "file-tab-1",
                id: "pane-root",
                tabIds: ["file-tab-1"],
                type: "pane",
            },
            tabsById: {
                "file-tab-1": {
                    ...existingTab,
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
                    pendingOpenLocation: {
                        endLine: 4,
                        startLine: 4,
                    },
                    savedContent: "export const value = 1;\n",
                    viewState,
                },
            },
        }));

        await useWorkspaceStore.getState().openFileTab(
            "project-1",
            "src/app.ts",
            null,
            undefined,
            "pane-root",
            undefined,
            {
                endLine: 22,
                startLine: 20,
            },
        );

        const state = useWorkspaceStore.getState();
        const tab = state.tabsById["file-tab-1"];
        expect(tab).toMatchObject({
            kind: "file",
            pendingOpenLocation: {
                endLine: 22,
                startLine: 20,
            },
            relativePath: "src/app.ts",
        });
        expect(tab?.kind === "file" ? tab.viewState : null).toBe(viewState);
        expect(openProjectFileMock).not.toHaveBeenCalled();
    });

    it("opens Markdown file tabs in edit mode by default", async () => {
        await useWorkspaceStore
            .getState()
            .openFileTab("project-1", "README.md", null);

        const state = useWorkspaceStore.getState();
        const openedTab = Object.values(state.tabsById).find(
            (tab) => tab.kind === "file" && tab.relativePath === "README.md",
        );

        expect(openedTab).toMatchObject({
            kind: "file",
            markdownViewMode: "edit",
            relativePath: "README.md",
        });
    });

    it("updates Markdown preview mode only for the requested file tab", async () => {
        const firstTab = createWorkspaceFileTab("file-tab-1", "README.md");
        const secondTab = createWorkspaceFileTab("file-tab-2", "CHANGELOG.md");

        useWorkspaceStore.setState((state) => ({
            ...state,
            rootNode: {
                activeTabId: "file-tab-1",
                id: "pane-root",
                tabIds: ["file-tab-1", "file-tab-2"],
                type: "pane",
            },
            tabsById: {
                "file-tab-1": {
                    ...firstTab,
                    markdownViewMode: "edit",
                },
                "file-tab-2": {
                    ...secondTab,
                    markdownViewMode: "edit",
                },
            },
        }));

        useWorkspaceStore
            .getState()
            .updateFileMarkdownViewMode("file-tab-1", "preview");

        const state = useWorkspaceStore.getState();
        expect(state.tabsById["file-tab-1"]).toMatchObject({
            kind: "file",
            markdownViewMode: "preview",
            relativePath: "README.md",
        });
        expect(state.tabsById["file-tab-2"]).toMatchObject({
            kind: "file",
            markdownViewMode: "edit",
            relativePath: "CHANGELOG.md",
        });

        await flushWorkspacePersistenceForTests();
        expect(persistWorkspaceLayoutMock).toHaveBeenCalled();
        const snapshot = persistWorkspaceLayoutMock.mock.calls.at(-1)?.[0];
        expect(snapshot ? getActivePersistedLayout(snapshot)?.tabs : null).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    kind: "file",
                    markdownViewMode: "preview",
                    relativePath: "README.md",
                }),
                expect.objectContaining({
                    kind: "file",
                    markdownViewMode: "edit",
                    relativePath: "CHANGELOG.md",
                }),
            ]),
        );
    });

    it("updates Markdown preview scroll only at runtime without persisting", async () => {
        useWorkspaceStore.setState((state) => ({
            ...state,
            rootNode: {
                activeTabId: "file-tab-1",
                id: "pane-root",
                tabIds: ["file-tab-1", "file-tab-2"],
                type: "pane",
            },
            tabsById: {
                "file-tab-1": {
                    ...createWorkspaceFileTab("file-tab-1", "README.md"),
                    markdownPreviewScrollTop: 100,
                    markdownViewMode: "preview",
                },
                "file-tab-2": {
                    ...createWorkspaceFileTab("file-tab-2", "README.md"),
                    markdownPreviewScrollTop: 300,
                    markdownViewMode: "preview",
                },
            },
        }));

        useWorkspaceStore
            .getState()
            .updateFileMarkdownPreviewScrollTop("file-tab-1", 421.6);

        const state = useWorkspaceStore.getState();
        expect(state.tabsById["file-tab-1"]).toMatchObject({
            kind: "file",
            markdownPreviewScrollTop: 422,
        });
        expect(state.tabsById["file-tab-2"]).toMatchObject({
            kind: "file",
            markdownPreviewScrollTop: 300,
        });

        await flushWorkspacePersistenceForTests();
        expect(persistWorkspaceLayoutMock).not.toHaveBeenCalled();
    });

    it("does not keep Markdown preview mode on non-Markdown file tabs", () => {
        useWorkspaceStore.setState((state) => ({
            ...state,
            rootNode: {
                activeTabId: "file-tab-1",
                id: "pane-root",
                tabIds: ["file-tab-1"],
                type: "pane",
            },
            tabsById: {
                "file-tab-1": {
                    ...createWorkspaceFileTab("file-tab-1", "src/app.ts"),
                    markdownViewMode: "preview",
                },
            },
        }));

        useWorkspaceStore
            .getState()
            .updateFileMarkdownViewMode("file-tab-1", "preview");

        const tab = useWorkspaceStore.getState().tabsById["file-tab-1"];
        expect(tab).toMatchObject({
            kind: "file",
            relativePath: "src/app.ts",
        });
        expect(tab).not.toHaveProperty("markdownViewMode");
    });

    it("keeps Markdown preview mode when reselecting an existing tab", async () => {
        useWorkspaceStore.setState((state) => ({
            ...state,
            rootNode: {
                activeTabId: "helper-tab",
                id: "pane-root",
                tabIds: ["file-tab-1", "helper-tab"],
                type: "pane",
            },
            tabsById: {
                "file-tab-1": {
                    ...createWorkspaceFileTab("file-tab-1", "README.md"),
                    markdownViewMode: "preview",
                },
                "helper-tab": createWorkspaceChatTab(
                    "helper-tab",
                    "session-helper",
                    "codex",
                ),
            },
        }));

        await useWorkspaceStore
            .getState()
            .openFileTab("project-1", "README.md", null);

        const state = useWorkspaceStore.getState();
        const tab = state.tabsById["file-tab-1"];
        const pane = state.rootNode.type === "pane" ? state.rootNode : null;

        expect(pane?.activeTabId).toBe("file-tab-1");
        expect(tab).toMatchObject({
            kind: "file",
            markdownViewMode: "preview",
            relativePath: "README.md",
        });
    });

    it("switches an existing Markdown preview tab to edit when opening a line", async () => {
        useWorkspaceStore.setState((state) => ({
            ...state,
            rootNode: {
                activeTabId: "helper-tab",
                id: "pane-root",
                tabIds: ["file-tab-1", "helper-tab"],
                type: "pane",
            },
            tabsById: {
                "file-tab-1": {
                    ...createWorkspaceFileTab("file-tab-1", "README.md"),
                    markdownViewMode: "preview",
                },
                "helper-tab": createWorkspaceChatTab(
                    "helper-tab",
                    "session-helper",
                    "codex",
                ),
            },
        }));

        await useWorkspaceStore
            .getState()
            .openFileTab("project-1", "README.md", null, null, null, undefined, {
                endLine: null,
                startLine: 12,
            });

        const state = useWorkspaceStore.getState();
        const tab = state.tabsById["file-tab-1"];
        const pane = state.rootNode.type === "pane" ? state.rootNode : null;

        expect(pane?.activeTabId).toBe("file-tab-1");
        expect(tab).toMatchObject({
            kind: "file",
            markdownViewMode: "edit",
            pendingOpenLocation: {
                endLine: null,
                startLine: 12,
            },
            relativePath: "README.md",
        });
    });

    it("opens duplicate Markdown tabs in edit mode when targeting a line", async () => {
        useWorkspaceStore.setState((state) => ({
            ...state,
            activePaneId: "pane-right",
            rootNode: {
                axis: "horizontal",
                children: [
                    {
                        activeTabId: "file-tab-1",
                        id: "pane-left",
                        tabIds: ["file-tab-1"],
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
                    ...createWorkspaceFileTab("file-tab-1", "README.md"),
                    markdownViewMode: "preview",
                },
            },
        }));

        await useWorkspaceStore
            .getState()
            .openFileTab(
                "project-1",
                "README.md",
                null,
                null,
                "pane-right",
                undefined,
                {
                    endLine: 8,
                    startLine: 4,
                },
            );

        const state = useWorkspaceStore.getState();
        const rightPane = findWorkspacePane(state.rootNode, "pane-right");
        const duplicateTabId = rightPane?.activeTabId;
        const duplicateTab = duplicateTabId
            ? state.tabsById[duplicateTabId]
            : null;

        expect(duplicateTabId).not.toBe("file-tab-1");
        expect(duplicateTab).toMatchObject({
            kind: "file",
            markdownViewMode: "edit",
            pendingOpenLocation: {
                endLine: 8,
                startLine: 4,
            },
            relativePath: "README.md",
        });
    });

    it("opens a singleton project diff tab per project and worktree", async () => {
        await useWorkspaceStore
            .getState()
            .openGitWorktreeDiffTab("project-1", "worktree-1");
        await useWorkspaceStore
            .getState()
            .openGitWorktreeDiffTab("project-1", "worktree-1");

        const state = useWorkspaceStore.getState();
        const projectDiffTabs = Object.values(state.tabsById).filter(
            (tab) => tab.kind === "git_worktree_diff",
        );

        expect(projectDiffTabs).toHaveLength(1);
        expect(projectDiffTabs[0]).toMatchObject({
            kind: "git_worktree_diff",
            projectId: "project-1",
            title: "Uncommitted Changes",
            worktreeId: "worktree-1",
        });
    });

    it("deduplicates primary project diff tabs across null and stored worktree ids", async () => {
        await useWorkspaceStore
            .getState()
            .openGitWorktreeDiffTab("project-1", null);
        await useWorkspaceStore
            .getState()
            .openGitWorktreeDiffTab("project-1", "project-1:primary");

        const state = useWorkspaceStore.getState();
        const projectDiffTabs = Object.values(state.tabsById).filter(
            (tab) => tab.kind === "git_worktree_diff",
        );

        expect(projectDiffTabs).toHaveLength(1);
    });

    it("opens unique GitHub workspace tabs and reselects existing detail tabs", async () => {
        const ref = {
            host: "github.com",
            owner: "octocat",
            repo: "hello-world",
        };

        await useWorkspaceStore.getState().openGitHubIssuesTab({
            projectId: "project-1",
            ref,
            worktreeId: "worktree-1",
        });
        await useWorkspaceStore.getState().openGitHubIssueTab({
            issueNumber: 123,
            projectId: "project-1",
            ref,
            worktreeId: "worktree-1",
        });
        await useWorkspaceStore.getState().openGitHubPullRequestsTab({
            projectId: "project-1",
            ref,
            worktreeId: "worktree-1",
        });
        await useWorkspaceStore.getState().openGitHubPullRequestTab({
            projectId: "project-1",
            pullRequestNumber: 456,
            ref,
            worktreeId: "worktree-1",
        });
        await useWorkspaceStore.getState().openGitHubPullRequestTab({
            projectId: "project-1",
            pullRequestNumber: 456,
            ref,
            worktreeId: "worktree-1",
        });

        const state = useWorkspaceStore.getState();
        const tabs = Object.values(state.tabsById);
        const pane = state.rootNode.type === "pane" ? state.rootNode : null;

        expect(tabs.map((tab) => tab.kind)).toEqual([
            "github_issues",
            "github_issue",
            "github_pull_requests",
            "github_pull_request",
        ]);
        expect(tabs.map((tab) => tab.title)).toEqual([
            "Issues",
            "#123",
            "Pull Requests",
            "PR #456",
        ]);
        expect(pane?.tabIds).toHaveLength(4);
        expect(pane?.activeTabId).toBe(
            tabs.find((tab) => tab.kind === "github_pull_request")?.id,
        );

        await flushWorkspacePersistenceForTests();
        expect(persistWorkspaceLayoutMock).toHaveBeenCalled();
        const persistedSnapshot =
            persistWorkspaceLayoutMock.mock.calls.at(-1)?.[0];
        if (!persistedSnapshot) {
            throw new Error("Expected workspace snapshot to be persisted.");
        }
        expect(getActivePersistedLayout(persistedSnapshot)?.tabs).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    issueNumber: 123,
                    kind: "github_issue",
                    ref,
                    title: "#123",
                    worktreeId: "worktree-1",
                }),
                expect.objectContaining({
                    kind: "github_pull_request",
                    pullRequestNumber: 456,
                    ref,
                    title: "PR #456",
                    worktreeId: "worktree-1",
                }),
            ]),
        );
    });

    it("opens a GitHub issue tab in the requested workspace pane target", async () => {
        const ref = {
            host: "github.com",
            owner: "octocat",
            repo: "hello-world",
        };

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

        const tabId = await useWorkspaceStore
            .getState()
            .openGitHubIssueTabAtTarget({
                issueNumber: 321,
                projectId: "project-1",
                ref,
                target: {
                    paneId: "pane-right",
                    type: "pane",
                },
                worktreeId: "worktree-1",
            });

        const state = useWorkspaceStore.getState();
        const rightPane = findWorkspacePane(state.rootNode, "pane-right");
        const leftPane = findWorkspacePane(state.rootNode, "pane-left");

        expect(tabId).toBeTruthy();
        expect(state.activePaneId).toBe("pane-right");
        expect(leftPane?.tabIds).toEqual([]);
        expect(rightPane?.tabIds).toEqual([tabId]);
        expect(tabId ? state.tabsById[tabId] : null).toMatchObject({
            issueNumber: 321,
            kind: "github_issue",
            projectId: "project-1",
            ref,
            title: "#321",
            worktreeId: "worktree-1",
        });
    });

    it("moves an existing GitHub pull request tab into a split target", async () => {
        const ref = {
            host: "github.com",
            owner: "octocat",
            repo: "hello-world",
        };

        await useWorkspaceStore.getState().openGitHubPullRequestTab({
            projectId: "project-1",
            pullRequestNumber: 456,
            ref,
            worktreeId: "worktree-1",
        });

        const initialState = useWorkspaceStore.getState();
        const initialPane =
            initialState.rootNode.type === "pane" ? initialState.rootNode : null;
        const existingTabId = initialPane?.tabIds[0] ?? null;
        expect(existingTabId).toBeTruthy();

        const movedTabId = await useWorkspaceStore
            .getState()
            .openGitHubPullRequestTabAtTarget({
                projectId: "project-1",
                pullRequestNumber: 456,
                ref,
                target: {
                    direction: "right",
                    paneId: "pane-root",
                    type: "split",
                },
                worktreeId: "worktree-1",
            });

        const state = useWorkspaceStore.getState();
        const targetPane = findWorkspacePane(state.rootNode, state.activePaneId);
        const sourcePane = findWorkspacePane(state.rootNode, "pane-root");

        expect(movedTabId).toBe(existingTabId);
        expect(state.rootNode.type).toBe("split");
        expect(sourcePane?.tabIds).toEqual([]);
        expect(targetPane?.tabIds).toEqual([existingTabId]);
        expect(targetPane?.activeTabId).toBe(existingTabId);
        expect(Object.values(state.tabsById)).toHaveLength(1);
    });

    it("reorders an existing GitHub issue tab correctly when targeting a later strip index in the same pane", async () => {
        const ref = {
            host: "github.com",
            owner: "octocat",
            repo: "hello-world",
        };

        useWorkspaceStore.setState((state) => ({
            ...state,
            activePaneId: "pane-root",
            rootNode: {
                activeTabId: "issue-tab",
                id: "pane-root",
                tabIds: ["issue-tab", "helper-tab", "other-tab"],
                type: "pane",
            },
            tabsById: {
                "helper-tab": createWorkspaceChatTab(
                    "helper-tab",
                    "session-helper",
                    "codex",
                ),
                "issue-tab": {
                    createdAt: "2026-04-14T00:00:00.000Z",
                    id: "issue-tab",
                    issueNumber: 42,
                    kind: "github_issue",
                    projectId: "project-1",
                    ref,
                    title: "#42",
                    worktreeId: "worktree-1",
                },
                "other-tab": {
                    createdAt: "2026-04-14T00:00:00.000Z",
                    id: "other-tab",
                    issueNumber: 43,
                    kind: "github_issue",
                    projectId: "project-1",
                    ref,
                    title: "#43",
                    worktreeId: "worktree-1",
                },
            },
        }));

        const tabId = await useWorkspaceStore
            .getState()
            .openGitHubIssueTabAtTarget({
                issueNumber: 42,
                projectId: "project-1",
                ref,
                target: {
                    insertIndex: 2,
                    paneId: "pane-root",
                    type: "pane",
                },
                worktreeId: "worktree-1",
            });

        const state = useWorkspaceStore.getState();
        const pane = findWorkspacePane(state.rootNode, "pane-root");

        expect(tabId).toBe("issue-tab");
        expect(pane?.tabIds).toEqual(["helper-tab", "issue-tab", "other-tab"]);
        expect(pane?.activeTabId).toBe("issue-tab");
    });

    it("opens a file in a new split target", async () => {
        const paneId = await useWorkspaceStore.getState().openFileTabAtTarget({
            projectId: "project-1",
            relativePath: "src/split-target.ts",
            target: {
                direction: "right",
                paneId: "pane-root",
                type: "split",
            },
            worktreeId: null,
        });

        const state = useWorkspaceStore.getState();
        expect(paneId).toBeTruthy();
        expect(state.rootNode.type).toBe("split");
        expect(state.activePaneId).toBe(paneId);

        const targetPane = paneId
            ? findWorkspacePane(state.rootNode, paneId)
            : null;
        expect(targetPane?.tabIds).toHaveLength(1);
        expect(targetPane?.activeTabId).toBe(targetPane?.tabIds[0]);

        const openedTabId = targetPane?.tabIds[0] ?? null;
        expect(openedTabId ? state.tabsById[openedTabId] : null).toMatchObject({
            kind: "file",
            relativePath: "src/split-target.ts",
        });
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
                    markdownPreviewScrollTop: 888,
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
                undefined,
                {
                    endLine: 34,
                    startLine: 30,
                },
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
        expect(persistWorkspaceLayoutMock).toHaveBeenCalled();

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
            pendingOpenLocation: {
                endLine: 34,
                startLine: 30,
            },
            projectId: "project-1",
            relativePath: "src/app.ts",
            reviewContext: null,
            savedContent: "export const value = 1;\n",
            worktreeId: "worktree-1",
        });
        expect(
            duplicatedTabId ? state.tabsById[duplicatedTabId] : null,
        ).not.toHaveProperty("markdownPreviewScrollTop");
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

        const persistedSnapshot =
            persistWorkspaceLayoutMock.mock.calls.at(-1)?.[0];
        expect(persistedSnapshot).toBeTruthy();
        expect(
            persistedSnapshot
                ? getActivePersistedLayout(persistedSnapshot)
                : null,
        ).toEqual({
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

        expect(persistWorkspaceLayoutMock).not.toHaveBeenCalled();

        await flushWorkspacePersistenceForTests();

        expect(persistWorkspaceLayoutMock).toHaveBeenCalledTimes(1);
    });

    it("treats a close flush before the first mutation as already durable", async () => {
        resetWorkspacePersistenceForTests();

        await expect(flushWorkspacePersistenceNow()).resolves.toBeUndefined();
        expect(persistWorkspaceLayoutMock).not.toHaveBeenCalled();
    });

    it("does not report a successful close flush when persistence keeps failing", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        persistWorkspaceLayoutMock.mockRejectedValue(
            new Error("persistence unavailable"),
        );
        await useWorkspaceStore.getState().requestWorkspaceNavigation("project-failure");

        await expect(flushWorkspacePersistenceNow()).rejects.toThrow(
            "Could not persist the workspace before closing.",
        );
        expect(persistWorkspaceLayoutMock).toHaveBeenCalledTimes(3);

        persistWorkspaceLayoutMock.mockResolvedValue(undefined);
        errorSpy.mockRestore();
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

        expect(persistWorkspaceLayoutMock).toHaveBeenCalledTimes(1);
        const persistedSnapshot =
            persistWorkspaceLayoutMock.mock.calls.at(-1)?.[0];
        expect(persistedSnapshot).toBeTruthy();
        expect(
            persistedSnapshot
                ? getActivePersistedLayout(persistedSnapshot)
                : null,
        ).toEqual({
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

    it("applies a watcher refresh to a clean file", async () => {
        const relativePath = "src/app.ts";
        const externalDocument = createProjectFileDocument(
            relativePath,
            "export const value = 2;\n",
            2,
        );
        openProjectFileMock.mockResolvedValueOnce(externalDocument);

        useWorkspaceStore.setState((state) => ({
            ...state,
            activePaneId: "pane-root",
            rootNode: {
                activeTabId: "file-1",
                id: "pane-root",
                tabIds: ["file-1"],
                type: "pane",
            },
            tabsById: {
                "file-1": createLoadedWorkspaceFileTab(
                    "file-1",
                    relativePath,
                    "export const value = 1;\n",
                ),
            },
        }));

        await useWorkspaceStore
            .getState()
            .refreshProjectTabs("project-1", null, [relativePath]);

        expect(openProjectFileMock).toHaveBeenCalledWith({
            projectId: "project-1",
            relativePath,
            worktreeId: null,
        });
        expect(useWorkspaceStore.getState().tabsById["file-1"]).toMatchObject({
            contentRevision: 1,
            document: { content: externalDocument.content, modifiedAtMs: 2 },
            draftContent: externalDocument.content,
            isDirty: false,
            savedContent: externalDocument.content,
        });
    });

    it("keeps duplicate tabs synchronized after a clean watcher refresh", async () => {
        const relativePath = "src/app.ts";
        const externalDocument = createProjectFileDocument(
            relativePath,
            "export const value = 2;\n",
            2,
        );
        openProjectFileMock.mockResolvedValueOnce(externalDocument);

        useWorkspaceStore.setState((state) => ({
            ...state,
            activePaneId: "pane-root",
            rootNode: {
                activeTabId: "file-left",
                id: "pane-root",
                tabIds: ["file-left", "file-right"],
                type: "pane",
            },
            tabsById: {
                "file-left": createLoadedWorkspaceFileTab(
                    "file-left",
                    relativePath,
                    "export const value = 1;\n",
                ),
                "file-right": {
                    ...createLoadedWorkspaceFileTab(
                        "file-right",
                        relativePath,
                        "export const value = 1;\n",
                    ),
                    viewState: {
                        contributionsState: [],
                        cursorState: [],
                        viewState: { scrollTop: 360 },
                    } as unknown as MonacoEditor.ICodeEditorViewState,
                },
            },
        }));

        await useWorkspaceStore
            .getState()
            .refreshProjectTabs("project-1", null, [relativePath]);

        expect(openProjectFileMock).toHaveBeenCalledTimes(1);
        for (const tabId of ["file-left", "file-right"]) {
            expect(useWorkspaceStore.getState().tabsById[tabId]).toMatchObject({
                contentRevision: 1,
                document: { content: externalDocument.content, modifiedAtMs: 2 },
                draftContent: externalDocument.content,
                isDirty: false,
                savedContent: externalDocument.content,
            });
        }
        expect(useWorkspaceStore.getState().tabsById["file-right"]?.kind).toBe(
            "file",
        );
        const rightTab = useWorkspaceStore.getState().tabsById["file-right"];
        expect(rightTab?.kind === "file" ? rightTab.viewState : null).toEqual({
            contributionsState: [],
            cursorState: [],
            viewState: { scrollTop: 360 },
        });
    });

    it("keeps the draft and view state when a stale watcher refresh resolves", async () => {
        const relativePath = "src/app.ts";
        const staleExternalLoad = createDeferred<ProjectFileDocument>();
        const preservedViewState = {
            contributionsState: [],
            cursorState: [
                {
                    inSelectionMode: false,
                    position: { column: 7, lineNumber: 3 },
                    selectionStart: { column: 7, lineNumber: 3 },
                },
            ],
            viewState: { scrollLeft: 18, scrollTop: 640 },
        } as unknown as MonacoEditor.ICodeEditorViewState;
        openProjectFileMock.mockImplementationOnce(
            () => staleExternalLoad.promise,
        );

        useWorkspaceStore.setState((state) => ({
            ...state,
            activePaneId: "pane-root",
            rootNode: {
                activeTabId: "file-1",
                id: "pane-root",
                tabIds: ["file-1"],
                type: "pane",
            },
            tabsById: {
                "file-1": {
                    ...createLoadedWorkspaceFileTab(
                        "file-1",
                        relativePath,
                        "export const value = 1;\n",
                    ),
                    viewState: preservedViewState,
                },
            },
        }));

        const refreshPromise = useWorkspaceStore
            .getState()
            .refreshProjectTabs("project-1", null, [relativePath]);
        await vi.waitFor(() => {
            expect(openProjectFileMock).toHaveBeenCalledTimes(1);
        });

        useWorkspaceStore
            .getState()
            .updateFileDraft("file-1", "export const value = 3;\n");
        staleExternalLoad.resolve(
            createProjectFileDocument(
                relativePath,
                "export const value = 2;\n",
                2,
            ),
        );
        await refreshPromise;

        expect(useWorkspaceStore.getState().tabsById["file-1"]).toMatchObject({
            contentRevision: 1,
            draftContent: "export const value = 3;\n",
            isDirty: true,
            savedContent: "export const value = 1;\n",
            viewState: preservedViewState,
        });
    });

    it("uses the newest watcher read after consecutive invalidations", async () => {
        const relativePath = "src/app.ts";
        const firstExternalLoad = createDeferred<ProjectFileDocument>();
        const secondExternalLoad = createDeferred<ProjectFileDocument>();
        openProjectFileMock
            .mockImplementationOnce(() => firstExternalLoad.promise)
            .mockImplementationOnce(() => secondExternalLoad.promise);

        useWorkspaceStore.setState((state) => ({
            ...state,
            activePaneId: "pane-root",
            rootNode: {
                activeTabId: "file-1",
                id: "pane-root",
                tabIds: ["file-1"],
                type: "pane",
            },
            tabsById: {
                "file-1": createLoadedWorkspaceFileTab(
                    "file-1",
                    relativePath,
                    "export const value = 1;\n",
                ),
            },
        }));

        const firstRefresh = useWorkspaceStore
            .getState()
            .refreshProjectTabs("project-1", null, [relativePath]);
        await vi.waitFor(() => {
            expect(openProjectFileMock).toHaveBeenCalledTimes(1);
        });

        const secondRefresh = useWorkspaceStore
            .getState()
            .refreshProjectTabs("project-1", null, [relativePath]);
        await vi.waitFor(() => {
            expect(openProjectFileMock).toHaveBeenCalledTimes(2);
        });

        firstExternalLoad.resolve(
            createProjectFileDocument(
                relativePath,
                "export const value = 2;\n",
                2,
            ),
        );
        await firstRefresh;
        expect(useWorkspaceStore.getState().tabsById["file-1"]).toMatchObject({
            draftContent: "export const value = 1;\n",
            isLoading: true,
        });

        secondExternalLoad.resolve(
            createProjectFileDocument(
                relativePath,
                "export const value = 3;\n",
                3,
            ),
        );
        await secondRefresh;

        expect(useWorkspaceStore.getState().tabsById["file-1"]).toMatchObject({
            contentRevision: 1,
            document: { content: "export const value = 3;\n", modifiedAtMs: 3 },
            draftContent: "export const value = 3;\n",
            isDirty: false,
            isLoading: false,
        });
    });

    it("discards an older manual reload after a newer watcher read", async () => {
        const relativePath = "src/app.ts";
        const manualLoad = createDeferred<ProjectFileDocument>();
        const watcherLoad = createDeferred<ProjectFileDocument>();
        openProjectFileMock
            .mockImplementationOnce(() => manualLoad.promise)
            .mockImplementationOnce(() => watcherLoad.promise);

        useWorkspaceStore.setState((state) => ({
            ...state,
            activePaneId: "pane-root",
            rootNode: {
                activeTabId: "file-1",
                id: "pane-root",
                tabIds: ["file-1"],
                type: "pane",
            },
            tabsById: {
                "file-1": createLoadedWorkspaceFileTab(
                    "file-1",
                    relativePath,
                    "export const value = 1;\n",
                ),
            },
        }));

        const manualReload = useWorkspaceStore
            .getState()
            .reloadFileTab("file-1");
        await vi.waitFor(() => {
            expect(openProjectFileMock).toHaveBeenCalledTimes(1);
        });

        const watcherRefresh = useWorkspaceStore
            .getState()
            .refreshProjectTabs("project-1", null, [relativePath]);
        await vi.waitFor(() => {
            expect(openProjectFileMock).toHaveBeenCalledTimes(2);
        });

        watcherLoad.resolve(
            createProjectFileDocument(
                relativePath,
                "export const value = 3;\n",
                3,
            ),
        );
        await watcherRefresh;

        manualLoad.resolve(
            createProjectFileDocument(
                relativePath,
                "export const value = 2;\n",
                2,
            ),
        );
        await manualReload;

        expect(useWorkspaceStore.getState().tabsById["file-1"]).toMatchObject({
            contentRevision: 1,
            document: { content: "export const value = 3;\n", modifiedAtMs: 3 },
            draftContent: "export const value = 3;\n",
            isDirty: false,
            isLoading: false,
            savedContent: "export const value = 3;\n",
        });
    });

    it("allows a manual reload to replace a dirty draft", async () => {
        const relativePath = "src/app.ts";
        const externalDocument = createProjectFileDocument(
            relativePath,
            "export const value = 2;\n",
            2,
        );
        openProjectFileMock.mockResolvedValueOnce(externalDocument);

        useWorkspaceStore.setState((state) => ({
            ...state,
            activePaneId: "pane-root",
            rootNode: {
                activeTabId: "file-1",
                id: "pane-root",
                tabIds: ["file-1"],
                type: "pane",
            },
            tabsById: {
                "file-1": {
                    ...createLoadedWorkspaceFileTab(
                        "file-1",
                        relativePath,
                        "export const value = 1;\n",
                    ),
                    draftContent: "export const value = 3;\n",
                    isDirty: true,
                },
            },
        }));

        await useWorkspaceStore.getState().reloadFileTab("file-1");

        expect(useWorkspaceStore.getState().tabsById["file-1"]).toMatchObject({
            contentRevision: 1,
            document: { content: externalDocument.content, modifiedAtMs: 2 },
            draftContent: externalDocument.content,
            isDirty: false,
            savedContent: externalDocument.content,
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

    it("invalidates clean files in inactive contexts and reloads them on activation", async () => {
        const activeWorkspace = createDefaultWorkspaceState();
        const inactiveTab = {
            ...createWorkspaceFileTab("file-inactive", "src/inactive.ts"),
            document: {
                absolutePath: "/tmp/src/inactive.ts",
                content: "export const stale = true;\n",
                imageDataBase64: null,
                isBinary: false,
                isTooLarge: false,
                kind: "text" as const,
                languageId: "typescript",
                languageLabel: "TypeScript",
                mimeType: "text/typescript",
                modifiedAtMs: 1,
                name: "inactive.ts",
                projectId: "project-2",
                relativePath: "src/inactive.ts",
                sizeBytes: 27,
            },
            draftContent: "export const stale = true;\n",
            projectId: "project-2",
            savedContent: "export const stale = true;\n",
        };
        const inactiveWorkspace: WorkspaceTreeState = {
            activePaneId: "pane-inactive",
            rootNode: {
                activeTabId: inactiveTab.id,
                id: "pane-inactive",
                tabIds: [inactiveTab.id],
                type: "pane",
            },
            tabsById: { [inactiveTab.id]: inactiveTab },
        };

        useWorkspaceStore.setState((state) => ({
            ...state,
            ...activeWorkspace,
            activeContextKey: "project-1::__primary__",
            contextsByKey: {
                "project-1::__primary__": {
                    key: "project-1::__primary__",
                    lastActivatedAt: "2026-04-14T00:00:00.000Z",
                    projectId: "project-1",
                    workspace: activeWorkspace,
                    worktreeId: null,
                },
                "project-2::__primary__": {
                    key: "project-2::__primary__",
                    lastActivatedAt: "2026-04-14T00:00:00.000Z",
                    projectId: "project-2",
                    workspace: inactiveWorkspace,
                    worktreeId: null,
                },
            },
        }));

        await useWorkspaceStore
            .getState()
            .refreshProjectTabs("project-2", null, ["src/inactive.ts"]);

        expect(openProjectFileMock).not.toHaveBeenCalled();
        expect(
            useWorkspaceStore.getState().contextsByKey[
                "project-2::__primary__"
            ]?.workspace.tabsById[inactiveTab.id],
        ).toMatchObject({ document: null, isDirty: false });

        await useWorkspaceStore
            .getState()
            .activateWorkspaceLayout("project-2::__primary__");
        await vi.waitFor(() => {
            expect(openProjectFileMock).toHaveBeenCalledWith({
                projectId: "project-2",
                relativePath: "src/inactive.ts",
                worktreeId: null,
            });
            expect(
                useWorkspaceStore.getState().tabsById[inactiveTab.id],
            ).toMatchObject({
                document: { content: "export const value = 1;\n" },
                isLoading: false,
            });
        });
    });

    it("preserves edits made while a file save is in flight", async () => {
        const originalDocument: ProjectFileDocument = {
            absolutePath: "/tmp/notes.md",
            content: "Hello\n",
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
            relativePath: "notes.md",
            sizeBytes: 6,
        };
        let resolveSave!: (document: ProjectFileDocument) => void;
        saveProjectFileMock.mockImplementationOnce(
            () =>
                new Promise<ProjectFileDocument>((resolve) => {
                    resolveSave = resolve;
                }),
        );
        useWorkspaceStore.setState((state) => ({
            ...state,
            activePaneId: "pane-root",
            rootNode: {
                activeTabId: "file-1",
                id: "pane-root",
                tabIds: ["file-1"],
                type: "pane",
            },
            tabsById: {
                "file-1": {
                    ...createWorkspaceFileTab("file-1", "notes.md"),
                    document: originalDocument,
                    draftContent: "Hello world\n",
                    isDirty: true,
                    savedContent: "Hello\n",
                    title: "notes.md",
                },
            },
        }));

        const savePromise = useWorkspaceStore
            .getState()
            .saveFileTab("file-1");

        expect(saveProjectFileMock).toHaveBeenCalledWith({
            content: "Hello world\n",
            expectedModifiedAtMs: 1,
            projectId: "project-1",
            relativePath: "notes.md",
            worktreeId: null,
        });
        expect(useWorkspaceStore.getState().tabsById["file-1"]).toMatchObject({
            isSaving: true,
        });

        useWorkspaceStore.getState().updateFileDraft("file-1", "Hello\n");
        resolveSave({
            ...originalDocument,
            content: "Hello world\n",
            modifiedAtMs: 2,
            sizeBytes: "Hello world\n".length,
        });
        await savePromise;

        expect(useWorkspaceStore.getState().tabsById["file-1"]).toMatchObject({
            document: expect.objectContaining({
                content: "Hello world\n",
                modifiedAtMs: 2,
            }) as ProjectFileDocument,
            draftContent: "Hello\n",
            isDirty: true,
            isSaving: false,
            savedContent: "Hello world\n",
        });
        expect(notifyFileBufferMock).toHaveBeenLastCalledWith({
            absolutePath: "/tmp/notes.md",
            content: "Hello\n",
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
        expect(persistWorkspaceLayoutMock).toHaveBeenCalled();
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
            sessionOpenMode: "history",
            sessionId: "session-persisted",
            title: "Recovered session",
            worktreeId: "worktree-1",
        });
        expect(ensureSessionMock).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionOpenMode: "history",
                sessionId: "session-persisted",
            }),
        );
        await flushWorkspacePersistenceForTests();
        expect(persistWorkspaceLayoutMock).toHaveBeenCalled();
    });

    it("focuses the requested child chat tab without selecting the parent", async () => {
        useWorkspaceStore.setState((state) => ({
            ...state,
            activePaneId: "pane-left",
            rootNode: {
                axis: "horizontal",
                children: [
                    {
                        activeTabId: "chat-parent",
                        id: "pane-left",
                        tabIds: ["chat-parent"],
                        type: "pane",
                    },
                    {
                        activeTabId: null,
                        id: "pane-right",
                        tabIds: ["chat-child"],
                        type: "pane",
                    },
                ],
                id: "split-root",
                sizes: [0.5, 0.5],
                type: "split",
            },
            tabsById: {
                "chat-child": createWorkspaceChatTab(
                    "chat-child",
                    "child-session",
                    "codex",
                ),
                "chat-parent": createWorkspaceChatTab(
                    "chat-parent",
                    "parent-session",
                    "codex",
                ),
            },
        }));

        await useWorkspaceStore.getState().openChatSessionTab({
            projectId: "project-1",
            runtimeId: "codex",
            sessionId: "child-session",
            title: "Galileo",
            worktreeId: "worktree-9",
        });

        const state = useWorkspaceStore.getState();
        const leftPane =
            state.rootNode.type === "split" ? state.rootNode.children[0] : null;
        const rightPane =
            state.rootNode.type === "split" ? state.rootNode.children[1] : null;

        if (leftPane?.type !== "pane" || rightPane?.type !== "pane") {
            throw new Error("Expected a split workspace with pane children.");
        }

        expect(Object.keys(state.tabsById).sort()).toEqual([
            "chat-child",
            "chat-parent",
        ]);
        expect(state.activePaneId).toBe("pane-right");
        expect(leftPane.activeTabId).toBe("chat-parent");
        expect(rightPane.activeTabId).toBe("chat-child");
        expect(state.tabsById["chat-child"]).toMatchObject({
            kind: "chat",
            sessionId: "child-session",
            title: "Galileo",
            worktreeId: "worktree-9",
        });
    });

    it("marks an existing chat tab as history when opened from session history", async () => {
        useWorkspaceStore.setState((state) => ({
            ...state,
            activePaneId: "pane-root",
            rootNode: {
                activeTabId: "chat-existing",
                id: "pane-root",
                tabIds: ["chat-existing"],
                type: "pane",
            },
            tabsById: {
                "chat-existing": createWorkspaceChatTab(
                    "chat-existing",
                    "session-history",
                    "opencode",
                ),
            },
        }));

        await useWorkspaceStore.getState().openChatSessionTab({
            projectId: "project-1",
            runtimeId: "opencode",
            sessionOpenMode: "history",
            sessionId: "session-history",
            title: "Recovered OpenCode session",
            worktreeId: null,
        });

        expect(
            useWorkspaceStore.getState().tabsById["chat-existing"],
        ).toMatchObject({
            kind: "chat",
            sessionOpenMode: "history",
            sessionId: "session-history",
        });
        expect(ensureSessionMock).toHaveBeenCalledWith(
            expect.objectContaining({
                id: "chat-existing",
                sessionOpenMode: "history",
                sessionId: "session-history",
            }),
        );
    });

    it("moves an existing chat tab to a split target without duplicating it", async () => {
        useWorkspaceStore.setState((state) => ({
            ...state,
            activePaneId: "pane-a",
            rootNode: {
                activeTabId: "chat-alpha",
                id: "pane-a",
                tabIds: ["chat-alpha"],
                type: "pane",
            },
            tabsById: {
                "chat-alpha": createWorkspaceChatTab(
                    "chat-alpha",
                    "session-alpha",
                    "codex",
                ),
            },
        }));

        await useWorkspaceStore.getState().openChatSessionTabAtTarget({
            projectId: "project-1",
            runtimeId: "codex",
            sessionId: "session-alpha",
            target: {
                direction: "right",
                paneId: "pane-a",
                type: "split",
            },
            title: "Alpha moved",
            worktreeId: null,
        });

        const state = useWorkspaceStore.getState();
        const chatTabs = Object.values(state.tabsById).filter(
            (tab) => tab.kind === "chat" && tab.sessionId === "session-alpha",
        );
        expect(chatTabs).toHaveLength(1);
        expect(state.rootNode.type).toBe("split");
        expect(state.activePaneId).not.toBe("pane-a");

        const targetPane = findWorkspacePane(state.rootNode, state.activePaneId);
        expect(targetPane?.tabIds).toEqual(["chat-alpha"]);
        expect(targetPane?.activeTabId).toBe("chat-alpha");
        expect(state.tabsById["chat-alpha"]).toMatchObject({
            title: "Alpha moved",
        });
    });

    it("creates a chat tab and hydrates it when opening a persisted session that is not open yet", async () => {
        await useWorkspaceStore.getState().openChatSessionTab({
            projectId: "project-1",
            runtimeId: "grok",
            sessionId: "session-new-history",
            title: "Recovered Grok session",
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
            runtimeId: "grok",
            sessionOpenMode: "history",
            sessionId: "session-new-history",
            title: "Recovered Grok session",
            worktreeId: "worktree-9",
        });
        expect(ensureSessionMock).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionOpenMode: "history",
                sessionId: "session-new-history",
            }),
        );
        await flushWorkspacePersistenceForTests();
        expect(persistWorkspaceLayoutMock).toHaveBeenCalled();
    });
});

describe("workspace terminal tabs", () => {
    beforeEach(() => {
        resetWorkspacePersistenceForTests();
        persistWorkspaceLayoutMock.mockClear();
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    closeAiSession: closeAiSessionMock,
                    closeTerminalSession: closeTerminalSessionMock,
                    notifyFileBuffer: notifyFileBufferMock,
                    openProjectFile: openProjectFileMock,
                    saveProjectFile: saveProjectFileMock,
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
    });

    it("keeps Terminal and Claude Code title numbering independent", async () => {
        await useWorkspaceStore.getState().createTerminalTab("project-1", null, {
            title: "Claude Code 1",
        });

        const terminalTabId = await useWorkspaceStore
            .getState()
            .createTerminalTab("project-1");

        expect(terminalTabId).toEqual(expect.any(String));
        expect(useWorkspaceStore.getState().tabsById[terminalTabId!])
            .toMatchObject({
                kind: "terminal",
                title: "Terminal 1",
            });
    });

    it("can create an optioned terminal tab in a requested pane", async () => {
        useWorkspaceStore.setState((state) => ({
            ...state,
            activePaneId: "pane-a",
            rootNode: {
                axis: "horizontal",
                children: [
                    {
                        activeTabId: null,
                        id: "pane-a",
                        tabIds: [],
                        type: "pane",
                    },
                    {
                        activeTabId: null,
                        id: "pane-b",
                        tabIds: [],
                        type: "pane",
                    },
                ],
                id: "split-root",
                sizes: [50, 50],
                type: "split",
            },
        }));

        const terminalTabId = await useWorkspaceStore
            .getState()
            .createTerminalTab("project-1", null, {
                paneId: "pane-b",
                title: "Claude Code 1",
            });
        const paneB = findWorkspacePane(
            useWorkspaceStore.getState().rootNode,
            "pane-b",
        );

        expect(paneB?.activeTabId).toBe(terminalTabId);
        expect(paneB?.tabIds).toEqual([terminalTabId]);
        expect(useWorkspaceStore.getState().tabsById[terminalTabId!])
            .toMatchObject({
                kind: "terminal",
                title: "Claude Code 1",
            });
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
                runtimeId: "grok",
                sessionId: "session-2",
                title: "Review",
                worktreeId: null,
            }),
        ).toBe("grok");

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
                runtimeId: "grok",
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

    it("matches a primary workspace chat when the active scope is canonical", () => {
        const state: WorkspaceTreeState = {
            activePaneId: "pane-root",
            rootNode: {
                activeTabId: "chat-primary",
                id: "pane-root",
                tabIds: ["chat-primary"],
                type: "pane",
            },
            tabsById: {
                "chat-primary": createWorkspaceChatTab(
                    "chat-primary",
                    "session-primary",
                    "codex",
                ),
            },
        };

        expect(
            getBestMatchingChatTabId(state, {
                currentPaneId: "pane-root",
                lastFocusedChatTabId: "chat-primary",
                projectId: "project-1",
                recentFocusedChatTabIds: [],
                worktreeId: "project-1:primary",
            }),
        ).toBe("chat-primary");
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

    it("does not make a restored chat the implicit line attachment target until it receives focus", async () => {
        useWorkspaceStore.setState((state) => ({
            ...state,
            activePaneId: "pane-file",
            lastFocusedChatTabId: "chat-closed",
            lastFocusedRuntimeId: "claude",
            recentActiveTabIds: ["chat-closed", "chat-target", "file-1"],
            recentFocusedChatTabIds: ["chat-closed", "chat-target"],
            rootNode: {
                axis: "horizontal",
                children: [
                    {
                        activeTabId: "file-1",
                        id: "pane-file",
                        tabIds: ["file-1"],
                        type: "pane",
                    },
                    {
                        activeTabId: "chat-closed",
                        id: "pane-chat",
                        tabIds: ["chat-target", "chat-closed"],
                        type: "pane",
                    },
                ],
                id: "split-root",
                sizes: [0.5, 0.5],
                type: "split",
            },
            tabsById: {
                "chat-closed": createWorkspaceChatTab(
                    "chat-closed",
                    "session-closed",
                    "claude",
                ),
                "chat-target": createWorkspaceChatTab(
                    "chat-target",
                    "session-target",
                    "codex",
                ),
                "file-1": createWorkspaceFileTab("file-1", "src/app.ts"),
            },
        }));

        await useWorkspaceStore.getState().closeTab("chat-closed");
        await useWorkspaceStore.getState().reopenLastClosedTab();

        const restoredState = useWorkspaceStore.getState();
        const chatPane = findWorkspacePane(restoredState.rootNode, "pane-chat");

        expect(chatPane?.activeTabId).toBe("chat-closed");
        expect(restoredState.lastFocusedChatTabId).toBe("chat-target");
        expect(
            getBestMatchingChatTabId(restoredState, {
                currentPaneId: "pane-file",
                lastFocusedChatTabId: restoredState.lastFocusedChatTabId,
                projectId: "project-1",
                recentFocusedChatTabIds:
                    restoredState.recentFocusedChatTabIds,
                worktreeId: null,
            }),
        ).toBe("chat-target");

        useWorkspaceStore.getState().markChatTabFocused("chat-closed");

        const focusedState = useWorkspaceStore.getState();
        expect(
            getBestMatchingChatTabId(focusedState, {
                currentPaneId: "pane-file",
                lastFocusedChatTabId: focusedState.lastFocusedChatTabId,
                projectId: "project-1",
                recentFocusedChatTabIds: focusedState.recentFocusedChatTabIds,
                worktreeId: null,
            }),
        ).toBe("chat-closed");
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

    it("reopens a closed chat tab without closing its live session", async () => {
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

        expect(closeAiSessionMock).not.toHaveBeenCalled();
        expect(useWorkspaceStore.getState().tabsById["chat-1"]).toMatchObject({
            id: "chat-1",
            sessionId: "session-1",
            title: "Codex 1",
        });
    });

    it("opens child review tabs with the child session and inherited worktree", async () => {
        await useWorkspaceStore.getState().openReviewTab({
            projectId: "project-1",
            runtimeId: "codex",
            sessionId: "parent-session",
            title: "Parent",
            worktreeId: "worktree-9",
        });
        await useWorkspaceStore.getState().openReviewTab({
            projectId: "project-1",
            runtimeId: "codex",
            sessionId: "child-session",
            title: "Galileo",
            worktreeId: "worktree-9",
        });

        const reviewTabs = Object.values(
            useWorkspaceStore.getState().tabsById,
        ).filter((tab) => tab.kind === "review");
        const childReviewTab = reviewTabs.find(
            (tab) => tab.sessionId === "child-session",
        );

        expect(reviewTabs).toHaveLength(2);
        expect(childReviewTab).toEqual(
            expect.objectContaining({
                kind: "review",
                projectId: "project-1",
                runtimeId: "codex",
                sessionId: "child-session",
                title: "Review · Galileo",
                worktreeId: "worktree-9",
            }),
        );
    });

    it("closes the live terminal session when a terminal tab is closed", async () => {
        resetWorkspacePersistenceForTests();
        closeTerminalSessionMock.mockClear();
        persistWorkspaceLayoutMock.mockClear();

        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    closeTerminalSession: closeTerminalSessionMock,
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
                    terminalId: "terminal-session-1",
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
