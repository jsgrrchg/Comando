export type GitRepositoryState =
    | "bare"
    | "error"
    | "missing"
    | "not_repo"
    | "ready";

export interface GitRepositoryResolution {
    readonly canonicalRootPath: string | null;
    readonly inputPath: string;
    readonly gitDirPath: string | null;
    readonly isBare: boolean;
    readonly isWorkTree: boolean;
    readonly message: string | null;
    readonly state: GitRepositoryState;
}

export interface GitSyncStatus {
    readonly ahead: number;
    readonly behind: number;
    readonly branchName: string | null;
    readonly commit: string | null;
    readonly detached: boolean;
    readonly trackingBranchName: string | null;
}

export interface GitBranchSummary {
    readonly commit: string;
    readonly current: boolean;
    readonly isRemote: boolean;
    readonly label: string;
    readonly linkedWorkTree: boolean;
    readonly name: string;
    readonly worktreePath: string | null;
}

export interface GitWorktreeSummary {
    readonly branchName: string | null;
    readonly branchRef: string | null;
    readonly canonicalPath: string;
    readonly detached: boolean;
    readonly headCommit: string;
    readonly isCurrent: boolean;
    readonly isMain: boolean;
    readonly locked: boolean;
    readonly lockReason: string | null;
    readonly path: string;
    readonly prunable: boolean;
}

export type GitChangeScope = "conflicted" | "staged" | "untracked" | "unstaged";

export interface GitChangeScopeCounts {
    readonly conflicted: number;
    readonly staged: number;
    readonly untracked: number;
    readonly unstaged: number;
}

export type GitChangeKind =
    | "added"
    | "conflicted"
    | "copied"
    | "deleted"
    | "modified"
    | "renamed"
    | "typechanged"
    | "untracked"
    | "unknown";

export interface GitChangeEntry {
    readonly conflicted: boolean;
    readonly id: string;
    readonly isBinary: boolean;
    readonly isRenamed: boolean;
    readonly kind: GitChangeKind;
    readonly name: string;
    readonly parentRelativePath: string | null;
    readonly previousPath: string | null;
    readonly relativePath: string;
    readonly scopes: readonly GitChangeScope[];
    readonly statusIndex: string;
    readonly statusWorkingDir: string;
}

export interface GitChangeTreeNode {
    readonly changeEntryId: string | null;
    readonly children: readonly GitChangeTreeNode[];
    readonly counts: GitChangeScopeCounts;
    readonly id: string;
    readonly kind: "directory" | "file";
    readonly name: string;
    readonly parentRelativePath: string | null;
    readonly relativePath: string;
}

export interface GitStatusSnapshot {
    readonly counts: GitChangeScopeCounts;
    readonly entries: readonly GitChangeEntry[];
    readonly hasConflicts: boolean;
    readonly hasStaged: boolean;
    readonly hasUnstaged: boolean;
    readonly hasUntracked: boolean;
    readonly isClean: boolean;
    readonly sync: GitSyncStatus | null;
    readonly tree: readonly GitChangeTreeNode[];
}

export interface GitRepositorySnapshot {
    readonly branches: readonly GitBranchSummary[];
    readonly fetchedAt: string;
    readonly resolution: GitRepositoryResolution;
    readonly status: GitStatusSnapshot;
    readonly worktrees: readonly GitWorktreeSummary[];
}

export interface GitDiffStatRecord {
    readonly additions: number;
    readonly deletions: number;
    readonly key: string;
}

export interface GitFileDiffLine {
    readonly newLineNumber: number | null;
    readonly oldLineNumber: number | null;
    readonly text: string;
    readonly type: "add" | "context" | "remove";
}

export interface GitFileDiffHunk {
    readonly header: string;
    readonly lines: readonly GitFileDiffLine[];
    readonly newCount: number;
    readonly newStart: number;
    readonly oldCount: number;
    readonly oldStart: number;
}

export interface GitFileDiffSummary {
    readonly deletions: number;
    readonly insertions: number;
}

export interface GitFileDiff {
    readonly changedPath: string;
    readonly isBinary: boolean;
    readonly previousPath: string | null;
    readonly raw: string;
    readonly staged: boolean;
    readonly summary: GitFileDiffSummary;
    readonly hunks: readonly GitFileDiffHunk[];
}

export interface GitFileDiffOptions {
    readonly kind?: GitChangeKind | null;
    readonly previousPath?: string | null;
    readonly staged?: boolean;
}

export interface GitListBranchesOptions {
    readonly scope?: "all" | "local";
}

export interface GitCommitReference {
    readonly kind: "branch" | "head" | "other" | "remote" | "tag";
    readonly label: string;
}

export interface GitHistoryCommitSummary {
    readonly authorEmail: string;
    readonly authorName: string;
    readonly authoredAt: string;
    readonly body: string;
    readonly parentShas: readonly string[];
    readonly refs: readonly GitCommitReference[];
    readonly sha: string;
    readonly shortSha: string;
    readonly subject: string;
}

export interface GitCommitDiffLine {
    readonly id: string;
    readonly text: string;
    readonly type: "add" | "context" | "remove";
}

export interface GitCommitDiffHunk {
    readonly header: string;
    readonly id: string;
    readonly lines: readonly GitCommitDiffLine[];
    readonly newCount: number;
    readonly newStart: number;
    readonly oldCount: number;
    readonly oldStart: number;
}

export interface GitCommitDiffFile {
    readonly additions: number | null;
    readonly deletions: number | null;
    readonly hunks: readonly GitCommitDiffHunk[];
    readonly isText: boolean;
    readonly kind: "create" | "delete" | "move" | "update";
    readonly newText: string | null;
    readonly oldText: string | null;
    readonly path: string;
    readonly previousPath: string | null;
    readonly reversible: boolean;
    readonly statusLabel: string | null;
}

export interface GitCommitDetail extends GitHistoryCommitSummary {
    readonly changedFileCount: number;
    readonly committedAt: string;
    readonly committerEmail: string;
    readonly committerName: string;
    readonly deletions: number;
    readonly files: readonly GitCommitDiffFile[];
    readonly insertions: number;
}

export interface GitListHistoryOptions {
    readonly caseSensitive?: boolean;
    readonly limit?: number;
    readonly query?: string;
}

export interface GitHistoryListResult {
    readonly commits: readonly GitHistoryCommitSummary[];
    readonly matchedCount: number;
    readonly totalCount: number;
}
