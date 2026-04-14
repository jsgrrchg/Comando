import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReviewFileItem } from "./editedFilesPresentationModel";
import {
    createPersistedReviewAnchor,
    getReviewViewStorageKey,
    persistReviewViewState,
    readPersistedReviewViewState,
    resolvePersistedReviewAnchor,
} from "./reviewTabPersistence";

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

function createReviewItem(
    identityKey: string,
    overrides: {
        readonly path?: string;
        readonly previousPath?: string | null;
        readonly updatedAt?: string;
        readonly hunkIds?: readonly string[];
    } = {},
): ReviewFileItem {
    const path = overrides.path ?? `src/${identityKey}.ts`;
    const previousPath = overrides.previousPath ?? null;
    const updatedAt = overrides.updatedAt ?? "2026-04-14T12:00:00.000Z";
    const hunkIds = overrides.hunkIds ?? ["hunk-1"];

    return {
        canOpen: true,
        canReject: true,
        canResolveHunks: true,
        diff: {
            hunks: hunkIds.map((hunkId, index) => ({
                id: hunkId,
                lines: [
                    {
                        id: `${hunkId}:remove`,
                        text: `old-${index}`,
                        type: "remove" as const,
                    },
                    {
                        id: `${hunkId}:add`,
                        text: `new-${index}`,
                        type: "add" as const,
                    },
                ],
                newCount: 1,
                newStart: index + 1,
                oldCount: 1,
                oldStart: index + 1,
            })),
            isText: true,
            kind: "update",
            newText: "new",
            oldText: "old",
            path,
            previousPath,
            reversible: true,
        },
        file: {
            hunks: hunkIds.map((hunkId, index) => ({
                id: hunkId,
                lines: [
                    {
                        id: `${hunkId}:remove`,
                        text: `old-${index}`,
                        type: "remove" as const,
                    },
                    {
                        id: `${hunkId}:add`,
                        text: `new-${index}`,
                        type: "add" as const,
                    },
                ],
                newCount: 1,
                newStart: index + 1,
                oldCount: 1,
                oldStart: index + 1,
            })),
            identityKey,
            isText: true,
            kind: "update",
            newText: "new",
            oldText: "old",
            path,
            previousPath,
            reviewState: "pending",
            reversible: true,
            sessionId: "session-1",
            toolCallId: "tool-1",
            updatedAt,
        },
        lines: [],
        stats: {
            additions: 1,
            approximate: false,
            deletions: 1,
        },
        summary: "Modified",
        tone: {
            accent: "var(--diff-add)",
            badge: null,
        },
    };
}

describe("reviewTabPersistence", () => {
    beforeEach(() => {
        Object.defineProperty(globalThis, "localStorage", {
            configurable: true,
            value: new MemoryStorage(),
            writable: true,
        });
        vi.useRealTimers();
    });

    it("persists and restores review view state scoped by project, worktree and session", () => {
        const key = getReviewViewStorageKey(
            "project-1",
            "worktree-1",
            "session-1",
        );
        const item = createReviewItem("file-1", {
            hunkIds: ["10:11:10:11"],
        });

        const persisted = persistReviewViewState(
            "project-1",
            "worktree-1",
            "session-1",
            {
                anchor: createPersistedReviewAnchor(item, ["10:11:10:11"]),
                expandedIdentityKeys: ["file-1", "file-2"],
                scrollTop: 144,
            },
        );

        expect(globalThis.localStorage.getItem(key)).not.toBeNull();
        expect(readPersistedReviewViewState("project-1", "worktree-1", "session-1")).toEqual(
            persisted,
        );
    });

    it("resolves anchors after a rename by matching path aliases", () => {
        const previousItem = createReviewItem("old-key", {
            path: "src/old-name.ts",
            previousPath: null,
            updatedAt: "2026-04-14T12:00:00.000Z",
        });
        const renamedItem = createReviewItem("new-key", {
            path: "src/new-name.ts",
            previousPath: "src/old-name.ts",
            updatedAt: "2026-04-14T12:05:00.000Z",
        });

        const anchor = createPersistedReviewAnchor(previousItem, ["hunk-1"]);

        expect(resolvePersistedReviewAnchor(anchor, [renamedItem])).toEqual({
            fileUpdatedAt: "2026-04-14T12:05:00.000Z",
            hunkIds: ["hunk-1"],
            identityKey: "new-key",
            pathAliases: ["src/new-name.ts", "src/old-name.ts"],
        });
    });
    it("prefers the anchor timestamp when multiple alias candidates match", () => {
        const sourceItem = createReviewItem("old-key", {
            path: "src/old-name.ts",
            previousPath: null,
            updatedAt: "2026-04-14T12:00:00.000Z",
        });
        const exactCandidate = createReviewItem("exact-key", {
            path: "src/exact-name.ts",
            previousPath: "src/old-name.ts",
            updatedAt: "2026-04-14T12:00:00.000Z",
        });
        const newerCandidate = createReviewItem("newer-key", {
            path: "src/newer-name.ts",
            previousPath: "src/old-name.ts",
            updatedAt: "2026-04-14T12:20:00.000Z",
        });

        const anchor = createPersistedReviewAnchor(sourceItem, ["hunk-1"]);

        expect(
            resolvePersistedReviewAnchor(anchor, [newerCandidate, exactCandidate]),
        ).toEqual({
            fileUpdatedAt: "2026-04-14T12:00:00.000Z",
            hunkIds: ["hunk-1"],
            identityKey: "exact-key",
            pathAliases: ["src/exact-name.ts", "src/old-name.ts"],
        });
    });

    it("prefers a path-alias candidate whose updatedAt matches the anchor", () => {
        const previousItem = createReviewItem("old-key", {
            path: "src/shared.ts",
            previousPath: null,
            updatedAt: "2026-04-14T12:00:00.000Z",
        });
        const exactUpdatedAtCandidate = createReviewItem("exact-key", {
            path: "src/exact.ts",
            previousPath: "src/shared.ts",
            updatedAt: "2026-04-14T12:00:00.000Z",
        });
        const newerCollision = createReviewItem("newer-key", {
            path: "src/newer.ts",
            previousPath: "src/shared.ts",
            updatedAt: "2026-04-14T12:10:00.000Z",
        });

        const anchor = createPersistedReviewAnchor(previousItem, ["hunk-1"]);

        expect(
            resolvePersistedReviewAnchor(anchor, [newerCollision, exactUpdatedAtCandidate]),
        ).toEqual({
            fileUpdatedAt: "2026-04-14T12:00:00.000Z",
            hunkIds: ["hunk-1"],
            identityKey: "exact-key",
            pathAliases: ["src/exact.ts", "src/shared.ts"],
        });
    });


    it("avoids clobbering newer persisted state and merges expanded keys on stale writes", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-04-14T12:00:00.000Z"));

        const newer = persistReviewViewState(
            "project-1",
            "worktree-1",
            "session-race",
            {
                anchor: null,
                expandedIdentityKeys: ["server"],
                scrollTop: 320,
            },
            {
                writerId: "server",
            },
        );

        vi.setSystemTime(new Date("2026-04-14T12:00:05.000Z"));

        const merged = persistReviewViewState(
            "project-1",
            "worktree-1",
            "session-race",
            {
                anchor: null,
                expandedIdentityKeys: ["client"],
                scrollTop: 48,
            },
            {
                baseUpdatedAt: (newer?.updatedAt ?? 0) - 1,
                writerId: "client",
            },
        );

        expect(merged?.scrollTop).toBe(320);
        expect(merged?.expandedIdentityKeys).toEqual(
            expect.arrayContaining(["server", "client"]),
        );
    });
});
