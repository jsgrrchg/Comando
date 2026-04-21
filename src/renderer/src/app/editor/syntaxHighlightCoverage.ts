import { getEditorLanguageIds } from "@shared/editor-language";

import { isTextMateLanguageSupported } from "./monacoTextmate";

export const SYNTAX_HIGHLIGHT_EXCLUDED_LANGUAGE_IDS = ["plaintext"] as const;

export const MONACO_FALLBACK_LANGUAGE_IDS = [] as const;

export interface SyntaxHighlightCoverageReport {
    readonly declaredLanguageIds: readonly string[];
    readonly explicitlyExcludedLanguageIds: readonly string[];
    readonly languagesMissingTextMateGrammar: readonly string[];
    readonly monacoFallbackLanguageIds: readonly string[];
    readonly textMateLanguageIds: readonly string[];
    readonly undecidedLanguageIds: readonly string[];
}

const excludedLanguageIds = new Set<string>(
    SYNTAX_HIGHLIGHT_EXCLUDED_LANGUAGE_IDS,
);
const monacoFallbackLanguageIds = new Set<string>(MONACO_FALLBACK_LANGUAGE_IDS);

export function getSyntaxHighlightCoverageReport(): SyntaxHighlightCoverageReport {
    const declaredLanguageIds = getEditorLanguageIds();
    const textMateLanguageIds = declaredLanguageIds.filter((languageId) =>
        isTextMateLanguageSupported(languageId),
    );
    const explicitlyExcludedLanguageIds = declaredLanguageIds.filter(
        (languageId) => excludedLanguageIds.has(languageId),
    );
    const monacoFallbackLanguageIdsInCatalog = declaredLanguageIds.filter(
        (languageId) => monacoFallbackLanguageIds.has(languageId),
    );
    const languagesMissingTextMateGrammar = declaredLanguageIds.filter(
        (languageId) =>
            !isTextMateLanguageSupported(languageId) &&
            !excludedLanguageIds.has(languageId),
    );
    const undecidedLanguageIds = languagesMissingTextMateGrammar.filter(
        (languageId) => !monacoFallbackLanguageIds.has(languageId),
    );

    return {
        declaredLanguageIds,
        explicitlyExcludedLanguageIds,
        languagesMissingTextMateGrammar,
        monacoFallbackLanguageIds: monacoFallbackLanguageIdsInCatalog,
        textMateLanguageIds,
        undecidedLanguageIds,
    };
}
