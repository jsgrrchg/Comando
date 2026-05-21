import { beforeEach, describe, expect, it } from "vitest";

import {
    getWorkspaceScrollStorageKey,
    persistWorkspaceScrollState,
    readPersistedWorkspaceScrollState,
} from "./usePersistedWorkspaceScroll";

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

describe("usePersistedWorkspaceScroll", () => {
    beforeEach(() => {
        Object.defineProperty(globalThis, "localStorage", {
            configurable: true,
            value: new MemoryStorage(),
            writable: true,
        });
    });

    it("builds stable keys scoped by surface, project, worktree and entity", () => {
        expect(
            getWorkspaceScrollStorageKey({
                entityId: "issue-123",
                projectId: "project-1",
                surface: "github_issue",
                worktreeId: "worktree-1",
            }),
        ).toBe(
            "comando.workspace.scroll:v1:surface:github_issue:project:project-1:worktree:worktree-1:entity:issue-123",
        );
    });

    it("uses global and root fallbacks when project or worktree are missing", () => {
        expect(
            getWorkspaceScrollStorageKey({
                projectId: null,
                surface: "chat_history",
                worktreeId: null,
            }),
        ).toBe(
            "comando.workspace.scroll:v1:surface:chat_history:project:global:worktree:root",
        );
    });

    it("persists and restores scroll offsets", () => {
        const key = getWorkspaceScrollStorageKey({
            projectId: "project-1",
            surface: "chat_history",
            worktreeId: "worktree-1",
        });

        const persisted = persistWorkspaceScrollState(key, 320);

        expect(globalThis.localStorage.getItem(key)).not.toBeNull();
        expect(readPersistedWorkspaceScrollState(key)).toEqual(persisted);
    });

    it("clamps negative scroll offsets when persisting", () => {
        const key = getWorkspaceScrollStorageKey({
            projectId: "project-1",
            surface: "git",
            worktreeId: null,
        });

        persistWorkspaceScrollState(key, -24);

        expect(readPersistedWorkspaceScrollState(key)).toMatchObject({
            scrollTop: 0,
        });
    });
});
