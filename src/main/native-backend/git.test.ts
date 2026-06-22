import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
    NativeGitCommitDetail,
    NativeGitDiffStatRecord,
    NativeGitFileDiff,
    NativeGitHistoryListResult,
    NativeGitOperationResult,
    NativeGitOriginalFile,
    NativeGitRemoteSummary,
    NativeGitRepositorySnapshot,
    NativeGitStatusSnapshot,
} from "@shared/native-backend";

import type { NativeBackendRequester } from "./persistence";
import { NativeGitGateway } from "./git";

const fixtureRoot = path.join(process.cwd(), "fixtures", "native-backend", "git");

describe("NativeGitGateway", () => {
    it("adapts native repository snapshots to the main GitGateway model", async () => {
        const gateway = gatewayWith(
            vi.fn((command: string) => {
                if (command === "git_get_diff_stats") {
                    return [fixture<NativeGitDiffStatRecord>("diff.stat.json")];
                }

                if (command === "git_list_remotes") {
                    return [fixture<NativeGitRemoteSummary>("remote.summary.json")];
                }

                return fixture<NativeGitRepositorySnapshot>(
                    "repository.snapshot.json",
                );
            }),
        );

        await expect(
            gateway.getRepositorySnapshot("/tmp/comando-project"),
        ).resolves.toMatchObject({
            branches: [
                {
                    commit: "1111111111111111111111111111111111111111",
                    current: true,
                    name: "main",
                },
            ],
            resolution: {
                canonicalRootPath: "/tmp/comando-project",
                state: "ready",
            },
            status: {
                entries: [
                    {
                        kind: "modified",
                        relativePath: "src/main.ts",
                        scopes: ["unstaged"],
                    },
                ],
                sync: {
                    ahead: 1,
                    branchName: "main",
                },
            },
            worktrees: [
                {
                    branchName: "main",
                    headCommit: "1111111111111111111111111111111111111111",
                    isMain: true,
                    path: "/tmp/comando-project",
                },
            ],
        });

        await expect(
            gateway.listRemotes("/tmp/comando-project", "origin/main", 1, 0),
        ).resolves.toEqual([
            expect.objectContaining({
                isDefault: true,
                name: "origin",
                refName: "origin/main",
            }),
        ]);
    });

    it("maps file diff options and native diff hunks", async () => {
        const requestMock = vi.fn(() =>
            fixture<NativeGitFileDiff>("diff.file.json"),
        );
        const gateway = gatewayWith(requestMock);

        await expect(
            gateway.getFileDiff("/tmp/comando-project", "src/main.ts", {
                kind: "typechanged",
                previousPath: "src/old-main.ts",
                scope: "staged",
                staged: true,
            }),
        ).resolves.toMatchObject({
            changedPath: "src/main.ts",
            hunks: [
                {
                    lines: [
                        { text: "export const answer = 41;", type: "remove" },
                        { text: "export const answer = 42;", type: "add" },
                    ],
                },
            ],
            previousPath: null,
            staged: false,
            summary: { deletions: 1, insertions: 1 },
        });

        expect(requestMock).toHaveBeenCalledWith(
            "git_get_file_diff",
            expect.objectContaining({
                changeKind: "typechange",
                diffScope: "staged",
                path: "src/main.ts",
                previousPath: "src/old-main.ts",
                staged: true,
            }),
        );
    });

    it("detects diff kind and scope when callers omit file diff options", async () => {
        const requestMock = vi.fn((command: string) => {
            if (command === "git_get_status") {
                return {
                    ...fixture<NativeGitStatusSnapshot>("status.snapshot.json"),
                    entries: [
                        {
                            ...fixture<NativeGitStatusSnapshot>(
                                "status.snapshot.json",
                            ).entries[0],
                            kind: "untracked",
                            path: "src/new.ts",
                            scopes: ["untracked"],
                        },
                    ],
                } satisfies NativeGitStatusSnapshot;
            }

            return {
                ...fixture<NativeGitFileDiff>("diff.file.json"),
                path: "src/new.ts",
            };
        });
        const gateway = gatewayWith(requestMock);

        await gateway.getFileDiff("/tmp/comando-project", "src/new.ts");

        expect(requestMock).toHaveBeenCalledWith(
            "git_get_file_diff",
            expect.objectContaining({
                changeKind: "untracked",
                diffScope: "untracked",
                path: "src/new.ts",
                staged: false,
            }),
        );
    });

    it("adapts history, commit detail, original text, and mutation snapshots", async () => {
        const snapshot = fixture<NativeGitRepositorySnapshot>(
            "repository.snapshot.json",
        );
        const requestMock = vi.fn((command: string) => {
            if (command === "git_get_history") {
                return fixture<NativeGitHistoryListResult>("history.list.json");
            }

            if (command === "git_get_commit_detail") {
                return fixture<NativeGitCommitDetail>("commit.detail.json");
            }

            if (command === "git_get_original_file") {
                return fixture<NativeGitOriginalFile>("original_file.json");
            }

            return {
                commitSha: "2222222222222222222222222222222222222222",
                message: null,
                ok: true,
                snapshot,
                updatedAt: "2026-06-20T00:00:00.000Z",
            } satisfies NativeGitOperationResult;
        });
        const gateway = gatewayWith(requestMock);

        await expect(gateway.listHistory("/tmp/comando-project")).resolves.toEqual({
            commits: [
                expect.objectContaining({
                    refs: [{ kind: "head", label: "HEAD -> main" }],
                    subject: "Initial commit",
                }),
            ],
            matchedCount: 1,
            totalCount: 1,
        });
        await expect(
            gateway.getCommitDetail(
                "/tmp/comando-project",
                "1111111111111111111111111111111111111111",
            ),
        ).resolves.toMatchObject({
            changedFileCount: 1,
            files: [{ kind: "create", path: "src/main.ts" }],
        });
        await expect(
            gateway.getFileText("/tmp/comando-project", "src/main.ts", "index"),
        ).resolves.toBe("export const answer = 41;\n");
        await expect(
            gateway.commit("/tmp/comando-project", "Native commit", {
                noVerify: true,
            }),
        ).resolves.toMatchObject({
            commitSha: "2222222222222222222222222222222222222222",
            snapshot: {
                resolution: { state: "ready" },
            },
        });
        await gateway.checkoutBranch("/tmp/comando-project", {
            branchName: "main",
            newBranchName: "feature/current",
        });
        await gateway.createWorktree("/tmp/comando-project", {
            branchName: "feature/worktree",
            path: "/tmp/feature-worktree",
        });
        await gateway.createWorktree("/tmp/comando-project", {
            branchName: "feature/existing",
            path: "/tmp/existing-worktree",
            startPoint: null,
        });

        expect(requestMock).toHaveBeenCalledWith(
            "git_commit",
            expect.objectContaining({
                message: "Native commit",
                noVerify: true,
            }),
        );
        expect(requestMock).toHaveBeenCalledWith(
            "git_checkout_branch",
            expect.objectContaining({
                branchName: "main",
                newBranchName: "feature/current",
                startPoint: "main",
            }),
        );
        expect(requestMock).toHaveBeenCalledWith(
            "git_create_worktree",
            expect.objectContaining({
                branchName: "feature/worktree",
                startPoint: "feature/worktree",
            }),
        );
        expect(requestMock).toHaveBeenCalledWith(
            "git_create_worktree",
            expect.objectContaining({
                branchName: "feature/existing",
                startPoint: null,
            }),
        );
    });
});

function gatewayWith(
    requestMock: (
        command: string,
        args?: Record<string, unknown>,
    ) => unknown,
): NativeGitGateway {
    const request: NativeBackendRequester["request"] = async (...args) =>
        (await Promise.resolve(requestMock(...args))) as never;
    return new NativeGitGateway({ request });
}

function fixture<T>(name: string): T {
    return JSON.parse(readFileSync(path.join(fixtureRoot, name), "utf8")) as T;
}
