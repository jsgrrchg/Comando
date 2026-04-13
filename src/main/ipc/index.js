import { BrowserWindow, dialog, ipcMain, nativeTheme, shell, } from "electron";
import { IPC_CHANNELS, IPC_EVENTS, } from "@shared/ipc";
export function registerIpcHandlers(options) {
    ipcMain.removeHandler(IPC_CHANNELS.getBootstrapSnapshot);
    ipcMain.removeHandler(IPC_CHANNELS.getPersistenceSnapshot);
    ipcMain.removeHandler(IPC_CHANNELS.getSettingsSnapshot);
    ipcMain.removeHandler(IPC_CHANNELS.getSystemTheme);
    ipcMain.removeHandler(IPC_CHANNELS.saveSettingsSnapshot);
    ipcMain.removeHandler(IPC_CHANNELS.saveActiveProjectId);
    ipcMain.removeHandler(IPC_CHANNELS.listProjects);
    ipcMain.removeHandler(IPC_CHANNELS.openProjects);
    ipcMain.removeHandler(IPC_CHANNELS.addProjectPaths);
    ipcMain.removeHandler(IPC_CHANNELS.removeProject);
    ipcMain.removeHandler(IPC_CHANNELS.touchProject);
    ipcMain.removeHandler(IPC_CHANNELS.listProjectTree);
    ipcMain.removeHandler(IPC_CHANNELS.openProjectFile);
    ipcMain.removeHandler(IPC_CHANNELS.saveProjectFile);
    ipcMain.removeHandler(IPC_CHANNELS.createProjectEntry);
    ipcMain.removeHandler(IPC_CHANNELS.renameProjectEntry);
    ipcMain.removeHandler(IPC_CHANNELS.deleteProjectEntry);
    ipcMain.removeHandler(IPC_CHANNELS.revealProjectEntry);
    ipcMain.removeHandler(IPC_CHANNELS.searchProjectEntries);
    ipcMain.removeHandler(IPC_CHANNELS.getWorkspaceSnapshot);
    ipcMain.removeHandler(IPC_CHANNELS.saveWorkspaceSnapshot);
    ipcMain.removeHandler(IPC_CHANNELS.getChatSessionState);
    ipcMain.removeHandler(IPC_CHANNELS.createTerminalSession);
    ipcMain.removeHandler(IPC_CHANNELS.writeTerminalInput);
    ipcMain.removeHandler(IPC_CHANNELS.resizeTerminalSession);
    ipcMain.removeHandler(IPC_CHANNELS.closeTerminalSession);
    ipcMain.removeHandler(IPC_CHANNELS.getAiRuntimeStatus);
    ipcMain.removeHandler(IPC_CHANNELS.getAiSessionSnapshot);
    ipcMain.removeHandler(IPC_CHANNELS.sendAiPrompt);
    ipcMain.removeHandler(IPC_CHANNELS.cancelAiSession);
    ipcMain.removeHandler(IPC_CHANNELS.closeAiSession);
    ipcMain.removeHandler(IPC_CHANNELS.respondAiPermission);
    ipcMain.removeHandler(IPC_CHANNELS.keepAiTrackedFile);
    ipcMain.removeHandler(IPC_CHANNELS.rejectAiTrackedFile);
    ipcMain.removeHandler(IPC_CHANNELS.keepAllAiTrackedFiles);
    ipcMain.removeHandler(IPC_CHANNELS.rejectAllAiTrackedFiles);
    ipcMain.removeHandler(IPC_CHANNELS.saveCodexRuntimeSettings);
    ipcMain.handle(IPC_CHANNELS.getBootstrapSnapshot, () => options.getSnapshot());
    ipcMain.handle(IPC_CHANNELS.getPersistenceSnapshot, () => options.persistenceService.loadSnapshot());
    ipcMain.handle(IPC_CHANNELS.getSettingsSnapshot, () => options.settingsService.loadSnapshot());
    ipcMain.handle(IPC_CHANNELS.getSystemTheme, () => ({
        isDark: nativeTheme.shouldUseDarkColors,
    }));
    ipcMain.handle(IPC_CHANNELS.saveSettingsSnapshot, (_event, snapshot) => {
        options.settingsService.saveSnapshot(snapshot);
    });
    ipcMain.handle(IPC_CHANNELS.saveActiveProjectId, (_event, projectId) => {
        options.persistenceService.saveActiveProjectId(projectId);
    });
    nativeTheme.on("updated", () => {
        const theme = {
            isDark: nativeTheme.shouldUseDarkColors,
        };
        for (const window of BrowserWindow.getAllWindows()) {
            window.webContents.send(IPC_EVENTS.themeUpdated, theme);
        }
    });
    ipcMain.handle(IPC_CHANNELS.listProjects, () => options.projectService.listProjects());
    ipcMain.handle(IPC_CHANNELS.openProjects, async (event) => {
        const ownerWindow = BrowserWindow.fromWebContents(event.sender) ??
            BrowserWindow.getFocusedWindow();
        const dialogOptions = {
            buttonLabel: "Add Project",
            message: "Choose one or more folders to add to the workspace.",
            properties: ["multiSelections", "openDirectory"],
            title: "Add projects",
        };
        const result = ownerWindow
            ? await dialog.showOpenDialog(ownerWindow, dialogOptions)
            : await dialog.showOpenDialog(dialogOptions);
        if (result.canceled || result.filePaths.length === 0) {
            return options.projectService.listProjects();
        }
        return options.projectService.addProjectPaths(result.filePaths);
    });
    ipcMain.handle(IPC_CHANNELS.addProjectPaths, (_event, paths) => options.projectService.addProjectPaths(paths));
    ipcMain.handle(IPC_CHANNELS.removeProject, (_event, projectId) => {
        options.projectService.removeProject(projectId);
    });
    ipcMain.handle(IPC_CHANNELS.touchProject, (_event, projectId) => {
        options.projectService.touchProject(projectId);
    });
    ipcMain.handle(IPC_CHANNELS.listProjectTree, (_event, input) => options.projectService.listProjectTreeChildren(input));
    ipcMain.handle(IPC_CHANNELS.openProjectFile, (_event, input) => options.projectService.openProjectFile(input));
    ipcMain.handle(IPC_CHANNELS.saveProjectFile, (_event, input) => options.projectService.saveProjectFile(input));
    ipcMain.handle(IPC_CHANNELS.createProjectEntry, (_event, input) => options.projectService.createProjectEntry(input));
    ipcMain.handle(IPC_CHANNELS.renameProjectEntry, (_event, input) => options.projectService.renameProjectEntry(input));
    ipcMain.handle(IPC_CHANNELS.deleteProjectEntry, (_event, input) => {
        return options.projectService.deleteProjectEntry(input);
    });
    ipcMain.handle(IPC_CHANNELS.revealProjectEntry, (_event, input) => {
        const absolutePath = options.projectService.resolveProjectEntryPath(input.projectId, input.relativePath);
        shell.showItemInFolder(absolutePath);
    });
    ipcMain.handle(IPC_CHANNELS.searchProjectEntries, (_event, input) => options.projectService.searchProjectEntries(input));
    ipcMain.handle(IPC_CHANNELS.getWorkspaceSnapshot, () => options.workspaceService.loadSnapshot());
    ipcMain.handle(IPC_CHANNELS.saveWorkspaceSnapshot, (_event, snapshot) => {
        options.workspaceService.saveSnapshot(snapshot);
    });
    ipcMain.handle(IPC_CHANNELS.getChatSessionState, (_event, sessionId) => options.workspaceService.loadChatSessionState(sessionId));
    ipcMain.handle(IPC_CHANNELS.createTerminalSession, (_event, input) => options.terminalService.createSession(input));
    ipcMain.handle(IPC_CHANNELS.writeTerminalInput, (_event, input) => {
        options.terminalService.writeInput(input.sessionId, input.data);
    });
    ipcMain.handle(IPC_CHANNELS.resizeTerminalSession, (_event, input) => {
        options.terminalService.resizeSession(input.sessionId, input.cols, input.rows);
    });
    ipcMain.handle(IPC_CHANNELS.closeTerminalSession, (_event, sessionId) => {
        options.terminalService.closeSession(sessionId);
    });
    ipcMain.handle(IPC_CHANNELS.getAiRuntimeStatus, (_event, runtimeId) => options.aiService.getRuntimeStatus(runtimeId));
    ipcMain.handle(IPC_CHANNELS.getAiSessionSnapshot, (_event, sessionId) => options.aiService.getSessionSnapshot(sessionId));
    ipcMain.handle(IPC_CHANNELS.sendAiPrompt, (_event, input) => options.aiService.sendPrompt(input));
    ipcMain.handle(IPC_CHANNELS.cancelAiSession, (_event, sessionId) => options.aiService.cancelSession(sessionId));
    ipcMain.handle(IPC_CHANNELS.closeAiSession, (_event, sessionId) => options.aiService.closeSession(sessionId));
    ipcMain.handle(IPC_CHANNELS.respondAiPermission, (_event, input) => options.aiService.respondPermission(input));
    ipcMain.handle(IPC_CHANNELS.keepAiTrackedFile, (_event, input) => options.aiService.keepTrackedFile(input));
    ipcMain.handle(IPC_CHANNELS.rejectAiTrackedFile, (_event, input) => options.aiService.rejectTrackedFile(input));
    ipcMain.handle(IPC_CHANNELS.keepAllAiTrackedFiles, (_event, sessionId) => options.aiService.keepAllTrackedFiles(sessionId));
    ipcMain.handle(IPC_CHANNELS.rejectAllAiTrackedFiles, (_event, sessionId) => options.aiService.rejectAllTrackedFiles(sessionId));
    ipcMain.handle(IPC_CHANNELS.saveCodexRuntimeSettings, (_event, settings) => options.aiService.saveCodexRuntimeSettings(settings));
}
