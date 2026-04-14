import { contextBridge, ipcRenderer } from "electron";

import {
    IPC_CHANNELS,
    IPC_EVENTS,
    type AppBootstrapSnapshot,
    type AiPermissionResponseInput,
    type AiRuntimeAuthLaunchInput,
    type AiRuntimeId,
    type AiRuntimeStatus,
    type AiSessionConfigOptionMutationInput,
    type AiSessionModeMutationInput,
    type AiSessionModelMutationInput,
    type AiSessionSnapshot,
    type AiTrackedFileHunkMutationInput,
    type AiTrackedFileMutationInput,
    type AiUserInputResponseInput,
    type ClaudeRuntimeSettingsInput,
    type ComandoApi,
    type CodexRuntimeSettings,
    type CreateProjectEntryInput,
    type CreateTerminalSessionInput,
    type DeleteProjectEntryInput,
    type ListProjectTreeInput,
    type OpenProjectWindowInput,
    type OpenProjectFileInput,
    type OpenSettingsWindowInput,
    type PersistenceSnapshot,
    type PrepareAiSessionInput,
    type ProjectSettingsSnapshot,
    type ProjectSettingsUpdatedEvent,
    type ProjectTreeInvalidation,
    type WindowContextSnapshot,
    type GeminiRuntimeSettingsInput,
    type GitBranchListInput,
    type GitBranchSummary,
    type GitChangesListInput,
    type GitChangeEntry,
    type GitCheckoutBranchInput,
    type GitCommitInput,
    type GitCommitResult,
    type GitCreateWorktreeInput,
    type GitDiscardPathsInput,
    type GitDiffInput,
    type GitFileDiff,
    type GitFetchInput,
    type GitPullInput,
    type GitPushInput,
    type GitRemoveWorktreeInput,
    type GitRepositoryInvalidation,
    type GitRepositoryScopeInput,
    type GitRepositorySnapshot,
    type GitStagePathsInput,
    type GitUnstagePathsInput,
    type GitWorktreeListInput,
    type GitWorktreeSummary,
    type KiloRuntimeSettingsInput,
    type RenameProjectEntryInput,
    type RevealProjectEntryInput,
    type ResizeTerminalSessionInput,
    type SearchProjectEntriesInput,
    type SaveProjectFileInput,
    type SendAiPromptInput,
    type SettingsSnapshot,
    type SettingsUpdatedEvent,
    type SystemTheme,
    type TerminalDataEvent,
    type TerminalExitEvent,
    type WriteTerminalInput,
    type WorkspaceSnapshot,
} from "@shared/ipc";

const comandoApi: ComandoApi = {
    getBootstrapSnapshot: () =>
        ipcRenderer.invoke(
            IPC_CHANNELS.getBootstrapSnapshot,
        ) as Promise<AppBootstrapSnapshot>,
    getPersistenceSnapshot: () =>
        ipcRenderer.invoke(
            IPC_CHANNELS.getPersistenceSnapshot,
        ) as Promise<PersistenceSnapshot>,
    getWindowContext: () =>
        ipcRenderer.invoke(
            IPC_CHANNELS.getWindowContext,
        ) as Promise<WindowContextSnapshot | null>,
    openProjectWindow: (input: OpenProjectWindowInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.openProjectWindow, input),
    getSettingsSnapshot: () =>
        ipcRenderer.invoke(
            IPC_CHANNELS.getSettingsSnapshot,
        ) as Promise<SettingsSnapshot>,
    getProjectSettings: (projectId: string) =>
        ipcRenderer.invoke(
            IPC_CHANNELS.getProjectSettings,
            projectId,
        ) as Promise<ProjectSettingsSnapshot | null>,
    getSystemTheme: () =>
        ipcRenderer.invoke(IPC_CHANNELS.getSystemTheme) as Promise<SystemTheme>,
    getWorkspaceSnapshot: () =>
        ipcRenderer.invoke(
            IPC_CHANNELS.getWorkspaceSnapshot,
        ) as Promise<WorkspaceSnapshot>,
    createTerminalSession: (input: CreateTerminalSessionInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.createTerminalSession, input),
    addProjectPaths: (paths: string[]) =>
        ipcRenderer.invoke(IPC_CHANNELS.addProjectPaths, paths),
    listProjects: () => ipcRenderer.invoke(IPC_CHANNELS.listProjects),
    onProjectTreeInvalidated: (listener) => {
        const handleEvent = (
            _event: Electron.IpcRendererEvent,
            payload: ProjectTreeInvalidation,
        ) => {
            listener(payload);
        };

        ipcRenderer.on(IPC_EVENTS.projectTreeInvalidated, handleEvent);

        return () => {
            ipcRenderer.removeListener(
                IPC_EVENTS.projectTreeInvalidated,
                handleEvent,
            );
        };
    },
    onProjectWindowRequested: (listener) => {
        const handleEvent = (
            _event: Electron.IpcRendererEvent,
            payload: OpenProjectWindowInput,
        ) => {
            listener(payload);
        };

        ipcRenderer.on(IPC_EVENTS.projectWindowRequested, handleEvent);

        return () => {
            ipcRenderer.removeListener(
                IPC_EVENTS.projectWindowRequested,
                handleEvent,
            );
        };
    },
    onGitRepositoryInvalidated: (listener) => {
        const handleEvent = (
            _event: Electron.IpcRendererEvent,
            payload: GitRepositoryInvalidation,
        ) => {
            listener(payload);
        };

        ipcRenderer.on(IPC_EVENTS.gitRepositoryInvalidated, handleEvent);

        return () => {
            ipcRenderer.removeListener(
                IPC_EVENTS.gitRepositoryInvalidated,
                handleEvent,
            );
        };
    },
    onGitRepositorySnapshotUpdated: (listener) => {
        const handleEvent = (
            _event: Electron.IpcRendererEvent,
            payload: GitRepositorySnapshot,
        ) => {
            listener(payload);
        };

        ipcRenderer.on(IPC_EVENTS.gitRepositorySnapshotUpdated, handleEvent);

        return () => {
            ipcRenderer.removeListener(
                IPC_EVENTS.gitRepositorySnapshotUpdated,
                handleEvent,
            );
        };
    },
    onGitWorktreesUpdated: (listener) => {
        const handleEvent = (
            _event: Electron.IpcRendererEvent,
            payload: GitRepositoryInvalidation,
        ) => {
            listener(payload);
        };

        ipcRenderer.on(IPC_EVENTS.gitWorktreesUpdated, handleEvent);

        return () => {
            ipcRenderer.removeListener(
                IPC_EVENTS.gitWorktreesUpdated,
                handleEvent,
            );
        };
    },
    onThemeUpdated: (listener) => {
        const handleEvent = (
            _event: Electron.IpcRendererEvent,
            theme: SystemTheme,
        ) => {
            listener(theme);
        };

        ipcRenderer.on(IPC_EVENTS.themeUpdated, handleEvent);

        return () => {
            ipcRenderer.removeListener(IPC_EVENTS.themeUpdated, handleEvent);
        };
    },
    onSettingsUpdated: (listener) => {
        const handleEvent = (
            _event: Electron.IpcRendererEvent,
            payload: SettingsUpdatedEvent,
        ) => {
            listener(payload);
        };

        ipcRenderer.on(IPC_EVENTS.settingsUpdated, handleEvent);

        return () => {
            ipcRenderer.removeListener(IPC_EVENTS.settingsUpdated, handleEvent);
        };
    },
    onProjectSettingsUpdated: (listener) => {
        const handleEvent = (
            _event: Electron.IpcRendererEvent,
            payload: ProjectSettingsUpdatedEvent,
        ) => {
            listener(payload);
        };

        ipcRenderer.on(IPC_EVENTS.projectSettingsUpdated, handleEvent);

        return () => {
            ipcRenderer.removeListener(
                IPC_EVENTS.projectSettingsUpdated,
                handleEvent,
            );
        };
    },
    onWorkspaceCloseActiveTab: (listener) => {
        const handleEvent = () => {
            listener();
        };

        ipcRenderer.on(IPC_EVENTS.workspaceCloseActiveTab, handleEvent);

        return () => {
            ipcRenderer.removeListener(
                IPC_EVENTS.workspaceCloseActiveTab,
                handleEvent,
            );
        };
    },
    onTerminalData: (listener) => {
        const handleEvent = (
            _event: Electron.IpcRendererEvent,
            payload: TerminalDataEvent,
        ) => {
            listener(payload);
        };

        ipcRenderer.on(IPC_EVENTS.terminalData, handleEvent);

        return () => {
            ipcRenderer.removeListener(IPC_EVENTS.terminalData, handleEvent);
        };
    },
    onTerminalExit: (listener) => {
        const handleEvent = (
            _event: Electron.IpcRendererEvent,
            payload: TerminalExitEvent,
        ) => {
            listener(payload);
        };

        ipcRenderer.on(IPC_EVENTS.terminalExit, handleEvent);

        return () => {
            ipcRenderer.removeListener(IPC_EVENTS.terminalExit, handleEvent);
        };
    },
    openProjectFile: (input: OpenProjectFileInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.openProjectFile, input),
    openProjects: () => ipcRenderer.invoke(IPC_CHANNELS.openProjects),
    saveProjectFile: (input: SaveProjectFileInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.saveProjectFile, input),
    createProjectEntry: (input: CreateProjectEntryInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.createProjectEntry, input),
    renameProjectEntry: (input: RenameProjectEntryInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.renameProjectEntry, input),
    deleteProjectEntry: (input: DeleteProjectEntryInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.deleteProjectEntry, input),
    revealProjectEntry: (input: RevealProjectEntryInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.revealProjectEntry, input),
    saveSettingsSnapshot: (snapshot: SettingsSnapshot) =>
        ipcRenderer.invoke(IPC_CHANNELS.saveSettingsSnapshot, snapshot),
    saveProjectSettings: (snapshot: ProjectSettingsSnapshot) =>
        ipcRenderer.invoke(IPC_CHANNELS.saveProjectSettings, snapshot),
    openSettingsWindow: (input: OpenSettingsWindowInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.openSettingsWindow, input),
    saveActiveProjectId: (projectId: string | null) =>
        ipcRenderer.invoke(IPC_CHANNELS.saveActiveProjectId, projectId),
    saveActiveWorktreeId: (worktreeId: string | null) =>
        ipcRenderer.invoke(IPC_CHANNELS.saveActiveWorktreeId, worktreeId),
    saveShellState: (snapshot) =>
        ipcRenderer.invoke(IPC_CHANNELS.saveShellState, snapshot),
    setTrafficLightVisibility: (visible: boolean) =>
        ipcRenderer.invoke(IPC_CHANNELS.setTrafficLightVisibility, visible),
    getGitRepositorySnapshot: (input: GitRepositoryScopeInput) =>
        ipcRenderer.invoke(
            IPC_CHANNELS.getGitRepositorySnapshot,
            input,
        ) as Promise<GitRepositorySnapshot | null>,
    listGitBranches: (input: GitBranchListInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.listGitBranches, input) as Promise<
            readonly GitBranchSummary[]
        >,
    listGitWorktrees: (input: GitWorktreeListInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.listGitWorktrees, input) as Promise<
            readonly GitWorktreeSummary[]
        >,
    listGitChanges: (input: GitChangesListInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.listGitChanges, input) as Promise<
            readonly GitChangeEntry[]
        >,
    getGitDiff: (input: GitDiffInput) =>
        ipcRenderer.invoke(
            IPC_CHANNELS.getGitDiff,
            input,
        ) as Promise<GitFileDiff | null>,
    stageGitPaths: (input: GitStagePathsInput) =>
        ipcRenderer.invoke(
            IPC_CHANNELS.stageGitPaths,
            input,
        ) as Promise<GitRepositorySnapshot>,
    unstageGitPaths: (input: GitUnstagePathsInput) =>
        ipcRenderer.invoke(
            IPC_CHANNELS.unstageGitPaths,
            input,
        ) as Promise<GitRepositorySnapshot>,
    discardGitPaths: (input: GitDiscardPathsInput) =>
        ipcRenderer.invoke(
            IPC_CHANNELS.discardGitPaths,
            input,
        ) as Promise<GitRepositorySnapshot>,
    commitGitChanges: (input: GitCommitInput) =>
        ipcRenderer.invoke(
            IPC_CHANNELS.commitGitChanges,
            input,
        ) as Promise<GitCommitResult>,
    checkoutGitBranch: (input: GitCheckoutBranchInput) =>
        ipcRenderer.invoke(
            IPC_CHANNELS.checkoutGitBranch,
            input,
        ) as Promise<GitRepositorySnapshot>,
    createGitWorktree: (input: GitCreateWorktreeInput) =>
        ipcRenderer.invoke(
            IPC_CHANNELS.createGitWorktree,
            input,
        ) as Promise<GitWorktreeSummary>,
    removeGitWorktree: (input: GitRemoveWorktreeInput) =>
        ipcRenderer.invoke(
            IPC_CHANNELS.removeGitWorktree,
            input,
        ) as Promise<GitRepositorySnapshot>,
    fetchGitRepository: (input: GitFetchInput) =>
        ipcRenderer.invoke(
            IPC_CHANNELS.fetchGitRepository,
            input,
        ) as Promise<GitRepositorySnapshot>,
    pullGitRepository: (input: GitPullInput) =>
        ipcRenderer.invoke(
            IPC_CHANNELS.pullGitRepository,
            input,
        ) as Promise<GitRepositorySnapshot>,
    pushGitRepository: (input: GitPushInput) =>
        ipcRenderer.invoke(
            IPC_CHANNELS.pushGitRepository,
            input,
        ) as Promise<GitRepositorySnapshot>,
    listProjectTree: (input: ListProjectTreeInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.listProjectTree, input),
    searchProjectEntries: (input: SearchProjectEntriesInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.searchProjectEntries, input),
    removeProject: (projectId: string) =>
        ipcRenderer.invoke(IPC_CHANNELS.removeProject, projectId),
    resizeTerminalSession: (input: ResizeTerminalSessionInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.resizeTerminalSession, input),
    saveWorkspaceSnapshot: (snapshot: WorkspaceSnapshot) =>
        ipcRenderer.invoke(IPC_CHANNELS.saveWorkspaceSnapshot, snapshot),
    getChatSessionState: (sessionId: string) =>
        ipcRenderer.invoke(IPC_CHANNELS.getChatSessionState, sessionId),
    getAiRuntimeStatus: (runtimeId: AiRuntimeId) =>
        ipcRenderer.invoke(IPC_CHANNELS.getAiRuntimeStatus, runtimeId),
    prepareAiSession: (input: PrepareAiSessionInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.prepareAiSession, input),
    getAiSessionSnapshot: (sessionId: string) =>
        ipcRenderer.invoke(IPC_CHANNELS.getAiSessionSnapshot, sessionId),
    sendAiPrompt: (input: SendAiPromptInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.sendAiPrompt, input),
    setAiSessionMode: (input: AiSessionModeMutationInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.setAiSessionMode, input),
    setAiSessionModel: (input: AiSessionModelMutationInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.setAiSessionModel, input),
    setAiSessionConfigOption: (input: AiSessionConfigOptionMutationInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.setAiSessionConfigOption, input),
    cancelAiSession: (sessionId: string) =>
        ipcRenderer.invoke(IPC_CHANNELS.cancelAiSession, sessionId),
    closeAiSession: (sessionId: string) =>
        ipcRenderer.invoke(IPC_CHANNELS.closeAiSession, sessionId),
    launchAiRuntimeAuth: (input: AiRuntimeAuthLaunchInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.launchAiRuntimeAuth, input),
    respondAiPermission: (input: AiPermissionResponseInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.respondAiPermission, input),
    respondAiUserInput: (input: AiUserInputResponseInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.respondAiUserInput, input),
    keepAiTrackedFile: (input: AiTrackedFileMutationInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.keepAiTrackedFile, input),
    rejectAiTrackedFile: (input: AiTrackedFileMutationInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.rejectAiTrackedFile, input),
    keepAiTrackedFileHunks: (input: AiTrackedFileHunkMutationInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.keepAiTrackedFileHunks, input),
    rejectAiTrackedFileHunks: (input: AiTrackedFileHunkMutationInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.rejectAiTrackedFileHunks, input),
    keepAllAiTrackedFiles: (sessionId: string) =>
        ipcRenderer.invoke(IPC_CHANNELS.keepAllAiTrackedFiles, sessionId),
    rejectAllAiTrackedFiles: (sessionId: string) =>
        ipcRenderer.invoke(IPC_CHANNELS.rejectAllAiTrackedFiles, sessionId),
    saveCodexRuntimeSettings: (settings: CodexRuntimeSettings) =>
        ipcRenderer.invoke(IPC_CHANNELS.saveCodexRuntimeSettings, settings),
    verifyCodexRuntimeSettings: (settings: CodexRuntimeSettings) =>
        ipcRenderer.invoke(IPC_CHANNELS.verifyCodexRuntimeSettings, settings),
    saveClaudeRuntimeSettings: (settings: ClaudeRuntimeSettingsInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.saveClaudeRuntimeSettings, settings),
    saveGeminiRuntimeSettings: (settings: GeminiRuntimeSettingsInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.saveGeminiRuntimeSettings, settings),
    saveKiloRuntimeSettings: (settings: KiloRuntimeSettingsInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.saveKiloRuntimeSettings, settings),
    closeTerminalSession: (sessionId: string) =>
        ipcRenderer.invoke(IPC_CHANNELS.closeTerminalSession, sessionId),
    touchProject: (projectId: string) =>
        ipcRenderer.invoke(IPC_CHANNELS.touchProject, projectId),
    writeTerminalInput: (input: WriteTerminalInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.writeTerminalInput, input),
    onAiRuntimeStatus: (listener) => {
        const handleEvent = (
            _event: Electron.IpcRendererEvent,
            status: AiRuntimeStatus,
        ) => {
            listener(status);
        };

        ipcRenderer.on(IPC_EVENTS.aiRuntimeStatus, handleEvent);

        return () => {
            ipcRenderer.removeListener(IPC_EVENTS.aiRuntimeStatus, handleEvent);
        };
    },
    onAiSessionSnapshot: (listener) => {
        const handleEvent = (
            _event: Electron.IpcRendererEvent,
            snapshot: AiSessionSnapshot,
        ) => {
            listener(snapshot);
        };

        ipcRenderer.on(IPC_EVENTS.aiSessionSnapshot, handleEvent);

        return () => {
            ipcRenderer.removeListener(
                IPC_EVENTS.aiSessionSnapshot,
                handleEvent,
            );
        };
    },
};

contextBridge.exposeInMainWorld("comando", comandoApi);
