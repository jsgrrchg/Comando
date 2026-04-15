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
    readonly parentRelativePath?: string | null;
    readonly projectId: string | null;
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

    for (let index = 1; index <= 100; index += 1) {
        const fileName = index === 1 ? "untitled.txt" : `untitled-${index}.txt`;

        try {
            const entry = await options.createEntry(
                options.projectId,
                options.parentRelativePath ?? null,
                fileName,
                "file",
                options.worktreeId,
            );
            options.setLastQuickCreateAction("file");
            await options.openFileTab(
                options.projectId,
                entry.relativePath,
                options.worktreeId,
            );
            return;
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : "Could not create the file.";

            if (isDuplicateEntryMessage(message)) {
                continue;
            }

            options.reportError(message);
            return;
        }
    }

    options.reportError("Could not create a unique untitled file.");
}

export async function createWorkspaceQuickDirectory(
    options: Omit<
        CreateWorkspaceFileOptions,
        "openFileTab" | "setLastQuickCreateAction"
    >,
): Promise<ProjectEntryMutationResult | null> {
    if (!options.projectId) {
        return null;
    }

    for (let index = 1; index <= 100; index += 1) {
        const directoryName =
            index === 1 ? "new-folder" : `new-folder-${index}`;

        try {
            return await options.createEntry(
                options.projectId,
                options.parentRelativePath ?? null,
                directoryName,
                "directory",
                options.worktreeId,
            );
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : "Could not create the folder.";

            if (isDuplicateEntryMessage(message)) {
                continue;
            }

            options.reportError(message);
            return null;
        }
    }

    options.reportError("Could not create a unique untitled folder.");
    return null;
}

function isDuplicateEntryMessage(message: string): boolean {
    return /same name already exists/i.test(message);
}
