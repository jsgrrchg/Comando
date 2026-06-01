import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    GitHubAuthStatus,
    GitHubIssueSummary,
    GitHubRepositoryRef,
} from "@shared/ipc";
import type { RuntimeWorkspaceGitHubIssuesTab } from "@renderer/app/workspace/tree";

const REPO: GitHubRepositoryRef = {
    host: "github.com",
    owner: "octocat",
    repo: "hello-world",
};
const REPO_KEY = "github.com/octocat/hello-world";

const mockGitHubStoreState = vi.hoisted(() => ({
    current: {
        authStatusByHost: {},
        createIssue: vi.fn(),
        errors: {},
        issueListStateByRepo: {},
        issuesByRepo: {},
        issuesByRepoAndState: {},
        loadingKeys: {},
        mutatingKeys: {},
        refreshAuthStatus: vi.fn(),
        refreshIssues: vi.fn(),
    },
}));

const mockWorkspaceStoreState = vi.hoisted(() => ({
    current: {
        openGitHubIssueTab: vi.fn(async () => {}),
    },
}));

vi.mock("@renderer/app/store/github-store", () => ({
    EMPTY_GITHUB_LIST: Object.freeze([]),
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
    GITHUB_ISSUES_ROW_VIRTUALIZATION_THRESHOLD,
    GitHubIssuesTabView,
} from "./GitHubIssuesTabView";

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

const TAB: RuntimeWorkspaceGitHubIssuesTab = {
    createdAt: "2026-05-28T00:00:00.000Z",
    id: "github-issues-tab-1",
    kind: "github_issues",
    projectId: "project-1",
    ref: REPO,
    title: "Issues",
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

function createIssueSummary(index: number): GitHubIssueSummary {
    return {
        assignees:
            index % 10 === 0
                ? [
                      {
                          avatarUrl: null,
                          id: 1,
                          login: "octocat",
                          url: "https://github.com/octocat",
                      },
                  ]
                : [],
        author: null,
        closedAt: null,
        commentCount: index % 5,
        createdAt: `2026-05-${String(1 + (index % 28)).padStart(2, "0")}T00:00:00.000Z`,
        id: index,
        isLocked: false,
        labels:
            index % 3 === 0
                ? [
                      {
                          color: "d73a4a",
                          description: "Baseline label",
                          id: index,
                          name: `area-${index}`,
                      },
                  ]
                : [],
        milestone: null,
        nodeId: `ISSUE_${index}`,
        number: index,
        state: "open",
        stateReason: null,
        title: `Baseline issue ${index}`,
        updatedAt: `2026-05-${String(1 + (index % 28)).padStart(2, "0")}T12:00:00.000Z`,
        url: `https://github.com/octocat/hello-world/issues/${index}`,
    };
}

function resetStoreState() {
    mockGitHubStoreState.current.authStatusByHost = {
        [REPO.host]: createAuthStatus(),
    };
    mockGitHubStoreState.current.createIssue.mockClear();
    mockGitHubStoreState.current.errors = {};
    mockGitHubStoreState.current.issueListStateByRepo = {
        [REPO_KEY]: "open",
    };
    mockGitHubStoreState.current.issuesByRepo = {};
    mockGitHubStoreState.current.issuesByRepoAndState = {
        [REPO_KEY]: {
            open: Array.from(
                { length: GITHUB_ISSUES_ROW_VIRTUALIZATION_THRESHOLD },
                (_, index) => createIssueSummary(index + 1),
            ),
        },
    };
    mockGitHubStoreState.current.loadingKeys = {};
    mockGitHubStoreState.current.mutatingKeys = {};
    mockGitHubStoreState.current.refreshAuthStatus.mockClear();
    mockGitHubStoreState.current.refreshIssues.mockClear();
    mockWorkspaceStoreState.current.openGitHubIssueTab.mockClear();
}

describe("GitHubIssuesTabView", () => {
    beforeEach(() => {
        Object.defineProperty(globalThis, "localStorage", {
            configurable: true,
            value: new MemoryStorage(),
            writable: true,
        });
        resetStoreState();
    });

    it("renders the large issues table baseline with table affordances intact", () => {
        const markup = renderToStaticMarkup(
            createElement(GitHubIssuesTabView, { tab: TAB }),
        );

        expect(markup).toContain(
            `${GITHUB_ISSUES_ROW_VIRTUALIZATION_THRESHOLD} items`,
        );
        expect(markup).toContain("Baseline issue 1");
        expect(markup).toContain(
            `Baseline issue ${GITHUB_ISSUES_ROW_VIRTUALIZATION_THRESHOLD}`,
        );
        expect(markup).toContain('aria-label="Resize # column"');
        expect(markup).toContain('aria-label="Resize Description column"');
        expect(markup).toContain("Drag to reorder. Drag the edge to resize.");
        expect(markup).toContain("Open in GitHub");
    });
});
