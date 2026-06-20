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
export type NativeFsVisibilityPolicy =
    | "hidden_by_policy"
    | "noisy"
    | "permission_denied"
    | "special"
    | "too_large_to_expand"
    | "visible";

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
    readonly visibility?: NativeFsVisibilityPolicy | null;
};

export type NativeFsReadFileInput = {
    readonly projectId: NativeProjectId;
    readonly worktreeId: NativeWorktreeId | null;
    readonly relativePath: NativeRelativePath;
    readonly maxBytes?: number | null;
};

export type NativeFsReadFileResult = {
    readonly projectId: NativeProjectId;
    readonly worktreeId: NativeWorktreeId | null;
    readonly path: string;
    readonly relativePath: NativeRelativePath;
    readonly name?: string | null;
    readonly content: string | null;
    readonly encoding: string | null;
    readonly lineEnding: string | null;
    readonly contentHash: string | null;
    readonly sizeBytes: number;
    readonly mtimeMs: number;
    readonly mimeType?: string | null;
    readonly kind?: "binary" | "image" | "text" | string | null;
    readonly imageDataBase64?: string | null;
    readonly isBinary: boolean;
    readonly isTooLarge: boolean;
};

export type NativeFsWriteFileInput = {
    readonly projectId: NativeProjectId;
    readonly worktreeId: NativeWorktreeId | null;
    readonly relativePath: NativeRelativePath;
    readonly content: string;
    readonly expectedContentHash: string | null;
    readonly expectedModifiedAtMs?: number | null;
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
    readonly file?: NativeFsReadFileResult | null;
};

export type NativeFsCreateEntryInput = {
    readonly projectId: NativeProjectId;
    readonly worktreeId: NativeWorktreeId | null;
    readonly parentRelativePath: NativeRelativePath | null;
    readonly name: string;
    readonly kind: NativeFsEntryKind;
    readonly origin: NativeFsMutationOrigin;
};

export type NativeFsRenameEntryInput = {
    readonly projectId: NativeProjectId;
    readonly worktreeId: NativeWorktreeId | null;
    readonly relativePath: NativeRelativePath;
    readonly nextName: string;
    readonly nextParentRelativePath?: NativeRelativePath | null;
    readonly origin: NativeFsMutationOrigin;
};

export type NativeFsDeleteEntryInput = {
    readonly projectId: NativeProjectId;
    readonly worktreeId: NativeWorktreeId | null;
    readonly relativePath: NativeRelativePath;
    readonly origin: NativeFsMutationOrigin;
};

export type NativeFsCopyEntriesInput = {
    readonly projectId: NativeProjectId;
    readonly worktreeId: NativeWorktreeId | null;
    readonly sourceRelativePaths: readonly NativeRelativePath[];
    readonly destinationParentRelativePath: NativeRelativePath | null;
    readonly origin: NativeFsMutationOrigin;
};

export type NativeFsCopyExternalEntriesInput = {
    readonly projectId: NativeProjectId;
    readonly worktreeId: NativeWorktreeId | null;
    readonly sourcePaths: readonly string[];
    readonly destinationParentRelativePath: NativeRelativePath | null;
    readonly origin: NativeFsMutationOrigin;
};

export type NativeFsEntryMutationResult = {
    readonly kind: NativeFsEntryKind;
    readonly name: string;
    readonly parentRelativePath: NativeRelativePath | null;
    readonly relativePath: NativeRelativePath;
    readonly entry?: NativeFsEntry | null;
};

export type NativeFsEntryMutationListResult = {
    readonly entries: readonly NativeFsEntryMutationResult[];
};

export type NativeFsRecordExternalMutationInput = {
    readonly projectId: NativeProjectId;
    readonly worktreeId: NativeWorktreeId | null;
    readonly relativePaths: readonly NativeRelativePath[];
    readonly origin: NativeFsMutationOrigin;
};

export type NativeFsRevealEntryInfoInput = {
    readonly projectId: NativeProjectId;
    readonly worktreeId: NativeWorktreeId | null;
    readonly relativePath: NativeRelativePath | null;
};

export type NativeFsRevealEntryInfoResult = {
    readonly projectId: NativeProjectId;
    readonly worktreeId: NativeWorktreeId | null;
    readonly path: string;
    readonly relativePath: NativeRelativePath | null;
    readonly exists: boolean;
    readonly kind: NativeFsEntryKind;
};

export type NativeFsWatchInput = {
    readonly projectId: NativeProjectId;
    readonly worktreeId: NativeWorktreeId | null;
};

export type NativeProjectTreeInvalidation = {
    readonly projectId: NativeProjectId;
    readonly worktreeId: NativeWorktreeId | null;
    readonly relativePaths: readonly NativeRelativePath[] | null;
    readonly occurredAt: string;
};

export type NativeFsWatchEvent = {
    readonly projectId: NativeProjectId;
    readonly worktreeId: NativeWorktreeId | null;
    readonly relativePath: NativeRelativePath | null;
    readonly kind: string;
    readonly origin: NativeFsMutationOrigin;
    readonly occurredAt: string;
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
