import type { IRawTheme } from "vscode-textmate";

import { MONACO_TYPESCRIPT_SEMANTIC_TOKEN_SELECTORS } from "./monacoSemanticTokens";

export type ComandoTextMateThemeName = "comando-light" | "comando-dark";

export interface ComandoTextMateThemeInput {
    // Accent is accepted for compatibility with the caller but is not used in
    // the palette anymore; it no longer participates in cache keying either.
    readonly accent?: string;
    readonly editorBackground: string;
    readonly editorForeground: string;
    readonly isDark: boolean;
    readonly textSecondary: string;
    readonly themeName: ComandoTextMateThemeName;
}

export interface ComandoCodeColorAnchors {
    readonly comment: string;
    readonly constant: string;
    readonly escape: string;
    readonly function: string;
    readonly keyword: string;
    readonly markup: string;
    readonly parameter: string;
    readonly property: string;
    readonly string: string;
    readonly type: string;
    readonly typeParameter: string;
    readonly variable: string;
}

export interface ComandoTextMatePalette {
    readonly anchors: ComandoCodeColorAnchors;
    readonly attribute: string;
    readonly comment: string;
    readonly constant: string;
    readonly decorator: string;
    readonly escape: string;
    readonly function: string;
    readonly keyword: string;
    readonly macro: string;
    readonly namespace: string;
    readonly number: string;
    readonly parameter: string;
    readonly property: string;
    readonly regexp: string;
    readonly string: string;
    readonly tag: string;
    readonly type: string;
    readonly typeParameter: string;
    readonly variable: string;
}

export interface ComandoSemanticTokenRule {
    readonly fontStyle?: string;
    readonly foreground: string;
}

export type ComandoSemanticTokenColors = Readonly<
    Record<string, ComandoSemanticTokenRule>
>;

/**
 * Minimal Monaco token theme rule shape compatible with
 * `monaco.editor.ITokenThemeRule`. Declared locally so this module stays
 * agnostic of the monaco-editor runtime target (the rest of the file never
 * imports monaco). Foreground colors are returned as `#RRGGBB` strings; the
 * Monaco-specific caller is responsible for stripping the leading `#` before
 * handing them to `defineTheme`.
 */
export interface ComandoMonarchThemeRule {
    readonly token: string;
    readonly foreground: string;
    readonly fontStyle?: string;
}

export interface ComandoTextMateTheme {
    readonly encodedTokensColors: readonly string[];
    readonly indexedColorMap: readonly string[];
    readonly palette: ComandoTextMatePalette;
    readonly rawTheme: IRawTheme;
    readonly semanticTokenColors: ComandoSemanticTokenColors;
    readonly themeName: ComandoTextMateThemeName;
}

const MIN_CODE_COLOR_CONTRAST = 4.5;
const UNUSED_COLOR_ID_ZERO = "#000001";
const textMateThemeCache = new Map<string, ComandoTextMateTheme>();

function normalizeRawThemeColor(value: string, fallback: string): string {
    const trimmed = value.trim();
    const normalized = /^#(?:[\da-f]{6}|[\da-f]{8})$/i.test(trimmed)
        ? trimmed.slice(0, 7)
        : fallback;

    return normalized.toUpperCase();
}

function hexToRgb(hexColor: string): readonly [number, number, number] {
    const normalizedColor = normalizeRawThemeColor(hexColor, "#000000").slice(1);

    return [
        Number.parseInt(normalizedColor.slice(0, 2), 16),
        Number.parseInt(normalizedColor.slice(2, 4), 16),
        Number.parseInt(normalizedColor.slice(4, 6), 16),
    ];
}

function relativeLuminance(hexColor: string): number {
    const [red, green, blue] = hexToRgb(hexColor).map((channel) => {
        const normalizedChannel = channel / 255;
        return normalizedChannel <= 0.03928
            ? normalizedChannel / 12.92
            : ((normalizedChannel + 0.055) / 1.055) ** 2.4;
    });

    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(firstColor: string, secondColor: string): number {
    const firstLuminance = relativeLuminance(firstColor);
    const secondLuminance = relativeLuminance(secondColor);
    const lighter = Math.max(firstLuminance, secondLuminance);
    const darker = Math.min(firstLuminance, secondLuminance);

    return (lighter + 0.05) / (darker + 0.05);
}

function accessibleColor(
    color: string,
    background: string,
    fallback: string,
): string {
    const normalizedColor = normalizeRawThemeColor(color, fallback);

    if (contrastRatio(normalizedColor, background) >= MIN_CODE_COLOR_CONTRAST) {
        return normalizedColor;
    }

    return normalizeRawThemeColor(fallback, fallback);
}

// Pre-blends a foreground against a background using the provided alpha
// (0..1). Returns an opaque 6-digit hex. We avoid 8-digit colors because
// vscode-textmate rejects them when building the encoded color map.
function blendColors(
    foreground: string,
    background: string,
    alpha: number,
): string {
    const clampedAlpha = Math.max(0, Math.min(1, alpha));
    const [foregroundRed, foregroundGreen, foregroundBlue] =
        hexToRgb(foreground);
    const [backgroundRed, backgroundGreen, backgroundBlue] =
        hexToRgb(background);
    const red = Math.round(
        foregroundRed * clampedAlpha + backgroundRed * (1 - clampedAlpha),
    );
    const green = Math.round(
        foregroundGreen * clampedAlpha + backgroundGreen * (1 - clampedAlpha),
    );
    const blue = Math.round(
        foregroundBlue * clampedAlpha + backgroundBlue * (1 - clampedAlpha),
    );
    const toHex = (value: number) =>
        Math.max(0, Math.min(255, value))
            .toString(16)
            .padStart(2, "0")
            .toUpperCase();

    return `#${toHex(red)}${toHex(green)}${toHex(blue)}`;
}

function createPalette(input: ComandoTextMateThemeInput): ComandoTextMatePalette {
    const editorBackground = normalizeRawThemeColor(
        input.editorBackground,
        input.isDark ? "#1C1C1C" : "#FFFFFF",
    );

    if (input.isDark) {
        const anchors = {
            comment: accessibleColor(
                input.textSecondary,
                editorBackground,
                "#9CA3AF",
            ),
            constant: "#FDBA74",
            escape: "#F472B6",
            function: "#60A5FA",
            keyword: "#C084FC",
            markup: "#FCA5A5",
            parameter: "#FED7AA",
            property: "#FDA4AF",
            string: "#A7F3D0",
            type: "#FACC15",
            typeParameter: "#86EFAC",
            variable: accessibleColor(
                input.editorForeground,
                editorBackground,
                "#E5E7EB",
            ),
        } as const satisfies ComandoCodeColorAnchors;

        return {
            anchors,
            attribute: "#FDE68A",
            comment: anchors.comment,
            constant: anchors.constant,
            decorator: "#F9A8D4",
            escape: anchors.escape,
            function: anchors.function,
            keyword: anchors.keyword,
            macro: "#FACC15",
            namespace: "#67E8F9",
            number: anchors.constant,
            parameter: anchors.parameter,
            property: anchors.property,
            regexp: "#A3E635",
            string: anchors.string,
            tag: anchors.markup,
            type: anchors.type,
            typeParameter: anchors.typeParameter,
            variable: anchors.variable,
        };
    }

    const anchors = {
        comment: accessibleColor(input.textSecondary, editorBackground, "#6B7280"),
        constant: "#9A3412",
        escape: "#BE185D",
        function: "#0550AE",
        keyword: "#7C3AED",
        markup: "#B42318",
        parameter: "#B45309",
        property: "#1E3A8A",
        string: "#0B6B3A",
        type: "#8A5A00",
        typeParameter: "#15803D",
        variable: accessibleColor(
            input.editorForeground,
            editorBackground,
            "#1F2937",
        ),
    } as const satisfies ComandoCodeColorAnchors;

    return {
        anchors,
        attribute: "#7C2D12",
        comment: anchors.comment,
        constant: anchors.constant,
        decorator: "#9D174D",
        escape: anchors.escape,
        function: anchors.function,
        keyword: anchors.keyword,
        macro: "#854D0E",
        namespace: "#6B21A8",
        number: anchors.constant,
        parameter: anchors.parameter,
        property: anchors.property,
        regexp: "#065F46",
        string: anchors.string,
        tag: anchors.markup,
        type: anchors.type,
        typeParameter: anchors.typeParameter,
        variable: anchors.variable,
    };
}

function createSemanticTokenColors(
    palette: ComandoTextMatePalette,
): ComandoSemanticTokenColors {
    const colors = {
        class: { foreground: palette.type },
        "class.defaultLibrary": { foreground: palette.type },
        "class.deprecated": {
            fontStyle: "strikethrough",
            foreground: palette.comment,
        },
        decorator: { foreground: palette.decorator },
        enum: { foreground: palette.type },
        enumMember: { foreground: palette.constant },
        function: { foreground: palette.function },
        "function.async": { foreground: palette.function },
        "function.defaultLibrary": { foreground: palette.function },
        interface: { foreground: palette.type },
        "interface.defaultLibrary": { foreground: palette.type },
        method: { foreground: palette.function },
        "method.async": { foreground: palette.function },
        "method.defaultLibrary": { foreground: palette.function },
        "method.static": { foreground: palette.function },
        namespace: { foreground: palette.namespace },
        parameter: { foreground: palette.parameter },
        property: { foreground: palette.property },
        "property.defaultLibrary": { foreground: palette.property },
        "property.deprecated": {
            fontStyle: "strikethrough",
            foreground: palette.comment,
        },
        "property.readonly": { foreground: palette.property },
        "property.static": { foreground: palette.property },
        type: { foreground: palette.type },
        "type.defaultLibrary": { foreground: palette.type },
        typeParameter: { foreground: palette.typeParameter },
        variable: { foreground: palette.variable },
        "variable.defaultLibrary": { foreground: palette.variable },
        "variable.deprecated": {
            fontStyle: "strikethrough",
            foreground: palette.comment,
        },
        "variable.readonly": { foreground: palette.constant },
    } satisfies ComandoSemanticTokenColors;

    for (const selector of MONACO_TYPESCRIPT_SEMANTIC_TOKEN_SELECTORS) {
        if (!colors[selector]) {
            throw new Error(`Missing semantic token color for "${selector}".`);
        }
    }

    return colors;
}

function createThemeSettings(
    input: ComandoTextMateThemeInput,
    palette: ComandoTextMatePalette,
): IRawTheme["settings"] {
    const editorForeground = normalizeRawThemeColor(
        input.editorForeground,
        input.isDark ? "#E8E8E8" : "#1C1C1C",
    );
    const editorBackground = normalizeRawThemeColor(
        input.editorBackground,
        input.isDark ? "#1C1C1C" : "#FFFFFF",
    );
    // JSX/HTML tag punctuation (< / >) should read as structural chrome, not as
    // a token. We pre-blend the variable color against the background so it
    // recedes while staying legible, and so vscode-textmate (which rejects
    // 8-digit RGBA values) still accepts the color.
    const tagPunctuationForeground = blendColors(
        palette.variable,
        editorBackground,
        0.55,
    );

    return [
        {
            settings: {
                background: editorBackground,
                foreground: editorForeground,
            },
        },
        {
            scope: [
                "comment",
                "punctuation.definition.comment",
                "markup.quote",
            ],
            settings: {
                fontStyle: "italic",
                foreground: palette.comment,
            },
        },
        {
            scope: [
                "keyword",
                "keyword.control",
                "keyword.other",
                "keyword.operator",
                "storage",
                "storage.type",
                "storage.modifier",
            ],
            settings: { foreground: palette.keyword },
        },
        {
            scope: [
                "string",
                "string.quoted",
                "string.template",
                "punctuation.definition.string",
            ],
            settings: { foreground: palette.string },
        },
        {
            scope: [
                "constant.numeric",
                "constant.numeric.integer",
                "constant.numeric.float",
            ],
            settings: { foreground: palette.number },
        },
        {
            scope: [
                "constant.language",
                "constant.other",
                "variable.other.constant",
                "variable.other.constant.ts",
                "variable.other.constant.tsx",
                "variable.other.constant.js",
                "variable.other.constant.js.jsx",
                "entity.name.constant",
            ],
            settings: { foreground: palette.constant },
        },
        {
            scope: [
                "entity.name.type",
                "entity.name.class",
                "entity.name.interface",
                "support.type",
                "support.class",
                "storage.type.class",
                "storage.type.interface",
                "storage.type.type",
                "source.ts support.type.primitive",
                "source.tsx support.type.primitive",
                "source.js support.type.primitive",
                "source.js.jsx support.type.primitive",
                "support.type.builtin.ts",
                "support.type.builtin.tsx",
            ],
            settings: { foreground: palette.type },
        },
        {
            scope: [
                "entity.name.function",
                "support.function",
                "support.function.builtin",
                "meta.function entity.name.function",
                "source.ts meta.function entity.name.function",
                "source.tsx meta.function entity.name.function",
                "source.js meta.function entity.name.function",
                "source.js.jsx meta.function entity.name.function",
                "entity.name.function.ts",
                "entity.name.function.tsx",
                "entity.name.function.js",
                "entity.name.function.js.jsx",
            ],
            settings: { foreground: palette.function },
        },
        {
            scope: [
                "variable",
                "variable.other",
                "variable.other.readwrite",
                "variable.other.readwrite.ts",
                "variable.other.readwrite.tsx",
                "variable.other.readwrite.js",
                "variable.other.readwrite.js.jsx",
                "meta.definition.variable",
            ],
            settings: { foreground: palette.variable },
        },
        {
            scope: [
                "variable.parameter",
                "meta.parameter",
                "meta.function.parameters variable",
                "source.ts meta.function.parameters variable.parameter",
                "source.tsx meta.function.parameters variable.parameter",
            ],
            settings: { foreground: palette.parameter },
        },
        {
            scope: [
                "variable.other.property",
                "variable.other.property.ts",
                "variable.other.property.tsx",
                "variable.other.property.js",
                "variable.other.property.js.jsx",
                "variable.other.property.rust",
                "variable.other.constant.property.ts",
                "variable.other.constant.property.tsx",
                "variable.other.constant.property.js",
                "variable.other.constant.property.js.jsx",
                "variable.other.member",
                "support.variable.property",
                "support.variable.property.dom",
                "meta.object-literal.key",
            ],
            settings: { foreground: palette.property },
        },
        {
            scope: [
                "meta.use.rust variable.other.rust",
                "source.rust meta.use.rust variable.other.rust",
            ],
            settings: { foreground: palette.function },
        },
        {
            scope: [
                "entity.name.namespace",
                "entity.name.module",
                "entity.name.type.module.ts",
                "entity.name.type.module.tsx",
                "entity.name.type.module.js",
                "entity.name.type.module.js.jsx",
                "support.module",
            ],
            settings: { foreground: palette.namespace },
        },
        {
            scope: [
                "entity.name.tag",
                "support.class.component",
                "meta.tag",
            ],
            settings: { foreground: palette.tag },
        },
        {
            scope: [
                "punctuation.definition.tag",
                "punctuation.definition.tag.begin",
                "punctuation.definition.tag.end",
            ],
            settings: { foreground: tagPunctuationForeground },
        },
        {
            scope: [
                "entity.other.attribute-name",
                "entity.other.attribute-name.html",
                "meta.attribute",
            ],
            settings: { foreground: palette.attribute },
        },
        {
            // JSDoc scopes: `{string}` inside `@param {string} foo` should read
            // as a type, names read as parameters/variables, and the `@tag`
            // itself reuses the decorator color to stand out.
            scope: [
                "entity.name.type.instance.jsdoc",
                "storage.type.instance.jsdoc",
            ],
            settings: { foreground: palette.type },
        },
        {
            scope: [
                "variable.other.jsdoc",
                "variable.other.description.jsdoc",
            ],
            settings: { foreground: palette.attribute },
        },
        {
            scope: [
                "keyword.other.documentation.jsdoc",
                "storage.type.class.jsdoc",
            ],
            settings: { foreground: palette.decorator },
        },
        {
            scope: [
                "string.regexp",
                "constant.other.character-class.regexp",
                "keyword.operator.quantifier.regexp",
                "keyword.control.anchor.regexp",
            ],
            settings: { foreground: palette.regexp },
        },
        {
            scope: [
                "constant.character.escape",
                "constant.character.numeric.regexp",
                "constant.character.escape.backslash.regexp",
            ],
            settings: { foreground: palette.escape },
        },
        {
            scope: [
                "entity.name.function.decorator",
                "meta.decorator",
                "punctuation.decorator",
            ],
            settings: { foreground: palette.decorator },
        },
        {
            scope: [
                "entity.name.function.macro",
                "support.function.macro",
                "keyword.control.directive",
            ],
            settings: { foreground: palette.macro },
        },
        {
            // Shiki's Markdown grammar uses `heading.N.markdown` with
            // `entity.name.section.markdown` for the ATX (`# Title`) text and
            // `markup.heading.setext.N.markdown` for setext headings. We match
            // the text scope directly so both flavors pick up the heading
            // color and bold weight.
            scope: [
                "markup.heading",
                "markup.heading entity.name",
                "entity.name.section",
            ],
            settings: {
                fontStyle: "bold",
                foreground: palette.tag,
            },
        },
        {
            scope: ["punctuation.definition.heading"],
            settings: { foreground: palette.tag },
        },
        {
            scope: ["markup.bold"],
            settings: {
                fontStyle: "bold",
                foreground: palette.variable,
            },
        },
        {
            scope: ["markup.italic"],
            settings: {
                fontStyle: "italic",
                foreground: palette.comment,
            },
        },
        {
            scope: ["markup.inline.raw", "markup.fenced_code"],
            settings: { foreground: palette.string },
        },
        {
            scope: ["invalid", "invalid.illegal", "invalid.deprecated"],
            settings: {
                fontStyle: "underline",
                foreground: palette.tag,
            },
        },
    ];
}

function collectIndexedColorMap(rawTheme: IRawTheme): readonly string[] {
    const colorMap = [UNUSED_COLOR_ID_ZERO];
    const seen = new Set<string>(colorMap);

    for (const setting of rawTheme.settings) {
        const colors = [
            setting.settings.foreground,
            setting.settings.background,
        ].filter((color): color is string => typeof color === "string");

        for (const color of colors) {
            const normalizedColor = normalizeRawThemeColor(color, color);
            if (!seen.has(normalizedColor)) {
                seen.add(normalizedColor);
                colorMap.push(normalizedColor);
            }
        }
    }

    return colorMap;
}

export function createComandoTextMateTheme(
    input: ComandoTextMateThemeInput,
): ComandoTextMateTheme {
    // Accent is intentionally excluded from the cache key since it does not
    // participate in the palette or the raw theme settings.
    const cacheKey = [
        input.themeName,
        normalizeRawThemeColor(
            input.editorBackground,
            input.isDark ? "#1C1C1C" : "#FFFFFF",
        ),
        normalizeRawThemeColor(
            input.editorForeground,
            input.isDark ? "#E8E8E8" : "#1C1C1C",
        ),
        normalizeRawThemeColor(
            input.textSecondary,
            input.isDark ? "#8A8A8A" : "#737373",
        ),
        input.isDark ? "dark" : "light",
    ].join("|");
    const cachedTheme = textMateThemeCache.get(cacheKey);

    if (cachedTheme) {
        return cachedTheme;
    }

    const palette = createPalette(input);
    const rawTheme: IRawTheme = {
        name: input.themeName,
        settings: createThemeSettings(input, palette),
    };
    const semanticTokenColors = createSemanticTokenColors(palette);
    const indexedColorMap = collectIndexedColorMap(rawTheme);
    const theme: ComandoTextMateTheme = {
        encodedTokensColors: indexedColorMap.slice(1),
        indexedColorMap,
        palette,
        rawTheme,
        semanticTokenColors,
        themeName: input.themeName,
    };

    textMateThemeCache.set(cacheKey, theme);
    return theme;
}

/**
 * Builds the minimal set of Monarch/basic-language fallback rules that
 * `monaco.editor.defineTheme` needs. Every scope that TextMate already
 * covers via `IRawTheme.settings` is deliberately omitted here — those
 * tokens are painted through the encoded color map and duplicating them
 * in the `rules` array only bloats Monaco's theme trie.
 *
 * Only generic tokens emitted by Monaco's basic-languages Monarch
 * tokenizers (`type.identifier`, `identifier`, `number`, bare `string`,
 * `regexp`, `tag`, `annotation`, ...) live here, plus a small set of
 * TextMate-style fallbacks that some in-tree Monarch definitions reuse.
 *
 * Foregrounds come from the palette as `#RRGGBB`. Callers that feed them
 * into Monaco must drop the leading `#`, since `ITokenThemeRule.foreground`
 * expects the bare hex without the hash.
 */
export function createMonarchFallbackRules(
    palette: ComandoTextMatePalette,
): readonly ComandoMonarchThemeRule[] {
    return [
        // Comments
        { token: "comment", foreground: palette.comment, fontStyle: "italic" },

        // Keywords / operators / storage
        { token: "keyword", foreground: palette.keyword },
        { token: "keyword.control", foreground: palette.keyword },
        { token: "keyword.other", foreground: palette.keyword },
        { token: "keyword.operator", foreground: palette.keyword },
        { token: "operator", foreground: palette.keyword },
        { token: "operators", foreground: palette.keyword },
        { token: "storage", foreground: palette.keyword },
        { token: "storage.modifier", foreground: palette.keyword },
        { token: "storage.type", foreground: palette.type },

        // Strings
        { token: "string", foreground: palette.string },
        { token: "string.quoted", foreground: palette.string },

        // Numbers / constants
        { token: "number", foreground: palette.number },
        { token: "constant", foreground: palette.constant },
        { token: "constant.language", foreground: palette.constant },

        // Regex (Monaco basic SQL and a few others)
        { token: "regexp", foreground: palette.regexp },

        // Types / classes / interfaces
        { token: "type", foreground: palette.type },
        { token: "type.identifier", foreground: palette.type },
        { token: "class", foreground: palette.type },
        { token: "interface", foreground: palette.type },
        { token: "enum", foreground: palette.type },

        // Functions / methods
        { token: "function", foreground: palette.function },
        { token: "function.method", foreground: palette.function },
        { token: "method", foreground: palette.function },

        // Markup (Monaco HTML/XML Monarch emits `tag`, attribute.name, etc.)
        { token: "tag", foreground: palette.tag },
        { token: "attribute.name", foreground: palette.attribute },
        { token: "meta.attribute", foreground: palette.attribute },
        { token: "attribute.value", foreground: palette.string },

        // Variables
        { token: "variable", foreground: palette.variable },
        { token: "variable.other", foreground: palette.variable },
        { token: "variable.parameter", foreground: palette.parameter },
        { token: "variable.predefined", foreground: palette.constant },

        // Annotations / decorators (Java, Kotlin, Python Monarch)
        { token: "annotation", foreground: palette.decorator },
        { token: "decorator", foreground: palette.decorator },

        // Semantic token selectors (bare, without modifiers). Modifier
        // variants live in `createMonacoSemanticTokenRules` and are
        // appended by the caller.
        { token: "namespace", foreground: palette.namespace },
        { token: "parameter", foreground: palette.parameter },
        { token: "property", foreground: palette.property },
        { token: "typeParameter", foreground: palette.typeParameter },
        { token: "enumMember", foreground: palette.constant },

        // Errors
        {
            token: "invalid",
            foreground: palette.tag,
            fontStyle: "underline",
        },

        // Markdown Monarch fallbacks
        {
            token: "markup.heading",
            foreground: palette.tag,
            fontStyle: "bold",
        },
        {
            token: "markup.bold",
            foreground: palette.variable,
            fontStyle: "bold",
        },
        {
            token: "markup.italic",
            foreground: palette.comment,
            fontStyle: "italic",
        },
        { token: "markup.inline.raw", foreground: palette.string },
        { token: "markup.fenced_code", foreground: palette.string },
    ];
}
