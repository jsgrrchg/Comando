import { beforeEach, describe, expect, it } from "vitest";

import {
    getChatViewStorageKey,
    persistChatViewState,
    readPersistedChatViewState,
} from "./chatViewPersistence";

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

describe("chatViewPersistence", () => {
    beforeEach(() => {
        Object.defineProperty(globalThis, "localStorage", {
            configurable: true,
            value: new MemoryStorage(),
            writable: true,
        });
    });

    it("persists and restores chat view state scoped by project, worktree and session", () => {
        const key = getChatViewStorageKey(
            "project-1",
            "worktree-1",
            "session-1",
        );

        const persisted = persistChatViewState(
            "project-1",
            "worktree-1",
            "session-1",
            {
                isNearBottom: false,
                scrollTop: 256,
            },
        );

        expect(globalThis.localStorage.getItem(key)).not.toBeNull();
        expect(
            readPersistedChatViewState(
                "project-1",
                "worktree-1",
                "session-1",
            ),
        ).toEqual(persisted);
    });

    it("clamps negative scroll offsets when persisting", () => {
        const persisted = persistChatViewState("project-1", null, "session-1", {
            isNearBottom: false,
            scrollTop: -48,
        });

        expect(persisted?.scrollTop).toBe(0);
        expect(
            readPersistedChatViewState("project-1", null, "session-1"),
        )?.toMatchObject({
            isNearBottom: false,
            scrollTop: 0,
        });
    });
});
