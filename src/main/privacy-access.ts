import os from "node:os";
import path from "node:path";

import { shell } from "electron";

import {
    IPC_EVENTS,
    type AppPrivacyAccessState,
} from "@shared/ipc";

import { forEachLiveWindow } from "./window";

const MACOS_FULL_DISK_ACCESS_SETTINGS_URL =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";
const PROTECTED_HOME_SUBDIRECTORIES = [
    "Desktop",
    "Documents",
    "Downloads",
    path.join("Library", "Application Support", "AddressBook"),
    path.join("Library", "Calendars"),
    path.join("Library", "Mail"),
    path.join("Library", "Messages"),
    path.join("Library", "Photos"),
    path.join("Library", "Safari"),
];

let appPrivacyAccessState: AppPrivacyAccessState = createInitialState();

export function getAppPrivacyAccessState(): AppPrivacyAccessState {
    return appPrivacyAccessState;
}

export function recordFilesystemAccessFailure(
    attemptedPath: string,
    error: unknown,
): void {
    if (
        process.platform !== "darwin" ||
        !isMacOsPrivacyPermissionDeniedError(error) ||
        !isLikelyProtectedMacOsPath(attemptedPath)
    ) {
        return;
    }

    updateAppPrivacyAccessState({
        lastDeniedPath: attemptedPath,
        lastUpdatedAt: createTimestamp(),
        message:
            "macOS blocked Comando from reading a protected folder. Grant Full Disk Access if you want the app to work reliably with projects in Documents, Desktop, Downloads, and other protected locations.",
        status: "attention-needed",
    });
}

export function recordFilesystemAccessSuccess(absolutePath: string): void {
    if (
        process.platform !== "darwin" ||
        appPrivacyAccessState.status !== "attention-needed" ||
        !isLikelyProtectedMacOsPath(absolutePath)
    ) {
        return;
    }

    updateAppPrivacyAccessState({
        lastDeniedPath: null,
        lastUpdatedAt: createTimestamp(),
        message:
            "Comando can currently access the protected folders you opened successfully.",
        status: "monitoring",
    });
}

export async function openMacOsFullDiskAccessSettings(): Promise<void> {
    if (process.platform !== "darwin") {
        return;
    }

    await shell.openExternal(MACOS_FULL_DISK_ACCESS_SETTINGS_URL);
}

export function isMacOsPrivacyPermissionDeniedError(error: unknown): boolean {
    if (!(error instanceof Error)) {
        return false;
    }

    const withCode = error as Error & { readonly code?: unknown };
    return withCode.code === "EACCES" || withCode.code === "EPERM";
}

export function isLikelyProtectedMacOsPath(absolutePath: string): boolean {
    if (process.platform !== "darwin") {
        return false;
    }

    const normalizedPath = path.resolve(absolutePath);
    const homeDirectory = path.resolve(os.homedir());
    if (
        normalizedPath !== homeDirectory &&
        !normalizedPath.startsWith(`${homeDirectory}${path.sep}`)
    ) {
        return false;
    }

    return PROTECTED_HOME_SUBDIRECTORIES.some((relativeDirectory) => {
        const protectedPath = path.join(homeDirectory, relativeDirectory);
        return (
            normalizedPath === protectedPath ||
            normalizedPath.startsWith(`${protectedPath}${path.sep}`)
        );
    });
}

function createInitialState(): AppPrivacyAccessState {
    if (process.platform !== "darwin") {
        return {
            canOpenFullDiskAccessSettings: false,
            lastDeniedPath: null,
            lastUpdatedAt: null,
            message:
                "macOS-only privacy guidance is not applicable on this platform.",
            status: "not-applicable",
        };
    }

    return {
        canOpenFullDiskAccessSettings: true,
        lastDeniedPath: null,
        lastUpdatedAt: null,
        message:
            "Comando will warn you here if macOS blocks access to a protected folder.",
        status: "monitoring",
    };
}

function updateAppPrivacyAccessState(
    patch: Partial<AppPrivacyAccessState>,
): void {
    appPrivacyAccessState = {
        ...appPrivacyAccessState,
        ...patch,
    };
    broadcastAppPrivacyAccessState(appPrivacyAccessState);
}

function broadcastAppPrivacyAccessState(payload: AppPrivacyAccessState): void {
    forEachLiveWindow((window) => {
        window.webContents.send(IPC_EVENTS.appPrivacyAccessState, payload);
    });
}

function createTimestamp(): string {
    return new Date().toISOString();
}
