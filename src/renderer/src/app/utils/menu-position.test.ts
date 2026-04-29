import { afterEach, describe, expect, it, vi } from "vitest";

import {
    getViewportSafeMenuPosition,
    getViewportSafeSubmenuPosition,
} from "./menu-position";

function setViewport(width: number, height: number) {
    vi.stubGlobal("window", {
        innerHeight: height,
        innerWidth: width,
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("menu-position", () => {
    it("clamps a root menu inside the viewport", () => {
        setViewport(320, 240);

        expect(getViewportSafeMenuPosition(300, 220, 100, 80)).toEqual({
            x: 212,
            y: 152,
        });
    });

    it("positions submenus to the right of the anchor when there is room", () => {
        setViewport(500, 300);

        expect(
            getViewportSafeSubmenuPosition(
                { left: 100, right: 180, top: 40 },
                160,
                120,
            ),
        ).toEqual({
            x: 184,
            y: 40,
        });
    });

    it("flips submenus to the left of the anchor before clamping", () => {
        setViewport(320, 300);

        expect(
            getViewportSafeSubmenuPosition(
                { left: 200, right: 300, top: 40 },
                160,
                120,
            ),
        ).toEqual({
            x: 36,
            y: 40,
        });
    });
});
