const MONACO_LANGUAGE_ID_ALIASES: Readonly<Record<string, string>> = {
    jsx: "javascript",
    tsx: "typescript",
};

export function resolveMonacoLanguageId(languageId: string): string {
    const normalizedLanguageId = languageId.trim().toLowerCase();

    if (!normalizedLanguageId) {
        return languageId;
    }

    return (
        MONACO_LANGUAGE_ID_ALIASES[normalizedLanguageId] ?? normalizedLanguageId
    );
}
