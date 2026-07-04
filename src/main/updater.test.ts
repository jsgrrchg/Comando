import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    hasPackagedUpdateConfig,
    isLinuxAppImageEnvironment,
    resolvePackagedUpdateConfigPath,
    resolveAutoUpdateSupportState,
    shouldEnableAutoUpdates,
} from "./updater-config";

const temporaryDirectories = new Set<string>();

type MockAutoUpdater = EventEmitter & {
    allowPrerelease: boolean;
    autoDownload: boolean;
    autoInstallOnAppQuit: boolean;
    checkForUpdates: ReturnType<typeof vi.fn>;
    quitAndInstall: ReturnType<typeof vi.fn>;
};

function createMockAutoUpdater(): MockAutoUpdater {
    const autoUpdater = new EventEmitter() as MockAutoUpdater;
    autoUpdater.allowPrerelease = true;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.checkForUpdates = vi.fn().mockResolvedValue(undefined);
    autoUpdater.quitAndInstall = vi.fn();
    return autoUpdater;
}

function createPackagedResourcesPath(): string {
    const resourcesPath = fs.mkdtempSync(
        path.join(os.tmpdir(), "comando-updater-runtime-test-"),
    );
    temporaryDirectories.add(resourcesPath);
    fs.writeFileSync(
        resolvePackagedUpdateConfigPath(resourcesPath),
        "provider: github\n",
        "utf8",
    );
    return resourcesPath;
}

async function importUpdaterWithMocks(options?: {
    readonly autoUpdater?: MockAutoUpdater;
    readonly showMessageBoxResponse?: number;
}) {
    vi.resetModules();

    const autoUpdater = options?.autoUpdater ?? createMockAutoUpdater();
    const sendToWindow = vi.fn();
    const showMessageBox = vi
        .fn()
        .mockResolvedValue({ response: options?.showMessageBoxResponse ?? 1 });
    const getFocusedMainWindow = vi.fn().mockReturnValue(null);
    const getMostRecentMainWindow = vi.fn().mockReturnValue(null);

    vi.doMock("electron", () => ({
        app: {
            getVersion: vi.fn(() => "1.2.3"),
        },
        BrowserWindow: {
            getFocusedWindow: vi.fn(() => null),
        },
        dialog: {
            showMessageBox,
        },
    }));
    vi.doMock("electron-updater", () => ({
        default: {
            autoUpdater,
        },
    }));
    vi.doMock("./window", () => ({
        forEachLiveWindow: vi.fn(
            (
                callback: (window: {
                    webContents: { send: typeof sendToWindow };
                }) => void,
            ) => {
                callback({ webContents: { send: sendToWindow } });
            },
        ),
    }));
    vi.doMock("./windows/registry", () => ({
        windowRegistry: {
            getFocusedMainWindow,
            getMostRecentMainWindow,
        },
    }));

    const updater = await import("./updater");

    return {
        autoUpdater,
        getFocusedMainWindow,
        getMostRecentMainWindow,
        sendToWindow,
        showMessageBox,
        updater,
    };
}

function initializeSupportedAutoUpdates(
    updater: Awaited<ReturnType<typeof importUpdaterWithMocks>>["updater"],
) {
    updater.initializeAutoUpdates({
        appChannel: "release",
        isLinuxAppImage: true,
        isPackaged: true,
        platform: "linux",
        resourcesPath: createPackagedResourcesPath(),
    });
}

beforeEach(() => {
    vi.restoreAllMocks();
});

afterEach(() => {
    for (const directoryPath of temporaryDirectories) {
        fs.rmSync(directoryPath, {
            force: true,
            recursive: true,
        });
    }
    temporaryDirectories.clear();
    vi.resetModules();
    vi.clearAllMocks();
});

describe("shouldEnableAutoUpdates", () => {
    it("requires packaged release builds", () => {
        expect(
            shouldEnableAutoUpdates({
                appChannel: "dev",
                isPackaged: true,
                platform: "darwin",
            }),
        ).toBe(false);

        expect(
            shouldEnableAutoUpdates({
                appChannel: "release",
                isPackaged: false,
                platform: "darwin",
            }),
        ).toBe(false);
    });

    it("supports packaged release builds on macOS, Windows, and Linux AppImage", () => {
        expect(
            shouldEnableAutoUpdates({
                appChannel: "release",
                isPackaged: true,
                platform: "darwin",
            }),
        ).toBe(true);

        expect(
            shouldEnableAutoUpdates({
                appChannel: "release",
                isPackaged: true,
                platform: "win32",
            }),
        ).toBe(true);

        expect(
            shouldEnableAutoUpdates({
                appChannel: "release",
                isLinuxAppImage: true,
                isPackaged: true,
                platform: "linux",
            }),
        ).toBe(true);
    });

    it("skips unsupported platforms and non-AppImage Linux packages", () => {
        expect(
            shouldEnableAutoUpdates({
                appChannel: "release",
                isPackaged: true,
                platform: "linux",
            }),
        ).toBe(false);

        expect(
            shouldEnableAutoUpdates({
                appChannel: "release",
                isLinuxAppImage: false,
                isPackaged: true,
                platform: "linux",
            }),
        ).toBe(false);
    });
});

describe("isLinuxAppImageEnvironment", () => {
    it("detects AppImage runtime environments", () => {
        expect(isLinuxAppImageEnvironment({ APPIMAGE: "/opt/Comando.AppImage" }))
            .toBe(true);
        expect(isLinuxAppImageEnvironment({ APPIMAGE: "   " })).toBe(false);
        expect(isLinuxAppImageEnvironment({})).toBe(false);
    });
});

describe("hasPackagedUpdateConfig", () => {
    it("resolves the packaged updater metadata file", () => {
        expect(resolvePackagedUpdateConfigPath("/tmp/comando")).toBe(
            path.join("/tmp/comando", "app-update.yml"),
        );
    });

    it("detects when the packaged updater metadata exists", () => {
        const resourcesPath = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-updater-test-"),
        );
        temporaryDirectories.add(resourcesPath);

        expect(hasPackagedUpdateConfig(resourcesPath)).toBe(false);

        fs.writeFileSync(
            resolvePackagedUpdateConfigPath(resourcesPath),
            "provider: github\n",
            "utf8",
        );

        expect(hasPackagedUpdateConfig(resourcesPath)).toBe(true);
    });
});

describe("resolveAutoUpdateSupportState", () => {
    it("describes why development builds cannot auto-update", () => {
        expect(
            resolveAutoUpdateSupportState({
                appChannel: "dev",
                isPackaged: false,
                platform: "darwin",
            }),
        ).toEqual({
            enabled: false,
            message:
                "Auto-updates are only available in packaged release builds.",
        });
    });

    it("requires packaged updater metadata when resourcesPath is provided", () => {
        const resourcesPath = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-updater-support-test-"),
        );
        temporaryDirectories.add(resourcesPath);

        expect(
            resolveAutoUpdateSupportState({
                appChannel: "release",
                isLinuxAppImage: true,
                isPackaged: true,
                platform: "linux",
                resourcesPath,
            }),
        ).toEqual({
            enabled: false,
            message:
                "This packaged build does not include updater metadata yet.",
        });

        fs.writeFileSync(
            resolvePackagedUpdateConfigPath(resourcesPath),
            "provider: github\n",
            "utf8",
        );

        expect(
            resolveAutoUpdateSupportState({
                appChannel: "release",
                isLinuxAppImage: true,
                isPackaged: true,
                platform: "linux",
                resourcesPath,
            }),
        ).toEqual({
            enabled: true,
            message:
                "Automatic updates are enabled for this packaged release build.",
        });
    });
});

describe("initializeAutoUpdates", () => {
    it("configures the updater and starts checking in supported builds", async () => {
        const { autoUpdater, updater } = await importUpdaterWithMocks();
        initializeSupportedAutoUpdates(updater);

        expect(autoUpdater.autoDownload).toBe(true);
        expect(autoUpdater.autoInstallOnAppQuit).toBe(true);
        expect(autoUpdater.allowPrerelease).toBe(false);
        expect(autoUpdater.listenerCount("error")).toBe(1);
        expect(autoUpdater.listenerCount("update-available")).toBe(1);
        expect(autoUpdater.listenerCount("download-progress")).toBe(1);
        expect(autoUpdater.listenerCount("update-not-available")).toBe(1);
        expect(autoUpdater.listenerCount("update-downloaded")).toBe(1);
        expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
        expect(updater.getAppUpdateState()).toMatchObject({
            autoUpdatesEnabled: true,
            canCheckForUpdates: false,
            canInstallUpdate: false,
            currentVersion: "1.2.3",
            status: "checking",
        });

        initializeSupportedAutoUpdates(updater);

        expect(autoUpdater.listenerCount("error")).toBe(1);
        expect(autoUpdater.listenerCount("update-available")).toBe(1);
    });

    it("leaves unsupported builds disabled without registering updater handlers", async () => {
        const { autoUpdater, updater } = await importUpdaterWithMocks();

        updater.initializeAutoUpdates({
            appChannel: "dev",
            isPackaged: false,
            platform: "darwin",
            resourcesPath: "/tmp/comando",
        });

        expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
        expect(autoUpdater.eventNames()).toEqual([]);
        expect(updater.getAppUpdateState()).toMatchObject({
            autoUpdatesEnabled: false,
            availableVersion: null,
            canCheckForUpdates: false,
            canInstallUpdate: false,
            downloadedVersion: null,
            lastCheckedAt: null,
            progressPercent: null,
            status: "unsupported",
        });
    });
});

describe("auto updater download events", () => {
    it("marks a discovered update as available and starts progress at zero", async () => {
        const { autoUpdater, updater } = await importUpdaterWithMocks();
        initializeSupportedAutoUpdates(updater);

        autoUpdater.emit("update-available", { version: "2.0.0" });

        expect(updater.getAppUpdateState()).toMatchObject({
            availableVersion: "2.0.0",
            canInstallUpdate: false,
            progressPercent: 0,
            status: "available",
        });
    });

    it("clamps download progress and includes the available version in messages", async () => {
        const { autoUpdater, updater } = await importUpdaterWithMocks();
        initializeSupportedAutoUpdates(updater);

        autoUpdater.emit("update-available", { version: "2.0.0" });
        autoUpdater.emit("download-progress", { percent: -12 });

        expect(updater.getAppUpdateState()).toMatchObject({
            message: "Downloading version 2.0.0 (0%).",
            progressPercent: 0,
            status: "downloading",
        });

        autoUpdater.emit("download-progress", { percent: 175.4 });

        expect(updater.getAppUpdateState()).toMatchObject({
            message: "Downloading version 2.0.0 (100%).",
            progressPercent: 100,
            status: "downloading",
        });
    });

    it("marks downloaded updates installable and prompts for restart", async () => {
        const { autoUpdater, showMessageBox, updater } =
            await importUpdaterWithMocks();
        initializeSupportedAutoUpdates(updater);

        autoUpdater.emit("update-downloaded", { version: "2.0.0" });

        expect(updater.getAppUpdateState()).toMatchObject({
            availableVersion: "2.0.0",
            canInstallUpdate: true,
            downloadedVersion: "2.0.0",
            progressPercent: 100,
            status: "downloaded",
        });
        expect(showMessageBox).toHaveBeenCalledTimes(1);
    });
});

describe("auto updater install and failure paths", () => {
    it("does not install before an update has downloaded", async () => {
        const { autoUpdater, updater } = await importUpdaterWithMocks();
        initializeSupportedAutoUpdates(updater);

        updater.installAppUpdateAndRestart();

        expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    });

    it("installs after an update has downloaded", async () => {
        const { autoUpdater, updater } = await importUpdaterWithMocks();
        initializeSupportedAutoUpdates(updater);

        autoUpdater.emit("update-downloaded", { version: "2.0.0" });
        updater.installAppUpdateAndRestart();

        expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    });

    it("installs when the restart prompt is accepted", async () => {
        const { autoUpdater, updater } = await importUpdaterWithMocks({
            showMessageBoxResponse: 0,
        });
        initializeSupportedAutoUpdates(updater);

        autoUpdater.emit("update-downloaded", { version: "2.0.0" });
        await vi.waitFor(() => {
            expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
        });
    });

    it("keeps the downloaded update pending when the restart prompt is dismissed", async () => {
        const { autoUpdater, showMessageBox, updater } =
            await importUpdaterWithMocks({
                showMessageBoxResponse: 1,
            });
        initializeSupportedAutoUpdates(updater);

        autoUpdater.emit("update-downloaded", { version: "2.0.0" });
        await vi.waitFor(() => {
            expect(showMessageBox).toHaveBeenCalledTimes(1);
        });

        expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    });

    it("stores a recoverable error when update checks fail", async () => {
        const autoUpdater = createMockAutoUpdater();
        autoUpdater.checkForUpdates.mockRejectedValue(
            new Error("GitHub update metadata is unavailable"),
        );
        const { updater } = await importUpdaterWithMocks({ autoUpdater });

        initializeSupportedAutoUpdates(updater);
        await vi.waitFor(() => {
            expect(updater.getAppUpdateState().status).toBe("error");
        });

        expect(updater.getAppUpdateState()).toMatchObject({
            canCheckForUpdates: true,
            message: "GitHub update metadata is unavailable",
            status: "error",
        });
        expect(updater.getAppUpdateState().lastCheckedAt).toEqual(
            expect.any(String),
        );
    });

    it("marks the app current when no update is available", async () => {
        const { autoUpdater, updater } = await importUpdaterWithMocks();
        initializeSupportedAutoUpdates(updater);

        autoUpdater.emit("update-available", { version: "2.0.0" });
        autoUpdater.emit("update-not-available");

        expect(updater.getAppUpdateState()).toMatchObject({
            availableVersion: null,
            canCheckForUpdates: true,
            message: "You're already on the latest version.",
            status: "not-available",
        });
    });
});
