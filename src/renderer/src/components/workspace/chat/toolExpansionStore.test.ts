import { describe, expect, it } from "vitest";

import {
    applyPersistentToolStateUpdate,
    getScopedToolUiStateStore,
    readStoredToolState,
    releaseScopedToolUiStateStore,
    resetScopedToolUiStateStoresForTests,
    resolvePersistentToolState,
} from "./toolExpansionStore";

describe("getScopedToolUiStateStore", () => {
    it("reuses state for the same chat scope and isolates other chats", () => {
        resetScopedToolUiStateStoresForTests();
        const firstMount = getScopedToolUiStateStore("session-1");
        firstMount.set("activity", true);

        expect(getScopedToolUiStateStore("session-1")).toBe(firstMount);
        expect(
            getScopedToolUiStateStore("session-1").get("activity"),
        ).toBe(true);
        expect(
            getScopedToolUiStateStore("session-2").has("activity"),
        ).toBe(false);
    });

    it("releases state for a permanently deleted chat scope", () => {
        resetScopedToolUiStateStoresForTests();
        getScopedToolUiStateStore("session-1").set("activity", true);

        releaseScopedToolUiStateStore("session-1");

        expect(getScopedToolUiStateStore("session-1").has("activity")).toBe(
            false,
        );
    });
});

describe("readStoredToolState", () => {
    it("returns the default when the key is absent", () => {
        expect(readStoredToolState(new Map(), "missing", "default")).toBe(
            "default",
        );
    });

    it("returns the stored value when the key is present", () => {
        const store = new Map<string, unknown>([["k", "stored"]]);

        expect(readStoredToolState(store, "k", "default")).toBe("stored");
    });

    it("treats a stored false/0 as a real value rather than a miss", () => {
        const store = new Map<string, unknown>([
            ["flag", false],
            ["count", 0],
        ]);

        expect(readStoredToolState(store, "flag", true)).toBe(false);
        expect(readStoredToolState(store, "count", 5)).toBe(0);
    });

    it("falls back to the default when there is no provider (null store)", () => {
        expect(readStoredToolState(null, "k", "default")).toBe("default");
    });
});

describe("resolvePersistentToolState", () => {
    it("keeps the in-memory slot value while the key is unchanged", () => {
        // The live value wins over the store while the key matches, so a local
        // toggle is not clobbered by a stale stored value.
        const store = new Map<string, unknown>([["k", "stored"]]);

        expect(
            resolvePersistentToolState(
                { key: "k", value: "live" },
                store,
                "k",
                "default",
            ),
        ).toBe("live");
    });

    it("re-hydrates from the store when the key changes", () => {
        const store = new Map<string, unknown>([["next", "persisted"]]);

        expect(
            resolvePersistentToolState(
                { key: "prev", value: "live" },
                store,
                "next",
                "default",
            ),
        ).toBe("persisted");
    });

    it("re-hydrates to the default when the new key was never stored", () => {
        expect(
            resolvePersistentToolState(
                { key: "prev", value: "live" },
                new Map(),
                "next",
                "default",
            ),
        ).toBe("default");
    });
});

describe("applyPersistentToolStateUpdate", () => {
    it("writes a direct value into the store and returns the next slot", () => {
        const store = new Map<string, unknown>();

        const slot = applyPersistentToolStateUpdate(
            { key: "k", value: false },
            store,
            "k",
            false,
            true,
        );

        expect(slot).toEqual({ key: "k", value: true });
        expect(store.get("k")).toBe(true);
    });

    it("applies a functional updater against the current value", () => {
        const store = new Map<string, unknown>();

        const slot = applyPersistentToolStateUpdate(
            { key: "k", value: 200 },
            store,
            "k",
            200,
            (previous: number) => previous + 40,
        );

        expect(slot.value).toBe(240);
        expect(store.get("k")).toBe(240);
    });

    it("runs the updater against the re-hydrated previous after a key change", () => {
        // The slot is stale (still on the old key); the updater must see the
        // value persisted under the NEW key, not the stale slot value. Here the
        // toggle flips the persisted `true`, not the slot's `false`.
        const store = new Map<string, unknown>([["next", true]]);

        const slot = applyPersistentToolStateUpdate(
            { key: "prev", value: false },
            store,
            "next",
            false,
            (previous: boolean) => !previous,
        );

        expect(slot.value).toBe(false);
        expect(store.get("next")).toBe(false);
    });

    it("persists across a remount: a written value is re-read by a fresh slot", () => {
        // This is the whole point of the store: a card's UI state outlives its
        // virtualized row scrolling out of view and remounting.
        const store = new Map<string, unknown>();

        // First mount: the user expands the card.
        applyPersistentToolStateUpdate(
            { key: "card", value: false },
            store,
            "card",
            false,
            true,
        );

        // The row scrolls away and remounts: a fresh slot initializes by reading
        // the store rather than the default.
        expect(readStoredToolState(store, "card", false)).toBe(true);
    });

    it("still returns the next slot when there is no provider to persist into", () => {
        // Without a store the hook degrades to ordinary local state: the update
        // resolves but has nowhere to persist, and must not throw.
        const slot = applyPersistentToolStateUpdate(
            { key: "k", value: 1 },
            null,
            "k",
            1,
            2,
        );

        expect(slot).toEqual({ key: "k", value: 2 });
    });
});
