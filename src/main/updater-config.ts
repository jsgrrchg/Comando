import fs from "node:fs";
import path from "node:path";

import type { AppChannel } from "@shared/app-identity";

const PACKAGED_UPDATE_CONFIG_FILE = "app-update.yml";

export interface AutoUpdateSupportState {
    readonly enabled: boolean;
    readonly message: string;
}

export function shouldEnableAutoUpdates(options: {
    readonly appChannel: AppChannel;
    readonly isLinuxAppImage?: boolean;
    readonly isPackaged: boolean;
    readonly platform: NodeJS.Platform;
}): boolean {
    if (!options.isPackaged || options.appChannel !== "release") {
        return false;
    }

    if (options.platform === "darwin" || options.platform === "win32") {
        return true;
    }

    return options.platform === "linux" && options.isLinuxAppImage === true;
}

export function resolvePackagedUpdateConfigPath(resourcesPath: string): string {
    return path.join(resourcesPath, PACKAGED_UPDATE_CONFIG_FILE);
}

export function hasPackagedUpdateConfig(resourcesPath: string): boolean {
    return fs.existsSync(resolvePackagedUpdateConfigPath(resourcesPath));
}

export function resolveAutoUpdateSupportState(options: {
    readonly appChannel: AppChannel;
    readonly isLinuxAppImage?: boolean;
    readonly isPackaged: boolean;
    readonly platform: NodeJS.Platform;
    readonly resourcesPath?: string | null;
}): AutoUpdateSupportState {
    if (!options.isPackaged) {
        return {
            enabled: false,
            message:
                "Auto-updates are only available in packaged release builds.",
        };
    }

    if (options.appChannel !== "release") {
        return {
            enabled: false,
            message: "Auto-updates are disabled on the dev channel.",
        };
    }

    if (!shouldEnableAutoUpdates(options)) {
        return {
            enabled: false,
            message:
                "Auto-updates are currently supported on macOS, Windows, and Linux AppImage release builds.",
        };
    }

    if (
        options.resourcesPath &&
        !hasPackagedUpdateConfig(options.resourcesPath)
    ) {
        return {
            enabled: false,
            message:
                "This packaged build does not include updater metadata yet.",
        };
    }

    return {
        enabled: true,
        message:
            "Automatic updates are enabled for this packaged release build.",
    };
}

export function isLinuxAppImageEnvironment(
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    return typeof env.APPIMAGE === "string" && env.APPIMAGE.trim().length > 0;
}
