import {
    INLINE_EDITOR_MAX_BYTES,
    MONACO_MAX_TOKENIZATION_LINE_LENGTH,
    TEXT_MATE_MAX_DOCUMENT_BYTES,
} from "@shared/editor-performance";

export {
    INLINE_EDITOR_MAX_BYTES,
    MONACO_MAX_TOKENIZATION_LINE_LENGTH,
    TEXT_MATE_MAX_DOCUMENT_BYTES,
};

export const LARGE_FILE_JSON_LANGUAGE_ID = "comando-large-json";
export const LARGE_FILE_JSONC_LANGUAGE_ID = "comando-large-jsonc";

export function shouldDisableTextMateForDocumentSize(
    sizeBytes: number | null | undefined,
): boolean {
    return (
        typeof sizeBytes === "number" &&
        Number.isFinite(sizeBytes) &&
        sizeBytes > TEXT_MATE_MAX_DOCUMENT_BYTES
    );
}

export function resolveLargeFileMonacoLanguageId(languageId: string): string {
    const normalizedLanguageId = languageId.trim().toLowerCase();

    if (normalizedLanguageId === "json") {
        return LARGE_FILE_JSON_LANGUAGE_ID;
    }

    if (normalizedLanguageId === "jsonc") {
        return LARGE_FILE_JSONC_LANGUAGE_ID;
    }

    return "plaintext";
}
