import type { NativeProjectId, NativeRelativePath, NativeWorktreeId } from "./ids";

export type NativeIndexStatus = "building" | "error" | "idle" | "ready";

export type NativeIndexScope = {
    readonly projectId: NativeProjectId;
    readonly worktreeId: NativeWorktreeId | null;
    readonly includeIgnored: boolean;
    readonly includeHidden: boolean;
};

export type NativeSearchLimits = {
    readonly limit: number;
    readonly maxMatchCount: number | null;
};

export type NativeSearchQuery = {
    readonly query: string;
    readonly projectId: NativeProjectId;
    readonly worktreeId: NativeWorktreeId | null;
    readonly includeIgnored: boolean;
    readonly includeHidden: boolean;
    readonly caseSensitive: boolean;
    readonly limits: NativeSearchLimits;
};

export type NativePathSearchResult = {
    readonly relativePath: NativeRelativePath;
    readonly rank: number;
    readonly matches: readonly string[];
};

export type NativeContentSearchResult = NativePathSearchResult;

export type NativeSearchResult = {
    readonly paths: readonly NativePathSearchResult[];
    readonly content: readonly NativeContentSearchResult[];
};

export type NativeSearchCancelled = {
    readonly operationId: string;
    readonly cancelledAt: string;
};
