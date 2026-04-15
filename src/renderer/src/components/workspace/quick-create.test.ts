import { describe, expect, it, vi } from "vitest";

import {
    createWorkspaceQuickDirectory,
    createWorkspaceQuickFile,
} from "./quick-create";

describe("createWorkspaceQuickFile", () => {
    it("creates and opens an untitled file in the project root", async () => {
        const createEntry = vi.fn(() =>
            Promise.resolve({
                kind: "file" as const,
                name: "untitled.txt",
                parentRelativePath: null,
                relativePath: "untitled.txt",
            }),
        );
        const openFileTab = vi.fn(() => Promise.resolve());
        const reportError = vi.fn();
        const setLastQuickCreateAction = vi.fn();

        await createWorkspaceQuickFile({
            createEntry,
            openFileTab,
            projectId: "project-1",
            reportError,
            setLastQuickCreateAction,
            worktreeId: null,
        });

        expect(createEntry).toHaveBeenCalledWith(
            "project-1",
            null,
            "untitled.txt",
            "file",
            null,
        );
        expect(setLastQuickCreateAction).toHaveBeenCalledWith("file");
        expect(openFileTab).toHaveBeenCalledWith(
            "project-1",
            "untitled.txt",
            null,
        );
        expect(reportError).not.toHaveBeenCalled();
    });

    it("uses the next available untitled name when untitled already exists", async () => {
        const createEntry = vi
            .fn()
            .mockRejectedValueOnce(
                new Error("An entry with the same name already exists."),
            )
            .mockResolvedValueOnce({
                kind: "file" as const,
                name: "untitled-2.txt",
                parentRelativePath: null,
                relativePath: "untitled-2.txt",
            });
        const openFileTab = vi.fn(() => Promise.resolve());
        const reportError = vi.fn();
        const setLastQuickCreateAction = vi.fn();

        await createWorkspaceQuickFile({
            createEntry,
            projectId: "project-1",
            reportError,
            setLastQuickCreateAction,
            openFileTab,
            worktreeId: null,
        });

        expect(createEntry).toHaveBeenNthCalledWith(
            1,
            "project-1",
            null,
            "untitled.txt",
            "file",
            null,
        );
        expect(createEntry).toHaveBeenNthCalledWith(
            2,
            "project-1",
            null,
            "untitled-2.txt",
            "file",
            null,
        );
        expect(openFileTab).toHaveBeenCalledWith(
            "project-1",
            "untitled-2.txt",
            null,
        );
        expect(reportError).not.toHaveBeenCalled();
    });

    it("reports the error when creation fails for another reason", async () => {
        const createEntry = vi.fn(() =>
            Promise.reject(new Error("Permission denied.")),
        );
        const openFileTab = vi.fn(() => Promise.resolve());
        const reportError = vi.fn();
        const setLastQuickCreateAction = vi.fn();

        await createWorkspaceQuickFile({
            createEntry,
            openFileTab,
            projectId: "project-1",
            reportError,
            setLastQuickCreateAction,
            worktreeId: null,
        });

        expect(reportError).toHaveBeenCalledWith("Permission denied.");
        expect(openFileTab).not.toHaveBeenCalled();
        expect(setLastQuickCreateAction).not.toHaveBeenCalled();
    });
});

describe("createWorkspaceQuickDirectory", () => {
    it("creates a default folder and returns the created entry", async () => {
        const createEntry = vi.fn().mockResolvedValue({
            kind: "directory",
            name: "new-folder",
            parentRelativePath: null,
            relativePath: "new-folder",
        });
        const reportError = vi.fn();

        const entry = await createWorkspaceQuickDirectory({
            createEntry,
            parentRelativePath: null,
            projectId: "project-1",
            reportError,
            worktreeId: null,
        });

        expect(entry).toEqual({
            kind: "directory",
            name: "new-folder",
            parentRelativePath: null,
            relativePath: "new-folder",
        });
        expect(createEntry).toHaveBeenCalledWith(
            "project-1",
            null,
            "new-folder",
            "directory",
            null,
        );
        expect(reportError).not.toHaveBeenCalled();
    });

    it("retries with an incremented folder name when the default already exists", async () => {
        const createEntry = vi
            .fn()
            .mockRejectedValueOnce(
                new Error(
                    "An entry with the same name already exists in that location.",
                ),
            )
            .mockResolvedValueOnce({
                kind: "directory",
                name: "new-folder-2",
                parentRelativePath: "src",
                relativePath: "src/new-folder-2",
            });

        const entry = await createWorkspaceQuickDirectory({
            createEntry,
            parentRelativePath: "src",
            projectId: "project-1",
            reportError: vi.fn(),
            worktreeId: "worktree-1",
        });

        expect(createEntry).toHaveBeenNthCalledWith(
            1,
            "project-1",
            "src",
            "new-folder",
            "directory",
            "worktree-1",
        );
        expect(createEntry).toHaveBeenNthCalledWith(
            2,
            "project-1",
            "src",
            "new-folder-2",
            "directory",
            "worktree-1",
        );
        expect(entry?.relativePath).toBe("src/new-folder-2");
    });
});
