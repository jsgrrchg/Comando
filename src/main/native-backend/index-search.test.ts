import { describe, expect, it, vi } from "vitest";

import type { NativeBackendRequester } from "./persistence";
import { NativeSearchGateway } from "./index-search";

describe("NativeSearchGateway", () => {
    it("adapts native list and search results to project tree nodes", async () => {
        const requestMock = vi.fn((command: string) => {
            if (command === "project_list_entries") {
                return Promise.resolve({
                    entries: [nativeEntry("src/main.ts")],
                    truncated: false,
                });
            }

            return Promise.resolve({
                entries: [nativeEntry("src/main.ts")],
                generation: 1,
                matches: [{ entry: nativeEntry("src/main.ts"), score: 400 }],
                operationId: "operation_1",
                stats: nativeStats(),
                status: "ready",
            });
        });
        const gateway = gatewayWith(requestMock);

        await expect(
            gateway.listProjectEntries({
                projectId: "project-1",
                rootPath: "/tmp/project",
                worktreeId: null,
            }),
        ).resolves.toEqual([
            expect.objectContaining({
                kind: "file",
                relativePath: "src/main.ts",
            }),
        ]);

        await expect(
            gateway.searchProjectEntries({
                includeAncestorDirectories: false,
                limit: 20,
                projectId: "project-1",
                query: "main",
                rootPath: "/tmp/project",
                worktreeId: null,
            }),
        ).resolves.toEqual([
            expect.objectContaining({
                kind: "file",
                relativePath: "src/main.ts",
            }),
        ]);
    });

    it("rejects truncated native index listings", async () => {
        const gateway = gatewayWith(
            vi.fn(() => Promise.resolve({
                entries: [],
                truncated: true,
            })),
        );

        await expect(
            gateway.listProjectEntries({
                projectId: "project-1",
                rootPath: "/tmp/project",
                worktreeId: null,
            }),
        ).rejects.toThrow("Native project index listing was truncated");
    });

    it("scopes native search cancellation context by caller", async () => {
        const requestMock = vi.fn(() => Promise.resolve({
            entries: [],
            generation: 1,
            matches: [],
            operationId: "operation_1",
            stats: nativeStats(),
            status: "ready",
        }));
        const gateway = gatewayWith(requestMock);

        await gateway.searchProjectEntries({
            limit: 20,
            projectId: "project-1",
            query: "main",
            rootPath: "/tmp/project",
            searchContext: "quick-open",
            worktreeId: "worktree-1",
        });

        expect(requestMock).toHaveBeenCalledWith(
            "project_search_entries",
            expect.objectContaining({
                contextKey: "project-1:worktree-1:quick-open",
            }),
        );
    });
});

function gatewayWith(
    requestMock: (command: string, args?: Record<string, unknown>) => Promise<unknown>,
): NativeSearchGateway {
    const request: NativeBackendRequester["request"] = async (...args) =>
        (await requestMock(...args)) as never;
    return new NativeSearchGateway({ request });
}

function nativeEntry(relativePath: string) {
    const name = relativePath.split("/").at(-1) ?? relativePath;
    return {
        extension: name.includes(".") ? name.split(".").at(-1) : null,
        gitStatus: null,
        hasChildren: false,
        id: `project-1:${relativePath}`,
        isGitIgnored: false,
        kind: "file",
        name,
        parentRelativePath: "src",
        policyState: "indexed",
        projectId: "project-1",
        relativePath,
        worktreeId: "project-1:primary",
    };
}

function nativeStats() {
    return {
        durationMs: 1,
        entryCount: 1,
        indexedDirectoryCount: 0,
        indexedFileCount: 1,
        reason: null,
        skippedCount: 0,
        truncated: false,
    };
}
