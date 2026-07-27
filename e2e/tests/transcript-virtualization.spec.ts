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
    expect(diagnostic.violations.markdownLagFrames).toEqual([]);
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

test("fast scrolling keeps every sampled viewport covered", async ({
    page,
}, testInfo) => {
    const diagnostic = await page.evaluate(async () => {
        return window.comandoTranscriptHarness.runFastScrollDiagnostic();
    });
    await testInfo.attach("transcript-fast-scroll-diagnostic", {
        body: JSON.stringify(diagnostic, null, 2),
        contentType: "application/json",
    });

    expect(diagnostic.samples.length).toBeGreaterThanOrEqual(8);
    expect(diagnostic.samples.every((sample) => sample.mountedRows > 0)).toBe(
        true,
    );
    expect(diagnostic.violations.uncoveredViewportFrames).toEqual([]);
    // A fling can produce isolated long tasks while mounting fresh cards, but
    // it must not degrade into one blocked task for every sampled frame.
    expect(diagnostic.violations.longTaskCount).toBeLessThan(
        diagnostic.samples.length,
    );
});

test("parameterized scenarios retain replayable renderer artifacts", async ({
    page,
}, testInfo) => {
    await page.evaluate(async () => {
        await window.comandoTranscriptHarness.loadScenario({
            activeTools: 80,
            aggregateDiffBytes: 512 * 1024,
            deltaBytes: 512,
            diffCount: 20,
            historyMessages: 1_000,
            seed: 7_026,
            sessionCount: 2,
            streamingDeltas: 8,
            terminalOutputBytes: 128 * 1024,
        });
        await window.comandoTranscriptHarness.runScrollPattern({
            positions: [0, 0.2, 0.7, 0.35, 1],
        });
        await window.comandoTranscriptHarness.startStreaming({
            deltaLimit: 8,
            finalText: "\n\n```ts\nexport const e2eScenario = true;\n```\n",
        });
        await window.comandoTranscriptHarness.applyMemoryPressure();
    });
    const metrics = await page.evaluate(() =>
        window.comandoTranscriptHarness.collectMetrics(),
    );
    await testInfo.attach("transcript-parameterized-scenario", {
        body: JSON.stringify(metrics, null, 2),
        contentType: "application/json",
    });

    expect(metrics.loadScenario.scenario.seed).toBe(7_026);
    expect(metrics.loadScenario.generated.sessions).toBe(2);
    expect(metrics.loadScenario.generated.tools).toBe(80);
    expect(metrics.samples.length).toBeGreaterThanOrEqual(5);
    expect(metrics.virtualRanges.length).toBeGreaterThan(0);
    expect(metrics.snapshot.mountedHistoryRowIds.length).toBeGreaterThan(0);
    expect(metrics.workCounters.timeline_full_rebuilds).toBe(0);
});

test("session cycles return renderer resources to a steady state after GC", async ({
    page,
}, testInfo) => {
    const diagnostic = await page.evaluate(async () => {
        return window.comandoTranscriptHarness.runSessionCycles(50);
    });
    await testInfo.attach("transcript-session-cycles", {
        body: JSON.stringify(diagnostic, null, 2),
        contentType: "application/json",
    });

    expect(diagnostic.samples).toHaveLength(50);
    const steadySamples = diagnostic.samples.slice(10);
    for (const sessionParity of [0, 1]) {
        const samplesForSession = steadySamples.filter(
            (sample) => sample.cycle % 2 === sessionParity,
        );
        // The two fixture sessions have intentionally different payload sizes.
        // Each must nevertheless settle to one bounded footprint on revisit.
        expect(
            new Set(samplesForSession.map((sample) => sample.residentPayloadBytes))
                .size,
        ).toBe(1);
        expect(
            new Set(samplesForSession.map((sample) => sample.retainedArtifacts))
                .size,
        ).toBe(1);
        expect(
            new Set(samplesForSession.map((sample) => sample.residentBlocks)).size,
        ).toBe(1);
        expect(
            new Set(samplesForSession.map((sample) => sample.domNodes)).size,
        ).toBe(1);
        const observerCounts = samplesForSession
            .map((sample) => sample.activeResizeObservers)
            .filter((count): count is number => count !== null);
        if (observerCounts.length > 0) {
            expect(new Set(observerCounts).size).toBe(1);
        }
    }
    expect(diagnostic.steadyState.maxResidentBlocks).toBeLessThanOrEqual(80);
    if (diagnostic.steadyState.heapGrowthRatio !== null) {
        // This is a trend gate after warm-up, not a one-sample leak assertion.
        expect(diagnostic.steadyState.heapGrowthRatio).toBeLessThanOrEqual(0.1);
    }
});

test("30 minute renderer soak retains bounded diagnostics", async ({ page }, testInfo) => {
    test.skip(
        process.env.RUN_CHAT_SOAK !== "1",
        "Run manually or weekly with RUN_CHAT_SOAK=1.",
    );
    test.setTimeout(31 * 60 * 1_000);

    const diagnostic = await page.evaluate(async () => {
        return window.comandoTranscriptHarness.runSoakDiagnostic();
    });
    await testInfo.attach("transcript-30-minute-soak", {
        body: JSON.stringify(diagnostic, null, 2),
        contentType: "application/json",
    });

    expect(diagnostic.durationMs).toBe(30 * 60 * 1_000);
    expect(diagnostic.samples.length).toBeGreaterThanOrEqual(60);
});
