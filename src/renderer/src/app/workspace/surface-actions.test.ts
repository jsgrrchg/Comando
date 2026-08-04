import { describe, expect, it, vi } from "vitest";

import type { WorkspaceSurfaceActionRequest } from "@shared/ipc";
import {
    executeWorkspaceSurfaceAction,
    type WorkspaceSurfaceActionDependencies,
} from "./surface-actions";

const context = {
    contextKey: "project-1::__primary__",
    projectId: "project-1",
    worktreeId: null,
} as const;

const ref = {
    host: "github.com",
    owner: "openai",
    repo: "codex",
} as const;

describe("executeWorkspaceSurfaceAction", () => {
    it("opens files locally and records quick create ownership", async () => {
        const harness = createHarness();

        await executeWorkspaceSurfaceAction(
            {
                ...context,
                kind: "file",
                origin: "quick-create",
                relativePath: "untitled.txt",
            },
            harness.dependencies,
        );

        expect(harness.workspace.setLastQuickCreateAction).toHaveBeenCalledWith(
            "file",
        );
        expect(harness.workspace.openFileTab).toHaveBeenCalledWith(
            "project-1",
            "untitled.txt",
            null,
        );
    });

    it("dispatches Git and chat actions to the local workspace store", async () => {
        const harness = createHarness();
        const requests: WorkspaceSurfaceActionRequest[] = [
            { ...context, kind: "git-history" },
            { ...context, kind: "git-worktree-diff" },
            { ...context, kind: "chat-history" },
            { ...context, kind: "new-chat", runtimeId: "grok" },
            {
                ...context,
                kind: "chat-session",
                runtimeId: "codex",
                sessionId: "session-history",
                sessionProjectId: "project-1",
                sessionWorktreeId: null,
                title: "History session",
            },
        ];

        for (const request of requests) {
            await executeWorkspaceSurfaceAction(request, harness.dependencies);
        }

        expect(harness.workspace.openGitTab).toHaveBeenCalledWith(
            "project-1",
            null,
        );
        expect(harness.workspace.openGitWorktreeDiffTab).toHaveBeenCalledWith(
            "project-1",
            null,
        );
        expect(harness.workspace.openChatHistoryTab).toHaveBeenCalledWith(
            "project-1",
            null,
        );
        expect(harness.workspace.createChatTab).toHaveBeenCalledWith(
            "project-1",
            null,
            "grok",
        );
        expect(harness.workspace.openChatSessionTab).toHaveBeenCalledWith({
            projectId: "project-1",
            runtimeId: "codex",
            sessionOpenMode: "history",
            sessionId: "session-history",
            title: "History session",
            worktreeId: null,
        });
    });

    it("opens GitHub lists and items locally", async () => {
        const harness = createHarness();

        await executeWorkspaceSurfaceAction(
            {
                ...context,
                kind: "github-list",
                listKind: "issues",
                ref,
            },
            harness.dependencies,
        );
        await executeWorkspaceSurfaceAction(
            {
                ...context,
                itemKind: "pull_request",
                itemNumber: 42,
                kind: "github-item",
                ref,
            },
            harness.dependencies,
        );

        expect(harness.workspace.openGitHubIssuesTab).toHaveBeenCalledWith(
            expect.objectContaining({ kind: "github-list", ref }),
        );
        expect(
            harness.workspace.openGitHubPullRequestTab,
        ).toHaveBeenCalledWith({
            projectId: "project-1",
            pullRequestNumber: 42,
            ref,
            worktreeId: null,
        });
    });

    it("focuses, closes, and launches terminals on the owning surface", async () => {
        const harness = createHarness({ terminal: true });

        await executeWorkspaceSurfaceAction(
            { ...context, kind: "focus-terminal", terminalId: "terminal-1" },
            harness.dependencies,
        );
        await executeWorkspaceSurfaceAction(
            { ...context, kind: "new-claude-terminal" },
            harness.dependencies,
        );
        await executeWorkspaceSurfaceAction(
            { ...context, kind: "close-terminal", terminalId: "terminal-1" },
            harness.dependencies,
        );

        expect(harness.workspace.selectTab).toHaveBeenCalledWith(
            "pane-1",
            "terminal-tab-1",
        );
        expect(harness.launchClaudeTerminal).toHaveBeenCalledWith({
            projectId: "project-1",
            worktreeId: null,
        });
        expect(harness.workspace.closeTab).toHaveBeenCalledWith("terminal-tab-1");
    });

    it("adds multiple files to the best matching local chat", async () => {
        const harness = createHarness({ chat: true });

        await executeWorkspaceSurfaceAction(
            {
                ...context,
                files: [
                    { name: "index.ts", relativePath: "src/index.ts" },
                    { name: "README.md", relativePath: "README.md" },
                ],
                forceNewChat: false,
                kind: "add-files-to-chat",
            },
            harness.dependencies,
        );

        expect(harness.ai.addDraftFileContext).toHaveBeenCalledTimes(2);
        expect(harness.ai.addDraftFileContext).toHaveBeenNthCalledWith(
            1,
            "session-1",
            expect.objectContaining({
                name: "index.ts",
                projectId: "project-1",
                relativePath: "src/index.ts",
            }),
        );
    });

    it("adds multiple GitHub mentions and honors forceNewChat", async () => {
        const harness = createHarness({ createChatOnDemand: true });

        await executeWorkspaceSurfaceAction(
            {
                ...context,
                forceNewChat: true,
                itemKind: "issue",
                items: [
                    {
                        number: 1,
                        title: "First",
                        url: "https://github.com/openai/codex/issues/1",
                    },
                    {
                        number: 2,
                        title: "Second",
                        url: "https://github.com/openai/codex/issues/2",
                    },
                ],
                kind: "add-github-items-to-chat",
                ref,
            },
            harness.dependencies,
        );

        expect(harness.workspace.createChatTab).toHaveBeenCalledWith(
            "project-1",
            null,
            "codex",
        );
        expect(harness.ai.setDraftComposerParts).toHaveBeenCalledWith(
            "created-session",
            expect.arrayContaining([
                expect.objectContaining({
                    number: 1,
                    type: "github_issue_mention",
                }),
                expect.objectContaining({
                    number: 2,
                    type: "github_issue_mention",
                }),
            ]),
        );
    });

    it("reports a missing terminal instead of mutating another pane", async () => {
        const harness = createHarness();

        await expect(
            executeWorkspaceSurfaceAction(
                {
                    ...context,
                    kind: "focus-terminal",
                    terminalId: "missing",
                },
                harness.dependencies,
            ),
        ).rejects.toThrow("no longer open");
        expect(harness.workspace.selectTab).not.toHaveBeenCalled();
    });
});

function createHarness(
    options: {
        readonly chat?: boolean;
        readonly createChatOnDemand?: boolean;
        readonly terminal?: boolean;
    } = {},
) {
    const chatTab = options.chat
        ? {
              createdAt: "2026-07-19T00:00:00.000Z",
              draft: "",
              id: "chat-tab-1",
              kind: "chat",
              projectId: "project-1",
              runtimeId: "codex",
              sessionId: "session-1",
              title: "Codex 1",
              worktreeId: null,
          }
        : null;
    const terminalTab = options.terminal
        ? {
              createdAt: "2026-07-19T00:00:00.000Z",
              exitCode: null,
              id: "terminal-tab-1",
              isReady: true,
              kind: "terminal",
              launchError: null,
              output: "",
              projectId: "project-1",
              session: null,
              sessionId: "terminal-1",
              signalCode: null,
              terminalId: "terminal-1",
              title: "Terminal 1",
              worktreeId: null,
          }
        : null;
    const tabsById: Record<string, unknown> = {};
    if (chatTab) tabsById[chatTab.id] = chatTab;
    if (terminalTab) tabsById[terminalTab.id] = terminalTab;
    const tabIds = [chatTab?.id, terminalTab?.id].filter(
        (tabId): tabId is string => Boolean(tabId),
    );

    const workspace = {
        activePaneId: "pane-1",
        closeTab: vi.fn(() => Promise.resolve()),
        createChatTab: vi.fn(() => {
            if (!options.createChatOnDemand) return Promise.resolve();
            tabsById["created-chat"] = {
                ...chatTab,
                id: "created-chat",
                kind: "chat",
                projectId: "project-1",
                runtimeId: "codex",
                sessionId: "created-session",
                title: "Codex 1",
                worktreeId: null,
            };
            workspace.lastFocusedChatTabId = "created-chat";
            return Promise.resolve();
        }),
        lastFocusedChatTabId: chatTab?.id ?? null,
        lastFocusedRuntimeId: "codex",
        openChatHistoryTab: vi.fn(() => Promise.resolve()),
        openChatSessionTab: vi.fn(() => Promise.resolve()),
        openFileTab: vi.fn(() => Promise.resolve()),
        openGitHubIssueTab: vi.fn(() => Promise.resolve()),
        openGitHubIssuesTab: vi.fn(() => Promise.resolve()),
        openGitHubPullRequestTab: vi.fn(() => Promise.resolve()),
        openGitHubPullRequestsTab: vi.fn(() => Promise.resolve()),
        openGitTab: vi.fn(() => Promise.resolve()),
        openGitWorktreeDiffTab: vi.fn(() => Promise.resolve()),
        recentFocusedChatTabIds: chatTab ? [chatTab.id] : [],
        rootNode: {
            activeTabId: tabIds[0] ?? null,
            id: "pane-1",
            tabIds,
            type: "pane",
        },
        selectTab: vi.fn(() => Promise.resolve()),
        setLastQuickCreateAction: vi.fn(),
        tabsById,
    };
    const ai = {
        addDraftFileContext: vi.fn(),
        sessions: {},
        setDraftComposerParts: vi.fn(),
    };
    const launchClaudeTerminal = vi.fn(() =>
        Promise.resolve({
            commandWritten: true,
            terminalId: "terminal-2",
            terminalTabId: "terminal-tab-2",
            transcriptSessionId: null,
        }),
    );
    const dependencies = {
        getAiState: () => ai,
        getWorkspaceState: () => workspace,
        launchClaudeTerminal,
    } as unknown as WorkspaceSurfaceActionDependencies;

    return { ai, dependencies, launchClaudeTerminal, workspace };
}
