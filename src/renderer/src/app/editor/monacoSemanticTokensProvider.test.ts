import { describe, expect, it } from "vitest";

import {
    COMANDO_SEMANTIC_TOKENS_LEGEND,
    convertTsSpansToMonacoTokens,
} from "./monacoSemanticTokensProvider";
import {
    MONACO_TYPESCRIPT_SEMANTIC_TOKEN_MODIFIERS,
    MONACO_TYPESCRIPT_SEMANTIC_TOKEN_TYPES,
} from "./monacoSemanticTokens";

// TypeScript token classification encoding: (tokenType + 1) << 8 | modifiersBitmask.
// Mirrors enum TokenEncodingConsts from typescript.d.ts.
function encodeTsClassification(
    tsTokenType: number,
    tsModifiersBitmask = 0,
): number {
    return ((tsTokenType + 1) << 8) | (tsModifiersBitmask & 0xff);
}

// TypeScript TokenType ordinals; must match TS_TOKEN_TYPE_NAMES in the provider.
const TS_TOKEN_TYPE = {
    class: 0,
    enum: 1,
    interface: 2,
    namespace: 3,
    typeParameter: 4,
    type: 5,
    parameter: 6,
    variable: 7,
    enumMember: 8,
    property: 9,
    function: 10,
    member: 11,
} as const;

// TypeScript TokenModifier bit positions; must match TS_TOKEN_MODIFIER_NAMES.
const TS_TOKEN_MODIFIER_BIT = {
    declaration: 0,
    static: 1,
    async: 2,
    readonly: 3,
    defaultLibrary: 4,
    local: 5,
} as const;

function monacoTypeIndex(name: string): number {
    const index = COMANDO_SEMANTIC_TOKENS_LEGEND.tokenTypes.indexOf(name);
    if (index === -1) {
        throw new Error(`Unknown Monaco token type: ${name}`);
    }
    return index;
}

function monacoModifierBit(name: string): number {
    const index = COMANDO_SEMANTIC_TOKENS_LEGEND.tokenModifiers.indexOf(name);
    if (index === -1) {
        throw new Error(`Unknown Monaco token modifier: ${name}`);
    }
    return 1 << index;
}

describe("monacoSemanticTokensProvider legend", () => {
    it("exposes the Monaco token types declared in monacoSemanticTokens", () => {
        expect(COMANDO_SEMANTIC_TOKENS_LEGEND.tokenTypes).toEqual([
            ...MONACO_TYPESCRIPT_SEMANTIC_TOKEN_TYPES,
        ]);
    });

    it("exposes the Monaco token modifiers declared in monacoSemanticTokens", () => {
        expect(COMANDO_SEMANTIC_TOKENS_LEGEND.tokenModifiers).toEqual([
            ...MONACO_TYPESCRIPT_SEMANTIC_TOKEN_MODIFIERS,
        ]);
    });
});

describe("convertTsSpansToMonacoTokens", () => {
    it("returns an empty Uint32Array when no spans are provided", () => {
        const result = convertTsSpansToMonacoTokens([], "const answer = 42;");
        expect(result).toBeInstanceOf(Uint32Array);
        expect(result.length).toBe(0);
    });

    it("encodes a single-line variable declaration as a Monaco quintuple", () => {
        const text = "const answer = 42;";
        const start = text.indexOf("answer");
        const spans = [
            start,
            "answer".length,
            encodeTsClassification(
                TS_TOKEN_TYPE.variable,
                (1 << TS_TOKEN_MODIFIER_BIT.declaration) |
                    (1 << TS_TOKEN_MODIFIER_BIT.readonly),
            ),
        ];

        const result = convertTsSpansToMonacoTokens(spans, text);

        expect(Array.from(result)).toEqual([
            0,
            start,
            "answer".length,
            monacoTypeIndex("variable"),
            monacoModifierBit("declaration") | monacoModifierBit("readonly"),
        ]);
    });

    it("delta-encodes multiple tokens spanning several lines", () => {
        const text = [
            "class Repository {", // line 0
            "    readonly kind = 'repo';", // line 1
            "    findById(id) { return id; }", // line 2
        ].join("\n");

        const classStart = text.indexOf("Repository");
        const kindStart = text.indexOf("kind");
        const findStart = text.indexOf("findById");
        const idParamStart =
            findStart + "findById".length + 1; /* '(' */

        const spans = [
            classStart,
            "Repository".length,
            encodeTsClassification(
                TS_TOKEN_TYPE.class,
                1 << TS_TOKEN_MODIFIER_BIT.declaration,
            ),
            kindStart,
            "kind".length,
            encodeTsClassification(
                TS_TOKEN_TYPE.property,
                (1 << TS_TOKEN_MODIFIER_BIT.declaration) |
                    (1 << TS_TOKEN_MODIFIER_BIT.readonly),
            ),
            findStart,
            "findById".length,
            encodeTsClassification(
                TS_TOKEN_TYPE.member,
                1 << TS_TOKEN_MODIFIER_BIT.declaration,
            ),
            idParamStart,
            "id".length,
            encodeTsClassification(TS_TOKEN_TYPE.parameter),
        ];

        const result = Array.from(
            convertTsSpansToMonacoTokens(spans, text),
        );

        // Expected deltas:
        // - first token: absolute line/col (0, classStart)
        // - second token: +1 line, col = indent-relative "kind"
        // - third token: +1 line, col = "findById" column
        // - fourth token: same line as "findById", delta col = ("findById".length + 1)
        const classColumn = classStart;
        const kindColumn = text.split("\n")[1].indexOf("kind");
        const findByIdColumn = text.split("\n")[2].indexOf("findById");
        const deltaFromFindToId = "findById".length + 1;

        expect(result).toEqual([
            0,
            classColumn,
            "Repository".length,
            monacoTypeIndex("class"),
            monacoModifierBit("declaration"),
            1,
            kindColumn,
            "kind".length,
            monacoTypeIndex("property"),
            monacoModifierBit("declaration") | monacoModifierBit("readonly"),
            1,
            findByIdColumn,
            "findById".length,
            monacoTypeIndex("method"),
            monacoModifierBit("declaration"),
            0,
            deltaFromFindToId,
            "id".length,
            monacoTypeIndex("parameter"),
            0,
        ]);
    });

    it("skips malformed spans (zero length or out-of-range start)", () => {
        const text = "const x = 1;";
        const spans = [
            -1,
            3,
            encodeTsClassification(TS_TOKEN_TYPE.variable),
            0,
            0,
            encodeTsClassification(TS_TOKEN_TYPE.variable),
            6,
            1,
            encodeTsClassification(TS_TOKEN_TYPE.variable),
        ];

        const result = Array.from(convertTsSpansToMonacoTokens(spans, text));

        // Only the third span should survive.
        expect(result).toEqual([
            0,
            6,
            1,
            monacoTypeIndex("variable"),
            0,
        ]);
    });

    it("falls back to variable for unknown TypeScript token types", () => {
        const text = "abc";
        const unknownTsType = 99;
        const spans = [0, 3, encodeTsClassification(unknownTsType)];

        const result = Array.from(convertTsSpansToMonacoTokens(spans, text));

        expect(result).toEqual([0, 0, 3, monacoTypeIndex("variable"), 0]);
    });

    it("ignores modifier bits that do not map to Monaco modifiers", () => {
        const text = "abc";
        // 'local' exists in TS but not in the Monaco legend; it must be stripped.
        const spans = [
            0,
            3,
            encodeTsClassification(
                TS_TOKEN_TYPE.variable,
                1 << TS_TOKEN_MODIFIER_BIT.local,
            ),
        ];

        const result = Array.from(convertTsSpansToMonacoTokens(spans, text));

        expect(result).toEqual([0, 0, 3, monacoTypeIndex("variable"), 0]);
    });
});
