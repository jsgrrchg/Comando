import type { editor as MonacoEditor } from "monaco-editor";

export const COMANDO_BRACKET_PAIR_COLOR_COUNT = 6;

export function createComandoEditorFeatureOptions(): MonacoEditor.IEditorOptions &
    MonacoEditor.IGlobalEditorOptions {
    return {
        bracketPairColorization: {
            enabled: true,
        },
        colorDecorators: true,
        colorDecoratorsActivatedOn: "clickAndHover",
        colorDecoratorsLimit: 2_000,
        guides: {
            bracketPairs: "active",
            bracketPairsHorizontal: "active",
            highlightActiveIndentation: "always",
            indentation: true,
        },
        occurrencesHighlight: "singleFile",
        stickyScroll: {
            enabled: true,
            maxLineCount: 5,
        },
        unicodeHighlight: {
            ambiguousCharacters: true,
            invisibleCharacters: true,
        },
    };
}
