import { describe, expect, it } from "vitest";

import {
    buildChatFontFamily,
    buildEditorFontFamily,
    CHAT_FONT_FAMILY_OPTIONS,
    EDITOR_FONT_FAMILY_OPTIONS,
    getDefaultAiChatSettings,
    getDefaultAppEditorSettings,
} from "./theme";

describe("theme font families", () => {
    it("exposes the bundled font families in editor, chat, and composer", () => {
        expect(
            EDITOR_FONT_FAMILY_OPTIONS.map((option) => option.id),
        ).toEqual(
            expect.arrayContaining([
                "system",
                "geist",
                "atkinson",
                "literata",
                "lora",
                "merriweather",
                "source-serif",
                "reading",
                "rounded",
                "humanist",
                "slab",
                "typewriter",
                "condensed",
                "andale",
            ]),
        );

        expect(CHAT_FONT_FAMILY_OPTIONS).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ group: "Sans", id: "geist" }),
                expect.objectContaining({ group: "Serif", id: "literata" }),
                expect.objectContaining({ group: "Mono", id: "typewriter" }),
            ]),
        );
    });

    it("resolves rich typography stacks for editor and AI", () => {
        expect(buildEditorFontFamily("geist")).toContain('"Geist"');
        expect(buildEditorFontFamily("sf-mono")).toContain('"SF Mono"');
        expect(buildChatFontFamily("typewriter")).toContain(
            '"American Typewriter"',
        );
        expect(buildChatFontFamily("jetbrains-mono")).toContain(
            '"JetBrains Mono"',
        );
    });

    it("uses the configured defaults for new editor and AI surfaces", () => {
        expect(getDefaultAppEditorSettings().fontFamily).toBe("ibm-plex-mono");
        expect(getDefaultAiChatSettings()).toMatchObject({
            chatFontFamily: "andale",
            composerFontFamily: "ibm-plex-mono",
        });
    });
});
