import { expect, test } from "@playwright/test";

const sizes = [
    { mode: "narrow", width: 700 },
    { mode: "medium", width: 980 },
    { mode: "wide", width: 1_480 },
] as const;

for (const { mode, width } of sizes) {
    test(`shell remains keyboard-usable at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ height: 800, width });
        await page.goto("/?harness=shell");
        await expect(page.locator("main")).toHaveAttribute(
            "data-shell-harness-mode",
            mode,
        );
        await expect(page.locator("[data-workspace-surface='true']")).toHaveCount(
            1,
        );

        if (mode === "wide") {
            await expect(page.getByRole("separator")).toHaveCount(2);
            await expect(
                page.getByRole("separator", {
                    name: "Resize workspace navigator",
                }),
            ).toHaveAttribute("aria-controls", "workspace-navigator");
            await expect(page.getByRole("dialog")).toHaveCount(0);
            return;
        }

        const inspectorToggle = page.getByRole("button", {
            name: "Show workspace inspector",
        });
        await inspectorToggle.click();
        const drawer = page.getByRole("dialog", {
            name: "Workspace inspector",
        });
        await expect(drawer).toBeVisible();
        await expect(drawer).toHaveAttribute("aria-modal", "true");
        await expect(
            page.getByRole("button", { name: "Inspector drawer action" }),
        ).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(drawer).toContainText("Inspector drawer action");
        await page.keyboard.press("Escape");
        await expect(drawer).toHaveCount(0);
        await expect(inspectorToggle).toBeFocused();
        await expect(page.locator("[data-workspace-surface='true']")).toHaveCount(
            1,
        );
    });
}

test("narrow mode switches drawers atomically without duplicating the surface", async ({
    page,
}) => {
    await page.setViewportSize({ height: 800, width: 700 });
    await page.goto("/?harness=shell");
    await page
        .getByRole("button", { name: "Show workspace navigator" })
        .click();
    await expect(
        page.getByRole("dialog", { name: "Workspace navigator" }),
    ).toBeVisible();

    await page
        .getByRole("button", { name: "Show workspace inspector" })
        .click();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(
        page.getByRole("dialog", { name: "Workspace inspector" }),
    ).toBeVisible();
    await expect(page.locator("[data-workspace-surface='true']")).toHaveCount(1);
});

test("reduced motion and solid transparency mode remove shell effects", async ({
    page,
}) => {
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.setViewportSize({ height: 800, width: 980 });
    await page.goto("/?harness=shell&platform=win32&transparency=false");
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.locator("html")).toHaveAttribute(
        "data-transparency-enabled",
        "false",
    );
    await expect(page.locator("[data-shell-grid='true']")).toHaveCSS(
        "transition-duration",
        "0s",
    );

    await page
        .getByRole("button", { name: "Show workspace inspector" })
        .click();
    await expect(page.getByRole("dialog")).toHaveCSS("animation-name", "none");
    await expect(page.locator(".shell-drawer-backdrop")).toHaveCSS(
        "backdrop-filter",
        "none",
    );
});

for (const platform of ["darwin", "win32", "linux"] as const) {
    test(`titlebar shell keeps accessible controls on ${platform}`, async ({
        page,
    }) => {
        await page.setViewportSize({ height: 800, width: 1_480 });
        await page.goto(`/?harness=shell&platform=${platform}`);
        await expect(page.locator("html")).toHaveAttribute(
            "data-platform",
            platform,
        );
        await expect(
            page.getByRole("button", { name: "Hide workspace navigator" }),
        ).toHaveAttribute("aria-expanded", "true");
        await expect(
            page.getByRole("button", { name: "Hide workspace inspector" }),
        ).toHaveAttribute("aria-expanded", "true");
    });
}
