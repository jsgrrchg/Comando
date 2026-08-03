/** @vitest-environment jsdom */
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const workerPool = vi.hoisted(() => ({
    highlighterOptions: [] as Array<unknown>,
    setRenderOptions: vi.fn(() => Promise.resolve()),
}));

vi.mock("@pierre/diffs/react", () => ({
    WorkerPoolContextProvider: ({
        children,
        highlighterOptions,
    }: {
        readonly children: ReactNode;
        readonly highlighterOptions: unknown;
    }) => {
        workerPool.highlighterOptions.push(highlighterOptions);
        return children;
    },
    useWorkerPool: () => workerPool,
}));

vi.mock("@renderer/app/editor/pierreShikiTheme", () => ({
    getComandoPierreThemes: (preset: string, boostCodeContrast: boolean) => ({
        dark: `comando-${preset}-dark-${boostCodeContrast ? "boosted" : "standard"}`,
        light: `comando-${preset}-light-${boostCodeContrast ? "boosted" : "standard"}`,
    }),
    registerComandoPierreThemes: vi.fn(),
}));

import {
    resetSettingsStoreForTests,
    useSettingsStore,
} from "@renderer/app/store/settings-store";

import { PierreDiffWorkerPoolProvider } from "./PierreDiffWorkerPoolProvider";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

describe("PierreDiffWorkerPoolProvider browser theme bridge", () => {
    beforeEach(() => {
        resetSettingsStoreForTests();
        workerPool.highlighterOptions.length = 0;
        workerPool.setRenderOptions.mockClear();
        vi.stubGlobal("Worker", class Worker {});
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("initializes and updates the shared highlighter with the active Comando syntax theme", () => {
        act(() => {
            useSettingsStore.setState((state) => ({
                appearance: {
                    ...state.appearance,
                    boostCodeContrast: false,
                    themePreset: "tokyoNight",
                },
            }));
        });

        const container = document.createElement("div");
        const root = createRoot(container);

        act(() => {
            root.render(
                <PierreDiffWorkerPoolProvider>
                    <div>Git diff</div>
                </PierreDiffWorkerPoolProvider>,
            );
        });

        expect(workerPool.highlighterOptions.at(-1)).toEqual({
            langs: [],
            theme: {
                dark: "comando-tokyoNight-dark-standard",
                light: "comando-tokyoNight-light-standard",
            },
        });
        expect(workerPool.setRenderOptions).toHaveBeenLastCalledWith({
            theme: {
                dark: "comando-tokyoNight-dark-standard",
                light: "comando-tokyoNight-light-standard",
            },
        });

        workerPool.setRenderOptions.mockClear();

        act(() => {
            useSettingsStore.setState((state) => ({
                appearance: {
                    ...state.appearance,
                    boostCodeContrast: true,
                    themePreset: "gruvbox",
                },
            }));
        });

        expect(workerPool.setRenderOptions).toHaveBeenCalledWith({
            theme: {
                dark: "comando-gruvbox-dark-boosted",
                light: "comando-gruvbox-light-boosted",
            },
        });

        act(() => root.unmount());
    });
});
