import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { GitCommitDetail, GitHistoryCommitSummary } from "@shared/ipc";
import type { RuntimeWorkspaceGitTab } from "@renderer/app/workspace/tree";

const mockGitStoreState = vi.hoisted(() => ({
    current: {
        commitDetailsByContext: {} as Record<
            string,
            Record<string, unknown> | undefined
        >,
        ensureCommitDetail: vi.fn(() => Promise.resolve(null)),
        errors: {} as Record<string, string | null | undefined>,
        historyByContext: {} as Record<
            string,
            readonly GitHistoryCommitSummary[] | undefined
        >,
        loadingCommitShas: {} as Record<string, readonly string[] | undefined>,
        loadingContexts: {} as Record<string, boolean | undefined>,
        loadingHistoryContexts: {} as Record<string, boolean | undefined>,
        refreshHistory: vi.fn(() => Promise.resolve([])),
        refreshProject: vi.fn(() => Promise.resolve(null)),
        selectCommit: vi.fn(() => Promise.resolve(null)),
        selectedCommitShas: {} as Record<string, string | null | undefined>,
        snapshots: {} as Record<string, unknown>,
    },
}));

const mockWorkspaceStoreState = vi.hoisted(() => ({
    current: {
        openFileTab: vi.fn(async () => {}),
        openGitCommitTab: vi.fn(async () => {}),
    },
}));

vi.mock("@renderer/app/store/git-store", () => ({
    useGitStore: (
        selector: (state: typeof mockGitStoreState.current) => unknown,
    ) => selector(mockGitStoreState.current),
}));

vi.mock("@renderer/app/store/workspace-store", () => ({
    useWorkspaceStore: (
        selector: (state: typeof mockWorkspaceStoreState.current) => unknown,
    ) => selector(mockWorkspaceStoreState.current),
}));

import { GitTabView } from "./GitTabView";

const TAB: RuntimeWorkspaceGitTab = {
    createdAt: "2026-04-15T00:00:00.000Z",
    id: "git-tab-1",
    kind: "git",
    projectId: "project-1",
    title: "Git",
    worktreeId: null,
};

const CONTEXT_KEY = `${TAB.projectId}::primary`;

function createCommit(
    overrides: Partial<GitHistoryCommitSummary> = {},
): GitHistoryCommitSummary {
    return {
        authorEmail: "jose@example.com",
        authorName: "Jose",
        authoredAt: "2026-04-14T21:50:00.000Z",
        body: "",
        parentShas: ["parent-1"],
        refs: [],
        sha: "c151e66e68a065f06480bda656b40c123456789",
        shortSha: "c151e66",
        subject: "Add Ctrl+Tab pane tab navigation",
        ...overrides,
    };
}

function resetStoreState() {
    mockGitStoreState.current.commitDetailsByContext = {};
    mockGitStoreState.current.ensureCommitDetail.mockClear();
    mockGitStoreState.current.errors = {};
    mockGitStoreState.current.historyByContext = {
        [CONTEXT_KEY]: [createCommit()],
    };
    mockGitStoreState.current.loadingCommitShas = {};
    mockGitStoreState.current.loadingContexts = {};
    mockGitStoreState.current.loadingHistoryContexts = {};
    mockGitStoreState.current.refreshHistory.mockClear();
    mockGitStoreState.current.refreshProject.mockClear();
    mockGitStoreState.current.selectCommit.mockClear();
    mockGitStoreState.current.selectedCommitShas = {};
    mockGitStoreState.current.snapshots = {
        [CONTEXT_KEY]: null,
    };
    mockWorkspaceStoreState.current.openFileTab.mockClear();
    mockWorkspaceStoreState.current.openGitCommitTab.mockClear();
}

function createCommitDetail(
    overrides: Partial<GitCommitDetail> = {},
): GitCommitDetail {
    const baseCommit = createCommit();
    return {
        ...baseCommit,
        changedFileCount: 2,
        committedAt: baseCommit.authoredAt,
        committerEmail: baseCommit.authorEmail,
        committerName: baseCommit.authorName,
        deletions: 2,
        files: [
            {
                additions: 12,
                deletions: 1,
                hunks: [],
                isText: true,
                kind: "update",
                newText: null,
                oldText: null,
                path: "src/renderer/src/components/git/GitPanel.tsx",
                previousPath: null,
                reversible: true,
                statusLabel: "modified",
            },
            {
                additions: null,
                deletions: 4,
                hunks: [],
                isText: true,
                kind: "delete",
                newText: null,
                oldText: null,
                path: "src/renderer/src/components/git/RemovedFile.tsx",
                previousPath: null,
                reversible: true,
                statusLabel: "deleted",
            },
        ],
        insertions: 12,
        ...overrides,
    };
}

describe("GitTabView", () => {
    it("hides the detail panel when no commit is selected", () => {
        resetStoreState();
        mockGitStoreState.current.selectedCommitShas = {
            [CONTEXT_KEY]: null,
        };

        const markup = renderToStaticMarkup(
            createElement(GitTabView, { tab: TAB }),
        );

        expect(markup).not.toContain("Select a commit to inspect it.");
        expect(markup).not.toContain("Resize commit details sidebar");
        expect(markup).not.toContain("View Commit");
    });

    it("shows the detail panel when an active commit exists", () => {
        const commit = createCommit();
        resetStoreState();
        mockGitStoreState.current.selectedCommitShas = {
            [CONTEXT_KEY]: commit.sha,
        };

        const markup = renderToStaticMarkup(
            createElement(GitTabView, { tab: TAB }),
        );

        expect(markup).toContain("Resize commit details sidebar");
        expect(markup).toContain("Add Ctrl+Tab pane tab navigation");
        expect(markup).toContain("View Commit");
    });

    it("marks commit files that can be opened as clickable", () => {
        const commit = createCommit();
        resetStoreState();
        mockGitStoreState.current.selectedCommitShas = {
            [CONTEXT_KEY]: commit.sha,
        };
        mockGitStoreState.current.commitDetailsByContext = {
            [CONTEXT_KEY]: {
                [commit.sha]: createCommitDetail(),
            },
        };

        const markup = renderToStaticMarkup(
            createElement(GitTabView, { tab: TAB }),
        );

        expect(markup).toContain(
            'aria-label="Open file src/renderer/src/components/git/GitPanel.tsx"',
        );
        expect(markup).not.toContain(
            'aria-label="Open file src/renderer/src/components/git/RemovedFile.tsx"',
        );
    });
});
