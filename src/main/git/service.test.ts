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

    it("lists history and commit details", async () => {
        const rootPath = createGitRepositoryFixture();

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

        const service = new GitService({ cacheSnapshots: false });
        const history = await service.listHistory(rootPath, { limit: 10 });
        const latestCommit = history[0];

        expect(history).toHaveLength(2);
        expect(latestCommit?.subject).toBe("update docs");
        expect(latestCommit?.shortSha).toMatch(/[0-9a-f]{7}/i);
        expect(
            latestCommit?.refs.some((reference) =>
                reference.label.includes("main"),
            ),
        ).toBe(true);

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
    });

    it("classifies paths outside a repo as non-repository", async () => {
        const rootPath = createGitRepositoryFixture();
        const service = new GitService({ cacheSnapshots: false });
        const resolution = await service.resolveRepository(rootPath);

        expect(resolution.state).toBe("not_repo");
        expect(resolution.canonicalRootPath).toBeNull();
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
