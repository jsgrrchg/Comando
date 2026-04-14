import { contextBridge, ipcRenderer } from "electron";

import {
    IPC_EVENTS,
    IPC_CHANNELS,
    type AppBootstrapSnapshot,
    type AiPermissionResponseInput,
    type AiRuntimeId,
    type AiRuntimeStatus,
    type AiSessionSnapshot,
    type AiTrackedFileHunkMutationInput,
    type AiTrackedFileMutationInput,
    type AiUserInputResponseInput,
    type ComandoApi,
    type CodexRuntimeSettings,
    type CreateProjectEntryInput,
    type CreateTerminalSessionInput,
    type DeleteProjectEntryInput,
    type ListProjectTreeInput,
    type OpenProjectFileInput,
    type PersistenceSnapshot,
    type ProjectTreeInvalidation,
    type RenameProjectEntryInput,
    type RevealProjectEntryInput,
    type ResizeTerminalSessionInput,
    type SearchProjectEntriesInput,
    type SaveProjectFileInput,
    type SendAiPromptInput,
    type SettingsSnapshot,
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
    getSettingsSnapshot: () =>
        ipcRenderer.invoke(
            IPC_CHANNELS.getSettingsSnapshot,
        ) as Promise<SettingsSnapshot>,
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
    saveActiveProjectId: (projectId: string | null) =>
        ipcRenderer.invoke(IPC_CHANNELS.saveActiveProjectId, projectId),
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
    getAiSessionSnapshot: (sessionId: string) =>
        ipcRenderer.invoke(IPC_CHANNELS.getAiSessionSnapshot, sessionId),
    sendAiPrompt: (input: SendAiPromptInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.sendAiPrompt, input),
    cancelAiSession: (sessionId: string) =>
        ipcRenderer.invoke(IPC_CHANNELS.cancelAiSession, sessionId),
    closeAiSession: (sessionId: string) =>
        ipcRenderer.invoke(IPC_CHANNELS.closeAiSession, sessionId),
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
