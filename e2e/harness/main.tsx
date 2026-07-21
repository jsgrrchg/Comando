import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";

import type { AiSessionSnapshot } from "@shared/ipc";
import {
    markChatPerformanceFrame,
    setChatPerformanceProbeEnabledForTests,
    type ChatPerformanceProbeEvent,
} from "@renderer/app/debug/chatPerformanceProbe";
import { ChatTimelineHistory } from "@renderer/components/workspace/ChatTabView";
import {
    createChatScrollCoordinator,
    type ChatScrollCoordinator,
} from "@renderer/components/workspace/chat/chatScrollCoordinator";
import type { MeasuredVirtualScrollRequest } from "@renderer/components/virtual/MeasuredVirtualList";
import type { ChatTimelineRow } from "@renderer/components/workspace/chat/chatTimelineModel";

import "@renderer/styles.css";
import "./transcript-harness.css";

const INITIAL_HISTORY_SIZE = 2_000;
const HISTORY_ROW_ID = "message:assistant-1999";
const STREAMING_ROW_ID = "message:assistant-live";

interface TranscriptHarnessSnapshot {
    readonly bottomGap: number;
    readonly clientHeight: number;
    readonly historyRowMounts: number;
    readonly historyRowUnmounts: number;
    readonly mountedHistoryRowIds: readonly string[];
    readonly scrollHeight: number;
    readonly scrollTop: number;
}

interface TranscriptDiagnosticSample extends TranscriptHarnessSnapshot {
    readonly frame: number;
    readonly frameDuration: number;
    readonly markdownContentChars: number;
    readonly markdownRenderedChars: number;
    readonly markdownStableChars: number;
    readonly measurementKey: string | null;
    readonly mountedRows: number;
    readonly pendingBlockPlaceholders: number;
    readonly phase: string;
    readonly rowKey: string | null;
    readonly viewportCovered: boolean;
}

interface TranscriptVirtualRangeEvent {
    readonly endIndex: number;
    readonly frame: number;
    readonly phase: string;
    readonly startIndex: number;
    readonly visibleEndIndex: number;
    readonly visibleStartIndex: number;
}

interface TranscriptDiagnosticEvent {
    readonly frame: number;
    readonly phase: string;
}

interface TranscriptScrollWrite extends TranscriptDiagnosticEvent {
    readonly value: number;
}

interface TranscriptStreamingViolations {
    readonly bottomGapFrames: readonly number[];
    readonly longTaskCount: number;
    readonly markdownLagFrames: readonly number[];
    readonly multiScrollWriteFrames: readonly number[];
}

interface TranscriptStreamingDiagnostic {
    readonly mutations: readonly TranscriptDiagnosticEvent[];
    readonly performanceEvents: readonly ChatPerformanceProbeEvent[];
    readonly resizeEvents: readonly TranscriptDiagnosticEvent[];
    readonly samples: readonly TranscriptDiagnosticSample[];
    readonly scrollWrites: readonly TranscriptScrollWrite[];
    readonly violations: TranscriptStreamingViolations;
    readonly virtualRanges: readonly TranscriptVirtualRangeEvent[];
}

interface TranscriptFastScrollViolations {
    readonly longTaskCount: number;
    readonly uncoveredViewportFrames: readonly number[];
}

interface TranscriptFastScrollDiagnostic {
    readonly longTasks: readonly TranscriptDiagnosticEvent[];
    readonly samples: readonly TranscriptDiagnosticSample[];
    readonly virtualRanges: readonly TranscriptVirtualRangeEvent[];
    readonly violations: TranscriptFastScrollViolations;
}

interface MutableTranscriptStreamingDiagnostic {
    longTasks: TranscriptDiagnosticEvent[];
    mutations: TranscriptDiagnosticEvent[];
    resizeEvents: TranscriptDiagnosticEvent[];
    samples: TranscriptDiagnosticSample[];
    scrollWrites: TranscriptScrollWrite[];
    virtualRanges: TranscriptVirtualRangeEvent[];
}

interface ComandoTranscriptHarness {
    appendDelta(delta: string): Promise<void>;
    runFastScrollDiagnostic(): Promise<TranscriptFastScrollDiagnostic>;
    runStreamingDiagnostic(): Promise<TranscriptStreamingDiagnostic>;
    snapshot(): TranscriptHarnessSnapshot;
    startTurn(): Promise<void>;
}

type PerformanceProbeRoot = typeof globalThis & {
    __comandoChatPerformanceProbeDump?: () => readonly ChatPerformanceProbeEvent[];
    __comandoChatPerformanceProbeReset?: () => void;
};

declare global {
    interface Window {
        comandoTranscriptHarness: ComandoTranscriptHarness;
    }
}

setChatPerformanceProbeEnabledForTests(true);

function waitForAnimationFrames(count: number): Promise<void> {
    return new Promise((resolve) => {
        const wait = (remaining: number) => {
            if (remaining <= 0) {
                resolve();
                return;
            }
            requestAnimationFrame(() => wait(remaining - 1));
        };
        wait(count);
    });
}

function createEmptyDiagnostic(): MutableTranscriptStreamingDiagnostic {
    return {
        longTasks: [],
        mutations: [],
        resizeEvents: [],
        samples: [],
        scrollWrites: [],
        virtualRanges: [],
    };
}

function isTranscriptViewportCovered(scrollElement: HTMLElement | null): boolean {
    if (!scrollElement) return false;

    const scrollRect = scrollElement.getBoundingClientRect();
    const historyElement = scrollElement.querySelector<HTMLElement>(
        "[data-chat-timeline-history]",
    );
    const historyRect = historyElement?.getBoundingClientRect();
    const scrollMarginTop = historyRect
        ? Math.max(
              0,
              historyRect.top - scrollRect.top + scrollElement.scrollTop,
          )
        : 0;
    const viewportTop = Math.max(0, scrollElement.scrollTop - scrollMarginTop);
    // The scroller reserves 24px at its trailing edge by design.
    const viewportBottom = viewportTop + scrollElement.clientHeight - 24;
    const intervals = [
        ...scrollElement.querySelectorAll<HTMLElement>(
            "[data-list-key]",
        ),
    ]
        .map((element) => {
            const match = /translateY\(([-\d.]+)px\)/.exec(
                element.style.transform,
            );
            if (!match) return null;
            const top = Number(match[1]);
            return {
                bottom: top + element.getBoundingClientRect().height,
                top,
            };
        })
        .filter(
            (interval): interval is { readonly bottom: number; readonly top: number } =>
                interval !== null &&
                interval.bottom > viewportTop &&
                interval.top < viewportBottom,
        )
        .map((interval) => ({
            bottom: Math.min(viewportBottom, interval.bottom),
            top: Math.max(viewportTop, interval.top),
        }))
        .sort((left, right) => left.top - right.top);

    let coveredBottom = viewportTop;
    for (const interval of intervals) {
        // Timeline rows intentionally reserve an 8px visual gap between cards.
        // Anything wider than that is an actual virtualized-content hole.
        if (interval.top > coveredBottom + 12) {
            return false;
        }
        coveredBottom = Math.max(coveredBottom, interval.bottom);
        if (coveredBottom >= viewportBottom - 12) {
            return true;
        }
    }

    return coveredBottom >= viewportBottom - 12;
}

function createMessageRow(
    id: string,
    content: string,
    kind: "assistant" | "user" = "assistant",
    status: AiSessionSnapshot["messages"][number]["status"] = "completed",
): ChatTimelineRow {
    const message: AiSessionSnapshot["messages"][number] = {
        attachments: [],
        content,
        createdAt: "2026-07-19T00:00:00.000Z",
        id,
        kind,
        status,
    };
    return { id: `message:${id}`, kind: "message", message };
}

function createInitialHistory(): readonly ChatTimelineRow[] {
    return Array.from({ length: INITIAL_HISTORY_SIZE }, (_, index) =>
        createMessageRow(
            `assistant-${index}`,
            `Historical assistant response ${index}. This content gives the row a measurable height.`,
        ),
    );
}

function readNumericDataset(
    element: HTMLElement | null,
    key: keyof DOMStringMap,
): number {
    return Number(element?.dataset[key] ?? 0);
}

function collectViolations(
    diagnostic: MutableTranscriptStreamingDiagnostic,
    performanceEvents: readonly ChatPerformanceProbeEvent[],
): TranscriptStreamingViolations {
    const writesByFrame = new Map<number, number>();
    for (const event of performanceEvents) {
        if (event.metric !== "scroll_write") {
            continue;
        }
        const frameTime = event.values.frameTime ?? 0;
        writesByFrame.set(frameTime, (writesByFrame.get(frameTime) ?? 0) + 1);
    }

    return {
        bottomGapFrames: diagnostic.samples
            .filter(
                (sample) =>
                    sample.phase.startsWith("stream-") &&
                    Math.abs(sample.bottomGap) > 2,
            )
            .map((sample) => sample.frame),
        longTaskCount: performanceEvents.filter(
            (event) => event.metric === "long_task",
        ).length,
        markdownLagFrames: diagnostic.samples
            .filter(
                (sample) =>
                    sample.markdownContentChars >
                    sample.markdownRenderedChars,
            )
            .map((sample) => sample.frame),
        multiScrollWriteFrames: [...writesByFrame.entries()]
            .filter(([, count]) => count > 1)
            .map(([frame]) => frame),
    };
}

function TranscriptHarness() {
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const lifecycle = useRef(new Map<string, { mounts: number; unmounts: number }>());
    const diagnostic = useRef<MutableTranscriptStreamingDiagnostic>(
        createEmptyDiagnostic(),
    );
    const diagnosticFrame = useRef(0);
    const diagnosticPhase = useRef("idle");
    const fastScrollActiveRef = useRef(false);
    const previousFrameAt = useRef(0);
    const [scrollCoordinator] = useState<ChatScrollCoordinator>(
        createChatScrollCoordinator,
    );
    const [historyRows, setHistoryRows] = useState(createInitialHistory);
    const [streamingText, setStreamingText] = useState<string | null>(null);

    const timelineItems = historyRows;
    const hotTailRow = useMemo<ChatTimelineRow | null>(
        () =>
            streamingText === null
                ? null
                : createMessageRow(
                "assistant-live",
                streamingText,
                "assistant",
                "streaming",
            ),
        [streamingText],
    );

    const snapshot = useCallback((): TranscriptHarnessSnapshot => {
        const scrollElement = scrollRef.current;
        const rowLifecycle = lifecycle.current.get(HISTORY_ROW_ID);
        const scrollHeight = scrollElement?.scrollHeight ?? 0;
        const scrollTop = scrollElement?.scrollTop ?? 0;
        const clientHeight = scrollElement?.clientHeight ?? 0;
        return {
            bottomGap: scrollHeight - clientHeight - scrollTop,
            clientHeight,
            historyRowMounts: rowLifecycle?.mounts ?? 0,
            historyRowUnmounts: rowLifecycle?.unmounts ?? 0,
            mountedHistoryRowIds: [
                ...document.querySelectorAll<HTMLElement>("[data-list-key]"),
            ].map((element) => element.dataset.listKey ?? ""),
            scrollHeight,
            scrollTop,
        };
    }, []);

    const recordSample = useCallback(
        (phase: string, frameAt: number) => {
            markChatPerformanceFrame(frameAt);
            diagnosticFrame.current += 1;
            diagnosticPhase.current = phase;
            const tail = document.querySelector<HTMLElement>(
                '[data-current-turn-tail="true"]',
            );
            const measured = tail?.closest<HTMLElement>(
                "[data-measurement-key]",
            );
            const markdown = tail?.querySelector<HTMLElement>(
                '[data-markdown-live="true"]',
            );
            diagnostic.current.samples.push({
                ...snapshot(),
                frame: diagnosticFrame.current,
                frameDuration:
                    previousFrameAt.current === 0
                        ? 0
                        : frameAt - previousFrameAt.current,
                markdownContentChars: readNumericDataset(
                    markdown ?? null,
                    "markdownContentChars",
                ),
                markdownRenderedChars: readNumericDataset(
                    markdown ?? null,
                    "markdownRenderedChars",
                ),
                markdownStableChars: readNumericDataset(
                    markdown ?? null,
                    "markdownStableChars",
                ),
                measurementKey: measured?.dataset.measurementKey ?? null,
                mountedRows: document.querySelectorAll("[data-list-key]").length,
                pendingBlockPlaceholders: document.querySelectorAll(
                    "[data-transcript-block-placeholder]",
                ).length,
                phase,
                rowKey:
                    measured?.dataset.listKey ??
                    tail?.dataset.hotTranscriptTail ??
                    null,
                viewportCovered: isTranscriptViewportCovered(scrollRef.current),
            });
            previousFrameAt.current = frameAt;
        },
        [snapshot],
    );

    const handleVirtualRangeChange = useCallback(
        (range: {
            readonly endIndex: number;
            readonly startIndex: number;
            readonly visibleEndIndex: number;
            readonly visibleStartIndex: number;
        }) => {
            diagnostic.current.virtualRanges.push({
                ...range,
                frame: diagnosticFrame.current,
                phase: diagnosticPhase.current,
            });
        },
        [],
    );

    const requestScroll = useCallback(
        (request: {
            readonly reason: "follow-end" | "measure-anchor" | "scroll-to-index";
            readonly target: "end" | number;
        }) => {
            scrollCoordinator.request(request, {
                element: scrollRef.current,
                navigationGeneration: 0,
                sessionId: "e2e-transcript",
            });
        },
        [scrollCoordinator],
    );

    const handleVirtualScrollRequest = useCallback(
        (request: MeasuredVirtualScrollRequest) => {
            requestScroll(request);
        },
        [requestScroll],
    );

    const handleVirtualResizeAutoFollow = useCallback(() => {
        requestScroll({ reason: "follow-end", target: "end" });
    }, [requestScroll]);

    const shouldSynchronizeVirtualScrollState = useCallback(
        () => fastScrollActiveRef.current,
        [],
    );

    const followEndNow = useCallback(() => {
        requestScroll({ reason: "follow-end", target: "end" });
        scrollCoordinator.flush();
    }, [requestScroll, scrollCoordinator]);

    useLayoutEffect(() => {
        followEndNow();
    }, [followEndNow, hotTailRow, timelineItems]);

    useEffect(() => {
        // Initial virtual geometry is asynchronous in this isolated harness.
        // Keep its bounded startup reconciliation separate from normal stream
        // updates, which are resolved synchronously in the layout effect above.
        // Pixel overscan can mount a wider first band than the old row-count
        // policy, so allow its asynchronous measurements to settle before the
        // harness starts a continuity scenario.
        let remainingFrames = 12;
        let followFrame: number | null = null;
        const followInitialGeometry = () => {
            followEndNow();
            remainingFrames -= 1;
            if (remainingFrames > 0) {
                followFrame = requestAnimationFrame(followInitialGeometry);
            }
        };
        followFrame = requestAnimationFrame(followInitialGeometry);

        return () => {
            if (followFrame !== null) {
                cancelAnimationFrame(followFrame);
            }
        };
    }, [followEndNow]);

    useEffect(() => {
        const scrollElement = scrollRef.current;
        if (!scrollElement) {
            return;
        }

        const trackedRow = scrollElement.querySelector<HTMLElement>(
            `[data-list-key="${HISTORY_ROW_ID}"]`,
        );
        if (trackedRow) {
            lifecycle.current.set(HISTORY_ROW_ID, { mounts: 1, unmounts: 0 });
        }
        const mutationObserver = new MutationObserver((records) => {
            for (const record of records) {
                for (const node of record.addedNodes) {
                    if (
                        node instanceof HTMLElement &&
                        (node.dataset.listKey === HISTORY_ROW_ID ||
                            node.querySelector(
                                `[data-list-key="${HISTORY_ROW_ID}"]`,
                            ))
                    ) {
                        const current = lifecycle.current.get(HISTORY_ROW_ID) ?? {
                            mounts: 0,
                            unmounts: 0,
                        };
                        lifecycle.current.set(HISTORY_ROW_ID, {
                            ...current,
                            mounts: current.mounts + 1,
                        });
                    }
                }
                for (const node of record.removedNodes) {
                    if (
                        node instanceof HTMLElement &&
                        (node.dataset.listKey === HISTORY_ROW_ID ||
                            node.querySelector(
                                `[data-list-key="${HISTORY_ROW_ID}"]`,
                            ))
                    ) {
                        const current = lifecycle.current.get(HISTORY_ROW_ID) ?? {
                            mounts: 0,
                            unmounts: 0,
                        };
                        lifecycle.current.set(HISTORY_ROW_ID, {
                            ...current,
                            unmounts: current.unmounts + 1,
                        });
                    }
                }
            }
            diagnostic.current.mutations.push({
                frame: diagnosticFrame.current,
                phase: diagnosticPhase.current,
            });
        });
        const resizeObserver = new ResizeObserver(() => {
            diagnostic.current.resizeEvents.push({
                frame: diagnosticFrame.current,
                phase: diagnosticPhase.current,
            });
        });
        mutationObserver.observe(scrollElement, { childList: true, subtree: true });
        resizeObserver.observe(scrollElement);
        const handleScroll = () => {
            diagnostic.current.scrollWrites.push({
                frame: diagnosticFrame.current,
                phase: diagnosticPhase.current,
                value: scrollElement.scrollTop,
            });
        };
        scrollElement.addEventListener("scroll", handleScroll);

        return () => {
            mutationObserver.disconnect();
            resizeObserver.disconnect();
            scrollElement.removeEventListener("scroll", handleScroll);
        };
    }, []);

    useEffect(() => {
        window.comandoTranscriptHarness = {
            appendDelta: async (delta) => {
                flushSync(() => {
                    setStreamingText((current) => (current ?? "") + delta);
                });
                await waitForAnimationFrames(3);
            },
            runFastScrollDiagnostic: async () => {
                const scrollElement = scrollRef.current;
                if (!scrollElement) {
                    throw new Error("Transcript scroll container is unavailable.");
                }

                // Do not race the harness's bounded initial bottom-follow loop.
                // The diagnostic must observe user scrolls, not startup writes.
                await waitForAnimationFrames(14);
                diagnostic.current = createEmptyDiagnostic();
                diagnosticFrame.current = 0;
                previousFrameAt.current = 0;
                fastScrollActiveRef.current = true;
                const maximum = Math.max(
                    0,
                    scrollElement.scrollHeight - scrollElement.clientHeight,
                );

                try {
                    for (const [index, progress] of [
                        0.12,
                        0.62,
                        0.28,
                        0.78,
                        0.18,
                        0.55,
                        0.36,
                        0.7,
                    ].entries()) {
                        diagnosticPhase.current = `fast-scroll-${index + 1}`;
                        scrollElement.scrollTop = Math.round(maximum * progress);
                        scrollElement.dispatchEvent(new Event("scroll"));
                        await new Promise<void>((resolve) => {
                            requestAnimationFrame((frameAt) => {
                                recordSample(diagnosticPhase.current, frameAt);
                                resolve();
                            });
                        });
                    }
                    await waitForAnimationFrames(2);

                    const samples = diagnostic.current.samples;
                    return {
                        longTasks: diagnostic.current.longTasks,
                        samples,
                        virtualRanges: diagnostic.current.virtualRanges,
                        violations: {
                            longTaskCount: diagnostic.current.longTasks.length,
                            uncoveredViewportFrames: samples
                                .filter(
                                    (sample) =>
                                        sample.phase.startsWith("fast-scroll-") &&
                                        !sample.viewportCovered,
                                )
                                .map((sample) => sample.frame),
                        },
                    };
                } finally {
                    fastScrollActiveRef.current = false;
                }
            },
            runStreamingDiagnostic: async () => {
                // The virtualizer needs a short bounded pass to settle the initial
                // bottom-follow geometry. Do not attribute those writes to streaming.
                await waitForAnimationFrames(14);
                const probeRoot = globalThis as PerformanceProbeRoot;
                probeRoot.__comandoChatPerformanceProbeReset?.();
                diagnostic.current = createEmptyDiagnostic();
                diagnosticFrame.current = 0;
                previousFrameAt.current = 0;
                let stopSampling = false;
                const sampling = new Promise<void>((resolve) => {
                    const sample = (frameAt: number) => {
                        recordSample(diagnosticPhase.current, frameAt);
                        if (stopSampling) {
                            resolve();
                            return;
                        }
                        requestAnimationFrame(sample);
                    };
                    requestAnimationFrame(sample);
                });

                diagnosticPhase.current = "turn-started";
                await window.comandoTranscriptHarness.startTurn();
                for (const [index, delta] of [
                    "## Streamed answer\n\n",
                    "A paragraph grows while the model streams.\n\n- first item",
                    "\n- second item\n\n| Name | Value |\n| --- | --- |\n| alpha | 1 |\n\n",
                    "```ts\nexport function streamed() {\n",
                    "    return true;\n}\n```\n",
                ].entries()) {
                    diagnosticPhase.current = `stream-${index + 1}`;
                    await window.comandoTranscriptHarness.appendDelta(delta);
                }
                await waitForAnimationFrames(4);
                stopSampling = true;
                await sampling;

                const performanceEvents = [
                    ...(probeRoot.__comandoChatPerformanceProbeDump?.() ?? []),
                ];
                return {
                    ...diagnostic.current,
                    performanceEvents,
                    violations: collectViolations(
                        diagnostic.current,
                        performanceEvents,
                    ),
                };
            },
            snapshot,
            startTurn: async () => {
                flushSync(() => {
                    setHistoryRows((current) => [
                        ...current,
                        createMessageRow("user-next-turn", "Next prompt", "user"),
                    ]);
                    setStreamingText("");
                });
                await waitForAnimationFrames(3);
            },
        };
    }, [recordSample, snapshot]);

    useEffect(() => {
        if (
            typeof PerformanceObserver === "undefined" ||
            !PerformanceObserver.supportedEntryTypes?.includes("longtask")
        ) {
            return;
        }

        const observer = new PerformanceObserver(() => {
            diagnostic.current.longTasks.push({
                frame: diagnosticFrame.current,
                phase: diagnosticPhase.current,
            });
        });
        observer.observe({ entryTypes: ["longtask"] });

        return () => observer.disconnect();
    }, []);

    return (
        <main className="transcript-harness">
            <div className="transcript-scroll chat-scroll" ref={scrollRef}>
                <div className="min-w-0 space-y-2">
                    <ChatTimelineHistory
                        active
                        historyRows={timelineItems}
                        hotTailRowId={hotTailRow?.id ?? null}
                        hotTailRows={hotTailRow ? [hotTailRow] : []}
                        liveTailRowId={
                            streamingText === null ? null : STREAMING_ROW_ID
                        }
                        newTurnAnchorRowId={null}
                        onVirtualScrollRequest={handleVirtualScrollRequest}
                        onOpenFile={() => Promise.resolve()}
                        onOpenImage={() => Promise.resolve()}
                        onOpenResolvedFileReference={() => undefined}
                        onSetActivityGroupExpanded={() => undefined}
                        onSetActivityRangeExpanded={() => undefined}
                        onVirtualRangeChange={handleVirtualRangeChange}
                        onVirtualResizeAutoFollow={handleVirtualResizeAutoFollow}
                        projectId={null}
                        resolveFileReference={() => null}
                        scrollRef={scrollRef}
                        sessionId="e2e-transcript"
                        showStreamingIndicator={streamingText !== null}
                        shouldSynchronizeVirtualScrollState={
                            shouldSynchronizeVirtualScrollState
                        }
                        streamingStartedAt={null}
                        worktreeId={null}
                    />
                </div>
            </div>
        </main>
    );
}

createRoot(document.getElementById("root")!).render(<TranscriptHarness />);
