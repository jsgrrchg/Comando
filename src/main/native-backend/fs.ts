import type {
    ProjectEntryMutationResult,
    ProjectFileDocument,
    ProjectTreeNode,
} from "@shared/ipc";
import {
    nativeFsMutationToIpc,
    nativeFsMutationsToIpc,
    nativeFsReadFileToIpc,
    nativeProjectTreeEntriesToIpc,
    type NativeFsEntryMutationListResult,
    type NativeFsEntryMutationResult,
    type NativeFsReadFileResult,
    type NativeFsWriteFileResult,
    type NativeProjectListEntriesResult,
    type NativeProjectTreeChildrenResult,
} from "@shared/native-backend";

import type {
    ProjectRuntimeCopyEntriesInput,
    ProjectRuntimeCopyExternalEntriesInput,
    ProjectRuntimeCreateEntryInput,
    ProjectRuntimeDeleteEntryInput,
    ProjectRuntimeEntryMutationInput,
    ProjectRuntimeListEntriesInput,
    ProjectRuntimeOpenFileInput,
    ProjectRuntimeRenameEntryInput,
    ProjectRuntimeSaveFileInput,
    ProjectRuntimeTreeInput,
} from "../projects/runtime";
import { ProjectFileConflictError } from "../projects/tree";
import type { NativeBackendRequester } from "./persistence";

export const NATIVE_FS_ENABLED_ENV = "COMANDO_NATIVE_FS";
export const NATIVE_FS_MODE_ENV = "COMANDO_NATIVE_FS_MODE";
export const NATIVE_PROJECT_TREE_ENABLED_ENV = "COMANDO_NATIVE_PROJECT_TREE";
export const NATIVE_WATCHERS_ENABLED_ENV = "COMANDO_NATIVE_WATCHERS";

export type NativeFsMode = "read" | "shadow" | "write";

export class NativeFsGateway {
    readonly #client: NativeBackendRequester;

    constructor(client: NativeBackendRequester) {
        this.#client = client;
    }

    async listProjectTreeChildren(
        input: ProjectRuntimeTreeInput,
    ): Promise<ProjectTreeNode[]> {
        const result = parseNativeProjectTreeChildrenResult(
            await this.#client.request("project_list_tree_children", {
                parentRelativePath: input.parentRelativePath,
                projectId: input.projectId,
                worktreeId: input.worktreeId ?? null,
            }),
        );
        return nativeProjectTreeEntriesToIpc(result.entries);
    }

    async listProjectEntries(
        input: ProjectRuntimeListEntriesInput,
    ): Promise<ProjectTreeNode[]> {
        const result = parseNativeProjectListEntriesResult(
            await this.#client.request("project_list_entries", {
                projectId: input.projectId,
                worktreeId: input.worktreeId ?? null,
            }),
        );
        return nativeProjectTreeEntriesToIpc(result.entries);
    }

    async openProjectFile(
        input: ProjectRuntimeOpenFileInput,
    ): Promise<ProjectFileDocument> {
        const result = parseNativeFsReadFileResult(
            await this.#client.request("fs_read_file", {
                projectId: input.projectId,
                relativePath: input.relativePath,
                worktreeId: input.worktreeId ?? null,
            }),
        );
        return nativeFsReadFileToIpc(result);
    }

    async saveProjectFile(
        input: ProjectRuntimeSaveFileInput,
    ): Promise<ProjectFileDocument> {
        const result = parseNativeFsWriteFileResult(
            await this.#client.request("fs_write_file", {
                content: input.content,
                expectedContentHash: null,
                expectedModifiedAtMs: input.expectedModifiedAtMs ?? null,
                origin: "user",
                projectId: input.projectId,
                relativePath: input.relativePath,
                worktreeId: input.worktreeId ?? null,
            }),
        );

        if (result.conflict) {
            throw new ProjectFileConflictError(input.relativePath);
        }

        if (result.file) {
            return nativeFsReadFileToIpc(result.file);
        }

        return await this.openProjectFile(input);
    }

    async createProjectEntry(
        input: ProjectRuntimeCreateEntryInput,
    ): Promise<ProjectEntryMutationResult> {
        const command =
            input.kind === "directory" ? "fs_create_directory" : "fs_create_file";
        const result = parseNativeFsEntryMutationResult(
            await this.#client.request(command, {
                kind: input.kind,
                name: input.name,
                origin: "user",
                parentRelativePath: input.parentRelativePath,
                projectId: input.projectId,
                worktreeId: input.worktreeId ?? null,
            }),
        );
        return nativeFsMutationToIpc(result);
    }

    async copyProjectEntries(
        input: ProjectRuntimeCopyEntriesInput,
    ): Promise<ProjectEntryMutationResult[]> {
        const result = parseNativeFsEntryMutationListResult(
            await this.#client.request("fs_copy_entries", {
                destinationParentRelativePath: input.destinationParentRelativePath,
                origin: "user",
                projectId: input.projectId,
                sourceRelativePaths: [...input.sourceRelativePaths],
                worktreeId: input.worktreeId ?? null,
            }),
        );
        return nativeFsMutationsToIpc(result.entries);
    }

    async copyExternalProjectEntries(
        input: ProjectRuntimeCopyExternalEntriesInput,
    ): Promise<ProjectEntryMutationResult[]> {
        const result = parseNativeFsEntryMutationListResult(
            await this.#client.request("fs_copy_external_entries", {
                destinationParentRelativePath: input.destinationParentRelativePath,
                origin: "user",
                projectId: input.projectId,
                sourcePaths: [...input.sourcePaths],
                worktreeId: input.worktreeId ?? null,
            }),
        );
        return nativeFsMutationsToIpc(result.entries);
    }

    async renameProjectEntry(
        input: ProjectRuntimeRenameEntryInput,
    ): Promise<ProjectEntryMutationResult> {
        const result = parseNativeFsEntryMutationResult(
            await this.#client.request("fs_rename_entry", {
                nextName: input.nextName,
                nextParentRelativePath: input.nextParentRelativePath ?? null,
                origin: "user",
                projectId: input.projectId,
                relativePath: input.relativePath,
                worktreeId: input.worktreeId ?? null,
            }),
        );
        return nativeFsMutationToIpc(result);
    }

    async deleteProjectEntry(input: ProjectRuntimeDeleteEntryInput): Promise<void> {
        await this.#client.request("fs_delete_entry", {
            origin: "user",
            projectId: input.projectId,
            relativePath: input.relativePath,
            worktreeId: input.worktreeId ?? null,
        });
    }

    async recordProjectEntryMutation(
        input: ProjectRuntimeEntryMutationInput,
    ): Promise<void> {
        await this.#client.request("fs_record_external_mutation", {
            origin: "user",
            projectId: input.projectId,
            relativePaths: [...input.relativePaths],
            worktreeId: input.worktreeId ?? null,
        });
    }

    async watchStart(projectId: string, worktreeId: string | null): Promise<void> {
        await this.#client.request("fs_watch_start", {
            projectId,
            worktreeId,
        });
    }

    async watchStop(projectId: string, worktreeId: string | null): Promise<void> {
        await this.#client.request("fs_watch_stop", {
            projectId,
            worktreeId,
        });
    }

    async watchSyncRegistry(): Promise<void> {
        await this.#client.request("fs_watch_sync_registry");
    }
}

export function resolveNativeFsMode(
    env: NodeJS.ProcessEnv = process.env,
): NativeFsMode | null {
    if (env[NATIVE_FS_ENABLED_ENV] !== "1") {
        return null;
    }

    const mode = env[NATIVE_FS_MODE_ENV];
    if (mode === "read" || mode === "write") {
        return mode;
    }

    return "shadow";
}

export function shouldUseNativeFsReads(
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    const mode = resolveNativeFsMode(env);
    return mode === "read" || mode === "write";
}

export function shouldUseNativeFsWrites(
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    return resolveNativeFsMode(env) === "write";
}

export function shouldUseNativeProjectTree(
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    return (
        shouldUseNativeFsReads(env) &&
        env[NATIVE_PROJECT_TREE_ENABLED_ENV] === "1"
    );
}

export function shouldUseNativeWatchers(
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    return (
        shouldUseNativeFsReads(env) && env[NATIVE_WATCHERS_ENABLED_ENV] === "1"
    );
}

function parseNativeProjectTreeChildrenResult(
    value: unknown,
): NativeProjectTreeChildrenResult {
    const record = requireRecord(value, "Native project tree children result");
    requireArray(record.entries, "entries");
    return record as unknown as NativeProjectTreeChildrenResult;
}

function parseNativeProjectListEntriesResult(
    value: unknown,
): NativeProjectListEntriesResult {
    const record = requireRecord(value, "Native project entries result");
    requireArray(record.entries, "entries");
    requireBoolean(record.truncated, "truncated");
    return record as unknown as NativeProjectListEntriesResult;
}

function parseNativeFsReadFileResult(value: unknown): NativeFsReadFileResult {
    const record = requireRecord(value, "Native read file result");
    requireString(record.path, "path");
    requireString(record.relativePath, "relativePath");
    requireNumber(record.sizeBytes, "sizeBytes");
    requireNumber(record.mtimeMs, "mtimeMs");
    requireBoolean(record.isBinary, "isBinary");
    requireBoolean(record.isTooLarge, "isTooLarge");
    return record as unknown as NativeFsReadFileResult;
}

function parseNativeFsWriteFileResult(value: unknown): NativeFsWriteFileResult {
    const record = requireRecord(value, "Native write file result");
    requireRecord(record.entry, "entry");
    if (record.file !== undefined && record.file !== null) {
        parseNativeFsReadFileResult(record.file);
    }
    return record as unknown as NativeFsWriteFileResult;
}

function parseNativeFsEntryMutationResult(
    value: unknown,
): NativeFsEntryMutationResult {
    const record = requireRecord(value, "Native mutation result");
    requireString(record.kind, "kind");
    requireString(record.name, "name");
    requireString(record.relativePath, "relativePath");
    return record as unknown as NativeFsEntryMutationResult;
}

function parseNativeFsEntryMutationListResult(
    value: unknown,
): NativeFsEntryMutationListResult {
    const record = requireRecord(value, "Native mutation list result");
    requireArray(record.entries, "entries");
    return record as unknown as NativeFsEntryMutationListResult;
}

function requireRecord(
    value: unknown,
    label: string,
): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${label} must be an object.`);
    }
    return value as Record<string, unknown>;
}

function requireArray(value: unknown, fieldName: string): readonly unknown[] {
    if (!Array.isArray(value)) {
        throw new Error(`Native filesystem field ${fieldName} must be an array.`);
    }
    return value;
}

function requireBoolean(value: unknown, fieldName: string): boolean {
    if (typeof value !== "boolean") {
        throw new Error(`Native filesystem field ${fieldName} must be a boolean.`);
    }
    return value;
}

function requireNumber(value: unknown, fieldName: string): number {
    if (typeof value !== "number") {
        throw new Error(`Native filesystem field ${fieldName} must be a number.`);
    }
    return value;
}

function requireString(value: unknown, fieldName: string): string {
    if (typeof value !== "string") {
        throw new Error(`Native filesystem field ${fieldName} must be a string.`);
    }
    return value;
}
