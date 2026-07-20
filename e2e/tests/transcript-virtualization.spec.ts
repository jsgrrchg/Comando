import { expect, test } from "@playwright/test";

interface TranscriptHarnessSnapshot {
    readonly bottomGap: number;
    readonly clientHeight: number;
    readonly historyRowMounts: number;
    readonly historyRowUnmounts: number;
    readonly mountedHistoryRowIds: readonly string[];
    readonly scrollHeight: number;
    readonly scrollTop: number;
}

async function snapshotTranscript(
    page: import("@playwright/test").Page,
): Promise<TranscriptHarnessSnapshot> {
    return page.evaluate(() => window.comandoTranscriptHarness.snapshot());
}

test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(
        () => typeof window.comandoTranscriptHarness?.snapshot === "function",
    );
});

test("virtualized history remains mounted while a new turn streams", async ({ page }, testInfo) => {
    const before = await snapshotTranscript(page);
    expect(before.mountedHistoryRowIds).toContain("message:assistant-1999");

    const diagnostic = await page.evaluate(async () => {
        return window.comandoTranscriptHarness.runStreamingDiagnostic();
    });
    await testInfo.attach("transcript-streaming-diagnostic", {
        body: JSON.stringify(diagnostic, null, 2),
        contentType: "application/json",
    });

    const after = await snapshotTranscript(page);
    expect(after.historyRowMounts).toBe(before.historyRowMounts);
    expect(after.historyRowUnmounts).toBe(before.historyRowUnmounts);
    expect(after.mountedHistoryRowIds).toContain("message:assistant-1999");
    expect(after.bottomGap).toBeLessThanOrEqual(120);
    expect(diagnostic.samples.map((sample) => sample.phase)).toContain(
        "turn-started",
    );
    expect(diagnostic.samples.map((sample) => sample.phase)).toContain(
        "stream-5",
    );
    expect(diagnostic.virtualRanges.length).toBeGreaterThan(0);
    expect(
        diagnostic.performanceEvents.some(
            (event: { readonly metric: string }) =>
                event.metric === "markdown_commit",
        ),
    ).toBe(true);
    await expect(page.locator("[data-hot-transcript-tail]")).toHaveCount(1);
    await expect(
        page.locator(
            "[data-hot-transcript-tail] [data-measurement-key]",
        ),
    ).toHaveCount(0);
    await expect(
        page.locator("[data-list-key] [data-streaming-indicator-host]"),
    ).toHaveCount(0);
    await expect(page.getByText("return true;", { exact: false })).toBeVisible();
});

test("streaming has no transient frame continuity violations", async ({
    page,
}, testInfo) => {
    test.fail(
        true,
        "The extracted hot tail still exposes Markdown/scroll continuity violations until Fases 2-3 land.",
    );

    const diagnostic = await page.evaluate(async () => {
        return window.comandoTranscriptHarness.runStreamingDiagnostic();
    });
    await testInfo.attach("transcript-frame-continuity-diagnostic", {
        body: JSON.stringify(diagnostic, null, 2),
        contentType: "application/json",
    });

    expect(diagnostic.violations).toEqual({
        bottomGapFrames: [],
        longTaskCount: 0,
        markdownLagFrames: [],
        multiScrollWriteFrames: [],
    });
});
