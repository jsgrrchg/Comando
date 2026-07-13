import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface MockedBrowserWindow {
    readonly options: Record<string, unknown>;
    readonly setBackgroundMaterial: ReturnType<typeof vi.fn>;
    readonly setTitleBarOverlay: ReturnType<typeof vi.fn>;
    readonly setVibrancy: ReturnType<typeof vi.fn>;
}

const electronMocks = vi.hoisted(() => {
    const windows: MockedBrowserWindow[] = [];

    class MockBrowserWindow implements MockedBrowserWindow {
        static getAllWindows = vi.fn(() => windows);

        readonly loadFile = vi.fn(() => Promise.resolve());
        readonly loadURL = vi.fn(() => Promise.resolve());
        readonly maximize = vi.fn();
        readonly setFullScreen = vi.fn();
        readonly setBackgroundMaterial = vi.fn();
        readonly setTitle = vi.fn();
        readonly setTitleBarOverlay = vi.fn();
        readonly setVibrancy = vi.fn();
        readonly webContents = {
            on: vi.fn(),
            setWindowOpenHandler: vi.fn(),
        };

        destroyed = false;
        readonly options: Record<string, unknown>;

        constructor(options: Record<string, unknown>) {
            this.options = options;
            windows.push(this);
        }

        isDestroyed() {
            return this.destroyed;
        }
    }

    return {
        app: {
            isPackaged: true,
        },
        BrowserWindow: MockBrowserWindow,
        clearWindows: () => {
            windows.splice(0);
            MockBrowserWindow.getAllWindows.mockClear();
        },
        nativeTheme: {
            shouldUseDarkColors: false,
        },
        screen: {
            getAllDisplays: vi.fn(() => [
                {
                    workArea: {
                        height: 1080,
                        width: 1920,
                        x: 0,
                        y: 0,
                    },
                },
            ]),
        },
        shell: {
            openExternal: vi.fn(() => Promise.resolve()),
        },
        windows,
    };
});

vi.mock("electron", () => ({
    app: electronMocks.app,
    BrowserWindow: electronMocks.BrowserWindow,
    nativeTheme: electronMocks.nativeTheme,
    screen: electronMocks.screen,
    shell: electronMocks.shell,
}));

import { createMainWindow, refreshWindowsTitleBarOverlays } from "./window";

describe("window titlebar overlays", () => {
    beforeEach(() => {
        electronMocks.clearWindows();
        electronMocks.nativeTheme.shouldUseDarkColors = false;
        vi.spyOn(process, "platform", "get").mockReturnValue("win32");
        Object.defineProperty(process, "resourcesPath", {
            configurable: true,
            value: path.join(process.cwd(), "out"),
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        electronMocks.clearWindows();
    });

    it("refreshes titlebar overlays for acrylic Windows windows", () => {
        const createdWindow = createMainWindow();
        const window = electronMocks.windows[0];

        expect(window).toBe(createdWindow);
        expect(window.options).toMatchObject({
            backgroundColor: "#00000000",
            backgroundMaterial: "acrylic",
            titleBarStyle: "hidden",
        });
        expect(window.setTitleBarOverlay).not.toHaveBeenCalled();

        electronMocks.nativeTheme.shouldUseDarkColors = true;
        refreshWindowsTitleBarOverlays();

        expect(window.setTitleBarOverlay).toHaveBeenCalledWith({
            color: "#00000000",
            height: 40,
            symbolColor: "#e8e8e8",
        });
    });

    it("creates solid Windows windows when transparency is disabled", () => {
        createMainWindow(null, false);
        const window = electronMocks.windows[0];

        expect(window.options).toMatchObject({
            backgroundColor: "#ffffff",
            backgroundMaterial: undefined,
            titleBarStyle: "hidden",
        });
    });

    it("positions macOS main window traffic lights against the titlebar edge", () => {
        vi.spyOn(process, "platform", "get").mockReturnValue("darwin");

        createMainWindow();

        expect(electronMocks.windows[0]?.options).toMatchObject({
            titleBarStyle: "hidden",
            trafficLightPosition: { x: 14, y: 14 },
        });
    });
});
