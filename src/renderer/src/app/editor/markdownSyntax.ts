import type * as monaco from "monaco-editor";

const MARKDOWN_BOLD_PAIR: monaco.languages.IAutoClosingPair = {
    open: "**",
    close: "**",
};

function appendDistinctPair<T extends monaco.languages.IAutoClosingPair>(
    pairs: readonly T[] | undefined,
    pair: T,
): T[] {
    if (pairs?.some((entry) => entry.open === pair.open && entry.close === pair.close)) {
        return [...pairs];
    }

    return [...(pairs ?? []), pair];
}

export function extendMarkdownLanguageConfiguration(
    configuration: monaco.languages.LanguageConfiguration | undefined,
): monaco.languages.LanguageConfiguration {
    return {
        ...(configuration ?? {}),
        autoClosingPairs: appendDistinctPair(
            configuration?.autoClosingPairs,
            MARKDOWN_BOLD_PAIR,
        ),
        surroundingPairs: appendDistinctPair(
            configuration?.surroundingPairs,
            MARKDOWN_BOLD_PAIR,
        ),
    };
}
