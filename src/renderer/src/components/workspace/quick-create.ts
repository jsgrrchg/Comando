import type { ProjectEntryKind, ProjectEntryMutationResult } from "@shared/ipc";
import type { WorkspaceQuickCreateAction } from "@renderer/app/store/workspace-store";

interface CreateWorkspaceFileOptions {
    readonly createEntry: (
        projectId: string,
        parentRelativePath: string | null,
        name: string,
        kind: ProjectEntryKind,
        worktreeId?: string | null,
    ) => Promise<ProjectEntryMutationResult>;
    readonly openFileTab: (
        projectId: string,
        relativePath: string,
        worktreeId?: string | null,
    ) => Promise<void>;
    readonly projectId: string | null;
    readonly promptForName: (
        message?: string,
        defaultValue?: string,
    ) => string | null;
    readonly reportError: (message: string) => void;
    readonly setLastQuickCreateAction: (
        action: WorkspaceQuickCreateAction,
    ) => void;
    readonly worktreeId: string | null;
}

export async function createWorkspaceQuickFile(
    options: CreateWorkspaceFileOptions,
): Promise<void> {
    if (!options.projectId) {
        return;
    }

    const name = options.promptForName("New file name", "untitled.txt");
    if (name === null) {
        return;
    }

    const trimmedName = name.trim();
    if (!trimmedName) {
        return;
    }

    try {
        const entry = await options.createEntry(
            options.projectId,
            null,
            trimmedName,
            "file",
            options.worktreeId,
        );
        options.setLastQuickCreateAction("file");
        await options.openFileTab(
            options.projectId,
            entry.relativePath,
            options.worktreeId,
        );
    } catch (error) {
        options.reportError(
            error instanceof Error
                ? error.message
                : "Could not create the file.",
        );
    }
}
