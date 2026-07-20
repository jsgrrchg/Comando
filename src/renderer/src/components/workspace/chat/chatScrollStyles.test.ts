/// <reference types="node" />

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

function extractChatScrollCssBlock(css: string): string {
    const startIndex = css.indexOf(".chat-scroll {");
    const endIndex = css.indexOf("\n}\n", startIndex);

    if (startIndex < 0 || endIndex < 0) {
        throw new Error("Could not find the chat scroll CSS block.");
    }

    return css.slice(startIndex, endIndex + 2);
}

describe("chat scroll styles", () => {
    it("disables native scroll anchoring on the scrolling chat container", async () => {
        const css = await readFile(
            join(process.cwd(), "src/renderer/src/styles.css"),
            "utf8",
        );

        expect(extractChatScrollCssBlock(css)).toContain(
            "overflow-anchor: none;",
        );
    });
});
