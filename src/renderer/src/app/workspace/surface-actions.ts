import { isKnownAiRuntimeId } from "@shared/ai-runtimes";
import { resolveEditorLanguage } from "@shared/editor-language";
import type { WorkspaceSurfaceActionRequest } from "@shared/ipc";

import {
    createGitHubIssueComposerDragItem,
    createGitHubPullRequestComposerDragItem,
} from "@renderer/app/drag-and-drop";
import { useAiStore } from "@renderer/app/store/ai-store";
import {
    getBestMatchingChatTabId,
    useWorkspaceStore,
} from "@renderer/app/store/workspace-store";
import { collectPaneNodes } from "@renderer/app/workspace/tree";
import {
    appendWorkspaceTabComposerItems,
    createEmptyComposerParts,
} from "@renderer/components/workspace/chat/composerParts";
import { launchClaudeCodeTerminal } from "@renderer/features/terminal/claudeCodeTerminal";
import {
    closeClaudeCodeSidebarSession,
    getClaudeCodeSidebarSessionByTerminalId,
    renameClaudeCodeSidebarSession,
} from "@renderer/features/terminal/claudeCodeSidebarSession";

type AiState = ReturnType<typeof useAiStore.getState>;
type WorkspaceState = ReturnType<typeof useWorkspaceStore.getState>;

export interface WorkspaceSurfaceActionDependencies {
    readonly getAiState: () => AiState;
    readonly getWorkspaceState: () => WorkspaceState;
    readonly launchClaudeTerminal: typeof launchClaudeCodeTerminal;
}

const defaultDependencies: WorkspaceSurfaceActionDependencies = {
    getAiState: useAiStore.getState,
    getWorkspaceState: useWorkspaceStore.getState,
    launchClaudeTerminal: launchClaudeCodeTerminal,
};

export async function executeWorkspaceSurfaceAction(
    request: WorkspaceSurfaceActionRequest,
    dependencies: WorkspaceSurfaceActionDependencies = defaultDependencies,
): Promise<void> {
    const workspace = dependencies.getWorkspaceState();

    switch (request.kind) {
        case "file":
            if (request.origin === "quick-create") {
                workspace.setLastQuickCreateAction("file");
            }
            await workspace.openFileTab(
                request.projectId,
                request.relativePath,
                request.worktreeId,
            );
            return;
        case "git-history":
            await workspace.openGitTab(request.projectId, request.worktreeId);
            return;
        case "git-worktree-diff":
            await workspace.openGitWorktreeDiffTab(
                request.projectId,
                request.worktreeId,
            );
            return;
        case "chat-session":
            await workspace.openChatSessionTab({
                projectId: request.sessionProjectId,
                runtimeId: request.runtimeId,
                sessionOpenMode: "history",
                sessionId: request.sessionId,
                title: request.title,
                worktreeId: request.sessionWorktreeId,
            });
            return;
        case "chat-history":
            await workspace.openChatHistoryTab(
                request.projectId,
                request.worktreeId,
            );
            return;
        case "new-chat":
            if (!isKnownAiRuntimeId(request.runtimeId)) {
                throw new Error("Unsupported chat runtime.");
            }
            await workspace.createChatTab(
                request.projectId,
                request.worktreeId,
                request.runtimeId,
            );
            return;
        case "focus-terminal":
            await focusTerminal(request.terminalId, workspace);
            return;
        case "rename-terminal":
            await renameTerminal(request.terminalId, request.title);
            return;
        case "close-terminal":
            await closeTerminal(request.terminalId, workspace);
            return;
        case "new-claude-terminal":
            await dependencies.launchClaudeTerminal({
                projectId: request.projectId,
                worktreeId: request.worktreeId,
            });
            return;
        case "github-list":
            if (request.listKind === "issues") {
                await workspace.openGitHubIssuesTab(request);
            } else {
                await workspace.openGitHubPullRequestsTab(request);
            }
            return;
        case "github-item":
            if (request.itemKind === "issue") {
                await workspace.openGitHubIssueTab({
                    issueNumber: request.itemNumber,
                    projectId: request.projectId,
                    ref: request.ref,
                    worktreeId: request.worktreeId,
                });
            } else {
                await workspace.openGitHubPullRequestTab({
                    projectId: request.projectId,
                    pullRequestNumber: request.itemNumber,
                    ref: request.ref,
                    worktreeId: request.worktreeId,
                });
            }
            return;
        case "add-files-to-chat":
            await addFilesToChat(request, dependencies);
            return;
        case "add-github-items-to-chat":
            await addGitHubItemsToChat(request, dependencies);
    }
}

async function focusTerminal(
    terminalId: string,
    workspace: WorkspaceState,
): Promise<void> {
    const tab = Object.values(workspace.tabsById).find(
        (candidate) =>
            candidate.kind === "terminal" &&
            candidate.terminalId === terminalId,
    );
    if (!tab) {
        throw new Error("The requested terminal is no longer open.");
    }

    const pane = collectPaneNodes(workspace.rootNode).find((candidate) =>
        candidate.tabIds.includes(tab.id),
    );
    if (!pane) {
        throw new Error("The requested terminal pane is unavailable.");
    }

    await workspace.selectTab(pane.id, tab.id);
}

async function renameTerminal(terminalId: string, title: string): Promise<void> {
    const session = getClaudeCodeSidebarSessionByTerminalId(terminalId);
    if (!session) {
        throw new Error("The requested terminal is no longer open.");
    }

    // The surface owns the terminal registry, including manual-title precedence.
    await renameClaudeCodeSidebarSession(session, title);
}

async function closeTerminal(
    terminalId: string,
    workspace: WorkspaceState,
): Promise<void> {
    const session = getClaudeCodeSidebarSessionByTerminalId(terminalId);
    if (session) {
        await closeClaudeCodeSidebarSession(session);
        return;
    }

    const tab = Object.values(workspace.tabsById).find(
        (candidate) =>
            candidate.kind === "terminal" &&
            candidate.terminalId === terminalId,
    );
    if (!tab) {
        throw new Error("The requested terminal is no longer open.");
    }
    await workspace.closeTab(tab.id);
}

async function addFilesToChat(
    request: Extract<
        WorkspaceSurfaceActionRequest,
        { readonly kind: "add-files-to-chat" }
    >,
    dependencies: WorkspaceSurfaceActionDependencies,
): Promise<void> {
    const sessionId = await resolveChatSession(request, dependencies);
    if (!sessionId) {
        throw new Error("Could not create a chat tab for these files.");
    }

    const ai = dependencies.getAiState();
    for (const file of request.files) {
        ai.addDraftFileContext(sessionId, {
            extension: file.relativePath.split(".").pop() ?? null,
            id: `file-ctx:${crypto.randomUUID()}`,
            languageId: resolveEditorLanguage({
                filePath: file.relativePath,
            }).id,
            name: file.name,
            projectId: request.projectId,
            relativePath: file.relativePath,
        });
    }
}

async function addGitHubItemsToChat(
    request: Extract<
        WorkspaceSurfaceActionRequest,
        { readonly kind: "add-github-items-to-chat" }
    >,
    dependencies: WorkspaceSurfaceActionDependencies,
): Promise<void> {
    const sessionId = await resolveChatSession(request, dependencies);
    if (!sessionId) {
        throw new Error("Could not create a chat tab for these GitHub items.");
    }

    const composerItems = request.items.map((item) =>
        request.itemKind === "issue"
            ? createGitHubIssueComposerDragItem(request.ref, item)
            : createGitHubPullRequestComposerDragItem(request.ref, item),
    );
    const ai = dependencies.getAiState();
    const existingParts =
        ai.sessions[sessionId]?.draftComposerParts ?? createEmptyComposerParts();
    ai.setDraftComposerParts(
        sessionId,
        appendWorkspaceTabComposerItems(existingParts, composerItems),
    );
}

async function resolveChatSession(
    request: {
        readonly forceNewChat: boolean;
        readonly projectId: string;
        readonly worktreeId: string | null;
    },
    dependencies: WorkspaceSurfaceActionDependencies,
): Promise<string | null> {
    let workspace = dependencies.getWorkspaceState();
    const targetChatTabId = request.forceNewChat
        ? null
        : getBestMatchingChatTabId(workspace, {
              currentPaneId: workspace.activePaneId,
              lastFocusedChatTabId: workspace.lastFocusedChatTabId,
              projectId: request.projectId,
              recentFocusedChatTabIds: workspace.recentFocusedChatTabIds,
              worktreeId: request.worktreeId,
          });
    const targetChatTab = targetChatTabId
        ? workspace.tabsById[targetChatTabId]
        : null;
    if (targetChatTab?.kind === "chat") {
        return targetChatTab.sessionId;
    }

    await workspace.createChatTab(
        request.projectId,
        request.worktreeId,
        workspace.lastFocusedRuntimeId,
    );
    workspace = dependencies.getWorkspaceState();
    const createdTab = workspace.lastFocusedChatTabId
        ? workspace.tabsById[workspace.lastFocusedChatTabId]
        : null;
    return createdTab?.kind === "chat" ? createdTab.sessionId : null;
}
