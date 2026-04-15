import { describe, expect, it } from "vitest";

import { CHAT_FONT_FAMILY_OPTIONS } from "../settings/theme";
import { buildSelectableFontFamilyOptions } from "./use-available-font-family-options";

describe("buildSelectableFontFamilyOptions", () => {
    it("hides unavailable fonts and preserves current selection", () => {
        const options = buildSelectableFontFamilyOptions(
            CHAT_FONT_FAMILY_OPTIONS,
            new Set(["system", "geist"]),
            "typewriter",
        );

        expect(options.map((option) => option.id)).toEqual([
            "system",
            "geist",
            "typewriter",
        ]);
        expect(options.at(-1)).toMatchObject({
            disabled: true,
            id: "typewriter",
            label: "Typewriter (unavailable on this device)",
        });
    });

    it("keeps the list unchanged while detection is pending", () => {
        const options = buildSelectableFontFamilyOptions(
            CHAT_FONT_FAMILY_OPTIONS,
            null,
            "system",
        );

        expect(options).toEqual(CHAT_FONT_FAMILY_OPTIONS);
    });
});
