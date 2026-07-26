import type { NativeProjectId, NativeRepositoryId, NativeWorktreeId } from "./ids";

export type NativeGitRepositoryScope = {
    readonly projectId: NativeProjectId;
    readonly worktreeId: NativeWorktreeId | null;
    readonly rootPath: string;
};

export type NativeGitCloneRepositoryInput = {
    readonly parentDirectory: string;
    readonly repositoryUrl: string;
    readonly targetPath: string;
};

export type NativeGitRepositoryResolution = {
    readonly inputPath: string;
    readonly canonicalRootPath: string | null;
    readonly gitDirPath: string | null;
    readonly isBare: boolean;
    readonly isWorkTree: boolean;
    readonly message: string | null;
    readonly state: string;
};

export type NativeGitSyncStatus = {
    readonly ahead: number;
    readonly behind: number;
    readonly branchName: string | null;
    readonly commit: string | null;
    readonly detached: boolean;
    readonly trackingBranchName: string | null;
};

export type NativeGitStatusSummary = {
    readonly changedCount: number;
    readonly stagedCount: number;
    readonly unstagedCount: number;
    readonly untrackedCount: number;
    readonly conflictedCount: number;
};

export type NativeGitScopeCounts = {
    readonly conflicted: number;
    readonly staged: number;
    readonly untracked: number;
    readonly unstaged: number;
};

export type NativeGitChangeEntry = {
    readonly id: string;
    readonly path: string;
    readonly name: string;
    readonly parentRelativePath: string | null;
    readonly previousPath: string | null;
    readonly scopes: readonly string[];
    readonly scope: string;
    readonly kind: string;
    readonly statusIndex: string;
    readonly statusWorkingDir: string;
    readonly isBinary: boolean;
    readonly isConflicted: boolean;
    readonly isRenamed: boolean;
    readonly additions: number | null;
    readonly deletions: number | null;
    readonly worktreeId: NativeWorktreeId | null;
};

export type NativeGitChangeTreeNode = {
    readonly id: string;
    readonly changeEntryId: string | null;
    readonly children: readonly NativeGitChangeTreeNode[];
    readonly counts: NativeGitScopeCounts;
    readonly kind: string;
    readonly name: string;
    readonly parentRelativePath: string | null;
    readonly relativePath: string;
};

export type NativeGitStatusSnapshot = {
    readonly counts: NativeGitScopeCounts;
    readonly entries: readonly NativeGitChangeEntry[];
    readonly hasConflicts: boolean;
    readonly hasStaged: boolean;
    readonly hasUnstaged: boolean;
    readonly hasUntracked: boolean;
    readonly isClean: boolean;
    readonly summary: NativeGitStatusSummary;
    readonly sync: NativeGitSyncStatus | null;
    readonly tree: readonly NativeGitChangeTreeNode[];
};

export type NativeGitBranchSummary = {
    readonly name: string;
    readonly label: string | null;
    readonly isCurrent: boolean;
    readonly isRemote: boolean;
    readonly isDetached: boolean;
    readonly linkedWorkTree: boolean;
    readonly upstreamName: string | null;
    readonly commitSha: string | null;
    readonly aheadBy: number;
    readonly behindBy: number;
    readonly worktreePath: string | null;
};

export type NativeGitRemoteSummary = {
    readonly name: string;
    readonly fetchUrl: string | null;
    readonly pushUrl: string | null;
    readonly isDefault: boolean;
    readonly refName: string | null;
    readonly aheadBy: number;
    readonly behindBy: number;
};

export type NativeGitWorktreeSummary = {
    readonly id: NativeWorktreeId;
    readonly projectId: NativeProjectId;
    readonly rootPath: string;
    readonly canonicalPath: string;
    readonly branchName: string | null;
    readonly branchRef: string | null;
    readonly commitSha: string | null;
    readonly detached: boolean;
    readonly isPrimary: boolean;
    readonly isCurrent: boolean;
    readonly locked: boolean;
    readonly lockReason: string | null;
    readonly prunable: boolean;
    readonly updatedAt: string;
};

export type NativeGitDiffStatRecord = {
    readonly additions: number;
    readonly deletions: number;
    readonly key: string;
};

export type NativeGitDiffLine = {
    readonly id: string;
    readonly type: string;
    readonly text: string;
    readonly oldLineNumber: number | null;
    readonly newLineNumber: number | null;
};

export type NativeGitDiffHunk = {
    readonly id: string;
    readonly header: string;
    readonly oldStart: number;
    readonly oldCount: number;
    readonly newStart: number;
    readonly newCount: number;
    readonly lines: readonly NativeGitDiffLine[];
};

export type NativeGitFileDiffSummary = {
    readonly insertions: number;
    readonly deletions: number;
};

export type NativeGitFileDiff = {
    readonly path: string;
    readonly previousPath: string | null;
    readonly kind: string;
    readonly staged: boolean;
    readonly isBinary: boolean;
    readonly isText: boolean;
    readonly isTooLarge: boolean;
    readonly oldText: string | null;
    readonly newText: string | null;
    readonly raw: string;
    readonly summary: NativeGitFileDiffSummary;
    readonly hunks: readonly NativeGitDiffHunk[];
};

export type NativeGitDiff = {
    readonly projectId: NativeProjectId;
    readonly worktreeId: NativeWorktreeId | null;
    readonly files: readonly NativeGitFileDiff[];
    readonly updatedAt: string;
};

export type NativeGitOriginalFile = {
    readonly baseText: string | null;
    readonly isText: boolean;
    readonly kind: string;
    readonly path: string;
    readonly previousPath: string | null;
    readonly scope: string;
};

export type NativeGitCommitReference = {
    readonly kind: string;
    readonly label: string;
};

export type NativeGitCommitSummary = {
    readonly sha: string;
    readonly shortSha: string;
    readonly subject: string;
    readonly body: string;
    readonly authorName: string;
    readonly authorEmail: string;
    readonly authoredAt: string;
    readonly parentShas: readonly string[];
    readonly refs: readonly NativeGitCommitReference[];
};

export type NativeGitHistoryListResult = {
    readonly commits: readonly NativeGitCommitSummary[];
    readonly matchedCount: number;
    readonly totalCount: number;
};

export type NativeGitCommitDiffFile = {
    readonly additions: number | null;
    readonly deletions: number | null;
    readonly hunks: readonly NativeGitDiffHunk[];
    readonly isText: boolean;
    readonly kind: string;
    readonly newText: string | null;
    readonly oldText: string | null;
    readonly path: string;
    readonly previousPath: string | null;
    readonly reversible: boolean;
    readonly statusLabel: string | null;
};

export type NativeGitCommitDetail = NativeGitCommitSummary & {
    readonly changedFileCount: number;
    readonly committedAt: string;
    readonly committerEmail: string;
    readonly committerName: string;
    readonly deletions: number;
    readonly files: readonly NativeGitCommitDiffFile[];
    readonly insertions: number;
};

export type NativeGitWorktreeDiffFile = {
    readonly additions: number | null;
    readonly deletions: number | null;
    readonly diff: NativeGitFileDiff | null;
    readonly error: string | null;
    readonly isBinary: boolean;
    readonly isConflicted: boolean;
    readonly kind: string;
    readonly path: string;
    readonly previousPath: string | null;
    readonly scope: string;
};

export type NativeGitWorktreeDiffSection = {
    readonly scope: string;
    readonly files: readonly NativeGitWorktreeDiffFile[];
};

export type NativeGitWorktreeDiffResult = {
    readonly projectId: NativeProjectId;
    readonly worktreeId: NativeWorktreeId | null;
    readonly sections: readonly NativeGitWorktreeDiffSection[];
    readonly updatedAt: string;
};

export type NativeGitBranchDiffFile = {
    readonly additions: number | null;
    readonly deletions: number | null;
    readonly diff: NativeGitFileDiff | null;
    readonly error: string | null;
    readonly isBinary: boolean;
    readonly kind: string;
    readonly path: string;
    readonly previousPath: string | null;
};

export type NativeGitBranchDiffResult = {
    readonly projectId: NativeProjectId;
    readonly worktreeId: NativeWorktreeId | null;
    readonly baseRef: string | null;
    readonly headRef: string;
    readonly files: readonly NativeGitBranchDiffFile[];
    readonly unavailableReason: string | null;
    readonly updatedAt: string;
};

export type NativeGitRepositorySnapshot = {
    readonly repositoryId: NativeRepositoryId;
    readonly projectId: NativeProjectId;
    readonly currentWorktreeId: NativeWorktreeId | null;
    readonly repositoryState: string;
    readonly rootPath: string;
    readonly canonicalRootPath: string;
    readonly resolution: NativeGitRepositoryResolution;
    readonly branch: NativeGitBranchSummary | null;
    readonly branches: readonly NativeGitBranchSummary[];
    readonly remotes: readonly NativeGitRemoteSummary[];
    readonly changes: readonly NativeGitChangeEntry[];
    readonly status: NativeGitStatusSnapshot;
    readonly worktrees: readonly NativeGitWorktreeSummary[];
    readonly updatedAt: string;
};

export type NativeGitOperationResult = {
    readonly ok: boolean;
    readonly message: string | null;
    readonly commitSha: string | null;
    readonly snapshot: NativeGitRepositorySnapshot | null;
    readonly updatedAt: string;
};

export type NativeGitRepositoryInvalidation = {
    readonly occurredAt: string;
    readonly projectId: NativeProjectId;
    readonly worktreeId: NativeWorktreeId | null;
    readonly rootPath: string | null;
    readonly reason: string;
};

export type NativeGitPathInput = {
    readonly scope: NativeGitRepositoryScope;
    readonly path: string;
    readonly previousPath: string | null;
    readonly changeKind: string | null;
    readonly diffScope: string | null;
    readonly staged: boolean | null;
};

export type NativeGitHistoryInput = {
    readonly scope: NativeGitRepositoryScope;
    readonly caseSensitive: boolean | null;
    readonly includeAllRefs: boolean | null;
    readonly limit: number | null;
    readonly query: string | null;
};

export type NativeGitCommitDetailInput = {
    readonly scope: NativeGitRepositoryScope;
    readonly commitSha: string;
};

export type NativeGitPathsInput = {
    readonly scope: NativeGitRepositoryScope;
    readonly paths: readonly string[];
};

export type NativeGitCommitInput = {
    readonly scope: NativeGitRepositoryScope;
    readonly message: string;
    readonly amend: boolean | null;
    readonly noVerify: boolean | null;
};

export type NativeGitCheckoutBranchInput = {
    readonly scope: NativeGitRepositoryScope;
    readonly branchName: string;
    readonly force: boolean | null;
    readonly newBranchName: string | null;
    readonly startPoint: string | null;
};

export type NativeGitWorktreeMutationInput = {
    readonly scope: NativeGitRepositoryScope;
    readonly branchName: string | null;
    readonly force: boolean | null;
    readonly path: string;
    readonly startPoint: string | null;
};

export type NativeGitDeleteLocalBranchInput = {
    readonly scope: NativeGitRepositoryScope;
    readonly branchName: string;
    readonly force: boolean | null;
};

export type NativeGitDeleteRemoteBranchInput = {
    readonly scope: NativeGitRepositoryScope;
    readonly remoteName: string;
    readonly remoteRef: string;
};

export type NativeGitFetchInput = {
    readonly scope: NativeGitRepositoryScope;
    readonly all: boolean | null;
    readonly prune: boolean | null;
    readonly remoteName: string | null;
};

export type NativeGitPullInput = {
    readonly scope: NativeGitRepositoryScope;
    readonly rebase: boolean | null;
    readonly remoteName: string | null;
    readonly remoteRef: string | null;
};

export type NativeGitPushInput = {
    readonly scope: NativeGitRepositoryScope;
    readonly force: boolean | null;
    readonly forceWithLease: boolean | null;
    readonly remoteName: string | null;
    readonly remoteRef: string | null;
    readonly setUpstream: boolean | null;
};
