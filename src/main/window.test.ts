import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface MockedBrowserWindow {
    readonly options: Record<string, unknown>;
    readonly setBackgroundMaterial: ReturnType<typeof vi.fn>;
    readonly setFullScreen: ReturnType<typeof vi.fn>;
    readonly setWindowButtonPosition: ReturnType<typeof vi.fn>;
    readonly setTitleBarOverlay: ReturnType<typeof vi.fn>;
    readonly setVibrancy: ReturnType<typeof vi.fn>;
    readonly webContents: {
        readonly send: ReturnType<typeof vi.fn>;
        readonly setWindowOpenHandler: ReturnType<typeof vi.fn>;
    };
    triggerDidFinishLoad(): void;
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
        readonly setWindowButtonPosition = vi.fn();
        private readonly didFinishLoadHandlers: Array<() => void> = [];
        readonly webContents = {
            on: vi.fn((eventName: string, listener: () => void) => {
                if (eventName === "did-finish-load") {
                    this.didFinishLoadHandlers.push(listener);
                }
            }),
            send: vi.fn(),
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

        triggerDidFinishLoad() {
            for (const handler of this.didFinishLoadHandlers) {
                handler();
            }
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

import {
    applyWindowTransparencyToWindow,
    createMainWindow,
    refreshWindowsTitleBarOverlays,
} from "./window";

describe("window titlebar overlays", () => {
    beforeEach(() => {
        electronMocks.clearWindows();
        electronMocks.nativeTheme.shouldUseDarkColors = false;
        electronMocks.screen.getAllDisplays.mockReset();
        electronMocks.screen.getAllDisplays.mockReturnValue([
            {
                workArea: {
                    height: 1080,
                    width: 1920,
                    x: 0,
                    y: 0,
                },
            },
        ]);
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
            height: 32,
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
            trafficLightPosition: { x: 14, y: 8 },
        });
        expect(electronMocks.windows).toHaveLength(1);

        electronMocks.windows[0]?.triggerDidFinishLoad();
        expect(
            electronMocks.windows[0]?.setWindowButtonPosition,
        ).toHaveBeenCalledWith({ x: 14, y: 8 });
    });

    it("uses the native overlay and solid shell fallback on Linux", () => {
        vi.spyOn(process, "platform", "get").mockReturnValue("linux");

        createMainWindow(null, false);

        expect(electronMocks.windows[0]?.options).toMatchObject({
            backgroundColor: "#ffffff",
            backgroundMaterial: undefined,
            titleBarOverlay: {
                color: "#00000000",
                height: 32,
                symbolColor: "#1c1c1c",
            },
            titleBarStyle: "hidden",
        });
    });

    it("updates native transparency without replacing the singleton window", () => {
        const windowsPlatform = vi
            .spyOn(process, "platform", "get")
            .mockReturnValue("win32");
        createMainWindow();
        const window = electronMocks.windows[0];
        if (!window) {
            throw new Error("Expected the main window.");
        }

        applyWindowTransparencyToWindow(
            window as unknown as import("electron").BrowserWindow,
            false,
        );
        expect(window.setBackgroundMaterial).toHaveBeenLastCalledWith("none");

        windowsPlatform.mockReturnValue("darwin");
        applyWindowTransparencyToWindow(
            window as unknown as import("electron").BrowserWindow,
            true,
        );
        expect(window.setVibrancy).toHaveBeenLastCalledWith("sidebar");
        expect(electronMocks.windows).toHaveLength(1);
    });

    it("restores fullscreen on a visible secondary display and recenters stale bounds", () => {
        electronMocks.screen.getAllDisplays.mockReturnValue([
            {
                workArea: { height: 1_080, width: 1_920, x: 0, y: 0 },
            },
            {
                workArea: { height: 1_440, width: 2_560, x: 1_920, y: 0 },
            },
        ]);
        const restoredState = {
            height: 900,
            id: "main",
            isFullScreen: true,
            isMaximized: false,
            width: 1_400,
            x: 2_100,
            y: 120,
        };

        createMainWindow(restoredState);
        expect(electronMocks.windows[0]?.options).toMatchObject({
            height: 900,
            width: 1_400,
            x: 2_100,
            y: 120,
        });
        expect(
            electronMocks.windows[0]?.setFullScreen,
        ).toHaveBeenCalledWith(true);

        electronMocks.clearWindows();
        electronMocks.screen.getAllDisplays.mockReturnValue([
            {
                workArea: { height: 1_080, width: 1_920, x: 0, y: 0 },
            },
        ]);
        createMainWindow(restoredState);
        expect(electronMocks.windows[0]?.options).toMatchObject({
            x: undefined,
            y: undefined,
        });
    });

    it("routes internal window opens to the host and external links to the system", () => {
        createMainWindow();
        const window = electronMocks.windows[0];
        const handler = window?.webContents.setWindowOpenHandler.mock
            .calls[0]?.[0] as ((input: { url: string }) => { action: string });

        expect(handler({ url: "comando://settings" })).toEqual({
            action: "deny",
        });
        expect(window?.webContents.send).toHaveBeenCalledWith(
            "app:internal-navigation-requested",
            "comando://settings",
        );

        expect(handler({ url: "https://example.com" })).toEqual({
            action: "deny",
        });
        expect(electronMocks.shell.openExternal).toHaveBeenCalledWith(
            "https://example.com/",
        );
    });
});
