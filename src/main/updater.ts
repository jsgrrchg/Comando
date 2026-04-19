import { app, BrowserWindow, dialog } from "electron";
import electronUpdater from "electron-updater";
import type { AppChannel } from "@shared/app-identity";
import { IPC_EVENTS, type AppUpdateState } from "@shared/ipc";

import { appIdentity } from "./app-runtime";
import { debugBenignError } from "./observability/logging";
import { resolveAutoUpdateSupportState } from "./updater-config";
import { forEachLiveWindow } from "./window";
import { windowRegistry } from "./windows/registry";

const { autoUpdater } = electronUpdater;

let hasRegisteredAutoUpdateHandlers = false;
let hasPromptedForDownloadedUpdate = false;
let activeCheckForUpdates: Promise<AppUpdateState> | null = null;
let appUpdateState: AppUpdateState = createInitialAppUpdateState();

export function initializeAutoUpdates(options: {
    readonly appChannel: AppChannel;
    readonly isPackaged: boolean;
    readonly platform: NodeJS.Platform;
    readonly resourcesPath: string;
}): void {
    const support = resolveAutoUpdateSupportState(options);

    if (!support.enabled) {
        updateAppUpdateState({
            autoUpdatesEnabled: false,
            availableVersion: null,
            canCheckForUpdates: false,
            canInstallUpdate: false,
            downloadedVersion: null,
            lastCheckedAt: null,
            message: support.message,
            progressPercent: null,
            status: "unsupported",
        });
        return;
    }

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;

    updateAppUpdateState({
        autoUpdatesEnabled: true,
        availableVersion: null,
        canCheckForUpdates: true,
        canInstallUpdate: false,
        downloadedVersion: null,
        lastCheckedAt: null,
        message: support.message,
        progressPercent: null,
        status: "idle",
    });

    registerAutoUpdaterHandlers();
    void checkForAppUpdates();
}

export function getAppUpdateState(): AppUpdateState {
    return appUpdateState;
}

export function checkForAppUpdates(): Promise<AppUpdateState> {
    if (!appUpdateState.canCheckForUpdates) {
        return Promise.resolve(appUpdateState);
    }

    if (activeCheckForUpdates) {
        return activeCheckForUpdates;
    }

    updateAppUpdateState({
        message: "Checking for updates...",
        canCheckForUpdates: false,
        progressPercent: null,
        status: "checking",
    });

    activeCheckForUpdates = autoUpdater
        .checkForUpdates()
        .then(() => appUpdateState)
        .catch((error) => {
            handleAutoUpdaterError(error);
            return appUpdateState;
        })
        .finally(() => {
            activeCheckForUpdates = null;
        });

    return activeCheckForUpdates;
}

export function installAppUpdateAndRestart(): void {
    if (!appUpdateState.canInstallUpdate) {
        return;
    }

    autoUpdater.quitAndInstall();
}

function registerAutoUpdaterHandlers(): void {
    if (hasRegisteredAutoUpdateHandlers) {
        return;
    }

    hasRegisteredAutoUpdateHandlers = true;

    autoUpdater.on("error", (error) => {
        handleAutoUpdaterError(error);
    });

    autoUpdater.on("update-available", (info) => {
        const nextVersion = normalizeVersion(info.version);
        updateAppUpdateState({
            availableVersion: nextVersion,
            canCheckForUpdates: false,
            canInstallUpdate: false,
            downloadedVersion: null,
            lastCheckedAt: createTimestamp(),
            message: nextVersion
                ? `Version ${nextVersion} is available and downloading now.`
                : "A new update is available and downloading now.",
            progressPercent: 0,
            status: "available",
        });
    });

    autoUpdater.on("download-progress", (progress) => {
        const percent = Number.isFinite(progress.percent)
            ? Math.max(0, Math.min(100, progress.percent))
            : null;
        const nextVersion = appUpdateState.availableVersion;

        updateAppUpdateState({
            canCheckForUpdates: false,
            canInstallUpdate: false,
            downloadedVersion: null,
            message:
                percent === null
                    ? "Downloading update..."
                    : nextVersion
                      ? `Downloading version ${nextVersion} (${Math.round(percent)}%).`
                      : `Downloading update (${Math.round(percent)}%).`,
            progressPercent: percent,
            status: "downloading",
        });
    });

    autoUpdater.on("update-not-available", () => {
        updateAppUpdateState({
            availableVersion: null,
            canCheckForUpdates: true,
            canInstallUpdate: false,
            downloadedVersion: null,
            lastCheckedAt: createTimestamp(),
            message: "You're already on the latest version.",
            progressPercent: null,
            status: "not-available",
        });
    });

    autoUpdater.on("update-downloaded", (info) => {
        const nextVersion = normalizeVersion(info.version);
        updateAppUpdateState({
            availableVersion: nextVersion,
            canCheckForUpdates: false,
            canInstallUpdate: true,
            downloadedVersion: nextVersion,
            lastCheckedAt: createTimestamp(),
            message: nextVersion
                ? `Version ${nextVersion} has been downloaded and is ready to install.`
                : "The latest update has been downloaded and is ready to install.",
            progressPercent: 100,
            status: "downloaded",
        });

        if (hasPromptedForDownloadedUpdate) {
            return;
        }

        hasPromptedForDownloadedUpdate = true;
        void promptToRestartForUpdate();
    });
}

function handleAutoUpdaterError(error: unknown): void {
    debugBenignError("autoUpdater", error);

    const message =
        error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "The app could not check for updates.";

    updateAppUpdateState({
        canCheckForUpdates: true,
        canInstallUpdate: false,
        downloadedVersion: null,
        lastCheckedAt: createTimestamp(),
        message,
        progressPercent: null,
        status: "error",
    });
}

async function promptToRestartForUpdate(): Promise<void> {
    const parentWindow = resolveUpdateDialogParentWindow();
    const dialogOptions = {
        buttons: ["Restart and Install", "Later"],
        cancelId: 1,
        defaultId: 0,
        detail:
            "The update has already been downloaded and will also install automatically the next time you quit the app.",
        message: "A new version of Comando is ready to install.",
        noLink: true,
        title: `${appIdentity.name} Update Ready`,
        type: "info" as const,
    };

    try {
        const result = parentWindow
            ? await dialog.showMessageBox(parentWindow, dialogOptions)
            : await dialog.showMessageBox(dialogOptions);

        if (result.response === 0) {
            installAppUpdateAndRestart();
        }
    } catch (error) {
        debugBenignError("autoUpdater.promptToRestart", error);
    }
}

function resolveUpdateDialogParentWindow(): BrowserWindow | null {
    return (
        windowRegistry.getFocusedMainWindow() ??
        windowRegistry.getMostRecentMainWindow() ??
        BrowserWindow.getFocusedWindow()
    );
}

function createInitialAppUpdateState(): AppUpdateState {
    return {
        autoUpdatesEnabled: false,
        availableVersion: null,
        canCheckForUpdates: false,
        canInstallUpdate: false,
        currentVersion: resolveCurrentVersion(),
        downloadedVersion: null,
        lastCheckedAt: null,
        message: "Auto-updates are initializing.",
        progressPercent: null,
        status: "unsupported",
    };
}

function updateAppUpdateState(
    patch: Partial<AppUpdateState>,
): AppUpdateState {
    appUpdateState = {
        ...appUpdateState,
        ...patch,
        currentVersion: resolveCurrentVersion(),
    };

    broadcastAppUpdateState(appUpdateState);
    return appUpdateState;
}

function broadcastAppUpdateState(payload: AppUpdateState): void {
    forEachLiveWindow((window) => {
        window.webContents.send(IPC_EVENTS.appUpdateState, payload);
    });
}

function resolveCurrentVersion(): string {
    try {
        const version = app.getVersion();
        return version.trim().length > 0 ? version : "0.0.0";
    } catch {
        return "0.0.0";
    }
}

function normalizeVersion(version: string | null | undefined): string | null {
    if (typeof version !== "string") {
        return null;
    }

    const trimmed = version.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function createTimestamp(): string {
    return new Date().toISOString();
}
