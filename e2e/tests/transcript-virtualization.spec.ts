import { expect, test } from "@playwright/test";

interface TranscriptHarnessSnapshot {
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
    expect(after.scrollTop).toBeGreaterThanOrEqual(after.scrollHeight - 620);
    expect(diagnostic.samples.map((sample) => sample.phase)).toEqual([
        "before-turn",
        "turn-started",
        "stream-1",
        "stream-2",
        "stream-3",
    ]);
    expect(diagnostic.virtualRanges.length).toBeGreaterThan(0);
    await expect(page.getByTestId("live-tail")).toContainText("Third streamed chunk");
});
