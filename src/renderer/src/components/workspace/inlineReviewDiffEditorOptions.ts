import type { editor as MonacoEditor } from "monaco-editor";

interface BuildInlineReviewDiffEditorOptionsInput {
    readonly fontFamily: string;
    readonly fontSize: number;
    readonly lineHeight: number;
    readonly minimapEnabled: boolean;
    readonly modifiedLineCount: number;
    readonly originalLineCount: number;
    readonly wordWrap: "off" | "on";
}

function getLineNumberDigits(lineCount: number): number {
    return Math.max(1, String(Math.max(1, lineCount)).length);
}

function getInlineReviewLineNumbersMinChars(options: {
    readonly modifiedLineCount: number;
    readonly originalLineCount: number;
}): number {
    const digits = Math.max(
        getLineNumberDigits(options.modifiedLineCount),
        getLineNumberDigits(options.originalLineCount),
    );

    return digits * 2 + 1;
}

export function buildInlineReviewDiffEditorOptions({
    fontFamily,
    fontSize,
    lineHeight,
    minimapEnabled,
    modifiedLineCount,
    originalLineCount,
    wordWrap,
}: BuildInlineReviewDiffEditorOptionsInput): MonacoEditor.IStandaloneDiffEditorConstructionOptions {
    return {
        automaticLayout: true,
        diffWordWrap: "inherit",
        experimental: {
            showEmptyDecorations: true,
            useTrueInlineView: false,
        },
        fontFamily,
        fontLigatures: true,
        fontSize,
        glyphMargin: false,
        hideCursorInOverviewRuler: true,
        hideUnchangedRegions: {
            enabled: false,
        },
        lineDecorationsWidth: 12,
        lineHeight,
        lineNumbersMinChars: getInlineReviewLineNumbersMinChars({
            modifiedLineCount,
            originalLineCount,
        }),
        minimap: {
            enabled: minimapEnabled,
        },
        originalEditable: false,
        overviewRulerBorder: false,
        overviewRulerLanes: 0,
        padding: { top: 16, bottom: 16 },
        readOnly: true,
        renderOverviewRuler: false,
        renderSideBySide: false,
        scrollbar: {
            alwaysConsumeMouseWheel: false,
            horizontalScrollbarSize: 6,
            useShadows: false,
            verticalScrollbarSize: 6,
        },
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        wordWrap,
    };
}
