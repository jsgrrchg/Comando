import type { AppIdentity } from "@shared/app-identity";
import type { AiReviewActionLogState } from "./ai-review-action-log";
import type { AppTerminalSettings } from "./terminal-settings";
import type { ChatFontFamily, EditorFontFamily } from "./typography";
import type { WorkspaceLocation } from "./workspace-context";

export type { AppTerminalSettings } from "./terminal-settings";
export type { ChatFontFamily, EditorFontFamily } from "./typography";

export const IPC_CHANNELS = {
    getBootstrapSnapshot: "app:get-bootstrap-snapshot",
    getAppUpdateState: "app:get-update-state",
    getAppPrivacyAccessState: "app:get-privacy-access-state",
    openMacOsFullDiskAccessSettings:
        "app:open-macos-full-disk-access-settings",
    checkForAppUpdates: "app:check-for-updates",
    installAppUpdateAndRestart: "app:install-update-and-restart",
    getPersistenceSnapshot: "app:get-persistence-snapshot",
    getWindowContext: "app:get-window-context",
    readClipboardText: "app:read-clipboard-text",
    writeClipboardText: "app:write-clipboard-text",
    openExternalUrl: "app:open-external-url",
    openGeneratedImage: "app:open-generated-image",
    revealGeneratedImage: "app:reveal-generated-image",
    openProjectWindow: "app:open-project-window",
    confirmWorkspaceClose: "workspace:confirm-close",
    checkCommandAvailability: "app:check-command-availability",
    readClaudeCodeTranscript: "app:read-claude-code-transcript",
    getSettingsSnapshot: "settings:get-snapshot",
    getProjectSettings: "settings:get-project-settings",
    saveCodexRuntimeSettings: "settings:save-codex-runtime-settings",
    verifyCodexRuntimeSettings: "settings:verify-codex-runtime-settings",
    saveClaudeRuntimeSettings: "settings:save-claude-runtime-settings",
    saveGrokRuntimeSettings: "settings:save-grok-runtime-settings",
    saveKiloRuntimeSettings: "settings:save-kilo-runtime-settings",
    saveOpenCodeRuntimeSettings: "settings:save-opencode-runtime-settings",
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
    listGitWorktreeDiff: "git:list-worktree-diff",
    getGitDiff: "git:get-diff",
    getGitOriginalFile: "git:get-original-file",
    getGitCommitDetail: "git:get-commit-detail",
    initGitRepository: "git:init-repository",
    stageGitPaths: "git:stage-paths",
    unstageGitPaths: "git:unstage-paths",
    discardGitPaths: "git:discard-paths",
    commitGitChanges: "git:commit",
    checkoutGitBranch: "git:checkout-branch",
    createGitBranch: "git:create-branch",
    createGitWorktree: "git:create-worktree",
    removeGitWorktree: "git:remove-worktree",
    deleteLocalGitBranch: "git:delete-local-branch",
    deleteRemoteGitBranch: "git:delete-remote-branch",
    fetchGitRepository: "git:fetch",
    pullGitRepository: "git:pull",
    pushGitRepository: "git:push",
    getGitHubAuthStatus: "github:get-auth-status",
    saveGitHubToken: "github:save-token",
    clearGitHubToken: "github:clear-token",
    listGitHubIssues: "github:list-issues",
    getGitHubIssue: "github:get-issue",
    createGitHubIssue: "github:create-issue",
    updateGitHubIssue: "github:update-issue",
    setGitHubIssueLabels: "github:set-issue-labels",
    commentGitHubIssue: "github:comment-issue",
    updateGitHubComment: "github:update-comment",
    closeGitHubIssue: "github:close-issue",
    reopenGitHubIssue: "github:reopen-issue",
    listGitHubPullRequests: "github:list-pull-requests",
    getGitHubPullRequest: "github:get-pull-request",
    getGitHubPullRequestDiff: "github:get-pull-request-diff",
    listGitHubPullRequestChecks: "github:list-pull-request-checks",
    createGitHubPullRequest: "github:create-pull-request",
    updateGitHubPullRequest: "github:update-pull-request",
    commentGitHubPullRequest: "github:comment-pull-request",
    markGitHubPullRequestReady: "github:mark-pull-request-ready",
    convertGitHubPullRequestToDraft: "github:convert-pull-request-to-draft",
    requestGitHubPullRequestReviewers:
        "github:request-pull-request-reviewers",
    listGitHubWorkflowRuns: "github:list-workflow-runs",
    listGitHubWorkflowRunJobs: "github:list-workflow-run-jobs",
    getGitHubWorkflowJobLogs: "github:get-workflow-job-logs",
    listGitHubWorkflowRunArtifacts: "github:list-workflow-run-artifacts",
    listGitHubCheckRunAnnotations: "github:list-check-run-annotations",
    rerunGitHubWorkflowRunFailedJobs: "github:rerun-workflow-run-failed-jobs",
    cancelGitHubWorkflowRun: "github:cancel-workflow-run",
    listGitHubNotifications: "github:list-notifications",
    listGitHubReleases: "github:list-releases",
    generateGitHubReleaseNotes: "github:generate-release-notes",
    createGitHubRelease: "github:create-release",
    publishGitHubRelease: "github:publish-release",
    listGitHubLabels: "github:list-labels",
    listGitHubMilestones: "github:list-milestones",
    listProjects: "projects:list",
    openProjects: "projects:open",
    cloneRepository: "projects:clone-repository",
    addProjectPaths: "projects:add-paths",
    clearProjectAppData: "projects:clear-app-data",
    getProjectAppDataSummary: "projects:get-app-data-summary",
    relocateProject: "projects:relocate",
    removeProject: "projects:remove",
    touchProject: "projects:touch",
    listProjectTree: "projects:list-tree",
    openProjectFile: "projects:open-file",
    saveProjectFile: "projects:save-file",
    createProjectEntry: "projects:create-entry",
    copyProjectEntries: "projects:copy-entries",
    copyExternalProjectEntries: "projects:copy-external-entries",
    renameProjectEntry: "projects:rename-entry",
    deleteProjectEntry: "projects:delete-entry",
    trashProjectEntry: "projects:trash-entry",
    openProjectEntryExternally: "projects:open-entry-externally",
    revealProjectEntry: "projects:reveal-entry",
    listProjectEntries: "projects:list-entries",
    searchProjectEntries: "projects:search-entries",
    getWorkspaceSnapshot: "workspace:get-snapshot",
    saveWorkspaceSnapshot: "workspace:save-snapshot",
    initializeWorkspaceSurfaces: "workspace:initialize-surfaces",
    activateWorkspaceSurface: "workspace:activate-surface",
    listOpenWorkspaceLocations: "workspace:list-open-locations",
    activateWorkspaceLocation: "workspace:activate-location",
    captureWorkspaceSurfaceContext: "workspace:capture-surface-context",
    dispatchWorkspaceSurfaceDrag: "workspace:dispatch-surface-drag",
    dispatchWorkspaceSurfaceAction: "workspace:dispatch-surface-action",
    claimWorkspaceSurfaceAction: "workspace:claim-surface-action",
    completeWorkspaceSurfaceAction: "workspace:complete-surface-action",
    notifyWorkspaceSurfaceReady: "workspace:notify-surface-ready",
    revealWorkspaceSurfaceFileInHostTree:
        "workspace:reveal-surface-file-in-host-tree",
    notifyWorkspaceSurfaceFocused: "workspace:notify-surface-focused",
    requestWorkspaceSurfaceContext: "workspace:request-surface-context",
    openWorkspaceSurfaceGitScopeMenu: "workspace:open-surface-git-scope-menu",
    openWorkspaceSurfaceProjectMenu: "workspace:open-surface-project-menu",
    showWorkspaceContextMenu: "workspace:show-context-menu",
    moveWorkspaceContext: "workspace:move-context",
    showNativeContextMenu: "app:show-native-context-menu",
    setWorkspaceSurfaceContentInset: "workspace:set-surface-content-inset",
    setWorkspaceSurfaceContentLeftInset: "workspace:set-surface-content-left-inset",
    notifyFileBuffer: "workspace:notify-file-buffer",
    getChatSessionState: "workspace:get-chat-session-state",
    createTerminalSession: "terminals:create-session",
    writeTerminalInput: "terminals:write-input",
    resizeTerminalSession: "terminals:resize-session",
    closeTerminalSession: "terminals:close-session",
    getAiEnvironmentDiagnostics: "ai:get-environment-diagnostics",
    getAiRuntimeStatus: "ai:get-runtime-status",
    prepareAiSession: "ai:prepare-session",
    refreshAiProjectScopes: "ai:refresh-project-scopes",
    listAiSessionHistory: "ai:list-session-history",
    getAiSessionSnapshot: "ai:get-session-snapshot",
    resyncAiSession: "ai:resync-session",
    getAiSessionTranscriptPage: "ai:get-session-transcript-page",
    getAiTranscriptCapability: "ai:get-transcript-capability",
    getAiTranscriptBlockMetadata: "ai:get-transcript-block-metadata",
    getAiTranscriptBlock: "ai:get-transcript-block",
    getAiTranscriptPayload: "ai:get-transcript-payload",
    getAiTranscriptPayloads: "ai:get-transcript-payloads",
    getAiPromptQueue: "ai:get-prompt-queue",
    enqueueAiPrompt: "ai:enqueue-prompt",
    removeAiQueuedPrompt: "ai:remove-queued-prompt",
    clearAiPromptQueue: "ai:clear-prompt-queue",
    beginEditAiQueuedPrompt: "ai:begin-edit-queued-prompt",
    cancelEditAiQueuedPrompt: "ai:cancel-edit-queued-prompt",
    updateAiQueuedPrompt: "ai:update-queued-prompt",
    steerAiQueuedPrompt: "ai:steer-queued-prompt",
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
    disconnectAiRuntimeAuth: "ai:disconnect-runtime-auth",
    respondAiPermission: "ai:respond-permission",
    respondAiUserInput: "ai:respond-user-input",
    keepAiTrackedFile: "ai:keep-tracked-file",
    rejectAiTrackedFile: "ai:reject-tracked-file",
    keepAiTrackedFileHunks: "ai:keep-tracked-file-hunks",
    rejectAiTrackedFileHunks: "ai:reject-tracked-file-hunks",
    keepAllAiTrackedFiles: "ai:keep-all-tracked-files",
    rejectAllAiTrackedFiles: "ai:reject-all-tracked-files",
    loadAiReviewDelta: "ai:load-review-delta",
    releaseAiReviewDelta: "ai:release-review-delta",
    loadAiToolActivityDetail: "ai:load-tool-activity-detail",
} as const;

export const IPC_EVENTS = {
    appUpdateState: "app:update-state",
    appPrivacyAccessState: "app:privacy-access-state",
    settingsCategoryRequested: "settings:category-requested",
    projectAppDataCleared: "projects:app-data-cleared",
    projectsUpdated: "projects:updated",
    projectTreeInvalidated: "projects:tree-invalidated",
    projectWindowRequested: "app:project-window-requested",
    themeUpdated: "app:theme-updated",
    settingsUpdated: "settings:updated",
    projectSettingsUpdated: "settings:project-updated",
    sidebarToggleRequested: "shell:sidebar-toggle-requested",
    workspaceCloseActiveTab: "workspace:close-active-tab",
    workspaceReopenLastClosedTab: "workspace:reopen-last-closed-tab",
    workspaceSwitcherRequested: "workspace:switcher-requested",
    workspaceFlushRequested: "workspace:flush-requested",
    workspaceFlushAcknowledged: "workspace:flush-acknowledged",
    workspaceSurfaceSnapshotRequested: "workspace:surface-snapshot-requested",
    workspaceSurfaceSnapshotCaptured: "workspace:surface-snapshot-captured",
    workspaceSurfaceSnapshotUpdated: "workspace:surface-snapshot-updated",
    workspaceSurfaceFocused: "workspace:surface-focused",
    workspaceSurfaceContextRequested: "workspace:surface-context-requested",
    workspaceSurfaceDrag: "workspace:surface-drag",
    workspaceSurfaceActionRequested: "workspace:surface-action-requested",
    workspaceSurfaceActionStatus: "workspace:surface-action-status",
    workspaceSurfaceFileRevealRequested:
        "workspace:surface-file-reveal-requested",
    workspaceSurfaceGitScopeMenuRequested:
        "workspace:surface-git-scope-menu-requested",
    workspaceSurfaceProjectMenuRequested: "workspace:surface-project-menu-requested",
    gitRepositoryInvalidated: "git:repository-invalidated",
    gitRepositorySnapshotUpdated: "git:repository-snapshot-updated",
    gitWorktreesUpdated: "git:worktrees-updated",
    githubAuthUpdated: "github:auth-updated",
    terminalData: "terminals:data",
    terminalExit: "terminals:exit",
    aiRuntimeStatus: "ai:runtime-status",
    aiSessionSnapshot: "ai:session-snapshot",
    aiSessionEvent: "ai:session-event",
    aiPromptQueue: "ai:prompt-queue",
    aiSessionStreamPort: "ai:session-stream-port",
    nativeBackendEvent: "native-backend:event",
} as const;

export interface WorkspaceSurfaceDragEvent {
    readonly detail: object;
    readonly kind: "agent" | "github";
}

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

export type AiToolActivityDefaultExpansion = "collapsed" | "expanded";

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
    readonly toolActivityDefaultExpansion: AiToolActivityDefaultExpansion;
}

export interface AppAppearanceSettings {
    readonly agentsSidebarScale: number;
    readonly boostCodeContrast: boolean;
    readonly chromeTransparency: number;
    readonly fileTreeScale: number;
    readonly stickyFoldersEnabled: boolean;
    readonly themeMode: ThemeMode;
    readonly themePreset: ThemePreset;
    readonly transparencyEnabled: boolean;
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
    readonly relativeLineNumbersEnabled: boolean;
    readonly suggestionsEnabled: boolean;
    readonly vimModeEnabled: boolean;
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
    readonly sidebarView?:
        | "files"
        | "git"
        | "agents"
        | "issues"
        | "pull_requests";
}

export interface CheckCommandAvailabilityInput {
    readonly name: string;
}

export interface CheckCommandAvailabilityResult {
    readonly found: boolean;
    readonly path: string | null;
}

export interface ReadClaudeCodeTranscriptInput {
    readonly cwd: string;
    readonly sessionId: string;
    readonly sinceMtimeMs?: number | null;
}

export interface ReadClaudeCodeTranscriptResult {
    readonly changed: boolean;
    readonly found: boolean;
    readonly mtimeMs: number | null;
    readonly preview: string | null;
    readonly title: string | null;
}

export type AiRuntimeId =
    | "claude"
    | "codex"
    | "grok"
    | "kilo"
    | "opencode";

export interface AiAuthMethod {
    readonly description: string;
    readonly id: string;
    readonly name: string;
}

export type ClaudeAuthMethodId =
    | "anthropic-api-key"
    | "claude-ai-login"
    | "claude-login"
    | "console-login"
    | "gateway"
    | "gateway-bedrock";

export type GrokAuthMethodId = "grok-login" | "xai-api-key";

export type KiloAuthMethodId = "kilo-login" | "kilo-api-key";

export type OpenCodeAuthMethodId = "opencode-login";

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
    readonly bedrockGatewayBaseUrl: string | null;
    readonly binaryPath: string | null;
    readonly gatewayBaseUrl: string | null;
    readonly hasAnthropicApiKey: boolean;
    readonly hasGatewayAuthToken: boolean;
    readonly hasGatewayCustomHeaders: boolean;
}

export interface ClaudeRuntimeSettingsInput {
    readonly authMethod: ClaudeAuthMethodId | null;
    readonly anthropicApiKey: SecretValuePatch;
    readonly bedrockGatewayBaseUrl: string | null;
    readonly binaryPath: string | null;
    readonly gatewayAuthToken: SecretValuePatch;
    readonly gatewayBaseUrl: string | null;
    readonly gatewayCustomHeaders: SecretValuePatch;
}

export interface GrokRuntimeSettings {
    readonly authInvalidatedAtMs: number | null;
    readonly authMethod: GrokAuthMethodId | null;
    readonly binaryPath: string | null;
    readonly hasXaiApiKey: boolean;
}

export interface GrokRuntimeSettingsInput {
    readonly authMethod: GrokAuthMethodId | null;
    readonly binaryPath: string | null;
    readonly xaiApiKey: SecretValuePatch;
}

export interface KiloRuntimeSettings {
    readonly authInvalidatedAtMs: number | null;
    readonly authMethod: KiloAuthMethodId | null;
    readonly binaryPath: string | null;
    readonly hasKiloApiKey: boolean;
}

export interface KiloRuntimeSettingsInput {
    readonly authMethod: KiloAuthMethodId | null;
    readonly binaryPath: string | null;
    readonly kiloApiKey: SecretValuePatch;
}

export interface OpenCodeRuntimeSettings {
    readonly authInvalidatedAtMs: number | null;
    readonly authMethod: OpenCodeAuthMethodId | null;
    readonly binaryPath: string | null;
}

export interface OpenCodeRuntimeSettingsInput {
    readonly authMethod: OpenCodeAuthMethodId | null;
    readonly binaryPath: string | null;
}

export interface AiSettingsSnapshot {
    readonly claude: ClaudeRuntimeSettings;
    readonly codex: CodexRuntimeSettings;
    readonly grok: GrokRuntimeSettings;
    readonly kilo: KiloRuntimeSettings;
    readonly opencode: OpenCodeRuntimeSettings;
}

export type AiRuntimeSource =
    | "bundled"
    | "env"
    | "path"
    | "settings"
    | "unknown"
    | "vendor";

export type AiRuntimeState = "error" | "missing" | "ready";

export type AiAuthCredentialSource =
    | "comando-secret"
    | "environment"
    | "external-runtime"
    | "none";

export interface AiRuntimeStatus {
    readonly availableCommands?: readonly AiAvailableCommand[];
    readonly authMethod: string | null;
    readonly authMethods: readonly AiAuthMethod[];
    readonly authReady: boolean;
    readonly authCredentialSource?: AiAuthCredentialSource;
    readonly authCredentialSourceLabel?: string;
    readonly authSessionMessage?: string | null;
    readonly authStorageMessage?: string | null;
    readonly canDisconnectAuth?: boolean;
    readonly canLogoutAuth?: boolean;
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

export interface AiResolvedExecutable {
    readonly command: string;
    readonly message: string | null;
    readonly path: string | null;
    readonly source: AiRuntimeSource | null;
    readonly state: AiRuntimeState;
}

export interface AiRuntimeDiagnostic {
    readonly authCredentialSource: AiAuthCredentialSource | null;
    readonly authMethod: string | null;
    readonly authReady: boolean;
    readonly command: string | null;
    readonly executablePath: string | null;
    readonly hasCustomBinaryPath: boolean;
    readonly message: string | null;
    readonly onboardingRequired: boolean;
    readonly preferredPath: string | null;
    readonly preferredPathEntries: readonly string[];
    readonly runtimeId: AiRuntimeId;
    readonly source: AiRuntimeSource | null;
    readonly state: AiRuntimeState;
}

export interface AiRuntimePathOverrideDiagnostic {
    readonly name:
        | "COMANDO_CLAUDE_ACP_BIN"
        | "COMANDO_CODEX_ACP_BIN"
        | "COMANDO_GROK_ACP_BIN"
        | "COMANDO_KILO_ACP_BIN"
        | "COMANDO_OPENCODE_ACP_BIN";
    readonly pathOrCommand: string | null;
    readonly present: boolean;
    readonly runtimeId: AiRuntimeId;
}

export interface AiCredentialEnvironmentDiagnostic {
    readonly name:
        | "ANTHROPIC_API_KEY"
        | "ANTHROPIC_AUTH_TOKEN"
        | "ANTHROPIC_BASE_URL"
        | "ANTHROPIC_BEDROCK_BASE_URL"
        | "ANTHROPIC_CUSTOM_HEADERS"
        | "CODEX_API_KEY"
        | "GEMINI_API_KEY"
        | "GOOGLE_API_KEY"
        | "KILO_API_KEY"
        | "OPENCODE_API_KEY"
        | "OPENAI_API_KEY"
        | "XAI_API_KEY";
    readonly present: boolean;
    readonly runtimeId: AiRuntimeId;
}

export interface AiEnvironmentPathDiagnostics {
    readonly inherited: string | null;
    readonly inheritedEntries: readonly string[];
    readonly preferred: string | null;
    readonly preferredEntries: readonly string[];
}

export interface AiEnvironmentDiagnostics {
    readonly checkedAt: string;
    readonly credentialEnvironment: readonly AiCredentialEnvironmentDiagnostic[];
    readonly executables: readonly AiResolvedExecutable[];
    readonly path: AiEnvironmentPathDiagnostics;
    readonly runtimePathOverrides: readonly AiRuntimePathOverrideDiagnostic[];
    readonly runtimes: readonly AiRuntimeDiagnostic[];
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
    /** The physical BrowserWindow that hosts an embedded workspace surface. */
    readonly hostWindowId?: string | null;
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
    readonly terminal?: AppTerminalSettings | null;
}

export interface ProjectSettingsSnapshot {
    readonly appearance: ProjectAppearanceSettings | null;
    readonly editor: ProjectEditorSettings | null;
    readonly projectId: string;
}

export interface SettingsUpdatedEvent {
    readonly aiChat: AppAiChatSettings | null;
    readonly appearance: AppAppearanceSettings | null;
    readonly editor: AppEditorSettings | null;
    readonly terminal: AppTerminalSettings | null;
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

export type SettingsWindowCategory =
    | "appearance"
    | "editor"
    | "terminal"
    | "projects"
    | "github"
    | "ai"
    | "privacy"
    | "shortcuts"
    | "runtimes"
    | "updates";

export interface OpenSettingsWindowInput {
    readonly initialCategory?: SettingsWindowCategory;
    readonly projectId: string | null;
}

export interface OpenProjectWindowInput {
    readonly branchName?: string | null;
    readonly forceNewWindow?: boolean;
    readonly projectId: string;
    readonly workspaceSnapshot?: WorkspaceNavigationSnapshot;
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

export type GitDiffScope = GitChangeScope;

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

export interface GitHistoryListResult {
    readonly commits: readonly GitHistoryCommitSummary[];
    readonly matchedCount: number;
    readonly totalCount: number;
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

export interface GitRevisionFileDiff extends GitFileDiff {
    readonly additions: number | null;
    /** Missing only when the value came from an older native backend. */
    readonly contentState?: "available" | "unavailable";
    readonly deletions: number | null;
    readonly statusLabel: string | null;
}

export type GitCommitFileDiff = GitRevisionFileDiff;

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
    readonly branches: readonly GitBranchSummary[];
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
    readonly generation?: number;
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
    readonly caseSensitive?: boolean;
    readonly includeAllRefs?: boolean;
    readonly limit?: number;
    readonly query?: string;
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
    readonly scope?: GitDiffScope | "auto";
}

export type GitOriginalFileInput = GitDiffInput;

export interface GitOriginalFile {
    readonly baseText: string | null;
    readonly isText: boolean;
    readonly kind: GitChangeKind;
    readonly path: string;
    readonly previousPath: string | null;
    readonly scope: GitDiffScope;
}

export interface GitWorktreeDiffInput extends GitRepositoryScopeInput {
    readonly scopes?: readonly GitDiffScope[];
}

export interface GitWorktreeDiffFile {
    readonly additions: number | null;
    readonly deletions: number | null;
    readonly diff: GitFileDiff | null;
    readonly error: string | null;
    readonly isBinary: boolean;
    readonly isConflicted: boolean;
    readonly kind: GitChangeKind;
    readonly path: string;
    readonly previousPath: string | null;
    readonly scope: GitDiffScope;
}

export interface GitWorktreeDiffSection {
    readonly scope: GitDiffScope;
    readonly files: readonly GitWorktreeDiffFile[];
}

export interface GitWorktreeDiffResult {
    readonly projectId: string;
    readonly worktreeId: string | null;
    readonly sections: readonly GitWorktreeDiffSection[];
    readonly updatedAt: string;
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
    readonly snapshot: GitRepositorySnapshot;
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

export interface GitCreateBranchInput extends GitRepositoryScopeInput {
    readonly branchName: string;
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
    readonly all?: boolean;
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
    readonly forceWithLease?: boolean;
    readonly remoteName?: string | null;
    readonly remoteRef?: string | null;
    readonly setUpstream?: boolean;
}

export interface GitHubRepositoryRef {
    readonly host: string;
    readonly owner: string;
    readonly repo: string;
}

export type GitHubAuthState =
    | "authenticated"
    | "invalid"
    | "missing"
    | "unknown";

export type GitHubTokenSource = "gh_cli" | "stored_token";

export type GitHubErrorCode =
    | "forbidden"
    | "invalid_auth"
    | "missing_auth"
    | "missing_remote"
    | "network_error"
    | "not_found"
    | "rate_limited"
    | "timeout"
    | "unknown";

export type GitHubIssueState = "closed" | "open";

export type GitHubIssueStateReason =
    | "completed"
    | "not_planned"
    | "reopened";

export type GitHubPullRequestState = "closed" | "merged" | "open";

export interface GitHubHostInput {
    readonly host?: string | null;
}

export type GitHubAuthStatusInput = GitHubHostInput;

export interface GitHubAuthStatus {
    readonly canReadActions: boolean;
    readonly canWriteActions: boolean;
    readonly canWriteIssues: boolean;
    readonly canWritePullRequests: boolean;
    readonly checkedAt: string;
    readonly errorCode: GitHubErrorCode | null;
    readonly host: string;
    readonly readOnly: boolean;
    readonly state: GitHubAuthState;
    readonly tokenSource: GitHubTokenSource | null;
    readonly user: GitHubUserSummary | null;
}

export interface GitHubSaveTokenInput extends GitHubHostInput {
    readonly token: string;
}

export type GitHubClearTokenInput = GitHubHostInput;

export interface GitHubRepositoryInput {
    readonly repository: GitHubRepositoryRef;
}

export interface GitHubPaginationInput {
    readonly cursor?: string | null;
    readonly limit?: number | null;
}

export interface GitHubMutationInput {
    readonly clientRequestId?: string | null;
}

export interface GitHubUserSummary {
    readonly avatarUrl: string | null;
    readonly id: number;
    readonly login: string;
    readonly url: string;
}

export interface GitHubLabelSummary {
    readonly color: string;
    readonly description: string | null;
    readonly id: number;
    readonly name: string;
}

export interface GitHubMilestoneSummary {
    readonly dueOn: string | null;
    readonly id: number;
    readonly number: number;
    readonly state: GitHubIssueState;
    readonly title: string;
}

export interface GitHubCommentSummary {
    readonly author: GitHubUserSummary | null;
    readonly body: string;
    readonly createdAt: string;
    readonly id: number;
    readonly updatedAt: string;
    readonly url: string;
}

export interface GitHubIssueSummary {
    readonly assignees: readonly GitHubUserSummary[];
    readonly author: GitHubUserSummary | null;
    readonly closedAt: string | null;
    readonly commentCount: number;
    readonly createdAt: string;
    readonly id: number;
    readonly isLocked: boolean;
    readonly labels: readonly GitHubLabelSummary[];
    readonly milestone: GitHubMilestoneSummary | null;
    readonly nodeId: string;
    readonly number: number;
    readonly state: GitHubIssueState;
    readonly stateReason: GitHubIssueStateReason | null;
    readonly title: string;
    readonly updatedAt: string;
    readonly url: string;
}

export interface GitHubIssueDetail extends GitHubIssueSummary {
    readonly body: string;
    readonly comments: readonly GitHubCommentSummary[];
}

export interface GitHubListIssuesInput
    extends GitHubRepositoryInput,
        GitHubPaginationInput {
    readonly assignee?: string | null;
    readonly labels?: readonly string[] | null;
    readonly query?: string | null;
    readonly state?: GitHubIssueState | "all";
}

export interface GitHubListIssuesResult {
    readonly issues: readonly GitHubIssueSummary[];
    readonly nextCursor: string | null;
    readonly totalCount: number | null;
}

export interface GitHubGetIssueInput extends GitHubRepositoryInput {
    readonly number: number;
}

export interface GitHubCreateIssueInput
    extends GitHubRepositoryInput,
        GitHubMutationInput {
    readonly assignees?: readonly string[] | null;
    readonly body?: string | null;
    readonly labels?: readonly string[] | null;
    readonly milestoneNumber?: number | null;
    readonly title: string;
}

export interface GitHubUpdateIssueInput
    extends GitHubRepositoryInput,
        GitHubMutationInput {
    readonly body?: string | null;
    readonly labels?: readonly string[] | null;
    readonly number: number;
    readonly title?: string | null;
}

/**
 * Uses GitHub's issue-label endpoint, which also manages labels on pull requests.
 */
export interface GitHubSetIssueLabelsInput
    extends GitHubRepositoryInput,
        GitHubMutationInput {
    readonly labels: readonly string[];
    readonly number: number;
}

export interface GitHubSetIssueLabelsResult {
    readonly labels: readonly GitHubLabelSummary[];
    readonly number: number;
}

export interface GitHubCommentIssueInput
    extends GitHubRepositoryInput,
        GitHubMutationInput {
    readonly body: string;
    readonly number: number;
}

export interface GitHubUpdateCommentInput
    extends GitHubRepositoryInput,
        GitHubMutationInput {
    readonly body: string;
    readonly commentId: number;
}

export interface GitHubSetIssueStateInput
    extends GitHubRepositoryInput,
        GitHubMutationInput {
    readonly number: number;
    readonly state: GitHubIssueState;
    readonly stateReason?: GitHubIssueStateReason | null;
}

export interface GitHubPullRequestBranchRef {
    readonly label: string;
    readonly ref: string;
    readonly repository: GitHubRepositoryRef;
    readonly sha: string;
}

export interface GitHubPullRequestSummary {
    readonly additions: number | null;
    readonly author: GitHubUserSummary | null;
    readonly base: GitHubPullRequestBranchRef;
    readonly changedFileCount: number | null;
    readonly closedAt: string | null;
    readonly commentCount: number;
    readonly commitCount: number | null;
    readonly createdAt: string;
    readonly deletions: number | null;
    readonly draft: boolean;
    readonly head: GitHubPullRequestBranchRef;
    readonly id: number;
    readonly labels: readonly GitHubLabelSummary[];
    readonly mergedAt: string | null;
    readonly nodeId: string;
    readonly number: number;
    readonly state: GitHubPullRequestState;
    readonly title: string;
    readonly updatedAt: string;
    readonly url: string;
}

export interface GitHubCommitSummary {
    readonly additions: number | null;
    readonly author: GitHubUserSummary | null;
    readonly authoredAt: string;
    readonly committer: GitHubUserSummary | null;
    readonly committedAt: string;
    readonly deletions: number | null;
    readonly message: string;
    readonly parentShas: readonly string[];
    readonly sha: string;
    readonly shortSha: string;
    readonly url: string;
}

export interface GitHubPullRequestDetail extends GitHubPullRequestSummary {
    readonly body: string;
    readonly comments: readonly GitHubCommentSummary[];
    readonly commits: readonly GitHubCommitSummary[];
    readonly mergeable: boolean | null;
}

export interface GitHubPullRequestDiffResult {
    readonly additions: number;
    readonly baseSha: string;
    readonly contentComplete: boolean;
    readonly deletions: number;
    readonly fileListComplete: boolean;
    readonly files: readonly GitRevisionFileDiff[];
    readonly headSha: string;
    readonly incompleteReason: string | null;
    readonly number: number;
    readonly totalFileCount: number;
}

export type GitHubPullRequestChecksState =
    | "failure"
    | "pending"
    | "success"
    | "unknown";

export type GitHubPullRequestCheckStatus =
    | "completed"
    | "in_progress"
    | "pending"
    | "queued"
    | "unknown";

export type GitHubPullRequestCheckConclusion =
    | "action_required"
    | "cancelled"
    | "failure"
    | "neutral"
    | "skipped"
    | "startup_failure"
    | "success"
    | "timed_out"
    | "unknown";

export interface GitHubPullRequestCheckSummary {
    readonly completedAt: string | null;
    readonly conclusion: GitHubPullRequestCheckConclusion | null;
    readonly detailsUrl: string | null;
    readonly id: string;
    readonly name: string;
    readonly source: "check_run" | "status";
    readonly startedAt: string | null;
    readonly status: GitHubPullRequestCheckStatus;
}

export interface GitHubPullRequestChecksInput extends GitHubRepositoryInput {
    readonly headSha: string;
    readonly pullRequestNumber: number;
}

export interface GitHubPullRequestChecksResult {
    readonly checkedAt: string;
    readonly checks: readonly GitHubPullRequestCheckSummary[];
    readonly headSha: string;
    readonly pullRequestNumber: number;
    readonly state: GitHubPullRequestChecksState;
    readonly url: string;
}

export interface GitHubListPullRequestsInput
    extends GitHubRepositoryInput,
        GitHubPaginationInput {
    readonly base?: string | null;
    readonly head?: string | null;
    readonly query?: string | null;
    readonly state?: GitHubIssueState | "all";
}

export interface GitHubListPullRequestsResult {
    readonly nextCursor: string | null;
    readonly pullRequests: readonly GitHubPullRequestSummary[];
    readonly totalCount: number | null;
}

export interface GitHubGetPullRequestInput extends GitHubRepositoryInput {
    readonly number: number;
}

export interface GitHubGetPullRequestDiffInput
    extends GitHubRepositoryInput {
    readonly number: number;
}

export interface GitHubCreatePullRequestInput
    extends GitHubRepositoryInput,
        GitHubMutationInput {
    readonly base: string;
    readonly body?: string | null;
    readonly draft?: boolean;
    readonly head: string;
    readonly maintainerCanModify?: boolean;
    readonly title: string;
}

export interface GitHubUpdatePullRequestInput
    extends GitHubRepositoryInput,
        GitHubMutationInput {
    readonly body?: string | null;
    readonly number: number;
    readonly title?: string | null;
}

export interface GitHubCommentPullRequestInput
    extends GitHubRepositoryInput,
        GitHubMutationInput {
    readonly body: string;
    readonly number: number;
}

export interface GitHubSetPullRequestDraftStateInput
    extends GitHubRepositoryInput,
        GitHubMutationInput {
    readonly draft: boolean;
    readonly number: number;
}

export interface GitHubRequestPullRequestReviewInput
    extends GitHubRepositoryInput,
        GitHubMutationInput {
    readonly number: number;
    readonly reviewers?: readonly string[] | null;
    readonly teamReviewers?: readonly string[] | null;
}

export type GitHubWorkflowRunStatus =
    | "completed"
    | "in_progress"
    | "queued"
    | "requested"
    | "unknown"
    | "waiting";

export type GitHubWorkflowConclusion =
    | "action_required"
    | "cancelled"
    | "failure"
    | "neutral"
    | "skipped"
    | "stale"
    | "success"
    | "timed_out"
    | "unknown";

export interface GitHubWorkflowRunSummary {
    readonly branch: string;
    readonly checkSuiteId: number | null;
    readonly conclusion: GitHubWorkflowConclusion | null;
    readonly createdAt: string;
    readonly event: string;
    readonly headSha: string;
    readonly id: number;
    readonly name: string;
    readonly runAttempt: number;
    readonly runNumber: number;
    readonly status: GitHubWorkflowRunStatus;
    readonly updatedAt: string;
    readonly url: string;
    readonly workflowName: string;
}

export interface GitHubWorkflowJobStepSummary {
    readonly completedAt: string | null;
    readonly conclusion: GitHubWorkflowConclusion | null;
    readonly name: string;
    readonly number: number;
    readonly startedAt: string | null;
    readonly status: GitHubWorkflowRunStatus;
}

export interface GitHubWorkflowJobSummary {
    readonly checkRunId: number | null;
    readonly completedAt: string | null;
    readonly conclusion: GitHubWorkflowConclusion | null;
    readonly id: number;
    readonly name: string;
    readonly runnerName: string | null;
    readonly startedAt: string | null;
    readonly status: GitHubWorkflowRunStatus;
    readonly steps: readonly GitHubWorkflowJobStepSummary[];
    readonly url: string;
}

export interface GitHubWorkflowArtifactSummary {
    readonly archiveDownloadUrl: string;
    readonly createdAt: string;
    readonly expired: boolean;
    readonly expiresAt: string | null;
    readonly id: number;
    readonly name: string;
    readonly sizeInBytes: number;
    readonly updatedAt: string;
    readonly url: string;
}

export interface GitHubCheckRunAnnotationSummary {
    readonly annotationLevel: "failure" | "notice" | "warning";
    readonly blobHref: string | null;
    readonly endColumn: number | null;
    readonly endLine: number | null;
    readonly message: string;
    readonly path: string;
    readonly rawDetails: string | null;
    readonly startColumn: number | null;
    readonly startLine: number;
    readonly title: string | null;
}

export interface GitHubWorkflowRunsInput
    extends GitHubRepositoryInput,
        GitHubPaginationInput {
    readonly branch?: string | null;
    readonly headSha?: string | null;
}

export interface GitHubWorkflowRunsResult {
    readonly nextCursor: string | null;
    readonly runs: readonly GitHubWorkflowRunSummary[];
    readonly totalCount: number | null;
}

export interface GitHubWorkflowRunJobsInput
    extends GitHubRepositoryInput,
        GitHubPaginationInput {
    readonly runId: number;
}

export interface GitHubWorkflowRunJobsResult {
    readonly jobs: readonly GitHubWorkflowJobSummary[];
    readonly nextCursor: string | null;
    readonly runId: number;
    readonly totalCount: number | null;
}

export interface GitHubWorkflowJobLogsInput extends GitHubRepositoryInput {
    readonly jobId: number;
}

export interface GitHubWorkflowJobLogsResult {
    readonly jobId: number;
    readonly logs: string;
    readonly truncated: boolean;
}

export interface GitHubWorkflowRunArtifactsInput
    extends GitHubRepositoryInput,
        GitHubPaginationInput {
    readonly runId: number;
}

export interface GitHubWorkflowRunArtifactsResult {
    readonly artifacts: readonly GitHubWorkflowArtifactSummary[];
    readonly nextCursor: string | null;
    readonly runId: number;
    readonly totalCount: number | null;
}

export interface GitHubCheckRunAnnotationsInput
    extends GitHubRepositoryInput,
        GitHubPaginationInput {
    readonly checkRunId: number;
}

export interface GitHubCheckRunAnnotationsResult {
    readonly annotations: readonly GitHubCheckRunAnnotationSummary[];
    readonly checkRunId: number;
    readonly nextCursor: string | null;
}

export interface GitHubWorkflowRunMutationInput
    extends GitHubRepositoryInput,
        GitHubMutationInput {
    readonly runId: number;
}

export interface GitHubNotificationSubjectSummary {
    readonly latestCommentUrl: string | null;
    readonly title: string;
    readonly type: string;
    readonly url: string | null;
}

export interface GitHubNotificationSummary {
    readonly id: string;
    readonly lastReadAt: string | null;
    readonly reason: string;
    readonly repository: GitHubRepositoryRef;
    readonly subject: GitHubNotificationSubjectSummary;
    readonly unread: boolean;
    readonly updatedAt: string;
    readonly url: string;
}

export interface GitHubNotificationsInput
    extends GitHubHostInput,
        GitHubPaginationInput {
    readonly all?: boolean | null;
    readonly participating?: boolean | null;
}

export interface GitHubNotificationsResult {
    readonly nextCursor: string | null;
    readonly notifications: readonly GitHubNotificationSummary[];
    readonly totalCount: number | null;
}

export interface GitHubReleaseSummary {
    readonly author: GitHubUserSummary | null;
    readonly body: string;
    readonly createdAt: string;
    readonly draft: boolean;
    readonly id: number;
    readonly name: string | null;
    readonly prerelease: boolean;
    readonly publishedAt: string | null;
    readonly tagName: string;
    readonly targetCommitish: string;
    readonly updatedAt: string;
    readonly url: string;
}

export interface GitHubListReleasesInput
    extends GitHubRepositoryInput,
        GitHubPaginationInput {}

export interface GitHubListReleasesResult {
    readonly nextCursor: string | null;
    readonly releases: readonly GitHubReleaseSummary[];
    readonly totalCount: number | null;
}

export interface GitHubGenerateReleaseNotesInput extends GitHubRepositoryInput {
    readonly previousTagName?: string | null;
    readonly tagName: string;
    readonly targetCommitish?: string | null;
}

export interface GitHubGeneratedReleaseNotes {
    readonly body: string;
    readonly name: string;
    readonly tagName: string;
}

export interface GitHubCreateReleaseInput
    extends GitHubRepositoryInput,
        GitHubMutationInput {
    readonly body?: string | null;
    readonly draft: boolean;
    readonly name?: string | null;
    readonly prerelease?: boolean;
    readonly tagName: string;
    readonly targetCommitish?: string | null;
}

export interface GitHubPublishReleaseInput
    extends GitHubRepositoryInput,
        GitHubMutationInput {
    readonly releaseId: number;
}

export interface GitHubListMilestonesInput
    extends GitHubRepositoryInput,
        GitHubPaginationInput {
    readonly state?: GitHubIssueState | "all";
}

export interface GitHubListMilestonesResult {
    readonly milestones: readonly GitHubMilestoneSummary[];
    readonly nextCursor: string | null;
    readonly totalCount: number | null;
}

export type GitHubListLabelsInput = GitHubRepositoryInput &
    GitHubPaginationInput;

export interface GitHubListLabelsResult {
    readonly labels: readonly GitHubLabelSummary[];
    readonly nextCursor: string | null;
    readonly totalCount: number | null;
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

export interface ProjectAppDataSummary {
    readonly chatSessionCount: number;
    readonly projectSettingsCount: number;
    readonly recentProjectCount: number;
    readonly workspaceLayoutCount: number;
    readonly workspaceSessionCount: number;
    readonly workspaceTabCount: number;
}

export interface ClearProjectAppDataInput {
    readonly projectId: string;
}

export interface ClearProjectAppDataResult {
    readonly cleared: ProjectAppDataSummary;
    readonly projects: readonly ProjectSummary[];
}

export type ProjectRelocateResult =
    | {
          readonly kind: "canceled";
          readonly projects: readonly ProjectSummary[];
      }
    | {
          readonly kind: "relocated";
          readonly project: ProjectSummary;
          readonly projects: readonly ProjectSummary[];
      };

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
    readonly isGitIgnored: boolean;
    readonly gitStatus: GitStatusBadge | null;
}

export interface SearchProjectEntriesInput {
    readonly includeAncestorDirectories?: boolean;
    readonly limit?: number;
    readonly projectId: string;
    readonly query: string;
    readonly searchContext?: string;
    readonly worktreeId?: string | null;
}

export interface ListProjectEntriesInput {
    readonly projectId: string;
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

export interface CopyProjectEntriesInput {
    readonly destinationParentRelativePath: string | null;
    readonly projectId: string;
    readonly sourceRelativePaths: readonly string[];
    readonly worktreeId?: string | null;
}

export interface CopyProjectEntriesResult {
    readonly entries: readonly ProjectEntryMutationResult[];
}

export interface CopyExternalProjectEntriesInput {
    readonly destinationParentRelativePath: string | null;
    readonly projectId: string;
    readonly sourcePaths: readonly string[];
    readonly worktreeId?: string | null;
}

export interface CopyExternalProjectEntriesResult {
    readonly entries: readonly ProjectEntryMutationResult[];
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

export interface TrashProjectEntryInput {
    readonly projectId: string;
    readonly relativePath: string;
    readonly worktreeId?: string | null;
}

export interface OpenProjectEntryExternallyInput {
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
    readonly generation?: number;
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
    readonly cols?: number;
    readonly extraEnv?: Record<string, string>;
    readonly preferredSessionId?: string;
    readonly rows?: number;
    readonly terminalId?: string;
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
    readonly cols?: number;
    readonly exitCode?: number | null;
    readonly errorMessage?: string | null;
    readonly rows?: number;
    readonly status?: "running" | "exited" | "error";
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
    readonly pinnedTabIds?: readonly string[];
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
    readonly markdownViewMode?: "edit" | "preview";
    readonly worktreeId?: string | null;
}

export interface WorkspaceChatTab {
    readonly id: string;
    readonly kind: "chat";
    readonly title: string;
    readonly projectId: string | null;
    readonly runtimeId: AiRuntimeId;
    readonly sessionOpenMode?: "history" | "live";
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

export interface WorkspaceGitWorktreeDiffTab {
    readonly createdAt: string;
    readonly id: string;
    readonly kind: "git_worktree_diff";
    readonly projectId: string;
    readonly title: string;
    readonly worktreeId?: string | null;
}

export interface WorkspaceGitHubIssuesTab {
    readonly createdAt: string;
    readonly id: string;
    readonly kind: "github_issues";
    readonly projectId: string | null;
    readonly ref: GitHubRepositoryRef;
    readonly title: string;
    readonly worktreeId?: string | null;
}

export interface WorkspaceGitHubIssueTab {
    readonly createdAt: string;
    readonly id: string;
    readonly issueNumber: number;
    readonly kind: "github_issue";
    readonly projectId: string | null;
    readonly ref: GitHubRepositoryRef;
    readonly title: string;
    readonly worktreeId?: string | null;
}

export interface WorkspaceGitHubPullRequestsTab {
    readonly createdAt: string;
    readonly id: string;
    readonly kind: "github_pull_requests";
    readonly projectId: string | null;
    readonly ref: GitHubRepositoryRef;
    readonly title: string;
    readonly worktreeId?: string | null;
}

export interface WorkspaceGitHubPullRequestTab {
    readonly createdAt: string;
    readonly id: string;
    readonly kind: "github_pull_request";
    readonly projectId: string | null;
    readonly pullRequestNumber: number;
    readonly ref: GitHubRepositoryRef;
    readonly title: string;
    readonly worktreeId?: string | null;
}

export interface WorkspaceTerminalTab {
    readonly id: string;
    readonly kind: "terminal";
    readonly title: string;
    readonly projectId: string | null;
    readonly sessionId: string;
    readonly terminalId?: string;
    readonly createdAt: string;
    readonly worktreeId?: string | null;
}

export type WorkspaceTab =
    | WorkspaceFileTab
    | WorkspaceChatTab
    | WorkspaceChatHistoryTab
    | WorkspaceGitTab
    | WorkspaceGitCommitTab
    | WorkspaceGitWorktreeDiffTab
    | WorkspaceGitHubIssueTab
    | WorkspaceGitHubIssuesTab
    | WorkspaceGitHubPullRequestTab
    | WorkspaceGitHubPullRequestsTab
    | WorkspaceReviewTab
    | WorkspaceTerminalTab;

export interface WorkspaceLayoutSnapshot {
    readonly activePaneId: string;
    readonly rootNode: WorkspaceNode;
    readonly tabs: readonly WorkspaceTab[];
}

// Kept as an alias while persisted v1 layouts are migrated to navigation v2.
export type WorkspaceSnapshot = WorkspaceLayoutSnapshot;

export type WorkspaceContextKey = string;

export interface PersistedWorkspaceContext {
    readonly key: WorkspaceContextKey;
    readonly lastActivatedAt: string;
    readonly projectId: string;
    readonly workspace: WorkspaceLayoutSnapshot;
    readonly worktreeId: string | null;
}

export interface WorkspaceNavigationSnapshot {
    readonly activeContextKey: WorkspaceContextKey | null;
    readonly contexts: readonly PersistedWorkspaceContext[];
    readonly openContextKeys: readonly WorkspaceContextKey[];
    readonly version: 3;
}

export interface OpenWorkspaceLocationSummary extends WorkspaceLocation {
    readonly isActive: boolean;
    readonly isCurrentWindow: boolean;
    readonly lastActivatedAt: string;
    readonly windowTitle: string;
}

export type ActivateWorkspaceLocationInput = WorkspaceLocation;

export interface WorkspaceSurfaceContextRequest {
    readonly emptyLayout?: boolean;
    readonly projectId: string;
    readonly worktreeId?: string | null;
}

export interface WorkspaceSurfaceActionContext {
    readonly contextKey: WorkspaceContextKey;
    readonly projectId: string;
    readonly worktreeId: string | null;
}

/** A request emitted by a workspace surface to reveal its active file in the host sidebar. */
export interface WorkspaceSurfaceFileRevealRequest
    extends WorkspaceSurfaceActionContext {
    readonly relativePath: string;
}

export interface WorkspaceSurfaceGitHubComposerItem {
    readonly number: number;
    readonly title: string;
    readonly url: string;
}

export type WorkspaceSurfaceActionRequest = WorkspaceSurfaceActionContext &
    (
        | {
              readonly kind: "file";
              readonly origin: "git" | "quick-create" | "tree";
              readonly relativePath: string;
          }
        | {
              readonly kind: "git-history" | "git-worktree-diff";
          }
        | {
              readonly kind: "chat-session";
              readonly runtimeId: AiRuntimeId;
              readonly sessionId: string;
              readonly sessionProjectId: string | null;
              readonly sessionWorktreeId: string | null;
              readonly title: string;
          }
        | {
              readonly kind: "chat-history";
          }
        | {
              readonly kind: "new-chat";
              readonly runtimeId: AiRuntimeId;
          }
        | {
              readonly kind: "focus-terminal";
              readonly terminalId: string;
          }
        | {
              readonly kind: "new-claude-terminal";
          }
        | {
              readonly kind: "github-list";
              readonly listKind: "issues" | "pull_requests";
              readonly ref: GitHubRepositoryRef;
          }
        | {
              readonly itemKind: "issue" | "pull_request";
              readonly itemNumber: number;
              readonly kind: "github-item";
              readonly ref: GitHubRepositoryRef;
          }
        | {
              readonly files: readonly {
                  readonly name: string;
                  readonly relativePath: string;
              }[];
              readonly forceNewChat: boolean;
              readonly kind: "add-files-to-chat";
          }
        | {
              readonly forceNewChat: boolean;
              readonly itemKind: "issue" | "pull_request";
              readonly items: readonly WorkspaceSurfaceGitHubComposerItem[];
              readonly kind: "add-github-items-to-chat";
              readonly ref: GitHubRepositoryRef;
          }
    );

export interface WorkspaceSurfaceActionEnvelope {
    readonly actionId: string;
    readonly request: WorkspaceSurfaceActionRequest;
}

export interface WorkspaceSurfaceActionCompletion {
    readonly actionId: string;
    readonly error?: string;
    readonly status: "completed" | "failed";
}

export interface WorkspaceSurfaceActionStatus {
    readonly actionId: string;
    readonly message?: string;
    readonly status: "completed" | "failed" | "rejected";
}

export type WorkspaceSurfaceActionDeliveryFailureReason =
    | "inactive-context"
    | "invalid-context"
    | "missing-surface";

export type WorkspaceSurfaceActionDeliveryResult =
    | { readonly delivered: true }
    | {
          readonly delivered: false;
          readonly reason: WorkspaceSurfaceActionDeliveryFailureReason;
      };

export type WorkspaceSurfaceActionDispatchResult =
    | {
          readonly actionId: string;
          readonly delivered: true;
          readonly state: "queued" | "sent";
      }
    | Extract<WorkspaceSurfaceActionDeliveryResult, { readonly delivered: false }>;

export interface WorkspaceContextMenuInput {
    readonly canCopyFullPath: boolean;
    readonly contextKey: string;
    readonly projectId: string;
    readonly worktreeId: string | null;
    readonly x: number;
    readonly y: number;
}

export type WorkspaceContextMenuAction =
    | { readonly type: "copy_full_path" }
    | {
          readonly type: "move";
          /** A null destination asks the main process to create an empty window. */
          readonly targetWindowId: string | null;
      }
    | { readonly type: "close" };

export interface MoveWorkspaceContextInput {
    readonly contextKey: string;
    readonly projectId: string;
    readonly targetWindowId: string | null;
    readonly worktreeId: string | null;
}

export type NativeContextMenuEntry =
    | {
          readonly type: "separator";
      }
    | {
          readonly id: string;
          readonly label: string;
          readonly enabled: boolean;
          readonly children?: readonly NativeContextMenuEntry[];
      };

export interface NativeContextMenuInput {
    readonly entries: readonly NativeContextMenuEntry[];
    readonly x: number;
    readonly y: number;
}

export interface WindowWorkspaceRestoreRecord {
    readonly revision: number;
    readonly schemaVersion: 1;
    readonly snapshot: WorkspaceNavigationSnapshot;
    readonly updatedAt: string;
}

export type PersistedWorkspaceSnapshot =
    | WorkspaceLayoutSnapshot
    | WorkspaceNavigationSnapshot;

export interface PersistedChatSessionState {
    readonly draft: string;
    readonly events: readonly ChatSessionEvent[];
    readonly messageCount: number;
    readonly projectId: string | null;
    readonly reviewArtifacts: readonly ReviewArtifact[];
    readonly sessionId: string;
    readonly title: string;
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
    | "image"
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

export interface AiGeneratedImage {
    readonly error: string | null;
    readonly mimeType: string | null;
    readonly path: string | null;
    readonly result: string | null;
    readonly revisedPrompt: string | null;
    readonly status: string;
    readonly title: string;
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
      }
    | {
          readonly type: "github_issue_mention";
          readonly host: string;
          readonly owner: string;
          readonly repo: string;
          readonly number: number;
          readonly label: string;
          readonly title: string;
          readonly url: string;
      }
    | {
          readonly type: "github_pull_request_mention";
          readonly host: string;
          readonly owner: string;
          readonly repo: string;
          readonly number: number;
          readonly label: string;
          readonly title: string;
          readonly url: string;
      };

export interface AiMessage {
    readonly attachments: readonly AiImageAttachment[];
    readonly content: string;
    readonly createdAt: string;
    readonly generatedImage?: AiGeneratedImage | null;
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

export type AiToolActivityAction = {
    readonly kind: "open_session";
    readonly sessionId: string;
};

export interface AiToolActivityLocation {
    readonly endLine: number | null;
    readonly line: number | null;
    readonly path: string;
}

export interface AiToolActivityChangeStats {
    readonly additions: number;
    readonly approximate: boolean;
    readonly deletions: number;
    readonly fileCount: number;
}

export interface AiToolActivity {
    readonly action?: AiToolActivityAction | null;
    // A compact, persisted cache for activity headers. Full diffs remain the
    // source of truth and are restored only when the activity is opened.
    readonly changeStats?: AiToolActivityChangeStats | null;
    readonly createdAt: string;
    readonly diffs: readonly AiFileDiff[];
    readonly exitCode: number | null;
    readonly id: string;
    readonly kind: string;
    readonly locations: readonly AiToolActivityLocation[];
    readonly rawInputJson: string | null;
    readonly rawOutputJson: string | null;
    readonly sessionId: string;
    readonly status: "completed" | "failed" | "in_progress" | "pending";
    readonly summary: string | null;
    readonly toolActivityDetailId?: string | null;
    readonly terminalOutput: string | null;
    readonly title: string;
    readonly updatedAt: string;
}

export interface AiLoadToolActivityDetailInput {
    readonly sessionId: string;
    readonly toolActivityDetailId: string;
}

export interface AiToolActivityDetail {
    readonly diffs: readonly AiFileDiff[];
    readonly rawInputJson: string | null;
    readonly rawOutputJson: string | null;
    readonly terminalOutput: string | null;
}
export interface AiPlanEntry {
    readonly content: string;
    readonly priority: "high" | "low" | "medium";
    readonly status: "completed" | "in_progress" | "pending";
}

export interface AiPlan {
    readonly entries: readonly AiPlanEntry[];
    readonly title: string | null;
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
    readonly description: string | null;
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
    readonly conflict?: string;
    readonly identityKey: string;
    readonly diffBase?: string;
    readonly currentText?: string;
    readonly hunks: readonly AiDiffHunk[];
    readonly hunksAreAnchored?: boolean;
    readonly isText: boolean;
    readonly kind: "create" | "delete" | "move" | "update";
    readonly nativeReviewDeltaId?: string;
    readonly nativeReviewInputRevision?: number;
    readonly nativeReviewState?: AiReviewDeltaState;
    readonly nativeReviewWorkCycleId?: string;
    readonly newText: string | null;
    readonly oldText: string | null;
    readonly path: string;
    readonly previousPath: string | null;
    readonly reviewState: "conflict" | "kept" | "pending" | "rejected";
    readonly reversible: boolean;
    readonly sessionId: string;
    readonly toolCallId: string | null;
    readonly updatedAt: string;
    readonly version?: number;
}

export interface AiReviewConflict {
    readonly externalChangeHash: string | null;
    readonly path: string;
    readonly reason: string;
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
    readonly activeTurnStartedAt?: string | null;
    readonly availableCommands: readonly AiAvailableCommand[];
    readonly closedAt?: string | null;
    readonly configOptions: readonly AiSessionConfigOption[];
    readonly lastError: string | null;
    readonly messages: readonly AiMessage[];
    readonly manualTitle?: string | null;
    readonly modeId: string | null;
    readonly modes: readonly AiSessionMode[];
    readonly modelId: string | null;
    readonly models: readonly AiSessionModel[];
    readonly pendingPermission: AiPermissionRequest | null;
    readonly pendingUserInput: AiUserInputRequest | null;
    readonly plan: AiPlan | null;
    readonly parentSessionId?: string | null;
    readonly projectId: string | null;
    readonly reasoningEffort?: string | null;
    readonly runtimeId: AiRuntimeId;
    readonly runtimeSessionId: string | null;
    readonly reviewActionLog?: AiReviewActionLogState | null;
    readonly reviewDeltas?: readonly AiReviewDeltaSummary[];
    readonly sessionId: string;
    readonly status: AiSessionStatus;
    readonly title: string;
    readonly tokenUsage: AiTokenUsage | null;
    readonly toolActivity: readonly AiToolActivity[];
    readonly trackedFiles: readonly AiTrackedFile[];
    readonly updatedAt: string;
    readonly worktreeId?: string | null;
}

export type AiTranscriptEntryKind =
    | "message"
    | "thinking"
    | "tool"
    | "status"
    | "plan";

export interface AiTranscriptEntrySummary {
    readonly label: string | null;
    readonly preview: string | null;
    readonly status: string | null;
    // Tool entries retain this lightweight identity so an evicted payload can
    // still be classified and reloaded as an editable change.
    readonly toolActivityDetailId?: string | null;
    readonly toolChangeStats?: AiToolActivityChangeStats | null;
    readonly toolKind?: string | null;
}

export interface AiTranscriptEntryEnvelope {
    readonly createdAt: string;
    readonly id: string;
    readonly kind: AiTranscriptEntryKind;
    readonly payloadRef: string | null;
    readonly sequence: number;
    readonly sessionId: string;
    readonly summary: AiTranscriptEntrySummary;
    readonly updatedAt: string;
}

export interface AiTranscriptBlockMetadata {
    readonly blockId: string;
    readonly endSequence: number;
    readonly entryCount: number;
    readonly estimatedHeight: number;
    readonly estimatedRowCount: number;
    readonly firstCreatedAt: string;
    readonly lastCreatedAt: string;
    readonly revision: number;
    readonly sessionId: string;
    readonly startSequence: number;
}

export interface AiTranscriptBlock extends AiTranscriptBlockMetadata {
    readonly capabilityVersion: number;
    readonly entries: readonly AiTranscriptEntryEnvelope[];
    readonly transcriptRevision: number;
}

export interface AiTranscriptBlockMetadataOutput {
    readonly blocks: readonly AiTranscriptBlockMetadata[];
    readonly capabilityVersion: number;
    readonly sessionId: string;
    readonly transcriptRevision: number;
}

export interface AiLoadTranscriptPayloadInput {
    readonly maxBytes?: number;
    readonly payloadRef: string;
    readonly sessionId: string;
}

export interface AiLoadTranscriptPayloadsInput {
    readonly maxBytes?: number;
    readonly payloadRefs: readonly string[];
    readonly sessionId: string;
}

export interface AiTranscriptPayload {
    readonly byteLength: number;
    readonly capabilityVersion: number;
    readonly contentHash: string;
    readonly payloadRef: string;
    readonly sessionId: string;
    readonly transcriptRevision: number;
    readonly value: unknown;
}

export interface AiTranscriptPayloadsOutput {
    readonly payloads: readonly AiTranscriptPayload[];
    readonly sessionId: string;
}

export type AiTranscriptStorageMode =
    | "block-native"
    | "legacy"
    | "migrating";

export interface AiTranscriptStorageState {
    readonly capabilityVersion: number;
    readonly legacyFallbackAvailable: boolean;
    readonly migrationManifestExists: boolean;
    readonly mode: AiTranscriptStorageMode;
    readonly sessionId: string;
    readonly storageVersion: number;
}

export interface AiTranscriptCapability {
    readonly blockNativeVersion: number | null;
    readonly legacyFallbackAvailable: boolean;
}

export interface AiHistoryMigrationInput {
    readonly limit?: number | null;
    readonly mode?: string | null;
    readonly sourceDatabasePath?: string | null;
}

export interface AiHistoryMigrationError {
    readonly message: string;
    readonly sessionId: string | null;
}

export interface AiHistoryMigrationResult {
    readonly completedAt: string | null;
    readonly errors: readonly AiHistoryMigrationError[];
    readonly failedSessions: number;
    readonly migratedSessions: number;
    readonly skippedSessions: number;
    readonly startedAt: string;
    readonly updatedAt: string;
}

export interface AiHistoryStorageHealth {
    readonly healthy: boolean;
    readonly latestError: string | null;
    readonly legacyFallbackAvailable: boolean;
    readonly migrationManifestExists: boolean;
    readonly nativeSessionCount: number;
    readonly orphanedSessionDirs: number;
    readonly storageVersion: number;
}

export type AiTranscriptTerminalStatus =
    | "cancelled"
    | "completed"
    | "failed";

export interface AiTranscriptPayloadWrite {
    readonly payloadRef: string;
    readonly value: unknown;
}

export interface AiOpenTranscriptEntryRef {
    readonly entryId: string;
    readonly entryRevision: number;
    readonly ordinal: number;
}

export interface AiOpenTranscriptTailCheckpoint {
    readonly sessionId: string;
    readonly turnId: string;
    readonly terminalStatus: AiTranscriptTerminalStatus | null;
    readonly entries: readonly AiTranscriptEntryEnvelope[];
    readonly payloads: readonly AiTranscriptPayloadWrite[];
    /** Entries removed since the preceding durable checkpoint. */
    readonly removedEntryIds: readonly string[];
    /** Only entries whose persisted ordering or revision changed. */
    readonly entryOrder: readonly AiOpenTranscriptEntryRef[];
}

export interface AiOpenTranscriptTail {
    readonly sessionId: string;
    readonly turnId: string;
    readonly terminalStatus: AiTranscriptTerminalStatus | null;
    readonly updatedAt: string;
    readonly revision: number;
    readonly entries: readonly AiTranscriptEntryEnvelope[];
    readonly payloads: readonly AiTranscriptPayloadWrite[];
    readonly entryRevisions: readonly AiOpenTranscriptEntryRef[];
}

export interface AiSealTranscriptTurnInput {
    readonly sessionId: string;
    readonly turnId: string;
    readonly entries: readonly AiTranscriptEntryEnvelope[];
    readonly payloads: readonly AiTranscriptPayloadWrite[];
}

export const AI_TRANSCRIPT_BLOCK_CAPABILITY_VERSION = 1;
export const AI_TRANSCRIPT_PAYLOAD_LIMIT_MAX = 64 * 1024 * 1024;

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

export type AiSessionEventOrigin = "live" | "replay" | "restore";

export type AiSessionMessageEventKind = Exclude<
    AiMessageKind,
    "image" | "thinking" | "user_input_request"
>;

export interface AiSessionDomainEventBase {
    readonly kind:
        | "image-generation"
        | "message-completed"
        | "message-delta"
        | "message-started"
        | "permission-request"
        | "plan"
        | "review"
        | "review-delta"
        | "session-info"
        | "status"
        | "session-closed"
        | "subagent-breadcrumb"
        | "subagent-created"
        | "thinking-completed"
        | "thinking-delta"
        | "thinking-started"
        | "token-usage"
        | "tool-activity"
        | "turn-status"
        | "user-input-request";
    readonly origin: AiSessionEventOrigin;
    readonly parentSessionId: string | null;
    readonly runtimeId: AiRuntimeId;
    readonly runtimeSessionId: string | null;
    readonly sessionId: string;
    readonly updatedAt: string;
}

export interface AiSessionMessageStartedEvent
    extends AiSessionDomainEventBase {
    readonly kind: "message-started";
    readonly message: AiMessage;
    readonly messageKind: AiSessionMessageEventKind;
}

export interface AiSessionMessageDeltaEvent extends AiSessionDomainEventBase {
    readonly content: string;
    readonly delta: string;
    readonly kind: "message-delta";
    readonly messageId: string;
    readonly messageKind: AiSessionMessageEventKind;
}

export interface AiSessionMessageCompletedEvent
    extends AiSessionDomainEventBase {
    readonly kind: "message-completed";
    readonly messageId: string;
    readonly messageKind: AiSessionMessageEventKind;
}

export interface AiSessionThinkingStartedEvent
    extends AiSessionDomainEventBase {
    readonly kind: "thinking-started";
    readonly message: AiMessage;
}

export interface AiSessionThinkingDeltaEvent extends AiSessionDomainEventBase {
    readonly content: string;
    readonly delta: string;
    readonly kind: "thinking-delta";
    readonly messageId: string;
}

export interface AiSessionThinkingCompletedEvent
    extends AiSessionDomainEventBase {
    readonly kind: "thinking-completed";
    readonly messageId: string;
}

export interface AiSessionToolActivityEvent
    extends AiSessionDomainEventBase {
    readonly activity: AiToolActivity;
    readonly kind: "tool-activity";
}

export interface AiSessionStatusEvent extends AiSessionDomainEventBase {
    readonly activeTurnStartedAt: string | null;
    readonly kind: "status";
    readonly lastError: string | null;
    readonly status: AiSessionStatus;
    readonly title?: string | null;
}

export type AiTurnStatus = "cancelled" | "completed" | "failed";

export interface AiSessionTurnStatusEvent extends AiSessionDomainEventBase {
    readonly error: string | null;
    readonly kind: "turn-status";
    readonly status: AiTurnStatus;
    readonly turnId: string;
}

export interface AiSessionClosedEvent extends AiSessionDomainEventBase {
    readonly closedAt: string;
    readonly kind: "session-closed";
}

export interface AiSessionPlanEvent extends AiSessionDomainEventBase {
    readonly kind: "plan";
    readonly plan: AiPlan | null;
}

export interface AiSessionImageGenerationEvent
    extends AiSessionDomainEventBase {
    readonly kind: "image-generation";
    readonly message: AiMessage;
}

export interface AiSessionPermissionRequestEvent
    extends AiSessionDomainEventBase {
    readonly kind: "permission-request";
    readonly request: AiPermissionRequest | null;
}

export interface AiSessionUserInputRequestEvent
    extends AiSessionDomainEventBase {
    readonly kind: "user-input-request";
    readonly request: AiUserInputRequest | null;
}

export interface AiSessionTokenUsageEvent extends AiSessionDomainEventBase {
    readonly kind: "token-usage";
    readonly tokenUsage: AiTokenUsage | null;
}

export interface AiSessionReviewEvent extends AiSessionDomainEventBase {
    readonly conflicts?: readonly AiReviewConflict[];
    readonly kind: "review";
    readonly trackedFiles: readonly AiTrackedFile[];
}

export type AiReviewDeltaState =
    | "preparing"
    | "ready"
    | "partial"
    | "unavailable"
    | "superseded";

export interface AiReviewFileSummary {
    readonly observedHash?: string;
    readonly path: string;
    readonly previousPath?: string;
    readonly reason?: string;
    readonly state: AiReviewDeltaState;
}

export interface AiReviewDeltaSummary {
    readonly deltaId: string;
    readonly files: readonly AiReviewFileSummary[];
    readonly inputRevision: number;
    readonly revision: number;
    readonly sessionId: string;
    readonly state: AiReviewDeltaState;
    readonly toolCallId: string;
    readonly updatedAt: string;
    readonly workCycleId: string;
}

export interface AiReviewDeltaDetails {
    readonly delta: AiReviewDeltaSummary;
    readonly trackedFiles: readonly AiTrackedFile[];
}

export interface AiLoadReviewDeltaInput {
    readonly expectedRevision: number;
    readonly reviewDeltaId: string;
    readonly sessionId: string;
}

export interface AiSessionReviewDeltaEvent extends AiSessionDomainEventBase {
    readonly delta: AiReviewDeltaSummary;
    readonly kind: "review-delta";
}

export interface AiSessionInfoEvent extends AiSessionDomainEventBase {
    readonly kind: "session-info";
    readonly projectId: string | null;
    readonly title: string;
    readonly worktreeId: string | null;
}

export interface AiSessionSubagentCreatedEvent
    extends AiSessionDomainEventBase {
    readonly childRuntimeSessionId: string | null;
    readonly childSessionId: string;
    readonly kind: "subagent-created";
    readonly modelId: string | null;
    readonly parentSessionId: string;
    readonly reasoningEffort: string | null;
    readonly title: string;
}

export interface AiSessionSubagentBreadcrumbEvent
    extends AiSessionDomainEventBase {
    readonly childSessionId: string;
    readonly kind: "subagent-breadcrumb";
    readonly toolCallId: string;
}

export type AiSessionDomainEvent =
    | AiSessionImageGenerationEvent
    | AiSessionInfoEvent
    | AiSessionMessageCompletedEvent
    | AiSessionMessageDeltaEvent
    | AiSessionMessageStartedEvent
    | AiSessionPermissionRequestEvent
    | AiSessionPlanEvent
    | AiSessionReviewEvent
    | AiSessionReviewDeltaEvent
    | AiSessionClosedEvent
    | AiSessionStatusEvent
    | AiSessionSubagentBreadcrumbEvent
    | AiSessionSubagentCreatedEvent
    | AiSessionThinkingCompletedEvent
    | AiSessionThinkingDeltaEvent
    | AiSessionThinkingStartedEvent
    | AiSessionTokenUsageEvent
    | AiSessionToolActivityEvent
    | AiSessionTurnStatusEvent
    | AiSessionUserInputRequestEvent;

export type AiSessionStreamPayload = AiSessionDomainEvent | AiSessionUpdate;

export type AiSessionStreamMessage =
    | {
          readonly payload: AiSessionStreamPayload;
          readonly seq: number;
          readonly type: "payload";
      }
    | {
          readonly sentAt: number;
          readonly seq: number;
          readonly type: "ping";
      };

export interface AiSessionStreamAckMessage {
    readonly seq: number;
    readonly type: "ack";
}

export interface SendAiPromptInput {
    readonly additionalRoots?: readonly string[];
    readonly attachments: readonly AiImageAttachment[];
    readonly composerParts?: readonly AiComposerMessagePart[];
    readonly messageId: string;
    readonly projectId: string | null;
    readonly prompt: string;
    readonly runtimeId: AiRuntimeId;
    readonly sessionId: string;
    readonly title: string;
    readonly worktreeId?: string | null;
}

export type AiQueuedPromptStatus =
    | "editing"
    | "failed"
    | "pending_dispatch"
    | "queued"
    | "running"
    | "sending";

export interface AiQueuedPrompt {
    readonly additionalRoots?: readonly string[];
    readonly attachments: readonly AiImageAttachment[];
    readonly composerPartsSnapshot: readonly AiComposerMessagePart[];
    readonly createdAt: string;
    readonly error: string | null;
    readonly fileContextsSnapshot: readonly AiFileContextAttachment[];
    readonly id: string;
    readonly messageId: string;
    readonly optimisticMessageId?: string;
    readonly projectId: string | null;
    readonly prompt: string;
    readonly runtimeId: AiRuntimeId;
    readonly sessionId: string;
    readonly status: AiQueuedPromptStatus;
    readonly title: string;
    readonly worktreeId: string | null;
}

export interface AiPromptQueueSnapshot {
    readonly activeItem: AiQueuedPrompt | null;
    readonly editingItem: AiQueuedPrompt | null;
    readonly items: readonly AiQueuedPrompt[];
    readonly paused: boolean;
    readonly revision: number;
    readonly sessionId: string;
}

export interface EnqueueAiPromptInput extends SendAiPromptInput {
    readonly fileContextsSnapshot?: readonly AiFileContextAttachment[];
}

export interface AiQueuedPromptMutationInput {
    readonly promptId: string;
    readonly sessionId: string;
}

export interface UpdateAiQueuedPromptInput extends EnqueueAiPromptInput {
    readonly promptId: string;
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
    readonly parentSessionId?: string | null;
    readonly pinnedAt?: string | null;
    readonly preview: string | null;
    readonly projectId: string | null;
    readonly runtimeId: AiRuntimeId;
    readonly runtimeSessionId?: string | null;
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
    readonly ownerWindowId?: string | null;
    readonly projectId: string | null;
    readonly runtimeId: AiRuntimeId;
    readonly worktreeId?: string | null;
}

export interface AiRuntimeAuthLogoutInput {
    readonly ownerWindowId?: string | null;
    readonly projectId?: string | null;
    readonly runtimeId: AiRuntimeId;
    readonly worktreeId?: string | null;
}

export interface AiRuntimeAuthDisconnectInput {
    readonly runtimeId: AiRuntimeId;
    readonly scope?: "comando" | "runtime" | "all";
}

export interface AiTrackedFileMutationInput {
    readonly expectedVersion?: number;
    readonly path: string;
    readonly sessionId: string;
    readonly trackedFileId?: string | null;
}

export interface AiTrackedFileHunkMutationInput {
    readonly expectedVersion?: number;
    readonly hunkIds: readonly string[];
    readonly path: string;
    readonly sessionId: string;
    readonly trackedFileId?: string | null;
}

export interface ConfirmWorkspaceCloseInput {
    readonly activeAgentCount: number;
    readonly dirtyFileCount: number;
    readonly workspaceName: string;
}

export interface ComandoApi {
    getBootstrapSnapshot: () => Promise<AppBootstrapSnapshot>;
    getAppUpdateState: () => Promise<AppUpdateState>;
    getAppPrivacyAccessState: () => Promise<AppPrivacyAccessState>;
    openMacOsFullDiskAccessSettings: () => Promise<void>;
    checkForAppUpdates: () => Promise<AppUpdateState>;
    installAppUpdateAndRestart: () => Promise<void>;
    getPersistenceSnapshot: () => Promise<PersistenceSnapshot | null>;
    getWindowContext: () => Promise<WindowContextSnapshot | null>;
    readClipboardText: () => Promise<string>;
    resolveDroppedFilePath: (file: File | null) => string | null;
    writeClipboardText: (text: string) => Promise<void>;
    openExternalUrl: (url: string) => Promise<void>;
    openGeneratedImage: (path: string) => Promise<void>;
    revealGeneratedImage: (path: string) => Promise<void>;
    openProjectWindow: (input: OpenProjectWindowInput) => Promise<void>;
    confirmWorkspaceClose: (
        input: ConfirmWorkspaceCloseInput,
    ) => Promise<boolean>;
    checkCommandAvailability: (
        input: CheckCommandAvailabilityInput,
    ) => Promise<CheckCommandAvailabilityResult>;
    readClaudeCodeTranscript: (
        input: ReadClaudeCodeTranscriptInput,
    ) => Promise<ReadClaudeCodeTranscriptResult>;
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
    initializeWorkspaceSurfaces: (
        snapshot: WorkspaceNavigationSnapshot,
    ) => Promise<void>;
    activateWorkspaceSurface: (contextKey: string) => Promise<void>;
    listOpenWorkspaceLocations: () => Promise<
        readonly OpenWorkspaceLocationSummary[]
    >;
    activateWorkspaceLocation: (
        input: ActivateWorkspaceLocationInput,
    ) => Promise<boolean>;
    requestWorkspaceSurfaceContext: (
        input: WorkspaceSurfaceContextRequest,
    ) => Promise<void>;
    openWorkspaceSurfaceGitScopeMenu: (anchor: {
        readonly width: number;
        readonly x: number;
    }) => Promise<void>;
    openWorkspaceSurfaceProjectMenu: () => Promise<void>;
    showWorkspaceContextMenu: (
        input: WorkspaceContextMenuInput,
    ) => Promise<WorkspaceContextMenuAction | null>;
    moveWorkspaceContext: (input: MoveWorkspaceContextInput) => Promise<void>;
    showNativeContextMenu: (
        input: NativeContextMenuInput,
    ) => Promise<string | null>;
    setWorkspaceSurfaceContentInset: (height: number) => Promise<void>;
    setWorkspaceSurfaceContentLeftInset: (width: number) => Promise<void>;
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
    ) => Promise<GitHistoryListResult>;
    listGitWorktreeDiff: (
        input: GitWorktreeDiffInput,
    ) => Promise<GitWorktreeDiffResult | null>;
    getGitDiff: (input: GitDiffInput) => Promise<GitFileDiff | null>;
    getGitOriginalFile: (
        input: GitOriginalFileInput,
    ) => Promise<GitOriginalFile | null>;
    getGitCommitDetail: (
        input: GitCommitDetailInput,
    ) => Promise<GitCommitDetail | null>;
    initGitRepository: (
        input: GitRepositoryScopeInput,
    ) => Promise<GitRepositorySnapshot>;
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
    createGitBranch: (
        input: GitCreateBranchInput,
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
    getGitHubAuthStatus: (
        input: GitHubAuthStatusInput,
    ) => Promise<GitHubAuthStatus>;
    saveGitHubToken: (
        input: GitHubSaveTokenInput,
    ) => Promise<GitHubAuthStatus>;
    clearGitHubToken: (
        input: GitHubClearTokenInput,
    ) => Promise<GitHubAuthStatus>;
    listGitHubIssues: (
        input: GitHubListIssuesInput,
    ) => Promise<GitHubListIssuesResult>;
    getGitHubIssue: (
        input: GitHubGetIssueInput,
    ) => Promise<GitHubIssueDetail | null>;
    createGitHubIssue: (
        input: GitHubCreateIssueInput,
    ) => Promise<GitHubIssueDetail>;
    updateGitHubIssue: (
        input: GitHubUpdateIssueInput,
    ) => Promise<GitHubIssueDetail>;
    setGitHubIssueLabels: (
        input: GitHubSetIssueLabelsInput,
    ) => Promise<GitHubSetIssueLabelsResult>;
    commentGitHubIssue: (
        input: GitHubCommentIssueInput,
    ) => Promise<GitHubCommentSummary>;
    updateGitHubComment: (
        input: GitHubUpdateCommentInput,
    ) => Promise<GitHubCommentSummary>;
    closeGitHubIssue: (
        input: GitHubSetIssueStateInput,
    ) => Promise<GitHubIssueDetail>;
    reopenGitHubIssue: (
        input: GitHubSetIssueStateInput,
    ) => Promise<GitHubIssueDetail>;
    listGitHubPullRequests: (
        input: GitHubListPullRequestsInput,
    ) => Promise<GitHubListPullRequestsResult>;
    getGitHubPullRequest: (
        input: GitHubGetPullRequestInput,
    ) => Promise<GitHubPullRequestDetail | null>;
    getGitHubPullRequestDiff: (
        input: GitHubGetPullRequestDiffInput,
    ) => Promise<GitHubPullRequestDiffResult>;
    listGitHubPullRequestChecks: (
        input: GitHubPullRequestChecksInput,
    ) => Promise<GitHubPullRequestChecksResult>;
    createGitHubPullRequest: (
        input: GitHubCreatePullRequestInput,
    ) => Promise<GitHubPullRequestDetail>;
    updateGitHubPullRequest: (
        input: GitHubUpdatePullRequestInput,
    ) => Promise<GitHubPullRequestDetail>;
    commentGitHubPullRequest: (
        input: GitHubCommentPullRequestInput,
    ) => Promise<GitHubCommentSummary>;
    markGitHubPullRequestReady: (
        input: GitHubSetPullRequestDraftStateInput,
    ) => Promise<GitHubPullRequestDetail>;
    convertGitHubPullRequestToDraft: (
        input: GitHubSetPullRequestDraftStateInput,
    ) => Promise<GitHubPullRequestDetail>;
    requestGitHubPullRequestReviewers: (
        input: GitHubRequestPullRequestReviewInput,
    ) => Promise<GitHubPullRequestDetail>;
    listGitHubWorkflowRuns: (
        input: GitHubWorkflowRunsInput,
    ) => Promise<GitHubWorkflowRunsResult>;
    listGitHubWorkflowRunJobs: (
        input: GitHubWorkflowRunJobsInput,
    ) => Promise<GitHubWorkflowRunJobsResult>;
    getGitHubWorkflowJobLogs: (
        input: GitHubWorkflowJobLogsInput,
    ) => Promise<GitHubWorkflowJobLogsResult>;
    listGitHubWorkflowRunArtifacts: (
        input: GitHubWorkflowRunArtifactsInput,
    ) => Promise<GitHubWorkflowRunArtifactsResult>;
    listGitHubCheckRunAnnotations: (
        input: GitHubCheckRunAnnotationsInput,
    ) => Promise<GitHubCheckRunAnnotationsResult>;
    rerunGitHubWorkflowRunFailedJobs: (
        input: GitHubWorkflowRunMutationInput,
    ) => Promise<void>;
    cancelGitHubWorkflowRun: (
        input: GitHubWorkflowRunMutationInput,
    ) => Promise<void>;
    listGitHubNotifications: (
        input: GitHubNotificationsInput,
    ) => Promise<GitHubNotificationsResult>;
    listGitHubReleases: (
        input: GitHubListReleasesInput,
    ) => Promise<GitHubListReleasesResult>;
    generateGitHubReleaseNotes: (
        input: GitHubGenerateReleaseNotesInput,
    ) => Promise<GitHubGeneratedReleaseNotes>;
    createGitHubRelease: (
        input: GitHubCreateReleaseInput,
    ) => Promise<GitHubReleaseSummary>;
    publishGitHubRelease: (
        input: GitHubPublishReleaseInput,
    ) => Promise<GitHubReleaseSummary>;
    listGitHubLabels: (
        input: GitHubListLabelsInput,
    ) => Promise<GitHubListLabelsResult>;
    listGitHubMilestones: (
        input: GitHubListMilestonesInput,
    ) => Promise<GitHubListMilestonesResult>;
    listProjects: () => Promise<ProjectSummary[]>;
    openProjects: () => Promise<ProjectAddResult>;
    cloneRepository: (
        input: CloneRepositoryInput,
    ) => Promise<CloneRepositoryResult>;
    addProjectPaths: (paths: string[]) => Promise<ProjectAddResult>;
    clearProjectAppData: (
        input: ClearProjectAppDataInput,
    ) => Promise<ClearProjectAppDataResult>;
    getProjectAppDataSummary: (
        projectId: string,
    ) => Promise<ProjectAppDataSummary>;
    relocateProject: (projectId: string) => Promise<ProjectRelocateResult>;
    removeProject: (projectId: string) => Promise<void>;
    touchProject: (projectId: string) => Promise<void>;
    onProjectAppDataCleared: (listener: (projectId: string) => void) => () => void;
    onProjectsUpdated: (
        listener: (projects: readonly ProjectSummary[]) => void,
    ) => () => void;
    onProjectWindowRequested: (
        listener: (payload: OpenProjectWindowInput) => void,
    ) => () => void;
    listProjectTree: (
        input: ListProjectTreeInput,
    ) => Promise<ProjectTreeNode[]>;
    listProjectEntries: (
        input: ListProjectEntriesInput,
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
    copyProjectEntries: (
        input: CopyProjectEntriesInput,
    ) => Promise<CopyProjectEntriesResult>;
    copyExternalProjectEntries: (
        input: CopyExternalProjectEntriesInput,
    ) => Promise<CopyExternalProjectEntriesResult>;
    renameProjectEntry: (
        input: RenameProjectEntryInput,
    ) => Promise<ProjectEntryMutationResult>;
    deleteProjectEntry: (input: DeleteProjectEntryInput) => Promise<void>;
    trashProjectEntry: (input: TrashProjectEntryInput) => Promise<void>;
    openProjectEntryExternally: (
        input: OpenProjectEntryExternallyInput,
    ) => Promise<void>;
    revealProjectEntry: (input: RevealProjectEntryInput) => Promise<void>;
    getWorkspaceSnapshot: () => Promise<PersistedWorkspaceSnapshot>;
    saveWorkspaceSnapshot: (
        snapshot: WorkspaceNavigationSnapshot,
    ) => Promise<void>;
    captureWorkspaceSurfaceContext: (
        contextKey: WorkspaceContextKey,
    ) => Promise<WorkspaceNavigationSnapshot | null>;
    dispatchWorkspaceSurfaceDrag: (
        event: WorkspaceSurfaceDragEvent,
    ) => Promise<void>;
    dispatchWorkspaceSurfaceAction: (
        request: WorkspaceSurfaceActionRequest,
    ) => Promise<WorkspaceSurfaceActionDispatchResult>;
    claimWorkspaceSurfaceAction: (actionId: string) => Promise<boolean>;
    completeWorkspaceSurfaceAction: (
        completion: WorkspaceSurfaceActionCompletion,
    ) => Promise<void>;
    notifyWorkspaceSurfaceReady: () => Promise<void>;
    revealWorkspaceSurfaceFileInHostTree: (
        request: WorkspaceSurfaceFileRevealRequest,
    ) => Promise<WorkspaceSurfaceActionDeliveryResult>;
    notifyWorkspaceSurfaceFocused: () => Promise<void>;
    onWorkspaceSurfaceSnapshotRequested: (
        listener: () => WorkspaceNavigationSnapshot,
    ) => () => void;
    notifyFileBuffer: (input: FileBufferNotificationInput) => Promise<void>;
    getChatSessionState: (
        sessionId: string,
    ) => Promise<PersistedChatSessionState | null>;
    getAiEnvironmentDiagnostics: () => Promise<AiEnvironmentDiagnostics>;
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
    loadAiReviewDelta: (
        input: AiLoadReviewDeltaInput,
    ) => Promise<AiReviewDeltaDetails | null>;
    releaseAiReviewDelta: (reviewDeltaId: string) => Promise<void>;
    loadAiToolActivityDetail: (
        input: AiLoadToolActivityDetailInput,
    ) => Promise<AiToolActivityDetail | null>;
    resyncAiSession: (sessionId: string) => Promise<AiSessionSnapshot | null>;
    getAiSessionTranscriptPage: (
        input: GetAiSessionTranscriptPageInput,
    ) => Promise<AiSessionTranscriptPage>;
    getAiTranscriptCapability: () => Promise<AiTranscriptCapability>;
    getAiTranscriptBlockMetadata: (
        sessionId: string,
    ) => Promise<AiTranscriptBlockMetadataOutput | null>;
    getAiTranscriptBlock: (
        sessionId: string,
        blockId: string,
    ) => Promise<AiTranscriptBlock | null>;
    getAiTranscriptPayload: (
        input: AiLoadTranscriptPayloadInput,
    ) => Promise<AiTranscriptPayload | null>;
    getAiTranscriptPayloads: (
        input: AiLoadTranscriptPayloadsInput,
    ) => Promise<AiTranscriptPayloadsOutput | null>;
    getAiPromptQueue: (sessionId: string) => Promise<AiPromptQueueSnapshot>;
    enqueueAiPrompt: (
        input: EnqueueAiPromptInput,
    ) => Promise<AiPromptQueueSnapshot>;
    removeAiQueuedPrompt: (
        input: AiQueuedPromptMutationInput,
    ) => Promise<AiPromptQueueSnapshot>;
    clearAiPromptQueue: (sessionId: string) => Promise<AiPromptQueueSnapshot>;
    beginEditAiQueuedPrompt: (
        input: AiQueuedPromptMutationInput,
    ) => Promise<AiPromptQueueSnapshot>;
    cancelEditAiQueuedPrompt: (
        sessionId: string,
    ) => Promise<AiPromptQueueSnapshot>;
    updateAiQueuedPrompt: (
        input: UpdateAiQueuedPromptInput,
    ) => Promise<AiPromptQueueSnapshot>;
    steerAiQueuedPrompt: (
        input: AiQueuedPromptMutationInput,
    ) => Promise<AiPromptQueueSnapshot>;
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
    disconnectAiRuntimeAuth: (
        input: AiRuntimeAuthDisconnectInput,
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
    saveGrokRuntimeSettings: (
        settings: GrokRuntimeSettingsInput,
    ) => Promise<AiRuntimeStatus>;
    saveKiloRuntimeSettings: (
        settings: KiloRuntimeSettingsInput,
    ) => Promise<AiRuntimeStatus>;
    saveOpenCodeRuntimeSettings: (
        settings: OpenCodeRuntimeSettingsInput,
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
    onSettingsCategoryRequested: (
        listener: (category: SettingsWindowCategory) => void,
    ) => () => void;
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
    onGitHubAuthUpdated: (
        listener: (payload: GitHubAuthStatus) => void,
    ) => () => void;
    onThemeUpdated: (listener: (theme: SystemTheme) => void) => () => void;
    onSettingsUpdated: (
        listener: (payload: SettingsUpdatedEvent) => void,
    ) => () => void;
    onProjectSettingsUpdated: (
        listener: (payload: ProjectSettingsUpdatedEvent) => void,
    ) => () => void;
    onSidebarToggleRequested: (listener: () => void) => () => void;
    onWorkspaceCloseActiveTab: (listener: () => void) => () => void;
    onWorkspaceReopenLastClosedTab: (listener: () => void) => () => void;
    onWorkspaceSwitcherRequested: (listener: () => void) => () => void;
    onWorkspaceFlushRequested: (
        listener: () => Promise<void> | void,
    ) => () => void;
    onWorkspaceSurfaceSnapshotUpdated: (
        listener: (snapshot: WorkspaceNavigationSnapshot) => void,
    ) => () => void;
    onWorkspaceSurfaceFocused: (listener: () => void) => () => void;
    onWorkspaceSurfaceContextRequested: (
        listener: (input: WorkspaceSurfaceContextRequest) => void,
    ) => () => void;
    onWorkspaceSurfaceDrag: (
        listener: (event: WorkspaceSurfaceDragEvent) => void,
    ) => () => void;
    onWorkspaceSurfaceActionRequested: (
        listener: (envelope: WorkspaceSurfaceActionEnvelope) => void,
    ) => () => void;
    onWorkspaceSurfaceActionStatus: (
        listener: (status: WorkspaceSurfaceActionStatus) => void,
    ) => () => void;
    onWorkspaceSurfaceFileRevealRequested: (
        listener: (request: WorkspaceSurfaceFileRevealRequest) => void,
    ) => () => void;
    onWorkspaceSurfaceGitScopeMenuRequested: (
        listener: (anchor: { readonly width: number; readonly x: number }) => void,
    ) => () => void;
    onWorkspaceSurfaceProjectMenuRequested: (listener: () => void) => () => void;
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
    onAiSessionEvent?: (
        listener: (event: AiSessionDomainEvent) => void,
    ) => () => void;
    onAiPromptQueue: (
        listener: (snapshot: AiPromptQueueSnapshot) => void,
    ) => () => void;
}
