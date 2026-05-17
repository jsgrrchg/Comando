import { describe, expect, it } from "vitest";

import {
    hasPrimaryPointerButton,
    isPrimaryPointerButton,
} from "./pointerGuards";

describe("pointerGuards", () => {
    it("detects primary pointer down by button id", () => {
        expect(isPrimaryPointerButton(0)).toBe(true);
        expect(isPrimaryPointerButton(1)).toBe(false);
        expect(isPrimaryPointerButton(2)).toBe(false);
    });

    it("detects primary pointer presence in buttons bitmask", () => {
        expect(hasPrimaryPointerButton(1)).toBe(true);
        expect(hasPrimaryPointerButton(3)).toBe(true);
        expect(hasPrimaryPointerButton(0)).toBe(false);
        expect(hasPrimaryPointerButton(2)).toBe(false);
    });
});
