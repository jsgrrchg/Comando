import path from "node:path";
import fs from "node:fs";

import {
    IPC_CHANNELS,
    IPC_EVENTS,
    type AppPrivacyAccessState,
    type AppUpdateState,
    type AppBootstrapSnapshot,
    type AppWindowKind,
    type ApplyWorkspaceRecoveryLayoutInput,
    type DiscardWorkspaceRecoveryLayoutInput,
    type AiPermissionResponseInput,
    type AiRuntimeAuthDisconnectInput,
    type AiRuntimeAuthLaunchInput,
    type AiRuntimeAuthLogoutInput,
    type CheckCommandAvailabilityInput,
    type CheckCommandAvailabilityResult,
    type AiRuntimeId,
    type AiSessionConfigOptionMutationInput,
    type GetAiSessionTranscriptPageInput,
    type ImageClipboardInput,
    type AiLoadTranscriptPayloadInput,
    type AiLoadTranscriptPayloadsInput,
    type AiLoadReviewDeltaInput,
    type AiLoadToolActivityDetailInput,
    type AiSessionModeMutationInput,
    type AiSessionModelMutationInput,
    type AiSessionRenameMutationInput,
    type AiTrackedFileHunkMutationInput,
    type AiTrackedFileMutationInput,
    type AiUserInputResponseInput,
    type ClaudeRuntimeSettingsInput,
    type ClearProjectAppDataInput,
    type CloneRepositoryInput,
    type CloneRepositoryResult,
    type ConfirmWorkspaceCloseInput,
    type CodexRuntimeSettingsInput,
    type CustomAcpRuntimeDefinitionInput,
    type DeleteCustomAcpRuntimeInput,
    type RestoreCustomAcpRuntimeInput,
    type UpdateCustomAcpRuntimeInput,
    type VerifyCustomAcpRuntimeInput,
    type CopyExternalProjectEntriesInput,
    type CopyProjectEntriesInput,
    type CreateProjectEntryInput,
    type CreateTerminalSessionInput,
    type DeleteProjectEntryInput,
    type DeleteWorktreeInput,
    type DeleteWorktreePreflightInput,
    type FileBufferNotificationInput,
    type NativeContextMenuInput,
    type ActivateProjectWorkspaceInput,
    type EnqueueAiPromptInput,
    type GitBranchDiffFile,
    type GitBranchDiffInput,
    type GitBranchDiffResult,
    type GitBranchListInput,
    type GitBranchSummary as SharedGitBranchSummary,
    type GitChangeEntry as SharedGitChangeEntry,
    type GitChangesListInput,
    type GitCheckoutBranchInput,
    type GitCommitDetail as SharedGitCommitDetail,
    type GitCommitDetailInput,
    type GitCommitInput,
    type GitCommitResult,
    type GitCreateBranchInput,
    type GitCreateWorktreeInput,
    type GitDeleteLocalBranchInput,
    type GitDeleteRemoteBranchInput,
    type GitDiffScope,
    type GitDiffInput,
    type GitDiscardPathsInput,
    type GitFetchInput,
    type GitFileDiff as SharedGitFileDiff,
    type GitHubAuthStatus,
    type GitHubAuthStatusInput,
    type GitHubClearTokenInput,
    type GitHubCommentIssueInput,
    type GitHubCommentPullRequestInput,
    type GitHubCommentSummary,
    type GitHubCreateIssueInput,
    type GitHubCreatePullRequestInput,
    type GitHubGetIssueInput,
    type GitHubGetPullRequestInput,
    type GitHubGetPullRequestDiffInput,
    type GitHubIssueDetail,
    type GitHubListLabelsInput,
    type GitHubListLabelsResult,
    type GitHubListIssuesInput,
    type GitHubListIssuesResult,
    type GitHubListMilestonesInput,
    type GitHubListMilestonesResult,
    type GitHubListPullRequestsInput,
    type GitHubListPullRequestsResult,
    type GitHubListReleasesInput,
    type GitHubListReleasesResult,
    type GitHubNotificationsInput,
    type GitHubNotificationsResult,
    type GitHubPullRequestChecksInput,
    type GitHubPullRequestChecksResult,
    type GitHubPullRequestDetail,
    type GitHubPullRequestDiffResult,
    type GitHubCreateReleaseInput,
    type GitHubGeneratedReleaseNotes,
    type GitHubGenerateReleaseNotesInput,
    type GitHubPublishReleaseInput,
    type GitHubReleaseSummary,
    type GitHubRequestPullRequestReviewInput,
    type GitHubSaveTokenInput,
    type GitHubSetIssueLabelsInput,
    type GitHubSetIssueLabelsResult,
    type GitHubSetIssueStateInput,
    type GitHubSetPullRequestDraftStateInput,
    type GitHubUpdateCommentInput,
    type GitHubUpdateIssueInput,
    type GitHubUpdatePullRequestInput,
    type GitHubCheckRunAnnotationsInput,
    type GitHubCheckRunAnnotationsResult,
    type GitHubWorkflowJobLogsInput,
    type GitHubWorkflowJobLogsResult,
    type GitHubWorkflowRunArtifactsInput,
    type GitHubWorkflowRunArtifactsResult,
    type GitHubWorkflowRunJobsInput,
    type GitHubWorkflowRunJobsResult,
    type GitHubWorkflowRunMutationInput,
    type GitHubWorkflowRunsInput,
    type GitHubWorkflowRunsResult,
    type GitHistoryListInput,
    type GitHistoryListResult as SharedGitHistoryListResult,
    type GitOriginalFile,
    type GitOriginalFileInput,
    type GitPullInput,
    type GitPushInput,
    type GitRemoteSummary,
    type GitRemoveWorktreeInput,
    type GitRepositoryInvalidation,
    type GitRepositoryScopeInput,
    type GitRepositorySnapshot as SharedGitRepositorySnapshot,
    type GitRepositoryStatusSummary,
    type GitStagePathsInput,
    type GitSyncStatus as SharedGitSyncStatus,
    type GitUnstagePathsInput,
    type GitWorktreeDiffFile,
    type GitWorktreeDiffInput,
    type GitWorktreeDiffResult,
    type GitWorktreeDiffSection,
    type GitWorktreeListInput,
    type GitWorktreeSummary as SharedGitWorktreeSummary,
    type ListAiSessionHistoryInput,
    type ListProjectEntriesInput,
    type ListProjectTreeInput,
    type OpenProjectEntryExternallyInput,
    type OpenProjectFileInput,
    type OpenSettingsWindowInput,
    type PrepareAiSessionInput,
    type PersistedShellState,
    type PersistenceSnapshot,
    type ProjectSettingsSnapshot,
    type ProjectSettingsUpdatedEvent,
    type GrokRuntimeSettingsInput,
    type KiloRuntimeSettingsInput,
    type RenameProjectEntryInput,
    type OpenCodeRuntimeSettingsInput,
    type RevealProjectEntryInput,
    type ResizeTerminalSessionInput,
    type ReassociateWorkspaceInput,
    type ReadClaudeCodeTranscriptInput,
    type RemoveSavedWorkspaceInput,
    type SearchProjectEntriesInput,
    type SaveProjectFileInput,
    type SaveWorkspaceSurfaceLayoutInput,
    type SaveImageAsInput,
    type AiQueuedPromptMutationInput,
    type UpdateAiQueuedPromptInput,
    type SettingsSnapshot,
    type SystemTheme,
    type ThemeMode,
    type TrashProjectEntryInput,
    type TsconfigResolutionSnapshot,
    type WindowContextSnapshot,
    type WriteTerminalInput,
    type WorkspaceSurfaceActionRequest,
    type WorkspaceSurfaceActionCompletion,
    type WorkspaceSurfaceContentInsets,
    type WorkspaceSurfaceCloseResult,
    type WorkspaceScopeActivationRequest,
    type WorkspaceSurfaceDragEvent,
    type WorkspaceSurfaceLeaseReport,
    type WorkspaceSurfaceAgentPresenceState,
    type WorkspaceSurfaceRuntimeBinding,
    type WorkspaceSurfaceRuntimeResync,
    type WorkspaceSurfaceRegistrySnapshot,
} from "@shared/ipc";
import { normalizePathKey as normalizeSharedPathKey } from "@shared/path-identity";
import {
    normalizeWorkspaceLayoutSnapshot,
} from "@shared/workspace-restore";

import {
    BrowserWindow,
    clipboard,
    dialog,
    ipcMain,
    Menu,
    nativeImage,
    nativeTheme,
    shell,
    type MessageBoxOptions,
    type MenuItemConstructorOptions,
    type OpenDialogOptions,
    type SaveDialogOptions,
} from "electron";

import {
    MAC_MAIN_TRAFFIC_LIGHT_POSITION,
    refreshWindowsTitleBarOverlays,
} from "@main/window";
import { createIpcInFlightLimiter } from "@main/ipc/rate-limit";
import { resolveSettingsSnapshotSaveEffects } from "@main/ipc/settings-save-effects";
import { debugBenignError } from "@main/observability/logging";
import { resolveCodexGeneratedImageFilePath } from "@main/file-preview-protocol";
import { isNativeBackendOperationCancelled } from "@main/native-backend/client";

import type { AiService } from "@main/ai/service";
import { createCustomAcpRuntimeDefinition } from "@main/ai/custom-acp-runtimes";
import { resolveCustomAcpRuntime } from "@main/ai/custom-acp-launch";
import {
    forgetOpenFileBuffer,
    recordOpenFileBuffer,
} from "@main/ai/openFileBuffers";
import { checkCommandAvailability } from "@main/shell/command-availability";
import type { GitGateway } from "@main/git/service";
import type { GitHubGateway } from "@main/github/service";
import type { ProjectService } from "@main/projects/service";
import type { PersistenceGateway } from "@main/persistence/service";
import type { SettingsGateway } from "@main/settings/service";
import {
    applyAppZoomToAllWindows,
    applyWindowTransparencyToAllWindows,
    broadcastSettingsUpdated,
} from "@main/settings/window-zoom";
import type { TerminalGateway } from "@main/terminals/service";
import {
    checkForAppUpdates,
    getAppUpdateState,
    installAppUpdateAndRestart,
} from "@main/updater";
import {
    createEmptyTsconfigResolution,
    resolveTsconfigForPath,
} from "@main/tsconfig/resolve";
import { readClaudeCodeTranscript } from "@main/ipc/claude-code-transcript";
import {
    getAppPrivacyAccessState,
    openMacOsFullDiskAccessSettings,
} from "@main/privacy-access";
import type { WorkspaceGateway } from "@main/workspace/service";
import type { NativePersistenceGateway } from "@main/native-backend/persistence";
import { createEmptyWorkspaceLayoutSnapshot } from "@shared/workspace-restore";
import { windowRegistry } from "@main/windows/registry";
import { workspaceSurfaceManager } from "@main/workspace/surface-manager";
import { workspaceRuntimeOwnership } from "@main/workspace/runtime-ownership-coordinator";
import {
    isWorkspaceSurfaceActiveFileState,
    isWorkspaceSurfaceAgentPresenceState,
    isWorkspaceSurfaceActionRequest,
    isWorkspaceSurfaceActionCompletion,
    isWorkspaceSurfaceFileRevealRequest,
} from "@main/workspace/surface-actions";
import { WorkspaceDestructiveCoordinator } from "@main/workspace/destructive-coordinator";

interface RegisterIpcHandlersOptions {
    readonly aiService: AiService;
    readonly gitService: GitGateway;
    readonly githubService: GitHubGateway;
    readonly getSnapshot: () => AppBootstrapSnapshot;
    readonly durableWorkspaceRepository: NativePersistenceGateway;
    readonly focusMainWindow: () => void;
    readonly activateProjectWorkspace: (
        input: ActivateProjectWorkspaceInput,
    ) => Promise<void>;
    readonly openSettingsView: (input: OpenSettingsWindowInput) => Promise<void>;
    readonly persistenceService: PersistenceGateway;
    readonly projectService: ProjectService;
    readonly settingsService: SettingsGateway;
    readonly terminalService: TerminalGateway;
    readonly workspaceService: WorkspaceGateway;
}

export function registerIpcHandlers(options: RegisterIpcHandlersOptions): void {
    const destructiveCoordinator = new WorkspaceDestructiveCoordinator({
        aiService: options.aiService,
        durableWorkspaceRepository: options.durableWorkspaceRepository,
        gitService: options.gitService,
        onWorkspaceClosed: (hostWindowId) => {
            if (workspaceSurfaceManager.getActiveContext(hostWindowId)) {
                return;
            }
            options.persistenceService.saveActiveProjectId(
                hostWindowId,
                null,
                null,
            );
            windowRegistry.updateMainWindowProjectId(hostWindowId, null, null);
            const hostWebContents =
                workspaceSurfaceManager.getHostWebContents(hostWindowId);
            const hostWindow = hostWebContents
                ? BrowserWindow.fromWebContents(hostWebContents)
                : null;
            hostWindow?.setTitle(buildMainWindowTitle());
        },
        projectService: options.projectService,
        settingsService: options.settingsService,
        surfaceManager: workspaceSurfaceManager,
        terminalService: options.terminalService,
    });
    void destructiveCoordinator.resumePendingOperations().catch((error) => {
        debugBenignError("workspace.deletion.resume", error);
    });
    ipcMain.removeHandler(IPC_CHANNELS.getBootstrapSnapshot);
    ipcMain.removeHandler(IPC_CHANNELS.getAppUpdateState);
    ipcMain.removeHandler(IPC_CHANNELS.getAppPrivacyAccessState);
    ipcMain.removeHandler(IPC_CHANNELS.openMacOsFullDiskAccessSettings);
    ipcMain.removeHandler(IPC_CHANNELS.checkForAppUpdates);
    ipcMain.removeHandler(IPC_CHANNELS.installAppUpdateAndRestart);
    ipcMain.removeHandler(IPC_CHANNELS.getPersistenceSnapshot);
    ipcMain.removeHandler(IPC_CHANNELS.getWindowContext);
    ipcMain.removeHandler(IPC_CHANNELS.readClipboardText);
    ipcMain.removeHandler(IPC_CHANNELS.writeClipboardText);
    ipcMain.removeHandler(IPC_CHANNELS.openExternalUrl);
    ipcMain.removeHandler(IPC_CHANNELS.openGeneratedImage);
    ipcMain.removeHandler(IPC_CHANNELS.revealGeneratedImage);
    ipcMain.removeHandler(IPC_CHANNELS.activateProjectWorkspace);
    ipcMain.removeHandler(IPC_CHANNELS.confirmWorkspaceClose);
    ipcMain.removeHandler(IPC_CHANNELS.checkCommandAvailability);
    ipcMain.removeHandler(IPC_CHANNELS.readClaudeCodeTranscript);
    ipcMain.removeHandler(IPC_CHANNELS.getSettingsSnapshot);
    ipcMain.removeHandler(IPC_CHANNELS.listCustomAcpRuntimes);
    ipcMain.removeHandler(IPC_CHANNELS.listDeletedCustomAcpRuntimes);
    ipcMain.removeHandler(IPC_CHANNELS.createCustomAcpRuntime);
    ipcMain.removeHandler(IPC_CHANNELS.updateCustomAcpRuntime);
    ipcMain.removeHandler(IPC_CHANNELS.deleteCustomAcpRuntime);
    ipcMain.removeHandler(IPC_CHANNELS.restoreCustomAcpRuntime);
    ipcMain.removeHandler(IPC_CHANNELS.verifyCustomAcpRuntime);
    ipcMain.removeHandler(IPC_CHANNELS.getProjectSettings);
    ipcMain.removeHandler(IPC_CHANNELS.getSystemTheme);
    ipcMain.removeHandler(IPC_CHANNELS.saveSettingsSnapshot);
    ipcMain.removeHandler(IPC_CHANNELS.saveProjectSettings);
    ipcMain.removeHandler(IPC_CHANNELS.openSettingsWindow);
    ipcMain.removeHandler(IPC_CHANNELS.saveActiveProjectId);
    ipcMain.removeHandler(IPC_CHANNELS.saveActiveWorktreeId);
    ipcMain.removeHandler(IPC_CHANNELS.saveShellState);
    ipcMain.removeHandler(IPC_CHANNELS.getWorkspaceCatalog);
    ipcMain.removeHandler(IPC_CHANNELS.resetWorkspaceLayout);
    ipcMain.removeHandler(IPC_CHANNELS.applyWorkspaceRecoveryLayout);
    ipcMain.removeHandler(IPC_CHANNELS.discardWorkspaceRecoveryLayout);
    ipcMain.removeHandler(IPC_CHANNELS.reassociateWorkspace);
    ipcMain.removeHandler(IPC_CHANNELS.removeSavedWorkspace);
    ipcMain.removeHandler(IPC_CHANNELS.preflightDeleteWorktree);
    ipcMain.removeHandler(IPC_CHANNELS.deleteWorktree);
    ipcMain.removeHandler(IPC_CHANNELS.setTrafficLightVisibility);
    ipcMain.removeHandler(IPC_CHANNELS.setNativeAppearance);
    ipcMain.removeHandler(IPC_CHANNELS.resolveTsconfigForPath);
    ipcMain.removeHandler(IPC_CHANNELS.getGitRepositorySnapshot);
    ipcMain.removeHandler(IPC_CHANNELS.listGitBranches);
    ipcMain.removeHandler(IPC_CHANNELS.listGitWorktrees);
    ipcMain.removeHandler(IPC_CHANNELS.listGitChanges);
    ipcMain.removeHandler(IPC_CHANNELS.listGitHistory);
    ipcMain.removeHandler(IPC_CHANNELS.listGitWorktreeDiff);
    ipcMain.removeHandler(IPC_CHANNELS.listGitBranchDiff);
    ipcMain.removeHandler(IPC_CHANNELS.getGitDiff);
    ipcMain.removeHandler(IPC_CHANNELS.getGitOriginalFile);
    ipcMain.removeHandler(IPC_CHANNELS.getGitCommitDetail);
    ipcMain.removeHandler(IPC_CHANNELS.initGitRepository);
    ipcMain.removeHandler(IPC_CHANNELS.stageGitPaths);
    ipcMain.removeHandler(IPC_CHANNELS.unstageGitPaths);
    ipcMain.removeHandler(IPC_CHANNELS.discardGitPaths);
    ipcMain.removeHandler(IPC_CHANNELS.commitGitChanges);
    ipcMain.removeHandler(IPC_CHANNELS.checkoutGitBranch);
    ipcMain.removeHandler(IPC_CHANNELS.createGitBranch);
    ipcMain.removeHandler(IPC_CHANNELS.createGitWorktree);
    ipcMain.removeHandler(IPC_CHANNELS.removeGitWorktree);
    ipcMain.removeHandler(IPC_CHANNELS.deleteLocalGitBranch);
    ipcMain.removeHandler(IPC_CHANNELS.deleteRemoteGitBranch);
    ipcMain.removeHandler(IPC_CHANNELS.fetchGitRepository);
    ipcMain.removeHandler(IPC_CHANNELS.pullGitRepository);
    ipcMain.removeHandler(IPC_CHANNELS.pushGitRepository);
    ipcMain.removeHandler(IPC_CHANNELS.getGitHubAuthStatus);
    ipcMain.removeHandler(IPC_CHANNELS.saveGitHubToken);
    ipcMain.removeHandler(IPC_CHANNELS.clearGitHubToken);
    ipcMain.removeHandler(IPC_CHANNELS.listGitHubIssues);
    ipcMain.removeHandler(IPC_CHANNELS.getGitHubIssue);
    ipcMain.removeHandler(IPC_CHANNELS.createGitHubIssue);
    ipcMain.removeHandler(IPC_CHANNELS.updateGitHubIssue);
    ipcMain.removeHandler(IPC_CHANNELS.setGitHubIssueLabels);
    ipcMain.removeHandler(IPC_CHANNELS.commentGitHubIssue);
    ipcMain.removeHandler(IPC_CHANNELS.updateGitHubComment);
    ipcMain.removeHandler(IPC_CHANNELS.closeGitHubIssue);
    ipcMain.removeHandler(IPC_CHANNELS.reopenGitHubIssue);
    ipcMain.removeHandler(IPC_CHANNELS.listGitHubPullRequests);
    ipcMain.removeHandler(IPC_CHANNELS.getGitHubPullRequest);
    ipcMain.removeHandler(IPC_CHANNELS.getGitHubPullRequestDiff);
    ipcMain.removeHandler(IPC_CHANNELS.listGitHubPullRequestChecks);
    ipcMain.removeHandler(IPC_CHANNELS.createGitHubPullRequest);
    ipcMain.removeHandler(IPC_CHANNELS.commentGitHubPullRequest);
    ipcMain.removeHandler(IPC_CHANNELS.markGitHubPullRequestReady);
    ipcMain.removeHandler(IPC_CHANNELS.convertGitHubPullRequestToDraft);
    ipcMain.removeHandler(IPC_CHANNELS.requestGitHubPullRequestReviewers);
    ipcMain.removeHandler(IPC_CHANNELS.listGitHubWorkflowRuns);
    ipcMain.removeHandler(IPC_CHANNELS.listGitHubWorkflowRunJobs);
    ipcMain.removeHandler(IPC_CHANNELS.getGitHubWorkflowJobLogs);
    ipcMain.removeHandler(IPC_CHANNELS.listGitHubWorkflowRunArtifacts);
    ipcMain.removeHandler(IPC_CHANNELS.listGitHubCheckRunAnnotations);
    ipcMain.removeHandler(IPC_CHANNELS.rerunGitHubWorkflowRunFailedJobs);
    ipcMain.removeHandler(IPC_CHANNELS.cancelGitHubWorkflowRun);
    ipcMain.removeHandler(IPC_CHANNELS.listGitHubNotifications);
    ipcMain.removeHandler(IPC_CHANNELS.listGitHubReleases);
    ipcMain.removeHandler(IPC_CHANNELS.generateGitHubReleaseNotes);
    ipcMain.removeHandler(IPC_CHANNELS.createGitHubRelease);
    ipcMain.removeHandler(IPC_CHANNELS.publishGitHubRelease);
    ipcMain.removeHandler(IPC_CHANNELS.listGitHubLabels);
    ipcMain.removeHandler(IPC_CHANNELS.listGitHubMilestones);
    ipcMain.removeHandler(IPC_CHANNELS.listProjects);
    ipcMain.removeHandler(IPC_CHANNELS.openProjects);
    ipcMain.removeHandler(IPC_CHANNELS.cloneRepository);
    ipcMain.removeHandler(IPC_CHANNELS.addProjectPaths);
    ipcMain.removeHandler(IPC_CHANNELS.clearProjectAppData);
    ipcMain.removeHandler(IPC_CHANNELS.getProjectAppDataSummary);
    ipcMain.removeHandler(IPC_CHANNELS.relocateProject);
    ipcMain.removeHandler(IPC_CHANNELS.removeProject);
    ipcMain.removeHandler(IPC_CHANNELS.touchProject);
    ipcMain.removeHandler(IPC_CHANNELS.listProjectTree);
    ipcMain.removeHandler(IPC_CHANNELS.openProjectFile);
    ipcMain.removeHandler(IPC_CHANNELS.saveProjectFile);
    ipcMain.removeHandler(IPC_CHANNELS.createProjectEntry);
    ipcMain.removeHandler(IPC_CHANNELS.copyProjectEntries);
    ipcMain.removeHandler(IPC_CHANNELS.copyExternalProjectEntries);
    ipcMain.removeHandler(IPC_CHANNELS.renameProjectEntry);
    ipcMain.removeHandler(IPC_CHANNELS.deleteProjectEntry);
    ipcMain.removeHandler(IPC_CHANNELS.trashProjectEntry);
    ipcMain.removeHandler(IPC_CHANNELS.openProjectEntryExternally);
    ipcMain.removeHandler(IPC_CHANNELS.revealProjectEntry);
    ipcMain.removeHandler(IPC_CHANNELS.listProjectEntries);
    ipcMain.removeHandler(IPC_CHANNELS.searchProjectEntries);
    ipcMain.removeHandler(IPC_CHANNELS.initializeWorkspaceSurfaces);
    ipcMain.removeHandler(IPC_CHANNELS.activateWorkspaceSurface);
    ipcMain.removeHandler(IPC_CHANNELS.closeWorkspaceSurface);
    ipcMain.removeHandler(IPC_CHANNELS.loadWorkspaceSurfaceLayout);
    ipcMain.removeHandler(IPC_CHANNELS.saveWorkspaceSurfaceLayout);
    ipcMain.removeHandler(IPC_CHANNELS.getWorkspaceSurfaceDiagnostics);
    ipcMain.removeHandler(IPC_CHANNELS.setWorkspaceHostOverlayVisible);
    ipcMain.removeHandler(IPC_CHANNELS.dispatchWorkspaceSurfaceDrag);
    ipcMain.removeHandler(IPC_CHANNELS.dispatchWorkspaceSurfaceAction);
    ipcMain.removeHandler(IPC_CHANNELS.notifyWorkspaceSurfaceReady);
    ipcMain.removeHandler(IPC_CHANNELS.notifyWorkspaceSurfaceRestoreFailed);
    ipcMain.removeHandler(IPC_CHANNELS.reportWorkspaceSurfaceLeases);
    ipcMain.removeHandler(IPC_CHANNELS.resyncWorkspaceSurfaceRuntime);
    ipcMain.removeHandler(IPC_CHANNELS.publishWorkspaceSurfaceActiveFile);
    ipcMain.removeHandler(IPC_CHANNELS.revealWorkspaceSurfaceFileInHostTree);
    ipcMain.removeHandler(IPC_CHANNELS.notifyWorkspaceSurfaceFocused);
    ipcMain.removeHandler(IPC_CHANNELS.requestWorkspaceScopeActivation);
    ipcMain.removeHandler(IPC_CHANNELS.openWorkspaceSurfaceGitScopeMenu);
    ipcMain.removeHandler(IPC_CHANNELS.showNativeContextMenu);
    ipcMain.removeHandler(IPC_CHANNELS.setWorkspaceSurfaceContentInset);
    ipcMain.removeHandler(IPC_CHANNELS.setWorkspaceSurfaceContentLeftInset);
    ipcMain.removeHandler(IPC_CHANNELS.setWorkspaceSurfaceContentInsets);
    ipcMain.removeHandler(IPC_CHANNELS.notifyFileBuffer);
    ipcMain.removeHandler(IPC_CHANNELS.getChatSessionState);
    ipcMain.removeHandler(IPC_CHANNELS.createTerminalSession);
    ipcMain.removeHandler(IPC_CHANNELS.writeTerminalInput);
    ipcMain.removeHandler(IPC_CHANNELS.resizeTerminalSession);
    ipcMain.removeHandler(IPC_CHANNELS.closeTerminalSession);
    ipcMain.removeHandler(IPC_CHANNELS.getAiEnvironmentDiagnostics);
    ipcMain.removeHandler(IPC_CHANNELS.getAiRuntimeStatus);
    ipcMain.removeHandler(IPC_CHANNELS.getAiSessionSnapshot);
    ipcMain.removeHandler(IPC_CHANNELS.loadAiReviewDelta);
    ipcMain.removeHandler(IPC_CHANNELS.releaseAiReviewDelta);
    ipcMain.removeHandler(IPC_CHANNELS.loadAiToolActivityDetail);
    ipcMain.removeHandler(IPC_CHANNELS.resyncAiSession);
    ipcMain.removeHandler(IPC_CHANNELS.listAiSessionHistory);
    ipcMain.removeHandler(IPC_CHANNELS.getAiSessionTranscriptPage);
    ipcMain.removeHandler(IPC_CHANNELS.getAiTranscriptCapability);
    ipcMain.removeHandler(IPC_CHANNELS.getAiTranscriptBlockMetadata);
    ipcMain.removeHandler(IPC_CHANNELS.getAiTranscriptBlock);
    ipcMain.removeHandler(IPC_CHANNELS.getAiTranscriptPayload);
    ipcMain.removeHandler(IPC_CHANNELS.getAiTranscriptPayloads);
    ipcMain.removeHandler(IPC_CHANNELS.getAiPromptQueue);
    ipcMain.removeHandler(IPC_CHANNELS.enqueueAiPrompt);
    ipcMain.removeHandler(IPC_CHANNELS.removeAiQueuedPrompt);
    ipcMain.removeHandler(IPC_CHANNELS.clearAiPromptQueue);
    ipcMain.removeHandler(IPC_CHANNELS.beginEditAiQueuedPrompt);
    ipcMain.removeHandler(IPC_CHANNELS.cancelEditAiQueuedPrompt);
    ipcMain.removeHandler(IPC_CHANNELS.updateAiQueuedPrompt);
    ipcMain.removeHandler(IPC_CHANNELS.steerAiQueuedPrompt);
    ipcMain.removeHandler(IPC_CHANNELS.refreshAiProjectScopes);
    ipcMain.removeHandler(IPC_CHANNELS.setAiSessionMode);
    ipcMain.removeHandler(IPC_CHANNELS.setAiSessionModel);
    ipcMain.removeHandler(IPC_CHANNELS.setAiSessionConfigOption);
    ipcMain.removeHandler(IPC_CHANNELS.setAiSessionPinned);
    ipcMain.removeHandler(IPC_CHANNELS.renameAiSession);
    ipcMain.removeHandler(IPC_CHANNELS.deleteAiSession);
    ipcMain.removeHandler(IPC_CHANNELS.cancelAiSession);
    ipcMain.removeHandler(IPC_CHANNELS.closeAiSession);
    ipcMain.removeHandler(IPC_CHANNELS.respondAiPermission);
    ipcMain.removeHandler(IPC_CHANNELS.respondAiUserInput);
    ipcMain.removeHandler(IPC_CHANNELS.logoutAiRuntimeAuth);
    ipcMain.removeHandler(IPC_CHANNELS.disconnectAiRuntimeAuth);
    ipcMain.removeHandler(IPC_CHANNELS.keepAiTrackedFile);
    ipcMain.removeHandler(IPC_CHANNELS.rejectAiTrackedFile);
    ipcMain.removeHandler(IPC_CHANNELS.keepAiTrackedFileHunks);
    ipcMain.removeHandler(IPC_CHANNELS.rejectAiTrackedFileHunks);
    ipcMain.removeHandler(IPC_CHANNELS.keepAllAiTrackedFiles);
    ipcMain.removeHandler(IPC_CHANNELS.rejectAllAiTrackedFiles);
    ipcMain.removeHandler(IPC_CHANNELS.saveCodexRuntimeSettings);
    ipcMain.removeHandler(IPC_CHANNELS.saveClaudeRuntimeSettings);
    ipcMain.removeHandler(IPC_CHANNELS.saveGrokRuntimeSettings);
    ipcMain.removeHandler(IPC_CHANNELS.saveKiloRuntimeSettings);
    ipcMain.removeHandler(IPC_CHANNELS.saveOpenCodeRuntimeSettings);
    ipcMain.removeHandler(IPC_CHANNELS.verifyCodexRuntimeSettings);
    ipcMain.removeHandler(IPC_CHANNELS.launchAiRuntimeAuth);

    ipcMain.handle(IPC_CHANNELS.getBootstrapSnapshot, () =>
        options.getSnapshot(),
    );
    ipcMain.handle(
        IPC_CHANNELS.getAppUpdateState,
        (): AppUpdateState => getAppUpdateState(),
    );
    ipcMain.handle(
        IPC_CHANNELS.getAppPrivacyAccessState,
        (): AppPrivacyAccessState => getAppPrivacyAccessState(),
    );
    ipcMain.handle(IPC_CHANNELS.openMacOsFullDiskAccessSettings, () =>
        openMacOsFullDiskAccessSettings(),
    );
    ipcMain.handle(
        IPC_CHANNELS.checkForAppUpdates,
        (): Promise<AppUpdateState> => checkForAppUpdates(),
    );
    ipcMain.handle(IPC_CHANNELS.installAppUpdateAndRestart, () => {
        installAppUpdateAndRestart();
    });
    ipcMain.handle(
        IPC_CHANNELS.getPersistenceSnapshot,
        (event): PersistenceSnapshot | null => {
            const context = windowRegistry.getContextByWebContents(
                event.sender,
            );
            if (!context) {
                return null;
            }
            const snapshot = options.persistenceService.loadSnapshot(
                getPersistenceOwnerId(context),
            );
            if (!workspaceSurfaceManager.isSurface(event.sender)) {
                return snapshot;
            }
            return {
                ...snapshot,
                activeProjectId: context.projectId,
                activeWorktreeId: context.worktreeId ?? null,
                windowContext: context,
            };
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.getWindowContext,
        (event): WindowContextSnapshot | null =>
            windowRegistry.getContextByWebContents(event.sender),
    );
    ipcMain.handle(IPC_CHANNELS.readClipboardText, (): string =>
        clipboard.readText(),
    );
    ipcMain.handle(IPC_CHANNELS.writeClipboardText, (_event, text: string) => {
        if (typeof text !== "string") {
            throw new TypeError("Expected clipboard text to be a string.");
        }

        clipboard.writeText(text);
    });
    ipcMain.handle(
        IPC_CHANNELS.writeClipboardImage,
        (_event, input: ImageClipboardInput) => {
            const image = resolveIpcImage(input);
            clipboard.writeImage(image);
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.saveImageAs,
        async (event, input: SaveImageAsInput) => {
            assertIpcImageInput(input);
            if (typeof input.suggestedName !== "string") {
                throw new TypeError("Expected an image file name.");
            }
            const ownerWindow =
                BrowserWindow.fromWebContents(event.sender) ??
                BrowserWindow.getFocusedWindow();
            const dialogOptions: SaveDialogOptions = {
                defaultPath: path.basename(input.suggestedName.trim()) || "image",
                title: "Save Image As",
            };
            const result = ownerWindow
                ? await dialog.showSaveDialog(ownerWindow, dialogOptions)
                : await dialog.showSaveDialog(dialogOptions);

            if (!result.canceled && result.filePath) {
                // Preserve the original bytes instead of re-encoding the image.
                await fs.promises.writeFile(
                    result.filePath,
                    Buffer.from(input.dataBase64, "base64"),
                );
            }
        },
    );
    ipcMain.handle(IPC_CHANNELS.openExternalUrl, async (_event, url: string) => {
        if (typeof url !== "string") {
            throw new TypeError("Expected external URL to be a string.");
        }

        const parsedUrl = new URL(url);
        if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
            throw new Error("Only http and https URLs can be opened externally.");
        }

        await shell.openExternal(parsedUrl.toString());
    });
    ipcMain.handle(
        IPC_CHANNELS.openGeneratedImage,
        async (_event, imagePath: string) => {
            const resolvedPath =
                await resolveGeneratedImageIpcPath(imagePath);
            const errorMessage = await shell.openPath(resolvedPath);
            if (errorMessage) {
                throw new Error(errorMessage);
            }
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.revealGeneratedImage,
        async (_event, imagePath: string) => {
            const resolvedPath =
                await resolveGeneratedImageIpcPath(imagePath);
            shell.showItemInFolder(resolvedPath);
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.activateProjectWorkspace,
        (_event, input: ActivateProjectWorkspaceInput) =>
            options.activateProjectWorkspace(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.confirmWorkspaceClose,
        async (event, input: ConfirmWorkspaceCloseInput): Promise<boolean> => {
            if (
                !input ||
                typeof input.workspaceName !== "string" ||
                !Number.isInteger(input.activeAgentCount) ||
                !Number.isInteger(input.dirtyFileCount) ||
                input.activeAgentCount < 0 ||
                input.dirtyFileCount < 0
            ) {
                throw new TypeError("Expected a valid workspace close confirmation input.");
            }

            const ownerWindow =
                BrowserWindow.fromWebContents(event.sender) ??
                BrowserWindow.getFocusedWindow();
            const details = [
                input.activeAgentCount > 0
                    ? `${input.activeAgentCount} ${input.activeAgentCount === 1 ? "agent is" : "agents are"} still working. ${input.activeAgentCount === 1 ? "It" : "They"} will continue running in the background if you close this workspace.`
                    : null,
                input.dirtyFileCount > 0
                    ? `${input.dirtyFileCount} unsaved ${input.dirtyFileCount === 1 ? "file will" : "files will"} be discarded.`
                    : null,
            ]
                .filter((detail): detail is string => Boolean(detail))
                .join("\n\n");
            const dialogOptions: MessageBoxOptions = {
                buttons: ["Keep Workspace Open", "Close Workspace"],
                cancelId: 0,
                defaultId: 0,
                detail: details,
                message: `Close “${input.workspaceName}”?`,
                noLink: true,
                title:
                    input.activeAgentCount > 0
                        ? "Agents are still working"
                        : "Unsaved changes",
                type: "warning",
            };
            const result = ownerWindow
                ? await dialog.showMessageBox(ownerWindow, dialogOptions)
                : await dialog.showMessageBox(dialogOptions);

            return result.response === 1;
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.checkCommandAvailability,
        (
            _event,
            input: CheckCommandAvailabilityInput,
        ): CheckCommandAvailabilityResult => checkCommandAvailability(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.readClaudeCodeTranscript,
        (_event, input: ReadClaudeCodeTranscriptInput) =>
            readClaudeCodeTranscript(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.getSettingsSnapshot,
        (): SettingsSnapshot => options.settingsService.loadSnapshot(),
    );
    ipcMain.handle(IPC_CHANNELS.listCustomAcpRuntimes, () =>
        options.settingsService.listCustomAcpRuntimes(),
    );
    ipcMain.handle(IPC_CHANNELS.listDeletedCustomAcpRuntimes, () =>
        options.settingsService.listDeletedCustomAcpRuntimes(),
    );
    ipcMain.handle(
        IPC_CHANNELS.createCustomAcpRuntime,
        (_event, input: CustomAcpRuntimeDefinitionInput) => {
            const definition =
                options.settingsService.createCustomAcpRuntime(input);
            broadcastCurrentSettings(options.settingsService);
            return definition;
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.updateCustomAcpRuntime,
        (_event, input: UpdateCustomAcpRuntimeInput) => {
            const definition = options.settingsService.updateCustomAcpRuntime(
                input.id,
                input.definition,
            );
            broadcastCurrentSettings(options.settingsService);
            return definition;
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.deleteCustomAcpRuntime,
        async (_event, input: DeleteCustomAcpRuntimeInput) => {
            const historyReferenceCount =
                await options.aiService.countSessionHistoryByRuntime(input.id);
            const result =
                options.settingsService.deleteCustomAcpRuntime(input.id);
            if (result.deleted) {
                broadcastCurrentSettings(options.settingsService);
            }
            return {
                ...result,
                historyReferenceCount,
            };
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.restoreCustomAcpRuntime,
        (_event, input: RestoreCustomAcpRuntimeInput) => {
            const definition = options.settingsService.restoreCustomAcpRuntime(
                input.id,
            );
            broadcastCurrentSettings(options.settingsService);
            return definition;
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.verifyCustomAcpRuntime,
        (_event, input: VerifyCustomAcpRuntimeInput) => {
            // Verification uses a transient Main-owned identity so renderer
            // input never becomes persistent launch authority.
            const definition = createCustomAcpRuntimeDefinition(
                input.definition,
                [],
            );
            return resolveCustomAcpRuntime(definition).status;
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.getProjectSettings,
        (_event, projectId: string): ProjectSettingsSnapshot | null =>
            options.settingsService.loadProjectSettings(projectId),
    );
    ipcMain.handle(
        IPC_CHANNELS.getSystemTheme,
        (): SystemTheme => ({
            isDark: nativeTheme.shouldUseDarkColors,
        }),
    );
    ipcMain.handle(
        IPC_CHANNELS.saveSettingsSnapshot,
        (_event, snapshot: SettingsSnapshot) => {
            options.settingsService.saveSnapshot(snapshot);
            const effects = resolveSettingsSnapshotSaveEffects(snapshot);
            if (effects.broadcastSettingsUpdated) {
                const persisted = options.settingsService.loadSnapshot();
                if (effects.applyAppZoom) {
                    const zoomFactor = persisted.appearance?.zoomFactor ?? 1;
                    applyAppZoomToAllWindows(zoomFactor);
                    workspaceSurfaceManager.setZoomFactor(zoomFactor);
                }
                if (effects.applyWindowTransparency) {
                    applyWindowTransparencyToAllWindows(
                        persisted.appearance?.transparencyEnabled ?? true,
                    );
                }
                broadcastSettingsUpdated(
                    persisted.appearance ?? null,
                    persisted.editor ?? null,
                    persisted.aiChat ?? null,
                    persisted.terminal ?? null,
                );
            }
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.saveProjectSettings,
        (_event, snapshot: ProjectSettingsSnapshot) => {
            options.settingsService.saveProjectSettings(snapshot);
            broadcastProjectSettingsUpdated({
                projectId: snapshot.projectId,
            });
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.openSettingsWindow,
        (_event, input: OpenSettingsWindowInput) =>
            options.openSettingsView(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.saveActiveProjectId,
        (event, projectId: string | null) => {
            const context = requireWindowContext(event.sender, "main");
            if (workspaceSurfaceManager.isSurface(event.sender)) {
                return;
            }
            options.persistenceService.saveActiveProjectId(
                getPersistenceOwnerId(context),
                projectId,
            );
            windowRegistry.updateMainWindowProjectId(
                getPersistenceOwnerId(context),
                projectId,
            );
            const ownerWindow = BrowserWindow.fromWebContents(event.sender);
            if (ownerWindow) {
                ownerWindow.setTitle(
                    buildMainWindowTitle(),
                );
            }
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.saveActiveWorktreeId,
        (event, worktreeId: string | null) => {
            const context = requireWindowContext(event.sender, "main");
            if (workspaceSurfaceManager.isSurface(event.sender)) {
                return;
            }
            const activeProjectId = context.projectId ?? null;
            const nextWorktreeId = activeProjectId ? worktreeId : null;

            options.persistenceService.saveActiveProjectId(
                getPersistenceOwnerId(context),
                activeProjectId,
                nextWorktreeId,
            );
            windowRegistry.updateMainWindowProjectId(
                getPersistenceOwnerId(context),
                activeProjectId,
                nextWorktreeId,
            );
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.saveShellState,
        (event, shellState: PersistedShellState | null) => {
            const context = requireWindowContext(event.sender, "main");
            if (workspaceSurfaceManager.isSurface(event.sender)) {
                return;
            }
            options.persistenceService.saveShellState(
                getPersistenceOwnerId(context),
                shellState,
            );
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.setTrafficLightVisibility,
        (event, visible: boolean) => {
            const win = BrowserWindow.fromWebContents(event.sender);
            if (win && process.platform === "darwin") {
                win.setWindowButtonPosition(
                    visible ? MAC_MAIN_TRAFFIC_LIGHT_POSITION : { x: -80, y: -80 },
                );
            }
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.setNativeAppearance,
        (_event, mode: ThemeMode) => {
            // Only Windows needs themeSource sync so the DWM acrylic
            // tints with the in-app light/dark mode. macOS keeps using
            // the system appearance to avoid touching native vibrancy.
            if (process.platform !== "win32") return;
            if (mode !== "system" && mode !== "light" && mode !== "dark") {
                return;
            }
            nativeTheme.themeSource = mode;
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.resolveTsconfigForPath,
        async (event, filePath: string): Promise<TsconfigResolutionSnapshot> => {
            const context = windowRegistry.getContextByWebContents(
                event.sender,
            );
            if (!context?.projectId) {
                return createEmptyTsconfigResolution(null);
            }

            try {
                return await resolveTsconfigForPath({
                    filePath,
                    projectRootPath: options.projectService.getProjectRootPath(
                        context.projectId,
                        context.worktreeId ?? null,
                    ),
                });
            } catch (error) {
                debugBenignError("ipc.resolveTsconfigForPath", error);
                return createEmptyTsconfigResolution(null, [
                    "The active project tsconfig could not be resolved.",
                ]);
            }
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.getGitRepositorySnapshot,
        async (
            _event,
            input: GitRepositoryScopeInput,
        ): Promise<SharedGitRepositorySnapshot | null> =>
            buildSharedGitRepositorySnapshot(
                options.projectService,
                options.gitService,
                input,
            ),
    );
    ipcMain.handle(
        IPC_CHANNELS.listGitBranches,
        async (
            _event,
            input: GitBranchListInput,
        ): Promise<readonly SharedGitBranchSummary[]> =>
            buildSharedGitBranches(
                options.projectService,
                options.gitService,
                input,
            ),
    );
    ipcMain.handle(
        IPC_CHANNELS.listGitWorktrees,
        async (
            _event,
            input: GitWorktreeListInput,
        ): Promise<readonly SharedGitWorktreeSummary[]> => {
            const snapshot = await buildSharedGitRepositorySnapshot(
                options.projectService,
                options.gitService,
                input,
            );
            if (!snapshot) {
                return [];
            }

            return input.includeDetached === false
                ? snapshot.worktrees.filter(
                      (worktree) => worktree.branchName !== null,
                  )
                : snapshot.worktrees;
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.listGitChanges,
        async (
            _event,
            input: GitChangesListInput,
        ): Promise<readonly SharedGitChangeEntry[]> => {
            const snapshot = await buildSharedGitRepositorySnapshot(
                options.projectService,
                options.gitService,
                input,
            );
            if (!snapshot) {
                return [];
            }

            return snapshot.changes.filter((change) => {
                if (
                    input.includeUntracked === false &&
                    change.scope === "untracked"
                ) {
                    return false;
                }

                return input.scope === undefined || input.scope === "all"
                    ? true
                    : change.scope === input.scope;
            });
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.getGitDiff,
        async (
            _event,
            input: GitDiffInput,
        ): Promise<SharedGitFileDiff | null> =>
            buildSharedGitDiff(
                options.projectService,
                options.gitService,
                input,
            ),
    );
    ipcMain.handle(
        IPC_CHANNELS.getGitOriginalFile,
        async (
            _event,
            input: GitOriginalFileInput,
        ): Promise<GitOriginalFile | null> =>
            buildGitOriginalFile(
                options.projectService,
                options.gitService,
                input,
            ),
    );
    ipcMain.handle(
        IPC_CHANNELS.listGitWorktreeDiff,
        async (
            _event,
            input: GitWorktreeDiffInput,
        ): Promise<GitWorktreeDiffResult | null> =>
            buildSharedGitWorktreeDiff(
                options.projectService,
                options.gitService,
                input,
            ),
    );
    ipcMain.handle(
        IPC_CHANNELS.listGitBranchDiff,
        async (
            _event,
            input: GitBranchDiffInput,
        ): Promise<GitBranchDiffResult | null> =>
            buildSharedGitBranchDiff(
                options.projectService,
                options.gitService,
                input,
            ),
    );
    ipcMain.handle(
        IPC_CHANNELS.listGitHistory,
        async (
            _event,
            input: GitHistoryListInput,
        ): Promise<SharedGitHistoryListResult> => {
            const scope = resolveGitScope(options.projectService, input);
            return options.gitService.listHistory(scope.rootPath, {
                caseSensitive: input.caseSensitive,
                includeAllRefs: input.includeAllRefs,
                limit: input.limit,
                query: input.query,
            });
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.getGitCommitDetail,
        async (
            _event,
            input: GitCommitDetailInput,
        ): Promise<SharedGitCommitDetail | null> => {
            const scope = resolveGitScope(options.projectService, input);
            return options.gitService.getCommitDetail(
                scope.rootPath,
                input.commitSha,
            );
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.initGitRepository,
        async (
            _event,
            input: GitRepositoryScopeInput,
        ): Promise<SharedGitRepositorySnapshot> =>
            handleGitSnapshotMutation(
                options.projectService,
                options.gitService,
                input,
                "unknown",
                async (rootPath) => options.gitService.initRepository(rootPath),
            ),
    );
    ipcMain.handle(
        IPC_CHANNELS.stageGitPaths,
        async (
            _event,
            input: GitStagePathsInput,
        ): Promise<SharedGitRepositorySnapshot> =>
            handleGitSnapshotMutation(
                options.projectService,
                options.gitService,
                input,
                "status",
                async (rootPath) =>
                    options.gitService.stagePaths(rootPath, input.paths),
            ),
    );
    ipcMain.handle(
        IPC_CHANNELS.unstageGitPaths,
        async (
            _event,
            input: GitUnstagePathsInput,
        ): Promise<SharedGitRepositorySnapshot> =>
            handleGitSnapshotMutation(
                options.projectService,
                options.gitService,
                input,
                "status",
                async (rootPath) =>
                    options.gitService.unstagePaths(rootPath, input.paths),
            ),
    );
    ipcMain.handle(
        IPC_CHANNELS.discardGitPaths,
        async (
            _event,
            input: GitDiscardPathsInput,
        ): Promise<SharedGitRepositorySnapshot> =>
            handleGitSnapshotMutation(
                options.projectService,
                options.gitService,
                input,
                "status",
                async (rootPath) =>
                    options.gitService.discardPaths(rootPath, input.paths),
            ),
    );
    ipcMain.handle(
        IPC_CHANNELS.commitGitChanges,
        async (_event, input: GitCommitInput): Promise<GitCommitResult> => {
            const scope = resolveGitScope(options.projectService, input);
            const result = await options.gitService.commit(
                scope.rootPath,
                input.message,
                {
                    amend: input.amend,
                    noVerify: input.noVerify,
                },
            );
            const snapshot = await adaptRepositorySnapshot(
                options.projectService,
                options.gitService,
                input,
                result.snapshot,
            );
            notifyGitSnapshot(snapshot, "status");

            return {
                branchName: snapshot.branch?.name ?? null,
                commitSha: result.commitSha,
                snapshot,
                updatedAt: snapshot.updatedAt,
                worktreeId: snapshot.currentWorktreeId,
            };
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.checkoutGitBranch,
        async (
            _event,
            input: GitCheckoutBranchInput,
        ): Promise<SharedGitRepositorySnapshot> =>
            handleGitSnapshotMutation(
                options.projectService,
                options.gitService,
                input,
                "branch",
                async (rootPath) =>
                    options.gitService.checkoutBranch(rootPath, {
                        branchName: input.branchName,
                        force: input.force,
                        newBranchName: input.newBranchName,
                        startPoint: input.startPoint,
                    }),
            ),
    );
    ipcMain.handle(
        IPC_CHANNELS.createGitBranch,
        async (
            _event,
            input: GitCreateBranchInput,
        ): Promise<SharedGitRepositorySnapshot> =>
            handleGitSnapshotMutation(
                options.projectService,
                options.gitService,
                input,
                "branch",
                async (rootPath) =>
                    options.gitService.createBranch(rootPath, {
                        branchName: input.branchName,
                        startPoint: input.startPoint,
                    }),
            ),
    );
    ipcMain.handle(
        IPC_CHANNELS.createGitWorktree,
        async (
            _event,
            input: GitCreateWorktreeInput,
        ): Promise<SharedGitWorktreeSummary> => {
            const scope = resolveGitScope(options.projectService, input);
            const snapshot = await options.gitService.createWorktree(
                scope.rootPath,
                {
                    branchName: input.branchName,
                    force: input.force,
                    path: input.path,
                    startPoint: input.startPoint,
                },
            );
            const sharedSnapshot = await adaptRepositorySnapshot(
                options.projectService,
                options.gitService,
                input,
                snapshot,
            );
            notifyGitSnapshot(sharedSnapshot, "worktree");

            const createdWorktree = sharedSnapshot.worktrees.find(
                (worktree) =>
                    normalizePathKey(worktree.rootPath) ===
                    normalizePathKey(input.path),
            );
            if (!createdWorktree) {
                throw new Error(
                    "The worktree was created but could not be resolved.",
                );
            }

            return createdWorktree;
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.removeGitWorktree,
        async (
            _event,
            input: GitRemoveWorktreeInput,
        ): Promise<SharedGitRepositorySnapshot> =>
            handleGitSnapshotMutation(
                options.projectService,
                options.gitService,
                input,
                "worktree",
                async (rootPath) =>
                    options.gitService.removeWorktree(rootPath, {
                        force: input.force,
                        path: input.path,
                    }),
            ),
    );
    ipcMain.handle(
        IPC_CHANNELS.deleteLocalGitBranch,
        async (
            _event,
            input: GitDeleteLocalBranchInput,
        ): Promise<SharedGitRepositorySnapshot> =>
            handleGitSnapshotMutation(
                options.projectService,
                options.gitService,
                input,
                "branch",
                async (rootPath) =>
                    options.gitService.deleteLocalBranch(rootPath, {
                        branchName: input.branchName,
                        force: input.force,
                    }),
            ),
    );
    ipcMain.handle(
        IPC_CHANNELS.deleteRemoteGitBranch,
        async (
            _event,
            input: GitDeleteRemoteBranchInput,
        ): Promise<SharedGitRepositorySnapshot> =>
            handleGitSnapshotMutation(
                options.projectService,
                options.gitService,
                input,
                "remote",
                async (rootPath) =>
                    options.gitService.deleteRemoteBranch(rootPath, {
                        remoteName: input.remoteName,
                        remoteRef: input.remoteRef,
                    }),
            ),
    );
    ipcMain.handle(
        IPC_CHANNELS.fetchGitRepository,
        async (
            _event,
            input: GitFetchInput,
        ): Promise<SharedGitRepositorySnapshot> =>
            handleGitSnapshotMutation(
                options.projectService,
                options.gitService,
                input,
                "remote",
                async (rootPath) =>
                    options.gitService.fetch(rootPath, {
                        all: input.all,
                        prune: input.prune,
                        remoteName: input.remoteName,
                    }),
            ),
    );
    ipcMain.handle(
        IPC_CHANNELS.pullGitRepository,
        async (
            _event,
            input: GitPullInput,
        ): Promise<SharedGitRepositorySnapshot> =>
            handleGitSnapshotMutation(
                options.projectService,
                options.gitService,
                input,
                "remote",
                async (rootPath) =>
                    options.gitService.pull(rootPath, {
                        rebase: input.rebase,
                        remoteName: input.remoteName,
                        remoteRef: input.remoteRef,
                    }),
            ),
    );
    ipcMain.handle(
        IPC_CHANNELS.pushGitRepository,
        async (
            _event,
            input: GitPushInput,
        ): Promise<SharedGitRepositorySnapshot> =>
            handleGitSnapshotMutation(
                options.projectService,
                options.gitService,
                input,
                "remote",
                async (rootPath) =>
                    options.gitService.push(rootPath, {
                        force: input.force,
                        forceWithLease: input.forceWithLease,
                        remoteName: input.remoteName,
                        remoteRef: input.remoteRef,
                        setUpstream: input.setUpstream,
                    }),
            ),
    );
    ipcMain.handle(
        IPC_CHANNELS.getGitHubAuthStatus,
        async (
            _event,
            input: GitHubAuthStatusInput,
        ): Promise<GitHubAuthStatus> =>
            options.githubService.getAuthStatus(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.saveGitHubToken,
        async (
            _event,
            input: GitHubSaveTokenInput,
        ): Promise<GitHubAuthStatus> => {
            const status = await options.githubService.saveToken(input);
            broadcastGitHubAuthUpdated(status);
            return status;
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.clearGitHubToken,
        async (
            _event,
            input: GitHubClearTokenInput,
        ): Promise<GitHubAuthStatus> => {
            const status = await options.githubService.clearToken(input);
            broadcastGitHubAuthUpdated(status);
            return status;
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.listGitHubIssues,
        async (
            _event,
            input: GitHubListIssuesInput,
        ): Promise<GitHubListIssuesResult> =>
            options.githubService.listIssues(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.getGitHubIssue,
        async (
            _event,
            input: GitHubGetIssueInput,
        ): Promise<GitHubIssueDetail | null> =>
            options.githubService.getIssue(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.createGitHubIssue,
        async (
            _event,
            input: GitHubCreateIssueInput,
        ): Promise<GitHubIssueDetail> =>
            options.githubService.createIssue(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.updateGitHubIssue,
        async (
            _event,
            input: GitHubUpdateIssueInput,
        ): Promise<GitHubIssueDetail> =>
            options.githubService.updateIssue(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.setGitHubIssueLabels,
        async (
            _event,
            input: GitHubSetIssueLabelsInput,
        ): Promise<GitHubSetIssueLabelsResult> =>
            options.githubService.setIssueLabels(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.commentGitHubIssue,
        async (
            _event,
            input: GitHubCommentIssueInput,
        ): Promise<GitHubCommentSummary> =>
            options.githubService.commentIssue(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.updateGitHubComment,
        async (
            _event,
            input: GitHubUpdateCommentInput,
        ): Promise<GitHubCommentSummary> =>
            options.githubService.updateComment(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.closeGitHubIssue,
        async (
            _event,
            input: GitHubSetIssueStateInput,
        ): Promise<GitHubIssueDetail> =>
            options.githubService.closeIssue(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.reopenGitHubIssue,
        async (
            _event,
            input: GitHubSetIssueStateInput,
        ): Promise<GitHubIssueDetail> =>
            options.githubService.reopenIssue(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.listGitHubPullRequests,
        async (
            _event,
            input: GitHubListPullRequestsInput,
        ): Promise<GitHubListPullRequestsResult> =>
            options.githubService.listPullRequests(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.getGitHubPullRequest,
        async (
            _event,
            input: GitHubGetPullRequestInput,
        ): Promise<GitHubPullRequestDetail | null> =>
            options.githubService.getPullRequest(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.getGitHubPullRequestDiff,
        async (
            _event,
            input: GitHubGetPullRequestDiffInput,
        ): Promise<GitHubPullRequestDiffResult> =>
            options.githubService.getPullRequestDiff(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.listGitHubPullRequestChecks,
        async (
            _event,
            input: GitHubPullRequestChecksInput,
        ): Promise<GitHubPullRequestChecksResult> =>
            options.githubService.listPullRequestChecks(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.createGitHubPullRequest,
        async (
            _event,
            input: GitHubCreatePullRequestInput,
        ): Promise<GitHubPullRequestDetail> =>
            options.githubService.createPullRequest(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.updateGitHubPullRequest,
        async (
            _event,
            input: GitHubUpdatePullRequestInput,
        ): Promise<GitHubPullRequestDetail> =>
            options.githubService.updatePullRequest(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.commentGitHubPullRequest,
        async (
            _event,
            input: GitHubCommentPullRequestInput,
        ): Promise<GitHubCommentSummary> =>
            options.githubService.commentPullRequest(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.markGitHubPullRequestReady,
        async (
            _event,
            input: GitHubSetPullRequestDraftStateInput,
        ): Promise<GitHubPullRequestDetail> =>
            options.githubService.markPullRequestReady(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.convertGitHubPullRequestToDraft,
        async (
            _event,
            input: GitHubSetPullRequestDraftStateInput,
        ): Promise<GitHubPullRequestDetail> =>
            options.githubService.convertPullRequestToDraft(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.requestGitHubPullRequestReviewers,
        async (
            _event,
            input: GitHubRequestPullRequestReviewInput,
        ): Promise<GitHubPullRequestDetail> =>
            options.githubService.requestPullRequestReviewers(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.listGitHubWorkflowRuns,
        async (
            _event,
            input: GitHubWorkflowRunsInput,
        ): Promise<GitHubWorkflowRunsResult> =>
            options.githubService.listWorkflowRuns(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.listGitHubWorkflowRunJobs,
        async (
            _event,
            input: GitHubWorkflowRunJobsInput,
        ): Promise<GitHubWorkflowRunJobsResult> =>
            options.githubService.listWorkflowRunJobs(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.getGitHubWorkflowJobLogs,
        async (
            _event,
            input: GitHubWorkflowJobLogsInput,
        ): Promise<GitHubWorkflowJobLogsResult> =>
            options.githubService.getWorkflowJobLogs(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.listGitHubWorkflowRunArtifacts,
        async (
            _event,
            input: GitHubWorkflowRunArtifactsInput,
        ): Promise<GitHubWorkflowRunArtifactsResult> =>
            options.githubService.listWorkflowRunArtifacts(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.listGitHubCheckRunAnnotations,
        async (
            _event,
            input: GitHubCheckRunAnnotationsInput,
        ): Promise<GitHubCheckRunAnnotationsResult> =>
            options.githubService.listCheckRunAnnotations(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.rerunGitHubWorkflowRunFailedJobs,
        async (_event, input: GitHubWorkflowRunMutationInput): Promise<void> =>
            options.githubService.rerunWorkflowRunFailedJobs(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.cancelGitHubWorkflowRun,
        async (_event, input: GitHubWorkflowRunMutationInput): Promise<void> =>
            options.githubService.cancelWorkflowRun(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.listGitHubNotifications,
        async (
            _event,
            input: GitHubNotificationsInput,
        ): Promise<GitHubNotificationsResult> =>
            options.githubService.listNotifications(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.listGitHubReleases,
        async (
            _event,
            input: GitHubListReleasesInput,
        ): Promise<GitHubListReleasesResult> =>
            options.githubService.listReleases(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.generateGitHubReleaseNotes,
        async (
            _event,
            input: GitHubGenerateReleaseNotesInput,
        ): Promise<GitHubGeneratedReleaseNotes> =>
            options.githubService.generateReleaseNotes(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.createGitHubRelease,
        async (
            _event,
            input: GitHubCreateReleaseInput,
        ): Promise<GitHubReleaseSummary> =>
            options.githubService.createRelease(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.publishGitHubRelease,
        async (
            _event,
            input: GitHubPublishReleaseInput,
        ): Promise<GitHubReleaseSummary> =>
            options.githubService.publishRelease(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.listGitHubLabels,
        async (
            _event,
            input: GitHubListLabelsInput,
        ): Promise<GitHubListLabelsResult> =>
            options.githubService.listLabels(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.listGitHubMilestones,
        async (
            _event,
            input: GitHubListMilestonesInput,
        ): Promise<GitHubListMilestonesResult> =>
            options.githubService.listMilestones(input),
    );
    nativeTheme.on("updated", () => {
        const theme: SystemTheme = {
            isDark: nativeTheme.shouldUseDarkColors,
        };

        refreshWindowsTitleBarOverlays();

        windowRegistry.forEachLiveWebContents((webContents) => {
            webContents.send(IPC_EVENTS.themeUpdated, theme);
        });
    });
    const broadcastProjectsUpdated = () => {
        const projects = options.projectService.listProjects();
        windowRegistry.forEachLiveWebContents((webContents) => {
            webContents.send(IPC_EVENTS.projectsUpdated, projects);
        });
        return projects;
    };

    ipcMain.handle(IPC_CHANNELS.listProjects, () =>
        options.projectService.listProjects(),
    );
    ipcMain.handle(IPC_CHANNELS.openProjects, async (event) => {
        options.focusMainWindow();
        const ownerWindow =
            BrowserWindow.fromWebContents(event.sender) ??
            BrowserWindow.getFocusedWindow();
        const dialogOptions: OpenDialogOptions = {
            buttonLabel: "Add Project",
            message: "Choose one or more folders to add to the workspace.",
            properties: ["multiSelections", "openDirectory"],
            title: "Add projects",
        };
        const result = ownerWindow
            ? await dialog.showOpenDialog(ownerWindow, dialogOptions)
            : await dialog.showOpenDialog(dialogOptions);

        if (result.canceled || result.filePaths.length === 0) {
            return {
                projectIdsToOpen: [],
                projects: options.projectService.listProjects(),
            };
        }

        const addResult = await options.projectService.addProjectPaths(
            result.filePaths,
        );
        broadcastProjectsUpdated();
        return addResult;
    });
    ipcMain.handle(
        IPC_CHANNELS.cloneRepository,
        async (event, input: CloneRepositoryInput): Promise<CloneRepositoryResult> => {
            options.focusMainWindow();
            const repositoryUrl = input?.repositoryUrl?.trim() ?? "";
            if (!repositoryUrl) {
                throw new Error("Repository URL is required.");
            }

            const ownerWindow =
                BrowserWindow.fromWebContents(event.sender) ??
                BrowserWindow.getFocusedWindow();
            const dialogOptions: OpenDialogOptions = {
                buttonLabel: "Clone Here",
                message: "Choose a folder where the repository will be cloned.",
                properties: ["openDirectory", "createDirectory"],
                title: "Clone repository",
            };
            const selection = ownerWindow
                ? await dialog.showOpenDialog(ownerWindow, dialogOptions)
                : await dialog.showOpenDialog(dialogOptions);

            if (selection.canceled || selection.filePaths.length === 0) {
                return { kind: "canceled" };
            }

            const parentDirectory = selection.filePaths[0];
            if (!parentDirectory) {
                return { kind: "canceled" };
            }

            const repositoryName = deriveRepositoryFolderName(repositoryUrl);
            const targetPath = path.join(parentDirectory, repositoryName);

            try {
                await options.gitService.cloneRepository({
                    parentDirectory,
                    repositoryUrl,
                    targetPath,
                });
            } catch (error) {
                const message =
                    error instanceof Error
                        ? error.message
                        : "Could not clone the repository.";
                throw new Error(message, { cause: error });
            }

            const result =
                await options.projectService.addProjectPaths([targetPath]);
            broadcastProjectsUpdated();
            return { kind: "added", result };
        },
    );
    ipcMain.handle(IPC_CHANNELS.addProjectPaths, async (_event, paths: string[]) => {
        const result = await options.projectService.addProjectPaths(paths);
        broadcastProjectsUpdated();
        return result;
    });
    ipcMain.handle(
        IPC_CHANNELS.getProjectAppDataSummary,
        async (_event, projectId: string) => {
            const summary =
                await options.projectService.getProjectAppDataSummary(projectId);
            return options.settingsService.loadProjectSettings(projectId)
                ? {
                      ...summary,
                      projectSettingsCount: summary.projectSettingsCount + 1,
                  }
                : summary;
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.clearProjectAppData,
        async (event, input: ClearProjectAppDataInput) => {
            const cleared = await destructiveCoordinator.clearProjectAppData(
                requireMainHostWindowId(event.sender),
                input.projectId,
            );
            windowRegistry.forEachLiveWebContents((webContents) => {
                webContents.send(
                    IPC_EVENTS.projectAppDataCleared,
                    input.projectId,
                );
            });
            broadcastProjectsUpdated();
            return {
                cleared,
                projects: options.projectService.listProjects(),
            };
        },
    );
    ipcMain.handle(IPC_CHANNELS.relocateProject, async (event, projectId: string) => {
        const ownerWindow =
            BrowserWindow.fromWebContents(event.sender) ??
            BrowserWindow.getFocusedWindow();
        const dialogOptions: OpenDialogOptions = {
            buttonLabel: "Use This Folder",
            message:
                "Choose the new folder for this project. Chat history will be preserved.",
            properties: ["openDirectory"],
            title: "Change project location",
        };
        const selection = ownerWindow
            ? await dialog.showOpenDialog(ownerWindow, dialogOptions)
            : await dialog.showOpenDialog(dialogOptions);

        if (selection.canceled || selection.filePaths.length === 0) {
            return {
                kind: "canceled",
                projects: options.projectService.listProjects(),
            };
        }

        const projectPath = selection.filePaths[0];
        if (!projectPath) {
            return {
                kind: "canceled",
                projects: options.projectService.listProjects(),
            };
        }

        const result = await options.projectService.relocateProject(
            projectId,
            projectPath,
        );
        broadcastProjectsUpdated();
        return {
            kind: "relocated",
            ...result,
        };
    });
    ipcMain.handle(IPC_CHANNELS.removeProject, async (_event, projectId: string) => {
        const scopes = (
            await options.durableWorkspaceRepository.listDurableWorkspaces()
        ).filter((workspace) => workspace.projectId === projectId);
        for (const context of windowRegistry.listMainWindowContexts()) {
            for (const workspace of scopes) {
                assertWorkspaceSurfaceClosed(
                    await workspaceSurfaceManager.closeWorkspaceSurface(
                        context.windowId,
                        workspace.scopeKey,
                    ),
                );
            }
        }
        await options.projectService.removeProject(projectId);
        broadcastProjectsUpdated();
    });
    ipcMain.handle(IPC_CHANNELS.touchProject, (_event, projectId: string) => {
        options.projectService.touchProject(projectId);
    });
    // Cap concurrent requests on filesystem-fanout handlers so a buggy
    // renderer loop cannot swamp the projects worker / event loop. Limits are
    // generous for read paths and tighter for mutations.
    const listProjectTreeLimiter = createIpcInFlightLimiter(12);
    const listProjectEntriesLimiter = createIpcInFlightLimiter(4);
    const openProjectFileLimiter = createIpcInFlightLimiter(8);
    const saveProjectFileLimiter = createIpcInFlightLimiter(4);
    const createProjectEntryLimiter = createIpcInFlightLimiter(4);
    const copyProjectEntriesLimiter = createIpcInFlightLimiter(2);
    const copyExternalProjectEntriesLimiter = createIpcInFlightLimiter(2);
    const renameProjectEntryLimiter = createIpcInFlightLimiter(4);
    const deleteProjectEntryLimiter = createIpcInFlightLimiter(4);
    ipcMain.handle(
        IPC_CHANNELS.listProjectTree,
        (_event, input: ListProjectTreeInput) =>
            listProjectTreeLimiter(() =>
                options.projectService.listProjectTreeChildren(input),
            ),
    );
    ipcMain.handle(
        IPC_CHANNELS.listProjectEntries,
        (_event, input: ListProjectEntriesInput) =>
            listProjectEntriesLimiter(() =>
                options.projectService.listProjectEntries(input),
            ),
    );
    ipcMain.handle(
        IPC_CHANNELS.openProjectFile,
        (_event, input: OpenProjectFileInput) =>
            openProjectFileLimiter(() =>
                options.projectService.openProjectFile(input),
            ),
    );
    ipcMain.handle(
        IPC_CHANNELS.saveProjectFile,
        (_event, input: SaveProjectFileInput) =>
            saveProjectFileLimiter(() =>
                options.projectService.saveProjectFile(input),
            ),
    );
    ipcMain.handle(
        IPC_CHANNELS.createProjectEntry,
        (_event, input: CreateProjectEntryInput) =>
            createProjectEntryLimiter(() =>
                options.projectService.createProjectEntry(input),
            ),
    );
    ipcMain.handle(
        IPC_CHANNELS.copyProjectEntries,
        (_event, input: CopyProjectEntriesInput) =>
            copyProjectEntriesLimiter(() =>
                options.projectService.copyProjectEntries(input),
            ),
    );
    ipcMain.handle(
        IPC_CHANNELS.copyExternalProjectEntries,
        (_event, input: CopyExternalProjectEntriesInput) =>
            copyExternalProjectEntriesLimiter(() =>
                options.projectService.copyExternalProjectEntries(input),
            ),
    );
    ipcMain.handle(
        IPC_CHANNELS.renameProjectEntry,
        (_event, input: RenameProjectEntryInput) =>
            renameProjectEntryLimiter(() =>
                options.projectService.renameProjectEntry(input),
            ),
    );
    ipcMain.handle(
        IPC_CHANNELS.deleteProjectEntry,
        (_event, input: DeleteProjectEntryInput) =>
            deleteProjectEntryLimiter(() =>
                options.projectService.deleteProjectEntry(input),
            ),
    );
    ipcMain.handle(
        IPC_CHANNELS.trashProjectEntry,
        async (_event, input: TrashProjectEntryInput) => {
            const absolutePath = options.projectService.resolveProjectEntryPath(
                input.projectId,
                input.relativePath,
                input.worktreeId ?? null,
            );
            await shell.trashItem(absolutePath);
            await options.projectService.recordProjectEntryMutation(
                input.projectId,
                input.relativePath,
                input.worktreeId ?? null,
            );
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.openProjectEntryExternally,
        async (_event, input: OpenProjectEntryExternallyInput) => {
            const absolutePath = options.projectService.resolveProjectEntryPath(
                input.projectId,
                input.relativePath,
                input.worktreeId ?? null,
            );
            const stats = await fs.promises.stat(absolutePath);
            if (!stats.isFile()) {
                throw new Error("Only files can be opened externally.");
            }

            const errorMessage = await shell.openPath(absolutePath);
            if (errorMessage) {
                throw new Error(errorMessage);
            }
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.revealProjectEntry,
        (_event, input: RevealProjectEntryInput) => {
            const absolutePath = options.projectService.resolveProjectEntryPath(
                input.projectId,
                input.relativePath,
                input.worktreeId ?? null,
            );
            shell.showItemInFolder(absolutePath);
        },
    );
    // Project search fans out to the projects worker and is the handler most
    // likely to pile up if a renderer loop fires rapidly; cap concurrent
    // in-flight requests to protect the worker pool and the main event loop.
    const searchProjectEntriesLimiter = createIpcInFlightLimiter(8);
    ipcMain.handle(
        IPC_CHANNELS.searchProjectEntries,
        async (_event, input: SearchProjectEntriesInput) => {
            try {
                return await searchProjectEntriesLimiter(() =>
                    options.projectService.searchProjectEntries(input),
                );
            } catch (error) {
                if (isNativeBackendOperationCancelled(error)) {
                    debugBenignError("projects.search-entries.cancelled", error);
                    return [];
                }
                throw error;
            }
        },
    );
    ipcMain.handle(IPC_CHANNELS.getWorkspaceCatalog, async (event) => {
        requireWindowContext(event.sender, "main");
        if (workspaceSurfaceManager.isSurface(event.sender)) {
            throw new Error("The workspace catalog is available only to the host.");
        }
        const [workspaces, navigation, recoveryLayouts, pendingDeletions] = await Promise.all([
            options.durableWorkspaceRepository.listDurableWorkspaces(),
            options.durableWorkspaceRepository.getWorkspaceNavigation(),
            options.durableWorkspaceRepository
                .listWorkspaceRecoveryLayouts(),
            options.durableWorkspaceRepository.listIncompleteWorkspaceDeletions(),
        ]);
        return {
            navigation,
            pendingDeletions,
            recoveryLayouts,
            workspaces,
        };
    });
    ipcMain.handle(
        IPC_CHANNELS.resetWorkspaceLayout,
        async (
            event,
            input: { readonly expectedRevision?: unknown; readonly scopeKey?: unknown },
        ) => {
            const context = requireWindowContext(event.sender, "main");
            if (
                workspaceSurfaceManager.isSurface(event.sender) ||
                !input ||
                typeof input.scopeKey !== "string" ||
                !input.scopeKey ||
                !Number.isSafeInteger(input.expectedRevision) ||
                Number(input.expectedRevision) < 0
            ) {
                throw new Error("A valid durable workspace revision is required.");
            }
            assertWorkspaceSurfaceClosed(
                await workspaceSurfaceManager.closeWorkspaceSurface(
                    context.windowId,
                    input.scopeKey,
                ),
            );
            return options.durableWorkspaceRepository.resetDurableWorkspace({
                expectedRevision: Number(input.expectedRevision),
                layoutSnapshot:
                    createEmptyWorkspaceLayoutSnapshot() as unknown as Readonly<
                        Record<string, unknown>
                    >,
                scopeKey: input.scopeKey,
            });
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.applyWorkspaceRecoveryLayout,
        async (event, input: ApplyWorkspaceRecoveryLayoutInput) => {
            const context = requireWindowContext(event.sender, "main");
            if (workspaceSurfaceManager.isSurface(event.sender)) {
                throw new Error("Recovery layouts are available only to the host.");
            }
            assertWorkspaceSurfaceClosed(
                await workspaceSurfaceManager.closeWorkspaceSurface(
                    context.windowId,
                    input.scopeKey,
                ),
            );
            return options.durableWorkspaceRepository.applyWorkspaceRecoveryLayout(
                input,
            );
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.discardWorkspaceRecoveryLayout,
        async (event, input: DiscardWorkspaceRecoveryLayoutInput) => {
            requireWindowContext(event.sender, "main");
            if (workspaceSurfaceManager.isSurface(event.sender)) {
                throw new Error("Recovery layouts are available only to the host.");
            }
            await options.durableWorkspaceRepository.discardWorkspaceRecoveryLayout(
                input,
            );
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.reassociateWorkspace,
        async (event, input: ReassociateWorkspaceInput) => {
            const context = requireWindowContext(event.sender, "main");
            if (workspaceSurfaceManager.isSurface(event.sender)) {
                throw new Error(
                    "Workspace reassociation is available only to the host.",
                );
            }
            assertWorkspaceSurfaceClosed(
                await workspaceSurfaceManager.closeWorkspaceSurface(
                    context.windowId,
                    input.sourceScopeKey,
                ),
            );
            return options.durableWorkspaceRepository.reassociateWorkspace(input);
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.removeSavedWorkspace,
        async (event, input: RemoveSavedWorkspaceInput) => {
            const context = requireWindowContext(event.sender, "main");
            if (workspaceSurfaceManager.isSurface(event.sender)) {
                throw new Error(
                    "Saved workspaces can be removed only from the host.",
                );
            }
            assertWorkspaceSurfaceClosed(
                await workspaceSurfaceManager.closeWorkspaceSurface(
                    context.windowId,
                    input.scopeKey,
                ),
            );
            await options.durableWorkspaceRepository.purgeDurableWorkspace(input);
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.preflightDeleteWorktree,
        async (event, input: DeleteWorktreePreflightInput) => {
            const context = requireWindowContext(event.sender, "main");
            return destructiveCoordinator.preflightDeleteWorktree(
                context.windowId,
                input,
            );
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.deleteWorktree,
        async (event, input: DeleteWorktreeInput) => {
            const context = requireWindowContext(event.sender, "main");
            const result = await destructiveCoordinator.deleteWorktree(
                context.windowId,
                input,
            );
            broadcastProjectsUpdated();
            return result;
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.initializeWorkspaceSurfaces,
        (event, snapshot: WorkspaceSurfaceRegistrySnapshot) => {
            const context = requireWindowContext(event.sender, "main");
            if (workspaceSurfaceManager.isSurface(event.sender)) {
                return;
            }
            const hostWindow = BrowserWindow.fromWebContents(event.sender);
            if (!hostWindow) {
                throw new Error("The workspace host window is unavailable.");
            }
            workspaceSurfaceManager.syncWorkspaceRegistry(
                hostWindow,
                context,
                snapshot,
            );
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.dispatchWorkspaceSurfaceDrag,
        (event, payload: unknown) => {
            const context = requireWindowContext(event.sender, "main");
            if (workspaceSurfaceManager.isSurface(event.sender)) {
                return;
            }
            if (
                !payload ||
                typeof payload !== "object" ||
                ((payload as { kind?: unknown }).kind !== "agent" &&
                    (payload as { kind?: unknown }).kind !== "github") ||
                typeof (payload as { contextKey?: unknown }).contextKey !==
                    "string" ||
                typeof (payload as { projectId?: unknown }).projectId !==
                    "string" ||
                !(
                    (payload as { worktreeId?: unknown }).worktreeId === null ||
                    typeof (payload as { worktreeId?: unknown }).worktreeId ===
                        "string"
                ) ||
                typeof (payload as { detail?: unknown }).detail !== "object" ||
                (payload as { detail: object | null }).detail === null
            ) {
                throw new Error("An agent or GitHub drag payload is required.");
            }
            return workspaceSurfaceManager.dispatchActiveSurfaceDrag(
                context.windowId,
                payload as WorkspaceSurfaceDragEvent,
            );
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.dispatchWorkspaceSurfaceAction,
        (event, input: WorkspaceSurfaceActionRequest) => {
            const context = requireWindowContext(event.sender, "main");
            if (
                workspaceSurfaceManager.isSurface(event.sender) ||
                !isWorkspaceSurfaceActionRequest(input)
            ) {
                throw new Error("A valid workspace surface action is required.");
            }
            return workspaceSurfaceManager.dispatchActiveSurfaceAction(
                context.windowId,
                input,
            );
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.notifyWorkspaceSurfaceReady,
        (event, binding: WorkspaceSurfaceRuntimeBinding) => {
            workspaceSurfaceManager.notifySurfaceReady(event.sender, binding);
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.notifyWorkspaceSurfaceRestoreFailed,
        (
            event,
            binding: WorkspaceSurfaceRuntimeBinding,
            message: unknown,
        ) => {
            workspaceSurfaceManager.notifySurfaceRestoreFailed(
                event.sender,
                binding,
                typeof message === "string"
                    ? message.slice(0, 1_000)
                    : "Could not restore the workspace surface.",
            );
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.reportWorkspaceSurfaceLeases,
        (event, report) => {
            if (!report || typeof report !== "object") {
                return false;
            }
            return workspaceSurfaceManager.reportSurfaceLeases(
                event.sender,
                report as WorkspaceSurfaceLeaseReport,
            );
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.resyncWorkspaceSurfaceRuntime,
        async (
            event,
            binding: WorkspaceSurfaceRuntimeBinding,
        ): Promise<WorkspaceSurfaceRuntimeResync> => {
            const subscriber =
                workspaceSurfaceManager.getSurfaceRuntimeSubscriber(
                    event.sender,
                );
            if (
                !subscriber ||
                !workspaceSurfaceManager.matchesSurfaceRuntimeBinding(
                    event.sender,
                    binding,
                )
            ) {
                throw new Error("The workspace surface binding is stale.");
            }
            try {
                const [aiSessions, terminals] = await Promise.all([
                    Promise.resolve(
                        options.aiService.resyncRuntimeSubscriber(
                            binding.runtimeOwnerId,
                            binding.generation,
                        ),
                    ),
                    Promise.resolve(
                        options.terminalService.resyncRuntimeSubscriber(
                            binding.runtimeOwnerId,
                            binding.generation,
                        ),
                    ),
                ]);
                workspaceRuntimeOwnership.consumeResyncRequirement(subscriber);
                workspaceSurfaceManager.recordRuntimeResync(event.sender, true);
                return { ...binding, aiSessions, terminals };
            } catch (error) {
                workspaceSurfaceManager.recordRuntimeResync(event.sender, false);
                throw error;
            }
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.claimWorkspaceSurfaceAction,
        (event, actionId: string) =>
            typeof actionId === "string" &&
            workspaceSurfaceManager.claimSurfaceAction(event.sender, actionId),
    );
    ipcMain.handle(
        IPC_CHANNELS.completeWorkspaceSurfaceAction,
        (event, completion: WorkspaceSurfaceActionCompletion) => {
            if (!isWorkspaceSurfaceActionCompletion(completion)) {
                return;
            }
            workspaceSurfaceManager.completeSurfaceAction(
                event.sender,
                completion,
            );
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.publishWorkspaceSurfaceActiveFile,
        (event, input) => {
            if (!isWorkspaceSurfaceActiveFileState(input)) {
                throw new Error("A valid workspace surface active file is required.");
            }
            return workspaceSurfaceManager.publishSurfaceActiveFile(
                event.sender,
                input,
            );
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.publishWorkspaceSurfaceAgentPresence,
        (event, input: WorkspaceSurfaceAgentPresenceState) => {
            if (!isWorkspaceSurfaceAgentPresenceState(input)) {
                throw new Error("A valid workspace surface agent presence is required.");
            }
            return workspaceSurfaceManager.publishSurfaceAgentPresence(
                event.sender,
                input,
            );
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.revealWorkspaceSurfaceFileInHostTree,
        (event, input) => {
            if (!isWorkspaceSurfaceFileRevealRequest(input)) {
                throw new Error("A valid workspace surface file reveal is required.");
            }
            return workspaceSurfaceManager.revealSurfaceFileInHostTree(
                event.sender,
                input,
            );
        },
    );
    ipcMain.handle(IPC_CHANNELS.notifyWorkspaceSurfaceFocused, (event) => {
        const surfaceContext = workspaceSurfaceManager.getSurfaceContext(
            event.sender,
        );
        if (!surfaceContext?.hostWindowId) {
            return;
        }
        workspaceSurfaceManager
            .getHostWebContents(surfaceContext.hostWindowId)
            ?.send(IPC_EVENTS.workspaceSurfaceFocused);
    });
    ipcMain.handle(
        IPC_CHANNELS.activateWorkspaceSurface,
        async (event, contextKey: string) => {
            const context = requireWindowContext(event.sender, "main");
            if (workspaceSurfaceManager.isSurface(event.sender)) {
                throw new Error("A workspace surface cannot activate another surface.");
            }
            const result = await workspaceSurfaceManager.activate(
                context.windowId,
                contextKey,
            );
            if (result.status !== "activated") {
                return result;
            }
            const activeContext = workspaceSurfaceManager.getActiveContext(
                context.windowId,
            );
            windowRegistry.updateMainWindowProjectId(
                context.windowId,
                activeContext?.projectId ?? null,
                activeContext?.worktreeId ?? null,
            );
            const hostWindow = BrowserWindow.fromWebContents(event.sender);
            if (hostWindow) {
                hostWindow.setTitle(
                    buildMainWindowTitle(),
                );
            }
            return result;
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.closeWorkspaceSurface,
        async (event, contextKey: unknown) => {
            const context = requireWindowContext(event.sender, "main");
            if (
                workspaceSurfaceManager.isSurface(event.sender) ||
                typeof contextKey !== "string" ||
                !contextKey
            ) {
                throw new Error("A valid workspace scope is required.");
            }
            const result = await workspaceSurfaceManager.closeWorkspaceSurface(
                context.windowId,
                contextKey,
            );
            if (
                result.status === "closed" &&
                !workspaceSurfaceManager.getActiveContext(context.windowId)
            ) {
                options.persistenceService.saveActiveProjectId(
                    context.windowId,
                    null,
                    null,
                );
                windowRegistry.updateMainWindowProjectId(
                    context.windowId,
                    null,
                    null,
                );
                const hostWindow = BrowserWindow.fromWebContents(event.sender);
                hostWindow?.setTitle(
                    buildMainWindowTitle(),
                );
            }
            return result;
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.loadWorkspaceSurfaceLayout,
        async (event, binding: WorkspaceSurfaceRuntimeBinding) => {
            if (
                !workspaceSurfaceManager.matchesSurfaceRuntimeBinding(
                    event.sender,
                    binding,
                )
            ) {
                throw new Error("The workspace surface binding is stale.");
            }
            const workspace =
                await options.durableWorkspaceRepository.loadDurableWorkspace(
                    binding.scopeKey,
                );
            if (
                !workspace ||
                workspace.runtimeOwnerId !== binding.runtimeOwnerId
            ) {
                throw new Error("The durable workspace is unavailable.");
            }
            const layout = normalizeWorkspaceLayoutSnapshot(
                workspace.layoutSnapshot,
            );
            if (!layout) {
                throw new Error("The durable workspace layout is invalid.");
            }
            return {
                ...binding,
                lastActivatedAt:
                    workspace.lastActivatedAt ?? workspace.updatedAt,
                layout,
                projectId: workspace.projectId,
                revision: workspace.revision,
                worktreeId: workspace.worktreeId,
            };
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.saveWorkspaceSurfaceLayout,
        async (event, input: SaveWorkspaceSurfaceLayoutInput) => {
            if (
                !input ||
                typeof input !== "object" ||
                !Number.isInteger(input.expectedRevision) ||
                input.expectedRevision < 0 ||
                !workspaceSurfaceManager.matchesSurfaceRuntimeBinding(
                    event.sender,
                    input,
                )
            ) {
                throw new Error("A current workspace surface layout is required.");
            }
            const layout = normalizeWorkspaceLayoutSnapshot(input.layout);
            if (!layout) {
                throw new Error("The workspace surface layout is invalid.");
            }
            const current =
                await options.durableWorkspaceRepository.loadDurableWorkspace(
                    input.scopeKey,
                );
            if (!current || current.runtimeOwnerId !== input.runtimeOwnerId) {
                throw new Error("The durable workspace is unavailable.");
            }
            const workspace =
                await options.durableWorkspaceRepository.saveDurableWorkspace({
                    expectedRevision: input.expectedRevision,
                    layoutSnapshot: layout as unknown as Readonly<
                        Record<string, unknown>
                    >,
                    scopeKey: input.scopeKey,
                });
            return {
                generation: input.generation,
                lastActivatedAt:
                    workspace.lastActivatedAt ?? input.lastActivatedAt,
                layout,
                projectId: workspace.projectId,
                revision: workspace.revision,
                runtimeOwnerId: input.runtimeOwnerId,
                scopeKey: input.scopeKey,
                worktreeId: workspace.worktreeId,
            };
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.getWorkspaceSurfaceDiagnostics,
        (event) => {
            const context = requireWindowContext(event.sender, "main");
            if (workspaceSurfaceManager.isSurface(event.sender)) {
                throw new Error("Diagnostics are available only to the host.");
            }
            return workspaceSurfaceManager.sampleSurfaceMemory(context.windowId);
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.setWorkspaceHostOverlayVisible,
        (event, visible: unknown) => {
            const context = requireWindowContext(event.sender, "main");
            if (
                workspaceSurfaceManager.isSurface(event.sender) ||
                typeof visible !== "boolean"
            ) {
                return;
            }
            workspaceSurfaceManager.setHostOverlayVisible(
                context.windowId,
                visible,
            );
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.requestWorkspaceScopeActivation,
        (event, input: WorkspaceScopeActivationRequest) => {
            requireWindowContext(event.sender, "main");
            const surfaceContext = workspaceSurfaceManager.getSurfaceContext(
                event.sender,
            );
            if (
                !surfaceContext ||
                !surfaceContext.hostWindowId ||
                !input ||
                typeof input.projectId !== "string" ||
                input.projectId.length === 0 ||
                (input.worktreeId !== undefined &&
                    input.worktreeId !== null &&
                    typeof input.worktreeId !== "string") ||
                (input.emptyLayout !== undefined &&
                    typeof input.emptyLayout !== "boolean")
            ) {
                return;
            }
            workspaceSurfaceManager
                .getHostWebContents(surfaceContext.hostWindowId)
                ?.send(IPC_EVENTS.workspaceScopeActivationRequested, input);
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.openWorkspaceSurfaceGitScopeMenu,
        (event, anchor: { readonly width: number; readonly x: number }) => {
            const context = requireWindowContext(event.sender, "main");
            if (workspaceSurfaceManager.isSurface(event.sender)) {
                return;
            }
            workspaceSurfaceManager.requestActiveGitScopeMenu(
                context.windowId,
                {
                    width: Math.max(0, Math.round(anchor.width)),
                    x: Math.max(0, Math.round(anchor.x)),
                },
            );
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.showNativeContextMenu,
        (event, input: NativeContextMenuInput) => {
            requireWindowContext(event.sender, "main");
            const window = BrowserWindow.fromWebContents(event.sender);
            if (!window || workspaceSurfaceManager.isSurface(event.sender)) {
                return null;
            }

            return showNativeContextMenu(window, input);
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.setWorkspaceSurfaceContentInset,
        (event, height: number) => {
            const context = requireWindowContext(event.sender, "main");
            if (!workspaceSurfaceManager.isSurface(event.sender)) {
                workspaceSurfaceManager.setContentInset(context.windowId, height);
            }
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.setWorkspaceSurfaceContentLeftInset,
        (event, width: number) => {
            const context = requireWindowContext(event.sender, "main");
            if (!workspaceSurfaceManager.isSurface(event.sender)) {
                workspaceSurfaceManager.setContentLeftInset(
                    context.windowId,
                    width,
                );
            }
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.setWorkspaceSurfaceContentInsets,
        (event, insets: WorkspaceSurfaceContentInsets) => {
            const context = requireWindowContext(event.sender, "main");
            if (!workspaceSurfaceManager.isSurface(event.sender)) {
                workspaceSurfaceManager.setContentInsets(
                    context.windowId,
                    insets,
                );
            }
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.notifyFileBuffer,
        (_event, input: FileBufferNotificationInput) => {
            if (input.content === null) {
                forgetOpenFileBuffer(input.absolutePath);
            } else {
                recordOpenFileBuffer(input.absolutePath, input.content);
            }

            options.aiService.notifyFileBuffer(input);
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.getChatSessionState,
        (_event, sessionId: string) =>
            options.workspaceService.loadChatSessionState(sessionId),
    );
    ipcMain.handle(
        IPC_CHANNELS.createTerminalSession,
        (event, input: CreateTerminalSessionInput) => {
            return options.terminalService.createSession(
                input,
                requireRuntimeOwnerId(event.sender),
            );
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.writeTerminalInput,
        (event, input: WriteTerminalInput) => {
            return options.terminalService.writeInput(
                requireRuntimeOwnerId(event.sender),
                input.sessionId,
                input.data,
            );
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.resizeTerminalSession,
        (event, input: ResizeTerminalSessionInput) => {
            return options.terminalService.resizeSession(
                requireRuntimeOwnerId(event.sender),
                input.sessionId,
                input.cols,
                input.rows,
            );
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.closeTerminalSession,
        (event, sessionId: string) => {
            return options.terminalService.closeSessionOrOwnedTerminal(
                requireRuntimeOwnerId(event.sender),
                sessionId,
            );
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.getAiEnvironmentDiagnostics,
        () => options.aiService.getEnvironmentDiagnostics(),
    );
    ipcMain.handle(
        IPC_CHANNELS.getAiRuntimeStatus,
        (_event, runtimeId: AiRuntimeId) =>
            options.aiService.getRuntimeStatus(runtimeId),
    );
    ipcMain.handle(
        IPC_CHANNELS.prepareAiSession,
        (event, input: PrepareAiSessionInput) => {
            return options.aiService.prepareSession(
                input,
                requireRuntimeOwnerId(event.sender),
            );
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.refreshAiProjectScopes,
        (_event, projectId: string) =>
            options.aiService.refreshProjectScopes(projectId),
    );
    ipcMain.handle(
        IPC_CHANNELS.listAiSessionHistory,
        (_event, input: ListAiSessionHistoryInput) =>
            options.aiService.listSessionHistory(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.getAiSessionSnapshot,
        (_event, sessionId: string) =>
            options.aiService.getSessionSnapshot(sessionId),
    );
    ipcMain.handle(
        IPC_CHANNELS.loadAiReviewDelta,
        (_event, input: AiLoadReviewDeltaInput) =>
            options.aiService.loadReviewDelta(
                input.sessionId,
                input.reviewDeltaId,
                input.expectedRevision,
            ),
    );
    ipcMain.handle(IPC_CHANNELS.releaseAiReviewDelta, (_event, reviewDeltaId: string) => {
        options.aiService.releaseReviewDelta(reviewDeltaId);
    });
    ipcMain.handle(
        IPC_CHANNELS.loadAiToolActivityDetail,
        (_event, input: AiLoadToolActivityDetailInput) =>
            options.aiService.loadToolActivityDetail(input),
    );
    ipcMain.handle(IPC_CHANNELS.resyncAiSession, (event, sessionId: string) => {
        return options.aiService.getLiveSessionSnapshotForWindow(
            requireRuntimeOwnerId(event.sender),
            sessionId,
        );
    });
    ipcMain.handle(
        IPC_CHANNELS.getAiSessionTranscriptPage,
        (_event, input: GetAiSessionTranscriptPageInput) =>
            options.aiService.getSessionTranscriptPage(input),
    );
    ipcMain.handle(IPC_CHANNELS.getAiTranscriptCapability, () =>
        options.aiService.getTranscriptCapability(),
    );
    ipcMain.handle(
        IPC_CHANNELS.getAiTranscriptBlockMetadata,
        (_event, sessionId: string) =>
            options.aiService.getTranscriptBlockMetadata(sessionId),
    );
    ipcMain.handle(
        IPC_CHANNELS.getAiTranscriptBlock,
        (_event, sessionId: string, blockId: string) =>
            options.aiService.getTranscriptBlock(sessionId, blockId),
    );
    ipcMain.handle(IPC_CHANNELS.getAiTranscriptPayload, (_event, input: AiLoadTranscriptPayloadInput) =>
        options.aiService.getTranscriptPayload(input),
    );
    ipcMain.handle(IPC_CHANNELS.getAiTranscriptPayloads, (_event, input: AiLoadTranscriptPayloadsInput) =>
        options.aiService.getTranscriptPayloads(input),
    );
    ipcMain.handle(IPC_CHANNELS.getAiPromptQueue, (event, sessionId: string) => {
        return options.aiService.getPromptQueue(
            sessionId,
            requireRuntimeOwnerId(event.sender),
        );
    });
    ipcMain.handle(
        IPC_CHANNELS.enqueueAiPrompt,
        (event, input: EnqueueAiPromptInput) => {
            return options.aiService.enqueuePrompt(
                input,
                requireRuntimeOwnerId(event.sender),
            );
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.removeAiQueuedPrompt,
        (event, input: AiQueuedPromptMutationInput) => {
            return options.aiService.removeQueuedPrompt(
                input,
                requireRuntimeOwnerId(event.sender),
            );
        },
    );
    ipcMain.handle(IPC_CHANNELS.clearAiPromptQueue, (event, sessionId: string) => {
        return options.aiService.clearPromptQueue(
            sessionId,
            requireRuntimeOwnerId(event.sender),
        );
    });
    ipcMain.handle(
        IPC_CHANNELS.beginEditAiQueuedPrompt,
        (event, input: AiQueuedPromptMutationInput) => {
            return options.aiService.beginEditQueuedPrompt(
                input,
                requireRuntimeOwnerId(event.sender),
            );
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.cancelEditAiQueuedPrompt,
        (event, sessionId: string) => {
            return options.aiService.cancelEditQueuedPrompt(
                sessionId,
                requireRuntimeOwnerId(event.sender),
            );
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.updateAiQueuedPrompt,
        (event, input: UpdateAiQueuedPromptInput) => {
            return options.aiService.updateQueuedPrompt(
                input,
                requireRuntimeOwnerId(event.sender),
            );
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.steerAiQueuedPrompt,
        (event, input: AiQueuedPromptMutationInput) => {
            return options.aiService.steerQueuedPrompt(
                input,
                requireRuntimeOwnerId(event.sender),
            );
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.setAiSessionMode,
        (_event, input: AiSessionModeMutationInput) =>
            options.aiService.setSessionMode(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.setAiSessionModel,
        (_event, input: AiSessionModelMutationInput) =>
            options.aiService.setSessionModel(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.setAiSessionConfigOption,
        (_event, input: AiSessionConfigOptionMutationInput) =>
            options.aiService.setSessionConfigOption(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.setAiSessionPinned,
        (
            _event,
            input: {
                readonly pinned: boolean;
                readonly sessionId: string;
            },
        ) => options.aiService.setSessionPinned(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.renameAiSession,
        (_event, input: AiSessionRenameMutationInput) =>
            options.aiService.renameSession(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.deleteAiSession,
        async (_event, sessionId: string) => {
            await options.aiService.deleteSession(sessionId);
            await options.durableWorkspaceRepository.forgetWorkspaceSessionReferences(
                sessionId,
            );
        },
    );
    ipcMain.handle(IPC_CHANNELS.cancelAiSession, (_event, sessionId: string) =>
        options.aiService.cancelSession(sessionId),
    );
    ipcMain.handle(IPC_CHANNELS.closeAiSession, (_event, sessionId: string) =>
        options.aiService.closeSession(sessionId),
    );
    ipcMain.handle(
        IPC_CHANNELS.launchAiRuntimeAuth,
        (event, input: AiRuntimeAuthLaunchInput) => {
            return options.aiService.launchRuntimeAuth({
                ...input,
                ownerWindowId: resolveRuntimeOwnerId(event.sender),
            });
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.logoutAiRuntimeAuth,
        (event, input: AiRuntimeAuthLogoutInput) => {
            return options.aiService.logoutRuntimeAuth({
                ...input,
                ownerWindowId: resolveRuntimeOwnerId(event.sender),
            });
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.disconnectAiRuntimeAuth,
        (_event, input: AiRuntimeAuthDisconnectInput) =>
            options.aiService.disconnectRuntimeAuth(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.respondAiPermission,
        (_event, input: AiPermissionResponseInput) =>
            options.aiService.respondPermission(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.respondAiUserInput,
        (_event, input: AiUserInputResponseInput) =>
            options.aiService.respondUserInput(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.keepAiTrackedFile,
        (_event, input: AiTrackedFileMutationInput) =>
            options.aiService.keepTrackedFile(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.rejectAiTrackedFile,
        (_event, input: AiTrackedFileMutationInput) =>
            options.aiService.rejectTrackedFile(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.rejectAiTrackedFileHunks,
        (_event, input: AiTrackedFileHunkMutationInput) =>
            options.aiService.rejectTrackedFileHunks(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.keepAiTrackedFileHunks,
        (_event, input: AiTrackedFileHunkMutationInput) =>
            options.aiService.keepTrackedFileHunks(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.keepAllAiTrackedFiles,
        (_event, sessionId: string) =>
            options.aiService.keepAllTrackedFiles(sessionId),
    );
    ipcMain.handle(
        IPC_CHANNELS.rejectAllAiTrackedFiles,
        (_event, sessionId: string) =>
            options.aiService.rejectAllTrackedFiles(sessionId),
    );
    ipcMain.handle(
        IPC_CHANNELS.saveCodexRuntimeSettings,
        (_event, settings: CodexRuntimeSettingsInput) =>
            options.aiService.saveCodexRuntimeSettings(settings),
    );
    ipcMain.handle(
        IPC_CHANNELS.saveClaudeRuntimeSettings,
        (_event, settings: ClaudeRuntimeSettingsInput) =>
            options.aiService.saveClaudeRuntimeSettings(settings),
    );
    ipcMain.handle(
        IPC_CHANNELS.saveGrokRuntimeSettings,
        (_event, settings: GrokRuntimeSettingsInput) =>
            options.aiService.saveGrokRuntimeSettings(settings),
    );
    ipcMain.handle(
        IPC_CHANNELS.saveKiloRuntimeSettings,
        (_event, settings: KiloRuntimeSettingsInput) =>
            options.aiService.saveKiloRuntimeSettings(settings),
    );
    ipcMain.handle(
        IPC_CHANNELS.saveOpenCodeRuntimeSettings,
        (_event, settings: OpenCodeRuntimeSettingsInput) =>
            options.aiService.saveOpenCodeRuntimeSettings(settings),
    );
    ipcMain.handle(
        IPC_CHANNELS.verifyCodexRuntimeSettings,
        (_event, settings: CodexRuntimeSettingsInput) =>
            options.aiService.verifyCodexRuntimeSettings(settings),
    );
}

async function resolveGeneratedImageIpcPath(imagePath: string): Promise<string> {
    if (typeof imagePath !== "string" || imagePath.trim().length === 0) {
        throw new TypeError("Expected generated image path to be a string.");
    }

    const resolvedPath = await resolveCodexGeneratedImageFilePath(imagePath);
    if (!resolvedPath) {
        throw new Error("Generated image path is not authorized.");
    }

    return resolvedPath;
}

function showNativeContextMenu(
    window: BrowserWindow,
    input: NativeContextMenuInput,
): Promise<string | null> {
    return new Promise((resolve) => {
        let selected = false;
        const select = (id: string) => {
            selected = true;
            resolve(id);
        };
        const template = normalizeNativeContextMenuEntries(
            input?.entries,
            select,
        );
        if (!template || template.length === 0) {
            resolve(null);
            return;
        }

        Menu.buildFromTemplate(template).popup({
            callback: () => {
                if (!selected) resolve(null);
            },
            window,
            x: Number.isFinite(input.x) ? Math.max(0, Math.round(input.x)) : 0,
            y: Number.isFinite(input.y) ? Math.max(0, Math.round(input.y)) : 0,
        });
    });
}

function normalizeNativeContextMenuEntries(
    entries: unknown,
    select: (id: string) => void,
    depth = 0,
): MenuItemConstructorOptions[] | null {
    if (!Array.isArray(entries) || entries.length > 100 || depth > 4) {
        return null;
    }

    const template: MenuItemConstructorOptions[] = [];
    for (const rawEntry of entries as unknown[]) {
        if (!rawEntry || typeof rawEntry !== "object") {
            return null;
        }
        const entry = rawEntry as Record<string, unknown>;
        if (entry.type === "separator") {
            template.push({ type: "separator" });
            continue;
        }
        const id = entry.id;
        const label = entry.label;
        const enabled = entry.enabled;
        if (
            typeof id !== "string" ||
            id.length === 0 ||
            id.length > 128 ||
            typeof label !== "string" ||
            label.length === 0 ||
            label.length > 512 ||
            typeof enabled !== "boolean"
        ) {
            return null;
        }

        let submenu: MenuItemConstructorOptions[] | undefined;
        if (entry.children !== undefined) {
            const normalizedChildren = normalizeNativeContextMenuEntries(
                entry.children,
                select,
                depth + 1,
            );
            if (!normalizedChildren) {
                return null;
            }
            submenu = normalizedChildren;
        }
        template.push({
            click: submenu ? undefined : () => select(id),
            enabled,
            label,
            submenu,
        });
    }
    return template;
}

function broadcastProjectSettingsUpdated(
    payload: ProjectSettingsUpdatedEvent,
): void {
    windowRegistry.forEachLiveWebContents((webContents) => {
        webContents.send(IPC_EVENTS.projectSettingsUpdated, payload);
    });
}

function broadcastGitHubAuthUpdated(payload: GitHubAuthStatus): void {
    windowRegistry.forEachLiveWebContents((webContents) => {
        webContents.send(IPC_EVENTS.githubAuthUpdated, payload);
    });
}

function requireWindowContext(
    sender: Electron.WebContents,
    expectedWindowKind: AppWindowKind,
): WindowContextSnapshot {
    const context = windowRegistry.getContextByWebContents(sender);
    if (!context || context.windowKind !== expectedWindowKind) {
        throw new Error(
            "The current renderer does not own a compatible window context.",
        );
    }

    return context;
}

function requireMainHostWindowId(sender: Electron.WebContents): string {
    const context = windowRegistry.getContextByWebContents(sender);
    const windowId =
        (context?.windowKind === "main" ? context.windowId : context?.hostWindowId) ??
        windowRegistry.getLastFocusedMainWindowId() ??
        windowRegistry.listMainWindowContexts()[0]?.windowId ??
        null;
    if (!windowId) {
        throw new Error("A main workspace host is required for this operation.");
    }
    return windowId;
}

function assertWorkspaceSurfaceClosed(result: WorkspaceSurfaceCloseResult): void {
    if (result.status === "blocked") {
        throw new Error(result.leases.map((lease) => lease.message).join(" "));
    }
    if (result.status === "failed") {
        throw new Error(result.message);
    }
}

function resolveRuntimeOwnerId(sender: Electron.WebContents): string | null {
    return (
        workspaceSurfaceManager.getRuntimeOwnerId(sender) ??
        windowRegistry.getContextByWebContents(sender)?.windowId ??
        null
    );
}

function requireRuntimeOwnerId(sender: Electron.WebContents): string {
    const runtimeOwnerId = resolveRuntimeOwnerId(sender);
    if (!runtimeOwnerId) {
        throw new Error("The current renderer has no runtime owner.");
    }
    return runtimeOwnerId;
}

function getPersistenceOwnerId(context: WindowContextSnapshot): string {
    return context.hostWindowId ?? context.windowId;
}

function buildMainWindowTitle(): string {
    return "Comando";
}

interface ResolvedGitScope {
    readonly canonicalRootPath: string;
    readonly projectId: string;
    readonly rootPath: string;
    readonly worktreeId: string | null;
}

type MainGitRepositorySnapshot = Awaited<
    ReturnType<GitGateway["getRepositorySnapshot"]>
>;
type MainGitChangeEntry = MainGitRepositorySnapshot["status"]["entries"][number];
type MainGitWorktreeDiffResult = Awaited<
    ReturnType<GitGateway["listWorktreeDiff"]>
>;
type MainGitWorktreeDiffFile =
    MainGitWorktreeDiffResult["sections"][number]["files"][number];
type MainGitBranchDiffResult = Awaited<ReturnType<GitGateway["listBranchDiff"]>>;
type MainGitBranchDiffFile = MainGitBranchDiffResult["files"][number];
type DiffStatEntry = { additions: number; deletions: number };
type DiffStatMap = Map<string, DiffStatEntry>;

function buildDiffStatMap(
    entries: Awaited<ReturnType<GitGateway["getDiffStats"]>>,
): DiffStatMap {
    const stats: DiffStatMap = new Map();

    for (const entry of entries) {
        stats.set(entry.key, {
            additions: entry.additions,
            deletions: entry.deletions,
        });
    }

    return stats;
}

async function buildSharedGitRepositorySnapshot(
    projectService: ProjectService,
    gitService: GitGateway,
    input: GitRepositoryScopeInput,
): Promise<SharedGitRepositorySnapshot> {
    const scope = resolveGitScope(projectService, input);
    const snapshot = await gitService.getRepositorySnapshot(scope.rootPath);
    return adaptRepositorySnapshot(projectService, gitService, input, snapshot);
}

async function buildSharedGitBranches(
    projectService: ProjectService,
    gitService: GitGateway,
    input: GitBranchListInput,
): Promise<readonly SharedGitBranchSummary[]> {
    const scope = resolveGitScope(projectService, input);
    const snapshot = await gitService.getRepositorySnapshot(scope.rootPath);
    if (snapshot.resolution.state !== "ready") {
        return [];
    }

    const remotes = await gitService.listRemotes(
        scope.rootPath,
        snapshot.status.sync?.trackingBranchName ?? null,
        snapshot.status.sync?.ahead ?? 0,
        snapshot.status.sync?.behind ?? 0,
    );
    const branches = adaptGitBranches(snapshot, remotes);

    return input.includeRemote === false
        ? branches.filter((branch) => !branch.isRemote)
        : branches;
}

async function buildSharedGitDiff(
    projectService: ProjectService,
    gitService: GitGateway,
    input: GitDiffInput,
): Promise<SharedGitFileDiff | null> {
    const scope = resolveGitScope(projectService, input);
    const snapshot = await gitService.getRepositorySnapshot(scope.rootPath);
    if (snapshot.resolution.state !== "ready") {
        return null;
    }

    const normalizedPath = normalizeGitPath(input.path);
    const entry =
        snapshot.status.entries.find(
            (candidate) => candidate.relativePath === normalizedPath,
        ) ?? null;
    if (!entry) {
        return null;
    }

    const requestedScope = normalizeRequestedDiffScope(input.scope);
    if (
        requestedScope !== "auto" &&
        !entry.scopes.includes(requestedScope)
    ) {
        return null;
    }

    const staged =
        requestedScope === "staged" ||
        (requestedScope === "auto" &&
            entry?.scopes.includes("staged") === true &&
            entry.scopes.includes("unstaged") === false);
    const diff = await gitService.getFileDiff(scope.rootPath, normalizedPath, {
        kind: entry?.kind ?? null,
        previousPath: entry?.previousPath ?? null,
        scope: requestedScope,
        staged,
    });

    return adaptGitFileDiff(diff, entry, null);
}

async function buildGitOriginalFile(
    projectService: ProjectService,
    gitService: GitGateway,
    input: GitOriginalFileInput,
): Promise<GitOriginalFile | null> {
    const scope = resolveGitScope(projectService, input);
    const snapshot = await gitService.getRepositorySnapshot(scope.rootPath);
    if (snapshot.resolution.state !== "ready") {
        return null;
    }

    const normalizedPath = normalizeGitPath(input.path);
    const entry =
        snapshot.status.entries.find(
            (candidate) => candidate.relativePath === normalizedPath,
        ) ?? null;
    if (!entry) {
        return null;
    }

    const requestedScope = normalizeRequestedDiffScope(input.scope);
    if (
        requestedScope !== "auto" &&
        !entry.scopes.includes(requestedScope)
    ) {
        return null;
    }

    const resolvedScope = resolveEffectiveGitDiffScope(entry, requestedScope);

    if (entry.isBinary || resolvedScope === "conflicted") {
        return {
            baseText: null,
            isText: false,
            kind: mapSharedChangeKind(entry.kind),
            path: entry.relativePath,
            previousPath: entry.previousPath,
            scope: resolvedScope,
        };
    }

    const baseText = await resolveGitOriginalFileText(
        gitService,
        scope.rootPath,
        entry,
        resolvedScope,
    );

    return {
        baseText,
        isText: baseText !== null,
        kind: mapSharedChangeKind(entry.kind),
        path: entry.relativePath,
        previousPath: entry.previousPath,
        scope: resolvedScope,
    };
}

async function resolveGitOriginalFileText(
    gitService: GitGateway,
    rootPath: string,
    entry: MainGitChangeEntry,
    diffScope: GitDiffScope,
): Promise<string | null> {
    if (diffScope === "untracked") {
        return "";
    }

    const reference = diffScope === "staged" ? "head" : "index";
    const basePath = resolveGitOriginalFileBasePath(entry, diffScope);
    const baseText = await gitService.getFileText(
        rootPath,
        basePath,
        reference,
    );

    if (baseText !== null) {
        return baseText;
    }

    return entry.kind === "added" || entry.kind === "untracked" ? "" : null;
}

function resolveGitOriginalFileBasePath(
    entry: MainGitChangeEntry,
    diffScope: GitDiffScope,
): string {
    if (diffScope === "staged") {
        return entry.previousPath ?? entry.relativePath;
    }

    if (diffScope === "unstaged" && entry.scopes.includes("staged")) {
        return entry.relativePath;
    }

    return entry.previousPath ?? entry.relativePath;
}

function resolveEffectiveGitDiffScope(
    entry: MainGitChangeEntry,
    requestedScope: GitDiffScope | "auto",
): GitDiffScope {
    if (requestedScope !== "auto") {
        return requestedScope;
    }

    if (entry.scopes.includes("unstaged")) {
        return "unstaged";
    }

    if (entry.scopes.includes("untracked")) {
        return "untracked";
    }

    if (entry.scopes.includes("staged")) {
        return "staged";
    }

    if (entry.scopes.includes("conflicted")) {
        return "conflicted";
    }

    return "unstaged";
}

async function buildSharedGitWorktreeDiff(
    projectService: ProjectService,
    gitService: GitGateway,
    input: GitWorktreeDiffInput,
): Promise<GitWorktreeDiffResult | null> {
    const scope = resolveGitScope(projectService, input);
    const snapshot = await gitService.getRepositorySnapshot(scope.rootPath);
    if (snapshot.resolution.state !== "ready") {
        return null;
    }

    const result = await gitService.listWorktreeDiff(scope.rootPath, {
        scopes: input.scopes,
    });

    return adaptGitWorktreeDiffResult(input.projectId, scope.worktreeId, result);
}

function adaptGitWorktreeDiffResult(
    projectId: string,
    worktreeId: string | null,
    result: MainGitWorktreeDiffResult,
): GitWorktreeDiffResult {
    return {
        projectId,
        sections: result.sections.map((section): GitWorktreeDiffSection => ({
            files: section.files.map(adaptGitWorktreeDiffFile),
            scope: section.scope,
        })),
        updatedAt: result.updatedAt,
        worktreeId,
    };
}

function adaptGitWorktreeDiffFile(
    file: MainGitWorktreeDiffFile,
): GitWorktreeDiffFile {
    return {
        additions: file.additions,
        deletions: file.deletions,
        diff: file.diff ? adaptGitWorktreeDiffFileDiff(file) : null,
        error: file.error,
        isBinary: file.isBinary,
        isConflicted: file.isConflicted,
        kind: mapSharedChangeKind(file.kind),
        path: file.path,
        previousPath: file.previousPath,
        scope: file.scope,
    };
}

async function buildSharedGitBranchDiff(
    projectService: ProjectService,
    gitService: GitGateway,
    input: GitBranchDiffInput,
): Promise<GitBranchDiffResult | null> {
    const scope = resolveGitScope(projectService, input);
    const snapshot = await gitService.getRepositorySnapshot(scope.rootPath);
    if (snapshot.resolution.state !== "ready") {
        return null;
    }

    const result = await gitService.listBranchDiff(scope.rootPath);
    return {
        baseRef: result.baseRef,
        files: result.files.map(adaptGitBranchDiffFile),
        headRef: result.headRef,
        projectId: input.projectId,
        unavailableReason: result.unavailableReason,
        updatedAt: result.updatedAt,
        worktreeId: scope.worktreeId,
    };
}

function adaptGitBranchDiffFile(file: MainGitBranchDiffFile): GitBranchDiffFile {
    return {
        additions: file.additions,
        deletions: file.deletions,
        diff: file.diff
            ? adaptReadOnlyGitFileDiff(
                  file.diff,
                  file.kind,
                  `branch:${file.diff.changedPath}`,
                  false,
              )
            : null,
        error: file.error,
        isBinary: file.isBinary,
        kind: mapSharedChangeKind(file.kind),
        path: file.path,
        previousPath: file.previousPath,
    };
}

function adaptGitWorktreeDiffFileDiff(
    file: MainGitWorktreeDiffFile,
): SharedGitFileDiff {
    const diff = file.diff;
    if (!diff) {
        throw new Error("Cannot adapt an empty worktree diff file.");
    }

    return adaptReadOnlyGitFileDiff(
        diff,
        file.kind,
        `${file.scope}:${diff.changedPath}`,
        !file.isConflicted,
    );
}

function adaptReadOnlyGitFileDiff(
    diff: MainGitWorktreeDiffFile["diff"],
    kind: MainGitWorktreeDiffFile["kind"],
    idPrefix: string,
    reversible: boolean,
): SharedGitFileDiff {
    if (!diff) {
        throw new Error("Cannot adapt an empty git file diff.");
    }

    return {
        hunks: diff.hunks.map((hunk, hunkIndex) => ({
            id: `${idPrefix}:${hunkIndex}`,
            lines: hunk.lines.map((line, lineIndex) => ({
                id: `${idPrefix}:${hunkIndex}:${lineIndex}`,
                text: line.text,
                type: line.type,
            })),
            newCount: hunk.newCount,
            newStart: hunk.newStart,
            oldCount: hunk.oldCount,
            oldStart: hunk.oldStart,
        })),
        isText: !diff.isBinary,
        kind: mapDiffKind(kind),
        newText: null,
        oldText: null,
        patch: diff.raw,
        path: diff.changedPath,
        previousPath: diff.previousPath,
        reversible,
    };
}

function adaptGitFileDiff(
    diff: Awaited<ReturnType<GitGateway["getFileDiff"]>>,
    entry: MainGitChangeEntry | null,
    diffScope: GitDiffScope | null,
): SharedGitFileDiff {
    const idPrefix = diffScope
        ? `${diffScope}:${diff.changedPath}`
        : diff.changedPath;

    return {
        hunks: diff.hunks.map((hunk, hunkIndex) => ({
            id: `${idPrefix}:${hunkIndex}`,
            lines: hunk.lines.map((line, lineIndex) => ({
                id: `${idPrefix}:${hunkIndex}:${lineIndex}`,
                text: line.text,
                type: line.type,
            })),
            newCount: hunk.newCount,
            newStart: hunk.newStart,
            oldCount: hunk.oldCount,
            oldStart: hunk.oldStart,
        })),
        isText: !diff.isBinary,
        kind: mapDiffKind(entry?.kind ?? null),
        newText: null,
        oldText: null,
        patch: diff.raw,
        path: diff.changedPath,
        previousPath: diff.previousPath,
        reversible: entry?.conflicted !== true,
    };
}

function normalizeRequestedDiffScope(
    requestedScope: GitDiffInput["scope"],
): GitDiffScope | "auto" {
    return isGitDiffScope(requestedScope) ? requestedScope : "auto";
}

function isGitDiffScope(value: unknown): value is GitDiffScope {
    return (
        value === "conflicted" ||
        value === "staged" ||
        value === "unstaged" ||
        value === "untracked"
    );
}

async function handleGitSnapshotMutation(
    projectService: ProjectService,
    gitService: GitGateway,
    input: GitRepositoryScopeInput,
    reason: GitRepositoryInvalidation["reason"],
    mutate: (rootPath: string) => Promise<MainGitRepositorySnapshot>,
): Promise<SharedGitRepositorySnapshot> {
    const scope = resolveGitScope(projectService, input);
    const snapshot = await mutate(scope.rootPath);
    const sharedSnapshot = await adaptRepositorySnapshot(
        projectService,
        gitService,
        input,
        snapshot,
    );

    notifyGitSnapshot(sharedSnapshot, reason);
    return sharedSnapshot;
}

async function adaptRepositorySnapshot(
    projectService: ProjectService,
    gitService: GitGateway,
    input: GitRepositoryScopeInput,
    snapshot: MainGitRepositorySnapshot,
): Promise<SharedGitRepositorySnapshot> {
    const scope = resolveGitScope(projectService, input);
    const remotes =
        snapshot.resolution.state === "ready"
            ? await gitService.listRemotes(
                  scope.rootPath,
                  snapshot.status.sync?.trackingBranchName ?? null,
                  snapshot.status.sync?.ahead ?? 0,
                  snapshot.status.sync?.behind ?? 0,
              )
            : [];
    const syncedWorktrees =
        snapshot.resolution.state === "ready"
            ? await projectService.syncProjectWorktrees(
                  input.projectId,
                  snapshot.worktrees.map((worktree) => ({
                      branchName: worktree.branchName,
                      headSha: worktree.headCommit || null,
                      rootPath: worktree.canonicalPath,
                  })),
              )
            : projectService.listProjectWorktrees(input.projectId);
    const branches = adaptGitBranches(snapshot, remotes);
    const currentBranch =
        branches.find((branch) => branch.isCurrent) ??
        buildDetachedBranch(snapshot, remotes);
    const worktrees = adaptGitWorktrees(scope, syncedWorktrees, snapshot);
    const currentWorktreeId =
        worktrees.find(
            (worktree) =>
                normalizePathKey(worktree.rootPath) ===
                normalizePathKey(scope.rootPath),
        )?.id ?? scope.worktreeId;
    const aheadBy = snapshot.status.sync?.ahead ?? 0;
    const behindBy = snapshot.status.sync?.behind ?? 0;
    const diffStats =
        snapshot.resolution.state === "ready"
            ? buildDiffStatMap(await gitService.getDiffStats(scope.rootPath))
            : new Map<string, DiffStatEntry>();
    const status: GitRepositoryStatusSummary = {
        changedCount: snapshot.status.entries.length,
        conflictedCount: snapshot.status.counts.conflicted,
        stagedCount: snapshot.status.counts.staged,
        unstagedCount: snapshot.status.counts.unstaged,
        untrackedCount: snapshot.status.counts.untracked,
    };

    return {
        aheadBy,
        behindBy,
        branch: currentBranch,
        branches,
        canonicalRootPath: scope.canonicalRootPath,
        changedPaths: snapshot.status.entries.map(
            (entry) => entry.relativePath,
        ),
        changes: snapshot.status.entries.map((entry) =>
            adaptGitChangeEntry(entry, currentWorktreeId, diffStats),
        ),
        currentWorktreeId,
        defaultTreeViewMode: "tree",
        headSha:
            snapshot.status.sync?.commit ??
            worktrees.find((worktree) => worktree.isCurrent)?.commitSha ??
            null,
        projectId: input.projectId,
        remotes,
        repositoryState: snapshot.resolution.state,
        rootPath: scope.rootPath,
        selectedRemoteName:
            remotes.find((remote) => remote.isDefault)?.name ?? null,
        status,
        syncStatus: deriveSharedSyncStatus(aheadBy, behindBy),
        updatedAt: snapshot.fetchedAt,
        worktrees,
    };
}

function resolveGitScope(
    projectService: ProjectService,
    input: GitRepositoryScopeInput,
): ResolvedGitScope {
    const fallbackWorktreeId = projectService.getPrimaryWorktreeId(
        input.projectId,
    );
    const worktreeId = input.worktreeId ?? fallbackWorktreeId ?? null;

    return {
        canonicalRootPath: projectService.getProjectCanonicalRootPath(
            input.projectId,
        ),
        projectId: input.projectId,
        rootPath: projectService.getProjectRootPath(
            input.projectId,
            worktreeId,
        ),
        worktreeId,
    };
}

function adaptGitChangeEntry(
    entry: MainGitRepositorySnapshot["status"]["entries"][number],
    worktreeId: string | null,
    diffStats: DiffStatMap,
): SharedGitChangeEntry {
    const scope = derivePrimaryScope(entry.scopes);
    const stat = resolveEntryDiffStat(
        entry.relativePath,
        entry.scopes,
        diffStats,
    );
    return {
        additions: stat?.additions ?? null,
        deletions: stat?.deletions ?? null,
        hasChildren: false,
        isBinary: entry.isBinary,
        isConflicted: entry.conflicted,
        isRenamed: entry.isRenamed,
        kind: mapSharedChangeKind(entry.kind),
        path: entry.relativePath,
        previousPath: entry.previousPath,
        scope,
        worktreeId,
    };
}

function adaptGitWorktrees(
    scope: ResolvedGitScope,
    syncedWorktrees: ReturnType<ProjectService["listProjectWorktrees"]>,
    snapshot: MainGitRepositorySnapshot,
): readonly SharedGitWorktreeSummary[] {
    const internalByPath = new Map(
        snapshot.worktrees.map((worktree) => [
            normalizePathKey(worktree.canonicalPath),
            worktree,
        ]),
    );

    return syncedWorktrees
        .map((worktree) => {
            const internal = internalByPath.get(
                normalizePathKey(worktree.rootPath),
            );

            return {
                branchName: worktree.branchName ?? internal?.branchName ?? null,
                commitSha: worktree.headSha ?? internal?.headCommit ?? null,
                id: worktree.id,
                isBare: snapshot.resolution.state === "bare",
                isCurrent:
                    normalizePathKey(worktree.rootPath) ===
                    normalizePathKey(scope.rootPath),
                isLocked: internal?.locked ?? false,
                isPrimary: worktree.isPrimary,
                lockedReason: internal?.lockReason ?? null,
                projectId: worktree.projectId,
                rootPath: worktree.rootPath,
                updatedAt: worktree.updatedAt,
            } satisfies SharedGitWorktreeSummary;
        })
        .sort((left, right) => {
            if (left.isCurrent !== right.isCurrent) {
                return left.isCurrent ? -1 : 1;
            }

            if (left.isPrimary !== right.isPrimary) {
                return left.isPrimary ? -1 : 1;
            }

            return left.rootPath.localeCompare(right.rootPath);
        });
}

function adaptGitBranches(
    snapshot: MainGitRepositorySnapshot,
    remotes: readonly GitRemoteSummary[],
): readonly SharedGitBranchSummary[] {
    const trackingBranchName = snapshot.status.sync?.trackingBranchName ?? null;
    const trackingRemoteName = getRemoteNameFromRef(trackingBranchName);

    return snapshot.branches
        .map((branch) => {
            const isCurrent = branch.current;
            const upstreamName = isCurrent
                ? trackingBranchName
                : inferBranchUpstream(branch.name, remotes);

            return {
                aheadBy:
                    isCurrent &&
                    getRemoteNameFromRef(upstreamName) === trackingRemoteName
                        ? (snapshot.status.sync?.ahead ?? 0)
                        : 0,
                behindBy:
                    isCurrent &&
                    getRemoteNameFromRef(upstreamName) === trackingRemoteName
                        ? (snapshot.status.sync?.behind ?? 0)
                        : 0,
                commitSha: branch.commit || null,
                isCurrent,
                isDetached: Boolean(
                    isCurrent && snapshot.status.sync?.detached,
                ),
                isRemote: branch.isRemote,
                kind: branch.isRemote ? "remote" : "branch",
                name: branch.name,
                upstreamName,
            } satisfies SharedGitBranchSummary;
        })
        .sort((left, right) => {
            if (left.isCurrent !== right.isCurrent) {
                return left.isCurrent ? -1 : 1;
            }

            if (left.isRemote !== right.isRemote) {
                return left.isRemote ? 1 : -1;
            }

            return left.name.localeCompare(right.name);
        });
}

function buildDetachedBranch(
    snapshot: MainGitRepositorySnapshot,
    remotes: readonly GitRemoteSummary[],
): SharedGitBranchSummary | null {
    if (!snapshot.status.sync?.detached) {
        return null;
    }

    return {
        aheadBy: snapshot.status.sync.ahead,
        behindBy: snapshot.status.sync.behind,
        commitSha: snapshot.status.sync.commit,
        isCurrent: true,
        isDetached: true,
        isRemote: false,
        kind: "detached",
        name: snapshot.status.sync.branchName ?? "HEAD",
        upstreamName:
            snapshot.status.sync.trackingBranchName ??
            remotes.find((remote) => remote.isDefault)?.refName ??
            null,
    };
}

function notifyGitSnapshot(
    snapshot: SharedGitRepositorySnapshot,
    reason: GitRepositoryInvalidation["reason"],
): void {
    const invalidation: GitRepositoryInvalidation = {
        occurredAt: snapshot.updatedAt,
        projectId: snapshot.projectId,
        reason,
        rootPath: snapshot.rootPath,
        worktreeId: snapshot.currentWorktreeId,
    };

    windowRegistry.forEachLiveWebContents((webContents) => {
        webContents.send(
            IPC_EVENTS.gitRepositoryInvalidated,
            invalidation,
        );
        webContents.send(
            IPC_EVENTS.gitRepositorySnapshotUpdated,
            snapshot,
        );
        if (reason === "worktree") {
            webContents.send(
                IPC_EVENTS.gitWorktreesUpdated,
                invalidation,
            );
        }
    });
}

function derivePrimaryScope(
    scopes: readonly ("conflicted" | "staged" | "untracked" | "unstaged")[],
): "conflicted" | "staged" | "unstaged" | "untracked" {
    if (scopes.includes("conflicted")) {
        return "conflicted";
    }

    if (scopes.includes("unstaged")) {
        return "unstaged";
    }

    if (scopes.includes("staged")) {
        return "staged";
    }

    return "untracked";
}

function resolveEntryDiffStat(
    relativePath: string,
    scopes: readonly ("conflicted" | "staged" | "untracked" | "unstaged")[],
    diffStats: DiffStatMap,
): DiffStatEntry | null {
    let additions = 0;
    let deletions = 0;
    let hasStat = false;

    for (const scope of scopes) {
        const stat = diffStats.get(`${scope}:${relativePath}`);
        if (!stat) {
            continue;
        }

        additions += stat.additions;
        deletions += stat.deletions;
        hasStat = true;
    }

    return hasStat ? { additions, deletions } : null;
}

function mapSharedChangeKind(kind: string): SharedGitChangeEntry["kind"] {
    switch (kind) {
        case "added":
        case "conflicted":
        case "copied":
        case "deleted":
        case "modified":
        case "renamed":
        case "untracked":
            return kind;
        case "typechanged":
            return "typechange";
        default:
            return "modified";
    }
}

function mapDiffKind(kind: string | null): SharedGitFileDiff["kind"] {
    switch (kind) {
        case "added":
        case "copied":
        case "untracked":
            return "create";
        case "deleted":
            return "delete";
        case "renamed":
            return "move";
        default:
            return "update";
    }
}

function deriveSharedSyncStatus(
    aheadBy: number,
    behindBy: number,
): SharedGitSyncStatus {
    if (aheadBy > 0 && behindBy > 0) {
        return "diverged";
    }

    if (aheadBy > 0) {
        return "ahead";
    }

    if (behindBy > 0) {
        return "behind";
    }

    return "in_sync";
}

function inferBranchUpstream(
    branchName: string,
    remotes: readonly GitRemoteSummary[],
): string | null {
    const defaultRemote =
        remotes.find((remote) => remote.isDefault) ?? remotes[0];
    if (!defaultRemote) {
        return null;
    }

    return `${defaultRemote.name}/${stripRemotePrefix(branchName)}`;
}

function getRemoteNameFromRef(referenceName: string | null): string | null {
    if (!referenceName) {
        return null;
    }

    const [remoteName] = referenceName.split("/");
    return remoteName || null;
}

function stripRemotePrefix(referenceName: string): string {
    const segments = referenceName.split("/");
    return segments.length > 2 && segments[0] === "remotes"
        ? segments.slice(2).join("/")
        : segments.length > 1 && segments[0] !== "refs"
          ? segments.slice(1).join("/")
          : referenceName;
}

function normalizePathKey(filePath: string): string {
    return normalizeSharedPathKey(path.resolve(filePath), {
        platform: getNativePathIdentityPlatform(),
    });
}

function getNativePathIdentityPlatform(): "posix" | "win32" {
    return process.platform === "win32" ? "win32" : "posix";
}

function broadcastCurrentSettings(settingsService: SettingsGateway): void {
    const persisted = settingsService.loadSnapshot();
    broadcastSettingsUpdated(
        persisted.appearance ?? null,
        persisted.editor ?? null,
        persisted.aiChat ?? null,
        persisted.terminal ?? null,
    );
}

function normalizeGitPath(filePath: string): string {
    return filePath.split(path.sep).join("/");
}

function deriveRepositoryFolderName(repositoryUrl: string): string {
    // Strip query strings and fragments, then take the final segment and drop
    // a trailing ".git" when present. Fallback to "repository" when parsing
    // yields an empty slug.
    const trimmed = repositoryUrl.trim().split(/[?#]/)[0] ?? "";
    const segments = trimmed.replace(/[\\/]+$/, "").split(/[\\/]/);
    const lastSegment = segments.pop() ?? "";
    const withoutGitSuffix = lastSegment.replace(/\.git$/i, "");
    const sanitized = withoutGitSuffix.replace(/[^\w.-]+/g, "-");
    return sanitized.length > 0 ? sanitized : "repository";
}

function resolveIpcImage(input: ImageClipboardInput) {
    assertIpcImageInput(input);

    const image = nativeImage.createFromDataURL(
        `data:${input.mimeType};base64,${input.dataBase64}`,
    );
    if (image.isEmpty()) {
        throw new TypeError("Expected decodable image data.");
    }

    return image;
}

function assertIpcImageInput(
    input: ImageClipboardInput,
): asserts input is ImageClipboardInput {
    if (
        !input ||
        typeof input.dataBase64 !== "string" ||
        typeof input.mimeType !== "string" ||
        !input.mimeType.startsWith("image/")
    ) {
        throw new TypeError("Expected valid image data.");
    }
}
