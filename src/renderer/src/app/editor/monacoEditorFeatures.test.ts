import { describe, expect, it } from "vitest";

import {
    COMANDO_BRACKET_PAIR_COLOR_COUNT,
    createComandoEditorFeatureOptions,
} from "./monacoEditorFeatures";

describe("monacoEditorFeatures", () => {
    it("enables the best-in-class editor affordances from Phase 7.5", () => {
        const options = createComandoEditorFeatureOptions();

        expect(COMANDO_BRACKET_PAIR_COLOR_COUNT).toBe(6);
        expect(options.bracketPairColorization?.enabled).toBe(true);
        expect(options.guides?.bracketPairs).toBe("active");
        expect(options.guides?.bracketPairsHorizontal).toBe("active");
        expect(options.guides?.indentation).toBe(true);
        expect(options.guides?.highlightActiveIndentation).toBe("always");
        expect(options.colorDecorators).toBe(true);
        expect(options.stickyScroll?.enabled).toBe(true);
        expect(options.stickyScroll?.maxLineCount).toBe(5);
        expect(options.occurrencesHighlight).toBe("singleFile");
        expect(options.unicodeHighlight?.ambiguousCharacters).toBe(true);
        expect(options.unicodeHighlight?.invisibleCharacters).toBe(true);
    });
});
