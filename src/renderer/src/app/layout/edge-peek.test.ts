import { describe, expect, it } from "vitest";

import { isPointInsideInflatedRect } from "./edge-peek";

const rect = {
    bottom: 200,
    height: 200,
    left: 0,
    right: 300,
    top: 0,
    width: 300,
};

describe("edge-peek", () => {
    it("keeps points inside the inflated safe zone", () => {
        expect(
            isPointInsideInflatedRect({ x: 326, y: 80 }, rect, 28),
        ).toBe(true);
    });

    it("rejects points outside the inflated safe zone", () => {
        expect(
            isPointInsideInflatedRect({ x: 340, y: 80 }, rect, 28),
        ).toBe(false);
    });

    it("rejects missing points and empty rects", () => {
        expect(isPointInsideInflatedRect(null, rect, 28)).toBe(false);
        expect(
            isPointInsideInflatedRect(
                { x: 0, y: 0 },
                {
                    ...rect,
                    bottom: 0,
                    height: 0,
                    right: 0,
                    width: 0,
                },
                28,
            ),
        ).toBe(false);
    });
});
