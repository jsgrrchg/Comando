import { beforeEach, describe, expect, it } from "vitest";

import {
    getGitCommitDiffCollapseStorageKey,
    persistGitCommitDiffCollapseState,
    readPersistedGitCommitDiffCollapseState,
} from "./gitCommitDiffCollapsePersistence";

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

describe("gitCommitDiffCollapsePersistence", () => {
    beforeEach(() => {
        Object.defineProperty(globalThis, "localStorage", {
            configurable: true,
            value: new MemoryStorage(),
            writable: true,
        });
    });

    it("builds stable keys scoped by surface, project, worktree and commit", () => {
        expect(
            getGitCommitDiffCollapseStorageKey({
                commitSha: "d094662",
                projectId: "project-1",
                surface: "git_commit",
                worktreeId: "worktree-1",
            }),
        ).toBe(
            "comando.workspace.gitCommitDiffCollapse:v1:surface:git_commit:project:project-1:worktree:worktree-1:commit:d094662",
        );
    });

    it("returns null when no collapse state has been persisted", () => {
        const key = getGitCommitDiffCollapseStorageKey({
            commitSha: "d094662",
            projectId: "project-1",
            surface: "git_commit",
            worktreeId: null,
        });

        expect(readPersistedGitCommitDiffCollapseState(key)).toBeNull();
    });

    it("persists collapsed file ids", () => {
        const key = getGitCommitDiffCollapseStorageKey({
            commitSha: "d094662",
            projectId: "project-1",
            surface: "git_commit",
            worktreeId: null,
        });

        const persisted = persistGitCommitDiffCollapseState(key, [
            "file-a.ts",
            "file-b.ts",
        ]);

        expect(globalThis.localStorage.getItem(key)).not.toBeNull();
        expect(readPersistedGitCommitDiffCollapseState(key)).toEqual(
            persisted,
        );
    });

    it("deduplicates invalid collapsed file ids before persisting", () => {
        const key = getGitCommitDiffCollapseStorageKey({
            commitSha: "d094662",
            projectId: "project-1",
            surface: "git_commit",
            worktreeId: null,
        });

        persistGitCommitDiffCollapseState(key, [
            "file-a.ts",
            "",
            "file-a.ts",
            "file-b.ts",
        ]);

        expect(readPersistedGitCommitDiffCollapseState(key)).toMatchObject({
            collapsedFileIds: ["file-a.ts", "file-b.ts"],
        });
    });

    it("returns null when storage reads or writes fail", () => {
        Object.defineProperty(globalThis, "localStorage", {
            configurable: true,
            value: new ThrowingStorage(),
            writable: true,
        });

        const key = getGitCommitDiffCollapseStorageKey({
            commitSha: "d094662",
            projectId: "project-1",
            surface: "git_commit",
            worktreeId: null,
        });

        expect(readPersistedGitCommitDiffCollapseState(key)).toBeNull();
        expect(
            persistGitCommitDiffCollapseState(key, ["file-a.ts"]),
        ).toBeNull();
    });
});
