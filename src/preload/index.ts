import { contextBridge, ipcRenderer } from "electron";

import {
    IPC_EVENTS,
    IPC_CHANNELS,
    type AppBootstrapSnapshot,
    type ComandoApi,
    type CreateTerminalSessionInput,
    type ListProjectTreeInput,
    type OpenProjectFileInput,
    type PersistedShellState,
    type PersistenceSnapshot,
    type ProjectTreeInvalidation,
    type ResizeTerminalSessionInput,
    type SaveProjectFileInput,
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
    saveShellState: (state: PersistedShellState) =>
        ipcRenderer.invoke(IPC_CHANNELS.saveShellState, state),
    saveActiveProjectId: (projectId: string | null) =>
        ipcRenderer.invoke(IPC_CHANNELS.saveActiveProjectId, projectId),
    listProjectTree: (input: ListProjectTreeInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.listProjectTree, input),
    removeProject: (projectId: string) =>
        ipcRenderer.invoke(IPC_CHANNELS.removeProject, projectId),
    resizeTerminalSession: (input: ResizeTerminalSessionInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.resizeTerminalSession, input),
    saveWorkspaceSnapshot: (snapshot: WorkspaceSnapshot) =>
        ipcRenderer.invoke(IPC_CHANNELS.saveWorkspaceSnapshot, snapshot),
    getChatSessionState: (sessionId: string) =>
        ipcRenderer.invoke(IPC_CHANNELS.getChatSessionState, sessionId),
    closeTerminalSession: (sessionId: string) =>
        ipcRenderer.invoke(IPC_CHANNELS.closeTerminalSession, sessionId),
    touchProject: (projectId: string) =>
        ipcRenderer.invoke(IPC_CHANNELS.touchProject, projectId),
    writeTerminalInput: (input: WriteTerminalInput) =>
        ipcRenderer.invoke(IPC_CHANNELS.writeTerminalInput, input),
};

contextBridge.exposeInMainWorld("comando", comandoApi);
