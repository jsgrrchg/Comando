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
        openRelativePath: path,
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

describe("reviewTabPersistence virtualization anchors", () => {
    beforeEach(() => {
        Object.defineProperty(globalThis, "localStorage", {
            configurable: true,
            value: new MemoryStorage(),
            writable: true,
        });
        vi.useRealTimers();
    });

    it("persists offsetWithinItem for virtualized restore", () => {
        const item = createReviewItem("file-1", {
            hunkIds: ["10:11:10:11"],
        });

        persistReviewViewState("project-1", "worktree-1", "session-1", {
            anchor: createPersistedReviewAnchor(item, ["10:11:10:11"], {
                offsetWithinItem: 48,
            }),
            expandedIdentityKeys: ["file-1"],
            scrollTop: 144,
        });

        const restored = readPersistedReviewViewState(
            "project-1",
            "worktree-1",
            "session-1",
        );

        expect(restored?.version).toBe(2);
        expect(restored?.anchor).toEqual({
            fileUpdatedAt: "2026-04-14T12:00:00.000Z",
            hunkIds: ["10:11:10:11"],
            identityKey: "file-1",
            offsetWithinItem: 48,
            pathAliases: ["src/file-1.ts"],
        });
    });

    it("preserves offsetWithinItem when the anchor resolves through path aliases", () => {
        const previousItem = createReviewItem("old-key", {
            path: "src/old-name.ts",
        });
        const renamedItem = createReviewItem("new-key", {
            path: "src/new-name.ts",
            previousPath: "src/old-name.ts",
            updatedAt: "2026-04-14T12:05:00.000Z",
        });

        const anchor = createPersistedReviewAnchor(previousItem, ["hunk-1"], {
            offsetWithinItem: 96,
        });

        expect(resolvePersistedReviewAnchor(anchor, [renamedItem])).toEqual({
            fileUpdatedAt: "2026-04-14T12:05:00.000Z",
            hunkIds: ["hunk-1"],
            identityKey: "new-key",
            offsetWithinItem: 96,
            pathAliases: ["src/new-name.ts", "src/old-name.ts"],
        });
    });

    it("reads legacy version 1 review view state without offsetWithinItem", () => {
        const key = getReviewViewStorageKey(
            "project-1",
            "worktree-1",
            "session-1",
        );

        globalThis.localStorage.setItem(
            key,
            JSON.stringify({
                anchor: {
                    fileUpdatedAt: "2026-04-14T12:00:00.000Z",
                    hunkIds: ["10:11:10:11"],
                    identityKey: "file-1",
                    pathAliases: ["src/file-1.ts"],
                },
                expandedIdentityKeys: ["file-1"],
                scrollTop: 72,
                updatedAt: 123,
                version: 1,
            }),
        );

        expect(
            readPersistedReviewViewState(
                "project-1",
                "worktree-1",
                "session-1",
            ),
        ).toEqual({
            anchor: {
                fileUpdatedAt: "2026-04-14T12:00:00.000Z",
                hunkIds: ["10:11:10:11"],
                identityKey: "file-1",
                pathAliases: ["src/file-1.ts"],
            },
            expandedIdentityKeys: ["file-1"],
            scrollTop: 72,
            updatedAt: 123,
            version: 2,
            writerId: undefined,
        });
    });
});
