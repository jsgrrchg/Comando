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
import type { GitGateway } from "../git/service";
import type { GitRepositorySnapshot, GitStatusSnapshot } from "../git/types";
import {
    NATIVE_GIT_ENABLED_ENV,
    NATIVE_GIT_MODE_ENV,
    NATIVE_GIT_MUTATIONS_ENV,
    NATIVE_GIT_NETWORK_ENV,
    NativeGitGateway,
    NativeGitRoutingGateway,
    resolveNativeGitMode,
    shouldUseNativeGitMutations,
    shouldUseNativeGitNetwork,
    shouldUseNativeGitReads,
    shouldUseNativeGitShadow,
} from "./git";

const fixtureRoot = path.join(process.cwd(), "fixtures", "native-backend", "git");

type TestGitGateway = GitGateway & {
    close(): Promise<void>;
    readonly calls: Record<string, ReturnType<typeof vi.fn>>;
};

describe("native git flags", () => {
    it("defaults off and defaults enabled git to shadow", () => {
        expect(resolveNativeGitMode({})).toBeNull();
        expect(resolveNativeGitMode({ [NATIVE_GIT_ENABLED_ENV]: "1" })).toBe(
            "shadow",
        );
        expect(
            resolveNativeGitMode({
                [NATIVE_GIT_ENABLED_ENV]: "1",
                [NATIVE_GIT_MODE_ENV]: "read",
            }),
        ).toBe("read");
        expect(
            resolveNativeGitMode({
                [NATIVE_GIT_ENABLED_ENV]: "1",
                [NATIVE_GIT_MODE_ENV]: "write",
            }),
        ).toBe("write");
    });

    it("separates reads, shadow, mutations, and network routing", () => {
        expect(
            shouldUseNativeGitReads({
                [NATIVE_GIT_ENABLED_ENV]: "1",
                [NATIVE_GIT_MODE_ENV]: "read",
            }),
        ).toBe(true);
        expect(
            shouldUseNativeGitShadow({
                [NATIVE_GIT_ENABLED_ENV]: "1",
            }),
        ).toBe(true);
        expect(
            shouldUseNativeGitMutations({
                [NATIVE_GIT_ENABLED_ENV]: "1",
                [NATIVE_GIT_MODE_ENV]: "write",
            }),
        ).toBe(false);
        expect(
            shouldUseNativeGitMutations({
                [NATIVE_GIT_ENABLED_ENV]: "1",
                [NATIVE_GIT_MODE_ENV]: "write",
                [NATIVE_GIT_MUTATIONS_ENV]: "1",
            }),
        ).toBe(true);
        expect(
            shouldUseNativeGitNetwork({
                [NATIVE_GIT_ENABLED_ENV]: "1",
                [NATIVE_GIT_MODE_ENV]: "write",
                [NATIVE_GIT_MUTATIONS_ENV]: "1",
                [NATIVE_GIT_NETWORK_ENV]: "1",
            }),
        ).toBe(true);
    });
});

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

describe("NativeGitRoutingGateway", () => {
    it("routes reads to native in read mode while keeping mutations on legacy", async () => {
        const legacy = mainGitGateway("legacy");
        const native = mainGitGateway("native");
        const gateway = new NativeGitRoutingGateway({
            env: {
                [NATIVE_GIT_ENABLED_ENV]: "1",
                [NATIVE_GIT_MODE_ENV]: "read",
            },
            legacy,
            native,
        });

        await expect(
            gateway.getRepositorySnapshot("/tmp/comando-project"),
        ).resolves.toMatchObject({
            branches: [{ commit: "native" }],
        });
        await gateway.stagePaths("/tmp/comando-project", ["src/main.ts"]);

        expect(native.calls.getRepositorySnapshot).toHaveBeenCalledOnce();
        expect(legacy.calls.getRepositorySnapshot).not.toHaveBeenCalled();
        expect(legacy.calls.stagePaths).toHaveBeenCalledOnce();
        expect(native.calls.stagePaths).not.toHaveBeenCalled();
    });

    it("keeps shadow reads on legacy and reports parity mismatches", async () => {
        const diagnostics: string[] = [];
        const legacy = mainGitGateway("legacy");
        const native = mainGitGateway("native", {
            statusCounts: {
                conflicted: 0,
                staged: 0,
                untracked: 0,
                unstaged: 2,
            },
        });
        const gateway = new NativeGitRoutingGateway({
            env: { [NATIVE_GIT_ENABLED_ENV]: "1" },
            legacy,
            native,
            onDiagnostic: (message) => {
                diagnostics.push(message);
            },
        });

        await expect(
            gateway.getRepositorySnapshot("/tmp/comando-project"),
        ).resolves.toMatchObject({
            branches: [{ commit: "legacy" }],
        });
        await flushPromises();

        expect(legacy.calls.getRepositorySnapshot).toHaveBeenCalledOnce();
        expect(native.calls.getRepositorySnapshot).toHaveBeenCalledOnce();
        expect(diagnostics[0]).toContain("shadow mismatch getRepositorySnapshot");
    });

    it("routes local and network mutations only when their flags are enabled", async () => {
        const legacy = mainGitGateway("legacy");
        const native = mainGitGateway("native");
        const localGateway = new NativeGitRoutingGateway({
            env: {
                [NATIVE_GIT_ENABLED_ENV]: "1",
                [NATIVE_GIT_MODE_ENV]: "write",
                [NATIVE_GIT_MUTATIONS_ENV]: "1",
            },
            legacy,
            native,
        });

        await localGateway.stagePaths("/tmp/comando-project", ["src/main.ts"]);
        await localGateway.fetch("/tmp/comando-project");

        expect(native.calls.stagePaths).toHaveBeenCalledOnce();
        expect(legacy.calls.fetch).toHaveBeenCalledOnce();
        expect(native.calls.fetch).not.toHaveBeenCalled();

        const networkGateway = new NativeGitRoutingGateway({
            env: {
                [NATIVE_GIT_ENABLED_ENV]: "1",
                [NATIVE_GIT_MODE_ENV]: "write",
                [NATIVE_GIT_MUTATIONS_ENV]: "1",
                [NATIVE_GIT_NETWORK_ENV]: "1",
            },
            legacy,
            native,
        });

        await networkGateway.fetch("/tmp/comando-project");

        expect(native.calls.fetch).toHaveBeenCalledOnce();
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

function mainGitGateway(
    commit: string,
    options: {
        readonly statusCounts?: GitStatusSnapshot["counts"];
    } = {},
): TestGitGateway {
    const snapshot = mainSnapshot(commit, options.statusCounts);
    const status = snapshot.status;
    const calls = {
        checkoutBranch: vi.fn(() => Promise.resolve(snapshot)),
        clear: vi.fn(),
        close: vi.fn(() => Promise.resolve()),
        commit: vi.fn(() => Promise.resolve({ commitSha: commit, snapshot })),
        createWorktree: vi.fn(() => Promise.resolve(snapshot)),
        deleteLocalBranch: vi.fn(() => Promise.resolve(snapshot)),
        deleteRemoteBranch: vi.fn(() => Promise.resolve(snapshot)),
        discardPaths: vi.fn(() => Promise.resolve(snapshot)),
        fetch: vi.fn(() => Promise.resolve(snapshot)),
        getCommitDetail: vi.fn(() =>
            Promise.resolve({
                authorEmail: "ada@example.invalid",
                authorName: "Ada Lovelace",
                authoredAt: "2026-06-20T00:00:00.000Z",
                body: "",
                changedFileCount: 1,
                committedAt: "2026-06-20T00:00:00.000Z",
                committerEmail: "ada@example.invalid",
                committerName: "Ada Lovelace",
                deletions: 0,
                files: [],
                insertions: 1,
                parentShas: [],
                refs: [],
                sha: commit,
                shortSha: commit.slice(0, 7),
                subject: "Initial commit",
            }),
        ),
        getDiffStats: vi.fn(() => Promise.resolve([])),
        getFileDiff: vi.fn(() =>
            Promise.resolve({
                changedPath: "src/main.ts",
                hunks: [],
                isBinary: false,
                previousPath: null,
                raw: "",
                staged: false,
                summary: { deletions: 0, insertions: 1 },
            }),
        ),
        getFileText: vi.fn(() =>
            Promise.resolve("export const answer = 42;\n"),
        ),
        getRepositorySnapshot: vi.fn(() => Promise.resolve(snapshot)),
        getStatus: vi.fn(() => Promise.resolve(status)),
        getSyncStatus: vi.fn(() => Promise.resolve(status.sync)),
        initRepository: vi.fn(() => Promise.resolve(snapshot)),
        invalidate: vi.fn(),
        listBranches: vi.fn(() => Promise.resolve(snapshot.branches)),
        listHistory: vi.fn(() =>
            Promise.resolve({
                commits: [
                    {
                        authorEmail: "ada@example.invalid",
                        authorName: "Ada Lovelace",
                        authoredAt: "2026-06-20T00:00:00.000Z",
                        body: "",
                        parentShas: [],
                        refs: [],
                        sha: commit,
                        shortSha: commit.slice(0, 7),
                        subject: "Initial commit",
                    },
                ],
                matchedCount: 1,
                totalCount: 1,
            }),
        ),
        listRemotes: vi.fn(() => Promise.resolve([])),
        listWorktrees: vi.fn(() => Promise.resolve(snapshot.worktrees)),
        pull: vi.fn(() => Promise.resolve(snapshot)),
        push: vi.fn(() => Promise.resolve(snapshot)),
        removeWorktree: vi.fn(() => Promise.resolve(snapshot)),
        resolveRepository: vi.fn(() => Promise.resolve(snapshot.resolution)),
        stagePaths: vi.fn(() => Promise.resolve(snapshot)),
        unstagePaths: vi.fn(() => Promise.resolve(snapshot)),
    };

    return {
        ...calls,
        calls,
    };
}

function mainSnapshot(
    commit: string,
    counts: GitStatusSnapshot["counts"] = {
        conflicted: 0,
        staged: 0,
        untracked: 0,
        unstaged: 1,
    },
): GitRepositorySnapshot {
    return {
        branches: [
            {
                commit,
                current: true,
                isRemote: false,
                label: "main",
                linkedWorkTree: false,
                name: "main",
                worktreePath: null,
            },
        ],
        fetchedAt: "2026-06-20T00:00:00.000Z",
        resolution: {
            canonicalRootPath: "/tmp/comando-project",
            gitDirPath: "/tmp/comando-project/.git",
            inputPath: "/tmp/comando-project",
            isBare: false,
            isWorkTree: true,
            message: null,
            state: "ready",
        },
        status: {
            counts,
            entries: [
                {
                    conflicted: false,
                    id: "git-change:src/main.ts",
                    isBinary: false,
                    isRenamed: false,
                    kind: "modified",
                    name: "main.ts",
                    parentRelativePath: "src",
                    previousPath: null,
                    relativePath: "src/main.ts",
                    scopes: ["unstaged"],
                    statusIndex: " ",
                    statusWorkingDir: "M",
                },
            ],
            hasConflicts: counts.conflicted > 0,
            hasStaged: counts.staged > 0,
            hasUnstaged: counts.unstaged > 0,
            hasUntracked: counts.untracked > 0,
            isClean:
                counts.conflicted + counts.staged + counts.unstaged + counts.untracked ===
                0,
            sync: {
                ahead: 0,
                behind: 0,
                branchName: "main",
                commit,
                detached: false,
                trackingBranchName: null,
            },
            tree: [],
        },
        worktrees: [],
    };
}

async function flushPromises(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}
