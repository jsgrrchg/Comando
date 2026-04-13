import { describe, expect, it } from "vitest";

import {
    createDefaultShellLayout,
    nudgeShellPanel,
    normalizeShellLayout,
    resizeShellPanel,
    shellLayoutConstraints,
} from "./shell-layout";

describe("shell-layout", () => {
    it("mantiene el workspace central dentro de limites minimos", () => {
        const normalizedLayout = normalizeShellLayout(
            {
                leftWidth: 900,
                rightWidth: 900,
            },
            1280,
        );

        expect(normalizedLayout.leftWidth).toBeLessThanOrEqual(
            shellLayoutConstraints.maxLeftWidth,
        );
        expect(normalizedLayout.rightWidth).toBeLessThanOrEqual(
            shellLayoutConstraints.maxRightWidth,
        );
    });

    it("redimensiona un panel y respeta los clamps del viewport", () => {
        const resizedLayout = resizeShellPanel(
            createDefaultShellLayout(),
            "left",
            600,
            1280,
        );

        expect(resizedLayout.leftWidth).toBeLessThanOrEqual(
            shellLayoutConstraints.maxLeftWidth,
        );
        expect(resizedLayout.rightWidth).toBe(
            shellLayoutConstraints.defaultRightWidth,
        );
    });

    it("ajusta con teclado en pasos discretos", () => {
        const nudgedLayout = nudgeShellPanel(
            createDefaultShellLayout(),
            "right",
            -shellLayoutConstraints.keyboardStep,
            1440,
        );

        expect(nudgedLayout.rightWidth).toBe(
            shellLayoutConstraints.defaultRightWidth -
                shellLayoutConstraints.keyboardStep,
        );
    });
});
