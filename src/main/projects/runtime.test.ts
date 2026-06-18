import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import { ProjectRuntime } from "./runtime";

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { force: true, recursive: true });
    }
});

describe("ProjectRuntime Git ignore metadata", () => {
    it("marks visible ignored files and directories without dimming tracked files", async () => {
        const rootPath = createProjectFixture();
        const git = simpleGit(rootPath);

        await git.init();
        fs.writeFileSync(
            path.join(rootPath, ".gitignore"),
            "local.env\nlogs/\ntracked.env\n",
        );
        fs.writeFileSync(path.join(rootPath, "local.env"), "SECRET=value\n");
        fs.writeFileSync(path.join(rootPath, "tracked.env"), "TRACKED=value\n");
        fs.mkdirSync(path.join(rootPath, "logs"));
        fs.writeFileSync(path.join(rootPath, "logs", "app.log"), "boot\n");

        await git.add(".gitignore");
        await git.raw(["add", "-f", "tracked.env"]);

        const runtime = new ProjectRuntime({
            onProjectTreeInvalidated: () => undefined,
        });
        runtime.syncRegistry({
            projects: [{ id: "project-1", rootPath }],
            worktrees: [],
        });

        try {
            const rootNodes = await runtime.listProjectTreeChildren({
                parentRelativePath: null,
                projectId: "project-1",
                rootPath,
                worktreeId: null,
            });
            const allEntries = await runtime.listProjectEntries({
                projectId: "project-1",
                rootPath,
                worktreeId: null,
            });

            expect(findNode(rootNodes, "local.env")?.isGitIgnored).toBe(true);
            expect(findNode(rootNodes, "logs")?.isGitIgnored).toBe(true);
            expect(findNode(rootNodes, "tracked.env")?.isGitIgnored).toBe(
                false,
            );
            expect(
                allEntries.nodes.find(
                    (node) => node.relativePath === "logs/app.log",
                )?.isGitIgnored,
            ).toBe(true);
        } finally {
            runtime.close();
        }
    });

    it("includes ignored ancestor directory metadata for backend file tree search", async () => {
        const rootPath = createProjectFixture();
        const git = simpleGit(rootPath);

        await git.init();
        fs.writeFileSync(path.join(rootPath, ".gitignore"), "logs/\n");
        fs.mkdirSync(path.join(rootPath, "logs"));
        fs.writeFileSync(path.join(rootPath, "logs", "app.log"), "boot\n");

        const runtime = new ProjectRuntime({
            onProjectTreeInvalidated: () => undefined,
        });
        runtime.syncRegistry({
            projects: [{ id: "project-1", rootPath }],
            worktrees: [],
        });

        try {
            const results = await runtime.searchProjectEntries({
                includeAncestorDirectories: true,
                limit: 10,
                projectId: "project-1",
                query: "app.log",
                rootPath,
                worktreeId: null,
            });

            expect(
                results.nodes.map((node) => ({
                    isGitIgnored: node.isGitIgnored,
                    kind: node.kind,
                    relativePath: node.relativePath,
                })),
            ).toEqual([
                {
                    isGitIgnored: true,
                    kind: "directory",
                    relativePath: "logs",
                },
                {
                    isGitIgnored: true,
                    kind: "file",
                    relativePath: "logs/app.log",
                },
            ]);
        } finally {
            runtime.close();
        }
    });

    it("marks ignored entries whose names contain accents", async () => {
        const rootPath = createProjectFixture();
        const git = simpleGit(rootPath);
        const personalDirectory = ".personal";
        const accentedDirectory = "diagnósticos";

        await git.init();
        fs.writeFileSync(path.join(rootPath, ".gitignore"), ".personal/\n");
        fs.mkdirSync(path.join(rootPath, personalDirectory));
        fs.mkdirSync(path.join(rootPath, personalDirectory, accentedDirectory));

        const runtime = new ProjectRuntime({
            onProjectTreeInvalidated: () => undefined,
        });
        runtime.syncRegistry({
            projects: [{ id: "project-1", rootPath }],
            worktrees: [],
        });

        try {
            const rootNodes = await runtime.listProjectTreeChildren({
                parentRelativePath: null,
                projectId: "project-1",
                rootPath,
                worktreeId: null,
            });
            const personalNodes = await runtime.listProjectTreeChildren({
                parentRelativePath: personalDirectory,
                projectId: "project-1",
                rootPath,
                worktreeId: null,
            });

            expect(
                findNode(rootNodes, personalDirectory)?.isGitIgnored,
            ).toBe(true);
            expect(
                findNode(personalNodes, accentedDirectory)?.isGitIgnored,
            ).toBe(true);
        } finally {
            runtime.close();
        }
    });
});

function createProjectFixture(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "comando-"));
    temporaryDirectories.push(directory);
    return directory;
}

function findNode(
    nodes: readonly { readonly name: string }[],
    name: string,
): { readonly isGitIgnored: boolean } | null {
    return (
        nodes.find(
            (
                node,
            ): node is {
                readonly isGitIgnored: boolean;
                readonly name: string;
            } =>
                node.name === name,
        ) ?? null
    );
}
