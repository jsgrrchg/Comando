import type { editor as MonacoEditor } from "monaco-editor";

interface BuildInlineReviewDiffEditorOptionsInput {
    readonly fontFamily: string;
    readonly fontSize: number;
    readonly lineHeight: number;
    readonly lineNumbers: MonacoEditor.LineNumbersType;
    readonly minimapEnabled: boolean;
    readonly modifiedLineCount: number;
    readonly originalLineCount: number;
    readonly wordWrap: "off" | "on";
}

type SemanticHighlightingEditorOptions = {
    readonly "semanticHighlighting.enabled": true | false | "configuredByTheme";
};

const semanticHighlightingOptions: SemanticHighlightingEditorOptions = {
    "semanticHighlighting.enabled": true,
};

function getLineNumberDigits(lineCount: number): number {
    return Math.max(1, String(Math.max(1, lineCount)).length);
}

function getInlineReviewLineNumbersMinChars(options: {
    readonly modifiedLineCount: number;
    readonly originalLineCount: number;
}): number {
    return Math.max(
        getLineNumberDigits(options.modifiedLineCount),
        getLineNumberDigits(options.originalLineCount),
    );
}

export function buildInlineReviewDiffEditorOptions({
    fontFamily,
    fontSize,
    lineHeight,
    lineNumbers,
    minimapEnabled,
    modifiedLineCount,
    originalLineCount,
    wordWrap,
}: BuildInlineReviewDiffEditorOptionsInput): MonacoEditor.IStandaloneDiffEditorConstructionOptions {
    return {
        automaticLayout: true,
        compactMode: true,
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
        lineNumbers,
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
        renderIndicators: false,
        renderOverviewRuler: false,
        renderSideBySide: false,
        scrollBeyondLastLine: false,
        ...semanticHighlightingOptions,
        smoothScrolling: true,
        wordWrap,
    };
}
