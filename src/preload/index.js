import { contextBridge, ipcRenderer } from "electron";
import { IPC_EVENTS, IPC_CHANNELS, } from "@shared/ipc";
const comandoApi = {
    getBootstrapSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.getBootstrapSnapshot),
    getPersistenceSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.getPersistenceSnapshot),
    getSettingsSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.getSettingsSnapshot),
    getSystemTheme: () => ipcRenderer.invoke(IPC_CHANNELS.getSystemTheme),
    getWorkspaceSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.getWorkspaceSnapshot),
    createTerminalSession: (input) => ipcRenderer.invoke(IPC_CHANNELS.createTerminalSession, input),
    addProjectPaths: (paths) => ipcRenderer.invoke(IPC_CHANNELS.addProjectPaths, paths),
    listProjects: () => ipcRenderer.invoke(IPC_CHANNELS.listProjects),
    onProjectTreeInvalidated: (listener) => {
        const handleEvent = (_event, payload) => {
            listener(payload);
        };
        ipcRenderer.on(IPC_EVENTS.projectTreeInvalidated, handleEvent);
        return () => {
            ipcRenderer.removeListener(IPC_EVENTS.projectTreeInvalidated, handleEvent);
        };
    },
    onThemeUpdated: (listener) => {
        const handleEvent = (_event, theme) => {
            listener(theme);
        };
        ipcRenderer.on(IPC_EVENTS.themeUpdated, handleEvent);
        return () => {
            ipcRenderer.removeListener(IPC_EVENTS.themeUpdated, handleEvent);
        };
    },
    onTerminalData: (listener) => {
        const handleEvent = (_event, payload) => {
            listener(payload);
        };
        ipcRenderer.on(IPC_EVENTS.terminalData, handleEvent);
        return () => {
            ipcRenderer.removeListener(IPC_EVENTS.terminalData, handleEvent);
        };
    },
    onTerminalExit: (listener) => {
        const handleEvent = (_event, payload) => {
            listener(payload);
        };
        ipcRenderer.on(IPC_EVENTS.terminalExit, handleEvent);
        return () => {
            ipcRenderer.removeListener(IPC_EVENTS.terminalExit, handleEvent);
        };
    },
    openProjectFile: (input) => ipcRenderer.invoke(IPC_CHANNELS.openProjectFile, input),
    openProjects: () => ipcRenderer.invoke(IPC_CHANNELS.openProjects),
    saveProjectFile: (input) => ipcRenderer.invoke(IPC_CHANNELS.saveProjectFile, input),
    createProjectEntry: (input) => ipcRenderer.invoke(IPC_CHANNELS.createProjectEntry, input),
    renameProjectEntry: (input) => ipcRenderer.invoke(IPC_CHANNELS.renameProjectEntry, input),
    deleteProjectEntry: (input) => ipcRenderer.invoke(IPC_CHANNELS.deleteProjectEntry, input),
    revealProjectEntry: (input) => ipcRenderer.invoke(IPC_CHANNELS.revealProjectEntry, input),
    saveSettingsSnapshot: (snapshot) => ipcRenderer.invoke(IPC_CHANNELS.saveSettingsSnapshot, snapshot),
    saveActiveProjectId: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.saveActiveProjectId, projectId),
    listProjectTree: (input) => ipcRenderer.invoke(IPC_CHANNELS.listProjectTree, input),
    searchProjectEntries: (input) => ipcRenderer.invoke(IPC_CHANNELS.searchProjectEntries, input),
    removeProject: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.removeProject, projectId),
    resizeTerminalSession: (input) => ipcRenderer.invoke(IPC_CHANNELS.resizeTerminalSession, input),
    saveWorkspaceSnapshot: (snapshot) => ipcRenderer.invoke(IPC_CHANNELS.saveWorkspaceSnapshot, snapshot),
    getChatSessionState: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.getChatSessionState, sessionId),
    getAiRuntimeStatus: (runtimeId) => ipcRenderer.invoke(IPC_CHANNELS.getAiRuntimeStatus, runtimeId),
    getAiSessionSnapshot: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.getAiSessionSnapshot, sessionId),
    sendAiPrompt: (input) => ipcRenderer.invoke(IPC_CHANNELS.sendAiPrompt, input),
    cancelAiSession: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.cancelAiSession, sessionId),
    closeAiSession: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.closeAiSession, sessionId),
    respondAiPermission: (input) => ipcRenderer.invoke(IPC_CHANNELS.respondAiPermission, input),
    keepAiTrackedFile: (input) => ipcRenderer.invoke(IPC_CHANNELS.keepAiTrackedFile, input),
    rejectAiTrackedFile: (input) => ipcRenderer.invoke(IPC_CHANNELS.rejectAiTrackedFile, input),
    keepAllAiTrackedFiles: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.keepAllAiTrackedFiles, sessionId),
    rejectAllAiTrackedFiles: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.rejectAllAiTrackedFiles, sessionId),
    saveCodexRuntimeSettings: (settings) => ipcRenderer.invoke(IPC_CHANNELS.saveCodexRuntimeSettings, settings),
    closeTerminalSession: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.closeTerminalSession, sessionId),
    touchProject: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.touchProject, projectId),
    writeTerminalInput: (input) => ipcRenderer.invoke(IPC_CHANNELS.writeTerminalInput, input),
    onAiRuntimeStatus: (listener) => {
        const handleEvent = (_event, status) => {
            listener(status);
        };
        ipcRenderer.on(IPC_EVENTS.aiRuntimeStatus, handleEvent);
        return () => {
            ipcRenderer.removeListener(IPC_EVENTS.aiRuntimeStatus, handleEvent);
        };
    },
    onAiSessionSnapshot: (listener) => {
        const handleEvent = (_event, snapshot) => {
            listener(snapshot);
        };
        ipcRenderer.on(IPC_EVENTS.aiSessionSnapshot, handleEvent);
        return () => {
            ipcRenderer.removeListener(IPC_EVENTS.aiSessionSnapshot, handleEvent);
        };
    },
};
contextBridge.exposeInMainWorld("comando", comandoApi);
