import type { ProjectFileDocument, TerminalSession, WorkspaceChatTab, WorkspaceFileTab, WorkspaceNode, WorkspacePaneNode, WorkspaceReviewTab, WorkspaceSnapshot, WorkspaceTerminalTab } from "@shared/ipc";
export type SplitDirection = "down" | "left" | "right" | "up";
export type MoveDirection = "next" | "previous";
export interface RuntimeWorkspaceFileTab extends WorkspaceFileTab {
    readonly document: ProjectFileDocument | null;
    readonly draftContent: string;
    readonly isDirty: boolean;
    readonly isLoading: boolean;
    readonly isSaving: boolean;
    readonly loadError: string | null;
    readonly saveError: string | null;
    readonly savedContent: string;
}
export type RuntimeWorkspaceChatTab = WorkspaceChatTab;
export type RuntimeWorkspaceReviewTab = WorkspaceReviewTab;
export interface RuntimeWorkspaceTerminalTab extends WorkspaceTerminalTab {
    readonly exitCode: number | null;
    readonly isReady: boolean;
    readonly launchError: string | null;
    readonly output: string;
    readonly session: TerminalSession | null;
    readonly signalCode: number | null;
}
export type RuntimeWorkspaceTab = RuntimeWorkspaceFileTab | RuntimeWorkspaceChatTab | RuntimeWorkspaceReviewTab | RuntimeWorkspaceTerminalTab;
export interface WorkspaceTreeState {
    readonly activePaneId: string;
    readonly rootNode: WorkspaceNode;
    readonly tabsById: Record<string, RuntimeWorkspaceTab>;
}
export declare function createDefaultWorkspaceState(): WorkspaceTreeState;
export declare function workspaceStateFromSnapshot(snapshot: WorkspaceSnapshot, tabsById: Record<string, RuntimeWorkspaceTab>): WorkspaceTreeState;
export declare function workspaceStateToSnapshot(state: WorkspaceTreeState): WorkspaceSnapshot;
export declare function splitPaneInDirection(state: WorkspaceTreeState, paneId: string, direction: SplitDirection, nextIds: {
    readonly paneId: string;
    readonly splitId: string;
}): WorkspaceTreeState;
export declare function resizeSplit(node: WorkspaceNode, splitId: string, nextSizes: readonly number[]): WorkspaceNode;
export declare function activatePane(state: WorkspaceTreeState, paneId: string): WorkspaceTreeState;
export declare function attachTabToPane(state: WorkspaceTreeState, paneId: string, tab: RuntimeWorkspaceTab): WorkspaceTreeState;
export declare function selectPaneTab(state: WorkspaceTreeState, paneId: string, tabId: string): WorkspaceTreeState;
export declare function closeWorkspaceTab(state: WorkspaceTreeState, tabId: string): WorkspaceTreeState;
export declare function closeWorkspacePane(state: WorkspaceTreeState, paneId: string): WorkspaceTreeState;
export declare function moveActiveTabBetweenPanes(state: WorkspaceTreeState, paneId: string, direction: MoveDirection): WorkspaceTreeState;
export declare function moveWorkspaceTabBetweenPanes(state: WorkspaceTreeState, tabId: string, direction: MoveDirection): WorkspaceTreeState;
export declare function closeOtherWorkspaceTabs(state: WorkspaceTreeState, tabId: string): WorkspaceTreeState;
export declare function closeWorkspaceTabsToRight(state: WorkspaceTreeState, tabId: string): WorkspaceTreeState;
export declare function closeWorkspaceTabsForProjectPath(state: WorkspaceTreeState, projectId: string, relativePath: string, kind: "directory" | "file"): WorkspaceTreeState;
export declare function renameWorkspaceTabsForProjectPath(state: WorkspaceTreeState, projectId: string, previousRelativePath: string, nextRelativePath: string, kind: "directory" | "file"): WorkspaceTreeState;
export declare function updateChatDraft(state: WorkspaceTreeState, tabId: string, draft: string): WorkspaceTreeState;
export declare function updateFileDraft(state: WorkspaceTreeState, tabId: string, draftContent: string): WorkspaceTreeState;
export declare function replaceFileDocument(state: WorkspaceTreeState, tabId: string, document: ProjectFileDocument): WorkspaceTreeState;
export declare function setFileTabSaving(state: WorkspaceTreeState, tabId: string, isSaving: boolean, saveError?: string | null): WorkspaceTreeState;
export declare function setFileTabLoadError(state: WorkspaceTreeState, tabId: string, loadError: string): WorkspaceTreeState;
export declare function setFileTabLoading(state: WorkspaceTreeState, tabId: string, isLoading: boolean): WorkspaceTreeState;
export declare function setTerminalSessionReady(state: WorkspaceTreeState, tabId: string, session: TerminalSession): WorkspaceTreeState;
export declare function setTerminalLaunchError(state: WorkspaceTreeState, tabId: string, launchError: string): WorkspaceTreeState;
export declare function appendTerminalOutput(state: WorkspaceTreeState, sessionId: string, chunk: string): WorkspaceTreeState;
export declare function markTerminalExited(state: WorkspaceTreeState, sessionId: string, exitCode: number | null, signalCode: number | null): WorkspaceTreeState;
export declare function removeProjectTabs(state: WorkspaceTreeState, projectId: string): WorkspaceTreeState;
export declare function collectPaneNodes(node: WorkspaceNode): WorkspacePaneNode[];
export declare function findPaneById(node: WorkspaceNode, paneId: string): WorkspacePaneNode | null;
export declare function findPaneIdForTab(node: WorkspaceNode, tabId: string): string | null;
export declare function findTerminalTabBySessionId(state: WorkspaceTreeState, sessionId: string): RuntimeWorkspaceTerminalTab | null;
