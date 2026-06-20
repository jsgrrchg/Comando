import type {
    NativeOperationId,
    NativeProjectId,
    NativeRelativePath,
    NativeWorktreeId,
} from "./ids";
import type { NativeProjectTreeEntry } from "./projects";

export type NativeIndexStatus =
    | "idle"
    | "building"
    | "ready"
    | "stale"
    | "error";

export type NativeIndexPolicyState =
    | "indexed"
    | "excluded_by_policy"
    | "noisy"
    | "special"
    | "too_large"
    | "permission_denied"
    | "unsupported";

export type NativeIndexScope = {
    readonly projectId: NativeProjectId;
    readonly worktreeId: NativeWorktreeId | null;
};

export type NativeIndexPolicy = {
    readonly includeDotfiles: boolean;
    readonly includeHidden: boolean;
    readonly followSymlinks: boolean;
    readonly maxEntries: number;
    readonly maxDepth: number | null;
};

export type NativeIndexStats = {
    readonly entryCount: number;
    readonly indexedFileCount: number;
    readonly indexedDirectoryCount: number;
    readonly skippedCount: number;
    readonly durationMs: number;
    readonly truncated: boolean;
    readonly reason: string | null;
};

export type NativeIndexStatusResult = {
    readonly projectId: NativeProjectId;
    readonly worktreeId: NativeWorktreeId | null;
    readonly generation: number;
    readonly status: NativeIndexStatus;
    readonly stats: NativeIndexStats;
    readonly operationId: NativeOperationId | null;
    readonly occurredAt: string;
};

export type NativeIndexEventPayload = NativeIndexStatusResult;

export type NativeIndexedProjectEntry = Omit<
    NativeProjectTreeEntry,
    "absolutePath" | "visibility" | "relativePath" | "parentRelativePath"
> & {
    readonly relativePath: NativeRelativePath;
    readonly parentRelativePath: NativeRelativePath | null;
    readonly policyState: NativeIndexPolicyState;
};

export type NativeIndexRebuildProjectInput = {
    readonly projectId: NativeProjectId;
    readonly worktreeId: NativeWorktreeId | null;
    readonly policy?: NativeIndexPolicy | null;
};

export type NativeIndexRebuildProjectResult = {
    readonly status: NativeIndexStatusResult;
    readonly entries: readonly NativeIndexedProjectEntry[];
};

export type NativeIndexUpdateKind =
    | "created"
    | "updated"
    | "deleted"
    | "renamed"
    | "invalidated";

export type NativeIndexUpdateEntriesInput = {
    readonly projectId: NativeProjectId;
    readonly worktreeId: NativeWorktreeId | null;
    readonly kind: NativeIndexUpdateKind;
    readonly relativePaths: readonly NativeRelativePath[] | null;
};

export type NativeIndexUpdateEntriesResult = {
    readonly status: NativeIndexStatusResult;
};

export type NativeIndexStatusInput = NativeIndexScope;

export type NativeIndexDropProjectInput = NativeIndexScope;

export type NativeIndexDropProjectResult = {
    readonly dropped: boolean;
};

export type NativeProjectEntrySearchInput = {
    readonly projectId: NativeProjectId;
    readonly worktreeId: NativeWorktreeId | null;
    readonly query: string;
    readonly includeAncestorDirectories: boolean;
    readonly limit: number;
    readonly contextKey?: string | null;
};

export type NativePathSearchMatch = {
    readonly entry: NativeIndexedProjectEntry;
    readonly score: number;
};

export type NativeProjectEntrySearchResult = {
    readonly operationId: NativeOperationId;
    readonly generation: number;
    readonly status: NativeIndexStatus;
    readonly entries: readonly NativeIndexedProjectEntry[];
    readonly matches: readonly NativePathSearchMatch[];
    readonly stats: NativeIndexStats;
};

export type NativeContentSearchInput = {
    readonly projectId: NativeProjectId;
    readonly worktreeId: NativeWorktreeId | null;
    readonly query: string;
    readonly limit: number;
};

export type NativeContentSearchResult = {
    readonly operationId: NativeOperationId;
    readonly matches: readonly NativeContentSearchMatch[];
    readonly truncated: boolean;
};

export type NativeContentSearchMatch = {
    readonly relativePath: NativeRelativePath;
    readonly lineNumber: number;
    readonly lineText: string;
};

export type NativeSearchCancelInput = {
    readonly operationId: NativeOperationId;
};

export type NativeSearchCancelled = {
    readonly operationId: NativeOperationId;
    readonly cancelled: boolean;
    readonly cancelledAt: string;
};
