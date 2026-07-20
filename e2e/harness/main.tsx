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
import { ChatTimelineHistoryRows } from "@renderer/components/workspace/chat/ChatTimelineHistoryRows";
import type { ChatTimelineRow } from "@renderer/components/workspace/chat/chatTimelineModel";

import "@renderer/styles.css";
import "./transcript-harness.css";

const INITIAL_HISTORY_SIZE = 2_000;
const HISTORY_ROW_ID = "message:assistant-1999";

interface TranscriptHarnessSnapshot {
    readonly historyRowMounts: number;
    readonly historyRowUnmounts: number;
    readonly mountedHistoryRowIds: readonly string[];
    readonly scrollHeight: number;
    readonly scrollTop: number;
}

interface TranscriptDiagnosticSample extends TranscriptHarnessSnapshot {
    readonly frame: number;
    readonly phase: string;
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

interface TranscriptStreamingDiagnostic {
    readonly mutations: readonly TranscriptDiagnosticEvent[];
    readonly resizeEvents: readonly TranscriptDiagnosticEvent[];
    readonly samples: readonly TranscriptDiagnosticSample[];
    readonly scrollWrites: readonly TranscriptScrollWrite[];
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

declare global {
    interface Window {
        comandoTranscriptHarness: ComandoTranscriptHarness;
    }
}

function nextPaint(): Promise<void> {
    return new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
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
): ChatTimelineRow {
    const message: AiSessionSnapshot["messages"][number] = {
        attachments: [],
        content,
        createdAt: "2026-07-19T00:00:00.000Z",
        id,
        kind,
        status: "completed",
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

function TranscriptHarness() {
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const lifecycle = useRef(new Map<string, { mounts: number; unmounts: number }>());
    const diagnostic = useRef<MutableTranscriptStreamingDiagnostic>(
        createEmptyDiagnostic(),
    );
    const diagnosticFrame = useRef(0);
    const diagnosticPhase = useRef("idle");
    const [historyRows, setHistoryRows] = useState(createInitialHistory);
    const [streamingText, setStreamingText] = useState("");

    const historyRow = useMemo(
        () => historyRows.find((row) => row.id === HISTORY_ROW_ID) ?? null,
        [historyRows],
    );

    useLayoutEffect(() => {
        const scrollElement = scrollRef.current;
        if (!scrollElement) {
            return;
        }
        scrollElement.scrollTop = scrollElement.scrollHeight;
        scrollElement.dispatchEvent(new Event("scroll"));
    }, [historyRows.length, streamingText]);

    const snapshot = useCallback((): TranscriptHarnessSnapshot => {
        const scrollElement = scrollRef.current;
        const rowLifecycle = lifecycle.current.get(HISTORY_ROW_ID);
        return {
            historyRowMounts: rowLifecycle?.mounts ?? 0,
            historyRowUnmounts: rowLifecycle?.unmounts ?? 0,
            mountedHistoryRowIds: [
                ...document.querySelectorAll<HTMLElement>("[data-history-row-id]"),
            ].map((element) => element.dataset.historyRowId ?? ""),
            scrollHeight: scrollElement?.scrollHeight ?? 0,
            scrollTop: scrollElement?.scrollTop ?? 0,
        };
    }, []);

    const recordSample = useCallback(
        (phase: string) => {
            diagnosticFrame.current += 1;
            diagnosticPhase.current = phase;
            diagnostic.current.samples.push({
                ...snapshot(),
                frame: diagnosticFrame.current,
                phase,
            });
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

    useEffect(() => {
        const scrollElement = scrollRef.current;
        if (!scrollElement) {
            return;
        }

        const mutationObserver = new MutationObserver(() => {
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
        const liveTail = scrollElement.querySelector<HTMLElement>(".live-tail");
        if (liveTail) {
            resizeObserver.observe(liveTail);
        }
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
                    setStreamingText((current) => current + delta);
                });
                await nextPaint();
            },
            runStreamingDiagnostic: async () => {
                diagnostic.current = createEmptyDiagnostic();
                diagnosticFrame.current = 0;
                recordSample("before-turn");
                diagnosticPhase.current = "turn-started";
                await window.comandoTranscriptHarness.startTurn();
                recordSample("turn-started");

                for (const [index, delta] of [
                    "First streamed chunk. ",
                    "Second streamed chunk changes the live tail height. ",
                    "Third streamed chunk adds enough content to trigger another measurement.",
                ].entries()) {
                    diagnosticPhase.current = `stream-${index + 1}`;
                    await window.comandoTranscriptHarness.appendDelta(delta);
                    recordSample(`stream-${index + 1}`);
                }

                return diagnostic.current;
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
                await nextPaint();
            },
        };
    }, [recordSample, snapshot]);

    if (!historyRow) {
        throw new Error("expected the tracked historical row");
    }

    return (
        <main className="transcript-harness">
            <div className="transcript-scroll" ref={scrollRef}>
                <ChatTimelineHistoryRows
                    historyRows={historyRows}
                    onVirtualRangeChange={handleVirtualRangeChange}
                    renderRow={({ row }) => <TranscriptRow lifecycle={lifecycle.current} row={row} />}
                    scrollRef={scrollRef}
                    sessionId="e2e-transcript"
                />
                <article className="live-tail" data-testid="live-tail">
                    {streamingText || "Waiting for a streamed response…"}
                </article>
            </div>
        </main>
    );
}

function TranscriptRow({
    lifecycle,
    row,
}: {
    readonly lifecycle: Map<string, { mounts: number; unmounts: number }>;
    readonly row: ChatTimelineRow;
}) {
    useEffect(() => {
        const current = lifecycle.get(row.id) ?? { mounts: 0, unmounts: 0 };
        lifecycle.set(row.id, { ...current, mounts: current.mounts + 1 });
        return () => {
            const next = lifecycle.get(row.id) ?? { mounts: 0, unmounts: 0 };
            lifecycle.set(row.id, { ...next, unmounts: next.unmounts + 1 });
        };
    }, [lifecycle, row.id]);

    return (
        <article className="transcript-row" data-history-row-id={row.id}>
            {row.kind === "message" ? row.message.content : row.id}
        </article>
    );
}

createRoot(document.getElementById("root")!).render(<TranscriptHarness />);
