import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeWorkspaceGitWorktreeDiffTab } from "@renderer/app/workspace/tree";
import type { GitWorktreeDiffResult } from "@shared/ipc";

const mockGitStoreState = vi.hoisted(() => ({
    current: {
        collapsedWorktreeDiffFileIds: {},
        discardPaths: vi.fn(() => Promise.resolve(null)),
        ensureWorktreeDiff: vi.fn(() => Promise.resolve(null)),
        errors: {},
        loadingWorktreeDiffContexts: {},
        refreshProject: vi.fn(() => Promise.resolve(null)),
        refreshWorktreeDiff: vi.fn(() => Promise.resolve(null)),
        selectedWorktreeDiffFileIds: {},
        selectWorktreeDiffFile: vi.fn(() => Promise.resolve(null)),
        setWorktreeDiffCollapsedFileIds: vi.fn(),
        snapshots: {},
        stagePaths: vi.fn(() => Promise.resolve(null)),
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
        suggestionsEnabled: true,
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

import { GitWorktreeDiffTabView } from "./GitWorktreeDiffTabView";

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

function resetStoreState() {
    mockGitStoreState.current.collapsedWorktreeDiffFileIds = {};
    mockGitStoreState.current.discardPaths.mockClear();
    mockGitStoreState.current.ensureWorktreeDiff.mockClear();
    mockGitStoreState.current.errors = {};
    mockGitStoreState.current.loadingWorktreeDiffContexts = {};
    mockGitStoreState.current.refreshProject.mockClear();
    mockGitStoreState.current.refreshWorktreeDiff.mockClear();
    mockGitStoreState.current.selectedWorktreeDiffFileIds = {};
    mockGitStoreState.current.selectWorktreeDiffFile.mockClear();
    mockGitStoreState.current.setWorktreeDiffCollapsedFileIds.mockClear();
    mockGitStoreState.current.snapshots = {
        [CONTEXT_KEY]: null,
    };
    mockGitStoreState.current.stagePaths.mockClear();
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

    it("keeps the persisted worktree scroll container as the diff scroll owner", () => {
        const markup = renderWorktreeMarkup();

        expect(markup).toContain(
            'class="shell-scrollbar min-h-0 flex-1 overflow-y-auto px-3 py-3"',
        );
        expect(markup).toContain('class="min-h-0 flex-1 px-2 py-2"');
        expect(markup).toContain("worktree-file.ts");
    });
});
