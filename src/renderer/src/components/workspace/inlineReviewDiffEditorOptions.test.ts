import { describe, expect, it } from "vitest";

import { buildInlineReviewDiffEditorOptions } from "./inlineReviewDiffEditorOptions";

describe("buildInlineReviewDiffEditorOptions", () => {
    it("keeps inline review on full-line rendering", () => {
        const options = buildInlineReviewDiffEditorOptions({
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            lineHeight: 20,
            minimapEnabled: true,
            modifiedLineCount: 214,
            originalLineCount: 219,
            wordWrap: "on",
        });

        expect(options.renderSideBySide).toBe(false);
        expect(options.experimental?.useTrueInlineView).toBe(false);
        expect(options.experimental?.showEmptyDecorations).toBe(true);
        expect(options.hideUnchangedRegions?.enabled).toBe(false);
        expect(options.lineDecorationsWidth).toBe(12);
        expect(options.lineNumbersMinChars).toBe(7);
        expect(options.wordWrap).toBe("on");
        expect(options.minimap?.enabled).toBe(true);
    });

    it("expands the gutter for larger inline diff line numbers", () => {
        const options = buildInlineReviewDiffEditorOptions({
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            lineHeight: 20,
            minimapEnabled: false,
            modifiedLineCount: 12034,
            originalLineCount: 9876,
            wordWrap: "off",
        });

        expect(options.lineNumbersMinChars).toBe(11);
        expect(options.minimap?.enabled).toBe(false);
    });
});
