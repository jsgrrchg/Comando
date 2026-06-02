import { afterEach, describe, expect, it, vi } from "vitest";

import { getTerminalTheme } from "./terminalTheme";

const FALLBACK_FONT_STACK =
    '"SF Mono", "SFMono-Regular", "JetBrains Mono", "Cascadia Code", Menlo, Monaco, Consolas, monospace';

function stubStyleEnvironment(
    values: Record<string, string> = {},
): void {
    const documentElement = {};
    vi.stubGlobal("document", { documentElement });
    vi.stubGlobal("window", {
        getComputedStyle: () => ({
            getPropertyValue: (name: string) => values[name] ?? "",
        }),
    });
}

describe("getTerminalTheme", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("uses the fallback terminal font when the configured font is empty", () => {
        stubStyleEnvironment();

        expect(getTerminalTheme(null, { fontFamily: "", fontSize: 16 }))
            .toMatchObject({
                fontFamily: FALLBACK_FONT_STACK,
                fontSize: 16,
            });
    });

    it("uses configured terminal font settings", () => {
        stubStyleEnvironment({
            "--color-accent": "#abcdef",
            "--color-editor": "#101010",
        });

        expect(
            getTerminalTheme(null, {
                fontFamily: "FiraCode Nerd Font",
                fontSize: 18,
            }),
        ).toMatchObject({
            accent: "#abcdef",
            background: "#101010",
            fontFamily: "FiraCode Nerd Font",
            fontSize: 18,
        });
    });
});
