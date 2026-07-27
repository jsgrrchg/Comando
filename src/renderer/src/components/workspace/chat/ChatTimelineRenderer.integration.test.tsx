/** @vitest-environment jsdom */
import { act, useEffect, type RefObject } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AiToolActivity } from "@shared/ipc";
import {
    readChatPerformanceCounters,
    resetChatPerformanceCounters,
    setChatPerformanceCountersEnabledForTests,
} from "@renderer/app/debug/chatPerformanceCounters";
import { TranscriptPayloadCache } from "@renderer/app/ai/transcriptPayloadCache";

import { ChatTranscriptSurface } from "./ChatTranscriptSurface";
import { ChatTimelineHistoryRows, type ChatTimelineSemanticAnchor } from "./ChatTimelineHistoryRows";
import { reconcileChatTimelineModel } from "./chatTimelineModel";
import {
    flattenTranscriptTimelineItems,
    type TranscriptTimelineItem,
    type TranscriptTimelineVirtualRow,
} from "./transcriptBlockVirtualization";

const SESSION_ID = "renderer-integration";
const VIEWPORT_HEIGHT = 240;
const ROW_HEIGHT = 28;
let measuredTimelineWidth = 640;

class FakeResizeObserver {
    static readonly instances: FakeResizeObserver[] = [];
    private readonly observed = new Set<Element>();

    constructor(private readonly callback: ResizeObserverCallback) {
        FakeResizeObserver.instances.push(this);
    }

    disconnect() {
        this.observed.clear();
    }

    observe(element: Element) {
        this.observed.add(element);
    }

    unobserve() {}

    static reset() {
        FakeResizeObserver.instances.length = 0;
    }

    static get connected() {
        return FakeResizeObserver.instances.reduce(
            (total, observer) => total + observer.observed.size,
            0,
        );
    }

    // The harness controls layout; exposing this keeps the stub compatible with
    // future tests that need to exercise a width report.
    emit() {
        this.callback([], this);
    }
}

function createActivity(index: number): AiToolActivity {
    const timestamp = `2026-07-26T00:00:${String(index % 60).padStart(2, "0")}.000Z`;
    return {
        createdAt: timestamp,
        diffs: [],
        exitCode: null,
        id: `tool-${index}`,
        kind: "read",
        locations: [],
        rawInputJson: JSON.stringify({ file_path: `src/file-${index}.ts` }),
        rawOutputJson: null,
        sessionId: SESSION_ID,
        status: "completed",
        summary: null,
        terminalOutput: null,
        title: `Read src/file-${index}.ts`,
        updatedAt: timestamp,
    };
}

function createToolRows(count = 500): readonly TranscriptTimelineItem[] {
    const model = reconcileChatTimelineModel(null, {
        messages: [],
        status: "idle",
        toolActivity: Array.from({ length: count }, (_, index) => createActivity(index)),
        trackedFiles: [],
    });

    const groupId = model.orderedRows[0]?.id;
    if (!groupId) throw new Error("expected the activity segment");
    return flattenTranscriptTimelineItems(model.orderedRows, {
        activeGroupId: groupId,
        defaultExpanded: true,
        expansionByGroupId: {
            [groupId]: { expandedRangeStarts: [0, 200, 400] },
        },
    });
}

function defineLayout(element: HTMLElement, values: {
    readonly clientHeight?: number;
    readonly clientWidth?: number;
    readonly scrollHeight?: number;
}) {
    for (const [key, value] of Object.entries(values)) {
        Object.defineProperty(element, key, {
            configurable: true,
            get: () => value,
        });
    }
    element.getBoundingClientRect = () => ({
        bottom: values.clientHeight ?? 0,
        height: values.clientHeight ?? 0,
        left: 0,
        right: values.clientWidth ?? 0,
        top: 0,
        width: values.clientWidth ?? 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
    });
}

function isSemanticAnchor(value: unknown): value is ChatTimelineSemanticAnchor {
    return typeof value === "object" &&
        value !== null &&
        "entryId" in value &&
        typeof value.entryId === "string" &&
        "offsetWithinEntry" in value &&
        typeof value.offsetWithinEntry === "number" &&
        "timelineItemId" in value &&
        typeof value.timelineItemId === "string";
}

function PayloadRow({
    cache,
    row,
}: {
    readonly cache: TranscriptPayloadCache<string>;
    readonly row: TranscriptTimelineVirtualRow;
}) {
    const payloadRef = row.kind === "activity-entry" ? `payload:${row.id}` : null;

    useEffect(() => {
        if (!payloadRef) return;
        void cache.load(payloadRef, { protect: true });
        return () => cache.release(payloadRef);
    }, [cache, payloadRef]);

    return <div data-rendered-row={row.id} style={{ height: ROW_HEIGHT }}>{row.id}</div>;
}

interface TimelineHarnessProps {
    readonly active: boolean;
    readonly cache: TranscriptPayloadCache<string>;
    readonly onAnchorReady?: (capture: (() => ChatTimelineSemanticAnchor | null) | null) => void;
    readonly restoreAnchor?: ChatTimelineSemanticAnchor | null;
    readonly rows: readonly TranscriptTimelineItem[];
    readonly scrollRef: RefObject<HTMLDivElement | null>;
}

function TimelineHarness({ active, cache, onAnchorReady, restoreAnchor, rows, scrollRef }: TimelineHarnessProps) {
    const contentRef: RefObject<HTMLDivElement | null> = { current: null };
    return (
        <ChatTranscriptSurface
            covered={false}
            jumpToBottom={null}
            onScroll={() => {}}
            scopeKey={SESSION_ID}
            scrollRef={scrollRef}
            timelineContentRef={contentRef}
        >
            <ChatTimelineHistoryRows
                active={active}
                historyRows={rows}
                hotTailRowId={null}
                hotTailRows={[]}
                onSemanticAnchorCaptureReady={onAnchorReady}
                renderRow={({ row }) => <PayloadRow cache={cache} row={row} />}
                renderStreamingIndicator={() => null}
                scrollRef={scrollRef}
                semanticRestoreAnchor={restoreAnchor}
                showStreamingIndicator={false}
            />
        </ChatTranscriptSurface>
    );
}

describe("chat timeline renderer integration", () => {
    const originalResizeObserver = globalThis.ResizeObserver;

    beforeEach(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        FakeResizeObserver.reset();
        measuredTimelineWidth = 640;
        resetChatPerformanceCounters();
        setChatPerformanceCountersEnabledForTests(true);
        vi.stubGlobal("ResizeObserver", FakeResizeObserver);
        vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
            function (this: HTMLElement) {
                const height = this.dataset.listKey ? ROW_HEIGHT : 0;
                return {
                    bottom: height,
                    height,
                    left: 0,
                    right: measuredTimelineWidth,
                    top: 0,
                    width: measuredTimelineWidth,
                    x: 0,
                    y: 0,
                    toJSON: () => ({}),
                };
            },
        );
    });

    afterEach(() => {
        setChatPerformanceCountersEnabledForTests(null);
        vi.unstubAllGlobals();
        if (originalResizeObserver) {
            globalThis.ResizeObserver = originalResizeObserver;
        }
        document.body.innerHTML = "";
    });

    it("hydrates only mounted tool rows while scrolling a 500-tool active segment", async () => {
        const requests = vi.fn((payloadRef: string) => Promise.resolve(payloadRef));
        const cache = new TranscriptPayloadCache({ load: requests }, 1024 * 1024, (value) => value.length);
        const scrollRef: RefObject<HTMLDivElement | null> = { current: null };
        const rootElement = document.createElement("div");
        const root = createRoot(rootElement);
        document.body.appendChild(rootElement);

        act(() => {
            root.render(<TimelineHarness active cache={cache} rows={createToolRows()} scrollRef={scrollRef} />);
        });
        const scrollContainer = scrollRef.current;
        if (!scrollContainer) throw new Error("expected scroll container");
        defineLayout(scrollContainer, {
            clientHeight: VIEWPORT_HEIGHT,
            clientWidth: 640,
            scrollHeight: 500 * ROW_HEIGHT,
        });

        // Re-sync after jsdom's synthetic geometry has been installed.
        act(() => {
            scrollContainer.dispatchEvent(new Event("scroll", { bubbles: true }));
        });
        await act(async () => {});

        const initialRequests = requests.mock.calls.length;
        const mountedRows = rootElement.querySelectorAll("[data-rendered-row]").length;
        expect(mountedRows).toBeLessThan(80);
        expect(initialRequests).toBeGreaterThan(0);
        expect(initialRequests).toBeLessThan(80);

        act(() => {
            // Use a normal wheel-sized move. A huge synthetic jump deliberately
            // activates the list's fling overscan and is not representative of
            // the steady visible-window hydration contract.
            scrollContainer.scrollTop = 168;
            scrollContainer.dispatchEvent(new Event("scroll", { bubbles: true }));
        });
        await act(async () => {});

        const remountedRows = rootElement.querySelectorAll("[data-rendered-row]").length;
        expect(remountedRows).toBeLessThan(80);
        expect(requests.mock.calls.length).toBeGreaterThan(initialRequests);
        expect(requests.mock.calls.length).toBeLessThan(160);
        expect(readChatPerformanceCounters().tool_payloads_requested).toBe(0);
        root.unmount();
    });

    it("evicts an offscreen payload and rehydrates it once with the same presentation", async () => {
        const requests = vi.fn((payloadRef: string) => Promise.resolve(`presentation:${payloadRef}`));
        const cache = new TranscriptPayloadCache({ load: requests }, 128, (value) => value.length);

        await cache.load("payload:tool-42");
        const presentation = await cache.load("payload:tool-42");
        cache.release("payload:tool-42");
        cache.applyMemoryPressure(0);
        expect(cache.has("payload:tool-42")).toBe(false);

        expect(await cache.load("payload:tool-42")).toBe(presentation);
        expect(requests).toHaveBeenCalledTimes(2);
    });

    it("disconnects observers while hidden and restores a semantic row anchor on return", () => {
        const cache = new TranscriptPayloadCache({ load: (value) => Promise.resolve(value) }, 1024, (value) => value.length);
        const rows = createToolRows();
        const scrollRef: RefObject<HTMLDivElement | null> = { current: null };
        const rootElement = document.createElement("div");
        const root = createRoot(rootElement);
        const captureRef: { current: (() => ChatTimelineSemanticAnchor | null) | null } = { current: null };
        document.body.appendChild(rootElement);

        act(() => {
            root.render(<TimelineHarness active cache={cache} rows={rows} scrollRef={scrollRef} onAnchorReady={(next) => { captureRef.current = next; }} />);
        });
        const scrollContainer = scrollRef.current;
        if (!scrollContainer) throw new Error("expected scroll container");
        defineLayout(scrollContainer, { clientHeight: VIEWPORT_HEIGHT, clientWidth: 640, scrollHeight: 14_000 });
        act(() => {
            scrollContainer.scrollTop = 180;
            scrollContainer.dispatchEvent(new Event("scroll", { bubbles: true }));
        });
        let anchor: ChatTimelineSemanticAnchor | null = null;
        if (captureRef.current) {
            const result: unknown = captureRef.current();
            if (isSemanticAnchor(result)) {
                anchor = result;
            }
        }
        expect(anchor?.entryId).toBeTruthy();
        const connectedWhileVisible = FakeResizeObserver.connected;
        expect(connectedWhileVisible).toBeGreaterThan(0);

        measuredTimelineWidth = 440;
        act(() => {
            for (const observer of FakeResizeObserver.instances) {
                observer.emit();
            }
        });
        // A narrower layout may mount a different window, but must not attach
        // a second observer set on top of the currently mounted rows.
        expect(FakeResizeObserver.connected).toBeLessThanOrEqual(connectedWhileVisible);
        const connectedAfterResize = FakeResizeObserver.connected;

        act(() => {
            root.render(<TimelineHarness active={false} cache={cache} rows={rows} scrollRef={scrollRef} onAnchorReady={(next) => { captureRef.current = next; }} />);
        });
        expect(FakeResizeObserver.connected).toBeLessThan(connectedWhileVisible);

        act(() => {
            root.render(<TimelineHarness active cache={cache} rows={rows} scrollRef={scrollRef} restoreAnchor={anchor} onAnchorReady={(next) => { captureRef.current = next; }} />);
        });
        expect(FakeResizeObserver.connected).toBeGreaterThan(0);
        expect(FakeResizeObserver.connected).toBeLessThanOrEqual(connectedAfterResize);
        root.unmount();
    });
});
