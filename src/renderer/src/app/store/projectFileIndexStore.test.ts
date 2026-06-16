// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectTreeInvalidation, ProjectTreeNode } from "@shared/ipc";

import {
    normalizeIndexPath,
    useProjectFileIndexStore,
} from "./projectFileIndexStore";

function fileNode(relativePath: string): ProjectTreeNode {
    return {
        id: relativePath,
        name: relativePath.split("/").pop() ?? relativePath,
        relativePath,
        parentRelativePath: null,
        kind: "file",
        extension: null,
        hasChildren: false,
        gitStatus: null,
    };
}

function directoryNode(relativePath: string): ProjectTreeNode {
    return { ...fileNode(relativePath), kind: "directory", hasChildren: true };
}

type InvalidationListener = (payload: ProjectTreeInvalidation) => void;

// The store subscribes to invalidations lazily and only once (module-level
// singleton), so the listener array must be stable across tests — recreating it
// would orphan the store's already-registered listener.
const invalidationListeners: InvalidationListener[] = [];
let listProjectEntries: ReturnType<typeof vi.fn>;

function emitInvalidation(projectId: string): void {
    const payload: ProjectTreeInvalidation = {
        projectId,
        occurredAt: "2026-06-16T00:00:00.000Z",
    };
    for (const listener of invalidationListeners) {
        listener(payload);
    }
}

function entryFor(projectId: string, worktreeId: string | null = null) {
    const key = `${projectId}::${worktreeId ?? "__primary__"}`;
    return useProjectFileIndexStore.getState().byContext[key];
}

beforeEach(() => {
    listProjectEntries = vi.fn().mockResolvedValue([]);
    (window as unknown as { comando: unknown }).comando = {
        listProjectEntries,
        onProjectTreeInvalidated: (listener: InvalidationListener) => {
            invalidationListeners.push(listener);
            return () => {
                const index = invalidationListeners.indexOf(listener);
                if (index >= 0) {
                    invalidationListeners.splice(index, 1);
                }
            };
        },
    };
    useProjectFileIndexStore.setState({ byContext: {} });
});

describe("normalizeIndexPath", () => {
    it("strips a leading ./ and trailing slashes without lowercasing", () => {
        expect(normalizeIndexPath("./src/App.tsx")).toBe("src/App.tsx");
        expect(normalizeIndexPath("src/components/")).toBe("src/components");
        expect(normalizeIndexPath("SRC/App.TSX")).toBe("SRC/App.TSX");
    });
});

describe("useProjectFileIndexStore.load", () => {
    it("indexes only file paths and ignores directories", async () => {
        listProjectEntries.mockResolvedValue([
            fileNode("src/app.ts"),
            directoryNode("src/components"),
            fileNode("./src/components/Button.tsx"),
        ]);

        useProjectFileIndexStore.getState().load("p1", null);

        await vi.waitFor(() => {
            expect(entryFor("p1")?.status).toBe("ready");
        });

        const paths = entryFor("p1")?.paths;
        expect(paths?.has("src/app.ts")).toBe(true);
        expect(paths?.has("src/components/Button.tsx")).toBe(true);
        expect(paths?.has("src/components")).toBe(false);
    });

    it("does not load when the project id is missing", () => {
        useProjectFileIndexStore.getState().load(null, null);
        expect(listProjectEntries).not.toHaveBeenCalled();
    });

    it("loads a context only once while cached", async () => {
        listProjectEntries.mockResolvedValue([fileNode("a.ts")]);

        useProjectFileIndexStore.getState().load("p2", null);
        await vi.waitFor(() => {
            expect(entryFor("p2")?.status).toBe("ready");
        });

        useProjectFileIndexStore.getState().load("p2", null);
        expect(listProjectEntries).toHaveBeenCalledTimes(1);
    });

    it("marks the context as error and retries on a later load", async () => {
        listProjectEntries.mockRejectedValueOnce(new Error("ipc down"));

        useProjectFileIndexStore.getState().load("p-err", null);
        await vi.waitFor(() => {
            expect(entryFor("p-err")?.status).toBe("error");
        });

        listProjectEntries.mockResolvedValue([fileNode("ok.ts")]);
        // A prior error is retryable.
        useProjectFileIndexStore.getState().load("p-err", null);
        await vi.waitFor(() => {
            expect(entryFor("p-err")?.status).toBe("ready");
        });
        expect(entryFor("p-err")?.paths?.has("ok.ts")).toBe(true);
        expect(listProjectEntries).toHaveBeenCalledTimes(2);
    });

    it("marks the index stale (keeping old paths) on invalidation, then reloads", async () => {
        listProjectEntries.mockResolvedValue([fileNode("a.ts")]);

        useProjectFileIndexStore.getState().load("p3", null);
        await vi.waitFor(() => {
            expect(entryFor("p3")?.status).toBe("ready");
        });

        emitInvalidation("p3");
        // Stale-while-revalidate: old paths stay visible, not dropped.
        expect(entryFor("p3")?.status).toBe("stale");
        expect(entryFor("p3")?.paths?.has("a.ts")).toBe(true);

        listProjectEntries.mockResolvedValue([fileNode("b.ts")]);
        useProjectFileIndexStore.getState().load("p3", null);
        await vi.waitFor(() => {
            expect(entryFor("p3")?.status).toBe("ready");
        });
        expect(entryFor("p3")?.paths?.has("b.ts")).toBe(true);
        expect(entryFor("p3")?.paths?.has("a.ts")).toBe(false);
        expect(listProjectEntries).toHaveBeenCalledTimes(2);
    });

    it("keeps the old paths visible while revalidating after an invalidation", async () => {
        listProjectEntries.mockResolvedValue([fileNode("a.ts")]);
        useProjectFileIndexStore.getState().load("p-swr", null);
        await vi.waitFor(() => {
            expect(entryFor("p-swr")?.status).toBe("ready");
        });

        // Hold the revalidation open so we can observe the in-between state.
        let resolveReload: (entries: ProjectTreeNode[]) => void = () => {};
        const reload = new Promise<ProjectTreeNode[]>((resolve) => {
            resolveReload = resolve;
        });
        listProjectEntries.mockReturnValueOnce(reload);

        emitInvalidation("p-swr");
        useProjectFileIndexStore.getState().load("p-swr", null);

        // While the fresh index is loading, the old paths remain available.
        expect(entryFor("p-swr")?.status).toBe("loading");
        expect(entryFor("p-swr")?.paths?.has("a.ts")).toBe(true);

        resolveReload([fileNode("a.ts"), fileNode("c.ts")]);
        await vi.waitFor(() => {
            expect(entryFor("p-swr")?.status).toBe("ready");
        });
        expect(entryFor("p-swr")?.paths?.has("c.ts")).toBe(true);
    });

    it("discards a first in-flight load when an invalidation races it", async () => {
        // Hold the first load open so the invalidation arrives mid-flight.
        let resolveFirstLoad: (entries: ProjectTreeNode[]) => void = () => {};
        const firstLoad = new Promise<ProjectTreeNode[]>((resolve) => {
            resolveFirstLoad = resolve;
        });
        listProjectEntries.mockReturnValueOnce(firstLoad);

        useProjectFileIndexStore.getState().load("p-race", null);
        expect(entryFor("p-race")?.status).toBe("loading");

        // Invalidation arrives before the first load resolves.
        emitInvalidation("p-race");
        expect(entryFor("p-race")?.status).toBe("stale");

        // The stale (pre-invalidation) response resolves now and must be ignored
        // by the epoch guard — it must not become the cached index.
        resolveFirstLoad([fileNode("stale.ts")]);
        await Promise.resolve();
        await Promise.resolve();
        expect(entryFor("p-race")?.status).toBe("stale");
        expect(entryFor("p-race")?.paths?.has("stale.ts") ?? false).toBe(false);

        // A fresh load reflects post-invalidation state.
        listProjectEntries.mockResolvedValue([fileNode("fresh.ts")]);
        useProjectFileIndexStore.getState().load("p-race", null);
        await vi.waitFor(() => {
            expect(entryFor("p-race")?.status).toBe("ready");
        });
        expect(entryFor("p-race")?.paths?.has("fresh.ts")).toBe(true);
        expect(entryFor("p-race")?.paths?.has("stale.ts")).toBe(false);
    });
});
