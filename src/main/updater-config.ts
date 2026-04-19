import fs from "node:fs";
import path from "node:path";

import type { AppChannel } from "@shared/app-identity";

const PACKAGED_UPDATE_CONFIG_FILE = "app-update.yml";

export function shouldEnableAutoUpdates(options: {
    readonly appChannel: AppChannel;
    readonly isPackaged: boolean;
    readonly platform: NodeJS.Platform;
}): boolean {
    if (!options.isPackaged || options.appChannel !== "release") {
        return false;
    }

    return options.platform === "darwin" || options.platform === "win32";
}

export function resolvePackagedUpdateConfigPath(resourcesPath: string): string {
    return path.join(resourcesPath, PACKAGED_UPDATE_CONFIG_FILE);
}

export function hasPackagedUpdateConfig(resourcesPath: string): boolean {
    return fs.existsSync(resolvePackagedUpdateConfigPath(resourcesPath));
}
