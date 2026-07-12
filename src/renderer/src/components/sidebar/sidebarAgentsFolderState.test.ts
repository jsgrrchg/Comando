import { beforeEach, describe, expect, it } from "vitest";

import {
    SIDEBAR_AGENT_FOLDER_NAME_MAX_LENGTH,
    SIDEBAR_AGENTS_FOLDER_STATE_VERSION,
    createEmptySidebarAgentsFolderState,
    createSidebarAgentsFolder,
    deleteSidebarAgentsFolder,
    getSidebarAgentsFolderStorageKey,
    moveSidebarAgentSessionToFolder,
    normalizeSidebarAgentFolderName,
    persistSidebarAgentsFolderState,
    readSidebarAgentsFolderState,
    removeSidebarAgentSessionFolderAssignment,
    renameSidebarAgentsFolder,
    reorderSidebarAgentsFolder,
    toggleSidebarAgentsFolderCollapsed,
    type SidebarAgentsFolderState,
} from "./sidebarAgentsFolderState";

class MemoryStorage implements Storage {
    private readonly values = new Map<string, string>();

    get length() {
        return this.values.size;
    }

    clear() {
        this.values.clear();
    }

    getItem(key: string) {
        return this.values.get(key) ?? null;
    }

    key(index: number) {
        return [...this.values.keys()][index] ?? null;
    }

    removeItem(key: string) {
        this.values.delete(key);
    }

    setItem(key: string, value: string) {
        this.values.set(key, value);
    }
}

function createState(): SidebarAgentsFolderState {
    return {
        collapsedFolderIds: [],
        folderOrder: ["research", "archive"],
        folders: {
            archive: {
                createdAt: 2,
                id: "archive",
                name: "Archive",
            },
            research: {
                createdAt: 1,
                id: "research",
                name: "Research",
            },
        },
        sessionFolderIds: {},
    };
}

describe("sidebarAgentsFolderState", () => {
    beforeEach(() => {
        Object.defineProperty(globalThis, "localStorage", {
            configurable: true,
            value: new MemoryStorage(),
            writable: true,
        });
    });

    it("normalizes names and creates folders without accepting empty or duplicate ids", () => {
        const emptyState = createEmptySidebarAgentsFolderState();
        const emptyResult = createSidebarAgentsFolder(emptyState, " \t ", {
            folderId: "empty",
        });
        expect(emptyResult).toEqual({ folderId: null, state: emptyState });

        const longName = `  Research   ${"x".repeat(100)}  `;
        const created = createSidebarAgentsFolder(emptyState, longName, {
            createdAt: 10,
            folderId: "research",
        });

        expect(created.folderId).toBe("research");
        expect(created.state.folderOrder).toEqual(["research"]);
        expect(created.state.folders.research).toEqual({
            createdAt: 10,
            id: "research",
            name: normalizeSidebarAgentFolderName(longName),
        });
        expect(created.state.folders.research?.name).toHaveLength(
            SIDEBAR_AGENT_FOLDER_NAME_MAX_LENGTH,
        );

        const duplicate = createSidebarAgentsFolder(
            created.state,
            "Duplicate",
            { folderId: "research" },
        );
        expect(duplicate).toEqual({ folderId: null, state: created.state });
    });

    it("persists versioned state and keeps project and worktree scopes isolated", () => {
        const state = moveSidebarAgentSessionToFolder(
            createState(),
            "session-a",
            "research",
        );
        persistSidebarAgentsFolderState("project-1", "worktree-a", state);

        const key = getSidebarAgentsFolderStorageKey(
            "project-1",
            "worktree-a",
        );
        const persisted: unknown = JSON.parse(
            globalThis.localStorage.getItem(key) ?? "{}",
        );
        expect(persisted).toMatchObject({
            version: SIDEBAR_AGENTS_FOLDER_STATE_VERSION,
            folders: state.folders,
            folderOrder: ["research", "archive"],
            sessionFolderIds: { "session-a": "research" },
            collapsedFolderIds: [],
        });
        expect(
            (persisted as { readonly updatedAt?: unknown }).updatedAt,
        ).toEqual(expect.any(Number));

        expect(
            readSidebarAgentsFolderState("project-1", "worktree-a"),
        ).toEqual(state);
        expect(
            readSidebarAgentsFolderState("project-1", "worktree-b"),
        ).toEqual(createEmptySidebarAgentsFolderState());
        expect(
            readSidebarAgentsFolderState("project-2", "worktree-a"),
        ).toEqual(createEmptySidebarAgentsFolderState());
    });

    it("hydrates only valid folder metadata while preserving unseen session assignments", () => {
        const key = getSidebarAgentsFolderStorageKey("project-1", null);
        globalThis.localStorage.setItem(
            key,
            JSON.stringify({
                version: SIDEBAR_AGENTS_FOLDER_STATE_VERSION,
                updatedAt: 100,
                folders: {
                    " research ": {
                        createdAt: 4,
                        id: "ignored",
                        name: "  Research   plans  ",
                    },
                    archive: {
                        createdAt: "invalid",
                        id: "archive",
                        name: "Archive",
                    },
                    empty: {
                        createdAt: 5,
                        id: "empty",
                        name: "   ",
                    },
                    invalid: "not-a-folder",
                },
                folderOrder: [
                    "archive",
                    "archive",
                    "missing",
                    12,
                ],
                sessionFolderIds: {
                    " history-only-session ": " research ",
                    "session-b": "missing",
                    "session-c": 12,
                },
                collapsedFolderIds: [
                    " research ",
                    "research",
                    "missing",
                    12,
                ],
            }),
        );

        expect(readSidebarAgentsFolderState("project-1", null)).toEqual({
            collapsedFolderIds: ["research"],
            folderOrder: ["archive", "research"],
            folders: {
                archive: {
                    createdAt: 0,
                    id: "archive",
                    name: "Archive",
                },
                research: {
                    createdAt: 4,
                    id: "research",
                    name: "Research plans",
                },
            },
            sessionFolderIds: {
                "history-only-session": "research",
            },
        });
    });

    it("returns empty state for corrupted or unsupported persisted data", () => {
        const key = getSidebarAgentsFolderStorageKey("project-1", null);

        globalThis.localStorage.setItem(key, "{not-json");
        expect(readSidebarAgentsFolderState("project-1", null)).toEqual(
            createEmptySidebarAgentsFolderState(),
        );

        globalThis.localStorage.setItem(
            key,
            JSON.stringify({
                version: 999,
                updatedAt: 100,
                ...createState(),
            }),
        );
        expect(readSidebarAgentsFolderState("project-1", null)).toEqual(
            createEmptySidebarAgentsFolderState(),
        );

        globalThis.localStorage.setItem(
            key,
            JSON.stringify({
                version: SIDEBAR_AGENTS_FOLDER_STATE_VERSION,
                updatedAt: "invalid",
                ...createState(),
            }),
        );
        expect(readSidebarAgentsFolderState("project-1", null)).toEqual(
            createEmptySidebarAgentsFolderState(),
        );
    });

    it("renames and deletes folders while cleaning only their related state", () => {
        let state = moveSidebarAgentSessionToFolder(
            createState(),
            "session-a",
            "research",
        );
        state = moveSidebarAgentSessionToFolder(
            state,
            "session-b",
            "archive",
        );
        state = toggleSidebarAgentsFolderCollapsed(state, "research");
        state = toggleSidebarAgentsFolderCollapsed(state, "archive");

        const renamed = renameSidebarAgentsFolder(
            state,
            "research",
            "  Active   research  ",
        );
        expect(renamed.folders.research?.name).toBe("Active research");
        expect(renameSidebarAgentsFolder(renamed, "research", "   ")).toBe(
            renamed,
        );

        const deleted = deleteSidebarAgentsFolder(renamed, "research");
        expect(deleted).toEqual({
            collapsedFolderIds: ["archive"],
            folderOrder: ["archive"],
            folders: {
                archive: {
                    createdAt: 2,
                    id: "archive",
                    name: "Archive",
                },
            },
            sessionFolderIds: { "session-b": "archive" },
        });
        expect(deleteSidebarAgentsFolder(deleted, "missing")).toBe(deleted);
    });

    it("reorders folders with clamped indexes and completes partial order metadata", () => {
        const partialState: SidebarAgentsFolderState = {
            ...createState(),
            folderOrder: ["research"],
            folders: {
                ...createState().folders,
                later: {
                    createdAt: 3,
                    id: "later",
                    name: "Later",
                },
            },
        };

        const movedFirst = reorderSidebarAgentsFolder(
            partialState,
            "later",
            -100,
        );
        expect(movedFirst.folderOrder).toEqual([
            "later",
            "research",
            "archive",
        ]);

        const movedLast = reorderSidebarAgentsFolder(
            movedFirst,
            "later",
            100,
        );
        expect(movedLast.folderOrder).toEqual([
            "research",
            "archive",
            "later",
        ]);
        expect(
            reorderSidebarAgentsFolder(movedLast, "missing", 0),
        ).toBe(movedLast);
        expect(
            reorderSidebarAgentsFolder(movedLast, "later", Number.NaN),
        ).toBe(movedLast);
    });

    it("moves, unassigns, removes, and toggles without pruning unrelated sessions", () => {
        const initial = createState();
        const assigned = moveSidebarAgentSessionToFolder(
            initial,
            "session-a",
            "research",
        );
        const withUnseenAssignment = moveSidebarAgentSessionToFolder(
            assigned,
            "session-not-currently-visible",
            "archive",
        );

        expect(
            moveSidebarAgentSessionToFolder(
                withUnseenAssignment,
                "session-a",
                "missing",
            ),
        ).toBe(withUnseenAssignment);
        expect(
            moveSidebarAgentSessionToFolder(
                withUnseenAssignment,
                "session-a",
                "research",
            ),
        ).toBe(withUnseenAssignment);

        const removed = removeSidebarAgentSessionFolderAssignment(
            withUnseenAssignment,
            "session-a",
        );
        expect(removed.sessionFolderIds).toEqual({
            "session-not-currently-visible": "archive",
        });
        expect(
            removeSidebarAgentSessionFolderAssignment(removed, "missing"),
        ).toBe(removed);

        const collapsed = toggleSidebarAgentsFolderCollapsed(
            removed,
            "archive",
        );
        expect(collapsed.collapsedFolderIds).toEqual(["archive"]);
        expect(
            toggleSidebarAgentsFolderCollapsed(collapsed, "archive")
                .collapsedFolderIds,
        ).toEqual([]);
        expect(
            toggleSidebarAgentsFolderCollapsed(collapsed, "missing"),
        ).toBe(collapsed);
    });
});
