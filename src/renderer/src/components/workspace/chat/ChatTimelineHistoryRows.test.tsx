/** @vitest-environment jsdom */
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AiSessionSnapshot } from "@shared/ipc";
import { useShellStore } from "@renderer/app/store/shell-store";

import type { ChatTimelineRow } from "./chatTimelineModel";
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
                overscan,
                preserveScrollAnchorOnItemsChange,
                preserveScrollAnchorOnMeasure,
                scrollMarginTop,
            });

            const indexes =
                items.length > 1 ? [0, items.length - 1] : [0];

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

function renderHistoryRows(historyRows: readonly ChatTimelineRow[]) {
    return renderToStaticMarkup(
        <ChatTimelineHistoryRows
            historyRows={historyRows}
            latestStreamingEditedFileToolRowId={null}
            onVirtualRangeChange={() => {}}
            renderRow={({ isLatestStreamingTool, row }) => (
                <div
                    data-latest-streaming-tool={
                        isLatestStreamingTool ? "true" : "false"
                    }
                    data-row-id={row.id}
                    key={row.id}
                >
                    {row.id}
                </div>
            )}
            scrollRef={{ current: null }}
            toolCardExpansionMode="collapsed"
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
                latestStreamingEditedFileToolRowId={null}
                renderRow={({ row }) => (
                    <div data-row-id={row.id} key={row.id}>
                        {row.id}
                    </div>
                )}
                scrollRef={scrollRef}
                toolCardExpansionMode="collapsed"
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

    it("keeps the non-virtualized path below the threshold", () => {
        const rows = createRows(CHAT_TIMELINE_VIRTUALIZATION_THRESHOLD - 1);
        const markup = renderHistoryRows(rows);

        expect(measuredVirtualListMock).not.toHaveBeenCalled();
        expect(markup).toContain("message:message-0");
        expect(markup).toContain(
            `message:message-${CHAT_TIMELINE_VIRTUALIZATION_THRESHOLD - 2}`,
        );
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
