import { describe, expect, it } from "vitest";

import { getWorkspaceTabStripScrollTarget } from "./workspaceTabStrip";

describe("getWorkspaceTabStripScrollTarget", () => {
    it("keeps the current scroll position when the tab is fully visible", () => {
        expect(
            getWorkspaceTabStripScrollTarget({
                nodeLeft: 140,
                nodeWidth: 90,
                scrollWidth: 800,
                stripLeft: 100,
                stripWidth: 320,
            }),
        ).toBeNull();
    });

    it("scrolls left when the active tab is hidden before the viewport", () => {
        expect(
            getWorkspaceTabStripScrollTarget({
                nodeLeft: 42,
                nodeWidth: 120,
                scrollWidth: 800,
                stripLeft: 100,
                stripWidth: 320,
            }),
        ).toBe(30);
    });

    it("scrolls right when the active tab is hidden after the viewport", () => {
        expect(
            getWorkspaceTabStripScrollTarget({
                nodeLeft: 480,
                nodeWidth: 160,
                scrollWidth: 800,
                stripLeft: 0,
                stripWidth: 320,
            }),
        ).toBe(332);
    });

    it("clamps the target at the scrollable end", () => {
        expect(
            getWorkspaceTabStripScrollTarget({
                nodeLeft: 720,
                nodeWidth: 160,
                scrollWidth: 820,
                stripLeft: 0,
                stripWidth: 320,
            }),
        ).toBe(500);
    });
});
