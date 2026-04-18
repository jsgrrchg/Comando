import { describe, expect, it } from "vitest";

import {
    APP_ZOOM_FACTOR_DEFAULT,
    APP_ZOOM_FACTOR_MAX,
    APP_ZOOM_FACTOR_MIN,
    clampAppZoomFactor,
    formatAppZoomPercent,
    stepAppZoomFactor,
} from "./app-zoom";

describe("clampAppZoomFactor", () => {
    it("returns the default for non-finite input", () => {
        expect(clampAppZoomFactor(Number.NaN)).toBe(APP_ZOOM_FACTOR_DEFAULT);
        expect(clampAppZoomFactor(Number.POSITIVE_INFINITY)).toBe(
            APP_ZOOM_FACTOR_DEFAULT,
        );
    });

    it("clamps to the declared range", () => {
        expect(clampAppZoomFactor(0.1)).toBe(APP_ZOOM_FACTOR_MIN);
        expect(clampAppZoomFactor(99)).toBe(APP_ZOOM_FACTOR_MAX);
    });

    it("rounds to two decimals", () => {
        expect(clampAppZoomFactor(1.234)).toBe(1.23);
        expect(clampAppZoomFactor(1.235)).toBe(1.24);
    });
});

describe("stepAppZoomFactor", () => {
    it("increases and decreases in fixed steps", () => {
        expect(stepAppZoomFactor(1, "increase")).toBeCloseTo(1.05);
        expect(stepAppZoomFactor(1, "decrease")).toBeCloseTo(0.95);
    });

    it("resets to the default", () => {
        expect(stepAppZoomFactor(1.4, "reset")).toBe(APP_ZOOM_FACTOR_DEFAULT);
    });

    it("never crosses the configured bounds", () => {
        expect(stepAppZoomFactor(APP_ZOOM_FACTOR_MAX, "increase")).toBe(
            APP_ZOOM_FACTOR_MAX,
        );
        expect(stepAppZoomFactor(APP_ZOOM_FACTOR_MIN, "decrease")).toBe(
            APP_ZOOM_FACTOR_MIN,
        );
    });
});

describe("formatAppZoomPercent", () => {
    it("prints a clamped percentage", () => {
        expect(formatAppZoomPercent(1)).toBe("100%");
        expect(formatAppZoomPercent(1.5)).toBe("150%");
        expect(formatAppZoomPercent(99)).toBe("150%");
        expect(formatAppZoomPercent(Number.NaN)).toBe("100%");
    });
});
