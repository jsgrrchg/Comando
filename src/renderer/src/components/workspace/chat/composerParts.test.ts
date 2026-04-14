import { describe, expect, it } from "vitest";

import type { AIComposerPart } from "./composerParts";
import {
    appendSelectionMentionPart,
    composerPartsToPlainText,
    serializeComposerPartsForPrompt,
} from "./composerParts";

describe("composerParts", () => {
    it("appends selection mentions as pills with trailing spacing", () => {
        const parts = appendSelectionMentionPart(
            [{ type: "text", text: "Review" }],
            {
                endLine: 18,
                path: "src/app.ts",
                selectedText: "const value = 1;",
                startLine: 12,
            },
        );

        expect(parts).toEqual([
            { type: "text", text: "Review " },
            {
                type: "selection_mention",
                endLine: 18,
                label: "(12:18) const value = 1;",
                path: "src/app.ts",
                selectedText: "const value = 1;",
                startLine: 12,
            },
            { type: "text", text: " " },
        ]);
    });

    it("serializes selection mentions for the prompt as line references", () => {
        const parts: AIComposerPart[] = [
            { type: "text", text: "Inspect " },
            {
                type: "selection_mention",
                endLine: 18,
                label: "(12:18) const value = 1;",
                path: "src/app.ts",
                selectedText: "const value = 1;",
                startLine: 12,
            },
        ];

        expect(serializeComposerPartsForPrompt(parts)).toBe(
            "Inspect src/app.ts:12-18",
        );
        expect(composerPartsToPlainText(parts)).toBe(
            "Inspect [(12:18) const value = 1;]",
        );
    });
});
