import { describe, expect, it } from "vitest";

import { extendMarkdownLanguageConfiguration } from "./markdownSyntax";

describe("markdownSyntax", () => {
    it("adds bold pairs to markdown auto closing configuration", () => {
        const result = extendMarkdownLanguageConfiguration({
            autoClosingPairs: [{ open: "(", close: ")" }],
            surroundingPairs: [{ open: "`", close: "`" }],
        });

        expect(result.autoClosingPairs).toEqual([
            { open: "(", close: ")" },
            { open: "**", close: "**" },
        ]);
        expect(result.surroundingPairs).toEqual([
            { open: "`", close: "`" },
            { open: "**", close: "**" },
        ]);
    });

    it("does not duplicate the bold pair when it already exists", () => {
        const result = extendMarkdownLanguageConfiguration({
            autoClosingPairs: [{ open: "**", close: "**" }],
            surroundingPairs: [{ open: "**", close: "**" }],
        });

        expect(result.autoClosingPairs).toEqual([{ open: "**", close: "**" }]);
        expect(result.surroundingPairs).toEqual([{ open: "**", close: "**" }]);
    });
});
