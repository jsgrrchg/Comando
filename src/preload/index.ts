/// <reference lib="dom" />

import { contextBridge, ipcRenderer, webUtils } from "electron";

import { deliverAiSessionStreamMessage } from "./ai-session-stream";
import {
    IPC_CHANNELS,
    IPC_EVENTS,
    type ProjectAddResult,
    type AppPrivacyAccessState,
    type AppUpdateState,
    type AppBootstrapSnapshot,
    type AiHistorySessionSummary,
    type AiPromptQueueSnapshot,
    type AiQueuedPromptMutationInput,
    type AiSessionDomainEvent,
    type AiSessionStreamAckMessage,
    type AiSessionUpdate,
    type AiPermissionResponseInput,
    type AiRuntimeAuthDisconnectInput,
    type AiRuntimeAuthLaunchInput,
    type AiRuntimeAuthLogoutInput,
    type AiEnvironmentDiagnostics,
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
    type ClearProjectAppDataInput,
    type ClearProjectAppDataResult,
    type CloneRepositoryInput,
    type CloneRepositoryResult,
    type ComandoApi,
    type CheckCommandAvailabilityInput,
    type CheckCommandAvailabilityResult,
    type CodexRuntimeSettingsInput,
    type CopyExternalProjectEntriesInput,
    type CopyExternalProjectEntriesResult,
    type CopyProjectEntriesInput,
    type CopyProjectEntriesResult,
    type CreateProjectEntryInput,
    type CreateTerminalSessionInput,
    type DeleteProjectEntryInput,
    type FileBufferNotificationInput,
    type EnqueueAiPromptInput,
    type GetAiSessionTranscriptPageInput,
    type ListAiSessionHistoryInput,
    type ListProjectTreeInput,
    type OpenProjectWindowInput,
    type OpenProjectEntryExternallyInput,
    type OpenProjectFileInput,
    type OpenSettingsWindowInput,
    type SettingsWindowCategory,
    type AiSessionSnapshot,
    type PersistenceSnapshot,
    type PrepareAiSessionInput,
    type ProjectSettingsSnapshot,
    type ProjectSettingsUpdatedEvent,
    type ReadClaudeCodeTranscriptInput,
    type ReadClaudeCodeTranscriptResult,
    type ProjectAppDataSummary,
    type ProjectRelocateResult,
    type ProjectSummary,
    type ProjectTreeInvalidation,
    type ThemeMode,
    type WindowContextSnapshot,
    type GitBranchListInput,
    type GitBranchSummary,
    type GitChangesListInput,
    type GitChangeEntry,
    type GitCheckoutBranchInput,
    type GitCommitDetail,
    type GitCommitDetailInput,
    type GitCommitInput,
    type GitCommitResult,
    type GitCreateBranchInput,
    type GitCreateWorktreeInput,
    type GitDeleteLocalBranchInput,
    type GitDeleteRemoteBranchInput,
    type GitDiscardPathsInput,
    type GitDiffInput,
    type GitFileDiff,
    type GitFetchInput,
    type GitWorktreeDiffInput,
    type GitWorktreeDiffResult,
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
    type GitHubCreateReleaseInput,
    type GitHubGeneratedReleaseNotes,
    type GitHubGenerateReleaseNotesInput,
    type GitHubPublishReleaseInput,
    type GitHubReleaseSummary,
    type GitHubRequestPullRequestReviewInput,
    type GitHubSaveTokenInput,
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
    type GitHistoryListResult,
    type GitOriginalFile,
    type GitOriginalFileInput,
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
    type GrokRuntimeSettingsInput,
    type KiloRuntimeSettingsInput,
    type ListProjectEntriesInput,
    type OpenCodeRuntimeSettingsInput,
    type RenameProjectEntryInput,
    type RevealProjectEntryInput,
    type ResizeTerminalSessionInput,
    type SearchProjectEntriesInput,
    type SaveProjectFileInput,
    type UpdateAiQueuedPromptInput,
    type SettingsSnapshot,
    type SettingsUpdatedEvent,
    type SystemTheme,
    type TerminalDataEvent,
    type TerminalExitEvent,
    type TrashProjectEntryInput,
    type TsconfigResolutionSnapshot,
    type WriteTerminalInput,
    type PersistedWorkspaceSnapshot,
    type WorkspaceNavigationSnapshot,
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

function assertCommandAvailabilityResult(
    channel: string,
    value: unknown,
): CheckCommandAvailabilityResult {
    const result = assertIpcObject<Partial<CheckCommandAvailabilityResult>>(
        channel,
        value,
    );
    if (typeof result.found !== "boolean") {
        throw new Error(
            `IPC contract violation on "${channel}": expected found to be boolean.`,
        );
    }
    if (result.path !== null && typeof result.path !== "string") {
        throw new Error(
            `IPC contract violation on "${channel}": expected path to be string or null.`,
        );
    }
    return {
        found: result.found,
        path: result.path,
    };
}

function assertClaudeCodeTranscriptResult(
    channel: string,
    value: unknown,
): ReadClaudeCodeTranscriptResult {
    const result = assertIpcObject<Partial<ReadClaudeCodeTranscriptResult>>(
        channel,
        value,
    );
    if (typeof result.found !== "boolean") {
        throw new Error(
            `IPC contract violation on "${channel}": expected found to be boolean.`,
        );
    }
    if (typeof result.changed !== "boolean") {
        throw new Error(
            `IPC contract violation on "${channel}": expected changed to be boolean.`,
        );
    }
    if (result.mtimeMs !== null && typeof result.mtimeMs !== "number") {
        throw new Error(
            `IPC contract violation on "${channel}": expected mtimeMs to be number or null.`,
        );
    }
    if (result.title !== null && typeof result.title !== "string") {
        throw new Error(
            `IPC contract violation on "${channel}": expected title to be string or null.`,
        );
    }
    if (result.preview !== null && typeof result.preview !== "string") {
        throw new Error(
            `IPC contract violation on "${channel}": expected preview to be string or null.`,
        );
    }
    return {
        changed: result.changed,
        found: result.found,
        mtimeMs: result.mtimeMs,
        preview: result.preview,
        title: result.title,
    };
}

const aiSessionSnapshotListeners = new Set<(update: AiSessionUpdate) => void>();
const aiSessionEventListeners = new Set<(event: AiSessionDomainEvent) => void>();
const aiPromptQueueListeners = new Set<
    (snapshot: AiPromptQueueSnapshot) => void
>();
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

function isAiSessionDomainEvent(value: unknown): value is AiSessionDomainEvent {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const candidate = value as {
        readonly kind?: unknown;
        readonly runtimeId?: unknown;
        readonly sessionId?: unknown;
    };

    return (
        typeof candidate.kind === "string" &&
        candidate.kind !== "patch" &&
        candidate.kind !== "snapshot" &&
        typeof candidate.runtimeId === "string" &&
        typeof candidate.sessionId === "string"
    );
}

function notifyAiSessionSnapshotListeners(update: unknown): void {
    if (!isAiSessionUpdate(update)) {
        console.warn(
            "[comando] Dropped AiSessionUpdate with unexpected shape.",
        );
        return;
    }
    for (const listener of aiSessionSnapshotListeners) {
        try {
            listener(update);
        } catch (error) {
            console.error("[comando] AiSessionUpdate listener failed.", error);
        }
    }
}

function notifyAiSessionEventListeners(event: unknown): void {
    if (!isAiSessionDomainEvent(event)) {
        console.warn(
            "[comando] Dropped AiSessionDomainEvent with unexpected shape.",
        );
        return;
    }
    for (const listener of aiSessionEventListeners) {
        try {
            listener(event);
        } catch (error) {
            console.error(
                "[comando] AiSessionDomainEvent listener failed.",
                error,
            );
        }
    }
}

function notifyAiSessionStreamPayload(payload: unknown): void {
    if (isAiSessionUpdate(payload)) {
        notifyAiSessionSnapshotListeners(payload);
        return;
    }

    if (isAiSessionDomainEvent(payload)) {
        notifyAiSessionEventListeners(payload);
        return;
    }

    console.warn("[comando] Dropped AI session stream payload.");
}

function acknowledgeAiSessionStreamPort(seq: number): void {
    const port = aiSessionSnapshotPort;
    if (!port) {
        return;
    }

    const message: AiSessionStreamAckMessage = {
        seq,
        type: "ack",
    };
    port.postMessage(message);
}

function notifyAiSessionStreamListeners(message: unknown): void {
    deliverAiSessionStreamMessage(message, {
        acknowledge: acknowledgeAiSessionStreamPort,
        notifyPayload: notifyAiSessionStreamPayload,
        reportDispatchError: (logMessage, error) => {
            console.error(logMessage, error);
        },
        reportWarning: (logMessage, error) => {
            if (error === undefined) {
                console.warn(logMessage);
                return;
            }
            console.warn(logMessage, error);
        },
    });
}

function bindAiSessionSnapshotPort(port: MessagePort): void {
    aiSessionSnapshotPort?.close();
    aiSessionSnapshotPort = port;
    aiSessionSnapshotPort.onmessage = (event) => {
        notifyAiSessionStreamListeners(event.data);
    };
    aiSessionSnapshotPort.start();
}

function handleAiSessionSnapshotFallback(
    _event: Electron.IpcRendererEvent,
    update: unknown,
): void {
    notifyAiSessionSnapshotListeners(update);
}

function handleAiSessionEventFallback(
    _event: Electron.IpcRendererEvent,
    event: unknown,
): void {
    notifyAiSessionEventListeners(event);
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
    readClipboardText: () => ipcRenderer.invoke(IPC_CHANNELS.readClipboardText),
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
    writeClipboardText: (text: string) =>
        ipcRenderer.invoke(IPC_CHANNELS.writeClipboardText, text),
    openExternalUrl: (url: string) =>
        ipcRenderer.invoke(IPC_CHANNELS.openExternalUrl, url),
    openGeneratedImage: (path: string) =>
        ipcRenderer.invoke(IPC_CHANNELS.openGeneratedImage, path),
    revealGeneratedImage: (path: string) =>
        ipcRenderer.invoke(IPC_CHANNELS.revealGeneratedImage, path),
    openProjectWindow: (input: OpenProjectWindowInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.openProjectWindow, input),
    checkCommandAvailability: async (input: CheckCommandAvailabilityInput) =>
        assertCommandAvailabilityResult(
            IPC_CHANNELS.checkCommandAvailability,
            await ipcRenderer.invoke(IPC_CHANNELS.checkCommandAvailability, input),
        ),
    readClaudeCodeTranscript: async (input: ReadClaudeCodeTranscriptInput) =>
        assertClaudeCodeTranscriptResult(
            IPC_CHANNELS.readClaudeCodeTranscript,
            await ipcRenderer.invoke(
                IPC_CHANNELS.readClaudeCodeTranscript,
                input,
            ),
        ),
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
        assertIpcObject<PersistedWorkspaceSnapshot>(
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
    clearProjectAppData: async (input: ClearProjectAppDataInput) =>
        assertIpcObject<ClearProjectAppDataResult>(
            IPC_CHANNELS.clearProjectAppData,
            await ipcRenderer.invoke(IPC_CHANNELS.clearProjectAppData, input),
        ),
    getProjectAppDataSummary: async (projectId: string) =>
        assertIpcObject<ProjectAppDataSummary>(
            IPC_CHANNELS.getProjectAppDataSummary,
            await ipcRenderer.invoke(
                IPC_CHANNELS.getProjectAppDataSummary,
                projectId,
            ),
        ),
    listProjects: async () =>
        assertIpcArray<ProjectSummary>(
            IPC_CHANNELS.listProjects,
            await ipcRenderer.invoke(IPC_CHANNELS.listProjects),
        ),
    relocateProject: async (projectId: string) =>
        assertIpcObject<ProjectRelocateResult>(
            IPC_CHANNELS.relocateProject,
            await ipcRenderer.invoke(IPC_CHANNELS.relocateProject, projectId),
        ),
    onProjectAppDataCleared: (listener) => {
        const handleEvent = (
            _event: Electron.IpcRendererEvent,
            projectId: string,
        ) => {
            listener(projectId);
        };

        ipcRenderer.on(IPC_EVENTS.projectAppDataCleared, handleEvent);

        return () => {
            ipcRenderer.removeListener(
                IPC_EVENTS.projectAppDataCleared,
                handleEvent,
            );
        };
    },
    onProjectsUpdated: (listener) => {
        const handleEvent = (
            _event: Electron.IpcRendererEvent,
            projects: readonly ProjectSummary[],
        ) => {
            listener(projects);
        };

        ipcRenderer.on(IPC_EVENTS.projectsUpdated, handleEvent);

        return () => {
            ipcRenderer.removeListener(IPC_EVENTS.projectsUpdated, handleEvent);
        };
    },
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
    onSettingsCategoryRequested: (listener) => {
        const handleEvent = (
            _event: Electron.IpcRendererEvent,
            category: SettingsWindowCategory,
        ) => {
            listener(category);
        };

        ipcRenderer.on(IPC_EVENTS.settingsCategoryRequested, handleEvent);

        return () => {
            ipcRenderer.removeListener(
                IPC_EVENTS.settingsCategoryRequested,
                handleEvent,
            );
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
    onGitHubAuthUpdated: (listener) => {
        const handleEvent = (
            _event: Electron.IpcRendererEvent,
            payload: GitHubAuthStatus,
        ) => {
            listener(payload);
        };

        ipcRenderer.on(IPC_EVENTS.githubAuthUpdated, handleEvent);

        return () => {
            ipcRenderer.removeListener(IPC_EVENTS.githubAuthUpdated, handleEvent);
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
    onWorkspaceFlushRequested: (listener) => {
        const handleEvent = (
            _event: Electron.IpcRendererEvent,
            requestId: string,
        ) => {
            void Promise.resolve()
                .then(listener)
                .then(() => {
                    ipcRenderer.send(
                        IPC_EVENTS.workspaceFlushAcknowledged,
                        requestId,
                    );
                })
                .catch(() => undefined);
        };

        ipcRenderer.on(IPC_EVENTS.workspaceFlushRequested, handleEvent);
        return () => {
            ipcRenderer.removeListener(
                IPC_EVENTS.workspaceFlushRequested,
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
    cloneRepository: async (input: CloneRepositoryInput) =>
        assertIpcObject<CloneRepositoryResult>(
            IPC_CHANNELS.cloneRepository,
            await ipcRenderer.invoke(IPC_CHANNELS.cloneRepository, input),
        ),
    saveProjectFile: (input: SaveProjectFileInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.saveProjectFile, input),
    createProjectEntry: (input: CreateProjectEntryInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.createProjectEntry, input),
    copyProjectEntries: async (input: CopyProjectEntriesInput) =>
        assertIpcObject<CopyProjectEntriesResult>(
            IPC_CHANNELS.copyProjectEntries,
            await ipcRenderer.invoke(IPC_CHANNELS.copyProjectEntries, input),
        ),
    copyExternalProjectEntries: async (
        input: CopyExternalProjectEntriesInput,
    ) =>
        assertIpcObject<CopyExternalProjectEntriesResult>(
            IPC_CHANNELS.copyExternalProjectEntries,
            await ipcRenderer.invoke(
                IPC_CHANNELS.copyExternalProjectEntries,
                input,
            ),
        ),
    renameProjectEntry: (input: RenameProjectEntryInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.renameProjectEntry, input),
    deleteProjectEntry: (input: DeleteProjectEntryInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.deleteProjectEntry, input),
    trashProjectEntry: (input: TrashProjectEntryInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.trashProjectEntry, input),
    openProjectEntryExternally: (input: OpenProjectEntryExternallyInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.openProjectEntryExternally, input),
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
    resolveTsconfigForPath: async (filePath: string) =>
        assertIpcObject<TsconfigResolutionSnapshot>(
            IPC_CHANNELS.resolveTsconfigForPath,
            await ipcRenderer.invoke(
                IPC_CHANNELS.resolveTsconfigForPath,
                filePath,
            ),
        ),
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
        assertIpcObject<GitHistoryListResult>(
            IPC_CHANNELS.listGitHistory,
            await ipcRenderer.invoke(IPC_CHANNELS.listGitHistory, input),
        ),
    getGitDiff: (input: GitDiffInput) =>
        ipcRenderer.invoke(
            IPC_CHANNELS.getGitDiff,
            input,
        ) as Promise<GitFileDiff | null>,
    getGitOriginalFile: (input: GitOriginalFileInput) =>
        ipcRenderer.invoke(
            IPC_CHANNELS.getGitOriginalFile,
            input,
        ) as Promise<GitOriginalFile | null>,
    listGitWorktreeDiff: (input: GitWorktreeDiffInput) =>
        ipcRenderer.invoke(
            IPC_CHANNELS.listGitWorktreeDiff,
            input,
        ) as Promise<GitWorktreeDiffResult | null>,
    getGitCommitDetail: (input: GitCommitDetailInput) =>
        ipcRenderer.invoke(
            IPC_CHANNELS.getGitCommitDetail,
            input,
        ) as Promise<GitCommitDetail | null>,
    initGitRepository: (input: GitRepositoryScopeInput) =>
        ipcRenderer.invoke(
            IPC_CHANNELS.initGitRepository,
            input,
        ) as Promise<GitRepositorySnapshot>,
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
    createGitBranch: (input: GitCreateBranchInput) =>
        ipcRenderer.invoke(
            IPC_CHANNELS.createGitBranch,
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
    getGitHubAuthStatus: async (input: GitHubAuthStatusInput) =>
        assertIpcObject<GitHubAuthStatus>(
            IPC_CHANNELS.getGitHubAuthStatus,
            await ipcRenderer.invoke(IPC_CHANNELS.getGitHubAuthStatus, input),
        ),
    saveGitHubToken: async (input: GitHubSaveTokenInput) =>
        assertIpcObject<GitHubAuthStatus>(
            IPC_CHANNELS.saveGitHubToken,
            await ipcRenderer.invoke(IPC_CHANNELS.saveGitHubToken, input),
        ),
    clearGitHubToken: async (input: GitHubClearTokenInput) =>
        assertIpcObject<GitHubAuthStatus>(
            IPC_CHANNELS.clearGitHubToken,
            await ipcRenderer.invoke(IPC_CHANNELS.clearGitHubToken, input),
        ),
    listGitHubIssues: async (input: GitHubListIssuesInput) =>
        assertIpcObject<GitHubListIssuesResult>(
            IPC_CHANNELS.listGitHubIssues,
            await ipcRenderer.invoke(IPC_CHANNELS.listGitHubIssues, input),
        ),
    getGitHubIssue: async (input: GitHubGetIssueInput) =>
        assertIpcObjectOrNull<GitHubIssueDetail>(
            IPC_CHANNELS.getGitHubIssue,
            await ipcRenderer.invoke(IPC_CHANNELS.getGitHubIssue, input),
        ),
    createGitHubIssue: async (input: GitHubCreateIssueInput) =>
        assertIpcObject<GitHubIssueDetail>(
            IPC_CHANNELS.createGitHubIssue,
            await ipcRenderer.invoke(IPC_CHANNELS.createGitHubIssue, input),
        ),
    updateGitHubIssue: async (input: GitHubUpdateIssueInput) =>
        assertIpcObject<GitHubIssueDetail>(
            IPC_CHANNELS.updateGitHubIssue,
            await ipcRenderer.invoke(IPC_CHANNELS.updateGitHubIssue, input),
        ),
    commentGitHubIssue: async (input: GitHubCommentIssueInput) =>
        assertIpcObject<GitHubCommentSummary>(
            IPC_CHANNELS.commentGitHubIssue,
            await ipcRenderer.invoke(IPC_CHANNELS.commentGitHubIssue, input),
        ),
    updateGitHubComment: async (input: GitHubUpdateCommentInput) =>
        assertIpcObject<GitHubCommentSummary>(
            IPC_CHANNELS.updateGitHubComment,
            await ipcRenderer.invoke(IPC_CHANNELS.updateGitHubComment, input),
        ),
    closeGitHubIssue: async (input: GitHubSetIssueStateInput) =>
        assertIpcObject<GitHubIssueDetail>(
            IPC_CHANNELS.closeGitHubIssue,
            await ipcRenderer.invoke(IPC_CHANNELS.closeGitHubIssue, input),
        ),
    reopenGitHubIssue: async (input: GitHubSetIssueStateInput) =>
        assertIpcObject<GitHubIssueDetail>(
            IPC_CHANNELS.reopenGitHubIssue,
            await ipcRenderer.invoke(IPC_CHANNELS.reopenGitHubIssue, input),
        ),
    listGitHubPullRequests: async (input: GitHubListPullRequestsInput) =>
        assertIpcObject<GitHubListPullRequestsResult>(
            IPC_CHANNELS.listGitHubPullRequests,
            await ipcRenderer.invoke(
                IPC_CHANNELS.listGitHubPullRequests,
                input,
            ),
        ),
    getGitHubPullRequest: async (input: GitHubGetPullRequestInput) =>
        assertIpcObjectOrNull<GitHubPullRequestDetail>(
            IPC_CHANNELS.getGitHubPullRequest,
            await ipcRenderer.invoke(IPC_CHANNELS.getGitHubPullRequest, input),
        ),
    listGitHubPullRequestChecks: async (
        input: GitHubPullRequestChecksInput,
    ) =>
        assertIpcObject<GitHubPullRequestChecksResult>(
            IPC_CHANNELS.listGitHubPullRequestChecks,
            await ipcRenderer.invoke(
                IPC_CHANNELS.listGitHubPullRequestChecks,
                input,
            ),
        ),
    createGitHubPullRequest: async (input: GitHubCreatePullRequestInput) =>
        assertIpcObject<GitHubPullRequestDetail>(
            IPC_CHANNELS.createGitHubPullRequest,
            await ipcRenderer.invoke(
                IPC_CHANNELS.createGitHubPullRequest,
                input,
            ),
        ),
    updateGitHubPullRequest: async (input: GitHubUpdatePullRequestInput) =>
        assertIpcObject<GitHubPullRequestDetail>(
            IPC_CHANNELS.updateGitHubPullRequest,
            await ipcRenderer.invoke(
                IPC_CHANNELS.updateGitHubPullRequest,
                input,
            ),
        ),
    commentGitHubPullRequest: async (input: GitHubCommentPullRequestInput) =>
        assertIpcObject<GitHubCommentSummary>(
            IPC_CHANNELS.commentGitHubPullRequest,
            await ipcRenderer.invoke(
                IPC_CHANNELS.commentGitHubPullRequest,
                input,
            ),
        ),
    markGitHubPullRequestReady: async (
        input: GitHubSetPullRequestDraftStateInput,
    ) =>
        assertIpcObject<GitHubPullRequestDetail>(
            IPC_CHANNELS.markGitHubPullRequestReady,
            await ipcRenderer.invoke(
                IPC_CHANNELS.markGitHubPullRequestReady,
                input,
            ),
        ),
    convertGitHubPullRequestToDraft: async (
        input: GitHubSetPullRequestDraftStateInput,
    ) =>
        assertIpcObject<GitHubPullRequestDetail>(
            IPC_CHANNELS.convertGitHubPullRequestToDraft,
            await ipcRenderer.invoke(
                IPC_CHANNELS.convertGitHubPullRequestToDraft,
                input,
            ),
        ),
    requestGitHubPullRequestReviewers: async (
        input: GitHubRequestPullRequestReviewInput,
    ) =>
        assertIpcObject<GitHubPullRequestDetail>(
            IPC_CHANNELS.requestGitHubPullRequestReviewers,
            await ipcRenderer.invoke(
                IPC_CHANNELS.requestGitHubPullRequestReviewers,
                input,
            ),
        ),
    listGitHubWorkflowRuns: async (input: GitHubWorkflowRunsInput) =>
        assertIpcObject<GitHubWorkflowRunsResult>(
            IPC_CHANNELS.listGitHubWorkflowRuns,
            await ipcRenderer.invoke(IPC_CHANNELS.listGitHubWorkflowRuns, input),
        ),
    listGitHubWorkflowRunJobs: async (input: GitHubWorkflowRunJobsInput) =>
        assertIpcObject<GitHubWorkflowRunJobsResult>(
            IPC_CHANNELS.listGitHubWorkflowRunJobs,
            await ipcRenderer.invoke(
                IPC_CHANNELS.listGitHubWorkflowRunJobs,
                input,
            ),
        ),
    getGitHubWorkflowJobLogs: async (input: GitHubWorkflowJobLogsInput) =>
        assertIpcObject<GitHubWorkflowJobLogsResult>(
            IPC_CHANNELS.getGitHubWorkflowJobLogs,
            await ipcRenderer.invoke(
                IPC_CHANNELS.getGitHubWorkflowJobLogs,
                input,
            ),
        ),
    listGitHubWorkflowRunArtifacts: async (
        input: GitHubWorkflowRunArtifactsInput,
    ) =>
        assertIpcObject<GitHubWorkflowRunArtifactsResult>(
            IPC_CHANNELS.listGitHubWorkflowRunArtifacts,
            await ipcRenderer.invoke(
                IPC_CHANNELS.listGitHubWorkflowRunArtifacts,
                input,
            ),
        ),
    listGitHubCheckRunAnnotations: async (
        input: GitHubCheckRunAnnotationsInput,
    ) =>
        assertIpcObject<GitHubCheckRunAnnotationsResult>(
            IPC_CHANNELS.listGitHubCheckRunAnnotations,
            await ipcRenderer.invoke(
                IPC_CHANNELS.listGitHubCheckRunAnnotations,
                input,
            ),
        ),
    rerunGitHubWorkflowRunFailedJobs: (input: GitHubWorkflowRunMutationInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.rerunGitHubWorkflowRunFailedJobs, input),
    cancelGitHubWorkflowRun: (input: GitHubWorkflowRunMutationInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.cancelGitHubWorkflowRun, input),
    listGitHubNotifications: async (input: GitHubNotificationsInput) =>
        assertIpcObject<GitHubNotificationsResult>(
            IPC_CHANNELS.listGitHubNotifications,
            await ipcRenderer.invoke(IPC_CHANNELS.listGitHubNotifications, input),
        ),
    listGitHubReleases: async (input: GitHubListReleasesInput) =>
        assertIpcObject<GitHubListReleasesResult>(
            IPC_CHANNELS.listGitHubReleases,
            await ipcRenderer.invoke(IPC_CHANNELS.listGitHubReleases, input),
        ),
    generateGitHubReleaseNotes: async (
        input: GitHubGenerateReleaseNotesInput,
    ) =>
        assertIpcObject<GitHubGeneratedReleaseNotes>(
            IPC_CHANNELS.generateGitHubReleaseNotes,
            await ipcRenderer.invoke(
                IPC_CHANNELS.generateGitHubReleaseNotes,
                input,
            ),
        ),
    createGitHubRelease: async (input: GitHubCreateReleaseInput) =>
        assertIpcObject<GitHubReleaseSummary>(
            IPC_CHANNELS.createGitHubRelease,
            await ipcRenderer.invoke(IPC_CHANNELS.createGitHubRelease, input),
        ),
    publishGitHubRelease: async (input: GitHubPublishReleaseInput) =>
        assertIpcObject<GitHubReleaseSummary>(
            IPC_CHANNELS.publishGitHubRelease,
            await ipcRenderer.invoke(IPC_CHANNELS.publishGitHubRelease, input),
        ),
    listGitHubLabels: async (input: GitHubListLabelsInput) =>
        assertIpcObject<GitHubListLabelsResult>(
            IPC_CHANNELS.listGitHubLabels,
            await ipcRenderer.invoke(IPC_CHANNELS.listGitHubLabels, input),
        ),
    listGitHubMilestones: async (input: GitHubListMilestonesInput) =>
        assertIpcObject<GitHubListMilestonesResult>(
            IPC_CHANNELS.listGitHubMilestones,
            await ipcRenderer.invoke(IPC_CHANNELS.listGitHubMilestones, input),
        ),
    listProjectTree: (input: ListProjectTreeInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.listProjectTree, input),
    listProjectEntries: (input: ListProjectEntriesInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.listProjectEntries, input),
    searchProjectEntries: (input: SearchProjectEntriesInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.searchProjectEntries, input),
    removeProject: (projectId: string) =>
        ipcRenderer.invoke(IPC_CHANNELS.removeProject, projectId),
    resizeTerminalSession: (input: ResizeTerminalSessionInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.resizeTerminalSession, input),
    saveWorkspaceSnapshot: (snapshot: WorkspaceNavigationSnapshot) =>
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
    getAiEnvironmentDiagnostics: async () =>
        assertIpcObject<AiEnvironmentDiagnostics>(
            IPC_CHANNELS.getAiEnvironmentDiagnostics,
            await ipcRenderer.invoke(IPC_CHANNELS.getAiEnvironmentDiagnostics),
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
    resyncAiSession: async (sessionId: string) =>
        assertIpcObjectOrNull<AiSessionSnapshot>(
            IPC_CHANNELS.resyncAiSession,
            await ipcRenderer.invoke(IPC_CHANNELS.resyncAiSession, sessionId),
        ),
    getAiSessionTranscriptPage: (input: GetAiSessionTranscriptPageInput) =>
        ipcRenderer.invoke(
            IPC_CHANNELS.getAiSessionTranscriptPage,
            input,
        ) as Promise<AiSessionTranscriptPage>,
    getAiPromptQueue: (sessionId: string) =>
        ipcRenderer.invoke(
            IPC_CHANNELS.getAiPromptQueue,
            sessionId,
        ) as Promise<AiPromptQueueSnapshot>,
    enqueueAiPrompt: (input: EnqueueAiPromptInput) =>
        ipcRenderer.invoke(
            IPC_CHANNELS.enqueueAiPrompt,
            input,
        ) as Promise<AiPromptQueueSnapshot>,
    removeAiQueuedPrompt: (input: AiQueuedPromptMutationInput) =>
        ipcRenderer.invoke(
            IPC_CHANNELS.removeAiQueuedPrompt,
            input,
        ) as Promise<AiPromptQueueSnapshot>,
    clearAiPromptQueue: (sessionId: string) =>
        ipcRenderer.invoke(
            IPC_CHANNELS.clearAiPromptQueue,
            sessionId,
        ) as Promise<AiPromptQueueSnapshot>,
    beginEditAiQueuedPrompt: (input: AiQueuedPromptMutationInput) =>
        ipcRenderer.invoke(
            IPC_CHANNELS.beginEditAiQueuedPrompt,
            input,
        ) as Promise<AiPromptQueueSnapshot>,
    cancelEditAiQueuedPrompt: (sessionId: string) =>
        ipcRenderer.invoke(
            IPC_CHANNELS.cancelEditAiQueuedPrompt,
            sessionId,
        ) as Promise<AiPromptQueueSnapshot>,
    updateAiQueuedPrompt: (input: UpdateAiQueuedPromptInput) =>
        ipcRenderer.invoke(
            IPC_CHANNELS.updateAiQueuedPrompt,
            input,
        ) as Promise<AiPromptQueueSnapshot>,
    steerAiQueuedPrompt: (input: AiQueuedPromptMutationInput) =>
        ipcRenderer.invoke(
            IPC_CHANNELS.steerAiQueuedPrompt,
            input,
        ) as Promise<AiPromptQueueSnapshot>,
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
    disconnectAiRuntimeAuth: (input: AiRuntimeAuthDisconnectInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.disconnectAiRuntimeAuth, input),
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
    saveGrokRuntimeSettings: (settings: GrokRuntimeSettingsInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.saveGrokRuntimeSettings, settings),
    saveKiloRuntimeSettings: (settings: KiloRuntimeSettingsInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.saveKiloRuntimeSettings, settings),
    saveOpenCodeRuntimeSettings: (settings: OpenCodeRuntimeSettingsInput) =>
        ipcRenderer.invoke(
            IPC_CHANNELS.saveOpenCodeRuntimeSettings,
            settings,
        ),
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
    onAiSessionEvent: (listener) => {
        if (aiSessionEventListeners.size === 0) {
            ipcRenderer.on(
                IPC_EVENTS.aiSessionEvent,
                handleAiSessionEventFallback,
            );
        }

        aiSessionEventListeners.add(listener);

        return () => {
            aiSessionEventListeners.delete(listener);

            if (aiSessionEventListeners.size === 0) {
                ipcRenderer.removeListener(
                    IPC_EVENTS.aiSessionEvent,
                    handleAiSessionEventFallback,
                );
            }
        };
    },
    onAiPromptQueue: (listener) => {
        const handleEvent = (
            _event: Electron.IpcRendererEvent,
            snapshot: AiPromptQueueSnapshot,
        ) => {
            listener(snapshot);
        };
        aiPromptQueueListeners.add(listener);
        ipcRenderer.on(IPC_EVENTS.aiPromptQueue, handleEvent);
        return () => {
            aiPromptQueueListeners.delete(listener);
            ipcRenderer.removeListener(IPC_EVENTS.aiPromptQueue, handleEvent);
        };
    },
};

contextBridge.exposeInMainWorld("comando", comandoApi);
