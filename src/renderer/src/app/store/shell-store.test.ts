import { afterEach, describe, expect, it } from "vitest";

import type { PersistedShellState } from "@shared/ipc";

import { shellLayoutConstraints } from "../layout/shell-layout";
import { useShellStore } from "./shell-store";

function resetShellStore(): void {
    useShellStore.setState({
        activeSurface: "workspace",
        leftCollapsed: false,
        leftWidth: shellLayoutConstraints.defaultLeftWidth,
        sidebarView: "files",
        viewportWidth: 1440,
    });
}

describe("shell-store", () => {
    afterEach(() => {
        resetShellStore();
    });

    it("normaliza snapshots legacy del utility panel al workspace actual", () => {
        useShellStore.getState().hydrate({
            activeSurface: "utility",
            leftCollapsed: true,
            leftWidth: 999,
            rightCollapsed: true,
            rightWidth: 420,
            sidebarView: "git",
        } as unknown as PersistedShellState);

        expect(useShellStore.getState()).toMatchObject({
            activeSurface: "workspace",
            leftCollapsed: true,
            leftWidth: shellLayoutConstraints.maxLeftWidth,
            sidebarView: "git",
        });
    });
});
