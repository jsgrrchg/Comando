import { describe, expect, it } from "vitest";

import {
    FILE_TREE_SCALE_DEFAULT,
    FILE_TREE_SCALE_MAX,
    FILE_TREE_SCALE_MIN,
    clampFileTreeScale,
    formatFileTreeScalePercent,
} from "./file-tree-scale";

describe("clampFileTreeScale", () => {
    it("returns the default for non-finite input", () => {
        expect(clampFileTreeScale(Number.NaN)).toBe(FILE_TREE_SCALE_DEFAULT);
        expect(clampFileTreeScale(Number.NEGATIVE_INFINITY)).toBe(
            FILE_TREE_SCALE_DEFAULT,
        );
    });

    it("clamps to the declared range", () => {
        expect(clampFileTreeScale(0)).toBe(FILE_TREE_SCALE_MIN);
        expect(clampFileTreeScale(10)).toBe(FILE_TREE_SCALE_MAX);
    });

    it("rounds to two decimals", () => {
        expect(clampFileTreeScale(1.019)).toBe(1.02);
    });
});

describe("formatFileTreeScalePercent", () => {
    it("prints a clamped percentage", () => {
        expect(formatFileTreeScalePercent(1)).toBe("100%");
        expect(formatFileTreeScalePercent(1.35)).toBe("135%");
        expect(formatFileTreeScalePercent(Number.NaN)).toBe("100%");
    });
});
