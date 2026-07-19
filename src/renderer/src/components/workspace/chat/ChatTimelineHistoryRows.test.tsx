/** @vitest-environment jsdom */
import { act, useEffect } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AiSessionSnapshot, AiToolActivity } from "@shared/ipc";
import { useShellStore } from "@renderer/app/store/shell-store";

import {
    reconcileChatTimelineModel,
    type ChatTimelineRow,
} from "./chatTimelineModel";
import type { TranscriptTimelineHistoryRow } from "./transcriptBlockVirtualization";
import { createChatPerformanceFixtureById } from "./chatPerformanceFixtures";
import {
    CHAT_TIMELINE_CONTENT_MAX_WIDTH_PX,
    CHAT_TIMELINE_VIRTUALIZATION_THRESHOLD,
    getChatTimelineVirtualMeasurementWidth,
} from "./chatTimelineVirtualization";

interface MeasuredVirtualListMockSnapshot {
    readonly firstEstimate: number | null;
    readonly firstKey: string | null;
    readonly firstMeasurementKey: string | null;
    readonly hasOnRangeChange: boolean;
    readonly hasOnReady: boolean;
    readonly itemCount: number;
    readonly observeMeasurements?: boolean;
    readonly overscan?: number;
    readonly preserveScrollAnchorOnItemsChange?: boolean;
    readonly preserveScrollAnchorOnMeasure?: boolean;
    readonly scrollMarginTop?: number;
}

type MeasuredVirtualListMock = (
    snapshot: MeasuredVirtualListMockSnapshot,
) => void;

const measuredVirtualListMock = vi.hoisted(() =>
    vi.fn<MeasuredVirtualListMock>(),
);
const virtualListMockOptions = vi.hoisted(() => ({
    renderSecondItem: false,
}));

let rectWidthsByElement = new WeakMap<Element, number>();
let rectWidthFallback = 0;

vi.mock("@renderer/components/virtual/MeasuredVirtualList", async () => {
    const { createElement } =
        await vi.importActual<typeof import("react")>("react");

    return {
        MeasuredVirtualList: <T,>({
            estimateSize,
            getItemMeasurementKey,
            getItemKey,
            items,
            onRangeChange,
            onReady,
            observeMeasurements,
            overscan,
            preserveScrollAnchorOnItemsChange,
            preserveScrollAnchorOnMeasure,
            renderItem,
            scrollMarginTop,
        }: {
            readonly estimateSize: (item: T, index: number) => number;
            readonly getItemMeasurementKey?: (
                item: T,
                index: number,
            ) => string;
            readonly getItemKey: (item: T, index: number) => string;
            readonly items: readonly T[];
            readonly onRangeChange?: () => void;
            readonly onReady?: () => void;
            readonly observeMeasurements?: boolean;
            readonly overscan?: number;
            readonly preserveScrollAnchorOnItemsChange?: boolean;
            readonly preserveScrollAnchorOnMeasure?: boolean;
            readonly renderItem: (params: {
                readonly index: number;
                readonly isVisible: boolean;
                readonly item: T;
            }) => ReactNode;
            readonly scrollMarginTop?: number;
        }) => {
            measuredVirtualListMock({
                firstEstimate:
                    items.length > 0 ? estimateSize(items[0], 0) : null,
                firstKey: items.length > 0 ? getItemKey(items[0], 0) : null,
                firstMeasurementKey:
                    items.length > 0 && getItemMeasurementKey
                        ? getItemMeasurementKey(items[0], 0)
                        : null,
                hasOnRangeChange: typeof onRangeChange === "function",
                hasOnReady: typeof onReady === "function",
                itemCount: items.length,
                observeMeasurements,
                overscan,
                preserveScrollAnchorOnItemsChange,
                preserveScrollAnchorOnMeasure,
                scrollMarginTop,
            });

            const indexes =
                virtualListMockOptions.renderSecondItem && items.length > 2
                    ? [0, 1, items.length - 1]
                    : items.length > 1
                      ? [0, items.length - 1]
                      : [0];

            return createElement(
                "div",
                { "data-testid": "mock-measured-virtual-list" },
                indexes.map((index) =>
                    createElement(
                        "div",
                        { key: getItemKey(items[index], index) },
                        renderItem({
                            index,
                            isVisible: true,
                            item: items[index],
                        }),
                    ),
                ),
            );
        },
    };
});

import {
    ChatTimelineHistoryRows,
    resolveChatTimelineFrozenContentWidth,
} from "./ChatTimelineHistoryRows";

function createMessage(
    overrides: Partial<AiSessionSnapshot["messages"][number]> = {},
): AiSessionSnapshot["messages"][number] {
    return {
        attachments: [],
        content: "hello",
        createdAt: "2026-04-14T00:00:00.000Z",
        id: "message-1",
        kind: "assistant",
        status: "completed",
        ...overrides,
    };
}

function createRows(count: number): ChatTimelineRow[] {
    return Array.from({ length: count }, (_, index) => {
        const message = createMessage({
            id: `message-${index}`,
        });

        return {
            id: `message:${message.id}`,
            kind: "message",
            message,
        };
    });
}

function createLoadedBlockSpacer(): TranscriptTimelineHistoryRow {
    return {
        blockId: "block-1",
        estimatedHeight: 1,
        id: "transcript-block:block-1",
        isLoaded: true,
        kind: "transcript-block-spacer",
        metadata: {
            blockId: "block-1",
            endSequence: 1,
            entryCount: 1,
            estimatedHeight: 72,
            estimatedRowCount: 1,
            firstCreatedAt: "2026-04-14T00:00:00.000Z",
            lastCreatedAt: "2026-04-14T00:00:00.000Z",
            revision: 1,
            sessionId: "session-1",
            startSequence: 1,
        },
    };
}

function createSegmentRow(entryCount = 1): ChatTimelineRow {
    const activities: AiToolActivity[] = Array.from(
        { length: entryCount },
        (_, index) => ({
            action: null,
            createdAt: "2026-04-14T00:00:00.000Z",
            diffs: [],
            exitCode: null,
            id: `read-${index + 1}`,
            kind: "read",
            locations: [],
            rawInputJson: JSON.stringify({ file_path: "src/app.ts" }),
            rawOutputJson: null,
            sessionId: "session-1",
            status: "completed",
            summary: null,
            terminalOutput: null,
            title: "Read src/app.ts",
            updatedAt: "2026-04-14T00:00:00.000Z",
        }),
    );
    const firstActivity = activities[0];
    const latestActivity = activities.at(-1)!;
    const entries = activities.map((activity) => ({
        policy: "groupable" as const,
        reviewEntry: {
            activity,
            hasPendingTrackedFiles: false,
            pendingTrackedFiles: [],
            trackedFiles: [],
        },
    }));

    return {
        changeStats: { additions: 0, approximate: false, deletions: 0 },
        entries,
        id: "activity-segment:session-1:read-1",
        items: entries.map((entry) => ({ entry, kind: "tool" })),
        kind: "activity-segment",
        summary: {
            actionCount: entryCount,
            changeCount: 0,
            changedFileCount: 0,
            commandCount: 0,
            failureCount: 0,
            fileCount: 1,
            hiddenActivityCount: entryCount,
            isInProgress: false,
            latestActivityId: latestActivity.id,
            latestTitle: "Read src/app.ts",
            searchCount: 0,
            startedAt: firstActivity.createdAt,
            updatedAt: latestActivity.updatedAt,
        },
    };
}

function renderHistoryRows(
    historyRows: readonly TranscriptTimelineHistoryRow[],
    active = true,
) {
    return renderToStaticMarkup(
        <ChatTimelineHistoryRows
            active={active}
            historyRows={historyRows}
            onVirtualRangeChange={() => {}}
            renderRow={({ row }) => (
                <div
                    data-row-id={row.id}
                    key={row.id}
                >
                    {row.id}
                </div>
            )}
            scrollRef={{ current: null }}
        />,
    );
}

interface MountedHistoryRows {
    readonly root: Root;
    readonly mountNode: HTMLElement;
    readonly scrollContainer: HTMLElement;
    readonly setContentWidth: (width: number) => void;
}

function mountHistoryRows(
    historyRows: readonly ChatTimelineRow[],
): MountedHistoryRows {
    const scrollContainer = document.createElement("div");
    Object.defineProperty(scrollContainer, "clientWidth", {
        configurable: true,
        get: () => 1200,
    });
    document.body.appendChild(scrollContainer);

    const mountNode = document.createElement("div");
    document.body.appendChild(mountNode);

    const root = createRoot(mountNode);
    const scrollRef = { current: scrollContainer };

    act(() => {
        root.render(
            <ChatTimelineHistoryRows
                historyRows={historyRows}
                renderRow={({ row }) => (
                    <div data-row-id={row.id} key={row.id}>
                        {row.id}
                    </div>
                )}
                scrollRef={scrollRef}
            />,
        );
    });

    const virtualList = mountNode.querySelector(
        "[data-testid='mock-measured-virtual-list']",
    );
    const historyElement = virtualList?.parentElement;
    if (!historyElement) {
        throw new Error("expected virtualized history element");
    }

    return {
        root,
        mountNode,
        scrollContainer,
        setContentWidth: (width: number) => {
            rectWidthsByElement.set(historyElement, width);
        },
    };
}

function latestFirstMeasurementKey(): string {
    const call =
        measuredVirtualListMock.mock.calls[
            measuredVirtualListMock.mock.calls.length - 1
        ]?.[0];

    if (!call?.firstMeasurementKey) {
        throw new Error("expected a measured virtual list call");
    }

    return call.firstMeasurementKey;
}

describe("ChatTimelineHistoryRows", () => {
    beforeEach(() => {
        (
            globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
        ).IS_REACT_ACT_ENVIRONMENT = true;
        rectWidthsByElement = new WeakMap<Element, number>();
        rectWidthFallback = 0;
        measuredVirtualListMock.mockClear();
        virtualListMockOptions.renderSecondItem = false;
        useShellStore.setState({ isResizingPanel: false });
        vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
            function getBoundingClientRect(this: Element): DOMRect {
                const width =
                    rectWidthsByElement.get(this) ?? rectWidthFallback;

                return {
                    bottom: 0,
                    height: 0,
                    left: 0,
                    right: width,
                    toJSON: () => ({}),
                    top: 0,
                    width,
                    x: 0,
                    y: 0,
                };
            },
        );
        vi.stubGlobal(
            "requestAnimationFrame",
            (callback: FrameRequestCallback) => {
                callback(0);
                return 1;
            },
        );
        vi.stubGlobal("cancelAnimationFrame", () => {});
    });

    afterEach(() => {
        useShellStore.setState({ isResizingPanel: false });
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        document.body.innerHTML = "";
    });

    it("virtualizes history below the threshold to preserve row identity", () => {
        const rows = createRows(CHAT_TIMELINE_VIRTUALIZATION_THRESHOLD - 1);
        const markup = renderHistoryRows(rows);

        expect(measuredVirtualListMock).toHaveBeenCalledWith(
            expect.objectContaining({
                firstKey: "message:message-0",
                itemCount: CHAT_TIMELINE_VIRTUALIZATION_THRESHOLD - 1,
            }),
        );
        expect(markup).toContain("message:message-0");
        expect(markup).toContain(
            `message:message-${CHAT_TIMELINE_VIRTUALIZATION_THRESHOLD - 2}`,
        );
    });

    it("keeps visible history mounted when block-native hydration starts", () => {
        const [visibleRow] = createRows(1);
        if (!visibleRow) {
            throw new Error("expected a visible row");
        }
        const scrollContainer = document.createElement("div");
        const mountNode = document.createElement("div");
        document.body.append(scrollContainer, mountNode);
        const root = createRoot(mountNode);
        let mounts = 0;
        let unmounts = 0;

        function InstrumentedRow({ row }: { readonly row: ChatTimelineRow }) {
            useEffect(() => {
                mounts += 1;
                return () => {
                    unmounts += 1;
                };
            }, []);

            return <div data-row-id={row.id}>{row.id}</div>;
        }

        const render = (historyRows: readonly TranscriptTimelineHistoryRow[]) => {
            root.render(
                <ChatTimelineHistoryRows
                    historyRows={historyRows}
                    renderRow={({ row }) => <InstrumentedRow row={row} />}
                    scrollRef={{ current: scrollContainer }}
                />,
            );
        };

        act(() => {
            render([visibleRow]);
        });
        expect(mounts).toBe(1);

        act(() => {
            render([createLoadedBlockSpacer(), visibleRow]);
        });

        // This is the exact transition performed when a sealed turn becomes
        // block-native. Replacing the direct list with MeasuredVirtualList
        // currently unmounts the visible row, producing the visual blink.
        expect(unmounts).toBe(0);

        act(() => {
            root.unmount();
        });
    });

    it("keeps virtualized history mounted when a new turn starts and streams", () => {
        const [historyRow] = createRows(1);
        if (!historyRow) {
            throw new Error("expected a historical row");
        }
        const userRow: ChatTimelineRow = {
            id: "message:user-next-turn",
            kind: "message",
            message: createMessage({
                content: "next prompt",
                id: "user-next-turn",
                kind: "user",
            }),
        };
        const scrollContainer = document.createElement("div");
        const mountNode = document.createElement("div");
        document.body.append(scrollContainer, mountNode);
        const root = createRoot(mountNode);
        const unmountsByRowId = new Map<string, number>();
        virtualListMockOptions.renderSecondItem = true;

        function InstrumentedRow({ row }: { readonly row: ChatTimelineRow }) {
            useEffect(() => {
                return () => {
                    unmountsByRowId.set(
                        row.id,
                        (unmountsByRowId.get(row.id) ?? 0) + 1,
                    );
                };
            }, [row.id]);

            return <div data-row-id={row.id}>{row.id}</div>;
        }

        const render = (historyRows: readonly TranscriptTimelineHistoryRow[]) => {
            root.render(
                <ChatTimelineHistoryRows
                    historyRows={historyRows}
                    renderRow={({ row }) => <InstrumentedRow row={row} />}
                    scrollRef={{ current: scrollContainer }}
                />,
            );
        };
        const blockNativeHistory = [createLoadedBlockSpacer(), historyRow];

        act(() => {
            render(blockNativeHistory);
        });

        // A new user prompt becomes history, while assistant streaming stays in
        // the separate live tail and must not remount the virtualized history.
        act(() => {
            render([...blockNativeHistory, userRow]);
            render([...blockNativeHistory, userRow]);
        });

        expect(unmountsByRowId.get(historyRow.id) ?? 0).toBe(0);

        act(() => {
            root.unmount();
        });
    });

    it("virtualizes unloaded transcript blocks at their estimated height", () => {
        const markup = renderHistoryRows([
            {
                blockId: "block-1",
                estimatedHeight: 18_432,
                id: "transcript-block:block-1",
                isLoaded: false,
                kind: "transcript-block-spacer",
                metadata: {
                    blockId: "block-1",
                    endSequence: 256,
                    entryCount: 256,
                    estimatedHeight: 18_432,
                    estimatedRowCount: 256,
                    firstCreatedAt: "2026-04-14T00:00:00.000Z",
                    lastCreatedAt: "2026-04-14T00:01:00.000Z",
                    revision: 1,
                    sessionId: "session-1",
                    startSequence: 1,
                },
            },
        ]);

        expect(measuredVirtualListMock).toHaveBeenCalledWith(
            expect.objectContaining({
                firstEstimate: 18_432,
                firstKey: "transcript-block:block-1",
                itemCount: 1,
            }),
        );
        expect(markup).toContain('data-transcript-block-spacer="block-1"');
    });

    it("passes all history rows to MeasuredVirtualList at the threshold", () => {
        const rows = createRows(CHAT_TIMELINE_VIRTUALIZATION_THRESHOLD);
        const markup = renderHistoryRows(rows);
        const firstCall = measuredVirtualListMock.mock.calls[0]?.[0];

        expect(measuredVirtualListMock).toHaveBeenCalledTimes(1);
        expect(measuredVirtualListMock).toHaveBeenCalledWith(
            expect.objectContaining({
                firstKey: "message:message-0",
                hasOnRangeChange: true,
                hasOnReady: true,
                itemCount: CHAT_TIMELINE_VIRTUALIZATION_THRESHOLD,
                observeMeasurements: true,
                overscan: 10,
                preserveScrollAnchorOnItemsChange: true,
                preserveScrollAnchorOnMeasure: true,
                scrollMarginTop: 0,
            }),
        );
        expect(firstCall?.firstEstimate).toBeGreaterThan(0);
        expect(firstCall?.firstMeasurementKey).toContain("message:message-0");
        expect(markup).toContain("mock-measured-virtual-list");
        expect(markup).toContain("message:message-0");
        expect(markup).toContain(
            `message:message-${CHAT_TIMELINE_VIRTUALIZATION_THRESHOLD - 1}`,
        );
        expect(markup.match(/padding-bottom:8px/g)).toHaveLength(1);
    });

    it("keeps the ten-thousand-message fixture DOM-bounded in the main timeline", () => {
        const fixture = createChatPerformanceFixtureById("chat-long-10k");
        const timeline = reconcileChatTimelineModel(null, fixture.snapshot);
        const markup = renderHistoryRows(timeline.historyRows);

        expect(timeline.historyRows).toHaveLength(10_000);
        expect(measuredVirtualListMock).toHaveBeenCalledWith(
            expect.objectContaining({ itemCount: 10_000 }),
        );
        expect(markup).toContain("message:message-1");
        expect(markup).toContain("message:message-10000");
        expect(markup.match(/data-row-id=/g)).toHaveLength(2);
    });

    it("keeps virtual layout but stops row measurements while retained and hidden", () => {
        const rows = createRows(CHAT_TIMELINE_VIRTUALIZATION_THRESHOLD);

        const markup = renderHistoryRows(rows, false);

        expect(measuredVirtualListMock).toHaveBeenCalledWith(
            expect.objectContaining({
                itemCount: CHAT_TIMELINE_VIRTUALIZATION_THRESHOLD,
                observeMeasurements: false,
            }),
        );
        expect(markup).toContain("mock-measured-virtual-list");
    });

    it("passes activity segments through the virtual list with their stable id", () => {
        const rows = [
            createSegmentRow(),
            ...createRows(CHAT_TIMELINE_VIRTUALIZATION_THRESHOLD - 1),
        ];
        const markup = renderHistoryRows(rows);
        const firstCall = measuredVirtualListMock.mock.calls[0]?.[0];

        expect(firstCall).toMatchObject({
            firstEstimate: 48,
            firstKey: "activity-segment:session-1:read-1",
            itemCount: CHAT_TIMELINE_VIRTUALIZATION_THRESHOLD,
        });
        expect(firstCall?.firstMeasurementKey).toContain(
            "activity-segment:session-1:read-1",
        );
        expect(markup).toContain("activity-segment:session-1:read-1");
    });

    it("virtualizes the outer timeline for an activity-heavy segment", () => {
        const rows = [
            createSegmentRow(CHAT_TIMELINE_VIRTUALIZATION_THRESHOLD),
        ];
        const markup = renderHistoryRows(rows);

        expect(measuredVirtualListMock).toHaveBeenCalledWith(
            expect.objectContaining({
                firstKey: "activity-segment:session-1:read-1",
                itemCount: 1,
            }),
        );
        expect(markup).toContain("activity-segment:session-1:read-1");
        expect(markup).toContain("mock-measured-virtual-list");
    });

    it("freezes content width during panel resize and re-syncs on release", () => {
        const rows = createRows(CHAT_TIMELINE_VIRTUALIZATION_THRESHOLD);
        rectWidthFallback = CHAT_TIMELINE_CONTENT_MAX_WIDTH_PX;
        const mounted = mountHistoryRows(rows);

        mounted.setContentWidth(CHAT_TIMELINE_CONTENT_MAX_WIDTH_PX);
        act(() => {
            window.dispatchEvent(new Event("resize"));
        });

        expect(latestFirstMeasurementKey()).toMatch(
            new RegExp(
                `:${getChatTimelineVirtualMeasurementWidth(
                    CHAT_TIMELINE_CONTENT_MAX_WIDTH_PX,
                )}:\\d+$`,
            ),
        );

        act(() => {
            useShellStore.getState().setResizingPanel(true);
        });

        const historyElement = mounted.mountNode.querySelector(
            "[data-testid='mock-measured-virtual-list']",
        )?.parentElement as HTMLElement | null;
        expect(historyElement?.style.width).toBe(
            `${CHAT_TIMELINE_CONTENT_MAX_WIDTH_PX}px`,
        );

        mounted.setContentWidth(620);
        act(() => {
            window.dispatchEvent(new Event("resize"));
        });

        expect(historyElement?.style.width).toBe(
            `${CHAT_TIMELINE_CONTENT_MAX_WIDTH_PX}px`,
        );
        expect(latestFirstMeasurementKey()).toMatch(
            new RegExp(
                `:${getChatTimelineVirtualMeasurementWidth(
                    CHAT_TIMELINE_CONTENT_MAX_WIDTH_PX,
                )}:\\d+$`,
            ),
        );

        act(() => {
            useShellStore.getState().setResizingPanel(false);
        });

        expect(historyElement?.style.width).toBe("");
        expect(latestFirstMeasurementKey()).toMatch(
            new RegExp(
                `:${getChatTimelineVirtualMeasurementWidth(620)}:\\d+$`,
            ),
        );

        mounted.root.unmount();
        mounted.scrollContainer.remove();
    });

    it("does not freeze virtualized rows to a collapsed measured width", () => {
        expect(
            resolveChatTimelineFrozenContentWidth({
                measuredWidth: 42,
                scrollContainerWidth: 1200,
            }),
        ).toBe(CHAT_TIMELINE_CONTENT_MAX_WIDTH_PX);
        expect(
            resolveChatTimelineFrozenContentWidth({
                measuredWidth: 42,
                scrollContainerWidth: 120,
            }),
        ).toBeNull();
    });

    it("keeps resize release capped when the panel grows beyond the timeline max", () => {
        const rows = createRows(CHAT_TIMELINE_VIRTUALIZATION_THRESHOLD);
        rectWidthFallback = 620;
        const mounted = mountHistoryRows(rows);

        mounted.setContentWidth(620);
        expect(latestFirstMeasurementKey()).toMatch(
            new RegExp(
                `:${getChatTimelineVirtualMeasurementWidth(620)}:\\d+$`,
            ),
        );

        act(() => {
            useShellStore.getState().setResizingPanel(true);
        });

        const historyElement = mounted.mountNode.querySelector(
            "[data-testid='mock-measured-virtual-list']",
        )?.parentElement as HTMLElement | null;
        expect(historyElement?.style.width).toBe("620px");

        mounted.setContentWidth(CHAT_TIMELINE_CONTENT_MAX_WIDTH_PX);
        act(() => {
            window.dispatchEvent(new Event("resize"));
        });

        expect(historyElement?.style.width).toBe("620px");
        expect(latestFirstMeasurementKey()).toMatch(
            new RegExp(
                `:${getChatTimelineVirtualMeasurementWidth(620)}:\\d+$`,
            ),
        );

        act(() => {
            useShellStore.getState().setResizingPanel(false);
        });

        expect(historyElement?.style.width).toBe("");
        expect(latestFirstMeasurementKey()).toMatch(
            new RegExp(
                `:${getChatTimelineVirtualMeasurementWidth(
                    CHAT_TIMELINE_CONTENT_MAX_WIDTH_PX,
                )}:\\d+$`,
            ),
        );

        mounted.root.unmount();
        mounted.scrollContainer.remove();
    });
});
