import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";

vi.mock("electron", () => ({
    Menu: {
        buildFromTemplate: vi.fn(),
        setApplicationMenu: vi.fn(),
    },
    app: { dock: null, isPackaged: true },
    shell: { openExternal: vi.fn() },
}));

import { buildMenuTemplate } from "./menu";

describe("application menu", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it("exposes singleton workspace and shell commands without window creation", () => {
        const closeActiveWorkspace = vi.fn();
        const toggleInspector = vi.fn();
        const toggleNavigator = vi.fn();
        const template = buildMenuTemplate({
            adjustAppZoom: vi.fn(),
            closeActiveTab: vi.fn(),
            closeActiveWorkspace,
            getFocusedMainWindowContext: () => null,
            openSettingsView: vi.fn(),
            openWorkspaceSwitcher: vi.fn(),
            reopenLastClosedTab: vi.fn(),
            toggleInspector,
            toggleNavigator,
        });
        const items = flattenMenu(template);

        expect(items.map((item) => item.label)).toEqual(
            expect.arrayContaining([
                "Close Workspace",
                "Toggle Inspector",
                "Toggle Navigator",
            ]),
        );
        expect(
            items.some((item) => item.label?.includes("New Window")),
        ).toBe(false);
        expect(
            items.find((item) => item.label === "Close Workspace")
                ?.accelerator,
        ).toBe("CmdOrCtrl+Shift+W");

        items.find((item) => item.label === "Close Workspace")?.click?.(
            {} as never,
            {} as never,
            {},
        );
        items.find((item) => item.label === "Toggle Inspector")?.click?.(
            {} as never,
            {} as never,
            {},
        );
        items.find((item) => item.label === "Toggle Navigator")?.click?.(
            {} as never,
            {} as never,
            {},
        );
        expect(closeActiveWorkspace).toHaveBeenCalledOnce();
        expect(toggleInspector).toHaveBeenCalledOnce();
        expect(toggleNavigator).toHaveBeenCalledOnce();
    });
});

function flattenMenu(
    items: readonly MenuItemConstructorOptions[],
): MenuItemConstructorOptions[] {
    return items.flatMap((item) => [
        item,
        ...(Array.isArray(item.submenu) ? flattenMenu(item.submenu) : []),
    ]);
}
