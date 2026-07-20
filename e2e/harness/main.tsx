import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";

import type { AiSessionSnapshot } from "@shared/ipc";
import {
    markChatPerformanceFrame,
    recordChatScrollWrite,
    setChatPerformanceProbeEnabledForTests,
    type ChatPerformanceProbeEvent,
} from "@renderer/app/debug/chatPerformanceProbe";
import { ChatTimelineHistory } from "@renderer/components/workspace/ChatTabView";
import type { ChatTimelineRow } from "@renderer/components/workspace/chat/chatTimelineModel";
import {
    createTranscriptStreamingIndicatorItem,
    type TranscriptTimelineItem,
} from "@renderer/components/workspace/chat/transcriptBlockVirtualization";

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
    readonly phase: string;
    readonly rowKey: string | null;
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

interface MutableTranscriptStreamingDiagnostic {
    mutations: TranscriptDiagnosticEvent[];
    resizeEvents: TranscriptDiagnosticEvent[];
    samples: TranscriptDiagnosticSample[];
    scrollWrites: TranscriptScrollWrite[];
    virtualRanges: TranscriptVirtualRangeEvent[];
}

interface ComandoTranscriptHarness {
    appendDelta(delta: string): Promise<void>;
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
        mutations: [],
        resizeEvents: [],
        samples: [],
        scrollWrites: [],
        virtualRanges: [],
    };
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
    const previousFrameAt = useRef(0);
    const bottomFollowFrameRef = useRef<number | null>(null);
    const [historyRows, setHistoryRows] = useState(createInitialHistory);
    const [streamingText, setStreamingText] = useState<string | null>(null);

    const timelineItems = useMemo<readonly TranscriptTimelineItem[]>(() => {
        if (streamingText === null) {
            return historyRows;
        }
        return [
            ...historyRows,
            createMessageRow(
                "assistant-live",
                streamingText,
                "assistant",
                "streaming",
            ),
            createTranscriptStreamingIndicatorItem("0s"),
        ];
    }, [historyRows, streamingText]);

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
                phase,
                rowKey: measured?.dataset.listKey ?? null,
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

    const writeToBottom = useCallback((reason: "follow-end" | "settle") => {
        const scrollElement = scrollRef.current;
        if (!scrollElement) {
            return;
        }
        const before = scrollElement.scrollTop;
        const after = Math.max(
            0,
            scrollElement.scrollHeight - scrollElement.clientHeight,
        );
        if (Math.abs(after - before) < 1) {
            return;
        }
        scrollElement.scrollTop = after;
        recordChatScrollWrite({
            after,
            before,
            clientHeight: scrollElement.clientHeight,
            navigationGeneration: 0,
            reason,
            scrollHeight: scrollElement.scrollHeight,
            sessionId: "e2e-transcript",
        });
    }, []);

    const scheduleBottomFollow = useCallback(() => {
        if (bottomFollowFrameRef.current !== null) {
            return;
        }
        let remainingFrames = 4;
        const follow = () => {
            bottomFollowFrameRef.current = null;
            writeToBottom(remainingFrames === 4 ? "follow-end" : "settle");
            remainingFrames -= 1;
            if (remainingFrames > 0) {
                bottomFollowFrameRef.current = requestAnimationFrame(follow);
            }
        };
        bottomFollowFrameRef.current = requestAnimationFrame(follow);
    }, [writeToBottom]);

    useEffect(() => {
        scheduleBottomFollow();
    }, [scheduleBottomFollow, timelineItems]);

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
            runStreamingDiagnostic: async () => {
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

    return (
        <main className="transcript-harness">
            <div className="transcript-scroll chat-scroll" ref={scrollRef}>
                <div className="min-w-0 space-y-2">
                    <ChatTimelineHistory
                        active
                        historyRows={timelineItems}
                        liveTailRowId={
                            streamingText === null ? null : STREAMING_ROW_ID
                        }
                        newTurnAnchorRowId={null}
                        onOpenFile={() => Promise.resolve()}
                        onOpenImage={() => Promise.resolve()}
                        onOpenResolvedFileReference={() => undefined}
                        onSetActivityGroupExpanded={() => undefined}
                        onSetActivityRangeExpanded={() => undefined}
                        onVirtualRangeChange={handleVirtualRangeChange}
                        onVirtualResizeAutoFollow={scheduleBottomFollow}
                        projectId={null}
                        resolveFileReference={() => null}
                        scrollRef={scrollRef}
                        sessionId="e2e-transcript"
                        worktreeId={null}
                    />
                </div>
            </div>
        </main>
    );
}

createRoot(document.getElementById("root")!).render(<TranscriptHarness />);
