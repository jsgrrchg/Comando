import { describe, expect, it } from "vitest";

import { isQuickOpenFileShortcut } from "./useWorkspaceQuickOpen";

function shortcutEvent(
    overrides: Partial<Parameters<typeof isQuickOpenFileShortcut>[0]>,
): Parameters<typeof isQuickOpenFileShortcut>[0] {
    return {
        altKey: false,
        ctrlKey: false,
        defaultPrevented: false,
        key: "t",
        metaKey: false,
        shiftKey: false,
        ...overrides,
    };
}

describe("workspace quick open shortcut", () => {
    it("recognizes Cmd/Ctrl+T without extra modifiers", () => {
        expect(
            isQuickOpenFileShortcut(shortcutEvent({ metaKey: true })),
        ).toBe(true);
        expect(
            isQuickOpenFileShortcut(
                shortcutEvent({ ctrlKey: true, key: "T" }),
            ),
        ).toBe(true);
    });

    it("rejects modified or already handled shortcuts", () => {
        expect(
            isQuickOpenFileShortcut(
                shortcutEvent({ metaKey: true, shiftKey: true }),
            ),
        ).toBe(false);
        expect(
            isQuickOpenFileShortcut(shortcutEvent({ altKey: true })),
        ).toBe(false);
        expect(
            isQuickOpenFileShortcut(
                shortcutEvent({ defaultPrevented: true, metaKey: true }),
            ),
        ).toBe(false);
    });
});
