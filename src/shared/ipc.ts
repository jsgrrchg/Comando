import type { AppIdentity } from "@shared/app-identity";

export const IPC_CHANNELS = {
    getBootstrapSnapshot: "app:get-bootstrap-snapshot",
    getPersistenceSnapshot: "app:get-persistence-snapshot",
    getSettingsSnapshot: "settings:get-snapshot",
    saveCodexRuntimeSettings: "settings:save-codex-runtime-settings",
    getSystemTheme: "app:get-system-theme",
    saveSettingsSnapshot: "settings:save-snapshot",
    saveActiveProjectId: "app:save-active-project-id",
    listProjects: "projects:list",
    openProjects: "projects:open",
    addProjectPaths: "projects:add-paths",
    removeProject: "projects:remove",
    touchProject: "projects:touch",
    listProjectTree: "projects:list-tree",
    openProjectFile: "projects:open-file",
    saveProjectFile: "projects:save-file",
    createProjectEntry: "projects:create-entry",
    renameProjectEntry: "projects:rename-entry",
    deleteProjectEntry: "projects:delete-entry",
    revealProjectEntry: "projects:reveal-entry",
    searchProjectEntries: "projects:search-entries",
    getWorkspaceSnapshot: "workspace:get-snapshot",
    saveWorkspaceSnapshot: "workspace:save-snapshot",
    getChatSessionState: "workspace:get-chat-session-state",
    createTerminalSession: "terminals:create-session",
    writeTerminalInput: "terminals:write-input",
    resizeTerminalSession: "terminals:resize-session",
    closeTerminalSession: "terminals:close-session",
    getAiRuntimeStatus: "ai:get-runtime-status",
    getAiSessionSnapshot: "ai:get-session-snapshot",
    sendAiPrompt: "ai:send-prompt",
    cancelAiSession: "ai:cancel-session",
    closeAiSession: "ai:close-session",
    respondAiPermission: "ai:respond-permission",
    respondAiUserInput: "ai:respond-user-input",
    keepAiTrackedFile: "ai:keep-tracked-file",
    rejectAiTrackedFile: "ai:reject-tracked-file",
    keepAiTrackedFileHunks: "ai:keep-tracked-file-hunks",
    rejectAiTrackedFileHunks: "ai:reject-tracked-file-hunks",
    keepAllAiTrackedFiles: "ai:keep-all-tracked-files",
    rejectAllAiTrackedFiles: "ai:reject-all-tracked-files",
} as const;

export const IPC_EVENTS = {
    projectTreeInvalidated: "projects:tree-invalidated",
    themeUpdated: "app:theme-updated",
    terminalData: "terminals:data",
    terminalExit: "terminals:exit",
    aiRuntimeStatus: "ai:runtime-status",
    aiSessionSnapshot: "ai:session-snapshot",
} as const;

export interface SystemTheme {
    readonly isDark: boolean;
}

export type PersistedShellSurface =
    | "projects"
    | "workspace"
    | "utility"
    | "composer";

export interface DatabaseStatus {
    readonly databaseFile: string;
    readonly appliedMigrations: readonly string[];
}

export interface AppBootstrapSnapshot {
    readonly app: AppIdentity;
    readonly database: DatabaseStatus;
    readonly platform: string;
    readonly startedAt: string;
    readonly versions: {
        readonly chrome: string;
        readonly electron: string;
        readonly node: string;
    };
}

export interface PersistedShellState {
    readonly activeSurface: PersistedShellSurface;
    readonly leftWidth: number;
    readonly rightWidth: number;
}

export type AiRuntimeId = "codex";

export interface CodexRuntimeSettings {
    readonly binaryPath: string | null;
}

export interface AiSettingsSnapshot {
    readonly codex: CodexRuntimeSettings;
}

export type AiRuntimeSource = "env" | "path" | "settings" | "unknown";

export type AiRuntimeState = "error" | "missing" | "ready";

export interface AiRuntimeStatus {
    readonly checkedAt: string;
    readonly command: string | null;
    readonly message: string | null;
    readonly runtimeId: AiRuntimeId;
    readonly source: AiRuntimeSource | null;
    readonly state: AiRuntimeState;
}

export interface PersistedWindowState {
    readonly height: number;
    readonly id: string;
    readonly isFullScreen: boolean;
    readonly isMaximized: boolean;
    readonly width: number;
    readonly x: number | null;
    readonly y: number | null;
}

export interface PersistenceSnapshot {
    readonly activeProjectId: string | null;
    readonly windowState: PersistedWindowState | null;
}

export interface SettingsSnapshot {
    readonly ai?: AiSettingsSnapshot | null;
    readonly shellState: PersistedShellState | null;
}

export type GitStatusBadge =
    | "added"
    | "deleted"
    | "mixed"
    | "modified"
    | "untracked";

export interface ProjectSummary {
    readonly id: string;
    readonly name: string;
    readonly rootPath: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly lastOpenedAt: string | null;
}

export interface ProjectTreeNode {
    readonly id: string;
    readonly name: string;
    readonly relativePath: string;
    readonly parentRelativePath: string | null;
    readonly kind: "directory" | "file";
    readonly extension: string | null;
    readonly hasChildren: boolean;
    readonly gitStatus: GitStatusBadge | null;
}

export interface SearchProjectEntriesInput {
    readonly limit?: number;
    readonly projectId: string;
    readonly query: string;
}

export type ProjectEntryKind = "directory" | "file";

export interface ProjectEntryMutationResult {
    readonly kind: ProjectEntryKind;
    readonly name: string;
    readonly parentRelativePath: string | null;
    readonly relativePath: string;
}

export interface ProjectFileDocument {
    readonly projectId: string;
    readonly absolutePath: string;
    readonly relativePath: string;
    readonly name: string;
    readonly content: string;
    readonly languageId: string;
    readonly languageLabel: string;
    readonly isBinary: boolean;
    readonly isTooLarge: boolean;
}

export interface SaveProjectFileInput {
    readonly projectId: string;
    readonly relativePath: string;
    readonly content: string;
}

export interface CreateProjectEntryInput {
    readonly projectId: string;
    readonly kind: ProjectEntryKind;
    readonly name: string;
    readonly parentRelativePath: string | null;
}

export interface RenameProjectEntryInput {
    readonly projectId: string;
    readonly nextName: string;
    readonly relativePath: string;
}

export interface DeleteProjectEntryInput {
    readonly projectId: string;
    readonly relativePath: string;
}

export interface RevealProjectEntryInput {
    readonly projectId: string;
    readonly relativePath: string | null;
}

export interface ProjectTreeInvalidation {
    readonly projectId: string;
    readonly occurredAt: string;
}

export interface ListProjectTreeInput {
    readonly projectId: string;
    readonly parentRelativePath: string | null;
}

export interface OpenProjectFileInput {
    readonly projectId: string;
    readonly relativePath: string;
}

export interface CreateTerminalSessionInput {
    readonly projectId: string | null;
    readonly preferredSessionId?: string;
}

export interface ResizeTerminalSessionInput {
    readonly sessionId: string;
    readonly cols: number;
    readonly rows: number;
}

export interface WriteTerminalInput {
    readonly sessionId: string;
    readonly data: string;
}

export interface TerminalSession {
    readonly sessionId: string;
    readonly projectId: string | null;
    readonly cwd: string;
}

export interface TerminalDataEvent {
    readonly sessionId: string;
    readonly data: string;
}

export interface TerminalExitEvent {
    readonly sessionId: string;
    readonly exitCode: number | null;
    readonly signalCode: number | null;
}

export type WorkspaceAxis = "horizontal" | "vertical";

export interface WorkspacePaneNode {
    readonly id: string;
    readonly type: "pane";
    readonly tabIds: readonly string[];
    readonly activeTabId: string | null;
}

export interface WorkspaceSplitNode {
    readonly id: string;
    readonly type: "split";
    readonly axis: WorkspaceAxis;
    readonly children: readonly WorkspaceNode[];
    readonly sizes: readonly number[];
}

export type WorkspaceNode = WorkspacePaneNode | WorkspaceSplitNode;

export interface WorkspaceFileTab {
    readonly id: string;
    readonly kind: "file";
    readonly title: string;
    readonly projectId: string;
    readonly relativePath: string;
    readonly createdAt: string;
}

export interface WorkspaceChatTab {
    readonly id: string;
    readonly kind: "chat";
    readonly title: string;
    readonly projectId: string | null;
    readonly runtimeId: AiRuntimeId;
    readonly sessionId: string;
    readonly draft: string;
    readonly createdAt: string;
}

export interface WorkspaceReviewTab {
    readonly id: string;
    readonly kind: "review";
    readonly title: string;
    readonly projectId: string | null;
    readonly runtimeId: AiRuntimeId;
    readonly sessionId: string;
    readonly createdAt: string;
}

export interface WorkspaceTerminalTab {
    readonly id: string;
    readonly kind: "terminal";
    readonly title: string;
    readonly projectId: string | null;
    readonly sessionId: string;
    readonly createdAt: string;
}

export type WorkspaceTab =
    | WorkspaceFileTab
    | WorkspaceChatTab
    | WorkspaceReviewTab
    | WorkspaceTerminalTab;

export interface WorkspaceSnapshot {
    readonly activePaneId: string;
    readonly rootNode: WorkspaceNode;
    readonly tabs: readonly WorkspaceTab[];
}

export interface PersistedChatSessionState {
    readonly draft: string;
    readonly events: readonly ChatSessionEvent[];
    readonly messageCount: number;
    readonly projectId: string | null;
    readonly reviewArtifacts: readonly ReviewArtifact[];
    readonly sessionId: string;
    readonly title: string;
    readonly transcriptJson: string;
    readonly updatedAt: string;
}

export interface ChatSessionEvent {
    readonly id: string;
    readonly sessionId: string;
    readonly sequence: number;
    readonly eventType: string;
    readonly payloadJson: string;
    readonly createdAt: string;
}

export interface ReviewArtifact {
    readonly id: string;
    readonly sessionId: string | null;
    readonly artifactType: string;
    readonly title: string;
    readonly path: string | null;
    readonly payloadJson: string;
    readonly createdAt: string;
    readonly updatedAt: string;
}

export type AiSessionStatus =
    | "error"
    | "idle"
    | "starting"
    | "streaming"
    | "waiting_permission"
    | "waiting_user_input";

export type AiMessageKind =
    | "assistant"
    | "thinking"
    | "user"
    | "user_input_request";

export interface AiMessage {
    readonly content: string;
    readonly createdAt: string;
    readonly id: string;
    readonly kind: AiMessageKind;
    readonly status: "completed" | "streaming";
}

export interface AiDiffHunkLine {
    readonly id: string;
    readonly text: string;
    readonly type: "add" | "context" | "remove";
}

export interface AiDiffHunk {
    readonly id: string;
    readonly lines: readonly AiDiffHunkLine[];
    readonly newCount: number;
    readonly newStart: number;
    readonly oldCount: number;
    readonly oldStart: number;
}

export type AiFileDiffHunk = AiDiffHunk;
export type AiFileDiffHunkLine = AiDiffHunkLine;

export interface AiFileDiff {
    readonly hunks: readonly AiDiffHunk[];
    readonly isText: boolean;
    readonly kind: "create" | "delete" | "move" | "update";
    readonly newText: string | null;
    readonly oldText: string | null;
    readonly path: string;
    readonly previousPath: string | null;
    readonly reversible: boolean;
}

export interface AiToolActivity {
    readonly diffs: readonly AiFileDiff[];
    readonly id: string;
    readonly kind: string;
    readonly locations: readonly string[];
    readonly rawInputJson: string | null;
    readonly rawOutputJson: string | null;
    readonly sessionId: string;
    readonly status: "completed" | "failed" | "in_progress" | "pending";
    readonly summary: string | null;
    readonly title: string;
    readonly updatedAt: string;
}

export interface AiPlanEntry {
    readonly content: string;
    readonly priority: "high" | "low" | "medium";
    readonly status: "completed" | "in_progress" | "pending";
}

export interface AiPlan {
    readonly entries: readonly AiPlanEntry[];
    readonly updatedAt: string;
}

export interface AiAvailableCommand {
    readonly description: string;
    readonly id: string;
    readonly insertText: string;
    readonly label: string;
}

export interface AiPermissionOption {
    readonly kind:
        | "allow_always"
        | "allow_once"
        | "reject_always"
        | "reject_once";
    readonly name: string;
    readonly optionId: string;
}

export interface AiPermissionRequest {
    readonly options: readonly AiPermissionOption[];
    readonly requestId: string;
    readonly sessionId: string;
    readonly title: string;
    readonly toolCallId: string;
    readonly updatedAt: string;
}

export interface AiUserInputQuestionOption {
    readonly description: string | null;
    readonly label: string;
}

export interface AiUserInputQuestion {
    readonly header: string;
    readonly id: string;
    readonly isOther: boolean;
    readonly isSecret: boolean;
    readonly options: readonly AiUserInputQuestionOption[];
    readonly question: string;
}

export interface AiUserInputRequest {
    readonly questions: readonly AiUserInputQuestion[];
    readonly requestId: string;
    readonly sessionId: string;
    readonly title: string;
    readonly toolCallId: string;
    readonly turnId: string | null;
    readonly updatedAt: string;
}

export interface AiTrackedFile {
    readonly identityKey: string;
    readonly hunks: readonly AiDiffHunk[];
    readonly isText: boolean;
    readonly kind: "create" | "delete" | "move" | "update";
    readonly newText: string | null;
    readonly oldText: string | null;
    readonly path: string;
    readonly previousPath: string | null;
    readonly reviewState: "kept" | "pending" | "rejected";
    readonly reversible: boolean;
    readonly sessionId: string;
    readonly toolCallId: string | null;
    readonly updatedAt: string;
}

export interface AiSessionSnapshot {
    readonly availableCommands: readonly AiAvailableCommand[];
    readonly lastError: string | null;
    readonly messages: readonly AiMessage[];
    readonly pendingPermission: AiPermissionRequest | null;
    readonly pendingUserInput: AiUserInputRequest | null;
    readonly plan: AiPlan | null;
    readonly projectId: string | null;
    readonly runtimeId: AiRuntimeId;
    readonly runtimeSessionId: string | null;
    readonly sessionId: string;
    readonly status: AiSessionStatus;
    readonly title: string;
    readonly toolActivity: readonly AiToolActivity[];
    readonly trackedFiles: readonly AiTrackedFile[];
    readonly updatedAt: string;
}

export interface SendAiPromptInput {
    readonly projectId: string | null;
    readonly prompt: string;
    readonly runtimeId: AiRuntimeId;
    readonly sessionId: string;
    readonly title: string;
}

export interface AiPromptResult {
    readonly sessionId: string;
    readonly stopReason: string;
}

export interface AiPermissionResponseInput {
    readonly optionId: string | null;
    readonly requestId: string;
    readonly sessionId: string;
}

export interface AiUserInputAnswer {
    readonly answers: readonly string[];
    readonly questionId: string;
}

export interface AiUserInputResponseInput {
    readonly answers: readonly AiUserInputAnswer[];
    readonly requestId: string;
    readonly sessionId: string;
}

export interface AiTrackedFileMutationInput {
    readonly path: string;
    readonly sessionId: string;
}

export interface AiTrackedFileHunkMutationInput {
    readonly hunkIds: readonly string[];
    readonly path: string;
    readonly sessionId: string;
}

export interface ComandoApi {
    getBootstrapSnapshot: () => Promise<AppBootstrapSnapshot>;
    getPersistenceSnapshot: () => Promise<PersistenceSnapshot>;
    getSettingsSnapshot: () => Promise<SettingsSnapshot>;
    getSystemTheme: () => Promise<SystemTheme>;
    saveSettingsSnapshot: (snapshot: SettingsSnapshot) => Promise<void>;
    saveActiveProjectId: (projectId: string | null) => Promise<void>;
    listProjects: () => Promise<ProjectSummary[]>;
    openProjects: () => Promise<ProjectSummary[]>;
    addProjectPaths: (paths: string[]) => Promise<ProjectSummary[]>;
    removeProject: (projectId: string) => Promise<void>;
    touchProject: (projectId: string) => Promise<void>;
    listProjectTree: (
        input: ListProjectTreeInput,
    ) => Promise<ProjectTreeNode[]>;
    searchProjectEntries: (
        input: SearchProjectEntriesInput,
    ) => Promise<ProjectTreeNode[]>;
    openProjectFile: (
        input: OpenProjectFileInput,
    ) => Promise<ProjectFileDocument>;
    saveProjectFile: (
        input: SaveProjectFileInput,
    ) => Promise<ProjectFileDocument>;
    createProjectEntry: (
        input: CreateProjectEntryInput,
    ) => Promise<ProjectEntryMutationResult>;
    renameProjectEntry: (
        input: RenameProjectEntryInput,
    ) => Promise<ProjectEntryMutationResult>;
    deleteProjectEntry: (input: DeleteProjectEntryInput) => Promise<void>;
    revealProjectEntry: (input: RevealProjectEntryInput) => Promise<void>;
    getWorkspaceSnapshot: () => Promise<WorkspaceSnapshot>;
    saveWorkspaceSnapshot: (snapshot: WorkspaceSnapshot) => Promise<void>;
    getChatSessionState: (
        sessionId: string,
    ) => Promise<PersistedChatSessionState | null>;
    getAiRuntimeStatus: (runtimeId: AiRuntimeId) => Promise<AiRuntimeStatus>;
    getAiSessionSnapshot: (
        sessionId: string,
    ) => Promise<AiSessionSnapshot | null>;
    sendAiPrompt: (input: SendAiPromptInput) => Promise<AiPromptResult>;
    cancelAiSession: (sessionId: string) => Promise<void>;
    closeAiSession: (sessionId: string) => Promise<void>;
    respondAiPermission: (input: AiPermissionResponseInput) => Promise<void>;
    respondAiUserInput: (input: AiUserInputResponseInput) => Promise<void>;
    keepAiTrackedFile: (input: AiTrackedFileMutationInput) => Promise<void>;
    rejectAiTrackedFile: (input: AiTrackedFileMutationInput) => Promise<void>;
    keepAiTrackedFileHunks: (
        input: AiTrackedFileHunkMutationInput,
    ) => Promise<void>;
    rejectAiTrackedFileHunks: (
        input: AiTrackedFileHunkMutationInput,
    ) => Promise<void>;
    keepAllAiTrackedFiles: (sessionId: string) => Promise<void>;
    rejectAllAiTrackedFiles: (sessionId: string) => Promise<void>;
    saveCodexRuntimeSettings: (
        settings: CodexRuntimeSettings,
    ) => Promise<AiRuntimeStatus>;
    createTerminalSession: (
        input: CreateTerminalSessionInput,
    ) => Promise<TerminalSession>;
    writeTerminalInput: (input: WriteTerminalInput) => Promise<void>;
    resizeTerminalSession: (input: ResizeTerminalSessionInput) => Promise<void>;
    closeTerminalSession: (sessionId: string) => Promise<void>;
    onProjectTreeInvalidated: (
        listener: (payload: ProjectTreeInvalidation) => void,
    ) => () => void;
    onThemeUpdated: (listener: (theme: SystemTheme) => void) => () => void;
    onTerminalData: (
        listener: (event: TerminalDataEvent) => void,
    ) => () => void;
    onTerminalExit: (
        listener: (event: TerminalExitEvent) => void,
    ) => () => void;
    onAiRuntimeStatus: (
        listener: (status: AiRuntimeStatus) => void,
    ) => () => void;
    onAiSessionSnapshot: (
        listener: (snapshot: AiSessionSnapshot) => void,
    ) => () => void;
}
