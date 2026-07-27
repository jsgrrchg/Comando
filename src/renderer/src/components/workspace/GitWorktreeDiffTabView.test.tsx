/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeWorkspaceGitWorktreeDiffTab } from "@renderer/app/workspace/tree";
import type { GitBranchDiffResult, GitWorktreeDiffResult } from "@shared/ipc";

const mockGitStoreState = vi.hoisted(() => ({
    current: {
        activeDiffModesByContext: {},
        branchDiffErrorsByContext: {},
        branchDiffsByContext: {},
        collapsedBranchDiffFileIds: {},
        collapsedWorktreeDiffFileIds: {},
        ensureBranchDiff: vi.fn(() => Promise.resolve(null)),
        discardPaths: vi.fn(() => Promise.resolve(null)),
        ensureWorktreeDiff: vi.fn(() => Promise.resolve(null)),
        errors: {},
        loadingBranchDiffContexts: {},
        loadingWorktreeDiffContexts: {},
        refreshBranchDiff: vi.fn(() => Promise.resolve(null)),
        refreshProject: vi.fn(() => Promise.resolve(null)),
        refreshWorktreeDiff: vi.fn(() => Promise.resolve(null)),
        selectedBranchDiffFileIds: {},
        selectedWorktreeDiffFileIds: {},
        selectBranchDiffFile: vi.fn(() => Promise.resolve(null)),
        selectWorktreeDiffFile: vi.fn(() => Promise.resolve(null)),
        setActiveDiffMode: vi.fn(),
        setBranchDiffCollapsedFileIds: vi.fn(),
        setWorktreeDiffCollapsedFileIds: vi.fn(),
        snapshots: {},
        staleBranchDiffContexts: {},
        staleWorktreeDiffContexts: {},
        stagePaths: vi.fn(() => Promise.resolve(null)),
        toggleBranchDiffFileCollapse: vi.fn(),
        toggleWorktreeDiffFileCollapse: vi.fn(),
        unstagePaths: vi.fn(() => Promise.resolve(null)),
        worktreeDiffsByContext: {},
    },
}));

const mockProjectsStoreState = vi.hoisted(() => ({
    current: {
        projects: [{ id: "project-1", name: "Comando" }],
    },
}));

const mockWorkspaceStoreState = vi.hoisted(() => ({
    current: {
        openFileTab: vi.fn(() => Promise.resolve(null)),
    },
}));

vi.mock("@renderer/app/hooks/use-resolved-editor-settings", () => ({
    useResolvedEditorSettings: () => ({
        autoSaveDelayMs: 1000,
        fontFamily: "system",
        fontSize: 14,
        lineHeight: 20,
        minimapEnabled: true,
        relativeLineNumbersEnabled: false,
        suggestionsEnabled: true,
        vimModeEnabled: false,
    }),
}));

vi.mock("@renderer/app/store/git-store", () => ({
    useGitStore: (
        selector: (state: typeof mockGitStoreState.current) => unknown,
    ) => selector(mockGitStoreState.current),
}));

vi.mock("@renderer/app/store/projects-store", () => ({
    useProjectsStore: (
        selector: (state: typeof mockProjectsStoreState.current) => unknown,
    ) => selector(mockProjectsStoreState.current),
}));

vi.mock("@renderer/app/store/workspace-store", () => ({
    useWorkspaceStore: (
        selector: (state: typeof mockWorkspaceStoreState.current) => unknown,
    ) => selector(mockWorkspaceStoreState.current),
}));

vi.mock("@renderer/components/workspace/usePersistedWorkspaceScroll", () => ({
    usePersistedWorkspaceScroll: () => ({
        handleScroll: vi.fn(),
        scrollRef: vi.fn(),
    }),
}));

import { GitWorktreeDiffTabView } from "./GitWorktreeDiffTabView";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

const TAB: RuntimeWorkspaceGitWorktreeDiffTab = {
    createdAt: "2026-05-21T00:00:00.000Z",
    id: "worktree-diff-tab-1",
    kind: "git_worktree_diff",
    projectId: "project-1",
    title: "Changes",
    worktreeId: null,
};

const CONTEXT_KEY = `${TAB.projectId}::primary`;

function createWorktreeDiffResult(): GitWorktreeDiffResult {
    return {
        projectId: TAB.projectId,
        sections: [
            {
                files: [
                    {
                        additions: 1,
                        deletions: 0,
                        diff: null,
                        error: null,
                        isBinary: false,
                        isConflicted: false,
                        kind: "modified",
                        path: "src/worktree-file.ts",
                        previousPath: null,
                        scope: "unstaged",
                    },
                ],
                scope: "unstaged",
            },
        ],
        updatedAt: "2026-05-21T00:00:00.000Z",
        worktreeId: TAB.worktreeId ?? null,
    };
}

function createBranchDiffResult(): GitBranchDiffResult {
    return {
        baseRef: "main",
        files: [
            {
                additions: 2,
                deletions: 1,
                diff: null,
                error: null,
                isBinary: false,
                kind: "modified",
                path: "src/branch-file.ts",
                previousPath: null,
            },
        ],
        headRef: "feature",
        projectId: TAB.projectId,
        unavailableReason: null,
        updatedAt: "2026-07-26T00:00:00.000Z",
        worktreeId: TAB.worktreeId ?? null,
    };
}

function resetStoreState() {
    mockGitStoreState.current.activeDiffModesByContext = {};
    mockGitStoreState.current.branchDiffErrorsByContext = {};
    mockGitStoreState.current.branchDiffsByContext = {
        [CONTEXT_KEY]: createBranchDiffResult(),
    };
    mockGitStoreState.current.collapsedBranchDiffFileIds = {};
    mockGitStoreState.current.collapsedWorktreeDiffFileIds = {};
    mockGitStoreState.current.ensureBranchDiff.mockClear();
    mockGitStoreState.current.discardPaths.mockClear();
    mockGitStoreState.current.ensureWorktreeDiff.mockClear();
    mockGitStoreState.current.errors = {};
    mockGitStoreState.current.loadingBranchDiffContexts = {};
    mockGitStoreState.current.loadingWorktreeDiffContexts = {};
    mockGitStoreState.current.refreshBranchDiff.mockClear();
    mockGitStoreState.current.refreshProject.mockClear();
    mockGitStoreState.current.refreshWorktreeDiff.mockClear();
    mockGitStoreState.current.selectedBranchDiffFileIds = {};
    mockGitStoreState.current.selectedWorktreeDiffFileIds = {};
    mockGitStoreState.current.selectBranchDiffFile.mockClear();
    mockGitStoreState.current.selectWorktreeDiffFile.mockClear();
    mockGitStoreState.current.setActiveDiffMode.mockClear();
    mockGitStoreState.current.setBranchDiffCollapsedFileIds.mockClear();
    mockGitStoreState.current.setWorktreeDiffCollapsedFileIds.mockClear();
    mockGitStoreState.current.snapshots = {
        [CONTEXT_KEY]: null,
    };
    mockGitStoreState.current.staleBranchDiffContexts = {};
    mockGitStoreState.current.staleWorktreeDiffContexts = {};
    mockGitStoreState.current.stagePaths.mockClear();
    mockGitStoreState.current.toggleBranchDiffFileCollapse.mockClear();
    mockGitStoreState.current.toggleWorktreeDiffFileCollapse.mockClear();
    mockGitStoreState.current.unstagePaths.mockClear();
    mockGitStoreState.current.worktreeDiffsByContext = {
        [CONTEXT_KEY]: createWorktreeDiffResult(),
    };
    mockWorkspaceStoreState.current.openFileTab.mockClear();
}

function renderWorktreeMarkup(): string {
    return renderToStaticMarkup(
        createElement(GitWorktreeDiffTabView, { tab: TAB }),
    );
}

describe("GitWorktreeDiffTabView", () => {
    beforeEach(() => {
        resetStoreState();
    });

    it("reserves the worktree body for the diff-owned scroller", () => {
        const markup = renderWorktreeMarkup();

        expect(markup).toContain('<main class="flex min-h-0 flex-1 flex-col">');
        expect(markup).toContain("worktree-file.ts");
        expect(markup).toContain('aria-label="Diff layout"');
        expect(markup).toContain("Side by side");
    });

    it("restores the selected branch mode after the view remounts", () => {
        mockGitStoreState.current.activeDiffModesByContext = {
            [CONTEXT_KEY]: "branch",
        };

        const markup = renderWorktreeMarkup();

        expect(markup).toContain("branch-file.ts");
        expect(markup).not.toContain("stage all");
    });

    it("switches to read-only branch changes and back", () => {
        const container = document.createElement("div");
        document.body.appendChild(container);
        const root = createRoot(container);
        act(() => {
            root.render(createElement(GitWorktreeDiffTabView, { tab: TAB }));
        });

        const branchTab = Array.from(container.querySelectorAll("button")).find(
            (button) => button.textContent === "Branch Changes",
        );
        expect(branchTab).toBeTruthy();
        act(() => {
            branchTab?.dispatchEvent(
                new MouseEvent("click", { bubbles: true }),
            );
        });

        expect(mockGitStoreState.current.setActiveDiffMode).toHaveBeenCalledWith(
            TAB.projectId,
            "branch",
            TAB.worktreeId,
        );

        mockGitStoreState.current.activeDiffModesByContext = {
            [CONTEXT_KEY]: "branch",
        };
        act(() => {
            root.render(createElement(GitWorktreeDiffTabView, { tab: TAB }));
        });

        expect(container.textContent).toContain("branch-file.ts");
        expect(container.textContent).not.toContain("stage all");
        expect(container.textContent).not.toContain("unstage all");
        expect(container.textContent).not.toContain("discard all");
        expect(container.textContent).toContain("refresh");
        expect(container.textContent).toContain("download all");

        const worktreeTab = Array.from(
            container.querySelectorAll("button"),
        ).find((button) => button.textContent === "Uncommitted Changes");
        act(() => {
            worktreeTab?.dispatchEvent(
                new MouseEvent("click", { bubbles: true }),
            );
        });
        expect(mockGitStoreState.current.setActiveDiffMode).toHaveBeenLastCalledWith(
            TAB.projectId,
            "worktree",
            TAB.worktreeId,
        );
        mockGitStoreState.current.activeDiffModesByContext = {};
        act(() => {
            root.render(createElement(GitWorktreeDiffTabView, { tab: TAB }));
        });
        expect(container.textContent).toContain("worktree-file.ts");
        expect(container.textContent).toContain("stage all");

        act(() => root.unmount());
        container.remove();
    });
});
