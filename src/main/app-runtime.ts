import fs from "node:fs";
import path from "node:path";

import { app } from "electron";

import {
    resolveAppChannel,
    resolveAppIdentity,
    type AppChannel,
    type AppIdentity,
} from "@shared/app-identity";

export const appChannel: AppChannel = resolveAppChannel({
    envChannel: process.env.COMANDO_APP_CHANNEL ?? null,
    isPackaged: typeof app?.isPackaged === "boolean" ? app.isPackaged : true,
});

export const appIdentity: AppIdentity = resolveAppIdentity(appChannel);

export function configureMainProcessApp(): void {
    if (
        !app ||
        typeof app.getPath !== "function" ||
        typeof app.setName !== "function" ||
        typeof app.setPath !== "function"
    ) {
        return;
    }

    app.setName(appIdentity.name);

    if (appChannel === "release") {
        return;
    }

    const userDataPath = path.join(app.getPath("appData"), appIdentity.name);
    const sessionDataPath = path.join(userDataPath, "session-data");

    fs.mkdirSync(userDataPath, { recursive: true });
    fs.mkdirSync(sessionDataPath, { recursive: true });

    app.setPath("userData", userDataPath);
    app.setPath("sessionData", sessionDataPath);
}
