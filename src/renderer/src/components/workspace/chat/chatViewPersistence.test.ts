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
                anchor: {
                    alignment: "start",
                    blockId: "block-7",
                    entryId: "entry-7",
                    offsetWithinEntry: 12,
                },
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
        expect(persisted?.anchor).toMatchObject({
            blockId: "block-7",
            entryId: "entry-7",
        });
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

    it("reads legacy anchors without a block hint", () => {
        const key = getChatViewStorageKey("project-1", null, "session-legacy");
        globalThis.localStorage.setItem(
            key,
            JSON.stringify({
                anchor: {
                    alignment: "start",
                    entryId: "entry-legacy",
                    offsetWithinEntry: 8,
                },
                isNearBottom: false,
                scrollTop: 320,
                updatedAt: 1,
                version: 2,
            }),
        );

        expect(
            readPersistedChatViewState("project-1", null, "session-legacy")
                ?.anchor,
        ).toMatchObject({ blockId: null, entryId: "entry-legacy" });
    });

    it("upgrades version 2 anchors without a virtual row identity", () => {
        const key = getChatViewStorageKey("project-1", null, "session-legacy");
        globalThis.localStorage.setItem(
            key,
            JSON.stringify({
                anchor: {
                    alignment: "start",
                    entryId: "message:long",
                    offsetWithinEntry: 48,
                },
                isNearBottom: false,
                scrollTop: 320,
                updatedAt: 1,
                version: 2,
            }),
        );

        expect(
            readPersistedChatViewState("project-1", null, "session-legacy"),
        )?.toMatchObject({
            anchor: { timelineItemId: null },
            version: 3,
        });
    });
});
