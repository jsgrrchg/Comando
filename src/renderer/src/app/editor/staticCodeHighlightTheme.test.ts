/// <reference types="node" />

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const EXPECTED_STATIC_TOKEN_ANCHORS = [
    "--code-color-comment",
    "--code-color-constant",
    "--code-color-escape",
    "--code-color-function",
    "--code-color-keyword",
    "--code-color-markup",
    "--code-color-parameter",
    "--code-color-property",
    "--code-color-string",
    "--code-color-type",
    "--code-color-variable",
] as const;

const FORBIDDEN_STATIC_TOKEN_COLOR_SOURCES = [
    "--diff-add",
    "--diff-move",
    "--diff-remove",
    "--diff-update",
    "--color-accent",
    "--color-text-primary",
    "--color-text-secondary",
] as const;

function extractStaticTokenCssBlock(css: string): string {
    const startIndex = css.indexOf(".cm-static-token-");
    const endIndex = css.indexOf("\nbutton,", startIndex);

    if (startIndex < 0 || endIndex < 0) {
        throw new Error("Could not find the static CodeMirror token CSS block.");
    }

    return css.slice(startIndex, endIndex);
}

async function readStaticTokenCssBlock(): Promise<string> {
    const css = await readFile(
        join(process.cwd(), "src/renderer/src/styles.css"),
        "utf8",
    );

    return extractStaticTokenCssBlock(css);
}

describe("static CodeMirror token theme", () => {
    it("uses Monaco code color anchors as the static token palette", async () => {
        const tokenCss = await readStaticTokenCssBlock();

        for (const anchor of EXPECTED_STATIC_TOKEN_ANCHORS) {
            expect(tokenCss).toContain(anchor);
        }
        expect(tokenCss).toContain("--code-color-");
    });

    it("does not colorize static tokens from diff, accent, or body text colors", async () => {
        const tokenCss = await readStaticTokenCssBlock();

        for (const variableName of FORBIDDEN_STATIC_TOKEN_COLOR_SOURCES) {
            expect(tokenCss).not.toContain(variableName);
        }
    });
});
