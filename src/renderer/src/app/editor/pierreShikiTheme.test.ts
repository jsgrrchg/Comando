import { describe, expect, it } from "vitest";
import { resolveThemes } from "@pierre/diffs";

import {
    resolveComandoThemeTokens,
    THEME_PRESET_OPTIONS,
} from "@renderer/app/settings/theme";
import type { ComandoCodeColorAnchors } from "./monacoTextmateTheme";
import {
    buildPierreDiffHostStyle,
    COMANDO_PIERRE_SYNTAX_SCOPES,
    createComandoPierreTheme,
    getComandoPierreThemeName,
    getRegisteredComandoPierreThemeNames,
    registerComandoPierreThemes,
} from "./pierreShikiTheme";

const CODE_ANCHORS = Object.keys(
    COMANDO_PIERRE_SYNTAX_SCOPES,
) as Array<keyof ComandoCodeColorAnchors>;

describe("pierre Shiki themes", () => {
    it("creates stable themes for every preset and color mode", () => {
        for (const { id: preset } of THEME_PRESET_OPTIONS) {
            for (const isDark of [false, true]) {
                for (const boostCodeContrast of [false, true]) {
                    const theme = createComandoPierreTheme(
                        preset,
                        isDark,
                        boostCodeContrast,
                    );
                    const tokens = resolveComandoThemeTokens(
                        preset,
                        isDark,
                        boostCodeContrast,
                    );

                    expect(theme.name).toBe(
                        getComandoPierreThemeName(
                            preset,
                            isDark,
                            boostCodeContrast,
                        ),
                    );
                    expect(theme.type).toBe(isDark ? "dark" : "light");
                    expect(theme.colors?.["editor.background"]).toMatch(
                        /^#[\da-f]{6}$/i,
                    );
                    expect(theme.colors?.["editor.foreground"]).toMatch(
                        /^#[\da-f]{6}$/i,
                    );

                    for (const anchor of CODE_ANCHORS) {
                        const scope = COMANDO_PIERRE_SYNTAX_SCOPES[anchor][0];
                        const rule = theme.tokenColors?.find((candidate) =>
                            Array.isArray(candidate.scope)
                                ? candidate.scope.includes(scope)
                                : candidate.scope === scope,
                        );

                        expect(rule?.settings.foreground).toBe(
                            tokens.code[anchor],
                        );
                    }
                }
            }
        }
    });

    it("registers each static theme only once", async () => {
        registerComandoPierreThemes();
        const firstRegistration = getRegisteredComandoPierreThemeNames();

        registerComandoPierreThemes();

        expect(firstRegistration).toHaveLength(
            THEME_PRESET_OPTIONS.length * 2 * 2,
        );
        expect(getRegisteredComandoPierreThemeNames()).toEqual(
            firstRegistration,
        );

        const [theme] = await resolveThemes([firstRegistration[0]]);
        expect(theme?.name).toBe(firstRegistration[0]);
    });

    it("passes resolved typography and colors to the Pierre host", () => {
        const tokens = resolveComandoThemeTokens("tokyoNight", true, true);
        const style = buildPierreDiffHostStyle(tokens, {
            fontFamily: '"Geist Mono"',
            fontSize: 15,
            lineHeight: 1.7,
        });

        expect(style["--diffs-font-family"]).toBe('"Geist Mono"');
        expect(style["--diffs-header-font-family"]).toBe("var(--font-sans)");
        expect(style["--diffs-font-size"]).toBe("15px");
        expect(style["--diffs-line-height"]).toBe("1.7");
        expect(style["--diffs-bg"]).toBe(tokens.editor);
        expect(style["--diffs-bg-buffer-override"]).toBe(tokens.editor);
        expect(style["--diffs-bg-separator-override"]).toBe(tokens.border);
        expect(style["--diffs-fg"]).toBe(tokens.editorText);
        expect(style["--diffs-fg-conflict-marker-override"]).toBe(
            tokens.code.markup,
        );
    });
});
