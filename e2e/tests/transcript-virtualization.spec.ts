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

test("virtualized history remains mounted while a new turn streams", async ({ page }) => {
    const before = await snapshotTranscript(page);
    expect(before.mountedHistoryRowIds).toContain("message:assistant-255");

    await page.evaluate(async () => {
        await window.comandoTranscriptHarness.startTurn();
        await window.comandoTranscriptHarness.appendDelta("First streamed chunk. ");
        await window.comandoTranscriptHarness.appendDelta(
            "Second streamed chunk that changes the live tail height.",
        );
    });

    const after = await snapshotTranscript(page);
    expect(after.historyRowMounts).toBe(before.historyRowMounts);
    expect(after.historyRowUnmounts).toBe(before.historyRowUnmounts);
    expect(after.mountedHistoryRowIds).toContain("message:assistant-255");
    expect(after.scrollTop).toBeGreaterThanOrEqual(after.scrollHeight - 620);
    await expect(page.getByTestId("live-tail")).toContainText("Second streamed chunk");
});
