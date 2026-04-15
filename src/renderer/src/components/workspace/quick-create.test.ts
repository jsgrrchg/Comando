import { describe, expect, it, vi } from "vitest";

import { createWorkspaceQuickFile } from "./quick-create";

describe("createWorkspaceQuickFile", () => {
    it("crea y abre un archivo untitled en la raiz del proyecto", async () => {
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

    it("usa el siguiente nombre disponible cuando untitled ya existe", async () => {
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
            openFileTab,
            projectId: "project-1",
            reportError,
            setLastQuickCreateAction,
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

    it("reporta el error cuando la creacion falla por otra razon", async () => {
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
