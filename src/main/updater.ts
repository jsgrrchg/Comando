import { BrowserWindow, dialog } from "electron";
import { autoUpdater } from "electron-updater";
import type { AppChannel } from "@shared/app-identity";

import { appIdentity } from "./app-runtime";
import { debugBenignError } from "./observability/logging";
import {
    hasPackagedUpdateConfig,
    shouldEnableAutoUpdates,
} from "./updater-config";
import { windowRegistry } from "./windows/registry";

let hasRegisteredAutoUpdateHandlers = false;
let hasPromptedForDownloadedUpdate = false;

export function initializeAutoUpdates(options: {
    readonly appChannel: AppChannel;
    readonly isPackaged: boolean;
    readonly platform: NodeJS.Platform;
    readonly resourcesPath: string;
}): void {
    if (!shouldEnableAutoUpdates(options)) {
        return;
    }

    if (!hasPackagedUpdateConfig(options.resourcesPath)) {
        return;
    }

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;

    if (!hasRegisteredAutoUpdateHandlers) {
        hasRegisteredAutoUpdateHandlers = true;

        autoUpdater.on("error", (error) => {
            debugBenignError("autoUpdater", error);
        });

        autoUpdater.on("update-downloaded", () => {
            if (hasPromptedForDownloadedUpdate) {
                return;
            }

            hasPromptedForDownloadedUpdate = true;
            void promptToRestartForUpdate();
        });
    }

    void autoUpdater.checkForUpdates().catch((error) => {
        debugBenignError("autoUpdater.checkForUpdates", error);
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
            autoUpdater.quitAndInstall();
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
