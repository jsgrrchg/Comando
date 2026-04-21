const MONACO_LANGUAGE_ID_ALIASES: Readonly<Record<string, string>> = {
    jsx: "javascriptreact",
    tsx: "typescriptreact",
};

const TYPESCRIPT_WORKER_LANGUAGE_IDS = new Set([
    "javascript",
    "javascriptreact",
    "typescript",
    "typescriptreact",
]);

export function resolveMonacoLanguageId(languageId: string): string {
    const normalizedLanguageId = languageId.trim().toLowerCase();

    if (!normalizedLanguageId) {
        return languageId;
    }

    return (
        MONACO_LANGUAGE_ID_ALIASES[normalizedLanguageId] ?? normalizedLanguageId
    );
}

export function isTypeScriptWorkerLanguageId(languageId: string): boolean {
    return TYPESCRIPT_WORKER_LANGUAGE_IDS.has(languageId.trim().toLowerCase());
}
