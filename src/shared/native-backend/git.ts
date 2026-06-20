import type { NativeProjectId, NativeRepositoryId, NativeWorktreeId } from "./ids";

export type NativeGitRepositoryScope = {
    readonly projectId: NativeProjectId;
    readonly worktreeId: NativeWorktreeId | null;
};

export type NativeGitStatusSummary = {
    readonly changedCount: number;
    readonly stagedCount: number;
    readonly unstagedCount: number;
    readonly untrackedCount: number;
    readonly conflictedCount: number;
};

export type NativeGitChangeEntry = {
    readonly path: string;
    readonly previousPath: string | null;
    readonly scope: string;
    readonly kind: string;
    readonly isBinary: boolean;
    readonly isConflicted: boolean;
    readonly additions: number | null;
    readonly deletions: number | null;
    readonly worktreeId: NativeWorktreeId | null;
};

export type NativeGitBranchSummary = {
    readonly name: string;
    readonly isCurrent: boolean;
    readonly isRemote: boolean;
    readonly isDetached: boolean;
    readonly upstreamName: string | null;
    readonly commitSha: string | null;
};

export type NativeGitRemoteSummary = {
    readonly name: string;
    readonly fetchUrl: string | null;
    readonly pushUrl: string | null;
    readonly isDefault: boolean;
};

export type NativeGitWorktreeSummary = {
    readonly id: NativeWorktreeId;
    readonly projectId: NativeProjectId;
    readonly rootPath: string;
    readonly branchName: string | null;
    readonly commitSha: string | null;
    readonly isPrimary: boolean;
    readonly isCurrent: boolean;
    readonly updatedAt: string;
};

export type NativeGitDiffLine = {
    readonly id: string;
    readonly type: string;
    readonly text: string;
};

export type NativeGitDiffHunk = {
    readonly id: string;
    readonly oldStart: number;
    readonly oldCount: number;
    readonly newStart: number;
    readonly newCount: number;
    readonly lines: readonly NativeGitDiffLine[];
};

export type NativeGitFileDiff = {
    readonly path: string;
    readonly previousPath: string | null;
    readonly kind: string;
    readonly isText: boolean;
    readonly isTooLarge: boolean;
    readonly oldText: string | null;
    readonly newText: string | null;
    readonly hunks: readonly NativeGitDiffHunk[];
};

export type NativeGitDiff = {
    readonly projectId: NativeProjectId;
    readonly worktreeId: NativeWorktreeId | null;
    readonly files: readonly NativeGitFileDiff[];
    readonly updatedAt: string;
};

export type NativeGitCommitSummary = {
    readonly sha: string;
    readonly shortSha: string;
    readonly subject: string;
    readonly authorName: string;
    readonly authoredAt: string;
};

export type NativeGitRepositorySnapshot = {
    readonly repositoryId: NativeRepositoryId;
    readonly projectId: NativeProjectId;
    readonly currentWorktreeId: NativeWorktreeId | null;
    readonly repositoryState: string;
    readonly rootPath: string;
    readonly canonicalRootPath: string;
    readonly branch: NativeGitBranchSummary | null;
    readonly remotes: readonly NativeGitRemoteSummary[];
    readonly changes: readonly NativeGitChangeEntry[];
    readonly status: NativeGitStatusSummary;
    readonly worktrees: readonly NativeGitWorktreeSummary[];
    readonly updatedAt: string;
};

export type NativeGitRepositoryInvalidation = {
    readonly occurredAt: string;
    readonly projectId: NativeProjectId;
    readonly worktreeId: NativeWorktreeId | null;
    readonly rootPath: string | null;
    readonly reason: string;
};
