import {
    registerCustomTheme,
    type ThemeRegistration,
    type ThemesType,
} from "@pierre/diffs";
import type { ThemePreset } from "@shared/ipc";

import {
    resolveComandoThemeTokens,
    THEME_PRESET_OPTIONS,
    type ComandoThemeTokens,
} from "@renderer/app/settings/theme";
import type { ComandoCodeColorAnchors } from "./monacoTextmateTheme";

export type ComandoPierreThemeName = `comando-${string}-${"dark" | "light"}`;

export interface PierreDiffTypography {
    readonly fontFamily?: string | null;
    readonly fontSize?: number | null;
    readonly lineHeight?: number | null;
}

export type PierreDiffHostStyle = Readonly<
    Record<`--diffs-${string}`, string>
>;

const DEFAULT_FONT_FAMILY = "var(--font-mono)";
const DEFAULT_FONT_SIZE_PX = 13;
const DEFAULT_LINE_HEIGHT = 1.55;
const registeredThemeNames = new Set<ComandoPierreThemeName>();

export const COMANDO_PIERRE_SYNTAX_SCOPES = {
    comment: ["comment", "punctuation.definition.comment", "markup.quote"],
    constant: [
        "constant",
        "constant.language",
        "variable.other.constant",
        "entity.name.constant",
    ],
    escape: [
        "constant.character.escape",
        "constant.character.numeric.regexp",
        "constant.character.escape.backslash.regexp",
    ],
    function: [
        "entity.name.function",
        "support.function",
        "meta.function-call",
        "variable.function",
    ],
    keyword: [
        "keyword",
        "keyword.control",
        "keyword.operator",
        "storage",
    ],
    markup: ["markup.heading", "entity.name.tag", "entity.name.section"],
    parameter: ["variable.parameter", "meta.parameter", "function.parameter"],
    property: [
        "variable.other.property",
        "support.variable.property",
        "meta.object-literal.key",
        "support.type.property-name",
    ],
    string: ["string", "string.quoted", "string.template"],
    type: [
        "entity.name.type",
        "entity.name.class",
        "entity.name.interface",
        "support.type",
    ],
    typeParameter: [
        "entity.name.type.parameter",
        "entity.name.type.type-parameter",
        "meta.type.parameters",
    ],
    variable: ["variable", "variable.other", "meta.definition.variable"],
} as const satisfies Record<keyof ComandoCodeColorAnchors, readonly string[]>;

function resolveFontSize(fontSize: number | null | undefined): string {
    const resolved =
        typeof fontSize === "number" && Number.isFinite(fontSize) && fontSize > 0
            ? fontSize
            : DEFAULT_FONT_SIZE_PX;

    return `${resolved}px`;
}

function resolveLineHeight(lineHeight: number | null | undefined): string {
    const resolved =
        typeof lineHeight === "number" &&
        Number.isFinite(lineHeight) &&
        lineHeight > 0
            ? lineHeight
            : DEFAULT_LINE_HEIGHT;

    return resolved > 4 ? `${resolved}px` : String(resolved);
}

export function getComandoPierreThemeName(
    preset: ThemePreset,
    isDark: boolean,
): ComandoPierreThemeName {
    return `comando-${preset}-${isDark ? "dark" : "light"}`;
}

export function getComandoPierreThemes(preset: ThemePreset): ThemesType {
    return {
        dark: getComandoPierreThemeName(preset, true),
        light: getComandoPierreThemeName(preset, false),
    };
}

function createTokenColors(anchors: ComandoCodeColorAnchors) {
    return (Object.keys(COMANDO_PIERRE_SYNTAX_SCOPES) as Array<
        keyof ComandoCodeColorAnchors
    >).map((anchor) => ({
        scope: [...COMANDO_PIERRE_SYNTAX_SCOPES[anchor]],
        settings: {
            foreground: anchors[anchor],
            ...(anchor === "comment" ? { fontStyle: "italic" } : {}),
            ...(anchor === "markup" ? { fontStyle: "bold" } : {}),
        },
    }));
}

export function createComandoPierreTheme(
    preset: ThemePreset,
    isDark: boolean,
): ThemeRegistration {
    const tokens = resolveComandoThemeTokens(preset, isDark, true);

    return {
        colors: {
            "editor.background": tokens.editor,
            "editor.foreground": tokens.editorText,
            "editor.selectionBackground": tokens.selection,
            "editorLineNumber.foreground": tokens.textSecondary,
            foreground: tokens.editorText,
        },
        name: getComandoPierreThemeName(preset, isDark),
        tokenColors: createTokenColors(tokens.code),
        type: isDark ? "dark" : "light",
    };
}

export function registerComandoPierreThemes(): void {
    for (const { id: preset } of THEME_PRESET_OPTIONS) {
        for (const isDark of [false, true]) {
            const name = getComandoPierreThemeName(preset, isDark);
            if (registeredThemeNames.has(name)) continue;

            const theme = createComandoPierreTheme(preset, isDark);
            registerCustomTheme(name, () => Promise.resolve(theme));
            registeredThemeNames.add(name);
        }
    }
}

export function getRegisteredComandoPierreThemeNames(): readonly ComandoPierreThemeName[] {
    return Array.from(registeredThemeNames);
}

export function buildPierreDiffHostStyle(
    tokens: ComandoThemeTokens,
    typography: PierreDiffTypography = {},
): PierreDiffHostStyle {
    const fontFamily = typography.fontFamily ?? DEFAULT_FONT_FAMILY;

    return {
        "--diffs-bg": tokens.editor,
        "--diffs-addition-color-override": "var(--diff-add)",
        "--diffs-bg-addition-emphasis-override": `color-mix(in srgb, var(--diff-add) 24%, ${tokens.editor})`,
        "--diffs-bg-addition-number-override": `color-mix(in srgb, var(--diff-add) 12%, ${tokens.bgSecondary})`,
        "--diffs-bg-addition-override": `color-mix(in srgb, var(--diff-add) 12%, ${tokens.editor})`,
        "--diffs-bg-buffer-override": tokens.editor,
        "--diffs-bg-context-gutter-override": tokens.bgSecondary,
        "--diffs-bg-context-override": tokens.editor,
        "--diffs-bg-deletion-emphasis-override": `color-mix(in srgb, var(--diff-remove) 24%, ${tokens.editor})`,
        "--diffs-bg-deletion-number-override": `color-mix(in srgb, var(--diff-remove) 12%, ${tokens.bgSecondary})`,
        "--diffs-bg-deletion-override": `color-mix(in srgb, var(--diff-remove) 12%, ${tokens.editor})`,
        "--diffs-bg-selection-number-override": tokens.selection,
        "--diffs-bg-selection-override": tokens.selection,
        "--diffs-bg-separator-override": tokens.border,
        "--diffs-deletion-color-override": "var(--diff-remove)",
        "--diffs-fg": tokens.editorText,
        "--diffs-fg-conflict-marker-override": tokens.code.markup,
        "--diffs-fg-number-override": tokens.textSecondary,
        "--diffs-font-family": fontFamily,
        "--diffs-font-size": resolveFontSize(typography.fontSize),
        "--diffs-header-font-family": "var(--font-sans)",
        "--diffs-line-height": resolveLineHeight(typography.lineHeight),
        "--diffs-modified-color-override": "var(--diff-warn)",
        "--diffs-tab-size": "4",
    };
}
