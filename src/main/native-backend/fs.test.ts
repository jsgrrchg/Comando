import { describe, expect, it, vi } from "vitest";

import { NativeFsGateway } from "./fs";
import type { NativeBackendRequester } from "./persistence";

describe("NativeFsGateway", () => {
    it("adapts native tree and file reads to project IPC models", async () => {
        const requestMock = vi.fn((command: string) => {
            if (command === "project_list_tree_children") {
                return Promise.resolve({
                    entries: [
                        {
                            extension: "ts",
                            gitStatus: null,
                            hasChildren: false,
                            id: "project-1:src/main.ts",
                            isGitIgnored: false,
                            kind: "file",
                            name: "main.ts",
                            parentRelativePath: "src",
                            projectId: "project-1",
                            relativePath: "src/main.ts",
                            worktreeId: "project-1:primary",
                        },
                    ],
                });
            }

            return Promise.resolve({
                content: "console.log('hi');\n",
                contentHash: "hash",
                encoding: "utf8",
                imageDataBase64: null,
                isBinary: false,
                isTooLarge: false,
                kind: "text",
                lineEnding: "\n",
                mimeType: "text/plain",
                mtimeMs: 100,
                name: "main.ts",
                path: "/tmp/project/src/main.ts",
                projectId: "project-1",
                relativePath: "src/main.ts",
                sizeBytes: 19,
                worktreeId: "project-1:primary",
            });
        });
        const gateway = gatewayWith(requestMock);

        await expect(
            gateway.listProjectTreeChildren({
                parentRelativePath: null,
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
            gateway.openProjectFile({
                projectId: "project-1",
                relativePath: "src/main.ts",
                rootPath: "/tmp/project",
                worktreeId: null,
            }),
        ).resolves.toEqual(
            expect.objectContaining({
                content: "console.log('hi');\n",
                kind: "text",
                languageId: "typescript",
            }),
        );
    });

    it("throws the legacy conflict error shape for stale native writes", async () => {
        const requestMock = vi.fn(() => Promise.resolve({
            conflict: {
                currentContentHash: "next",
                externalMtimeMs: 200,
                reason: "modified_time_mismatch",
            },
            entry: nativeEntry(),
        }));
        const gateway = gatewayWith(requestMock);

        await expect(
            gateway.saveProjectFile({
                content: "next",
                expectedModifiedAtMs: 100,
                projectId: "project-1",
                relativePath: "src/main.ts",
                rootPath: "/tmp/project",
                worktreeId: null,
            }),
        ).rejects.toMatchObject({
            name: "ProjectFileConflictError",
        });
    });

    it("rejects truncated native project entry listings", async () => {
        const requestMock = vi.fn(() => Promise.resolve({
            entries: [],
            truncated: true,
        }));
        const gateway = gatewayWith(requestMock);

        await expect(
            gateway.listProjectEntries({
                projectId: "project-1",
                rootPath: "/tmp/project",
                worktreeId: null,
            }),
        ).rejects.toThrow("Native project entry listing was truncated");
    });
});

function gatewayWith(
    requestMock: (command: string, args?: Record<string, unknown>) => Promise<unknown>,
): NativeFsGateway {
    const request: NativeBackendRequester["request"] = async (...args) =>
        (await requestMock(...args)) as never;
    return new NativeFsGateway({ request });
}

function nativeEntry() {
    return {
        contentHash: null,
        isBinary: false,
        isDirectory: false,
        isSymlink: false,
        isTooLarge: false,
        kind: "file",
        mtimeMs: 100,
        path: "/tmp/project/src/main.ts",
        projectId: "project-1",
        relativePath: "src/main.ts",
        sizeBytes: 10,
        status: "clean",
        worktreeId: "project-1:primary",
    };
}
