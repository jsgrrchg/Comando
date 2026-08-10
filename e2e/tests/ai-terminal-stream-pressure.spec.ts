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
    await page.getByRole("button", { name: "Suspend" }).click();
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
                acknowledgedPayloads: snapshot.acknowledgedPayloads,
                criticalKindsDelivered: snapshot.criticalKindsDelivered,
                finalOutputLength: snapshot.finalOutput.length,
                frameCoalesced: snapshot.frameCoalesced,
                framePeakPending: snapshot.framePeakPending,
                peakInFlight: snapshot.peakInFlight,
                presencePublishes: snapshot.presencePublishes,
                producerEvents: snapshot.producerEvents,
                status: snapshot.status,
                storeToolApplies: snapshot.storeToolApplies,
                toolEventsReceived: snapshot.toolEventsReceived,
                transportCoalesced: snapshot.transportCoalesced,
            },
            null,
            2,
        ),
        contentType: "application/json",
    });

    expect(snapshot.producerEvents).toBe(10_007);
    expect(snapshot.peakInFlight).toBe(32);
    expect(snapshot.transportCoalesced).toBeGreaterThan(8_000);
    expect(snapshot.frameCoalesced).toBeGreaterThan(1_000);
    expect(snapshot.framePeakPending).toBe(1);
    expect(snapshot.toolEventsReceived).toBeLessThanOrEqual(1_400);
    expect(snapshot.storeToolApplies).toBeLessThanOrEqual(45);
    expect(snapshot.presencePublishes).toBeLessThanOrEqual(8);
    expect(snapshot.ackBeforeIngestion).toBe(false);
    expect(snapshot.duplicatePayloads).toBe(0);
    expect(snapshot.acknowledgedPayloads).toBeGreaterThan(0);
    expect(snapshot.criticalKindsDelivered).toEqual([
        "permission-request",
        "status",
        "turn-status",
        "user-input-request",
    ]);
    expect(snapshot.finalOutput).toBe(snapshot.expectedFinalOutput);
    expect(snapshot.finalOutput).toHaveLength(10_000);
    expect(snapshot.finalExitCode).toBe(0);
    expect(snapshot.finalDiffCount).toBe(1);
    await expect(page.getByLabel("Composer")).toHaveValue(
        "workspace remains interactive",
    );
    expect(snapshot.activeTab).toBe("background");
    expect(snapshot.lifecycle).toBe("suspended");
    expect(snapshot.scrollAtBottom).toBe(true);
});
