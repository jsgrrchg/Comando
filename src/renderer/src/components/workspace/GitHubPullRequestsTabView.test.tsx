import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    GitHubAuthStatus,
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

import {
    GITHUB_PULL_REQUESTS_ROW_VIRTUALIZATION_THRESHOLD,
    GitHubPullRequestsTabView,
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

    it("renders the large pull requests table baseline with table affordances intact", () => {
        const markup = renderToStaticMarkup(
            createElement(GitHubPullRequestsTabView, { tab: TAB }),
        );

        expect(markup).toContain(
            `${GITHUB_PULL_REQUESTS_ROW_VIRTUALIZATION_THRESHOLD} items`,
        );
        expect(markup).toContain("Baseline pull request 1");
        expect(markup).toContain(
            `Baseline pull request ${GITHUB_PULL_REQUESTS_ROW_VIRTUALIZATION_THRESHOLD}`,
        );
        expect(markup).toContain('aria-label="Resize # column"');
        expect(markup).toContain('aria-label="Resize Branch column"');
        expect(markup).toContain("Drag to reorder. Drag the edge to resize.");
        expect(markup).toContain("Open");
    });
});
