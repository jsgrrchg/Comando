import { expect, test } from "@playwright/test";

test("verbose terminal streaming keeps workspace interactions responsive", async ({
    page,
}, testInfo) => {
    await page.goto("/?harness=terminal-pressure");
    await page.waitForFunction(
        () => typeof window.comandoTerminalPressureHarness?.start === "function",
    );

    await page.evaluate(() => window.comandoTerminalPressureHarness.start());
    await page.getByLabel("Composer").fill("workspace remains interactive");
    await page.getByRole("button", { name: "Background" }).click();
    await page.locator("[data-pressure-scroll]").evaluate((element) => {
        element.scrollTop = element.scrollHeight;
    });
    await expect(page.locator("[data-pressure-status]")).toHaveText("complete");

    const snapshot = await page.evaluate(() =>
        window.comandoTerminalPressureHarness.snapshot(),
    );
    await testInfo.attach("ai-terminal-stream-pressure", {
        body: JSON.stringify(
            {
                activeTab: snapshot.activeTab,
                appliedToolEvents: snapshot.appliedToolEvents,
                composerValueLength: snapshot.composerValue.length,
                finalOutputLength: snapshot.finalOutput.length,
                producerEvents: snapshot.producerEvents,
                status: snapshot.status,
            },
            null,
            2,
        ),
        contentType: "application/json",
    });

    expect(snapshot.producerEvents).toBe(10_002);
    expect(snapshot.appliedToolEvents).toBeLessThanOrEqual(42);
    expect(snapshot.finalOutput).toBe(snapshot.expectedFinalOutput);
    expect(snapshot.finalOutput).toHaveLength(10_000);
    expect(snapshot.composerValue).toBe("workspace remains interactive");
    expect(snapshot.activeTab).toBe("background");
});
