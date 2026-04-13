import { app, BrowserWindow } from "electron";

import { appIdentity } from "@shared/app-identity";
import {
    IPC_EVENTS,
    type AppBootstrapSnapshot,
    type ProjectTreeInvalidation,
    type TerminalDataEvent,
    type TerminalExitEvent,
} from "@shared/ipc";

import { bootstrapDatabase, type DatabaseManager } from "./db";
import { ProjectService } from "./projects/service";
import { registerIpcHandlers } from "./ipc";
import { PersistenceService } from "./persistence/service";
import { SettingsService } from "./settings/service";
import { TerminalService } from "./terminals/service";
import { WorkspaceService } from "./workspace/service";
import { createMainWindow } from "./window";

let database: DatabaseManager | null = null;
let bootstrapSnapshot: AppBootstrapSnapshot | null = null;
let persistenceService: PersistenceService | null = null;
let projectService: ProjectService | null = null;
let settingsService: SettingsService | null = null;
let terminalService: TerminalService | null = null;
let workspaceService: WorkspaceService | null = null;

void app.whenReady().then(() => {
    database = bootstrapDatabase({
        dataDir: app.getPath("userData"),
    });
    persistenceService = new PersistenceService(database.connection);
    settingsService = new SettingsService(database.connection);
    projectService = new ProjectService({
        connection: database.connection,
        onProjectTreeInvalidated: broadcastProjectTreeInvalidation,
    });
    terminalService = new TerminalService({
        onData: broadcastTerminalData,
        onExit: broadcastTerminalExit,
        projectService,
    });
    workspaceService = new WorkspaceService(database.connection);

    bootstrapSnapshot = {
        app: appIdentity,
        database: database.status,
        platform: process.platform,
        startedAt: new Date().toISOString(),
        versions: {
            chrome: process.versions.chrome,
            electron: process.versions.electron,
            node: process.versions.node,
        },
    };

    registerIpcHandlers({
        getSnapshot: () => {
            if (!bootstrapSnapshot) {
                throw new Error(
                    "The initial bootstrap snapshot is not available yet.",
                );
            }

            return bootstrapSnapshot;
        },
        persistenceService,
        projectService,
        settingsService,
        terminalService,
        workspaceService,
    });

    const mainWindow = createMainWindow(
        persistenceService.loadSnapshot().windowState,
    );
    attachWindowPersistence(mainWindow);

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createMainWindow();
        }
    });
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        app.quit();
    }
});

app.on("before-quit", () => {
    projectService?.close();
    projectService = null;
    terminalService?.close();
    terminalService = null;
    persistenceService = null;
    settingsService = null;
    workspaceService = null;
    database?.close();
    database = null;
});

function broadcastProjectTreeInvalidation(
    payload: ProjectTreeInvalidation,
): void {
    for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(IPC_EVENTS.projectTreeInvalidated, payload);
    }
}

function attachWindowPersistence(window: BrowserWindow): void {
    let timeout: NodeJS.Timeout | null = null;

    const persistWindowState = () => {
        if (!persistenceService) {
            return;
        }

        const bounds = window.getBounds();
        persistenceService.saveWindowState({
            height: bounds.height,
            id: "main",
            isFullScreen: window.isFullScreen(),
            isMaximized: window.isMaximized(),
            width: bounds.width,
            x: bounds.x,
            y: bounds.y,
        });
    };

    const schedulePersist = () => {
        if (timeout) {
            clearTimeout(timeout);
        }

        timeout = setTimeout(() => {
            persistWindowState();
            timeout = null;
        }, 140);
    };

    window.on("resize", schedulePersist);
    window.on("move", schedulePersist);
    window.on("maximize", schedulePersist);
    window.on("unmaximize", schedulePersist);
    window.on("enter-full-screen", schedulePersist);
    window.on("leave-full-screen", schedulePersist);
    window.on("close", persistWindowState);

    persistWindowState();
}

function broadcastTerminalData(payload: TerminalDataEvent): void {
    for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(IPC_EVENTS.terminalData, payload);
    }
}

function broadcastTerminalExit(payload: TerminalExitEvent): void {
    for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(IPC_EVENTS.terminalExit, payload);
    }
}
