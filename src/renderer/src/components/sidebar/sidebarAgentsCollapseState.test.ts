import { beforeEach, describe, expect, it } from "vitest";

import {
    getSidebarAgentsCollapseStorageKey,
    persistSidebarAgentsCollapsedSessionIds,
    readSidebarAgentsCollapsedSessionIds,
} from "./sidebarAgentsCollapseState";

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

describe("sidebarAgentsCollapseState", () => {
    beforeEach(() => {
        Object.defineProperty(globalThis, "localStorage", {
            configurable: true,
            value: new MemoryStorage(),
            writable: true,
        });
    });

    it("persists and restores collapsed session ids scoped by project and worktree", () => {
        const key = getSidebarAgentsCollapseStorageKey(
            "project-1",
            "worktree-1",
        );
        const persisted = persistSidebarAgentsCollapsedSessionIds(
            "project-1",
            "worktree-1",
            new Set(["parent-1", "parent-2"]),
        );

        expect(globalThis.localStorage.getItem(key)).not.toBeNull();
        expect(persisted?.collapsedSessionIds).toEqual([
            "parent-1",
            "parent-2",
        ]);
        expect(
            [
                ...readSidebarAgentsCollapsedSessionIds(
                    "project-1",
                    "worktree-1",
                ),
            ],
        ).toEqual(["parent-1", "parent-2"]);
    });

    it("keeps collapse state isolated between worktree scopes", () => {
        persistSidebarAgentsCollapsedSessionIds(
            "project-1",
            "worktree-a",
            new Set(["parent-a"]),
        );
        persistSidebarAgentsCollapsedSessionIds(
            "project-1",
            "worktree-b",
            new Set(["parent-b"]),
        );

        expect(
            [
                ...readSidebarAgentsCollapsedSessionIds(
                    "project-1",
                    "worktree-a",
                ),
            ],
        ).toEqual(["parent-a"]);
        expect(
            [
                ...readSidebarAgentsCollapsedSessionIds(
                    "project-1",
                    "worktree-b",
                ),
            ],
        ).toEqual(["parent-b"]);
    });

    it("normalizes duplicates, blanks and non-string session ids", () => {
        const key = getSidebarAgentsCollapseStorageKey("project-1", null);

        globalThis.localStorage.setItem(
            key,
            JSON.stringify({
                collapsedSessionIds: [
                    " parent-1 ",
                    "",
                    "parent-1",
                    null,
                    "parent-2",
                ],
                updatedAt: Date.now(),
                version: 1,
            }),
        );

        expect(
            [...readSidebarAgentsCollapsedSessionIds("project-1", null)],
        ).toEqual(["parent-1", "parent-2"]);
    });

    it("ignores corrupted or unsupported persisted state", () => {
        const key = getSidebarAgentsCollapseStorageKey("project-1", null);

        globalThis.localStorage.setItem(key, "{not-json");
        expect(readSidebarAgentsCollapsedSessionIds("project-1", null).size).toBe(
            0,
        );

        globalThis.localStorage.setItem(
            key,
            JSON.stringify({
                collapsedSessionIds: ["parent-1"],
                updatedAt: Date.now(),
                version: 999,
            }),
        );
        expect(readSidebarAgentsCollapsedSessionIds("project-1", null).size).toBe(
            0,
        );
    });
});
