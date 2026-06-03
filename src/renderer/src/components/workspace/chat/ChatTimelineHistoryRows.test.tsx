import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AiSessionSnapshot } from "@shared/ipc";

import type { ChatTimelineRow } from "./chatTimelineModel";
import { CHAT_TIMELINE_VIRTUALIZATION_THRESHOLD } from "./chatTimelineVirtualization";

interface MeasuredVirtualListMockSnapshot {
    readonly firstEstimate: number | null;
    readonly firstKey: string | null;
    readonly firstMeasurementKey: string | null;
    readonly hasOnRangeChange: boolean;
    readonly hasOnReady: boolean;
    readonly itemCount: number;
    readonly overscan?: number;
    readonly scrollMarginTop?: number;
}

type MeasuredVirtualListMock = (
    snapshot: MeasuredVirtualListMockSnapshot,
) => void;

const measuredVirtualListMock = vi.hoisted(() =>
    vi.fn<MeasuredVirtualListMock>(),
);

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

import { ChatTimelineHistoryRows } from "./ChatTimelineHistoryRows";

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
            onVirtualListReady={() => {}}
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

describe("ChatTimelineHistoryRows", () => {
    beforeEach(() => {
        measuredVirtualListMock.mockClear();
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
});
