import { describe, expect, it } from "vitest";

import {
    getSyntaxHighlightCoverageReport,
    MONACO_FALLBACK_LANGUAGE_IDS,
    SYNTAX_HIGHLIGHT_EXCLUDED_LANGUAGE_IDS,
} from "./syntaxHighlightCoverage";
import { isTextMateLanguageSupported } from "./monacoTextmate";

const EXPECTED_DECLARED_LANGUAGE_IDS = [
    "plaintext",
    "tsx",
    "typescript",
    "jsx",
    "javascript",
    "json",
    "jsonc",
    "markdown",
    "mdx",
    "html",
    "css",
    "scss",
    "less",
    "xml",
    "yaml",
    "shell",
    "python",
    "go",
    "rust",
    "java",
    "kotlin",
    "php",
    "ruby",
    "sql",
    "graphql",
    "hcl",
    "toml",
    "dockerfile",
    "ini",
    "lua",
    "c",
    "cpp",
    "csharp",
    "astro",
    "prisma",
    "swift",
    "scala",
    "cmake",
    "diff",
    "clojure",
    "erlang",
    "elixir",
    "groovy",
    "haskell",
    "julia",
    "makefile",
    "pascal",
    "perl",
    "powershell",
    "protobuf",
    "r",
    "sass",
    "stylus",
    "svelte",
    "tcl",
    "vb",
    "wast",
    "d",
    "vue",
    "dart",
    "nix",
    "zig",
    "objc",
    "bat",
    "cmd",
    "fish",
    "nu",
    "solidity",
    "nginx",
    "http",
    "csv",
    "log",
] as const;

describe("syntax highlight coverage", () => {
    it("reports declared, TextMate, excluded, and pending grammar languages", () => {
        const report = getSyntaxHighlightCoverageReport();
        const textMateCoveredLanguageIds = report.declaredLanguageIds.filter(
            (languageId) => isTextMateLanguageSupported(languageId),
        );

        expect(report.declaredLanguageIds).toEqual(EXPECTED_DECLARED_LANGUAGE_IDS);
        expect(report.textMateLanguageIds).toEqual(textMateCoveredLanguageIds);
        expect(report.textMateLanguageIds).toHaveLength(71);
        expect(report.explicitlyExcludedLanguageIds).toEqual(
            SYNTAX_HIGHLIGHT_EXCLUDED_LANGUAGE_IDS,
        );
        expect(report.languagesMissingTextMateGrammar).toEqual([]);
        expect(report.monacoFallbackLanguageIds).toEqual(
            MONACO_FALLBACK_LANGUAGE_IDS,
        );
    });

    it("fails when a catalog language has no explicit highlight strategy", () => {
        const report = getSyntaxHighlightCoverageReport();

        if (report.undecidedLanguageIds.length > 0) {
            throw new Error(
                `Missing syntax highlight strategy for: ${report.undecidedLanguageIds.join(
                    ", ",
                )}`,
            );
        }

        expect(report.undecidedLanguageIds).toEqual([]);
    });

    it("keeps language ids unique in the baseline report", () => {
        const report = getSyntaxHighlightCoverageReport();

        expect(new Set(report.declaredLanguageIds).size).toBe(
            report.declaredLanguageIds.length,
        );
    });
});
