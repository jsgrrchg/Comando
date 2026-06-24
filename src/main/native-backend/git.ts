import path from "node:path";

import type { GitRemoteSummary } from "@shared/ipc";
import type {
    NativeGitBranchSummary,
    NativeGitChangeTreeNode,
    NativeGitCommitDetail,
    NativeGitCommitDiffFile,
    NativeGitCommitReference,
    NativeGitCommitSummary,
    NativeGitDiffHunk,
    NativeGitDiffLine,
    NativeGitDiffStatRecord,
    NativeGitFileDiff,
    NativeGitHistoryListResult,
    NativeGitOperationResult,
    NativeGitOriginalFile,
    NativeGitPathInput,
    NativeGitRemoteSummary,
    NativeGitRepositoryResolution,
    NativeGitRepositoryScope,
    NativeGitRepositorySnapshot,
    NativeGitScopeCounts,
    NativeGitStatusSnapshot,
    NativeGitSyncStatus,
    NativeGitWorktreeSummary,
} from "@shared/native-backend";

import type { GitGateway } from "../git/service";
import type {
    GitBranchSummary,
    GitChangeKind,
    GitChangeScope,
    GitChangeTreeNode,
    GitCommitDetail,
    GitCommitDiffFile,
    GitCommitDiffHunk,
    GitCommitDiffLine,
    GitCommitReference,
    GitFileDiff,
    GitFileDiffHunk,
    GitFileDiffLine,
    GitFileDiffOptions,
    GitFileTextReference,
    GitHistoryCommitSummary,
    GitHistoryListResult,
    GitListBranchesOptions,
    GitListHistoryOptions,
    GitRepositoryResolution,
    GitRepositorySnapshot,
    GitRepositoryState,
    GitStatusSnapshot,
    GitSyncStatus,
    GitWorktreeSummary,
} from "../git/types";
import type { NativeBackendRequester } from "./persistence";

const SYNTHETIC_NATIVE_GIT_PROJECT_ID = "native_git";

export interface ClosableGitGateway extends GitGateway {
    close(): Promise<void>;
}

export class NativeGitGateway implements ClosableGitGateway {
    readonly #client: NativeBackendRequester;

    constructor(client: NativeBackendRequester) {
        this.#client = client;
    }

    async resolveRepository(
        inputPath: string,
    ): Promise<GitRepositoryResolution> {
        const scope = nativeGitScope(inputPath);
        return nativeRepositoryResolutionToMain(
            parseNativeRepositoryResolution(
                await this.#client.request("git_resolve_repository", scope),
            ),
        );
    }

    async getRepositorySnapshot(
        inputPath: string,
    ): Promise<GitRepositorySnapshot> {
        const scope = nativeGitScope(inputPath);
        return nativeRepositorySnapshotToMain(
            parseNativeRepositorySnapshot(
                await this.#client.request("git_get_repository_snapshot", scope),
            ),
        );
    }

    async getStatus(inputPath: string): Promise<GitStatusSnapshot> {
        const scope = nativeGitScope(inputPath);
        return nativeStatusSnapshotToMain(
            parseNativeStatusSnapshot(
                await this.#client.request("git_get_status", scope),
            ),
        );
    }

    async getSyncStatus(inputPath: string): Promise<GitSyncStatus | null> {
        return (await this.getStatus(inputPath)).sync;
    }

    async listWorktrees(
        inputPath: string,
    ): Promise<readonly GitWorktreeSummary[]> {
        const scope = nativeGitScope(inputPath);
        return parseNativeWorktrees(
            await this.#client.request("git_list_worktrees", scope),
        ).map(nativeWorktreeSummaryToMain);
    }

    async listBranches(
        inputPath: string,
        options: GitListBranchesOptions = {},
    ): Promise<readonly GitBranchSummary[]> {
        const scope = nativeGitScope(inputPath);
        return parseNativeBranches(
            await this.#client.request("git_list_branches", {
                branchScope: options.scope ?? "all",
                scope,
            }),
        ).map(nativeBranchSummaryToMain);
    }

    async getFileDiff(
        inputPath: string,
        relativePath: string,
        options: GitFileDiffOptions = {},
    ): Promise<GitFileDiff> {
        const resolvedOptions = await this.#resolveFileDiffOptions(
            inputPath,
            relativePath,
            options,
        );
        return nativeFileDiffToMain(
            parseNativeFileDiff(
                await this.#client.request(
                    "git_get_file_diff",
                    nativeGitPathInput(inputPath, relativePath, resolvedOptions),
                ),
            ),
        );
    }

    async getFileText(
        inputPath: string,
        relativePath: string,
        reference: GitFileTextReference,
    ): Promise<string | null> {
        const original = parseNativeOriginalFile(
            await this.#client.request("git_get_original_file", {
                changeKind: "modified",
                diffScope: reference === "index" ? "unstaged" : "staged",
                path: relativePath,
                previousPath: null,
                scope: nativeGitScope(inputPath),
                staged: reference === "head",
            } satisfies NativeGitPathInput),
        );
        return original.baseText;
    }

    async listHistory(
        inputPath: string,
        options: GitListHistoryOptions = {},
    ): Promise<GitHistoryListResult> {
        return nativeHistoryListToMain(
            parseNativeHistoryList(
                await this.#client.request("git_get_history", {
                    caseSensitive: options.caseSensitive ?? null,
                    limit: options.limit ?? null,
                    query: options.query ?? null,
                    scope: nativeGitScope(inputPath),
                }),
            ),
        );
    }

    async getCommitDetail(
        inputPath: string,
        commitSha: string,
    ): Promise<GitCommitDetail> {
        return nativeCommitDetailToMain(
            parseNativeCommitDetail(
                await this.#client.request("git_get_commit_detail", {
                    commitSha,
                    scope: nativeGitScope(inputPath),
                }),
            ),
        );
    }

    async initRepository(inputPath: string): Promise<GitRepositorySnapshot> {
        return nativeOperationSnapshot(
            parseNativeOperationResult(
                await this.#client.request("git_init_repository", nativeGitScope(inputPath)),
            ),
        );
    }

    async cloneRepository(input: {
        readonly parentDirectory: string;
        readonly repositoryUrl: string;
        readonly targetPath: string;
    }): Promise<void> {
        await this.#client.request("git_clone_repository", {
            parentDirectory: input.parentDirectory,
            repositoryUrl: input.repositoryUrl,
            targetPath: input.targetPath,
        });
    }

    async stagePaths(
        inputPath: string,
        relativePaths: readonly string[],
    ): Promise<GitRepositorySnapshot> {
        return this.#pathsOperation("git_stage_paths", inputPath, relativePaths);
    }

    async unstagePaths(
        inputPath: string,
        relativePaths: readonly string[],
    ): Promise<GitRepositorySnapshot> {
        return this.#pathsOperation("git_unstage_paths", inputPath, relativePaths);
    }

    async discardPaths(
        inputPath: string,
        relativePaths: readonly string[],
    ): Promise<GitRepositorySnapshot> {
        return this.#pathsOperation("git_discard_paths", inputPath, relativePaths);
    }

    async commit(
        inputPath: string,
        message: string,
        options: {
            readonly amend?: boolean;
            readonly noVerify?: boolean;
        } = {},
    ): Promise<{
        readonly commitSha: string;
        readonly snapshot: GitRepositorySnapshot;
    }> {
        const result = parseNativeOperationResult(
            await this.#client.request("git_commit", {
                amend: options.amend ?? null,
                message,
                noVerify: options.noVerify ?? null,
                scope: nativeGitScope(inputPath),
            }),
        );
        const snapshot = nativeOperationSnapshot(result);
        if (!result.commitSha) {
            throw new Error("Native git commit completed without a commit sha.");
        }
        return { commitSha: result.commitSha, snapshot };
    }

    async checkoutBranch(
        inputPath: string,
        options: {
            readonly branchName: string;
            readonly force?: boolean;
            readonly newBranchName?: string | null;
            readonly startPoint?: string | null;
        },
    ): Promise<GitRepositorySnapshot> {
        return nativeOperationSnapshot(
            parseNativeOperationResult(
                await this.#client.request("git_checkout_branch", {
                    branchName: options.branchName,
                    force: options.force ?? null,
                    newBranchName: options.newBranchName ?? null,
                    scope: nativeGitScope(inputPath),
                    startPoint: options.newBranchName
                        ? (options.startPoint ?? options.branchName)
                        : null,
                }),
            ),
        );
    }

    async createWorktree(
        inputPath: string,
        options: {
            readonly branchName: string;
            readonly force?: boolean;
            readonly path: string;
            readonly startPoint?: string | null;
        },
    ): Promise<GitRepositorySnapshot> {
        return nativeOperationSnapshot(
            parseNativeOperationResult(
                await this.#client.request("git_create_worktree", {
                    branchName: options.branchName,
                    force: options.force ?? null,
                    path: options.path,
                    scope: nativeGitScope(inputPath),
                    startPoint:
                        options.startPoint === undefined
                            ? options.branchName
                            : options.startPoint,
                }),
            ),
        );
    }

    async deleteLocalBranch(
        inputPath: string,
        options: {
            readonly branchName: string;
            readonly force?: boolean;
        },
    ): Promise<GitRepositorySnapshot> {
        return nativeOperationSnapshot(
            parseNativeOperationResult(
                await this.#client.request("git_delete_local_branch", {
                    branchName: options.branchName,
                    force: options.force ?? null,
                    scope: nativeGitScope(inputPath),
                }),
            ),
        );
    }

    async deleteRemoteBranch(
        inputPath: string,
        options: {
            readonly remoteName: string;
            readonly remoteRef: string;
        },
    ): Promise<GitRepositorySnapshot> {
        return nativeOperationSnapshot(
            parseNativeOperationResult(
                await this.#client.request("git_delete_remote_branch", {
                    remoteName: options.remoteName,
                    remoteRef: options.remoteRef,
                    scope: nativeGitScope(inputPath),
                }),
            ),
        );
    }

    async removeWorktree(
        inputPath: string,
        options: {
            readonly force?: boolean;
            readonly path: string;
        },
    ): Promise<GitRepositorySnapshot> {
        return nativeOperationSnapshot(
            parseNativeOperationResult(
                await this.#client.request("git_remove_worktree", {
                    branchName: null,
                    force: options.force ?? null,
                    path: options.path,
                    scope: nativeGitScope(inputPath),
                    startPoint: null,
                }),
            ),
        );
    }

    async fetch(
        inputPath: string,
        options: {
            readonly all?: boolean;
            readonly prune?: boolean;
            readonly remoteName?: string | null;
        } = {},
    ): Promise<GitRepositorySnapshot> {
        return nativeOperationSnapshot(
            parseNativeOperationResult(
                await this.#client.request("git_fetch", {
                    all: options.all ?? null,
                    prune: options.prune ?? null,
                    remoteName: options.remoteName ?? null,
                    scope: nativeGitScope(inputPath),
                }),
            ),
        );
    }

    async pull(
        inputPath: string,
        options: {
            readonly rebase?: boolean;
            readonly remoteName?: string | null;
            readonly remoteRef?: string | null;
        } = {},
    ): Promise<GitRepositorySnapshot> {
        return nativeOperationSnapshot(
            parseNativeOperationResult(
                await this.#client.request("git_pull", {
                    rebase: options.rebase ?? null,
                    remoteName: options.remoteName ?? null,
                    remoteRef: options.remoteRef ?? null,
                    scope: nativeGitScope(inputPath),
                }),
            ),
        );
    }

    async push(
        inputPath: string,
        options: {
            readonly force?: boolean;
            readonly forceWithLease?: boolean;
            readonly remoteName?: string | null;
            readonly remoteRef?: string | null;
            readonly setUpstream?: boolean;
        } = {},
    ): Promise<GitRepositorySnapshot> {
        return nativeOperationSnapshot(
            parseNativeOperationResult(
                await this.#client.request("git_push", {
                    force: options.force ?? null,
                    forceWithLease: options.forceWithLease ?? null,
                    remoteName: options.remoteName ?? null,
                    remoteRef: options.remoteRef ?? null,
                    scope: nativeGitScope(inputPath),
                    setUpstream: options.setUpstream ?? null,
                }),
            ),
        );
    }

    async listRemotes(
        inputPath: string,
        trackingBranchName: string | null,
        aheadBy: number,
        behindBy: number,
    ): Promise<readonly GitRemoteSummary[]> {
        return parseNativeRemotes(
            await this.#client.request("git_list_remotes", {
                aheadBy,
                behindBy,
                scope: nativeGitScope(inputPath),
                trackingBranchName,
            }),
        ).map(nativeRemoteSummaryToMain);
    }

    async getDiffStats(
        inputPath: string,
    ): Promise<readonly NativeGitDiffStatRecord[]> {
        return parseNativeDiffStats(
            await this.#client.request(
                "git_get_diff_stats",
                nativeGitScope(inputPath),
            ),
        );
    }

    invalidate(inputPath?: string): void {
        void inputPath;
        // GitGateway keeps this hook for legacy cache invalidation; native Git reads
        // are uncached and filesystem watcher events drive renderer refresh.
    }

    clear(): void {
        // This gateway has no local Git cache to clear.
    }

    async close(): Promise<void> {
        // The shared native backend client owns the sidecar lifecycle.
    }

    async #pathsOperation(
        command: "git_discard_paths" | "git_stage_paths" | "git_unstage_paths",
        inputPath: string,
        relativePaths: readonly string[],
    ): Promise<GitRepositorySnapshot> {
        return nativeOperationSnapshot(
            parseNativeOperationResult(
                await this.#client.request(command, {
                    paths: [...relativePaths],
                    scope: nativeGitScope(inputPath),
                }),
            ),
        );
    }

    async #resolveFileDiffOptions(
        inputPath: string,
        relativePath: string,
        options: GitFileDiffOptions,
    ): Promise<GitFileDiffOptions> {
        if (
            options.kind &&
            options.previousPath !== undefined &&
            options.scope &&
            options.scope !== "auto"
        ) {
            return options;
        }

        const status = await this.getStatus(inputPath);
        const entry = status.entries.find(
            (candidate) =>
                candidate.relativePath === normalizeGitRelativePath(relativePath),
        );
        if (!entry) {
            return options;
        }

        const scope = resolveNativeDiffScope(options, entry);
        return {
            kind: options.kind ?? entry.kind,
            previousPath: options.previousPath ?? entry.previousPath,
            scope,
            staged: options.staged ?? scope === "staged",
        };
    }
}

export function nativeRepositorySnapshotToMain(
    snapshot: NativeGitRepositorySnapshot,
): GitRepositorySnapshot {
    return {
        branches: snapshot.branches.map(nativeBranchSummaryToMain),
        fetchedAt: snapshot.updatedAt,
        resolution: nativeRepositoryResolutionToMain(snapshot.resolution),
        status: nativeStatusSnapshotToMain(snapshot.status),
        worktrees: snapshot.worktrees.map(nativeWorktreeSummaryToMain),
    };
}

export function nativeFileDiffToMain(diff: NativeGitFileDiff): GitFileDiff {
    return {
        changedPath: diff.path,
        hunks: diff.hunks.map(nativeDiffHunkToMain),
        isBinary: diff.isBinary,
        previousPath: diff.previousPath,
        raw: diff.raw,
        staged: diff.staged,
        summary: {
            deletions: diff.summary.deletions,
            insertions: diff.summary.insertions,
        },
    };
}

function nativeGitScope(inputPath: string): NativeGitRepositoryScope {
    const rootPath = path.resolve(inputPath);
    return {
        projectId: SYNTHETIC_NATIVE_GIT_PROJECT_ID,
        rootPath,
        worktreeId: null,
    };
}

function nativeGitPathInput(
    inputPath: string,
    relativePath: string,
    options: GitFileDiffOptions,
): NativeGitPathInput {
    return {
        changeKind: options.kind ? mainChangeKindToNative(options.kind) : null,
        diffScope: options.scope ?? null,
        path: relativePath,
        previousPath: options.previousPath ?? null,
        scope: nativeGitScope(inputPath),
        staged: options.staged ?? null,
    };
}

function resolveNativeDiffScope(
    options: GitFileDiffOptions,
    entry: GitStatusSnapshot["entries"][number],
): GitChangeScope {
    if (options.scope && options.scope !== "auto") {
        return options.scope;
    }

    if ((options.kind ?? entry.kind) === "untracked") {
        return "untracked";
    }

    if (options.staged === true) {
        return "staged";
    }

    if (entry.scopes.includes("unstaged")) {
        return "unstaged";
    }

    if (entry.scopes.includes("untracked")) {
        return "untracked";
    }

    if (entry.scopes.includes("staged")) {
        return "staged";
    }

    return "unstaged";
}

function normalizeGitRelativePath(relativePath: string): string {
    return relativePath.split(path.sep).join("/");
}

function nativeRepositoryResolutionToMain(
    resolution: NativeGitRepositoryResolution,
): GitRepositoryResolution {
    return {
        canonicalRootPath: resolution.canonicalRootPath,
        gitDirPath: resolution.gitDirPath,
        inputPath: resolution.inputPath,
        isBare: resolution.isBare,
        isWorkTree: resolution.isWorkTree,
        message: resolution.message,
        state: parseRepositoryState(resolution.state),
    };
}

function nativeStatusSnapshotToMain(
    status: NativeGitStatusSnapshot,
): GitStatusSnapshot {
    return {
        counts: nativeScopeCountsToMain(status.counts),
        entries: status.entries.map((entry) => ({
            conflicted: entry.isConflicted,
            id: entry.id,
            isBinary: entry.isBinary,
            isRenamed: entry.isRenamed,
            kind: nativeChangeKindToMain(entry.kind),
            name: entry.name,
            parentRelativePath: entry.parentRelativePath,
            previousPath: entry.previousPath,
            relativePath: entry.path,
            scopes: entry.scopes.map(parseChangeScope),
            statusIndex: entry.statusIndex,
            statusWorkingDir: entry.statusWorkingDir,
        })),
        hasConflicts: status.hasConflicts,
        hasStaged: status.hasStaged,
        hasUnstaged: status.hasUnstaged,
        hasUntracked: status.hasUntracked,
        isClean: status.isClean,
        sync: status.sync ? nativeSyncStatusToMain(status.sync) : null,
        tree: status.tree.map(nativeTreeNodeToMain),
    };
}

function nativeBranchSummaryToMain(
    branch: NativeGitBranchSummary,
): GitBranchSummary {
    return {
        commit: branch.commitSha ?? "",
        current: branch.isCurrent,
        isRemote: branch.isRemote,
        label: branch.label ?? branch.name,
        linkedWorkTree: branch.linkedWorkTree,
        name: branch.name,
        worktreePath: branch.worktreePath,
    };
}

function nativeRemoteSummaryToMain(
    remote: NativeGitRemoteSummary,
): GitRemoteSummary {
    return {
        aheadBy: remote.aheadBy,
        behindBy: remote.behindBy,
        fetchUrl: remote.fetchUrl,
        isDefault: remote.isDefault,
        name: remote.name,
        pushUrl: remote.pushUrl,
        refName: remote.refName,
    };
}

function nativeWorktreeSummaryToMain(
    worktree: NativeGitWorktreeSummary,
): GitWorktreeSummary {
    return {
        branchName: worktree.branchName,
        branchRef: worktree.branchRef,
        canonicalPath: worktree.canonicalPath,
        detached: worktree.detached,
        headCommit: worktree.commitSha ?? "",
        isCurrent: worktree.isCurrent,
        isMain: worktree.isPrimary,
        locked: worktree.locked,
        lockReason: worktree.lockReason,
        path: worktree.rootPath,
        prunable: worktree.prunable,
    };
}

function nativeSyncStatusToMain(sync: NativeGitSyncStatus): GitSyncStatus {
    return {
        ahead: sync.ahead,
        behind: sync.behind,
        branchName: sync.branchName,
        commit: sync.commit,
        detached: sync.detached,
        trackingBranchName: sync.trackingBranchName,
    };
}

function nativeScopeCountsToMain(
    counts: NativeGitScopeCounts,
): GitStatusSnapshot["counts"] {
    return {
        conflicted: counts.conflicted,
        staged: counts.staged,
        untracked: counts.untracked,
        unstaged: counts.unstaged,
    };
}

function nativeTreeNodeToMain(
    node: NativeGitChangeTreeNode,
): GitChangeTreeNode {
    return {
        changeEntryId: node.changeEntryId,
        children: node.children.map(nativeTreeNodeToMain),
        counts: nativeScopeCountsToMain(node.counts),
        id: node.id,
        kind: node.kind === "directory" ? "directory" : "file",
        name: node.name,
        parentRelativePath: node.parentRelativePath,
        relativePath: node.relativePath,
    };
}

function nativeDiffHunkToMain(hunk: NativeGitDiffHunk): GitFileDiffHunk {
    return {
        header: hunk.header,
        lines: hunk.lines.map(nativeDiffLineToMain),
        newCount: hunk.newCount,
        newStart: hunk.newStart,
        oldCount: hunk.oldCount,
        oldStart: hunk.oldStart,
    };
}

function nativeDiffLineToMain(line: NativeGitDiffLine): GitFileDiffLine {
    return {
        newLineNumber: line.newLineNumber,
        oldLineNumber: line.oldLineNumber,
        text: line.text,
        type: parseDiffLineType(line.type),
    };
}

function nativeHistoryListToMain(
    history: NativeGitHistoryListResult,
): GitHistoryListResult {
    return {
        commits: history.commits.map(nativeCommitSummaryToMain),
        matchedCount: history.matchedCount,
        totalCount: history.totalCount,
    };
}

function nativeCommitSummaryToMain(
    commit: NativeGitCommitSummary,
): GitHistoryCommitSummary {
    return {
        authorEmail: commit.authorEmail,
        authorName: commit.authorName,
        authoredAt: commit.authoredAt,
        body: commit.body,
        parentShas: commit.parentShas,
        refs: commit.refs.map(nativeCommitReferenceToMain),
        sha: commit.sha,
        shortSha: commit.shortSha,
        subject: commit.subject,
    };
}

function nativeCommitDetailToMain(
    commit: NativeGitCommitDetail,
): GitCommitDetail {
    return {
        ...nativeCommitSummaryToMain(commit),
        changedFileCount: commit.changedFileCount,
        committedAt: commit.committedAt,
        committerEmail: commit.committerEmail,
        committerName: commit.committerName,
        deletions: commit.deletions,
        files: commit.files.map(nativeCommitDiffFileToMain),
        insertions: commit.insertions,
    };
}

function nativeCommitReferenceToMain(
    reference: NativeGitCommitReference,
): GitCommitReference {
    return {
        kind: parseCommitReferenceKind(reference.kind),
        label: reference.label,
    };
}

function nativeCommitDiffFileToMain(
    file: NativeGitCommitDiffFile,
): GitCommitDiffFile {
    return {
        additions: file.additions,
        deletions: file.deletions,
        hunks: file.hunks.map(nativeCommitDiffHunkToMain),
        isText: file.isText,
        kind: parseCommitDiffKind(file.kind),
        newText: file.newText,
        oldText: file.oldText,
        path: file.path,
        previousPath: file.previousPath,
        reversible: file.reversible,
        statusLabel: file.statusLabel,
    };
}

function nativeCommitDiffHunkToMain(
    hunk: NativeGitDiffHunk,
): GitCommitDiffHunk {
    return {
        header: hunk.header,
        id: hunk.id,
        lines: hunk.lines.map(nativeCommitDiffLineToMain),
        newCount: hunk.newCount,
        newStart: hunk.newStart,
        oldCount: hunk.oldCount,
        oldStart: hunk.oldStart,
    };
}

function nativeCommitDiffLineToMain(
    line: NativeGitDiffLine,
): GitCommitDiffLine {
    return {
        id: line.id,
        text: line.text,
        type: parseDiffLineType(line.type),
    };
}

function nativeOperationSnapshot(
    result: NativeGitOperationResult,
): GitRepositorySnapshot {
    if (!result.ok) {
        throw new Error(result.message ?? "Native git operation failed.");
    }

    if (!result.snapshot) {
        throw new Error("Native git operation completed without a snapshot.");
    }

    return nativeRepositorySnapshotToMain(result.snapshot);
}

function parseRepositoryState(value: string): GitRepositoryState {
    if (
        value === "bare" ||
        value === "error" ||
        value === "missing" ||
        value === "not_repo" ||
        value === "ready"
    ) {
        return value;
    }
    return "error";
}

function parseChangeScope(value: string): GitChangeScope {
    if (
        value === "conflicted" ||
        value === "staged" ||
        value === "unstaged" ||
        value === "untracked"
    ) {
        return value;
    }
    return "unstaged";
}

function nativeChangeKindToMain(value: string): GitChangeKind {
    if (value === "typechange") {
        return "typechanged";
    }

    if (
        value === "added" ||
        value === "conflicted" ||
        value === "copied" ||
        value === "deleted" ||
        value === "modified" ||
        value === "renamed" ||
        value === "untracked"
    ) {
        return value;
    }

    return "unknown";
}

function mainChangeKindToNative(value: GitChangeKind): string {
    return value === "typechanged" ? "typechange" : value;
}

function parseDiffLineType(value: string): "add" | "context" | "remove" {
    if (value === "add" || value === "remove") {
        return value;
    }
    return "context";
}

function parseCommitReferenceKind(value: string): GitCommitReference["kind"] {
    if (
        value === "branch" ||
        value === "head" ||
        value === "remote" ||
        value === "tag"
    ) {
        return value;
    }
    return "other";
}

function parseCommitDiffKind(value: string): GitCommitDiffFile["kind"] {
    if (
        value === "create" ||
        value === "delete" ||
        value === "move" ||
        value === "update"
    ) {
        return value;
    }
    return "update";
}

function parseNativeRepositoryResolution(
    value: unknown,
): NativeGitRepositoryResolution {
    const record = requireRecord(value, "Native git repository resolution");
    requireString(record.inputPath, "inputPath");
    requireBoolean(record.isBare, "isBare");
    requireBoolean(record.isWorkTree, "isWorkTree");
    requireString(record.state, "state");
    return record as unknown as NativeGitRepositoryResolution;
}

function parseNativeRepositorySnapshot(
    value: unknown,
): NativeGitRepositorySnapshot {
    const record = requireRecord(value, "Native git repository snapshot");
    requireString(record.updatedAt, "updatedAt");
    requireRecord(record.resolution, "resolution");
    requireRecord(record.status, "status");
    requireArray(record.branches, "branches");
    requireArray(record.worktrees, "worktrees");
    return record as unknown as NativeGitRepositorySnapshot;
}

function parseNativeStatusSnapshot(value: unknown): NativeGitStatusSnapshot {
    const record = requireRecord(value, "Native git status snapshot");
    requireRecord(record.counts, "counts");
    requireArray(record.entries, "entries");
    requireArray(record.tree, "tree");
    requireBoolean(record.isClean, "isClean");
    return record as unknown as NativeGitStatusSnapshot;
}

function parseNativeFileDiff(value: unknown): NativeGitFileDiff {
    const record = requireRecord(value, "Native git file diff");
    requireString(record.path, "path");
    requireBoolean(record.isBinary, "isBinary");
    requireString(record.raw, "raw");
    requireRecord(record.summary, "summary");
    requireArray(record.hunks, "hunks");
    return record as unknown as NativeGitFileDiff;
}

function parseNativeOriginalFile(value: unknown): NativeGitOriginalFile {
    const record = requireRecord(value, "Native git original file");
    requireString(record.path, "path");
    requireBoolean(record.isText, "isText");
    requireString(record.kind, "kind");
    requireString(record.scope, "scope");
    return record as unknown as NativeGitOriginalFile;
}

function parseNativeHistoryList(value: unknown): NativeGitHistoryListResult {
    const record = requireRecord(value, "Native git history result");
    requireArray(record.commits, "commits");
    requireNumber(record.matchedCount, "matchedCount");
    requireNumber(record.totalCount, "totalCount");
    return record as unknown as NativeGitHistoryListResult;
}

function parseNativeCommitDetail(value: unknown): NativeGitCommitDetail {
    const record = requireRecord(value, "Native git commit detail");
    requireString(record.sha, "sha");
    requireArray(record.files, "files");
    requireNumber(record.insertions, "insertions");
    requireNumber(record.deletions, "deletions");
    return record as unknown as NativeGitCommitDetail;
}

function parseNativeOperationResult(value: unknown): NativeGitOperationResult {
    const record = requireRecord(value, "Native git operation result");
    requireBoolean(record.ok, "ok");
    requireString(record.updatedAt, "updatedAt");
    return record as unknown as NativeGitOperationResult;
}

function parseNativeBranches(value: unknown): readonly NativeGitBranchSummary[] {
    return requireArray(value, "branches") as readonly NativeGitBranchSummary[];
}

function parseNativeWorktrees(value: unknown): readonly NativeGitWorktreeSummary[] {
    return requireArray(value, "worktrees") as readonly NativeGitWorktreeSummary[];
}

function parseNativeRemotes(value: unknown): readonly NativeGitRemoteSummary[] {
    return requireArray(value, "remotes") as readonly NativeGitRemoteSummary[];
}

function parseNativeDiffStats(
    value: unknown,
): readonly NativeGitDiffStatRecord[] {
    return requireArray(value, "diffStats") as readonly NativeGitDiffStatRecord[];
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
        throw new Error(`Native git field ${fieldName} must be an array.`);
    }
    return value;
}

function requireBoolean(value: unknown, fieldName: string): boolean {
    if (typeof value !== "boolean") {
        throw new Error(`Native git field ${fieldName} must be a boolean.`);
    }
    return value;
}

function requireNumber(value: unknown, fieldName: string): number {
    if (typeof value !== "number") {
        throw new Error(`Native git field ${fieldName} must be a number.`);
    }
    return value;
}

function requireString(value: unknown, fieldName: string): string {
    if (typeof value !== "string") {
        throw new Error(`Native git field ${fieldName} must be a string.`);
    }
    return value;
}
