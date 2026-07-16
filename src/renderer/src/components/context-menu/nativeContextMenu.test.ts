// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { requestNativeContextMenuAction } from "./nativeContextMenu";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("requestNativeContextMenuAction", () => {
    it("returns the renderer action selected by the native menu", async () => {
        const firstAction = vi.fn();
        const secondAction = vi.fn();
        const showNativeContextMenu = vi
            .fn()
            .mockResolvedValue("native-menu-1");
        vi.stubGlobal("comando", { showNativeContextMenu });

        const action = await requestNativeContextMenuAction(
            [
                { action: firstAction, label: "First" },
                { type: "separator" },
                { action: secondAction, disabled: true, label: "Second" },
            ],
            { x: 20, y: 30 },
        );

        expect(showNativeContextMenu).toHaveBeenCalledWith({
            entries: [
                {
                    children: undefined,
                    enabled: true,
                    id: "native-menu-0",
                    label: "First",
                },
                { type: "separator" },
                {
                    children: undefined,
                    enabled: false,
                    id: "native-menu-1",
                    label: "Second",
                },
            ],
            x: 20,
            y: 30,
        });
        expect(action).toBe(secondAction);
    });
});
