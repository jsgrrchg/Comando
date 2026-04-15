import { describe, expect, it } from "vitest";

import {
    createDefaultShellLayout,
    nudgeShellPanel,
    normalizeShellLayout,
    resizeShellPanel,
    shellLayoutConstraints,
} from "./shell-layout";

describe("shell-layout", () => {
    it("keeps central workspace within minimum limits", () => {
        const normalizedLayout = normalizeShellLayout(
            {
                leftWidth: 900,
            },
            1280,
        );

        expect(normalizedLayout.leftWidth).toBeLessThanOrEqual(
            shellLayoutConstraints.maxLeftWidth,
        );
    });

    it("resizes a panel and respects viewport clamps", () => {
        const resizedLayout = resizeShellPanel(
            createDefaultShellLayout(),
            "left",
            600,
            1280,
        );

        expect(resizedLayout.leftWidth).toBeLessThanOrEqual(
            shellLayoutConstraints.maxLeftWidth,
        );
    });

    it("nudges with keyboard in discrete steps", () => {
        const nudgedLayout = nudgeShellPanel(
            createDefaultShellLayout(),
            "left",
            -shellLayoutConstraints.keyboardStep,
            1440,
        );

        expect(nudgedLayout.leftWidth).toBe(
            shellLayoutConstraints.defaultLeftWidth -
                shellLayoutConstraints.keyboardStep,
        );
    });
});
