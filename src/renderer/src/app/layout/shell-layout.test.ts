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
            },
            1280,
        );

        expect(normalizedLayout.leftWidth).toBeLessThanOrEqual(
            shellLayoutConstraints.maxLeftWidth,
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
    });

    it("ajusta con teclado en pasos discretos", () => {
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
