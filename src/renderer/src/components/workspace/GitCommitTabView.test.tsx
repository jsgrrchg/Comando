import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GitCommitDetail } from "@shared/ipc";
import type { RuntimeWorkspaceGitCommitTab } from "@renderer/app/workspace/tree";

import {
    getGitCommitDiffCollapseStorageKey,
    persistGitCommitDiffCollapseState,
} from "./gitCommitDiffCollapsePersistence";

const mockGitStoreState = vi.hoisted(() => ({
    current: {
        commitDetailsByContext: {},
        ensureCommitDetail: vi.fn(() => Promise.resolve(null)),
        errors: {},
        loadingCommitShas: {},
        selectCommit: vi.fn(() => Promise.resolve(null)),
        snapshots: {},
    },
}));

const mockWorkspaceStoreState = vi.hoisted(() => ({
    current: {
        openGitTab: vi.fn(async () => {}),
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

vi.mock("@renderer/app/store/workspace-store", () => ({
    useWorkspaceStore: (
        selector: (state: typeof mockWorkspaceStoreState.current) => unknown,
    ) => selector(mockWorkspaceStoreState.current),
}));

import { GitCommitTabView } from "./GitCommitTabView";

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

const TAB: RuntimeWorkspaceGitCommitTab = {
    commitSha: "d094662e1234567890",
    createdAt: "2026-05-21T00:00:00.000Z",
    id: "commit-tab-1",
    kind: "git_commit",
    projectId: "project-1",
    title: "d094662",
    worktreeId: null,
};

const CONTEXT_KEY = `${TAB.projectId}::primary`;

function createCommitDetail(): GitCommitDetail {
    return {
        authorEmail: "jose@example.com",
        authorName: "Jose",
        authoredAt: "2026-05-21T12:00:00.000Z",
        body: "",
        changedFileCount: 2,
        committedAt: "2026-05-21T12:00:00.000Z",
        committerEmail: "jose@example.com",
        committerName: "Jose",
        deletions: 0,
        files: [
            {
                additions: 1,
                deletions: 0,
                hunks: [
                    {
                        id: "hunk-a",
                        lines: [
                            {
                                id: "line-a",
                                text: "expanded-line-a",
                                type: "add",
                            },
                        ],
                        newCount: 1,
                        newStart: 1,
                        oldCount: 0,
                        oldStart: 1,
                    },
                ],
                isText: true,
                kind: "update",
                newText: null,
                oldText: null,
                path: "src/file-a.ts",
                previousPath: null,
                reversible: true,
                statusLabel: "modified",
            },
            {
                additions: 1,
                deletions: 0,
                hunks: [
                    {
                        id: "hunk-b",
                        lines: [
                            {
                                id: "line-b",
                                text: "expanded-line-b",
                                type: "add",
                            },
                        ],
                        newCount: 1,
                        newStart: 1,
                        oldCount: 0,
                        oldStart: 1,
                    },
                ],
                isText: true,
                kind: "update",
                newText: null,
                oldText: null,
                path: "src/file-b.ts",
                previousPath: null,
                reversible: true,
                statusLabel: "modified",
            },
        ],
        insertions: 2,
        parentShas: ["parent-1"],
        refs: [],
        sha: TAB.commitSha,
        shortSha: "d094662",
        subject: "Open Claude Code from agents sidebar",
    };
}

function resetStoreState() {
    mockGitStoreState.current.commitDetailsByContext = {
        [CONTEXT_KEY]: {
            [TAB.commitSha]: createCommitDetail(),
        },
    };
    mockGitStoreState.current.ensureCommitDetail.mockClear();
    mockGitStoreState.current.errors = {};
    mockGitStoreState.current.loadingCommitShas = {};
    mockGitStoreState.current.selectCommit.mockClear();
    mockGitStoreState.current.snapshots = {
        [CONTEXT_KEY]: null,
    };
    mockWorkspaceStoreState.current.openGitTab.mockClear();
}

function renderCommitMarkup(): string {
    return renderToStaticMarkup(createElement(GitCommitTabView, { tab: TAB }));
}

describe("GitCommitTabView", () => {
    beforeEach(() => {
        Object.defineProperty(globalThis, "localStorage", {
            configurable: true,
            value: new MemoryStorage(),
            writable: true,
        });
        resetStoreState();
    });

    it("shows commit diff files expanded by default", () => {
        const markup = renderCommitMarkup();

        expect(markup).toContain("expanded-line-a");
        expect(markup).toContain("expanded-line-b");
        expect(markup).toContain("collapse all");
    });

    it("restores persisted collapsed files when the commit tab remounts", () => {
        const storageKey = getGitCommitDiffCollapseStorageKey({
            commitSha: TAB.commitSha,
            projectId: TAB.projectId,
            surface: TAB.kind,
            worktreeId: TAB.worktreeId,
        });

        persistGitCommitDiffCollapseState(storageKey, ["src/file-a.ts"]);

        const markup = renderCommitMarkup();

        expect(markup).not.toContain("expanded-line-a");
        expect(markup).toContain("expanded-line-b");
        expect(markup).toContain("collapse all");
    });

    it("restores a persisted collapse-all state after remount", () => {
        const storageKey = getGitCommitDiffCollapseStorageKey({
            commitSha: TAB.commitSha,
            projectId: TAB.projectId,
            surface: TAB.kind,
            worktreeId: TAB.worktreeId,
        });

        persistGitCommitDiffCollapseState(storageKey, [
            "src/file-a.ts",
            "src/file-b.ts",
        ]);

        const markup = renderCommitMarkup();

        expect(markup).not.toContain("expanded-line-a");
        expect(markup).not.toContain("expanded-line-b");
        expect(markup).toContain("expand all");
    });
});
