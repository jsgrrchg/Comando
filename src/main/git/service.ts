import type { GitRemoteSummary } from "@shared/ipc";

import type {
    GitBranchSummary,
    GitCommitDetail,
    GitDiffStatRecord,
    GitFileDiff,
    GitFileDiffOptions,
    GitFileTextReference,
    GitHistoryListResult,
    GitListBranchesOptions,
    GitListHistoryOptions,
    GitRepositoryResolution,
    GitRepositorySnapshot,
    GitStatusSnapshot,
    GitSyncStatus,
    GitWorktreeSummary,
} from "./types";

export interface GitGateway {
    resolveRepository(inputPath: string): Promise<GitRepositoryResolution>;
    getRepositorySnapshot(inputPath: string): Promise<GitRepositorySnapshot>;
    getStatus(inputPath: string): Promise<GitStatusSnapshot>;
    getSyncStatus(inputPath: string): Promise<GitSyncStatus | null>;
    listWorktrees(inputPath: string): Promise<readonly GitWorktreeSummary[]>;
    listBranches(
        inputPath: string,
        options?: GitListBranchesOptions,
    ): Promise<readonly GitBranchSummary[]>;
    getFileDiff(
        inputPath: string,
        relativePath: string,
        options?: GitFileDiffOptions,
    ): Promise<GitFileDiff>;
    getFileText(
        inputPath: string,
        relativePath: string,
        reference: GitFileTextReference,
    ): Promise<string | null>;
    listHistory(
        inputPath: string,
        options?: GitListHistoryOptions,
    ): Promise<GitHistoryListResult>;
    getCommitDetail(
        inputPath: string,
        commitSha: string,
    ): Promise<GitCommitDetail>;
    initRepository(inputPath: string): Promise<GitRepositorySnapshot>;
    cloneRepository(input: {
        readonly parentDirectory: string;
        readonly repositoryUrl: string;
        readonly targetPath: string;
    }): Promise<void>;
    stagePaths(
        inputPath: string,
        relativePaths: readonly string[],
    ): Promise<GitRepositorySnapshot>;
    unstagePaths(
        inputPath: string,
        relativePaths: readonly string[],
    ): Promise<GitRepositorySnapshot>;
    discardPaths(
        inputPath: string,
        relativePaths: readonly string[],
    ): Promise<GitRepositorySnapshot>;
    commit(
        inputPath: string,
        message: string,
        options?: {
            readonly amend?: boolean;
            readonly noVerify?: boolean;
        },
    ): Promise<{
        readonly commitSha: string;
        readonly snapshot: GitRepositorySnapshot;
    }>;
    checkoutBranch(
        inputPath: string,
        options: {
            readonly branchName: string;
            readonly force?: boolean;
            readonly newBranchName?: string | null;
            readonly startPoint?: string | null;
        },
    ): Promise<GitRepositorySnapshot>;
    createWorktree(
        inputPath: string,
        options: {
            readonly branchName: string;
            readonly force?: boolean;
            readonly path: string;
            readonly startPoint?: string | null;
        },
    ): Promise<GitRepositorySnapshot>;
    deleteLocalBranch(
        inputPath: string,
        options: {
            readonly branchName: string;
            readonly force?: boolean;
        },
    ): Promise<GitRepositorySnapshot>;
    deleteRemoteBranch(
        inputPath: string,
        options: {
            readonly remoteName: string;
            readonly remoteRef: string;
        },
    ): Promise<GitRepositorySnapshot>;
    removeWorktree(
        inputPath: string,
        options: {
            readonly force?: boolean;
            readonly path: string;
        },
    ): Promise<GitRepositorySnapshot>;
    fetch(
        inputPath: string,
        options?: {
            readonly all?: boolean;
            readonly prune?: boolean;
            readonly remoteName?: string | null;
        },
    ): Promise<GitRepositorySnapshot>;
    pull(
        inputPath: string,
        options?: {
            readonly rebase?: boolean;
            readonly remoteName?: string | null;
            readonly remoteRef?: string | null;
        },
    ): Promise<GitRepositorySnapshot>;
    push(
        inputPath: string,
        options?: {
            readonly force?: boolean;
            readonly forceWithLease?: boolean;
            readonly remoteName?: string | null;
            readonly remoteRef?: string | null;
            readonly setUpstream?: boolean;
        },
    ): Promise<GitRepositorySnapshot>;
    listRemotes(
        inputPath: string,
        trackingBranchName: string | null,
        aheadBy: number,
        behindBy: number,
    ): Promise<readonly GitRemoteSummary[]>;
    getDiffStats(inputPath: string): Promise<readonly GitDiffStatRecord[]>;
    invalidate(inputPath?: string): void;
    clear(): void;
}
