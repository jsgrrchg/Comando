import { describe, expect, it } from "vitest";

import { CHAT_FONT_FAMILY_OPTIONS } from "../settings/theme";
import { buildSelectableFontFamilyOptions } from "./use-available-font-family-options";

describe("buildSelectableFontFamilyOptions", () => {
    it("oculta las fuentes no disponibles y conserva la seleccion actual", () => {
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

    it("deja intacta la lista mientras no termina la deteccion", () => {
        const options = buildSelectableFontFamilyOptions(
            CHAT_FONT_FAMILY_OPTIONS,
            null,
            "system",
        );

        expect(options).toEqual(CHAT_FONT_FAMILY_OPTIONS);
    });
});
