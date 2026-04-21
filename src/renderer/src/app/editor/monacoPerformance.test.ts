import { describe, expect, it } from "vitest";

import {
    INLINE_EDITOR_MAX_BYTES,
    LARGE_FILE_JSON_LANGUAGE_ID,
    LARGE_FILE_JSONC_LANGUAGE_ID,
    MONACO_MAX_TOKENIZATION_LINE_LENGTH,
    TEXT_MATE_MAX_DOCUMENT_BYTES,
    resolveLargeFileMonacoLanguageId,
    shouldDisableTextMateForDocumentSize,
} from "./monacoPerformance";
import { LARGE_JSON_FIXTURE_MIN_BYTES } from "./syntaxHighlightFixtures";

describe("monacoPerformance", () => {
    it("keeps the tokenization and TextMate budgets explicit", () => {
        expect(MONACO_MAX_TOKENIZATION_LINE_LENGTH).toBe(20_000);
        expect(TEXT_MATE_MAX_DOCUMENT_BYTES).toBe(5 * 1024 * 1024);
        expect(INLINE_EDITOR_MAX_BYTES).toBeGreaterThan(
            LARGE_JSON_FIXTURE_MIN_BYTES,
        );
    });

    it("disables TextMate above the document-size budget", () => {
        expect(
            shouldDisableTextMateForDocumentSize(TEXT_MATE_MAX_DOCUMENT_BYTES),
        ).toBe(false);
        expect(
            shouldDisableTextMateForDocumentSize(
                TEXT_MATE_MAX_DOCUMENT_BYTES + 1,
            ),
        ).toBe(true);
    });

    it("uses JSON-specific fallback languages for large JSON files", () => {
        expect(resolveLargeFileMonacoLanguageId("json")).toBe(
            LARGE_FILE_JSON_LANGUAGE_ID,
        );
        expect(resolveLargeFileMonacoLanguageId("jsonc")).toBe(
            LARGE_FILE_JSONC_LANGUAGE_ID,
        );
        expect(resolveLargeFileMonacoLanguageId("typescript")).toBe("plaintext");
    });
});
