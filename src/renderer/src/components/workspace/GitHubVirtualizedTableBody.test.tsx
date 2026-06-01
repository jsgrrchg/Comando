import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const measuredVirtualListMock = vi.hoisted(() =>
    vi.fn(
        ({
            items,
            renderItem,
        }: {
            readonly items: readonly string[];
            readonly renderItem: (params: {
                readonly index: number;
                readonly isVisible: boolean;
                readonly item: string;
            }) => ReactNode;
        }) => (
            <div data-testid="measured-virtual-list">
                {items.slice(0, 2).map((item, index) =>
                    renderItem({
                        index,
                        isVisible: true,
                        item,
                    }),
                )}
            </div>
        ),
    ),
);

vi.mock("../virtual/MeasuredVirtualList", () => ({
    MeasuredVirtualList: measuredVirtualListMock,
}));

import {
    applyGitHubVirtualizedTableRowLayout,
    GitHubVirtualizedTableBody,
} from "./GitHubVirtualizedTableBody";

function createItems(count: number): string[] {
    return Array.from({ length: count }, (_, index) => `row-${index}`);
}

function renderBody({
    gridTemplateColumns = "40px 1fr",
    items,
    minWidth = 240,
    threshold = 5,
}: {
    readonly gridTemplateColumns?: string;
    readonly items: readonly string[];
    readonly minWidth?: number;
    readonly threshold?: number;
}) {
    return renderToStaticMarkup(
        <GitHubVirtualizedTableBody
            estimateRowHeight={() => 48}
            getRowKey={(item) => item}
            gridTemplateColumns={gridTemplateColumns}
            items={items}
            minWidth={minWidth}
            renderRow={(item) => (
                <div className="group/row items-stretch">
                    <button type="button">{item}</button>
                </div>
            )}
            scrollContainerRef={{ current: null }}
            threshold={threshold}
        />,
    );
}

describe("GitHubVirtualizedTableBody", () => {
    beforeEach(() => {
        measuredVirtualListMock.mockClear();
    });

    it("renders every row below the virtualization threshold", () => {
        const markup = renderBody({
            items: createItems(4),
            threshold: 5,
        });

        expect(markup).toContain("row-0");
        expect(markup).toContain("row-3");
        expect(markup.match(/group\/row/g)).toHaveLength(4);
        expect(measuredVirtualListMock).not.toHaveBeenCalled();
    });

    it("uses MeasuredVirtualList above the virtualization threshold", () => {
        const markup = renderBody({
            items: createItems(8),
            threshold: 5,
        });

        expect(markup).toContain("row-0");
        expect(markup).toContain("row-1");
        expect(markup).not.toContain("row-7");
        expect(measuredVirtualListMock).toHaveBeenCalledTimes(1);
        expect(measuredVirtualListMock.mock.calls[0]?.[0]).toMatchObject({
            enabled: true,
            overscan: 6,
            scrollMarginTop: 0,
        });
    });

    it("applies the table grid layout to rendered rows", () => {
        const markup = renderBody({
            gridTemplateColumns: "56px 420px 128px",
            items: createItems(2),
            minWidth: 604,
            threshold: 5,
        });

        expect(markup).toContain("grid group/row items-stretch");
        expect(markup).toContain("grid-template-columns:56px 420px 128px");
        expect(markup).toContain("min-width:604px");
    });

    it("passes updated layout values to virtualized rows", () => {
        renderBody({
            gridTemplateColumns: "40px 1fr",
            items: createItems(8),
            minWidth: 240,
            threshold: 5,
        });

        const markup = renderBody({
            gridTemplateColumns: "72px 2fr",
            items: createItems(8),
            minWidth: 360,
            threshold: 5,
        });

        expect(markup).toContain("grid-template-columns:72px 2fr");
        expect(markup).toContain("min-width:360px");
    });

    it("preserves row click handlers when injecting layout props", () => {
        const handleClick = vi.fn();
        const row = applyGitHubVirtualizedTableRowLayout({
            gridTemplateColumns: "1fr",
            minWidth: 120,
            row: (
                <button onClick={handleClick} type="button">
                    Open
                </button>
            ),
        });

        expect(isValidElement(row)).toBe(true);
        if (!isValidElement<{ readonly onClick: () => void }>(row)) {
            throw new Error("Expected a valid row element");
        }

        row.props.onClick();
        expect(handleClick).toHaveBeenCalledTimes(1);
    });
});
