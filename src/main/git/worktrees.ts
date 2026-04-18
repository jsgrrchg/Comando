import fs from "node:fs";
import path from "node:path";

import { simpleGit } from "simple-git";

import { debugBenignError } from "@main/observability/logging";

import type {
    GitBranchSummary,
    GitListBranchesOptions,
    GitRepositoryResolution,
    GitWorktreeSummary,
} from "./types";

export async function resolveGitRepository(
    inputPath: string,
): Promise<GitRepositoryResolution> {
    const normalizedPath = path.resolve(inputPath);

    if (!pathExists(normalizedPath)) {
        return {
            canonicalRootPath: null,
            inputPath: normalizedPath,
            gitDirPath: null,
            isBare: false,
            isWorkTree: false,
            message: "The selected path does not exist.",
            state: "missing",
        };
    }

    const git = simpleGit(normalizedPath);

    try {
        const topLevel = await git.raw(["rev-parse", "--show-toplevel"]);
        const canonicalRootPath = path.resolve(topLevel.trim());
        const gitDirPath = await resolveGitDir(normalizedPath);

        return {
            canonicalRootPath,
            inputPath: normalizedPath,
            gitDirPath,
            isBare: false,
            isWorkTree: true,
            message: null,
            state: "ready",
        };
    } catch (error) {
        const bare = await isBareRepository(normalizedPath);

        if (bare) {
            return {
                canonicalRootPath: path.resolve(normalizedPath),
                inputPath: normalizedPath,
                gitDirPath: normalizedPath,
                isBare: true,
                isWorkTree: false,
                message: null,
                state: "bare",
            };
        }

        return {
            canonicalRootPath: null,
            inputPath: normalizedPath,
            gitDirPath: null,
            isBare: false,
            isWorkTree: false,
            message:
                error instanceof Error
                    ? error.message
                    : "The selected path is not a git repository.",
            state: "not_repo",
        };
    }
}

export async function listGitBranches(
    rootPath: string,
    options: GitListBranchesOptions = {},
    worktreePathsByBranchName: ReadonlyMap<string, string> = new Map(),
): Promise<readonly GitBranchSummary[]> {
    const git = simpleGit(rootPath);
    const summary =
        options.scope === "local"
            ? await git.branchLocal()
            : await git.branch([
                  "--all",
                  "--verbose",
                  "--no-abbrev",
                  "--color=never",
              ]);

    return [...summary.all]
        .map((branchName) => {
            const branch = summary.branches[branchName];
            if (!branch) {
                return null;
            }

            return {
                commit: branch.commit,
                current: branch.current,
                isRemote: isRemoteBranchName(branchName),
                label: branch.label,
                linkedWorkTree: branch.linkedWorkTree,
                name: branchName,
                worktreePath:
                    worktreePathsByBranchName.get(branchName) ??
                    worktreePathsByBranchName.get(
                        normalizeBranchName(branchName),
                    ) ??
                    null,
            } satisfies GitBranchSummary;
        })
        .filter((branch): branch is GitBranchSummary => branch !== null)
        .sort((left, right) => {
            if (left.current !== right.current) {
                return left.current ? -1 : 1;
            }

            if (left.linkedWorkTree !== right.linkedWorkTree) {
                return left.linkedWorkTree ? -1 : 1;
            }

            if (left.isRemote !== right.isRemote) {
                return left.isRemote ? 1 : -1;
            }

            return left.name.localeCompare(right.name);
        });
}

export async function listGitWorktrees(
    rootPath: string,
    canonicalRootPath: string,
): Promise<readonly GitWorktreeSummary[]> {
    const git = simpleGit(rootPath);
    const output = await git.raw(["worktree", "list", "--porcelain"]);
    const entries = parseWorktreePorcelain(output);

    return entries
        .map((entry) => ({
            branchName: entry.branchRef
                ? normalizeBranchName(entry.branchRef)
                : null,
            branchRef: entry.branchRef,
            canonicalPath: path.resolve(entry.path),
            detached: entry.detached,
            headCommit: entry.headCommit,
            isCurrent:
                path.resolve(entry.path) === path.resolve(canonicalRootPath),
            isMain:
                path.resolve(entry.path) === path.resolve(canonicalRootPath),
            locked: entry.locked,
            lockReason: entry.lockReason,
            path: entry.path,
            prunable: entry.prunable,
        }))
        .sort((left, right) => {
            if (left.isCurrent !== right.isCurrent) {
                return left.isCurrent ? -1 : 1;
            }

            return left.canonicalPath.localeCompare(right.canonicalPath);
        });
}

export async function buildBranchWorktreeMap(
    rootPath: string,
): Promise<ReadonlyMap<string, string>> {
    const worktrees = await listGitWorktreeEntries(rootPath);
    const map = new Map<string, string>();

    for (const entry of worktrees) {
        if (entry.branchRef) {
            map.set(normalizeBranchName(entry.branchRef), entry.path);
        }
    }

    return map;
}

export async function listGitWorktreeEntries(
    rootPath: string,
): Promise<readonly ParsedGitWorktreeEntry[]> {
    const git = simpleGit(rootPath);
    const output = await git.raw(["worktree", "list", "--porcelain"]);
    return parseWorktreePorcelain(output);
}

export interface ParsedGitWorktreeEntry {
    readonly branchRef: string | null;
    readonly detached: boolean;
    readonly headCommit: string;
    readonly locked: boolean;
    readonly lockReason: string | null;
    readonly path: string;
    readonly prunable: boolean;
}

function parseWorktreePorcelain(
    output: string,
): readonly ParsedGitWorktreeEntry[] {
    const trimmedOutput = output.trim();
    if (!trimmedOutput) {
        return [];
    }

    const blocks = trimmedOutput
        .split(/\n\s*\n/)
        .map((block) => block.trim())
        .filter(Boolean);

    return blocks.map((block) => {
        const entry: ParsedGitWorktreeEntry = {
            branchRef: null,
            detached: false,
            headCommit: "",
            locked: false,
            lockReason: null,
            path: "",
            prunable: false,
        };

        for (const line of block.split("\n")) {
            if (line.startsWith("worktree ")) {
                (entry as { path: string }).path = line
                    .slice("worktree ".length)
                    .trim();
                continue;
            }

            if (line.startsWith("HEAD ")) {
                (entry as { headCommit: string }).headCommit = line
                    .slice("HEAD ".length)
                    .trim();
                continue;
            }

            if (line.startsWith("branch ")) {
                (entry as { branchRef: string | null }).branchRef = line
                    .slice("branch ".length)
                    .trim();
                continue;
            }

            if (line === "detached") {
                (entry as { detached: boolean }).detached = true;
                continue;
            }

            if (line.startsWith("locked")) {
                (entry as { locked: boolean }).locked = true;
                (entry as { lockReason: string | null }).lockReason =
                    line.length > "locked".length
                        ? line.slice("locked".length).trim()
                        : null;
                continue;
            }

            if (line.startsWith("prunable")) {
                (entry as { prunable: boolean }).prunable = true;
            }
        }

        return entry;
    });
}

function normalizeBranchName(refName: string): string {
    if (refName.startsWith("refs/heads/")) {
        return refName.slice("refs/heads/".length);
    }

    if (refName.startsWith("refs/remotes/")) {
        return refName.slice("refs/remotes/".length);
    }

    return refName;
}

function isRemoteBranchName(branchName: string): boolean {
    return (
        branchName.startsWith("remotes/") || branchName.startsWith("origin/")
    );
}

async function resolveGitDir(baseDir: string): Promise<string> {
    const git = simpleGit(baseDir);
    const gitDir = await git.raw(["rev-parse", "--git-dir"]);
    const trimmed = gitDir.trim();
    return path.isAbsolute(trimmed) ? trimmed : path.resolve(baseDir, trimmed);
}

async function isBareRepository(baseDir: string): Promise<boolean> {
    try {
        const git = simpleGit(baseDir);
        const result = await git.raw(["rev-parse", "--is-bare-repository"]);
        return result.trim() === "true";
    } catch (error) {
        debugBenignError("git.worktrees.isBareRepository", error);
        return false;
    }
}

function pathExists(targetPath: string): boolean {
    try {
        return fs.statSync(targetPath).isDirectory();
    } catch (error) {
        debugBenignError("git.worktrees.pathExists", error);
        return false;
    }
}
