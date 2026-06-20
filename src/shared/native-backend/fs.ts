import type { NativeProjectId, NativeRelativePath, NativeWorktreeId } from "./ids";

export type NativeFsEntryKind = "directory" | "file" | "other" | "symlink";
export type NativeFsEntryStatus =
    | "clean"
    | "conflicted"
    | "created"
    | "deleted"
    | "ignored"
    | "modified"
    | "renamed"
    | "unknown";
export type NativeFsMutationOrigin = "agent" | "external" | "system" | "user";

export type NativeFsEntry = {
    readonly path: string;
    readonly relativePath: NativeRelativePath;
    readonly projectId: NativeProjectId;
    readonly worktreeId: NativeWorktreeId | null;
    readonly kind: NativeFsEntryKind;
    readonly isDirectory: boolean;
    readonly isSymlink: boolean;
    readonly isBinary: boolean;
    readonly isTooLarge: boolean;
    readonly sizeBytes: number | null;
    readonly mtimeMs: number | null;
    readonly contentHash: string | null;
    readonly status: NativeFsEntryStatus;
};

export type NativeFsReadFileInput = {
    readonly projectId: NativeProjectId;
    readonly worktreeId: NativeWorktreeId | null;
    readonly relativePath: NativeRelativePath;
};

export type NativeFsReadFileResult = {
    readonly projectId: NativeProjectId;
    readonly worktreeId: NativeWorktreeId | null;
    readonly path: string;
    readonly relativePath: NativeRelativePath;
    readonly content: string | null;
    readonly encoding: string | null;
    readonly lineEnding: string | null;
    readonly contentHash: string | null;
    readonly sizeBytes: number;
    readonly mtimeMs: number;
    readonly isBinary: boolean;
    readonly isTooLarge: boolean;
};

export type NativeFsWriteFileInput = {
    readonly projectId: NativeProjectId;
    readonly worktreeId: NativeWorktreeId | null;
    readonly relativePath: NativeRelativePath;
    readonly content: string;
    readonly expectedContentHash: string | null;
    readonly origin: NativeFsMutationOrigin;
};

export type NativeFsConflict = {
    readonly reason: string;
    readonly currentContentHash: string | null;
    readonly externalMtimeMs: number | null;
};

export type NativeFsWriteFileResult = {
    readonly entry: NativeFsEntry;
    readonly conflict: NativeFsConflict | null;
};

export type NativeOpenBufferState = {
    readonly path: string;
    readonly relativePath: NativeRelativePath;
    readonly projectId: NativeProjectId;
    readonly worktreeId: NativeWorktreeId | null;
    readonly contentHash: string | null;
    readonly isDirty: boolean;
};

export type NativePathPolicy = {
    readonly path: string;
    readonly visible: boolean;
    readonly aiAccess: boolean;
    readonly reason: string | null;
};
