import { beforeEach, describe, expect, it } from "vitest";

import {
    GIT_DIFF_STYLE_STORAGE_KEY,
    persistGitDiffStyle,
    readPersistedGitDiffStyle,
} from "./gitDiffStylePersistence";

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

class ThrowingStorage extends MemoryStorage {
    override getItem(key: string): string | null {
        void key;
        throw new Error("storage unavailable");
    }

    override setItem(key: string, value: string): void {
        void key;
        void value;
        throw new Error("quota exceeded");
    }
}

describe("gitDiffStylePersistence", () => {
    beforeEach(() => {
        Object.defineProperty(globalThis, "localStorage", {
            configurable: true,
            value: new MemoryStorage(),
            writable: true,
        });
    });

    it("defaults to the unified layout", () => {
        expect(readPersistedGitDiffStyle()).toBe("unified");
    });

    it("persists the side-by-side layout", () => {
        persistGitDiffStyle("split");

        expect(globalThis.localStorage.getItem(GIT_DIFF_STYLE_STORAGE_KEY)).toBe(
            "split",
        );
        expect(readPersistedGitDiffStyle()).toBe("split");
    });

    it("treats malformed storage values as the unified layout", () => {
        globalThis.localStorage.setItem(GIT_DIFF_STYLE_STORAGE_KEY, "grid");

        expect(readPersistedGitDiffStyle()).toBe("unified");
    });

    it("keeps the unified fallback when storage is unavailable", () => {
        Object.defineProperty(globalThis, "localStorage", {
            configurable: true,
            value: new ThrowingStorage(),
            writable: true,
        });

        expect(readPersistedGitDiffStyle()).toBe("unified");
        expect(persistGitDiffStyle("split")).toBe("split");
    });
});
