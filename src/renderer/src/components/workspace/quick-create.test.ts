import { describe, expect, it, vi } from "vitest";

import { createWorkspaceQuickFile } from "./quick-create";

describe("createWorkspaceQuickFile", () => {
    it("abre el archivo creado en la raiz del proyecto", async () => {
        const createEntry = vi.fn(async () => ({
            kind: "file" as const,
            name: "notes.md",
            parentRelativePath: null,
            relativePath: "notes.md",
        }));
        const openFileTab = vi.fn(async () => {});
        const promptForName = vi.fn(() => "notes.md");
        const reportError = vi.fn();
        const setLastQuickCreateAction = vi.fn();

        await createWorkspaceQuickFile({
            createEntry,
            openFileTab,
            projectId: "project-1",
            promptForName,
            reportError,
            setLastQuickCreateAction,
            worktreeId: null,
        });

        expect(promptForName).toHaveBeenCalledWith(
            "New file name",
            "untitled.txt",
        );
        expect(createEntry).toHaveBeenCalledWith(
            "project-1",
            null,
            "notes.md",
            "file",
            null,
        );
        expect(setLastQuickCreateAction).toHaveBeenCalledWith("file");
        expect(openFileTab).toHaveBeenCalledWith(
            "project-1",
            "notes.md",
            null,
        );
        expect(reportError).not.toHaveBeenCalled();
    });

    it("reporta el error cuando la creacion falla", async () => {
        const createEntry = vi.fn(async () => {
            throw new Error("An entry with the same name already exists.");
        });
        const openFileTab = vi.fn(async () => {});
        const promptForName = vi.fn(() => "notes.md");
        const reportError = vi.fn();
        const setLastQuickCreateAction = vi.fn();

        await createWorkspaceQuickFile({
            createEntry,
            openFileTab,
            projectId: "project-1",
            promptForName,
            reportError,
            setLastQuickCreateAction,
            worktreeId: null,
        });

        expect(reportError).toHaveBeenCalledWith(
            "An entry with the same name already exists.",
        );
        expect(openFileTab).not.toHaveBeenCalled();
        expect(setLastQuickCreateAction).not.toHaveBeenCalled();
    });
});
