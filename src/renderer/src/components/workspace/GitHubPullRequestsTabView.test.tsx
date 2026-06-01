import { createElement } from "react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    GitHubAuthStatus,
    GitHubPullRequestChecksResult,
    GitHubPullRequestSummary,
    GitHubRepositoryRef,
} from "@shared/ipc";
import type { RuntimeWorkspaceGitHubPullRequestsTab } from "@renderer/app/workspace/tree";

const REPO: GitHubRepositoryRef = {
    host: "github.com",
    owner: "octocat",
    repo: "hello-world",
};
const REPO_KEY = "github.com/octocat/hello-world";

const mockGitStoreState = vi.hoisted(() => ({
    current: {
        snapshots: {},
    },
}));

const mockGitHubStoreState = vi.hoisted(() => ({
    current: {
        authStatusByHost: {},
        createPullRequest: vi.fn(),
        errors: {},
        loadingKeys: {},
        mutatingKeys: {},
        pullRequestChecksByRepo: {},
        pullRequestListStateByRepo: {},
        pullRequestsByRepo: {},
        pullRequestsByRepoAndState: {},
        refreshAuthStatus: vi.fn(),
        refreshPullRequestChecks: vi.fn(),
        refreshPullRequests: vi.fn(),
    },
}));

const mockWorkspaceStoreState = vi.hoisted(() => ({
    current: {
        openGitHubPullRequestTab: vi.fn(async () => {}),
    },
}));

const measuredVirtualListMock = vi.hoisted(() => vi.fn());

vi.mock("@renderer/app/store/git-store", () => ({
    useGitStore: (
        selector: (state: typeof mockGitStoreState.current) => unknown,
    ) => selector(mockGitStoreState.current),
}));

vi.mock("@renderer/app/store/github-store", () => ({
    EMPTY_GITHUB_LIST: Object.freeze([]),
    EMPTY_GITHUB_RECORD: Object.freeze({}),
    getGitHubPullRequestChecksKey: (
        ref: GitHubRepositoryRef,
        headSha: string,
    ) => `${ref.host.toLowerCase()}/${ref.owner}/${ref.repo}:pr-checks:${headSha}`,
    getGitHubRepoKey: (ref: GitHubRepositoryRef) =>
        `${ref.host.toLowerCase()}/${ref.owner}/${ref.repo}`,
    useGitHubStore: (
        selector: (state: typeof mockGitHubStoreState.current) => unknown,
    ) => selector(mockGitHubStoreState.current),
}));

vi.mock("@renderer/app/store/workspace-store", () => ({
    useWorkspaceStore: (
        selector: (state: typeof mockWorkspaceStoreState.current) => unknown,
    ) => selector(mockWorkspaceStoreState.current),
}));

vi.mock("../virtual/MeasuredVirtualList", async () => {
    const { createElement } =
        await vi.importActual<typeof import("react")>("react");

    return {
        MeasuredVirtualList: <T,>({
            getItemKey,
            items,
            onRangeChange,
            renderItem,
        }: {
            readonly getItemKey: (item: T, index: number) => string;
            readonly items: readonly T[];
            readonly onRangeChange?: () => void;
            readonly renderItem: (params: {
                readonly index: number;
                readonly isVisible: boolean;
                readonly item: T;
            }) => ReactNode;
        }) => {
            measuredVirtualListMock({
                hasRangeChange: typeof onRangeChange === "function",
                itemCount: items.length,
            });

            return createElement(
                "div",
                { "data-testid": "mock-measured-virtual-list" },
                items.slice(0, 5).map((item, index) =>
                    createElement(
                        "div",
                        { key: getItemKey(item, index) },
                        renderItem({
                            index,
                            isVisible: true,
                            item,
                        }),
                    ),
                ),
            );
        },
    };
});

import {
    GITHUB_PULL_REQUESTS_ROW_VIRTUALIZATION_THRESHOLD,
    GITHUB_PULL_REQUESTS_VIRTUALIZATION_THRESHOLD,
    GitHubPullRequestsTabView,
    getVisiblePullRequestCheckTargets,
} from "./GitHubPullRequestsTabView";

class MemoryStorage implements Storage {
    private readonly values = new Map<string, string>();

    get length() {
        return this.values.size;
    }

    clear() {
        this.values.clear();
    }

    getItem(key: string) {
        return this.values.get(key) ?? null;
    }

    key(index: number) {
        return [...this.values.keys()][index] ?? null;
    }

    removeItem(key: string) {
        this.values.delete(key);
    }

    setItem(key: string, value: string) {
        this.values.set(key, value);
    }
}

const TAB: RuntimeWorkspaceGitHubPullRequestsTab = {
    createdAt: "2026-05-28T00:00:00.000Z",
    id: "github-pull-requests-tab-1",
    kind: "github_pull_requests",
    projectId: "project-1",
    ref: REPO,
    title: "Pull Requests",
    worktreeId: null,
};

function createAuthStatus(): GitHubAuthStatus {
    return {
        canReadActions: true,
        canWriteActions: true,
        canWriteIssues: true,
        canWritePullRequests: true,
        checkedAt: "2026-05-28T00:00:00.000Z",
        errorCode: null,
        host: REPO.host,
        readOnly: false,
        state: "authenticated",
        tokenSource: "gh_cli",
        user: {
            avatarUrl: null,
            id: 1,
            login: "octocat",
            url: "https://github.com/octocat",
        },
    };
}

function createPullRequestSummary(index: number): GitHubPullRequestSummary {
    return {
        additions: index,
        author: null,
        base: {
            label: "octocat:main",
            ref: "main",
            repository: REPO,
            sha: `base-${index}`,
        },
        changedFileCount: index % 7,
        closedAt: null,
        commentCount: index % 4,
        commitCount: index % 6,
        createdAt: `2026-05-${String(1 + (index % 28)).padStart(2, "0")}T00:00:00.000Z`,
        deletions: index % 3,
        draft: index % 11 === 0,
        head: {
            label: `octocat:feature-${index}`,
            ref: `feature-${index}`,
            repository: REPO,
            sha: `head-${index}`,
        },
        id: index,
        labels:
            index % 5 === 0
                ? [
                      {
                          color: "0e8a16",
                          description: "Baseline label",
                          id: index,
                          name: `stack-${index}`,
                      },
                  ]
                : [],
        mergedAt: null,
        nodeId: `PR_${index}`,
        number: index,
        state: "open",
        title: `Baseline pull request ${index}`,
        updatedAt: `2026-05-${String(1 + (index % 28)).padStart(2, "0")}T12:00:00.000Z`,
        url: `https://github.com/octocat/hello-world/pull/${index}`,
    };
}

function createPullRequestChecks(
    overrides: Partial<GitHubPullRequestChecksResult> = {},
): GitHubPullRequestChecksResult {
    return {
        checkedAt: "2026-05-28T00:00:00.000Z",
        checks: [],
        headSha: "head-1",
        pullRequestNumber: 1,
        state: "success",
        url: "https://github.com/octocat/hello-world/pull/1/checks",
        ...overrides,
    };
}

function resetStoreState() {
    mockGitStoreState.current.snapshots = {};
    mockGitHubStoreState.current.authStatusByHost = {
        [REPO.host]: createAuthStatus(),
    };
    mockGitHubStoreState.current.createPullRequest.mockClear();
    mockGitHubStoreState.current.errors = {};
    mockGitHubStoreState.current.loadingKeys = {};
    mockGitHubStoreState.current.mutatingKeys = {};
    mockGitHubStoreState.current.pullRequestChecksByRepo = {};
    mockGitHubStoreState.current.pullRequestListStateByRepo = {
        [REPO_KEY]: "open",
    };
    mockGitHubStoreState.current.pullRequestsByRepo = {};
    mockGitHubStoreState.current.pullRequestsByRepoAndState = {
        [REPO_KEY]: {
            open: Array.from(
                { length: GITHUB_PULL_REQUESTS_ROW_VIRTUALIZATION_THRESHOLD },
                (_, index) => createPullRequestSummary(index + 1),
            ),
        },
    };
    mockGitHubStoreState.current.refreshAuthStatus.mockClear();
    mockGitHubStoreState.current.refreshPullRequestChecks.mockClear();
    mockGitHubStoreState.current.refreshPullRequests.mockClear();
    mockWorkspaceStoreState.current.openGitHubPullRequestTab.mockClear();
    measuredVirtualListMock.mockClear();
}

describe("GitHubPullRequestsTabView", () => {
    beforeEach(() => {
        Object.defineProperty(globalThis, "localStorage", {
            configurable: true,
            value: new MemoryStorage(),
            writable: true,
        });
        resetStoreState();
    });

    it("virtualizes the large pull requests table with table affordances intact", () => {
        const markup = renderToStaticMarkup(
            createElement(GitHubPullRequestsTabView, { tab: TAB }),
        );

        expect(markup).toContain(
            `${GITHUB_PULL_REQUESTS_ROW_VIRTUALIZATION_THRESHOLD} items`,
        );
        expect(markup).toContain("Baseline pull request");
        expect(markup).not.toContain(
            `Baseline pull request ${GITHUB_PULL_REQUESTS_ROW_VIRTUALIZATION_THRESHOLD}`,
        );
        expect(measuredVirtualListMock).toHaveBeenCalledWith({
            hasRangeChange: true,
            itemCount: GITHUB_PULL_REQUESTS_ROW_VIRTUALIZATION_THRESHOLD,
        });
        expect(markup).toContain('aria-label="Resize # column"');
        expect(markup).toContain('aria-label="Resize Branch column"');
        expect(markup).toContain("Drag to reorder. Drag the edge to resize.");
        expect(markup).toContain("Open");
        expect(markup).toContain("height:58px");
        expect(markup).toContain("grid-template-columns:56px 420px 220px 140px 84px");
        expect(markup).toContain("min-width:920px");
        expect(markup).toContain("border-b border-border-subtle py-1.5");
    });

    it("renders every pull request below the virtualization threshold", () => {
        mockGitHubStoreState.current.pullRequestsByRepoAndState = {
            [REPO_KEY]: {
                open: Array.from(
                    {
                        length:
                            GITHUB_PULL_REQUESTS_VIRTUALIZATION_THRESHOLD - 1,
                    },
                    (_, index) => createPullRequestSummary(index + 1),
                ),
            },
        };

        const markup = renderToStaticMarkup(
            createElement(GitHubPullRequestsTabView, { tab: TAB }),
        );

        expect(markup).toContain(
            `${GITHUB_PULL_REQUESTS_VIRTUALIZATION_THRESHOLD - 1} items`,
        );
        expect(markup).toContain("Baseline pull request 1");
        expect(markup).toContain(
            `Baseline pull request ${
                GITHUB_PULL_REQUESTS_VIRTUALIZATION_THRESHOLD - 1
            }`,
        );
        expect(measuredVirtualListMock).not.toHaveBeenCalled();
    });

    it("keeps the current branch highlight inside virtualized rows", () => {
        mockGitStoreState.current.snapshots = {
            "project-1::primary": {
                branch: {
                    ahead: 0,
                    behind: 0,
                    isDetached: false,
                    name: "feature-2",
                    upstreamName: "origin/feature-2",
                },
                projectId: "project-1",
                worktrees: [],
            },
        };

        const markup = renderToStaticMarkup(
            createElement(GitHubPullRequestsTabView, { tab: TAB }),
        );

        expect(markup).toContain("Current branch");
    });

    it("renders pull request check states", () => {
        mockGitHubStoreState.current.pullRequestsByRepoAndState = {
            [REPO_KEY]: {
                open: Array.from({ length: 5 }, (_, index) =>
                    createPullRequestSummary(index + 1),
                ),
            },
        };
        mockGitHubStoreState.current.pullRequestChecksByRepo = {
            [REPO_KEY]: {
                "head-1": createPullRequestChecks({
                    headSha: "head-1",
                    pullRequestNumber: 1,
                    state: "success",
                }),
                "head-2": createPullRequestChecks({
                    headSha: "head-2",
                    pullRequestNumber: 2,
                    state: "failure",
                }),
                "head-3": createPullRequestChecks({
                    headSha: "head-3",
                    pullRequestNumber: 3,
                    state: "pending",
                }),
            },
        };
        mockGitHubStoreState.current.loadingKeys = {
            [`${REPO_KEY}:pr-checks:head-4`]: true,
        };

        const markup = renderToStaticMarkup(
            createElement(GitHubPullRequestsTabView, { tab: TAB }),
        );

        expect(markup).toContain("checks passing");
        expect(markup).toContain("checks failed");
        expect(markup).toContain("checks pending");
        expect(markup).toContain("checks...");
        expect(markup).toContain("checks unknown");
    });

    it("derives check targets from the virtual visible range", () => {
        const pullRequests = Array.from({ length: 60 }, (_, index) =>
            createPullRequestSummary(index + 1),
        );
        const initialTargets = getVisiblePullRequestCheckTargets({
            pullRequests,
            range: null,
        });
        const rangedTargets = getVisiblePullRequestCheckTargets({
            pullRequests,
            range: {
                endIndex: 40,
                startIndex: 24,
                visibleEndIndex: 34,
                visibleStartIndex: 30,
            },
        });

        expect(initialTargets).toHaveLength(20);
        expect(initialTargets[0]).toEqual({ headSha: "head-1", number: 1 });
        expect(initialTargets.at(-1)).toEqual({
            headSha: "head-20",
            number: 20,
        });
        expect(rangedTargets[0]).toEqual({
            headSha: "head-21",
            number: 21,
        });
        expect(rangedTargets.at(-1)).toEqual({
            headSha: "head-45",
            number: 45,
        });
    });

    it("deduplicates check targets by head sha", () => {
        const firstPullRequest = createPullRequestSummary(1);
        const secondPullRequest = createPullRequestSummary(2);
        const targets = getVisiblePullRequestCheckTargets({
            pullRequests: [
                firstPullRequest,
                {
                    ...secondPullRequest,
                    head: {
                        ...secondPullRequest.head,
                        sha: firstPullRequest.head.sha,
                    },
                },
            ],
            range: null,
        });

        expect(targets).toEqual([{ headSha: "head-1", number: 1 }]);
    });

    it("falls back to initial check targets when a virtual range is stale", () => {
        const pullRequests = Array.from({ length: 12 }, (_, index) =>
            createPullRequestSummary(index + 1),
        );
        const targets = getVisiblePullRequestCheckTargets({
            pullRequests,
            range: {
                endIndex: 220,
                startIndex: 200,
                visibleEndIndex: 210,
                visibleStartIndex: 200,
            },
        });

        expect(targets).toHaveLength(12);
        expect(targets[0]).toEqual({ headSha: "head-1", number: 1 });
        expect(targets.at(-1)).toEqual({
            headSha: "head-12",
            number: 12,
        });
    });
});
