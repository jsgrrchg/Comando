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
import { createChatLoadFixture } from "@shared/testing/chatLoadFactories";
import {
    createChatLoadDiagnosticSummary,
    type ChatLoadDiagnosticSummary,
    type ChatLoadScenario,
} from "@shared/testing/chatLoadScenario";
import { applyAiTranscriptMemoryPressure } from "@renderer/app/store/ai-store";
import {
    readChatPerformanceCounters,
    resetChatPerformanceCounters,
    type ChatPerformanceCounterSnapshot,
} from "@renderer/app/debug/chatPerformanceCounters";
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
import { reconcileChatTimelineModel } from "@renderer/components/workspace/chat/chatTimelineModel";
import {
    flattenTranscriptTimelineItems,
    type TranscriptTimelineItem,
} from "@renderer/components/workspace/chat/transcriptBlockVirtualization";

import "@renderer/styles.css";
import "./transcript-harness.css";

const INITIAL_HISTORY_SIZE = 2_000;
const INITIAL_HISTORY_SCENARIO = {
    activeTools: 0,
    aggregateDiffBytes: 0,
    deltaBytes: 0,
    diffCount: 0,
    historyMessages: INITIAL_HISTORY_SIZE,
    seed: 2_000,
    sessionCount: 1,
    streamingDeltas: 0,
    terminalOutputBytes: 0,
} satisfies ChatLoadScenario;
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
    readonly loadScenario: ChatLoadDiagnosticSummary;
    readonly mutations: readonly TranscriptDiagnosticEvent[];
    readonly performanceEvents: readonly ChatPerformanceProbeEvent[];
    readonly resizeEvents: readonly TranscriptDiagnosticEvent[];
    readonly samples: readonly TranscriptDiagnosticSample[];
    readonly scrollWrites: readonly TranscriptScrollWrite[];
    readonly violations: TranscriptStreamingViolations;
    readonly virtualRanges: readonly TranscriptVirtualRangeEvent[];
    readonly workCounters: ChatPerformanceCounterSnapshot;
}

interface TranscriptFastScrollViolations {
    readonly longTaskCount: number;
    readonly uncoveredViewportFrames: readonly number[];
}

interface TranscriptFastScrollDiagnostic {
    readonly loadScenario: ChatLoadDiagnosticSummary;
    readonly longTasks: readonly TranscriptDiagnosticEvent[];
    readonly samples: readonly TranscriptDiagnosticSample[];
    readonly virtualRanges: readonly TranscriptVirtualRangeEvent[];
    readonly violations: TranscriptFastScrollViolations;
    readonly workCounters: ChatPerformanceCounterSnapshot;
}

export interface TranscriptHarnessScenarioConfig extends ChatLoadScenario {
    readonly expandTools?: boolean;
    readonly sessionIndex?: number;
}

export interface TranscriptStreamingConfig {
    readonly deltaLimit?: number;
    readonly finalText?: string;
}

export interface TranscriptScrollPattern {
    readonly positions: readonly number[];
}

interface TranscriptHarnessMetrics {
    readonly loadScenario: ChatLoadDiagnosticSummary;
    readonly performanceEvents: readonly ChatPerformanceProbeEvent[];
    readonly samples: readonly TranscriptDiagnosticSample[];
    readonly scrollWrites: readonly TranscriptScrollWrite[];
    readonly snapshot: TranscriptHarnessSnapshot;
    readonly virtualRanges: readonly TranscriptVirtualRangeEvent[];
    readonly workCounters: ChatPerformanceCounterSnapshot;
}

interface TranscriptResourceMetrics {
    readonly activeResizeObservers: number | null;
    readonly domNodes: number;
    readonly heapUsedBytes: number | null;
    readonly residentBlocks: number;
    readonly residentPayloadBytes: number;
    readonly retainedArtifacts: number;
}

interface TranscriptSessionCycleSample extends TranscriptResourceMetrics {
    readonly cycle: number;
}

interface TranscriptSessionCyclesDiagnostic {
    readonly samples: readonly TranscriptSessionCycleSample[];
    readonly steadyState: {
        readonly firstHeapUsedBytes: number | null;
        readonly heapGrowthRatio: number | null;
        readonly lastHeapUsedBytes: number | null;
        readonly maxActiveResizeObservers: number | null;
        readonly maxDomNodes: number;
        readonly maxResidentBlocks: number;
        readonly maxResidentPayloadBytes: number;
        readonly maxRetainedArtifacts: number;
    };
}

interface TranscriptSoakConfig {
    readonly durationMs?: number;
    readonly sampleIntervalMs?: number;
}

interface TranscriptSoakDiagnostic {
    readonly cycles: number;
    readonly durationMs: number;
    readonly samples: readonly TranscriptSessionCycleSample[];
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
    applyMemoryPressure(): Promise<void>;
    appendDelta(delta: string): Promise<void>;
    collectMetrics(): TranscriptHarnessMetrics;
    loadScenario(config: TranscriptHarnessScenarioConfig): Promise<void>;
    runSessionCycles(cycles?: number): Promise<TranscriptSessionCyclesDiagnostic>;
    runSoakDiagnostic(config?: TranscriptSoakConfig): Promise<TranscriptSoakDiagnostic>;
    runFastScrollDiagnostic(): Promise<TranscriptFastScrollDiagnostic>;
    runScrollPattern(pattern: TranscriptScrollPattern): Promise<void>;
    runStreamingDiagnostic(): Promise<TranscriptStreamingDiagnostic>;
    snapshot(): TranscriptHarnessSnapshot;
    startStreaming(config?: TranscriptStreamingConfig): Promise<void>;
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

let activeResizeObserverCount = 0;
const NativeResizeObserver = globalThis.ResizeObserver;

if (NativeResizeObserver) {
    // Browser APIs do not expose observer liveness. Wrapping it in the isolated
    // harness lets the soak test catch observers retained after a tab switch.
    class TrackedResizeObserver implements ResizeObserver {
        private readonly observed = new Set<Element>();
        private readonly nativeObserver: ResizeObserver;

        constructor(callback: ResizeObserverCallback) {
            this.nativeObserver = new NativeResizeObserver(callback);
        }

        disconnect() {
            activeResizeObserverCount -= this.observed.size;
            this.observed.clear();
            this.nativeObserver.disconnect();
        }

        observe(target: Element, options?: ResizeObserverOptions) {
            if (!this.observed.has(target)) {
                this.observed.add(target);
                activeResizeObserverCount += 1;
            }
            this.nativeObserver.observe(target, options);
        }

        unobserve(target: Element) {
            if (this.observed.delete(target)) {
                activeResizeObserverCount -= 1;
            }
            this.nativeObserver.unobserve(target);
        }
    }

    globalThis.ResizeObserver = TrackedResizeObserver;
}

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

function waitForMilliseconds(milliseconds: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function readHeapUsedBytes(): number | null {
    const memory = (performance as Performance & {
        memory?: { readonly usedJSHeapSize?: number };
    }).memory;
    return typeof memory?.usedJSHeapSize === "number"
        ? memory.usedJSHeapSize
        : null;
}

function countFixturePayloadBytes(items: readonly TranscriptTimelineItem[]): number {
    let bytes = 0;
    for (const item of items) {
        if (item.kind !== "activity-entry" || item.item.kind !== "tool") continue;
        const activity = item.item.entry.reviewEntry.activity;
        bytes += new TextEncoder().encode(activity.terminalOutput ?? "").byteLength;
        bytes += activity.diffs.reduce(
            (total, diff) =>
                total + (diff.newText?.length ?? 0) + (diff.oldText?.length ?? 0),
            0,
        );
    }
    return bytes;
}

function describeSteadyState(
    samples: readonly TranscriptSessionCycleSample[],
): TranscriptSessionCyclesDiagnostic["steadyState"] {
    const steadySamples = samples.slice(10);
    const firstHeapUsedBytes = steadySamples[0]?.heapUsedBytes ?? null;
    const lastHeapUsedBytes = steadySamples.at(-1)?.heapUsedBytes ?? null;
    return {
        firstHeapUsedBytes,
        heapGrowthRatio:
            firstHeapUsedBytes && lastHeapUsedBytes
                ? (lastHeapUsedBytes - firstHeapUsedBytes) / firstHeapUsedBytes
                : null,
        lastHeapUsedBytes,
        maxActiveResizeObservers: steadySamples.every(
            (sample) => sample.activeResizeObservers === null,
        )
            ? null
            : Math.max(
                  ...steadySamples.map(
                      (sample) => sample.activeResizeObservers ?? 0,
                  ),
              ),
        maxDomNodes: Math.max(0, ...steadySamples.map((sample) => sample.domNodes)),
        maxResidentBlocks: Math.max(
            0,
            ...steadySamples.map((sample) => sample.residentBlocks),
        ),
        maxResidentPayloadBytes: Math.max(
            0,
            ...steadySamples.map((sample) => sample.residentPayloadBytes),
        ),
        maxRetainedArtifacts: Math.max(
            0,
            ...steadySamples.map((sample) => sample.retainedArtifacts),
        ),
    };
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
    return { blockId: null, id: `message:${id}`, kind: "message", message };
}

function createInitialHistory(): readonly ChatTimelineRow[] {
    const fixture = createChatLoadFixture(INITIAL_HISTORY_SCENARIO);
    const messages = fixture.sessions[0]?.messages ?? [];
    return messages.map((message, index) =>
        createMessageRow(
            `assistant-${index}`,
            `Historical assistant response ${index}. Deterministic token ${message.content.slice(-16)} gives the row a measurable height.`,
        ),
    );
}

function createScenarioTimeline(
    config: TranscriptHarnessScenarioConfig,
): {
    readonly deltas: readonly string[];
    readonly items: readonly TranscriptTimelineItem[];
    readonly summary: ChatLoadDiagnosticSummary;
} {
    const fixture = createChatLoadFixture(config);
    const sessionIndex = Math.min(
        Math.max(0, Math.floor(config.sessionIndex ?? 0)),
        fixture.sessions.length - 1,
    );
    const session = fixture.sessions[sessionIndex];
    if (!session) {
        throw new Error("Transcript scenario did not create a session.");
    }
    const model = reconcileChatTimelineModel(null, {
        messages: session.messages,
        status: "idle",
        toolActivity: session.toolActivity,
        trackedFiles: [],
    });

    return {
        deltas: session.streamingDeltas,
        // The harness begins collapsed, matching a cold chat view. Scenarios
        // can still exercise virtual scroll without materializing every tool.
        items: flattenTranscriptTimelineItems(model.orderedRows, {
            defaultExpanded: config.expandTools ?? false,
            expansionByGroupId: {},
        }),
        summary: createChatLoadDiagnosticSummary(config),
    };
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
    const scenarioSummaryRef = useRef<ChatLoadDiagnosticSummary>(
        createChatLoadDiagnosticSummary(INITIAL_HISTORY_SCENARIO),
    );
    const scenarioDeltasRef = useRef<readonly string[]>([]);
    const scenarioItemsRef = useRef<readonly TranscriptTimelineItem[]>([]);
    const [scrollCoordinator] = useState<ChatScrollCoordinator>(
        createChatScrollCoordinator,
    );
    const [historyRows, setHistoryRows] = useState<
        readonly TranscriptTimelineItem[]
    >(createInitialHistory);
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

    const collectResourceMetrics = useCallback((): TranscriptResourceMetrics => {
        const mountedRows = document.querySelectorAll("[data-list-key]").length;
        return {
            activeResizeObservers: NativeResizeObserver
                ? activeResizeObserverCount
                : null,
            domNodes: document.querySelectorAll("*").length,
            heapUsedBytes: readHeapUsedBytes(),
            // Mounted virtual rows are the renderer's resident transcript blocks.
            // The complete fixture remains in a ref only for deterministic reloads.
            residentBlocks: mountedRows,
            residentPayloadBytes: countFixturePayloadBytes(
                scenarioItemsRef.current,
            ),
            retainedArtifacts:
                scenarioItemsRef.current.length + scenarioDeltasRef.current.length,
        };
    }, []);

    const forceGarbageCollection = useCallback(async () => {
        const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
        // Chromium exposes gc only when the diagnostic runner asks for it.
        // Repeating it avoids sampling an object that was promoted one cycle ago.
        gc?.();
        await waitForAnimationFrames(1);
        gc?.();
        await waitForAnimationFrames(1);
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
            readonly reason:
                | "follow-end"
                | "measure-anchor"
                | "restore"
                | "scroll-to-index";
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
            applyMemoryPressure: async () => {
                applyAiTranscriptMemoryPressure(0);
                await waitForAnimationFrames(2);
            },
            appendDelta: async (delta) => {
                flushSync(() => {
                    setStreamingText((current) => (current ?? "") + delta);
                });
                await waitForAnimationFrames(3);
            },
            collectMetrics: () => {
                const probeRoot = globalThis as PerformanceProbeRoot;
                return {
                    loadScenario: scenarioSummaryRef.current,
                    performanceEvents: [
                        ...(probeRoot.__comandoChatPerformanceProbeDump?.() ?? []),
                    ],
                    samples: [...diagnostic.current.samples],
                    scrollWrites: [...diagnostic.current.scrollWrites],
                    snapshot: snapshot(),
                    virtualRanges: [...diagnostic.current.virtualRanges],
                    workCounters: readChatPerformanceCounters(),
                };
            },
            loadScenario: async (config) => {
                const next = createScenarioTimeline(config);
                scenarioSummaryRef.current = next.summary;
                scenarioDeltasRef.current = next.deltas;
                scenarioItemsRef.current = next.items;
                diagnostic.current = createEmptyDiagnostic();
                diagnosticFrame.current = 0;
                previousFrameAt.current = 0;
                resetChatPerformanceCounters();
                flushSync(() => {
                    setHistoryRows(next.items);
                    setStreamingText(null);
                });
                await waitForAnimationFrames(4);
            },
            runSessionCycles: async (cycles = 50) => {
                const samples: TranscriptSessionCycleSample[] = [];
                const cycleCount = Math.max(1, Math.floor(cycles));
                const scenario = {
                    activeTools: 24,
                    aggregateDiffBytes: 384 * 1024,
                    deltaBytes: 768,
                    diffCount: 12,
                    expandTools: true,
                    historyMessages: 512,
                    seed: 7_027,
                    sessionCount: 2,
                    streamingDeltas: 4,
                    terminalOutputBytes: 128 * 1024,
                } satisfies TranscriptHarnessScenarioConfig;

                for (let cycle = 0; cycle < cycleCount; cycle += 1) {
                    await window.comandoTranscriptHarness.loadScenario({
                        ...scenario,
                        sessionIndex: cycle % scenario.sessionCount,
                    });
                    await window.comandoTranscriptHarness.runScrollPattern({
                        positions: [1, 0.25, 0.75, 1],
                    });
                    await window.comandoTranscriptHarness.startStreaming({
                        deltaLimit: 2,
                        finalText: "\n\n```ts\nexport const cycle = true;\n```\n",
                    });
                    await window.comandoTranscriptHarness.applyMemoryPressure();
                    await forceGarbageCollection();
                    samples.push({ cycle: cycle + 1, ...collectResourceMetrics() });
                }

                return { samples, steadyState: describeSteadyState(samples) };
            },
            runSoakDiagnostic: async (config = {}) => {
                const durationMs = config.durationMs ?? 30 * 60 * 1_000;
                const sampleIntervalMs = config.sampleIntervalMs ?? 30_000;
                const startedAt = performance.now();
                const samples: TranscriptSessionCycleSample[] = [];
                let cycle = 0;
                let nextSampleAt = startedAt;

                while (performance.now() - startedAt < durationMs) {
                    await window.comandoTranscriptHarness.runSessionCycles(1);
                    cycle += 1;
                    const now = performance.now();
                    if (now >= nextSampleAt) {
                        await forceGarbageCollection();
                        samples.push({ cycle, ...collectResourceMetrics() });
                        nextSampleAt = now + sampleIntervalMs;
                    }
                    // This keeps the soak representative of a live renderer instead
                    // of turning it into an unrealistic tight-loop CPU benchmark.
                    await waitForMilliseconds(250);
                }

                return { cycles: cycle, durationMs, samples };
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
                resetChatPerformanceCounters();
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
                        loadScenario: createChatLoadDiagnosticSummary(
                            INITIAL_HISTORY_SCENARIO,
                        ),
                        longTasks: diagnostic.current.longTasks,
                        samples,
                        workCounters: readChatPerformanceCounters(),
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
                resetChatPerformanceCounters();
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
                    loadScenario: createChatLoadDiagnosticSummary(
                        INITIAL_HISTORY_SCENARIO,
                    ),
                    performanceEvents,
                    workCounters: readChatPerformanceCounters(),
                    violations: collectViolations(
                        diagnostic.current,
                        performanceEvents,
                    ),
                };
            },
            runScrollPattern: async (pattern) => {
                const scrollElement = scrollRef.current;
                if (!scrollElement) {
                    throw new Error("Transcript scroll container is unavailable.");
                }
                const maximum = Math.max(
                    0,
                    scrollElement.scrollHeight - scrollElement.clientHeight,
                );
                for (const [index, position] of pattern.positions.entries()) {
                    diagnosticPhase.current = `scroll-pattern-${index + 1}`;
                    scrollElement.scrollTop = Math.round(
                        Math.min(1, Math.max(0, position)) * maximum,
                    );
                    scrollElement.dispatchEvent(new Event("scroll"));
                    await new Promise<void>((resolve) => {
                        requestAnimationFrame((frameAt) => {
                            recordSample(diagnosticPhase.current, frameAt);
                            resolve();
                        });
                    });
                }
            },
            snapshot,
            startStreaming: async (config = {}) => {
                await window.comandoTranscriptHarness.startTurn();
                const deltas = scenarioDeltasRef.current.slice(
                    0,
                    config.deltaLimit ?? scenarioDeltasRef.current.length,
                );
                for (const delta of deltas) {
                    await window.comandoTranscriptHarness.appendDelta(delta);
                }
                if (config.finalText) {
                    await window.comandoTranscriptHarness.appendDelta(
                        config.finalText,
                    );
                }
            },
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
