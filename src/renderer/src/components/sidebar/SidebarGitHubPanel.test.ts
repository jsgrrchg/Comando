// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
    GitBranchSummary,
    GitHubIssueSummary,
    GitHubPullRequestSummary,
    GitHubRepositoryRef,
    GitRemoteSummary,
    GitRepositorySnapshot,
    GitWorktreeSummary,
} from "@shared/ipc";

import {
    buildSidebarGitHubComposerParts,
    getSidebarGitHubAddToChatLabel,
    getSidebarGitHubContextNumbers,
    getSidebarGitHubDragItems,
    getGitHubRepositorySnapshot,
    getProjectSnapshot,
    reconcileSidebarGitHubSelection,
    resolveSidebarGitHubItemClickSelection,
    SidebarGitHubDraggableRow,
    shouldOpenSidebarGitHubItemClick,
} from "./SidebarGitHubPanel";
import {
    SIDEBAR_GITHUB_DRAG_EVENT,
    type SidebarGitHubDragDetail,
} from "./sidebarGitHubDragEvents";

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

afterEach(() => {
    for (const root of mountedRoots.splice(0)) {
        act(() => {
            root.unmount();
        });
    }
    for (const container of mountedContainers.splice(0)) {
        container.remove();
    }
    vi.restoreAllMocks();
});

function createBranch(
    overrides: Partial<GitBranchSummary> = {},
): GitBranchSummary {
    return {
        aheadBy: 0,
        behindBy: 0,
        commitSha: "abc1234567890",
        isCurrent: true,
        isDetached: false,
        isRemote: false,
        kind: "branch",
        name: "main",
        upstreamName: "origin/main",
        ...overrides,
    };
}

function createRemote(
    overrides: Partial<GitRemoteSummary> = {},
): GitRemoteSummary {
    return {
        aheadBy: 0,
        behindBy: 0,
        fetchUrl: "https://github.com/example/comando.git",
        isDefault: true,
        name: "origin",
        pushUrl: "https://github.com/example/comando.git",
        refName: "origin/main",
        ...overrides,
    };
}

function createWorktree(
    overrides: Partial<GitWorktreeSummary> = {},
): GitWorktreeSummary {
    return {
        branchName: "main",
        commitSha: "abc1234567890",
        id: "project-1:primary",
        isBare: false,
        isCurrent: true,
        isLocked: false,
        isPrimary: true,
        lockedReason: null,
        projectId: "project-1",
        rootPath: "/tmp/Comando",
        updatedAt: "2026-04-19T00:00:00.000Z",
        ...overrides,
    };
}

function createSnapshot(
    overrides: Partial<GitRepositorySnapshot> = {},
): GitRepositorySnapshot {
    return {
        aheadBy: 0,
        behindBy: 0,
        branch: createBranch(),
        branches: [],
        canonicalRootPath: "/tmp/Comando",
        changedPaths: [],
        changes: [],
        currentWorktreeId: null,
        defaultTreeViewMode: "tree",
        headSha: "abc1234567890",
        projectId: "project-1",
        remotes: [createRemote()],
        repositoryState: "ready",
        rootPath: "/tmp/Comando",
        selectedRemoteName: "origin",
        status: {
            changedCount: 0,
            conflictedCount: 0,
            stagedCount: 0,
            unstagedCount: 0,
            untrackedCount: 0,
        },
        syncStatus: "in_sync",
        updatedAt: "2026-04-19T00:00:00.000Z",
        worktrees: [createWorktree()],
        ...overrides,
    };
}

const repoRef: GitHubRepositoryRef = {
    host: "github.com",
    owner: "example",
    repo: "comando",
};

function createIssue(
    overrides: Partial<GitHubIssueSummary> = {},
): GitHubIssueSummary {
    const number = overrides.number ?? 1;
    return {
        assignees: [],
        author: null,
        closedAt: null,
        commentCount: 0,
        createdAt: "2026-04-19T00:00:00.000Z",
        id: number,
        isLocked: false,
        labels: [],
        milestone: null,
        nodeId: `issue-${number}`,
        number,
        state: "open",
        stateReason: null,
        title: `Issue ${number}`,
        updatedAt: "2026-04-19T00:00:00.000Z",
        url: `https://github.com/example/comando/issues/${number}`,
        ...overrides,
    };
}

function createPullRequest(
    overrides: Partial<GitHubPullRequestSummary> = {},
): GitHubPullRequestSummary {
    const number = overrides.number ?? 1;
    return {
        additions: null,
        author: null,
        base: {
            label: "example:main",
            ref: "main",
            repository: repoRef,
            sha: "base",
        },
        changedFileCount: null,
        closedAt: null,
        commentCount: 0,
        commitCount: null,
        createdAt: "2026-04-19T00:00:00.000Z",
        deletions: null,
        draft: false,
        head: {
            label: "example:feature",
            ref: "feature",
            repository: repoRef,
            sha: "head",
        },
        id: number,
        labels: [],
        mergedAt: null,
        nodeId: `pr-${number}`,
        number,
        state: "open",
        title: `Pull Request ${number}`,
        updatedAt: "2026-04-19T00:00:00.000Z",
        url: `https://github.com/example/comando/pull/${number}`,
        ...overrides,
    };
}

describe("SidebarGitHubPanel snapshot helpers", () => {
    it("does not use a project fallback for the branch snapshot of a missing worktree", () => {
        const primarySnapshot = createSnapshot({
            branch: createBranch({ name: "main" }),
            worktrees: [
                createWorktree(),
                createWorktree({
                    branchName: "feature/github-panel",
                    id: "worktree-feature",
                    isCurrent: false,
                    isPrimary: false,
                    rootPath: "/tmp/Comando-feature",
                }),
            ],
        });

        const snapshots = {
            "project-1::primary": primarySnapshot,
        };

        expect(
            getProjectSnapshot(snapshots, "project-1", "worktree-feature"),
        ).toBeNull();
    });

    it("uses a project snapshot fallback for GitHub repository identity", () => {
        const primarySnapshot = createSnapshot({
            remotes: [
                createRemote({
                    fetchUrl: "git@github.com:example/comando.git",
                    pushUrl: "git@github.com:example/comando.git",
                }),
            ],
            worktrees: [
                createWorktree(),
                createWorktree({
                    branchName: "feature/github-panel",
                    id: "worktree-feature",
                    isCurrent: false,
                    isPrimary: false,
                    rootPath: "/tmp/Comando-feature",
                }),
            ],
        });

        const snapshots = {
            "project-1::primary": primarySnapshot,
        };

        expect(
            getGitHubRepositorySnapshot(
                snapshots,
                "project-1",
                "worktree-feature",
            ),
        ).toBe(primarySnapshot);
    });

    it("prefers the direct worktree snapshot for GitHub repository identity", () => {
        const primarySnapshot = createSnapshot({
            branch: createBranch({ name: "main" }),
        });
        const worktreeSnapshot = createSnapshot({
            branch: createBranch({ name: "feature/github-panel" }),
            currentWorktreeId: "worktree-feature",
            rootPath: "/tmp/Comando-feature",
            worktrees: [
                createWorktree({
                    branchName: "feature/github-panel",
                    id: "worktree-feature",
                    rootPath: "/tmp/Comando-feature",
                }),
            ],
        });

        const snapshots = {
            "project-1::primary": primarySnapshot,
            "project-1::worktree-feature": worktreeSnapshot,
        };

        expect(
            getGitHubRepositorySnapshot(
                snapshots,
                "project-1",
                "worktree-feature",
            ),
        ).toBe(worktreeSnapshot);
    });
});

describe("SidebarGitHubPanel selection helpers", () => {
    it("selects a visible shift range from the anchor", () => {
        expect(
            resolveSidebarGitHubItemClickSelection({
                anchorNumber: 2,
                isRangeSelection: true,
                isToggleSelection: false,
                itemNumber: 5,
                selectedNumbers: [],
                visibleNumbers: [1, 2, 3, 4, 5],
            }),
        ).toEqual({
            anchorNumber: 2,
            selectedNumbers: [2, 3, 4, 5],
        });
    });

    it("toggles a single item and moves the anchor", () => {
        expect(
            resolveSidebarGitHubItemClickSelection({
                anchorNumber: 2,
                isRangeSelection: false,
                isToggleSelection: true,
                itemNumber: 4,
                selectedNumbers: [2, 3],
                visibleNumbers: [1, 2, 3, 4],
            }),
        ).toEqual({
            anchorNumber: 4,
            selectedNumbers: [2, 3, 4],
        });
    });

    it("keeps normal click as open-first while preserving a range anchor", () => {
        expect(
            resolveSidebarGitHubItemClickSelection({
                anchorNumber: 2,
                isRangeSelection: false,
                isToggleSelection: false,
                itemNumber: 4,
                selectedNumbers: [2, 3],
                visibleNumbers: [1, 2, 3, 4],
            }),
        ).toEqual({
            anchorNumber: 4,
            selectedNumbers: [],
        });
    });

    it("reconciles selection against the visible list", () => {
        expect(
            reconcileSidebarGitHubSelection({
                anchorNumber: 4,
                selectedNumbers: [2, 3, 4],
                visibleNumbers: [1, 3, 5],
            }),
        ).toEqual({
            anchorNumber: null,
            selectedNumbers: [3],
        });
    });

    it("uses the whole selected range for context when right-clicking a selected item", () => {
        expect(
            getSidebarGitHubContextNumbers({
                itemNumber: 3,
                selectedNumbers: [4, 2, 3],
                visibleNumbers: [1, 2, 3, 4, 5],
            }),
        ).toEqual([2, 3, 4]);
    });

    it("uses only the target item for context when it is outside selection", () => {
        expect(
            getSidebarGitHubContextNumbers({
                itemNumber: 5,
                selectedNumbers: [2, 3],
                visibleNumbers: [1, 2, 3, 4, 5],
            }),
        ).toEqual([5]);
    });

    it("drags the ordered selected items when the dragged issue is selected", () => {
        expect(
            getSidebarGitHubDragItems({
                item: createIssue({ number: 3, title: "Third" }),
                selectedNumbers: [4, 2, 3],
                visibleItems: [
                    createIssue({ number: 1, title: "First" }),
                    createIssue({ number: 2, title: "Second" }),
                    createIssue({ number: 3, title: "Third" }),
                    createIssue({ number: 4, title: "Fourth" }),
                ],
                visibleNumbers: [1, 2, 3, 4],
            }),
        ).toEqual([
            { number: 2, title: "Second" },
            { number: 3, title: "Third" },
            { number: 4, title: "Fourth" },
        ]);
    });

    it("drags only the target item when it is outside selection", () => {
        expect(
            getSidebarGitHubDragItems({
                item: createPullRequest({ number: 5, title: "Fifth" }),
                selectedNumbers: [2, 3],
                visibleItems: [
                    createPullRequest({ number: 2, title: "Second" }),
                    createPullRequest({ number: 3, title: "Third" }),
                    createPullRequest({ number: 5, title: "Fifth" }),
                ],
                visibleNumbers: [2, 3, 5],
            }),
        ).toEqual([{ number: 5, title: "Fifth" }]);
    });

    it("opens items only on unmodified clicks", () => {
        expect(
            shouldOpenSidebarGitHubItemClick({
                ctrlKey: false,
                metaKey: false,
                shiftKey: false,
            }),
        ).toBe(true);

        expect(
            shouldOpenSidebarGitHubItemClick({
                ctrlKey: false,
                metaKey: false,
                shiftKey: true,
            }),
        ).toBe(false);
        expect(
            shouldOpenSidebarGitHubItemClick({
                ctrlKey: false,
                metaKey: true,
                shiftKey: false,
            }),
        ).toBe(false);
        expect(
            shouldOpenSidebarGitHubItemClick({
                ctrlKey: true,
                metaKey: false,
                shiftKey: false,
            }),
        ).toBe(false);
    });
});

describe("SidebarGitHubDraggableRow", () => {
    it("keeps an active drag alive across rerenders with new drag item arrays", () => {
        const releasePointerCapture = vi.fn();
        const setPointerCapture = vi.fn();
        const events: SidebarGitHubDragDetail[] = [];
        const handleDrag = (event: Event) => {
            events.push(
                (event as CustomEvent<SidebarGitHubDragDetail>).detail,
            );
        };
        window.addEventListener(SIDEBAR_GITHUB_DRAG_EVENT, handleDrag);

        const container = document.createElement("div");
        document.body.append(container);
        mountedContainers.push(container);
        const root = createRoot(container);
        mountedRoots.push(root);

        const renderRow = (title: string) => {
            act(() => {
                root.render(
                    createElement(
                        SidebarGitHubDraggableRow,
                        {
                            children: createElement("span", null, title),
                            dragItems: [{ number: 7, title }],
                            itemKind: "issue",
                            meta: "#7 - 1 comment",
                            number: 7,
                            onOpen: () => undefined,
                            projectId: "project-1",
                            repoRef,
                            selected: false,
                            title,
                            worktreeId: "project-1:primary",
                        },
                    ),
                );
            });
        };

        try {
            renderRow("First title");
            const row = container.querySelector<HTMLElement>("[role='button']");
            expect(row).not.toBeNull();
            if (!row) {
                throw new Error("Expected draggable row to render.");
            }

            row.setPointerCapture = setPointerCapture;
            row.releasePointerCapture = releasePointerCapture;

            act(() => {
                row.dispatchEvent(
                    new PointerEvent("pointerdown", {
                        bubbles: true,
                        button: 0,
                        buttons: 1,
                        clientX: 10,
                        clientY: 10,
                        pointerId: 4,
                    }),
                );
                row.dispatchEvent(
                    new PointerEvent("pointermove", {
                        bubbles: true,
                        buttons: 1,
                        clientX: 26,
                        clientY: 10,
                        pointerId: 4,
                    }),
                );
            });

            renderRow("Second title");

            act(() => {
                window.dispatchEvent(
                    new PointerEvent("pointerup", {
                        bubbles: true,
                        button: 0,
                        buttons: 0,
                        clientX: 32,
                        clientY: 10,
                        pointerId: 4,
                    }),
                );
            });

            expect(events.map((event) => event.phase)).toEqual([
                "start",
                "end",
            ]);
            expect(events[0]).toMatchObject({
                items: [{ number: 7, title: "First title" }],
                number: 7,
                title: "First title",
            });
            expect(events[1]).toMatchObject({
                items: [{ number: 7, title: "First title" }],
                number: 7,
                title: "First title",
            });
            expect(setPointerCapture).toHaveBeenCalledWith(4);
            expect(releasePointerCapture).toHaveBeenCalledWith(4);
        } finally {
            window.removeEventListener(SIDEBAR_GITHUB_DRAG_EVENT, handleDrag);
        }
    });
});

describe("SidebarGitHubPanel chat helpers", () => {
    it("pluralizes issue and pull request add-to-chat labels", () => {
        expect(
            getSidebarGitHubAddToChatLabel({
                count: 3,
                forceNewChat: false,
                kind: "issues",
            }),
        ).toBe("Add 3 Issues to Chat");
        expect(
            getSidebarGitHubAddToChatLabel({
                count: 2,
                forceNewChat: true,
                kind: "pull_requests",
            }),
        ).toBe("Add 2 Pull Requests to New Chat");
    });

    it("builds issue mention pills for add-to-chat payloads", () => {
        expect(
            buildSidebarGitHubComposerParts(
                repoRef,
                [
                    createIssue({ number: 7, title: "Crash on launch" }),
                    createIssue({ number: 8, title: "Slow indexing" }),
                ],
                "issues",
            ),
        ).toEqual([
            { text: "", type: "text" },
            {
                host: "github.com",
                label: "#7",
                number: 7,
                owner: "example",
                repo: "comando",
                title: "Crash on launch",
                type: "github_issue_mention",
                url: "https://github.com/example/comando/issues/7",
            },
            { text: " ", type: "text" },
            {
                host: "github.com",
                label: "#8",
                number: 8,
                owner: "example",
                repo: "comando",
                title: "Slow indexing",
                type: "github_issue_mention",
                url: "https://github.com/example/comando/issues/8",
            },
            { text: " ", type: "text" },
        ]);
    });

    it("builds pull request mention pills for add-to-new-chat payloads", () => {
        expect(
            buildSidebarGitHubComposerParts(
                repoRef,
                [createPullRequest({ number: 11, title: "Ship polish pass" })],
                "pull_requests",
            ),
        ).toEqual([
            { text: "", type: "text" },
            {
                host: "github.com",
                label: "PR #11",
                number: 11,
                owner: "example",
                repo: "comando",
                title: "Ship polish pass",
                type: "github_pull_request_mention",
                url: "https://github.com/example/comando/pull/11",
            },
            { text: " ", type: "text" },
        ]);
    });
});
