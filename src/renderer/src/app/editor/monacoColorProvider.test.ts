import { describe, expect, it } from "vitest";

import { findCssColorLiterals } from "./monacoColorProvider";

describe("monacoColorProvider", () => {
    it("finds hex, rgb, rgba, hsl, and hsla literals", () => {
        const matches = findCssColorLiterals(
            'color: #336699; border: rgb(255, 0, 128); box-shadow: rgba(0, 0, 0, 0.25); background: hsl(120, 100%, 25%); outline: hsla(240, 100%, 50%, 50%);',
        );

        expect(matches).toHaveLength(5);
        expect(matches[0]?.color).toMatchObject({
            alpha: 1,
            blue: 153,
            green: 102,
            red: 51,
        });
        expect(matches[1]?.color).toMatchObject({
            alpha: 1,
            blue: 128,
            green: 0,
            red: 255,
        });
        expect(matches[2]?.color.alpha).toBe(0.25);
        expect(matches[3]?.color).toMatchObject({
            alpha: 1,
            blue: 0,
            green: 128,
            red: 0,
        });
        expect(matches[4]?.color.alpha).toBe(0.5);
    });

    it("detects Tailwind arbitrary color values inside TSX class strings", () => {
        const [match] = findCssColorLiterals(
            '<div className="bg-[#0ea5e9] text-[rgb(255,255,255)]" />',
        );

        expect(match).toMatchObject({
            color: {
                blue: 233,
                green: 165,
                red: 14,
            },
        });
    });

    it("does not treat longer hex-like identifiers as color literals", () => {
        expect(findCssColorLiterals("const id = '#123456789';")).toEqual([]);
    });
});
