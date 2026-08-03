import { describe, expect, it } from "vitest";

import {
    createDefaultShellLayout,
    getShellGridTemplateColumns,
    getOpenShellDrawerSide,
    getShellPanelWidthRange,
    getShellResponsiveMode,
    getShellSurfaceSideInsets,
    normalizeShellLayout,
    nudgeShellPanel,
    resizeShellPanel,
    resolveShellResponsiveLayout,
    scaleShellSurfaceInsets,
    shouldHideWorkspaceSurfaceForHostOverlay,
    shellLayoutConstraints,
} from "./shell-layout";

describe("shell-layout", () => {
    it.each([
        { expectedMode: "narrow", viewportWidth: 700 },
        { expectedMode: "medium", viewportWidth: 980 },
        { expectedMode: "wide", viewportWidth: 1_480 },
    ] as const)(
        "resolves the $expectedMode layout at $viewportWidth px",
        ({ expectedMode, viewportWidth }) => {
            expect(getShellResponsiveMode(viewportWidth)).toBe(expectedMode);
        },
    );

    it("clamps both wide panels together around the minimum center", () => {
        const normalized = normalizeShellLayout(
            { leftWidth: 900, rightWidth: 900 },
            1_200,
        );
        const centerWidth =
            1_200 -
            normalized.leftWidth -
            normalized.rightWidth -
            shellLayoutConstraints.handleWidth * 2;

        expect(normalized.leftWidth).toBeGreaterThanOrEqual(
            shellLayoutConstraints.minLeftWidth,
        );
        expect(normalized.rightWidth).toBeGreaterThanOrEqual(
            shellLayoutConstraints.minRightWidth,
        );
        expect(centerWidth).toBeGreaterThanOrEqual(
            shellLayoutConstraints.minCenterWidth,
        );
    });

    it.each([700, 980, 1_480])(
        "keeps the effective center above its minimum at %i px",
        (viewportWidth) => {
            const layout = normalizeShellLayout(
                { leftWidth: 10_000, rightWidth: 10_000 },
                viewportWidth,
            );
            const responsive = resolveShellResponsiveLayout(
                layout,
                {
                    leftCollapsed: false,
                    preferredDrawer: null,
                    rightCollapsed: false,
                },
                viewportWidth,
            );
            const insets = getShellSurfaceSideInsets(responsive);

            expect(
                viewportWidth - insets.left - insets.right,
            ).toBeGreaterThanOrEqual(shellLayoutConstraints.minCenterWidth);
        },
    );

    it("keeps drawer widths while narrow and sends zero surface insets", () => {
        const responsive = resolveShellResponsiveLayout(
            createDefaultShellLayout(),
            {
                leftCollapsed: false,
                preferredDrawer: "right",
                rightCollapsed: false,
            },
            700,
        );

        expect(responsive).toMatchObject({
            left: { collapsed: true, overlay: true },
            mode: "narrow",
            right: { collapsed: false, overlay: true },
        });
        expect(getShellSurfaceSideInsets(responsive)).toEqual({
            left: 0,
            right: 0,
        });
        expect(getShellGridTemplateColumns(responsive)).toBe(
            "0px 0px minmax(0, 1fr) 0px 0px",
        );
        expect(getOpenShellDrawerSide(responsive)).toBe("right");
        expect(
            shouldHideWorkspaceSurfaceForHostOverlay({
                responsive,
                settingsOpen: false,
                workspaceSwitcherOpen: false,
            }),
        ).toBe(true);
    });

    it("keeps navigator persistent and inspector overlaid at 980 px", () => {
        const responsive = resolveShellResponsiveLayout(
            createDefaultShellLayout(),
            {
                leftCollapsed: false,
                preferredDrawer: "right",
                rightCollapsed: false,
            },
            980,
        );

        expect(getShellSurfaceSideInsets(responsive)).toEqual({
            left:
                shellLayoutConstraints.defaultLeftWidth +
                shellLayoutConstraints.handleWidth,
            right: 0,
        });
    });

    it("applies both persistent insets at 1480 px", () => {
        const responsive = resolveShellResponsiveLayout(
            createDefaultShellLayout(),
            {
                leftCollapsed: false,
                preferredDrawer: null,
                rightCollapsed: false,
            },
            1_480,
        );

        expect(getShellSurfaceSideInsets(responsive)).toEqual({
            left: 281,
            right: 341,
        });
        expect(getOpenShellDrawerSide(responsive)).toBeNull();
        expect(
            shouldHideWorkspaceSurfaceForHostOverlay({
                responsive,
                settingsOpen: false,
                workspaceSwitcherOpen: true,
            }),
        ).toBe(true);
    });

    it("scales all insets together for host zoom", () => {
        expect(
            scaleShellSurfaceInsets(
                { left: 281, right: 341, top: 52 },
                1.25,
            ),
        ).toEqual({ left: 351.25, right: 426.25, top: 65 });
    });

    it("preserves manual collapse preferences across effective modes", () => {
        const preferences = {
            leftCollapsed: true,
            preferredDrawer: "right" as const,
            rightCollapsed: true,
        };
        const narrow = resolveShellResponsiveLayout(
            createDefaultShellLayout(),
            preferences,
            700,
        );
        const wide = resolveShellResponsiveLayout(
            createDefaultShellLayout(),
            preferences,
            1_480,
        );

        expect(narrow.right.collapsed).toBe(false);
        expect(wide.left.collapsed).toBe(true);
        expect(wide.right.collapsed).toBe(true);
    });

    it("resizes and nudges either panel within its joint range", () => {
        const initial = createDefaultShellLayout();
        const resized = resizeShellPanel(initial, "right", 900, 1_200);
        const range = getShellPanelWidthRange(resized, "right", 1_200);
        const nudged = nudgeShellPanel(
            resized,
            "right",
            -shellLayoutConstraints.keyboardStep,
            1_200,
        );

        expect(resized.rightWidth).toBeLessThanOrEqual(range.max);
        expect(nudged.rightWidth).toBe(
            resized.rightWidth - shellLayoutConstraints.keyboardStep,
        );
    });
});
