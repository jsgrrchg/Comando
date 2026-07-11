import { describe, expect, it } from "vitest";

import {
    formatComposerDisplaySelectionLabel,
    parseComposerDisplayFileMention,
    parseComposerDisplayFolderMention,
    parseComposerDisplaySelectionMention,
    serializeComposerDisplayFileMention,
    serializeComposerDisplayFolderMention,
    serializeComposerDisplaySelectionMention,
    serializeComposerMessagePartsForDisplay,
} from "./composer-display-markers";

describe("composer display markers", () => {
    it("round-trips file mention metadata safely", () => {
        const serialized = serializeComposerDisplayFileMention({
            label: "thread.rs",
            relativePath: "vendor/codex-acp/src/thread.rs",
        });
        const payload = serialized.slice(2, -2);

        expect(parseComposerDisplayFileMention(payload)).toEqual({
            label: "thread.rs",
            relativePath: "vendor/codex-acp/src/thread.rs",
        });
    });

    it("ignores legacy and malformed markers", () => {
        expect(parseComposerDisplayFileMention("@thread.rs")).toBeNull();
        expect(parseComposerDisplayFileMention("file|%ZZ|thread.rs")).toBeNull();
    });

    it("round-trips folder mention metadata safely", () => {
        const serialized = serializeComposerDisplayFolderMention({
            folderPath: "src/components",
            label: "components",
        });

        expect(parseComposerDisplayFolderMention(serialized.slice(2, -2))).toEqual({
            folderPath: "src/components",
            label: "components",
        });
    });

    it("round-trips and formats selection mention metadata", () => {
        const serialized = serializeComposerDisplaySelectionMention({
            endLine: 14,
            label: "(8:14) - selected code",
            path: "src/elicitation.ts",
            startLine: 8,
        });
        const parsed = parseComposerDisplaySelectionMention(
            serialized.slice(2, -2),
        );

        expect(parsed).toEqual({
            endLine: 14,
            label: "(8:14) - selected code",
            path: "src/elicitation.ts",
            startLine: 8,
        });
        expect(parsed && formatComposerDisplaySelectionLabel(parsed)).toBe(
            "elicitation.ts (lines 8–14)",
        );
    });

    it("uses enriched selections for optimistic user messages", () => {
        const serialized = serializeComposerMessagePartsForDisplay(
            [
                {
                    endLine: 14,
                    label: "(8:14) - full selected preview",
                    path: "src/elicitation.ts",
                    selectedText: "full selected preview",
                    startLine: 8,
                    type: "selection_mention",
                },
                { text: " what do you see?", type: "text" },
            ],
            "fallback",
        );

        expect(serialized).toContain("selection|src%2Felicitation.ts|8|14|");
        expect(serialized).toContain(" what do you see?");
    });
});
