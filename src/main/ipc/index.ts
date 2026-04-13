import {
    BrowserWindow,
    dialog,
    ipcMain,
    nativeTheme,
    type OpenDialogOptions,
} from "electron";

import {
    IPC_CHANNELS,
    IPC_EVENTS,
    type AppBootstrapSnapshot,
    type CreateTerminalSessionInput,
    type ListProjectTreeInput,
    type OpenProjectFileInput,
    type PersistenceSnapshot,
    type ResizeTerminalSessionInput,
    type SaveProjectFileInput,
    type SettingsSnapshot,
    type SystemTheme,
    type WriteTerminalInput,
    type WorkspaceSnapshot,
} from "@shared/ipc";

import type { ProjectService } from "@main/projects/service";
import type { PersistenceService } from "@main/persistence/service";
import type { SettingsService } from "@main/settings/service";
import type { TerminalService } from "@main/terminals/service";
import type { WorkspaceService } from "@main/workspace/service";

interface RegisterIpcHandlersOptions {
    readonly getSnapshot: () => AppBootstrapSnapshot;
    readonly persistenceService: PersistenceService;
    readonly projectService: ProjectService;
    readonly settingsService: SettingsService;
    readonly terminalService: TerminalService;
    readonly workspaceService: WorkspaceService;
}

export function registerIpcHandlers(options: RegisterIpcHandlersOptions): void {
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
    ipcMain.removeHandler(IPC_CHANNELS.getWorkspaceSnapshot);
    ipcMain.removeHandler(IPC_CHANNELS.saveWorkspaceSnapshot);
    ipcMain.removeHandler(IPC_CHANNELS.getChatSessionState);
    ipcMain.removeHandler(IPC_CHANNELS.createTerminalSession);
    ipcMain.removeHandler(IPC_CHANNELS.writeTerminalInput);
    ipcMain.removeHandler(IPC_CHANNELS.resizeTerminalSession);
    ipcMain.removeHandler(IPC_CHANNELS.closeTerminalSession);

    ipcMain.handle(IPC_CHANNELS.getBootstrapSnapshot, () =>
        options.getSnapshot(),
    );
    ipcMain.handle(
        IPC_CHANNELS.getPersistenceSnapshot,
        (): PersistenceSnapshot => options.persistenceService.loadSnapshot(),
    );
    ipcMain.handle(
        IPC_CHANNELS.getSettingsSnapshot,
        (): SettingsSnapshot => options.settingsService.loadSnapshot(),
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
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.saveActiveProjectId,
        (_event, projectId: string | null) => {
            options.persistenceService.saveActiveProjectId(projectId);
        },
    );

    nativeTheme.on("updated", () => {
        const theme: SystemTheme = {
            isDark: nativeTheme.shouldUseDarkColors,
        };

        for (const window of BrowserWindow.getAllWindows()) {
            window.webContents.send(IPC_EVENTS.themeUpdated, theme);
        }
    });
    ipcMain.handle(IPC_CHANNELS.listProjects, () =>
        options.projectService.listProjects(),
    );
    ipcMain.handle(IPC_CHANNELS.openProjects, async (event) => {
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
            return options.projectService.listProjects();
        }

        return options.projectService.addProjectPaths(result.filePaths);
    });
    ipcMain.handle(IPC_CHANNELS.addProjectPaths, (_event, paths: string[]) =>
        options.projectService.addProjectPaths(paths),
    );
    ipcMain.handle(IPC_CHANNELS.removeProject, (_event, projectId: string) => {
        options.projectService.removeProject(projectId);
    });
    ipcMain.handle(IPC_CHANNELS.touchProject, (_event, projectId: string) => {
        options.projectService.touchProject(projectId);
    });
    ipcMain.handle(
        IPC_CHANNELS.listProjectTree,
        (_event, input: ListProjectTreeInput) =>
            options.projectService.listProjectTreeChildren(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.openProjectFile,
        (_event, input: OpenProjectFileInput) =>
            options.projectService.openProjectFile(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.saveProjectFile,
        (_event, input: SaveProjectFileInput) =>
            options.projectService.saveProjectFile(input),
    );
    ipcMain.handle(IPC_CHANNELS.getWorkspaceSnapshot, () =>
        options.workspaceService.loadSnapshot(),
    );
    ipcMain.handle(
        IPC_CHANNELS.saveWorkspaceSnapshot,
        (_event, snapshot: WorkspaceSnapshot) => {
            options.workspaceService.saveSnapshot(snapshot);
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.getChatSessionState,
        (_event, sessionId: string) =>
            options.workspaceService.loadChatSessionState(sessionId),
    );
    ipcMain.handle(
        IPC_CHANNELS.createTerminalSession,
        (_event, input: CreateTerminalSessionInput) =>
            options.terminalService.createSession(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.writeTerminalInput,
        (_event, input: WriteTerminalInput) => {
            options.terminalService.writeInput(input.sessionId, input.data);
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.resizeTerminalSession,
        (_event, input: ResizeTerminalSessionInput) => {
            options.terminalService.resizeSession(
                input.sessionId,
                input.cols,
                input.rows,
            );
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.closeTerminalSession,
        (_event, sessionId: string) => {
            options.terminalService.closeSession(sessionId);
        },
    );
}
