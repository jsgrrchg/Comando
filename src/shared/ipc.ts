import type { AppIdentity } from "@shared/app-identity";
import type { ChatFontFamily, EditorFontFamily } from "./typography";

export type { ChatFontFamily, EditorFontFamily } from "./typography";

export const IPC_CHANNELS = {
    getBootstrapSnapshot: "app:get-bootstrap-snapshot",
    getAppUpdateState: "app:get-update-state",
    getAppChangelog: "app:get-changelog",
    getAppPrivacyAccessState: "app:get-privacy-access-state",
    openMacOsFullDiskAccessSettings:
        "app:open-macos-full-disk-access-settings",
    checkForAppUpdates: "app:check-for-updates",
    installAppUpdateAndRestart: "app:install-update-and-restart",
    getPersistenceSnapshot: "app:get-persistence-snapshot",
    getWindowContext: "app:get-window-context",
    openProjectWindow: "app:open-project-window",
    getSettingsSnapshot: "settings:get-snapshot",
    getProjectSettings: "settings:get-project-settings",
    saveCodexRuntimeSettings: "settings:save-codex-runtime-settings",
    verifyCodexRuntimeSettings: "settings:verify-codex-runtime-settings",
    saveClaudeRuntimeSettings: "settings:save-claude-runtime-settings",
    saveGeminiRuntimeSettings: "settings:save-gemini-runtime-settings",
    saveKiloRuntimeSettings: "settings:save-kilo-runtime-settings",
    getSystemTheme: "app:get-system-theme",
    saveSettingsSnapshot: "settings:save-snapshot",
    saveProjectSettings: "settings:save-project-settings",
    openSettingsWindow: "app:open-settings-window",
    saveActiveProjectId: "app:save-active-project-id",
    saveActiveWorktreeId: "app:save-active-worktree-id",
    saveShellState: "app:save-shell-state",
    setTrafficLightVisibility: "app:set-traffic-light-visibility",
    setNativeAppearance: "app:set-native-appearance",
    resolveTsconfigForPath: "tsconfig:resolve-for-path",
    getGitRepositorySnapshot: "git:get-repository-snapshot",
    listGitBranches: "git:list-branches",
    listGitWorktrees: "git:list-worktrees",
    listGitChanges: "git:list-changes",
    listGitHistory: "git:list-history",
    getGitDiff: "git:get-diff",
    getGitCommitDetail: "git:get-commit-detail",
    stageGitPaths: "git:stage-paths",
    unstageGitPaths: "git:unstage-paths",
    discardGitPaths: "git:discard-paths",
    commitGitChanges: "git:commit",
    checkoutGitBranch: "git:checkout-branch",
    createGitWorktree: "git:create-worktree",
    removeGitWorktree: "git:remove-worktree",
    deleteLocalGitBranch: "git:delete-local-branch",
    deleteRemoteGitBranch: "git:delete-remote-branch",
    fetchGitRepository: "git:fetch",
    pullGitRepository: "git:pull",
    pushGitRepository: "git:push",
    listProjects: "projects:list",
    openProjects: "projects:open",
    cloneRepository: "projects:clone-repository",
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
    notifyFileBuffer: "workspace:notify-file-buffer",
    getChatSessionState: "workspace:get-chat-session-state",
    createTerminalSession: "terminals:create-session",
    writeTerminalInput: "terminals:write-input",
    resizeTerminalSession: "terminals:resize-session",
    closeTerminalSession: "terminals:close-session",
    getAiRuntimeStatus: "ai:get-runtime-status",
    prepareAiSession: "ai:prepare-session",
    refreshAiProjectScopes: "ai:refresh-project-scopes",
    listAiSessionHistory: "ai:list-session-history",
    getAiSessionSnapshot: "ai:get-session-snapshot",
    getAiSessionTranscriptPage: "ai:get-session-transcript-page",
    sendAiPrompt: "ai:send-prompt",
    setAiSessionMode: "ai:set-session-mode",
    setAiSessionModel: "ai:set-session-model",
    setAiSessionConfigOption: "ai:set-session-config-option",
    setAiSessionPinned: "ai:set-session-pinned",
    renameAiSession: "ai:rename-session",
    deleteAiSession: "ai:delete-session",
    cancelAiSession: "ai:cancel-session",
    closeAiSession: "ai:close-session",
    launchAiRuntimeAuth: "ai:launch-runtime-auth",
    logoutAiRuntimeAuth: "ai:logout-runtime-auth",
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
    appUpdateState: "app:update-state",
    appPrivacyAccessState: "app:privacy-access-state",
    projectTreeInvalidated: "projects:tree-invalidated",
    projectWindowRequested: "app:project-window-requested",
    themeUpdated: "app:theme-updated",
    settingsUpdated: "settings:updated",
    projectSettingsUpdated: "settings:project-updated",
    workspaceCloseActiveTab: "workspace:close-active-tab",
    workspaceReopenLastClosedTab: "workspace:reopen-last-closed-tab",
    gitRepositoryInvalidated: "git:repository-invalidated",
    gitRepositorySnapshotUpdated: "git:repository-snapshot-updated",
    gitWorktreesUpdated: "git:worktrees-updated",
    terminalData: "terminals:data",
    terminalExit: "terminals:exit",
    aiRuntimeStatus: "ai:runtime-status",
    aiSessionSnapshot: "ai:session-snapshot",
    aiSessionStreamPort: "ai:session-stream-port",
} as const;

export interface SystemTheme {
    readonly isDark: boolean;
}

export type ThemeMode = "system" | "light" | "dark";

export type ThemePreset =
    | "default"
    | "ocean"
    | "forest"
    | "amber"
    | "rose"
    | "lavender"
    | "nord"
    | "sunset"
    | "catppuccin"
    | "solarized"
    | "tokyoNight"
    | "gruvbox"
    | "ayu"
    | "nightOwl"
    | "vesper"
    | "rosePine"
    | "kanagawa"
    | "everforest"
    | "synthwave84"
    | "claude"
    | "codex";

export interface AppAiChatSettings {
    readonly chatFontFamily: ChatFontFamily;
    readonly chatFontSize: number;
    readonly composerFontFamily: ChatFontFamily;
    readonly composerFontSize: number;
    readonly reviewDiffZoom: number;
    readonly requireCmdEnterToSend: boolean;
    readonly screenshotRetentionSeconds: number;
    readonly historyRetentionDays: number;
    readonly contextUsageBarEnabled: boolean;
}

export interface AppAppearanceSettings {
    readonly fileTreeScale: number;
    readonly themeMode: ThemeMode;
    readonly themePreset: ThemePreset;
    readonly zoomFactor: number;
}

export interface ProjectAppearanceSettings {
    readonly themeMode: ThemeMode | null;
    readonly themePreset: ThemePreset | null;
}

export interface AppEditorSettings {
    readonly autoSaveDelayMs: number;
    readonly fontFamily: EditorFontFamily;
    readonly fontSize: number;
    readonly lineHeight: number;
    readonly minimapEnabled: boolean;
    readonly suggestionsEnabled: boolean;
}

export interface ProjectEditorSettings {
    readonly fontFamily: EditorFontFamily | null;
    readonly fontSize: number | null;
    readonly lineHeight: number | null;
    readonly minimapEnabled: boolean | null;
    readonly suggestionsEnabled: boolean | null;
}

export type PersistedShellSurface = "projects" | "workspace" | "composer";

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
    readonly leftCollapsed?: boolean;
    readonly leftWidth: number;
    readonly sidebarView?: "files" | "git" | "agents";
}

export type AiRuntimeId = "claude" | "codex" | "gemini" | "kilo";

export interface AiAuthMethod {
    readonly description: string;
    readonly id: string;
    readonly name: string;
}

export type ClaudeAuthMethodId =
    | "claude-ai-login"
    | "claude-login"
    | "console-login"
    | "gateway";

export type GeminiAuthMethodId = "login_with_google" | "use_gemini";

export type KiloAuthMethodId = "kilo-login";

export type CodexAuthMethodId = "chatgpt" | "codex-api-key" | "openai-api-key";

export interface CodexRuntimeSettings {
    readonly authMethod: CodexAuthMethodId | null;
    readonly binaryPath: string | null;
    readonly hasCodexApiKey: boolean;
    readonly hasOpenAiApiKey: boolean;
}

export interface CodexRuntimeSettingsInput {
    readonly authMethod: CodexAuthMethodId | null;
    readonly binaryPath: string | null;
    readonly codexApiKey: SecretValuePatch;
    readonly openaiApiKey: SecretValuePatch;
}

export type SecretValuePatch =
    | {
          readonly kind: "clear";
      }
    | {
          readonly kind: "set";
          readonly value: string;
      }
    | {
          readonly kind: "unchanged";
      };

export interface ClaudeRuntimeSettings {
    readonly authInvalidatedAtMs: number | null;
    readonly authMethod: ClaudeAuthMethodId | null;
    readonly binaryPath: string | null;
    readonly gatewayBaseUrl: string | null;
    readonly hasGatewayAuthToken: boolean;
    readonly hasGatewayCustomHeaders: boolean;
}

export interface ClaudeRuntimeSettingsInput {
    readonly authMethod: ClaudeAuthMethodId | null;
    readonly binaryPath: string | null;
    readonly gatewayAuthToken: SecretValuePatch;
    readonly gatewayBaseUrl: string | null;
    readonly gatewayCustomHeaders: SecretValuePatch;
}

export interface GeminiRuntimeSettings {
    readonly authInvalidatedAtMs: number | null;
    readonly authMethod: GeminiAuthMethodId | null;
    readonly binaryPath: string | null;
    readonly googleCloudLocation: string | null;
    readonly googleCloudProject: string | null;
    readonly hasGeminiApiKey: boolean;
    readonly hasGoogleApiKey: boolean;
}

export interface GeminiRuntimeSettingsInput {
    readonly authMethod: GeminiAuthMethodId | null;
    readonly binaryPath: string | null;
    readonly geminiApiKey: SecretValuePatch;
    readonly googleApiKey: SecretValuePatch;
    readonly googleCloudLocation: string | null;
    readonly googleCloudProject: string | null;
}

export interface KiloRuntimeSettings {
    readonly authInvalidatedAtMs: number | null;
    readonly binaryPath: string | null;
}

export interface KiloRuntimeSettingsInput {
    readonly binaryPath: string | null;
}

export interface AiSettingsSnapshot {
    readonly claude: ClaudeRuntimeSettings;
    readonly codex: CodexRuntimeSettings;
    readonly gemini: GeminiRuntimeSettings;
    readonly kilo: KiloRuntimeSettings;
}

export type AiRuntimeSource =
    | "bundled"
    | "env"
    | "path"
    | "settings"
    | "unknown"
    | "vendor";

export type AiRuntimeState = "error" | "missing" | "ready";

export interface AiRuntimeStatus {
    readonly availableCommands?: readonly AiAvailableCommand[];
    readonly authMethod: string | null;
    readonly authMethods: readonly AiAuthMethod[];
    readonly authReady: boolean;
    readonly checkedAt: string;
    readonly command: string | null;
    readonly configOptions?: readonly AiSessionConfigOption[];
    readonly hasCustomBinaryPath: boolean;
    readonly hasGatewayConfig: boolean;
    readonly hasGatewayUrl: boolean;
    readonly message: string | null;
    readonly modeId?: string | null;
    readonly modes?: readonly AiSessionMode[];
    readonly modelId?: string | null;
    readonly models?: readonly AiSessionModel[];
    readonly onboardingRequired: boolean;
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

export type AppWindowKind = "main" | "settings";

export interface WindowContextSnapshot {
    readonly projectId: string | null;
    readonly windowId: string;
    readonly windowKind: AppWindowKind;
    readonly worktreeId?: string | null;
    readonly workspaceId: string | null;
    readonly workspaceSessionId: string | null;
}

export interface PersistenceSnapshot {
    readonly activeProjectId: string | null;
    readonly activeWorktreeId?: string | null;
    readonly shellState: PersistedShellState | null;
    readonly windowContext: WindowContextSnapshot | null;
    readonly windowState: PersistedWindowState | null;
}

export interface SettingsSnapshot {
    readonly ai?: AiSettingsSnapshot | null;
    readonly aiChat?: AppAiChatSettings | null;
    readonly appearance?: AppAppearanceSettings | null;
    readonly editor?: AppEditorSettings | null;
    readonly shellState: PersistedShellState | null;
}

export interface ProjectSettingsSnapshot {
    readonly appearance: ProjectAppearanceSettings | null;
    readonly editor: ProjectEditorSettings | null;
    readonly projectId: string;
}

export interface SettingsUpdatedEvent {
    readonly appearance: AppAppearanceSettings | null;
    readonly editor: AppEditorSettings | null;
}

export type AppUpdateStatus =
    | "unsupported"
    | "idle"
    | "checking"
    | "available"
    | "downloading"
    | "downloaded"
    | "not-available"
    | "error";

export interface AppUpdateState {
    readonly autoUpdatesEnabled: boolean;
    readonly availableVersion: string | null;
    readonly canCheckForUpdates: boolean;
    readonly canInstallUpdate: boolean;
    readonly currentVersion: string;
    readonly downloadedVersion: string | null;
    readonly lastCheckedAt: string | null;
    readonly message: string;
    readonly progressPercent: number | null;
    readonly status: AppUpdateStatus;
}

export interface AppChangelogRelease {
    readonly date: string | null;
    readonly highlights: readonly string[];
    readonly version: string;
}

export type AppPrivacyAccessStatus =
    | "not-applicable"
    | "monitoring"
    | "attention-needed";

export interface AppPrivacyAccessState {
    readonly canOpenFullDiskAccessSettings: boolean;
    readonly lastDeniedPath: string | null;
    readonly lastUpdatedAt: string | null;
    readonly message: string;
    readonly status: AppPrivacyAccessStatus;
}

export interface ProjectSettingsUpdatedEvent {
    readonly projectId: string;
}

export interface OpenSettingsWindowInput {
    readonly projectId: string | null;
}

export interface OpenProjectWindowInput {
    readonly branchName?: string | null;
    readonly forceNewWindow?: boolean;
    readonly projectId: string;
    readonly worktreeId?: string | null;
}

export type TsconfigModuleResolution =
    | "bundler"
    | "classic"
    | "node"
    | "node16"
    | "nodenext";

export interface TsconfigCompilerOptionsSnapshot {
    readonly baseUrl: string | null;
    readonly moduleResolution: TsconfigModuleResolution | null;
    readonly paths: Readonly<Record<string, readonly string[]>> | null;
}

export interface TsconfigResolutionSnapshot {
    readonly aliasPatterns: readonly string[];
    readonly compilerOptions: TsconfigCompilerOptionsSnapshot | null;
    readonly configPath: string | null;
    readonly diagnosticCodesToIgnore: readonly number[];
    readonly errors: readonly string[];
    readonly projectRootPath: string | null;
}

export type GitRepositoryState =
    | "bare"
    | "error"
    | "missing"
    | "not_repo"
    | "ready";

export type GitSyncStatus =
    | "ahead"
    | "behind"
    | "diverged"
    | "in_sync"
    | "unknown";

export type GitPanelSurface = "changes" | "diffs" | "files";

export type GitTreeViewMode = "flat" | "tree";

export type GitChangeScope = "conflicted" | "staged" | "unstaged" | "untracked";

export type GitChangeKind =
    | "added"
    | "conflicted"
    | "copied"
    | "deleted"
    | "modified"
    | "renamed"
    | "typechange"
    | "untracked";

export type GitDiffLineType = "add" | "context" | "remove";

export type GitReferenceKind = "branch" | "detached" | "remote" | "tag";

export interface GitRepositoryScopeInput {
    readonly projectId: string;
    readonly worktreeId?: string | null;
}

export interface GitRemoteSummary {
    readonly aheadBy: number;
    readonly behindBy: number;
    readonly fetchUrl: string | null;
    readonly isDefault: boolean;
    readonly name: string;
    readonly pushUrl: string | null;
    readonly refName: string | null;
}

export interface GitBranchSummary {
    readonly aheadBy: number;
    readonly behindBy: number;
    readonly commitSha: string | null;
    readonly isCurrent: boolean;
    readonly isDetached: boolean;
    readonly isRemote: boolean;
    readonly kind: GitReferenceKind;
    readonly name: string;
    readonly upstreamName: string | null;
}

export interface GitCommitReference {
    readonly kind: "branch" | "head" | "other" | "remote" | "tag";
    readonly label: string;
}

export interface GitHistoryCommitSummary {
    readonly authorEmail: string;
    readonly authorName: string;
    readonly authoredAt: string;
    readonly body: string;
    readonly parentShas: readonly string[];
    readonly refs: readonly GitCommitReference[];
    readonly sha: string;
    readonly shortSha: string;
    readonly subject: string;
}

export interface GitWorktreeSummary {
    readonly branchName: string | null;
    readonly commitSha: string | null;
    readonly id: string;
    readonly isBare: boolean;
    readonly isCurrent: boolean;
    readonly isLocked: boolean;
    readonly isPrimary: boolean;
    readonly lockedReason: string | null;
    readonly projectId: string;
    readonly rootPath: string;
    readonly updatedAt: string;
}

export interface GitChangeEntry {
    readonly additions: number | null;
    readonly deletions: number | null;
    readonly hasChildren: boolean;
    readonly isBinary: boolean;
    readonly isConflicted: boolean;
    readonly isRenamed: boolean;
    readonly kind: GitChangeKind;
    readonly path: string;
    readonly previousPath: string | null;
    readonly scope: GitChangeScope;
    readonly worktreeId: string | null;
}

export interface GitDiffLine {
    readonly id: string;
    readonly text: string;
    readonly type: GitDiffLineType;
}

export interface GitDiffHunk {
    readonly id: string;
    readonly lines: readonly GitDiffLine[];
    readonly newCount: number;
    readonly newStart: number;
    readonly oldCount: number;
    readonly oldStart: number;
}

export interface GitFileDiff {
    readonly hunks: readonly GitDiffHunk[];
    readonly isText: boolean;
    readonly kind: "create" | "delete" | "move" | "update";
    readonly newText: string | null;
    readonly oldText: string | null;
    readonly path: string;
    readonly previousPath: string | null;
    readonly reversible: boolean;
}

export interface GitCommitFileDiff extends GitFileDiff {
    readonly additions: number | null;
    readonly deletions: number | null;
    readonly statusLabel: string | null;
}

export interface GitRepositoryStatusSummary {
    readonly conflictedCount: number;
    readonly changedCount: number;
    readonly stagedCount: number;
    readonly unstagedCount: number;
    readonly untrackedCount: number;
}

export interface GitRepositorySnapshot {
    readonly aheadBy: number;
    readonly behindBy: number;
    readonly branch: GitBranchSummary | null;
    readonly canonicalRootPath: string;
    readonly changedPaths: readonly string[];
    readonly changes: readonly GitChangeEntry[];
    readonly currentWorktreeId: string | null;
    readonly defaultTreeViewMode: GitTreeViewMode;
    readonly headSha: string | null;
    readonly projectId: string;
    readonly remotes: readonly GitRemoteSummary[];
    readonly repositoryState: GitRepositoryState;
    readonly rootPath: string;
    readonly selectedRemoteName: string | null;
    readonly status: GitRepositoryStatusSummary;
    readonly syncStatus: GitSyncStatus;
    readonly updatedAt: string;
    readonly worktrees: readonly GitWorktreeSummary[];
}

export interface GitRepositoryInvalidation {
    readonly occurredAt: string;
    readonly projectId: string;
    readonly reason:
        | "branch"
        | "filesystem"
        | "remote"
        | "status"
        | "unknown"
        | "worktree";
    readonly rootPath: string | null;
    readonly worktreeId: string | null;
}

export interface GitBranchListInput extends GitRepositoryScopeInput {
    readonly includeRemote?: boolean;
}

export interface GitHistoryListInput extends GitRepositoryScopeInput {
    readonly limit?: number;
}

export interface GitWorktreeListInput extends GitRepositoryScopeInput {
    readonly includeDetached?: boolean;
}

export interface GitChangesListInput extends GitRepositoryScopeInput {
    readonly includeUntracked?: boolean;
    readonly scope?: GitChangeScope | "all";
}

export interface GitDiffInput extends GitRepositoryScopeInput {
    readonly path: string;
}

export interface GitCommitDetailInput extends GitRepositoryScopeInput {
    readonly commitSha: string;
}

export interface GitStagePathsInput extends GitRepositoryScopeInput {
    readonly paths: readonly string[];
}

export interface GitUnstagePathsInput extends GitRepositoryScopeInput {
    readonly paths: readonly string[];
}

export interface GitDiscardPathsInput extends GitRepositoryScopeInput {
    readonly paths: readonly string[];
    readonly force?: boolean;
}

export interface GitCommitInput extends GitRepositoryScopeInput {
    readonly amend?: boolean;
    readonly message: string;
    readonly noVerify?: boolean;
}

export interface GitCommitResult {
    readonly branchName: string | null;
    readonly commitSha: string;
    readonly updatedAt: string;
    readonly worktreeId: string | null;
}

export interface GitCommitDetail extends GitHistoryCommitSummary {
    readonly changedFileCount: number;
    readonly committedAt: string;
    readonly committerEmail: string;
    readonly committerName: string;
    readonly deletions: number;
    readonly files: readonly GitCommitFileDiff[];
    readonly insertions: number;
}

export interface GitCheckoutBranchInput extends GitRepositoryScopeInput {
    readonly branchName: string;
    readonly force?: boolean;
    readonly newBranchName?: string | null;
    readonly startPoint?: string | null;
}

export interface GitCreateWorktreeInput extends GitRepositoryScopeInput {
    readonly branchName: string;
    readonly checkout?: boolean;
    readonly force?: boolean;
    readonly path: string;
    readonly startPoint?: string | null;
}

export interface GitRemoveWorktreeInput extends GitRepositoryScopeInput {
    readonly force?: boolean;
    readonly path: string;
}

export interface GitDeleteLocalBranchInput extends GitRepositoryScopeInput {
    readonly branchName: string;
    readonly force?: boolean;
}

export interface GitDeleteRemoteBranchInput extends GitRepositoryScopeInput {
    readonly remoteName: string;
    readonly remoteRef: string;
}

export interface GitFetchInput extends GitRepositoryScopeInput {
    readonly prune?: boolean;
    readonly remoteName?: string | null;
}

export interface GitPullInput extends GitRepositoryScopeInput {
    readonly remoteName?: string | null;
    readonly rebase?: boolean;
    readonly remoteRef?: string | null;
}

export interface GitPushInput extends GitRepositoryScopeInput {
    readonly force?: boolean;
    readonly remoteName?: string | null;
    readonly remoteRef?: string | null;
    readonly setUpstream?: boolean;
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
    readonly canonicalRootPath?: string | null;
    readonly rootPath: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly lastOpenedAt: string | null;
}

export interface ProjectAddResult {
    readonly projectIdsToOpen: readonly string[];
    readonly projects: readonly ProjectSummary[];
}

export interface CloneRepositoryInput {
    readonly repositoryUrl: string;
}

export type CloneRepositoryResult =
    | {
          readonly kind: "added";
          readonly result: ProjectAddResult;
      }
    | {
          readonly kind: "canceled";
      };

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
    readonly worktreeId?: string | null;
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
    readonly modifiedAtMs: number;
    readonly languageId: string;
    readonly languageLabel: string;
    readonly kind: "binary" | "image" | "text";
    readonly mimeType: string | null;
    readonly imageDataBase64: string | null;
    readonly sizeBytes: number;
    readonly isBinary: boolean;
    readonly isTooLarge: boolean;
}

export interface SaveProjectFileInput {
    readonly projectId: string;
    readonly relativePath: string;
    readonly content: string;
    readonly expectedModifiedAtMs?: number | null;
    readonly worktreeId?: string | null;
}

export interface FileBufferNotificationInput {
    readonly absolutePath: string;
    // null signals the buffer should be forgotten (tab closed, file saved
    // so the disk is authoritative again, etc.).
    readonly content: string | null;
}

export interface CreateProjectEntryInput {
    readonly projectId: string;
    readonly kind: ProjectEntryKind;
    readonly name: string;
    readonly parentRelativePath: string | null;
    readonly worktreeId?: string | null;
}

export interface RenameProjectEntryInput {
    readonly projectId: string;
    readonly nextName: string;
    readonly nextParentRelativePath?: string | null;
    readonly relativePath: string;
    readonly worktreeId?: string | null;
}

export interface DeleteProjectEntryInput {
    readonly projectId: string;
    readonly relativePath: string;
    readonly worktreeId?: string | null;
}

export interface RevealProjectEntryInput {
    readonly projectId: string;
    readonly relativePath: string | null;
    readonly worktreeId?: string | null;
}

export interface ProjectTreeInvalidation {
    readonly projectId: string;
    readonly occurredAt: string;
    readonly relativePaths?: readonly string[] | null;
    readonly worktreeId?: string | null;
}

export interface ListProjectTreeInput {
    readonly projectId: string;
    readonly parentRelativePath: string | null;
    readonly worktreeId?: string | null;
}

export interface OpenProjectFileInput {
    readonly projectId: string;
    readonly relativePath: string;
    readonly worktreeId?: string | null;
}

export interface CreateTerminalSessionInput {
    readonly projectId: string | null;
    readonly preferredSessionId?: string;
    readonly worktreeId?: string | null;
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
    readonly worktreeId?: string | null;
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
    readonly worktreeId?: string | null;
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
    readonly worktreeId?: string | null;
}

export interface WorkspaceChatHistoryTab {
    readonly id: string;
    readonly kind: "chat_history";
    readonly title: string;
    readonly projectId: string | null;
    readonly createdAt: string;
    readonly worktreeId?: string | null;
}

export interface WorkspaceReviewTab {
    readonly id: string;
    readonly kind: "review";
    readonly title: string;
    readonly projectId: string | null;
    readonly runtimeId: AiRuntimeId;
    readonly sessionId: string;
    readonly createdAt: string;
    readonly worktreeId?: string | null;
}

export interface WorkspaceGitTab {
    readonly id: string;
    readonly kind: "git";
    readonly title: string;
    readonly projectId: string | null;
    readonly createdAt: string;
    readonly worktreeId?: string | null;
}

export interface WorkspaceGitCommitTab {
    readonly commitSha: string;
    readonly createdAt: string;
    readonly id: string;
    readonly kind: "git_commit";
    readonly projectId: string | null;
    readonly title: string;
    readonly worktreeId?: string | null;
}

export interface WorkspaceTerminalTab {
    readonly id: string;
    readonly kind: "terminal";
    readonly title: string;
    readonly projectId: string | null;
    readonly sessionId: string;
    readonly createdAt: string;
    readonly worktreeId?: string | null;
}

export type WorkspaceTab =
    | WorkspaceFileTab
    | WorkspaceChatTab
    | WorkspaceChatHistoryTab
    | WorkspaceGitTab
    | WorkspaceGitCommitTab
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
    readonly worktreeId?: string | null;
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

export interface AiImageAttachment {
    readonly id: string;
    readonly dataBase64: string;
    readonly mimeType: string;
    readonly name: string | null;
    readonly sizeBytes: number | null;
}

export interface AiFileContextAttachment {
    readonly id: string;
    readonly projectId: string;
    readonly relativePath: string;
    readonly name: string;
    readonly extension: string | null;
    readonly languageId: string;
    readonly selectedText?: string | null;
    readonly startLine?: number | null;
    readonly endLine?: number | null;
}

export type AiComposerMessagePart =
    | { readonly type: "text"; readonly text: string }
    | {
          readonly type: "file_mention";
          readonly label: string;
          readonly path: string;
          readonly relativePath: string;
          readonly languageId: string;
      }
    | {
          readonly type: "folder_mention";
          readonly folderPath: string;
          readonly label: string;
      }
    | { readonly type: "fetch_mention" }
    | { readonly type: "plan_mention" }
    | {
          readonly type: "selection_mention";
          readonly label: string;
          readonly path: string;
          readonly selectedText: string;
          readonly startLine: number;
          readonly endLine: number;
      }
    | {
          readonly type: "file_attachment";
          readonly filePath: string;
          readonly mimeType: string;
          readonly label: string;
      }
    | {
          readonly type: "git_commit_mention";
          readonly commitSha: string;
          readonly label: string;
      };

export interface AiMessage {
    readonly attachments: readonly AiImageAttachment[];
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
    readonly visualEndLine?: number;
    readonly visualStartLine?: number;
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
    readonly createdAt: string;
    readonly diffs: readonly AiFileDiff[];
    readonly exitCode: number | null;
    readonly id: string;
    readonly kind: string;
    readonly locations: readonly string[];
    readonly rawInputJson: string | null;
    readonly rawOutputJson: string | null;
    readonly sessionId: string;
    readonly status: "completed" | "failed" | "in_progress" | "pending";
    readonly summary: string | null;
    readonly terminalOutput: string | null;
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
    readonly diffBase?: string;
    readonly currentText?: string;
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
    readonly version?: number;
}

export type AiSessionConfigCategory = "mode" | "model" | "other" | "reasoning";

export interface AiSessionModel {
    readonly description: string | null;
    readonly id: string;
    readonly name: string;
}

export interface AiSessionMode {
    readonly description: string | null;
    readonly id: string;
    readonly name: string;
}

export interface AiSessionConfigSelectOption {
    readonly description: string | null;
    readonly groupLabel: string | null;
    readonly label: string;
    readonly value: string;
}

export type AiSessionConfigOption =
    | {
          readonly category: AiSessionConfigCategory;
          readonly description: string | null;
          readonly id: string;
          readonly label: string;
          readonly type: "boolean";
          readonly value: boolean;
      }
    | {
          readonly category: AiSessionConfigCategory;
          readonly description: string | null;
          readonly id: string;
          readonly label: string;
          readonly options: readonly AiSessionConfigSelectOption[];
          readonly type: "select";
          readonly value: string;
      };

export interface AiTokenUsageCost {
    readonly amount: number;
    readonly currency: string;
}

export interface AiTokenUsage {
    readonly used: number;
    readonly size: number;
    readonly cost: AiTokenUsageCost | null;
    readonly updatedAt: string;
}

export interface AiSessionSnapshot {
    readonly availableCommands: readonly AiAvailableCommand[];
    readonly configOptions: readonly AiSessionConfigOption[];
    readonly lastError: string | null;
    readonly messages: readonly AiMessage[];
    readonly modeId: string | null;
    readonly modes: readonly AiSessionMode[];
    readonly modelId: string | null;
    readonly models: readonly AiSessionModel[];
    readonly pendingPermission: AiPermissionRequest | null;
    readonly pendingUserInput: AiUserInputRequest | null;
    readonly plan: AiPlan | null;
    readonly projectId: string | null;
    readonly runtimeId: AiRuntimeId;
    readonly runtimeSessionId: string | null;
    readonly sessionId: string;
    readonly status: AiSessionStatus;
    readonly title: string;
    readonly tokenUsage: AiTokenUsage | null;
    readonly toolActivity: readonly AiToolActivity[];
    readonly trackedFiles: readonly AiTrackedFile[];
    readonly updatedAt: string;
    readonly worktreeId?: string | null;
}

export type AiSessionPatchChanges = Partial<
    Omit<AiSessionSnapshot, "runtimeId" | "sessionId">
>;

export interface AiSessionPatch {
    readonly changes: AiSessionPatchChanges;
    readonly runtimeId: AiRuntimeId;
    readonly sessionId: string;
}

export type AiSessionUpdate =
    | {
          readonly kind: "patch";
          readonly patch: AiSessionPatch;
      }
    | {
          readonly kind: "snapshot";
          readonly snapshot: AiSessionSnapshot;
      };

export interface SendAiPromptInput {
    readonly additionalRoots?: readonly string[];
    readonly attachments: readonly AiImageAttachment[];
    readonly composerParts?: readonly AiComposerMessagePart[];
    readonly projectId: string | null;
    readonly prompt: string;
    readonly runtimeId: AiRuntimeId;
    readonly sessionId: string;
    readonly title: string;
    readonly worktreeId?: string | null;
}

export interface PrepareAiSessionInput {
    readonly projectId: string | null;
    readonly runtimeId: AiRuntimeId;
    readonly sessionId: string;
    readonly title: string;
    readonly worktreeId?: string | null;
}

export interface AiPromptResult {
    readonly sessionId: string;
    readonly stopReason: string;
}

export interface AiSessionModeMutationInput {
    readonly modeId: string;
    readonly sessionId: string;
}

export interface AiSessionModelMutationInput {
    readonly modelId: string;
    readonly sessionId: string;
}

export interface AiSessionConfigOptionMutationInput {
    readonly optionId: string;
    readonly sessionId: string;
    readonly value: boolean | string;
}

export interface AiSessionRenameMutationInput {
    readonly sessionId: string;
    readonly title: string;
}

export interface AiSessionPinnedMutationInput {
    readonly pinned: boolean;
    readonly sessionId: string;
}

export interface ListAiSessionHistoryInput {
    readonly limit?: number | null;
    readonly projectId: string | null;
    readonly worktreeId?: string | null;
}

export interface AiHistorySessionSummary {
    readonly createdAt: string;
    readonly messageCount: number;
    readonly pinnedAt?: string | null;
    readonly preview: string | null;
    readonly projectId: string | null;
    readonly runtimeId: AiRuntimeId;
    readonly sessionId: string;
    readonly title: string;
    readonly updatedAt: string;
    readonly worktreeId?: string | null;
}

export interface GetAiSessionTranscriptPageInput {
    readonly limit: number;
    readonly offset: number;
    readonly sessionId: string;
}

export interface AiSessionTranscriptPage {
    readonly messages: readonly AiMessage[];
    readonly offset: number;
    readonly sessionId: string;
    readonly totalMessages: number;
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

export interface AiRuntimeAuthLaunchInput {
    readonly methodId: string;
    readonly projectId: string | null;
    readonly runtimeId: AiRuntimeId;
    readonly worktreeId?: string | null;
}

export interface AiRuntimeAuthLogoutInput {
    readonly runtimeId: AiRuntimeId;
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
    getAppUpdateState: () => Promise<AppUpdateState>;
    getAppChangelog: () => Promise<readonly AppChangelogRelease[]>;
    getAppPrivacyAccessState: () => Promise<AppPrivacyAccessState>;
    openMacOsFullDiskAccessSettings: () => Promise<void>;
    checkForAppUpdates: () => Promise<AppUpdateState>;
    installAppUpdateAndRestart: () => Promise<void>;
    getPersistenceSnapshot: () => Promise<PersistenceSnapshot | null>;
    getWindowContext: () => Promise<WindowContextSnapshot | null>;
    readClipboardText: () => Promise<string>;
    resolveDroppedFilePath: (file: File | null) => string | null;
    writeClipboardText: (text: string) => Promise<void>;
    openProjectWindow: (input: OpenProjectWindowInput) => Promise<void>;
    getSettingsSnapshot: () => Promise<SettingsSnapshot>;
    getProjectSettings: (
        projectId: string,
    ) => Promise<ProjectSettingsSnapshot | null>;
    getSystemTheme: () => Promise<SystemTheme>;
    saveSettingsSnapshot: (snapshot: SettingsSnapshot) => Promise<void>;
    saveProjectSettings: (snapshot: ProjectSettingsSnapshot) => Promise<void>;
    openSettingsWindow: (input: OpenSettingsWindowInput) => Promise<void>;
    saveActiveProjectId: (projectId: string | null) => Promise<void>;
    saveActiveWorktreeId: (worktreeId: string | null) => Promise<void>;
    saveShellState: (snapshot: PersistedShellState | null) => Promise<void>;
    setTrafficLightVisibility: (visible: boolean) => Promise<void>;
    setNativeAppearance: (mode: ThemeMode) => Promise<void>;
    resolveTsconfigForPath: (
        filePath: string,
    ) => Promise<TsconfigResolutionSnapshot>;
    getGitRepositorySnapshot: (
        input: GitRepositoryScopeInput,
    ) => Promise<GitRepositorySnapshot | null>;
    listGitBranches: (
        input: GitBranchListInput,
    ) => Promise<readonly GitBranchSummary[]>;
    listGitWorktrees: (
        input: GitWorktreeListInput,
    ) => Promise<readonly GitWorktreeSummary[]>;
    listGitChanges: (
        input: GitChangesListInput,
    ) => Promise<readonly GitChangeEntry[]>;
    listGitHistory: (
        input: GitHistoryListInput,
    ) => Promise<readonly GitHistoryCommitSummary[]>;
    getGitDiff: (input: GitDiffInput) => Promise<GitFileDiff | null>;
    getGitCommitDetail: (
        input: GitCommitDetailInput,
    ) => Promise<GitCommitDetail | null>;
    stageGitPaths: (
        input: GitStagePathsInput,
    ) => Promise<GitRepositorySnapshot>;
    unstageGitPaths: (
        input: GitUnstagePathsInput,
    ) => Promise<GitRepositorySnapshot>;
    discardGitPaths: (
        input: GitDiscardPathsInput,
    ) => Promise<GitRepositorySnapshot>;
    commitGitChanges: (input: GitCommitInput) => Promise<GitCommitResult>;
    checkoutGitBranch: (
        input: GitCheckoutBranchInput,
    ) => Promise<GitRepositorySnapshot>;
    createGitWorktree: (
        input: GitCreateWorktreeInput,
    ) => Promise<GitWorktreeSummary>;
    removeGitWorktree: (
        input: GitRemoveWorktreeInput,
    ) => Promise<GitRepositorySnapshot>;
    deleteLocalGitBranch: (
        input: GitDeleteLocalBranchInput,
    ) => Promise<GitRepositorySnapshot>;
    deleteRemoteGitBranch: (
        input: GitDeleteRemoteBranchInput,
    ) => Promise<GitRepositorySnapshot>;
    fetchGitRepository: (
        input: GitFetchInput,
    ) => Promise<GitRepositorySnapshot>;
    pullGitRepository: (input: GitPullInput) => Promise<GitRepositorySnapshot>;
    pushGitRepository: (input: GitPushInput) => Promise<GitRepositorySnapshot>;
    listProjects: () => Promise<ProjectSummary[]>;
    openProjects: () => Promise<ProjectAddResult>;
    cloneRepository: (
        input: CloneRepositoryInput,
    ) => Promise<CloneRepositoryResult>;
    addProjectPaths: (paths: string[]) => Promise<ProjectAddResult>;
    removeProject: (projectId: string) => Promise<void>;
    touchProject: (projectId: string) => Promise<void>;
    onProjectWindowRequested: (
        listener: (payload: OpenProjectWindowInput) => void,
    ) => () => void;
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
    notifyFileBuffer: (input: FileBufferNotificationInput) => Promise<void>;
    getChatSessionState: (
        sessionId: string,
    ) => Promise<PersistedChatSessionState | null>;
    getAiRuntimeStatus: (runtimeId: AiRuntimeId) => Promise<AiRuntimeStatus>;
    prepareAiSession: (
        input: PrepareAiSessionInput,
    ) => Promise<AiSessionSnapshot>;
    refreshAiProjectScopes: (projectId: string) => Promise<void>;
    listAiSessionHistory: (
        input: ListAiSessionHistoryInput,
    ) => Promise<readonly AiHistorySessionSummary[]>;
    getAiSessionSnapshot: (
        sessionId: string,
    ) => Promise<AiSessionSnapshot | null>;
    getAiSessionTranscriptPage: (
        input: GetAiSessionTranscriptPageInput,
    ) => Promise<AiSessionTranscriptPage>;
    sendAiPrompt: (input: SendAiPromptInput) => Promise<AiPromptResult>;
    setAiSessionMode: (input: AiSessionModeMutationInput) => Promise<void>;
    setAiSessionModel: (input: AiSessionModelMutationInput) => Promise<void>;
    setAiSessionConfigOption: (
        input: AiSessionConfigOptionMutationInput,
    ) => Promise<void>;
    setAiSessionPinned: (input: AiSessionPinnedMutationInput) => Promise<void>;
    renameAiSession: (input: AiSessionRenameMutationInput) => Promise<void>;
    deleteAiSession: (sessionId: string) => Promise<void>;
    cancelAiSession: (sessionId: string) => Promise<void>;
    closeAiSession: (sessionId: string) => Promise<void>;
    respondAiPermission: (input: AiPermissionResponseInput) => Promise<void>;
    respondAiUserInput: (input: AiUserInputResponseInput) => Promise<void>;
    launchAiRuntimeAuth: (input: AiRuntimeAuthLaunchInput) => Promise<void>;
    logoutAiRuntimeAuth: (
        input: AiRuntimeAuthLogoutInput,
    ) => Promise<AiRuntimeStatus>;
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
        settings: CodexRuntimeSettingsInput,
    ) => Promise<AiRuntimeStatus>;
    verifyCodexRuntimeSettings: (
        settings: CodexRuntimeSettingsInput,
    ) => Promise<AiRuntimeStatus>;
    saveClaudeRuntimeSettings: (
        settings: ClaudeRuntimeSettingsInput,
    ) => Promise<AiRuntimeStatus>;
    saveGeminiRuntimeSettings: (
        settings: GeminiRuntimeSettingsInput,
    ) => Promise<AiRuntimeStatus>;
    saveKiloRuntimeSettings: (
        settings: KiloRuntimeSettingsInput,
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
    onAppUpdateState: (listener: (payload: AppUpdateState) => void) => () => void;
    onAppPrivacyAccessState: (
        listener: (payload: AppPrivacyAccessState) => void,
    ) => () => void;
    onGitRepositoryInvalidated: (
        listener: (payload: GitRepositoryInvalidation) => void,
    ) => () => void;
    onGitRepositorySnapshotUpdated: (
        listener: (payload: GitRepositorySnapshot) => void,
    ) => () => void;
    onGitWorktreesUpdated: (
        listener: (payload: GitRepositoryInvalidation) => void,
    ) => () => void;
    onThemeUpdated: (listener: (theme: SystemTheme) => void) => () => void;
    onSettingsUpdated: (
        listener: (payload: SettingsUpdatedEvent) => void,
    ) => () => void;
    onProjectSettingsUpdated: (
        listener: (payload: ProjectSettingsUpdatedEvent) => void,
    ) => () => void;
    onWorkspaceCloseActiveTab: (listener: () => void) => () => void;
    onWorkspaceReopenLastClosedTab: (listener: () => void) => () => void;
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
        listener: (update: AiSessionUpdate) => void,
    ) => () => void;
}
