import { describe, expect, it } from "vitest";

import { isScrollViewportNearBottom } from "./chatScroll";

describe("isScrollViewportNearBottom", () => {
    it("returns true when the viewport is inside the threshold", () => {
        expect(isScrollViewportNearBottom(840, 1000, 120, 80)).toBe(true);
    });

    it("returns false when the viewport is outside the threshold", () => {
        expect(isScrollViewportNearBottom(760, 1000, 120, 80)).toBe(false);
    });

    it("treats the exact threshold boundary as not near bottom", () => {
        expect(isScrollViewportNearBottom(800, 1000, 120, 80)).toBe(false);
    });
});
