import { describe, expect, it } from "vitest";

import {
    AGENTS_SIDEBAR_SCALE_DEFAULT,
    AGENTS_SIDEBAR_SCALE_MAX,
    AGENTS_SIDEBAR_SCALE_MIN,
    clampAgentsSidebarScale,
    formatAgentsSidebarScalePercent,
} from "./agents-sidebar-scale";

describe("clampAgentsSidebarScale", () => {
    it("returns the default for non-finite input", () => {
        expect(clampAgentsSidebarScale(Number.NaN)).toBe(
            AGENTS_SIDEBAR_SCALE_DEFAULT,
        );
        expect(clampAgentsSidebarScale(Number.NEGATIVE_INFINITY)).toBe(
            AGENTS_SIDEBAR_SCALE_DEFAULT,
        );
    });

    it("clamps to the declared range", () => {
        expect(clampAgentsSidebarScale(0)).toBe(AGENTS_SIDEBAR_SCALE_MIN);
        expect(clampAgentsSidebarScale(10)).toBe(AGENTS_SIDEBAR_SCALE_MAX);
    });

    it("rounds to two decimals", () => {
        expect(clampAgentsSidebarScale(1.019)).toBe(1.02);
    });
});

describe("formatAgentsSidebarScalePercent", () => {
    it("prints a clamped percentage", () => {
        expect(formatAgentsSidebarScalePercent(1)).toBe("100%");
        expect(formatAgentsSidebarScalePercent(1.4)).toBe("140%");
        expect(formatAgentsSidebarScalePercent(Number.NaN)).toBe("100%");
    });
});
