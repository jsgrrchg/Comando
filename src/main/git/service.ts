import fs from "node:fs";
import path from "node:path";

import { simpleGit } from "simple-git";

import type {
    GitBranchSummary,
    GitFileDiff,
    GitFileDiffOptions,
    GitListBranchesOptions,
    GitRepositoryResolution,
    GitRepositorySnapshot,
    GitStatusSnapshot,
    GitSyncStatus,
    GitWorktreeSummary,
} from "./types";

import { buildGitStatusSnapshot, createEmptyGitScopeCounts } from "./status";
import {
    buildBranchWorktreeMap,
    listGitBranches,
    listGitWorktrees,
    resolveGitRepository,
} from "./worktrees";
import { getGitFileDiff } from "./diff";

export interface GitServiceOptions {
    readonly cacheSnapshots?: boolean;
}

export class GitService {
    readonly #cacheSnapshots: boolean;
    readonly #snapshotCache = new Map<string, GitRepositorySnapshot>();
    readonly #resolutionCache = new Map<string, GitRepositoryResolution>();

    constructor(options: GitServiceOptions = {}) {
        this.#cacheSnapshots = options.cacheSnapshots ?? true;
    }

    async resolveRepository(
        inputPath: string,
    ): Promise<GitRepositoryResolution> {
        const normalizedPath = path.resolve(inputPath);
        const cachedResolution = this.#resolutionCache.get(normalizedPath);
        if (cachedResolution) {
            return cachedResolution;
        }

        const resolution = await resolveGitRepository(normalizedPath);
        if (this.#cacheSnapshots) {
            this.#resolutionCache.set(normalizedPath, resolution);
        }

        return resolution;
    }

    async getRepositorySnapshot(
        inputPath: string,
    ): Promise<GitRepositorySnapshot> {
        const normalizedPath = path.resolve(inputPath);
        const cachedSnapshot = this.#snapshotCache.get(normalizedPath);
        if (cachedSnapshot) {
            return cachedSnapshot;
        }

        const resolution = await this.resolveRepository(normalizedPath);
        if (resolution.state !== "ready" || !resolution.canonicalRootPath) {
            const snapshot = {
                branches: [],
                fetchedAt: new Date().toISOString(),
                resolution,
                status: {
                    counts: createEmptyGitScopeCounts(),
                    entries: [],
                    hasConflicts: false,
                    hasStaged: false,
                    hasUnstaged: false,
                    hasUntracked: false,
                    isClean: true,
                    sync: null,
                    tree: [],
                } satisfies GitStatusSnapshot,
                worktrees: [],
            } satisfies GitRepositorySnapshot;

            if (this.#cacheSnapshots) {
                this.#snapshotCache.set(normalizedPath, snapshot);
            }

            return snapshot;
        }

        const rootPath = resolution.canonicalRootPath;
        const [worktrees, status, branchWorktreeMap] = await Promise.all([
            listGitWorktrees(rootPath, rootPath),
            this.getStatus(rootPath),
            buildBranchWorktreeMap(rootPath),
        ]);
        const branches = await listGitBranches(rootPath, {}, branchWorktreeMap);

        const snapshot = {
            branches,
            fetchedAt: new Date().toISOString(),
            resolution,
            status,
            worktrees,
        } satisfies GitRepositorySnapshot;

        if (this.#cacheSnapshots) {
            this.#snapshotCache.set(normalizedPath, snapshot);
        }

        return snapshot;
    }

    async getStatus(inputPath: string): Promise<GitStatusSnapshot> {
        const resolution = await this.resolveRepository(inputPath);
        if (resolution.state !== "ready" || !resolution.canonicalRootPath) {
            return {
                counts: createEmptyGitScopeCounts(),
                entries: [],
                hasConflicts: false,
                hasStaged: false,
                hasUnstaged: false,
                hasUntracked: false,
                isClean: true,
                sync: null,
                tree: [],
            };
        }

        const git = simpleGit(resolution.canonicalRootPath);
        const status = await git.status();
        const snapshot = buildGitStatusSnapshot(status);
        return {
            ...snapshot,
            sync: await hydrateGitSyncStatus(
                snapshot.sync,
                resolution.canonicalRootPath,
            ),
        };
    }

    async getSyncStatus(inputPath: string): Promise<GitSyncStatus | null> {
        const status = await this.getStatus(inputPath);
        return status.sync;
    }

    async listWorktrees(
        inputPath: string,
    ): Promise<readonly GitWorktreeSummary[]> {
        const resolution = await this.resolveRepository(inputPath);
        if (resolution.state !== "ready" || !resolution.canonicalRootPath) {
            return [];
        }

        return listGitWorktrees(
            resolution.canonicalRootPath,
            resolution.canonicalRootPath,
        );
    }

    async listBranches(
        inputPath: string,
        options: GitListBranchesOptions = {},
    ): Promise<readonly GitBranchSummary[]> {
        const resolution = await this.resolveRepository(inputPath);
        if (resolution.state !== "ready" || !resolution.canonicalRootPath) {
            return [];
        }

        const worktreeMap = await buildBranchWorktreeMap(
            resolution.canonicalRootPath,
        );
        return listGitBranches(
            resolution.canonicalRootPath,
            options,
            worktreeMap,
        );
    }

    async getFileDiff(
        inputPath: string,
        relativePath: string,
        options: GitFileDiffOptions = {},
    ): Promise<GitFileDiff> {
        const resolution = await this.resolveRepository(inputPath);
        if (resolution.state !== "ready" || !resolution.canonicalRootPath) {
            throw new Error("The selected path is not a ready git repository.");
        }

        return getGitFileDiff(
            resolution.canonicalRootPath,
            relativePath,
            options,
        );
    }

    async stagePaths(
        inputPath: string,
        relativePaths: readonly string[],
    ): Promise<GitRepositorySnapshot> {
        const rootPath = await this.#requireReadyRepositoryRoot(inputPath);
        await simpleGit(rootPath).add(normalizeGitPaths(relativePaths));
        this.invalidate(inputPath);
        return this.getRepositorySnapshot(inputPath);
    }

    async unstagePaths(
        inputPath: string,
        relativePaths: readonly string[],
    ): Promise<GitRepositorySnapshot> {
        const rootPath = await this.#requireReadyRepositoryRoot(inputPath);
        await simpleGit(rootPath).raw([
            "restore",
            "--staged",
            "--",
            ...normalizeGitPaths(relativePaths),
        ]);
        this.invalidate(inputPath);
        return this.getRepositorySnapshot(inputPath);
    }

    async discardPaths(
        inputPath: string,
        relativePaths: readonly string[],
    ): Promise<GitRepositorySnapshot> {
        const rootPath = await this.#requireReadyRepositoryRoot(inputPath);
        const git = simpleGit(rootPath);
        const normalizedPaths = normalizeGitPaths(relativePaths);

        for (const relativePath of normalizedPaths) {
            const status = await git.raw([
                "status",
                "--porcelain=v1",
                "--",
                relativePath,
            ]);
            const firstLine = status.trim().split("\n")[0] ?? "";
            const absolutePath = path.join(rootPath, relativePath);

            if (firstLine.startsWith("??")) {
                await fs.promises.rm(absolutePath, {
                    force: true,
                    recursive: true,
                });
                continue;
            }

            await git.raw(["restore", "--", relativePath]);
        }

        this.invalidate(inputPath);
        return this.getRepositorySnapshot(inputPath);
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
        const rootPath = await this.#requireReadyRepositoryRoot(inputPath);
        const git = simpleGit(rootPath);
        const trimmedMessage = message.trim();
        const statusSnapshot = buildGitStatusSnapshot(await git.status());
        const [gitUserName, gitUserEmail] = await Promise.all([
            readGitConfig(git, "user.name"),
            readGitConfig(git, "user.email"),
        ]);

        if (!trimmedMessage) {
            throw new Error("Write a commit message before committing.");
        }

        if (statusSnapshot.hasConflicts) {
            throw new Error("Resolve git conflicts before committing.");
        }

        if (!statusSnapshot.hasStaged) {
            throw new Error("Stage at least one change before committing.");
        }

        if (!gitUserName || !gitUserEmail) {
            throw new Error(
                "Git identity is not configured. Set user.name and user.email before committing.",
            );
        }

        const args = ["commit", "-m", trimmedMessage];

        if (options.amend) {
            args.push("--amend");
        }

        if (options.noVerify) {
            args.push("--no-verify");
        }

        await git.raw(args);
        const commitSha = (await git.raw(["rev-parse", "HEAD"])).trim();
        this.invalidate(inputPath);

        return {
            commitSha,
            snapshot: await this.getRepositorySnapshot(inputPath),
        };
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
        const rootPath = await this.#requireReadyRepositoryRoot(inputPath);
        const git = simpleGit(rootPath);
        const args = ["checkout"];

        if (options.force) {
            args.push("--force");
        }

        if (options.newBranchName) {
            args.push("-b", options.newBranchName);
            args.push(options.startPoint ?? options.branchName);
        } else {
            args.push(options.branchName);
        }

        await git.raw(args);
        this.invalidate(inputPath);
        return this.getRepositorySnapshot(inputPath);
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
        const rootPath = await this.#requireReadyRepositoryRoot(inputPath);
        const git = simpleGit(rootPath);
        const args = ["worktree", "add"];

        if (options.force) {
            args.push("--force");
        }

        args.push("-b", options.branchName, path.resolve(options.path));
        args.push(options.startPoint ?? options.branchName);

        await git.raw(args);
        this.invalidate(inputPath);
        return this.getRepositorySnapshot(inputPath);
    }

    async removeWorktree(
        inputPath: string,
        options: {
            readonly force?: boolean;
            readonly path: string;
        },
    ): Promise<GitRepositorySnapshot> {
        const rootPath = await this.#requireReadyRepositoryRoot(inputPath);
        const git = simpleGit(rootPath);
        const args = ["worktree", "remove"];

        if (options.force) {
            args.push("--force");
        }

        args.push(path.resolve(options.path));
        await git.raw(args);
        this.invalidate(inputPath);
        return this.getRepositorySnapshot(inputPath);
    }

    async fetch(
        inputPath: string,
        options: {
            readonly prune?: boolean;
            readonly remoteName?: string | null;
        } = {},
    ): Promise<GitRepositorySnapshot> {
        const rootPath = await this.#requireReadyRepositoryRoot(inputPath);
        const git = simpleGit(rootPath);
        const args = ["fetch"];

        if (options.prune) {
            args.push("--prune");
        }

        if (options.remoteName) {
            args.push(options.remoteName);
        }

        await git.raw(args);
        this.invalidate(inputPath);
        return this.getRepositorySnapshot(inputPath);
    }

    async pull(
        inputPath: string,
        options: {
            readonly rebase?: boolean;
            readonly remoteName?: string | null;
            readonly remoteRef?: string | null;
        } = {},
    ): Promise<GitRepositorySnapshot> {
        const rootPath = await this.#requireReadyRepositoryRoot(inputPath);
        const git = simpleGit(rootPath);
        const args = ["pull"];

        if (options.rebase) {
            args.push("--rebase");
        }

        if (options.remoteName) {
            args.push(options.remoteName);
        }

        if (options.remoteRef) {
            args.push(options.remoteRef);
        }

        await git.raw(args);
        this.invalidate(inputPath);
        return this.getRepositorySnapshot(inputPath);
    }

    async push(
        inputPath: string,
        options: {
            readonly force?: boolean;
            readonly remoteName?: string | null;
            readonly remoteRef?: string | null;
            readonly setUpstream?: boolean;
        } = {},
    ): Promise<GitRepositorySnapshot> {
        const rootPath = await this.#requireReadyRepositoryRoot(inputPath);
        const git = simpleGit(rootPath);
        const args = ["push"];

        if (options.force) {
            args.push("--force");
        }

        if (options.setUpstream) {
            args.push("--set-upstream");
        }

        if (options.remoteName) {
            args.push(options.remoteName);
        }

        if (options.remoteRef) {
            args.push(options.remoteRef);
        }

        await git.raw(args);
        this.invalidate(inputPath);
        return this.getRepositorySnapshot(inputPath);
    }

    invalidate(inputPath?: string): void {
        if (!inputPath) {
            this.#snapshotCache.clear();
            this.#resolutionCache.clear();
            return;
        }

        const normalizedPath = path.resolve(inputPath);
        this.#snapshotCache.delete(normalizedPath);
        this.#resolutionCache.delete(normalizedPath);
    }

    clear(): void {
        this.#snapshotCache.clear();
        this.#resolutionCache.clear();
    }

    async #requireReadyRepositoryRoot(inputPath: string): Promise<string> {
        const resolution = await this.resolveRepository(inputPath);
        if (resolution.state !== "ready" || !resolution.canonicalRootPath) {
            throw new Error("The selected path is not a ready git repository.");
        }

        return resolution.canonicalRootPath;
    }
}

async function hydrateGitSyncStatus(
    sync: GitSyncStatus | null,
    rootPath: string,
): Promise<GitSyncStatus | null> {
    if (!sync) {
        return null;
    }

    const git = simpleGit(rootPath);
    try {
        const commit = (await git.raw(["rev-parse", "HEAD"])).trim();
        return {
            ...sync,
            commit: commit || null,
        };
    } catch {
        return sync;
    }
}

async function readGitConfig(
    git: ReturnType<typeof simpleGit>,
    key: string,
): Promise<string | null> {
    try {
        const value = (await git.raw(["config", "--get", key])).trim();
        return value.length > 0 ? value : null;
    } catch {
        return null;
    }
}

function normalizeGitPaths(paths: readonly string[]): string[] {
    return paths.map((filePath) => filePath.split(path.sep).join("/"));
}
