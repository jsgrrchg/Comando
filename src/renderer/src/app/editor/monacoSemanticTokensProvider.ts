import type * as monaco from "monaco-editor";

import {
    MONACO_TYPESCRIPT_SEMANTIC_TOKEN_MODIFIERS,
    MONACO_TYPESCRIPT_SEMANTIC_TOKEN_TYPES,
} from "./monacoSemanticTokens";

type MonacoNamespace = typeof import("monaco-editor");

// Encoding constants used by TypeScript's getEncodedSemanticClassifications.
// Source: node_modules/typescript/lib/typescript.d.ts, enum TokenEncodingConsts.
// typeOffset = 8 means the 24 high bits store the TS token type + 1, and
// the low 8 bits store a bitmask of TS token modifiers.
const TS_TOKEN_TYPE_OFFSET = 8;
const TS_TOKEN_MODIFIER_MASK = (1 << TS_TOKEN_TYPE_OFFSET) - 1;
const TS_SEMANTIC_CLASSIFICATION_FORMAT = "2020";
// TypeScript emits spans as flat arrays of triples (start, length, classification).
const TS_SPAN_TUPLE_LENGTH = 3;
// Monaco expects encoded tokens as quintuples
// (deltaLine, deltaStartChar, length, tokenType, tokenModifiers).
const MONACO_TOKEN_TUPLE_LENGTH = 5;

// Mirrors the TypeScript internal TokenType enum (see typescriptServices.js,
// enum TokenType in Monaco's bundled TypeScript services). Keep indices stable
// against upstream TS; the values below were verified against TypeScript 5.x.
const TS_TOKEN_TYPE_NAMES = [
    "class",
    "enum",
    "interface",
    "namespace",
    "typeParameter",
    "type",
    "parameter",
    "variable",
    "enumMember",
    "property",
    "function",
    "member",
] as const;

// Mirrors the TypeScript internal TokenModifier enum, same source.
const TS_TOKEN_MODIFIER_NAMES = [
    "declaration",
    "static",
    "async",
    "readonly",
    "defaultLibrary",
    "local",
] as const;

// TS's "member" is effectively "method" in Monaco/LSP vocabulary.
const TS_TOKEN_TYPE_TO_MONACO_NAME: Readonly<Record<string, string>> = {
    class: "class",
    enum: "enum",
    interface: "interface",
    namespace: "namespace",
    typeParameter: "typeParameter",
    type: "type",
    parameter: "parameter",
    variable: "variable",
    enumMember: "enumMember",
    property: "property",
    function: "function",
    member: "method",
};

const MONACO_TYPESCRIPT_LANGUAGE_IDS = [
    "typescript",
    "typescriptreact",
    "javascript",
    "javascriptreact",
] as const;

const JAVASCRIPT_FAMILY_LANGUAGE_IDS = new Set([
    "javascript",
    "javascriptreact",
]);

const SEMANTIC_TOKENS_INSTALLED_FLAG = "__comandoSemanticTokensInstalled";

type InstalledFlagCarrier = typeof globalThis & {
    [SEMANTIC_TOKENS_INSTALLED_FLAG]?: boolean;
};

export interface ComandoSemanticTokensLegend {
    readonly tokenTypes: readonly string[];
    readonly tokenModifiers: readonly string[];
}

export const COMANDO_SEMANTIC_TOKENS_LEGEND: ComandoSemanticTokensLegend = {
    tokenTypes: [...MONACO_TYPESCRIPT_SEMANTIC_TOKEN_TYPES],
    tokenModifiers: [...MONACO_TYPESCRIPT_SEMANTIC_TOKEN_MODIFIERS],
};

// Precomputed lookups for fast decoding.
const MONACO_TOKEN_TYPE_INDEX: ReadonlyMap<string, number> = new Map(
    COMANDO_SEMANTIC_TOKENS_LEGEND.tokenTypes.map((name, index) => [name, index]),
);

const MONACO_TOKEN_MODIFIER_INDEX: ReadonlyMap<string, number> = new Map(
    COMANDO_SEMANTIC_TOKENS_LEGEND.tokenModifiers.map((name, index) => [
        name,
        index,
    ]),
);

const FALLBACK_MONACO_TOKEN_TYPE_INDEX =
    MONACO_TOKEN_TYPE_INDEX.get("variable") ?? 0;

function resolveMonacoTokenTypeIndex(tsTokenType: number): number {
    const tsName = TS_TOKEN_TYPE_NAMES[tsTokenType];
    if (tsName === undefined) {
        return FALLBACK_MONACO_TOKEN_TYPE_INDEX;
    }

    const monacoName = TS_TOKEN_TYPE_TO_MONACO_NAME[tsName];
    if (monacoName === undefined) {
        return FALLBACK_MONACO_TOKEN_TYPE_INDEX;
    }

    return (
        MONACO_TOKEN_TYPE_INDEX.get(monacoName) ??
        FALLBACK_MONACO_TOKEN_TYPE_INDEX
    );
}

function resolveMonacoModifiersBitmask(tsModifiersBitmask: number): number {
    let monacoBitmask = 0;

    for (let bit = 0; bit < TS_TOKEN_MODIFIER_NAMES.length; bit += 1) {
        if ((tsModifiersBitmask & (1 << bit)) === 0) {
            continue;
        }

        const tsName = TS_TOKEN_MODIFIER_NAMES[bit];
        if (tsName === undefined) {
            continue;
        }

        const monacoIndex = MONACO_TOKEN_MODIFIER_INDEX.get(tsName);
        if (monacoIndex === undefined) {
            continue;
        }

        monacoBitmask |= 1 << monacoIndex;
    }

    return monacoBitmask;
}

interface LineIndexLookup {
    readonly lineStartOffsets: readonly number[];
    readonly totalLength: number;
}

function buildLineIndexLookup(text: string): LineIndexLookup {
    const lineStartOffsets: number[] = [0];
    for (let index = 0; index < text.length; index += 1) {
        if (text.charCodeAt(index) === 10 /* \n */) {
            lineStartOffsets.push(index + 1);
        }
    }

    return {
        lineStartOffsets,
        totalLength: text.length,
    };
}

interface LineColumn {
    readonly line: number;
    readonly column: number;
}

function offsetToLineColumn(
    offset: number,
    lookup: LineIndexLookup,
): LineColumn {
    const { lineStartOffsets } = lookup;
    // Binary search for the greatest lineStart <= offset.
    let low = 0;
    let high = lineStartOffsets.length - 1;
    while (low < high) {
        const mid = (low + high + 1) >>> 1;
        const lineStart = lineStartOffsets[mid] ?? 0;
        if (lineStart <= offset) {
            low = mid;
        } else {
            high = mid - 1;
        }
    }

    const lineStart = lineStartOffsets[low] ?? 0;
    return { line: low, column: offset - lineStart };
}

/**
 * Converts TypeScript getEncodedSemanticClassifications output (flat triples
 * of start/length/classification) into Monaco's delta-encoded quintuples.
 *
 * Exported for unit testing; callers typically go through
 * createTypeScriptSemanticTokensProvider.
 */
export function convertTsSpansToMonacoTokens(
    spans: readonly number[],
    text: string,
): Uint32Array {
    if (spans.length === 0) {
        return new Uint32Array(0);
    }

    const lookup = buildLineIndexLookup(text);
    const tokenCount = Math.floor(spans.length / TS_SPAN_TUPLE_LENGTH);
    const data = new Uint32Array(tokenCount * MONACO_TOKEN_TUPLE_LENGTH);

    let writeIndex = 0;
    let previousLine = 0;
    let previousStartColumn = 0;
    let previousValid = false;

    for (let tokenIndex = 0; tokenIndex < tokenCount; tokenIndex += 1) {
        const spanBase = tokenIndex * TS_SPAN_TUPLE_LENGTH;
        const start = spans[spanBase] ?? 0;
        const length = spans[spanBase + 1] ?? 0;
        const classification = spans[spanBase + 2] ?? 0;

        if (length <= 0 || start < 0 || start >= lookup.totalLength) {
            continue;
        }

        const tsTokenType = (classification >> TS_TOKEN_TYPE_OFFSET) - 1;
        const tsModifiersBitmask = classification & TS_TOKEN_MODIFIER_MASK;

        if (tsTokenType < 0) {
            continue;
        }

        const monacoTokenType = resolveMonacoTokenTypeIndex(tsTokenType);
        const monacoModifiers = resolveMonacoModifiersBitmask(
            tsModifiersBitmask,
        );

        const { line, column } = offsetToLineColumn(start, lookup);
        const deltaLine = previousValid ? line - previousLine : line;
        const deltaStartColumn =
            previousValid && deltaLine === 0
                ? column - previousStartColumn
                : column;

        data[writeIndex] = deltaLine;
        data[writeIndex + 1] = deltaStartColumn;
        data[writeIndex + 2] = length;
        data[writeIndex + 3] = monacoTokenType;
        data[writeIndex + 4] = monacoModifiers;
        writeIndex += MONACO_TOKEN_TUPLE_LENGTH;

        previousLine = line;
        previousStartColumn = column;
        previousValid = true;
    }

    if (writeIndex === data.length) {
        return data;
    }

    return data.slice(0, writeIndex);
}

interface TypeScriptSemanticWorkerApi {
    readonly getEncodedSemanticClassifications?: (
        fileName: string,
        span: { readonly start: number; readonly length: number },
        format?: string,
    ) => Promise<{ readonly spans: readonly number[] } | undefined>;
}

type MonacoTypeScriptNamespace = {
    readonly getTypeScriptWorker?: () => Promise<
        (...uris: monaco.Uri[]) => Promise<TypeScriptSemanticWorkerApi>
    >;
    readonly getJavaScriptWorker?: () => Promise<
        (...uris: monaco.Uri[]) => Promise<TypeScriptSemanticWorkerApi>
    >;
};

async function resolveSemanticWorker(
    monacoApi: MonacoNamespace,
    model: monaco.editor.ITextModel,
): Promise<TypeScriptSemanticWorkerApi | null> {
    const tsNamespace = monacoApi.languages
        .typescript as unknown as MonacoTypeScriptNamespace;
    const languageId = model.getLanguageId();
    const isJavaScript = JAVASCRIPT_FAMILY_LANGUAGE_IDS.has(languageId);

    const accessorFactory = isJavaScript
        ? tsNamespace.getJavaScriptWorker
        : tsNamespace.getTypeScriptWorker;

    if (typeof accessorFactory !== "function") {
        return null;
    }

    try {
        const accessor = await accessorFactory();
        const worker = await accessor(model.uri);
        return worker ?? null;
    } catch {
        return null;
    }
}

function createSemanticTokensProvider(
    monacoApi: MonacoNamespace,
): monaco.languages.DocumentSemanticTokensProvider {
    return {
        getLegend: () => ({
            tokenTypes: [...COMANDO_SEMANTIC_TOKENS_LEGEND.tokenTypes],
            tokenModifiers: [...COMANDO_SEMANTIC_TOKENS_LEGEND.tokenModifiers],
        }),
        provideDocumentSemanticTokens: async (model) => {
            const worker = await resolveSemanticWorker(monacoApi, model);
            // The Monaco 0.55 bundled TypeScript worker adapter does not
            // surface getEncodedSemanticClassifications in its TypeScript
            // typings. In practice, the worker instance proxied by Monaco is
            // class-bound, so the method is only reachable when a custom
            // worker extension exposes it. We probe at runtime and fall back
            // to an empty token set to avoid breaking highlighting.
            if (!worker || typeof worker.getEncodedSemanticClassifications !== "function") {
                return { data: new Uint32Array(0), resultId: undefined };
            }

            try {
                const text = model.getValue();
                const response = await worker.getEncodedSemanticClassifications(
                    model.uri.toString(),
                    { start: 0, length: text.length },
                    TS_SEMANTIC_CLASSIFICATION_FORMAT,
                );

                if (!response || !Array.isArray(response.spans)) {
                    return { data: new Uint32Array(0), resultId: undefined };
                }

                return {
                    data: convertTsSpansToMonacoTokens(response.spans, text),
                    resultId: undefined,
                };
            } catch {
                return { data: new Uint32Array(0), resultId: undefined };
            }
        },
        releaseDocumentSemanticTokens: () => {
            // No-op: we don't return a resultId for incremental updates.
        },
    };
}

/**
 * Factory exposed for tests; production code should prefer
 * installMonacoSemanticTokensProviders.
 */
export function createTypeScriptSemanticTokensProvider(
    monacoApi: MonacoNamespace,
): monaco.languages.DocumentSemanticTokensProvider {
    return createSemanticTokensProvider(monacoApi);
}

export function installMonacoSemanticTokensProviders(
    monacoApi: MonacoNamespace,
): void {
    const carrier = globalThis as InstalledFlagCarrier;
    if (carrier[SEMANTIC_TOKENS_INSTALLED_FLAG]) {
        return;
    }

    const provider = createSemanticTokensProvider(monacoApi);
    for (const languageId of MONACO_TYPESCRIPT_LANGUAGE_IDS) {
        monacoApi.languages.registerDocumentSemanticTokensProvider(
            languageId,
            provider,
        );
    }

    carrier[SEMANTIC_TOKENS_INSTALLED_FLAG] = true;
}
