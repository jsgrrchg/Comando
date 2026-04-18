import { Menu, app, shell, type MenuItemConstructorOptions } from "electron";

import type { WindowContextSnapshot } from "@shared/ipc";

import { appIdentity } from "./app-runtime";

interface InstallApplicationMenuOptions {
    readonly adjustAppZoom: (
        direction: "decrease" | "increase" | "reset",
    ) => void;
    readonly closeFocusedWindowSurface: () => void;
    readonly focusProjectWindow: (projectId: string) => boolean;
    readonly getFocusedMainWindowContext: () => WindowContextSnapshot | null;
    readonly openNewMainWindow: (
        projectId?: string | null,
    ) => Promise<void> | void;
    readonly reopenLastClosedTab: () => void;
    readonly openSettingsWindow: (
        projectId: string | null,
    ) => Promise<void> | void;
}

export function installApplicationMenu(
    options: InstallApplicationMenuOptions,
): void {
    const template = buildMenuTemplate(options);
    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);

    if (process.platform === "darwin" && app.dock) {
        app.dock.setMenu(
            Menu.buildFromTemplate([
                {
                    click: () => {
                        void options.openNewMainWindow(null);
                    },
                    label: "New Window",
                },
                {
                    click: () => {
                        const context = options.getFocusedMainWindowContext();
                        void options.openSettingsWindow(
                            context?.projectId ?? null,
                        );
                    },
                    label: "Settings",
                },
            ]),
        );
    }
}

function buildMenuTemplate(
    options: InstallApplicationMenuOptions,
): MenuItemConstructorOptions[] {
    const isMac = process.platform === "darwin";
    const fileMenu: MenuItemConstructorOptions = {
        label: "File",
        submenu: [
            {
                accelerator: "CmdOrCtrl+Alt+Shift+N",
                click: () => {
                    void options.openNewMainWindow(null);
                },
                label: "New Window",
            },
            {
                accelerator: "CmdOrCtrl+Alt+N",
                click: () => {
                    const context = options.getFocusedMainWindowContext();
                    const projectId = context?.projectId ?? null;
                    if (!projectId) {
                        void options.openNewMainWindow(null);
                        return;
                    }

                    if (!options.focusProjectWindow(projectId)) {
                        void options.openNewMainWindow(projectId);
                    }
                },
                label: "Open Current Project In New Window",
            },
            { type: "separator" },
            {
                accelerator: "CmdOrCtrl+,",
                click: () => {
                    const context = options.getFocusedMainWindowContext();
                    void options.openSettingsWindow(context?.projectId ?? null);
                },
                label: "Settings",
            },
            { type: "separator" },
            {
                accelerator: "CmdOrCtrl+Shift+T",
                click: () => {
                    options.reopenLastClosedTab();
                },
                label: "Reopen Closed Tab",
            },
            isMac
                ? {
                      accelerator: "CmdOrCtrl+W",
                      click: () => {
                          options.closeFocusedWindowSurface();
                      },
                      label: "Close",
                  }
                : { role: "quit" },
        ],
    };

    const editMenu: MenuItemConstructorOptions = {
        role: "editMenu",
    };
    const viewMenu: MenuItemConstructorOptions = {
        label: "View",
        submenu: [
            {
                accelerator: "CmdOrCtrl+Alt+R",
                role: "reload",
            },
            {
                accelerator: "CmdOrCtrl+Alt+Shift+R",
                role: "forceReload",
            },
            {
                role: "toggleDevTools",
            },
            { type: "separator" },
            {
                accelerator: "CmdOrCtrl+B",
                label: "Toggle Sidebar",
            },
            { type: "separator" },
            {
                accelerator: "CmdOrCtrl+0",
                click: () => {
                    options.adjustAppZoom("reset");
                },
                label: "Actual Size",
            },
            {
                accelerator: "CmdOrCtrl+Plus",
                click: () => {
                    options.adjustAppZoom("increase");
                },
                label: "Zoom In",
            },
            {
                accelerator: "CmdOrCtrl+-",
                click: () => {
                    options.adjustAppZoom("decrease");
                },
                label: "Zoom Out",
            },
            { type: "separator" },
            {
                role: "togglefullscreen",
            },
        ],
    };
    const windowMenu: MenuItemConstructorOptions = {
        role: "windowMenu",
    };
    const helpMenu: MenuItemConstructorOptions = {
        label: "Help",
        submenu: [
            {
                click: () => {
                    void shell.openExternal(
                        "https://github.com/electron/electron",
                    );
                },
                label: `About ${appIdentity.name}`,
            },
        ],
    };

    if (isMac) {
        return [
            {
                label: appIdentity.name,
                submenu: [
                    { role: "about" },
                    { type: "separator" },
                    { role: "services" },
                    { type: "separator" },
                    { role: "hide" },
                    { role: "hideOthers" },
                    { role: "unhide" },
                    { type: "separator" },
                    { role: "quit" },
                ],
            },
            fileMenu,
            editMenu,
            viewMenu,
            windowMenu,
            helpMenu,
        ];
    }

    return [fileMenu, editMenu, viewMenu, windowMenu, helpMenu];
}
