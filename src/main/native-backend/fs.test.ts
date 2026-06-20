import { describe, expect, it, vi } from "vitest";

import {
    NATIVE_FS_ENABLED_ENV,
    NATIVE_FS_MODE_ENV,
    NATIVE_PROJECT_TREE_ENABLED_ENV,
    NativeFsGateway,
    resolveNativeFsMode,
    shouldUseNativeFsReads,
    shouldUseNativeFsWrites,
    shouldUseNativeProjectTree,
} from "./fs";
import type { NativeBackendRequester } from "./persistence";

describe("native filesystem flags", () => {
    it("defaults off and defaults enabled mode to shadow", () => {
        expect(resolveNativeFsMode({})).toBeNull();
        expect(
            resolveNativeFsMode({
                [NATIVE_FS_ENABLED_ENV]: "1",
            }),
        ).toBe("shadow");
        expect(
            resolveNativeFsMode({
                [NATIVE_FS_ENABLED_ENV]: "1",
                [NATIVE_FS_MODE_ENV]: "read",
            }),
        ).toBe("read");
        expect(
            resolveNativeFsMode({
                [NATIVE_FS_ENABLED_ENV]: "1",
                [NATIVE_FS_MODE_ENV]: "write",
            }),
        ).toBe("write");
    });

    it("routes reads, writes, and tree only in explicit modes", () => {
        expect(shouldUseNativeFsReads({})).toBe(false);
        expect(
            shouldUseNativeFsReads({
                [NATIVE_FS_ENABLED_ENV]: "1",
                [NATIVE_FS_MODE_ENV]: "read",
            }),
        ).toBe(true);
        expect(
            shouldUseNativeFsWrites({
                [NATIVE_FS_ENABLED_ENV]: "1",
                [NATIVE_FS_MODE_ENV]: "read",
            }),
        ).toBe(false);
        expect(
            shouldUseNativeFsWrites({
                [NATIVE_FS_ENABLED_ENV]: "1",
                [NATIVE_FS_MODE_ENV]: "write",
            }),
        ).toBe(true);
        expect(
            shouldUseNativeProjectTree({
                [NATIVE_FS_ENABLED_ENV]: "1",
                [NATIVE_FS_MODE_ENV]: "read",
            }),
        ).toBe(false);
        expect(
            shouldUseNativeProjectTree({
                [NATIVE_FS_ENABLED_ENV]: "1",
                [NATIVE_FS_MODE_ENV]: "read",
                [NATIVE_PROJECT_TREE_ENABLED_ENV]: "1",
            }),
        ).toBe(true);
    });
});

describe("NativeFsGateway", () => {
    it("adapts native tree and file reads to project IPC models", async () => {
        const requestMock = vi.fn(async (command: string) => {
            if (command === "project_list_tree_children") {
                return {
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
                };
            }

            return {
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
            };
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
        const requestMock = vi.fn(async () => ({
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
