/// <reference lib="dom" />

import { clipboard, contextBridge, ipcRenderer, webUtils } from "electron";

import {
    IPC_CHANNELS,
    IPC_EVENTS,
    type AppChangelogRelease,
    type ProjectAddResult,
    type AppPrivacyAccessState,
    type AppUpdateState,
    type AppBootstrapSnapshot,
    type AiHistorySessionSummary,
    type AiSessionUpdate,
    type AiPermissionResponseInput,
    type AiRuntimeAuthLaunchInput,
    type AiRuntimeAuthLogoutInput,
    type AiRuntimeId,
    type AiRuntimeStatus,
    type AiSessionConfigOptionMutationInput,
    type AiSessionModeMutationInput,
    type AiSessionModelMutationInput,
    type AiSessionPinnedMutationInput,
    type AiSessionRenameMutationInput,
    type AiSessionTranscriptPage,
    type AiTrackedFileHunkMutationInput,
    type AiTrackedFileMutationInput,
    type AiUserInputResponseInput,
    type ClaudeRuntimeSettingsInput,
    type ComandoApi,
    type CodexRuntimeSettingsInput,
    type CreateProjectEntryInput,
    type CreateTerminalSessionInput,
    type DeleteProjectEntryInput,
    type FileBufferNotificationInput,
    type GetAiSessionTranscriptPageInput,
    type ListAiSessionHistoryInput,
    type ListProjectTreeInput,
    type OpenProjectWindowInput,
    type OpenProjectFileInput,
    type OpenSettingsWindowInput,
    type AiSessionSnapshot,
    type PersistenceSnapshot,
    type PrepareAiSessionInput,
    type ProjectSettingsSnapshot,
    type ProjectSettingsUpdatedEvent,
    type ProjectSummary,
    type ProjectTreeInvalidation,
    type ThemeMode,
    type WindowContextSnapshot,
    type GeminiRuntimeSettingsInput,
    type GitBranchListInput,
    type GitBranchSummary,
    type GitChangesListInput,
    type GitChangeEntry,
    type GitCheckoutBranchInput,
    type GitCommitDetail,
    type GitCommitDetailInput,
    type GitCommitInput,
    type GitCommitResult,
    type GitCreateWorktreeInput,
    type GitDeleteLocalBranchInput,
    type GitDeleteRemoteBranchInput,
    type GitDiscardPathsInput,
    type GitDiffInput,
    type GitFileDiff,
    type GitFetchInput,
    type GitHistoryCommitSummary,
    type GitHistoryListInput,
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

window.addEventListener("DOMContentLoaded", () => {
    document.documentElement?.setAttribute("data-comando-preload", "ready");
});

// Envelope validation policy for IPC responses.
//
// The full structural validation of every snapshot would require duplicating
// hundreds of lines of schema that risk drifting from the TS types. Instead,
// the high-risk bootstrap handlers below go through `assertIpcObject` /
// `assertIpcObjectOrNull` so a broken main handler returning something that is
// not an object (e.g. `undefined`, string, number, boolean) fails loudly at
// the boundary rather than corrupting the renderer state silently.
function assertIpcObject<T>(channel: string, value: unknown): T {
    if (typeof value !== "object" || value === null) {
        throw new Error(
            `IPC contract violation on "${channel}": expected object, got ${typeof value}.`,
        );
    }
    return value as T;
}

function assertIpcObjectOrNull<T>(channel: string, value: unknown): T | null {
    if (value === null) {
        return null;
    }
    if (typeof value !== "object") {
        throw new Error(
            `IPC contract violation on "${channel}": expected object or null, got ${typeof value}.`,
        );
    }
    return value as T;
}

function assertIpcArray<T>(channel: string, value: unknown): T[] {
    if (!Array.isArray(value)) {
        throw new Error(
            `IPC contract violation on "${channel}": expected array, got ${typeof value}.`,
        );
    }
    return value as T[];
}

const aiSessionSnapshotListeners = new Set<(update: AiSessionUpdate) => void>();
let aiSessionSnapshotPort: MessagePort | null = null;

// Narrow runtime guard for the IPC envelope. Does not validate the full
// `AiSessionSnapshot` shape (deliberately: avoids duplicating the whole schema
// across the IPC boundary) — it only ensures the discriminant is valid and
// the referenced payload is a non-null object, which prevents catastrophic
// mismatches if main and renderer schemas ever drift.
function isAiSessionUpdate(value: unknown): value is AiSessionUpdate {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const candidate = value as {
        readonly kind?: unknown;
        readonly patch?: unknown;
        readonly snapshot?: unknown;
    };
    if (candidate.kind === "patch") {
        return (
            typeof candidate.patch === "object" && candidate.patch !== null
        );
    }
    if (candidate.kind === "snapshot") {
        return (
            typeof candidate.snapshot === "object" &&
            candidate.snapshot !== null
        );
    }
    return false;
}

function notifyAiSessionSnapshotListeners(update: unknown): void {
    if (!isAiSessionUpdate(update)) {
        console.warn(
            "[comando] Dropped AiSessionUpdate with unexpected shape.",
        );
        return;
    }
    for (const listener of aiSessionSnapshotListeners) {
        listener(update);
    }
}

function bindAiSessionSnapshotPort(port: MessagePort): void {
    aiSessionSnapshotPort?.close();
    aiSessionSnapshotPort = port;
    aiSessionSnapshotPort.onmessage = (event) => {
        notifyAiSessionSnapshotListeners(event.data);
    };
    aiSessionSnapshotPort.start();
}

function handleAiSessionSnapshotFallback(
    _event: Electron.IpcRendererEvent,
    update: unknown,
): void {
    notifyAiSessionSnapshotListeners(update);
}

ipcRenderer.on(IPC_EVENTS.aiSessionStreamPort, (event) => {
    const [port] = event.ports;
    if (!port) {
        return;
    }

    bindAiSessionSnapshotPort(port);
});

window.addEventListener("beforeunload", () => {
    aiSessionSnapshotPort?.close();
    aiSessionSnapshotPort = null;
});

const comandoApi: ComandoApi = {
    getBootstrapSnapshot: async () =>
        assertIpcObject<AppBootstrapSnapshot>(
            IPC_CHANNELS.getBootstrapSnapshot,
            await ipcRenderer.invoke(IPC_CHANNELS.getBootstrapSnapshot),
        ),
    getAppUpdateState: async () =>
        assertIpcObject<AppUpdateState>(
            IPC_CHANNELS.getAppUpdateState,
            await ipcRenderer.invoke(IPC_CHANNELS.getAppUpdateState),
        ),
    getAppChangelog: async () =>
        assertIpcArray<AppChangelogRelease>(
            IPC_CHANNELS.getAppChangelog,
            await ipcRenderer.invoke(IPC_CHANNELS.getAppChangelog),
        ),
    getAppPrivacyAccessState: async () =>
        assertIpcObject<AppPrivacyAccessState>(
            IPC_CHANNELS.getAppPrivacyAccessState,
            await ipcRenderer.invoke(IPC_CHANNELS.getAppPrivacyAccessState),
        ),
    openMacOsFullDiskAccessSettings: () =>
        ipcRenderer.invoke(IPC_CHANNELS.openMacOsFullDiskAccessSettings),
    checkForAppUpdates: async () =>
        assertIpcObject<AppUpdateState>(
            IPC_CHANNELS.checkForAppUpdates,
            await ipcRenderer.invoke(IPC_CHANNELS.checkForAppUpdates),
        ),
    installAppUpdateAndRestart: () =>
        ipcRenderer.invoke(IPC_CHANNELS.installAppUpdateAndRestart),
    getPersistenceSnapshot: async () =>
        assertIpcObjectOrNull<PersistenceSnapshot>(
            IPC_CHANNELS.getPersistenceSnapshot,
            await ipcRenderer.invoke(IPC_CHANNELS.getPersistenceSnapshot),
        ),
    getWindowContext: async () =>
        assertIpcObjectOrNull<WindowContextSnapshot>(
            IPC_CHANNELS.getWindowContext,
            await ipcRenderer.invoke(IPC_CHANNELS.getWindowContext),
        ),
    readClipboardText: () => Promise.resolve(clipboard.readText()),
    resolveDroppedFilePath: (file) => {
        if (!file) {
            return null;
        }

        try {
            const resolvedPath = webUtils.getPathForFile(file);
            return resolvedPath.trim().length > 0 ? resolvedPath : null;
        } catch {
            return null;
        }
    },
    writeClipboardText: (text: string) => {
        clipboard.writeText(text);
        return Promise.resolve();
    },
    openProjectWindow: (input: OpenProjectWindowInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.openProjectWindow, input),
    getSettingsSnapshot: async () =>
        assertIpcObject<SettingsSnapshot>(
            IPC_CHANNELS.getSettingsSnapshot,
            await ipcRenderer.invoke(IPC_CHANNELS.getSettingsSnapshot),
        ),
    getProjectSettings: async (projectId: string) =>
        assertIpcObjectOrNull<ProjectSettingsSnapshot>(
            IPC_CHANNELS.getProjectSettings,
            await ipcRenderer.invoke(
                IPC_CHANNELS.getProjectSettings,
                projectId,
            ),
        ),
    getSystemTheme: async () =>
        assertIpcObject<SystemTheme>(
            IPC_CHANNELS.getSystemTheme,
            await ipcRenderer.invoke(IPC_CHANNELS.getSystemTheme),
        ),
    getWorkspaceSnapshot: async () =>
        assertIpcObject<WorkspaceSnapshot>(
            IPC_CHANNELS.getWorkspaceSnapshot,
            await ipcRenderer.invoke(IPC_CHANNELS.getWorkspaceSnapshot),
        ),
    createTerminalSession: (input: CreateTerminalSessionInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.createTerminalSession, input),
    addProjectPaths: async (paths: string[]) =>
        assertIpcObject<ProjectAddResult>(
            IPC_CHANNELS.addProjectPaths,
            await ipcRenderer.invoke(IPC_CHANNELS.addProjectPaths, paths),
        ),
    listProjects: async () =>
        assertIpcArray<ProjectSummary>(
            IPC_CHANNELS.listProjects,
            await ipcRenderer.invoke(IPC_CHANNELS.listProjects),
        ),
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
    onAppUpdateState: (listener) => {
        const handleEvent = (
            _event: Electron.IpcRendererEvent,
            payload: AppUpdateState,
        ) => {
            listener(payload);
        };

        ipcRenderer.on(IPC_EVENTS.appUpdateState, handleEvent);

        return () => {
            ipcRenderer.removeListener(IPC_EVENTS.appUpdateState, handleEvent);
        };
    },
    onAppPrivacyAccessState: (listener) => {
        const handleEvent = (
            _event: Electron.IpcRendererEvent,
            payload: AppPrivacyAccessState,
        ) => {
            listener(payload);
        };

        ipcRenderer.on(IPC_EVENTS.appPrivacyAccessState, handleEvent);

        return () => {
            ipcRenderer.removeListener(
                IPC_EVENTS.appPrivacyAccessState,
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
    onWorkspaceReopenLastClosedTab: (listener) => {
        const handleEvent = () => {
            listener();
        };

        ipcRenderer.on(IPC_EVENTS.workspaceReopenLastClosedTab, handleEvent);

        return () => {
            ipcRenderer.removeListener(
                IPC_EVENTS.workspaceReopenLastClosedTab,
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
    openProjects: async () =>
        assertIpcObject<ProjectAddResult>(
            IPC_CHANNELS.openProjects,
            await ipcRenderer.invoke(IPC_CHANNELS.openProjects),
        ),
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
    setNativeAppearance: (mode: ThemeMode) =>
        ipcRenderer.invoke(IPC_CHANNELS.setNativeAppearance, mode),
    getGitRepositorySnapshot: async (input: GitRepositoryScopeInput) =>
        assertIpcObjectOrNull<GitRepositorySnapshot>(
            IPC_CHANNELS.getGitRepositorySnapshot,
            await ipcRenderer.invoke(
                IPC_CHANNELS.getGitRepositorySnapshot,
                input,
            ),
        ),
    listGitBranches: async (input: GitBranchListInput) =>
        assertIpcArray<GitBranchSummary>(
            IPC_CHANNELS.listGitBranches,
            await ipcRenderer.invoke(IPC_CHANNELS.listGitBranches, input),
        ),
    listGitWorktrees: async (input: GitWorktreeListInput) =>
        assertIpcArray<GitWorktreeSummary>(
            IPC_CHANNELS.listGitWorktrees,
            await ipcRenderer.invoke(IPC_CHANNELS.listGitWorktrees, input),
        ),
    listGitChanges: async (input: GitChangesListInput) =>
        assertIpcArray<GitChangeEntry>(
            IPC_CHANNELS.listGitChanges,
            await ipcRenderer.invoke(IPC_CHANNELS.listGitChanges, input),
        ),
    listGitHistory: async (input: GitHistoryListInput) =>
        assertIpcArray<GitHistoryCommitSummary>(
            IPC_CHANNELS.listGitHistory,
            await ipcRenderer.invoke(IPC_CHANNELS.listGitHistory, input),
        ),
    getGitDiff: (input: GitDiffInput) =>
        ipcRenderer.invoke(
            IPC_CHANNELS.getGitDiff,
            input,
        ) as Promise<GitFileDiff | null>,
    getGitCommitDetail: (input: GitCommitDetailInput) =>
        ipcRenderer.invoke(
            IPC_CHANNELS.getGitCommitDetail,
            input,
        ) as Promise<GitCommitDetail | null>,
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
    deleteLocalGitBranch: (input: GitDeleteLocalBranchInput) =>
        ipcRenderer.invoke(
            IPC_CHANNELS.deleteLocalGitBranch,
            input,
        ) as Promise<GitRepositorySnapshot>,
    deleteRemoteGitBranch: (input: GitDeleteRemoteBranchInput) =>
        ipcRenderer.invoke(
            IPC_CHANNELS.deleteRemoteGitBranch,
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
    notifyFileBuffer: (input: FileBufferNotificationInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.notifyFileBuffer, input),
    getChatSessionState: (sessionId: string) =>
        ipcRenderer.invoke(IPC_CHANNELS.getChatSessionState, sessionId),
    getAiRuntimeStatus: async (runtimeId: AiRuntimeId) =>
        assertIpcObject<AiRuntimeStatus>(
            IPC_CHANNELS.getAiRuntimeStatus,
            await ipcRenderer.invoke(
                IPC_CHANNELS.getAiRuntimeStatus,
                runtimeId,
            ),
        ),
    prepareAiSession: (input: PrepareAiSessionInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.prepareAiSession, input),
    refreshAiProjectScopes: (projectId: string) =>
        ipcRenderer.invoke(IPC_CHANNELS.refreshAiProjectScopes, projectId),
    listAiSessionHistory: async (input: ListAiSessionHistoryInput) =>
        assertIpcArray<AiHistorySessionSummary>(
            IPC_CHANNELS.listAiSessionHistory,
            await ipcRenderer.invoke(IPC_CHANNELS.listAiSessionHistory, input),
        ),
    getAiSessionSnapshot: async (sessionId: string) =>
        assertIpcObjectOrNull<AiSessionSnapshot>(
            IPC_CHANNELS.getAiSessionSnapshot,
            await ipcRenderer.invoke(
                IPC_CHANNELS.getAiSessionSnapshot,
                sessionId,
            ),
        ),
    getAiSessionTranscriptPage: (input: GetAiSessionTranscriptPageInput) =>
        ipcRenderer.invoke(
            IPC_CHANNELS.getAiSessionTranscriptPage,
            input,
        ) as Promise<AiSessionTranscriptPage>,
    sendAiPrompt: (input: SendAiPromptInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.sendAiPrompt, input),
    setAiSessionMode: (input: AiSessionModeMutationInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.setAiSessionMode, input),
    setAiSessionModel: (input: AiSessionModelMutationInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.setAiSessionModel, input),
    setAiSessionConfigOption: (input: AiSessionConfigOptionMutationInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.setAiSessionConfigOption, input),
    setAiSessionPinned: (input: AiSessionPinnedMutationInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.setAiSessionPinned, input),
    renameAiSession: (input: AiSessionRenameMutationInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.renameAiSession, input),
    deleteAiSession: (sessionId: string) =>
        ipcRenderer.invoke(IPC_CHANNELS.deleteAiSession, sessionId),
    cancelAiSession: (sessionId: string) =>
        ipcRenderer.invoke(IPC_CHANNELS.cancelAiSession, sessionId),
    closeAiSession: (sessionId: string) =>
        ipcRenderer.invoke(IPC_CHANNELS.closeAiSession, sessionId),
    launchAiRuntimeAuth: (input: AiRuntimeAuthLaunchInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.launchAiRuntimeAuth, input),
    logoutAiRuntimeAuth: (input: AiRuntimeAuthLogoutInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.logoutAiRuntimeAuth, input),
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
    saveCodexRuntimeSettings: (settings: CodexRuntimeSettingsInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.saveCodexRuntimeSettings, settings),
    verifyCodexRuntimeSettings: (settings: CodexRuntimeSettingsInput) =>
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
        if (aiSessionSnapshotListeners.size === 0) {
            ipcRenderer.on(
                IPC_EVENTS.aiSessionSnapshot,
                handleAiSessionSnapshotFallback,
            );
        }

        aiSessionSnapshotListeners.add(listener);

        return () => {
            aiSessionSnapshotListeners.delete(listener);

            if (aiSessionSnapshotListeners.size === 0) {
                ipcRenderer.removeListener(
                    IPC_EVENTS.aiSessionSnapshot,
                    handleAiSessionSnapshotFallback,
                );
            }
        };
    },
};

contextBridge.exposeInMainWorld("comando", comandoApi);
