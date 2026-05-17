import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { GitService } from "./service";

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { force: true, recursive: true });
    }
});

describe("GitService", () => {
    it("resolves repositories, worktrees, branches, and dirty state", async () => {
        const rootPath = createGitRepositoryFixture();
        const featureWorktreePath = path.join(
            path.dirname(rootPath),
            "comando-git-feature",
        );
        temporaryDirectories.push(featureWorktreePath);

        git(rootPath, ["init", "-b", "main"]);
        git(rootPath, ["config", "user.name", "Comando"]);
        git(rootPath, ["config", "user.email", "comando@example.com"]);
        fs.writeFileSync(path.join(rootPath, "README.md"), "hello\n");
        fs.mkdirSync(path.join(rootPath, "src"));
        fs.writeFileSync(
            path.join(rootPath, "src", "main.ts"),
            "console.log(1);\n",
        );
        git(rootPath, ["add", "."]);
        git(rootPath, ["commit", "-m", "initial commit"]);
        git(rootPath, ["checkout", "-b", "feature/git-panel"]);
        fs.writeFileSync(
            path.join(rootPath, "src", "main.ts"),
            "console.log(2);\n",
        );
        fs.writeFileSync(path.join(rootPath, "scratch.txt"), "scratch\n");
        fs.writeFileSync(path.join(rootPath, "README.md"), "hello\nupdated\n");
        git(rootPath, ["add", "README.md"]);
        fs.rmSync(featureWorktreePath, { force: true, recursive: true });
        git(rootPath, [
            "worktree",
            "add",
            featureWorktreePath,
            "-b",
            "feature/sidebar",
        ]);

        const canonicalRootPath = fs.realpathSync(rootPath);
        const canonicalFeatureWorktreePath =
            fs.realpathSync(featureWorktreePath);
        const service = new GitService({ cacheSnapshots: false });
        const snapshot = await service.getRepositorySnapshot(
            path.join(rootPath, "src"),
        );

        expect(snapshot.resolution.state).toBe("ready");
        expect(snapshot.resolution.canonicalRootPath).toBe(canonicalRootPath);
        expect(snapshot.status.hasStaged).toBe(true);
        expect(snapshot.status.hasUntracked).toBe(true);
        expect(snapshot.status.hasUnstaged).toBe(true);
        expect(snapshot.status.isClean).toBe(false);
        expect(snapshot.status.sync?.branchName).toBe("feature/git-panel");
        expect(snapshot.status.sync?.commit).toMatch(/[0-9a-f]{7,40}/i);
        expect(snapshot.branches.map((branch) => branch.name)).toEqual(
            expect.arrayContaining(["feature/git-panel", "main"]),
        );
        expect(
            snapshot.worktrees.map((worktree) => worktree.canonicalPath),
        ).toEqual(
            expect.arrayContaining([
                canonicalRootPath,
                canonicalFeatureWorktreePath,
            ]),
        );
        expect(
            snapshot.worktrees.find(
                (worktree) => worktree.canonicalPath === canonicalRootPath,
            ),
        ).toMatchObject({
            branchName: "feature/git-panel",
            isCurrent: true,
            isMain: true,
        });
        expect(snapshot.status.tree[0]?.kind).toBe("directory");
        expect(
            snapshot.status.entries.map((entry) => entry.relativePath),
        ).toEqual(
            expect.arrayContaining(["README.md", "scratch.txt", "src/main.ts"]),
        );
    });

    it("parses diffs for modified and untracked files", async () => {
        const rootPath = createGitRepositoryFixture();

        git(rootPath, ["init", "-b", "main"]);
        git(rootPath, ["config", "user.name", "Comando"]);
        git(rootPath, ["config", "user.email", "comando@example.com"]);
        fs.writeFileSync(path.join(rootPath, "README.md"), "hello\n");
        git(rootPath, ["add", "README.md"]);
        git(rootPath, ["commit", "-m", "initial commit"]);

        fs.writeFileSync(path.join(rootPath, "README.md"), "hello\nworld\n");
        fs.writeFileSync(path.join(rootPath, "new-file.txt"), "new file\n");

        const service = new GitService({ cacheSnapshots: false });
        const modifiedDiff = await service.getFileDiff(rootPath, "README.md", {
            staged: false,
        });
        const untrackedDiff = await service.getFileDiff(
            rootPath,
            "new-file.txt",
            {
                staged: false,
            },
        );

        expect(modifiedDiff.hunks.length).toBeGreaterThan(0);
        expect(modifiedDiff.summary.insertions).toBeGreaterThan(0);
        expect(modifiedDiff.summary.deletions).toBe(0);
        expect(untrackedDiff.hunks.length).toBeGreaterThan(0);
        expect(untrackedDiff.raw).toContain("diff --git");
    });

    it("loads staged and unstaged diffs separately for the same file", async () => {
        const rootPath = createGitRepositoryFixture();

        git(rootPath, ["init", "-b", "main"]);
        git(rootPath, ["config", "user.name", "Comando"]);
        git(rootPath, ["config", "user.email", "comando@example.com"]);
        fs.writeFileSync(path.join(rootPath, "README.md"), "hello\nbase\n");
        git(rootPath, ["add", "README.md"]);
        git(rootPath, ["commit", "-m", "initial commit"]);

        fs.writeFileSync(path.join(rootPath, "README.md"), "hello\nstaged\n");
        git(rootPath, ["add", "README.md"]);
        fs.writeFileSync(
            path.join(rootPath, "README.md"),
            "hello\nunstaged\n",
        );

        const service = new GitService({ cacheSnapshots: false });
        const stagedDiff = await service.getFileDiff(rootPath, "README.md", {
            scope: "staged",
        });
        const unstagedDiff = await service.getFileDiff(rootPath, "README.md", {
            scope: "unstaged",
        });

        expect(stagedDiff.staged).toBe(true);
        expect(stagedDiff.raw).toContain("+staged");
        expect(stagedDiff.raw).not.toContain("+unstaged");
        expect(unstagedDiff.staged).toBe(false);
        expect(unstagedDiff.raw).toContain("-staged");
        expect(unstagedDiff.raw).toContain("+unstaged");
    });

    it("treats untracked no-index diff exit code 1 as a valid diff", async () => {
        const rootPath = createGitRepositoryFixture();

        git(rootPath, ["init", "-b", "main"]);
        git(rootPath, ["config", "user.name", "Comando"]);
        git(rootPath, ["config", "user.email", "comando@example.com"]);
        fs.writeFileSync(path.join(rootPath, "README.md"), "hello\n");
        git(rootPath, ["add", "README.md"]);
        git(rootPath, ["commit", "-m", "initial commit"]);
        fs.writeFileSync(path.join(rootPath, "new-file.txt"), "new file\n");

        const service = new GitService({ cacheSnapshots: false });
        const untrackedDiff = await service.getFileDiff(
            rootPath,
            "new-file.txt",
            {
                scope: "untracked",
            },
        );

        expect(untrackedDiff.hunks.length).toBeGreaterThan(0);
        expect(untrackedDiff.raw).toContain("diff --git");
        expect(untrackedDiff.summary.insertions).toBe(1);
    });

    it("lists remotes and collects staged and unstaged diff stats", async () => {
        const rootPath = createGitRepositoryFixture();
        const remotePath = createGitRepositoryFixture();

        git(rootPath, ["init", "-b", "main"]);
        git(rootPath, ["config", "user.name", "Comando"]);
        git(rootPath, ["config", "user.email", "comando@example.com"]);
        git(remotePath, ["init", "--bare"]);

        fs.writeFileSync(path.join(rootPath, "README.md"), "hello\n");
        fs.writeFileSync(path.join(rootPath, "notes.txt"), "note\n");
        git(rootPath, ["add", "."]);
        git(rootPath, ["commit", "-m", "initial commit"]);
        git(rootPath, ["remote", "add", "origin", remotePath]);
        git(rootPath, ["push", "-u", "origin", "main"]);

        fs.writeFileSync(path.join(rootPath, "README.md"), "hello\nworld\n");
        git(rootPath, ["add", "README.md"]);
        fs.writeFileSync(path.join(rootPath, "notes.txt"), "note\nextra\n");

        const service = new GitService({ cacheSnapshots: false });
        const remotes = await service.listRemotes(
            rootPath,
            "origin/main",
            2,
            1,
        );
        const diffStats = await service.getDiffStats(rootPath);
        const statsByKey = new Map(
            diffStats.map((entry) => [
                entry.key,
                {
                    additions: entry.additions,
                    deletions: entry.deletions,
                },
            ]),
        );

        expect(remotes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    aheadBy: 2,
                    behindBy: 1,
                    isDefault: true,
                    name: "origin",
                }),
            ]),
        );
        expect(statsByKey.get("staged:README.md")).toMatchObject({
            additions: 1,
            deletions: 0,
        });
        expect(statsByKey.get("unstaged:notes.txt")).toMatchObject({
            additions: 1,
            deletions: 0,
        });
    });

    it("pushes branch publication and force-with-lease updates", async () => {
        const rootPath = createGitRepositoryFixture();
        const remotePath = createGitRepositoryFixture();

        git(rootPath, ["init", "-b", "main"]);
        git(rootPath, ["config", "user.name", "Comando"]);
        git(rootPath, ["config", "user.email", "comando@example.com"]);
        git(remotePath, ["init", "--bare"]);

        fs.writeFileSync(path.join(rootPath, "README.md"), "hello\n");
        git(rootPath, ["add", "README.md"]);
        git(rootPath, ["commit", "-m", "initial commit"]);
        git(rootPath, ["remote", "add", "origin", remotePath]);

        const service = new GitService({ cacheSnapshots: false });
        await service.push(rootPath, {
            remoteName: "origin",
            remoteRef: "main",
            setUpstream: true,
        });

        fs.writeFileSync(path.join(rootPath, "README.md"), "hello\nagain\n");
        git(rootPath, ["add", "README.md"]);
        git(rootPath, ["commit", "--amend", "-m", "rewritten commit"]);

        await expect(
            service.push(rootPath, { forceWithLease: true }),
        ).resolves.toMatchObject({
            resolution: {
                state: "ready",
            },
        });
    });

    it("lists history and commit details", async () => {
        const rootPath = createGitRepositoryFixture();
        const featureWorktreePath = path.join(
            path.dirname(rootPath),
            "comando-git-history-feature",
        );
        temporaryDirectories.push(featureWorktreePath);

        git(rootPath, ["init", "-b", "main"]);
        git(rootPath, ["config", "user.name", "Comando"]);
        git(rootPath, ["config", "user.email", "comando@example.com"]);

        fs.writeFileSync(path.join(rootPath, "README.md"), "hello\n");
        git(rootPath, ["add", "README.md"]);
        git(rootPath, ["commit", "-m", "initial commit"]);

        fs.writeFileSync(path.join(rootPath, "README.md"), "hello\nworld\n");
        fs.writeFileSync(path.join(rootPath, "notes.txt"), "details\n");
        git(rootPath, ["add", "."]);
        git(rootPath, ["commit", "-m", "update docs"]);
        git(rootPath, ["branch", "feature/history", "HEAD~1"]);
        git(rootPath, [
            "worktree",
            "add",
            featureWorktreePath,
            "feature/history",
        ]);
        fs.writeFileSync(
            path.join(featureWorktreePath, "feature.txt"),
            "feature\n",
        );
        git(featureWorktreePath, ["add", "feature.txt"]);
        git(featureWorktreePath, ["commit", "-m", "feature worktree commit"]);

        const service = new GitService({ cacheSnapshots: false });
        const history = await service.listHistory(rootPath, { limit: 10 });
        const latestCommit = history.commits[0];

        expect(history.commits).toHaveLength(2);
        expect(history.matchedCount).toBe(2);
        expect(history.totalCount).toBe(2);
        expect(latestCommit?.subject).toBe("update docs");
        expect(latestCommit?.shortSha).toMatch(/[0-9a-f]{7}/i);
        expect(
            latestCommit?.refs.some((reference) =>
                reference.label.includes("main"),
            ),
        ).toBe(true);

        const firstPage = await service.listHistory(rootPath, { limit: 1 });
        expect(firstPage.commits).toHaveLength(1);
        expect(firstPage.matchedCount).toBe(2);
        expect(firstPage.totalCount).toBe(2);

        const detail = await service.getCommitDetail(
            rootPath,
            latestCommit?.sha ?? "",
        );

        expect(detail.subject).toBe("update docs");
        expect(detail.changedFileCount).toBe(2);
        expect(detail.insertions).toBeGreaterThan(0);
        expect(detail.files.map((file) => file.path)).toEqual(
            expect.arrayContaining(["README.md", "notes.txt"]),
        );

        const filteredHistory = await service.listHistory(rootPath, {
            limit: 1,
            query: "initial",
        });

        expect(filteredHistory.commits).toHaveLength(1);
        expect(filteredHistory.commits[0]?.subject).toBe("initial commit");
        expect(filteredHistory.matchedCount).toBe(1);
        expect(filteredHistory.totalCount).toBe(2);

        const hiddenBranchHistory = await service.listHistory(rootPath, {
            query: "feature worktree",
        });
        expect(hiddenBranchHistory.commits).toHaveLength(0);
        expect(hiddenBranchHistory.matchedCount).toBe(0);
        expect(hiddenBranchHistory.totalCount).toBe(2);

        const featureHistory = await service.listHistory(featureWorktreePath, {
            limit: 10,
        });
        expect(featureHistory.commits.map((commit) => commit.subject)).toEqual([
            "feature worktree commit",
            "initial commit",
        ]);
        expect(featureHistory.matchedCount).toBe(2);
        expect(featureHistory.totalCount).toBe(2);
    });

    it("invalidates cached snapshots across worktrees after branch metadata changes", async () => {
        const rootPath = createGitRepositoryFixture();
        const featureWorktreePath = path.join(
            path.dirname(rootPath),
            "comando-git-cache-feature",
        );
        temporaryDirectories.push(featureWorktreePath);

        git(rootPath, ["init", "-b", "main"]);
        git(rootPath, ["config", "user.name", "Comando"]);
        git(rootPath, ["config", "user.email", "comando@example.com"]);
        fs.writeFileSync(path.join(rootPath, "README.md"), "hello\n");
        git(rootPath, ["add", "README.md"]);
        git(rootPath, ["commit", "-m", "initial commit"]);
        git(rootPath, ["branch", "feature/cache"]);
        git(rootPath, [
            "worktree",
            "add",
            featureWorktreePath,
            "feature/cache",
        ]);

        const service = new GitService();
        const cachedFeatureSnapshot =
            await service.getRepositorySnapshot(featureWorktreePath);
        expect(
            cachedFeatureSnapshot.branches.map((branch) => branch.name),
        ).not.toContain("hotfix/cache");

        await service.checkoutBranch(rootPath, {
            branchName: "main",
            newBranchName: "hotfix/cache",
        });

        const refreshedFeatureSnapshot =
            await service.getRepositorySnapshot(featureWorktreePath);
        expect(
            refreshedFeatureSnapshot.branches.map((branch) => branch.name),
        ).toContain("hotfix/cache");
    });

    it("classifies paths outside a repo as non-repository", async () => {
        const rootPath = createGitRepositoryFixture();
        const service = new GitService({ cacheSnapshots: false });
        const resolution = await service.resolveRepository(rootPath);

        expect(resolution.state).toBe("not_repo");
        expect(resolution.canonicalRootPath).toBeNull();
    });

    it("initializes a non-repository project", async () => {
        const rootPath = createGitRepositoryFixture();
        fs.writeFileSync(path.join(rootPath, "README.md"), "hello\n");
        const service = new GitService({ cacheSnapshots: false });

        const snapshot = await service.initRepository(rootPath);

        expect(snapshot.resolution.state).toBe("ready");
        expect(snapshot.resolution.canonicalRootPath).toBe(
            fs.realpathSync(rootPath),
        );
        expect(snapshot.worktrees[0]).toMatchObject({
            branchName: "main",
            isCurrent: true,
            isMain: true,
        });
        expect(snapshot.status.hasUntracked).toBe(true);
        await expect(service.listHistory(rootPath)).resolves.toEqual({
            commits: [],
            matchedCount: 0,
            totalCount: 0,
        });
    });

    it("runs preflight checks before committing", async () => {
        const rootPath = createGitRepositoryFixture();
        const isolatedHome = createGitRepositoryFixture();
        const previousHome = process.env.HOME;
        const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;

        process.env.HOME = isolatedHome;
        process.env.XDG_CONFIG_HOME = path.join(isolatedHome, ".config");

        try {
            git(rootPath, ["init", "-b", "main"]);
            fs.writeFileSync(path.join(rootPath, "README.md"), "hello\n");
            git(rootPath, ["add", "README.md"]);

            const service = new GitService({ cacheSnapshots: false });

            await expect(
                service.commit(rootPath, "initial commit"),
            ).rejects.toThrow("Git identity is not configured");

            git(rootPath, ["config", "user.name", "Comando"]);
            git(rootPath, ["config", "user.email", "comando@example.com"]);
            const commitResult = await service.commit(
                rootPath,
                "initial commit",
            );
            expect(commitResult.commitSha).toMatch(/[0-9a-f]{7,40}/i);

            fs.writeFileSync(
                path.join(rootPath, "README.md"),
                "hello\nworld\n",
            );
            await expect(
                service.commit(rootPath, "without staging"),
            ).rejects.toThrow("Stage at least one change before committing.");
        } finally {
            process.env.HOME = previousHome;
            process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
        }
    });
});

function createGitRepositoryFixture(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "comando-git-"));
    temporaryDirectories.push(directory);
    return directory;
}

function git(cwd: string, args: readonly string[]): void {
    const result = spawnSync("git", [...args], {
        cwd,
        encoding: "utf8",
        env: {
            ...process.env,
            GIT_AUTHOR_EMAIL: "comando@example.com",
            GIT_AUTHOR_NAME: "Comando",
            GIT_COMMITTER_EMAIL: "comando@example.com",
            GIT_COMMITTER_NAME: "Comando",
        },
    });

    if (result.status !== 0) {
        throw new Error(
            [`git ${args.join(" ")}`, result.stdout, result.stderr]
                .filter(Boolean)
                .join("\n"),
        );
    }
}
