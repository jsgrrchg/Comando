/// <reference types="node" />

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { OnigScanner, OnigString, loadWASM } from "vscode-oniguruma";
import { INITIAL, Registry, type IRawGrammar } from "vscode-textmate";

import {
    TEXT_MATE_GRAMMAR_DEFINITIONS,
    type TextMateGrammarDefinition,
} from "./monacoTextmateLanguages";

const grammarDefinitionsByScope = new Map<string, TextMateGrammarDefinition>(
    TEXT_MATE_GRAMMAR_DEFINITIONS.map((definition) => [
        definition.scopeName,
        definition,
    ]),
);

const rawGrammarCache = new Map<string, IRawGrammar>();
let onigWasmPromise: Promise<void> | null = null;

function loadOnigWasm() {
    if (!onigWasmPromise) {
        onigWasmPromise = (async () => {
            const wasmBytes = await readFile(
                join(
                    process.cwd(),
                    "node_modules/vscode-oniguruma/release/onig.wasm",
                ),
            );
            const wasmBuffer = wasmBytes.buffer.slice(
                wasmBytes.byteOffset,
                wasmBytes.byteOffset + wasmBytes.byteLength,
            );

            await loadWASM(wasmBuffer);
        })();
    }

    return onigWasmPromise;
}

function getRawGrammarScopeName(grammar: unknown): string | null {
    if (
        typeof grammar === "object" &&
        grammar !== null &&
        "scopeName" in grammar &&
        typeof grammar.scopeName === "string"
    ) {
        return grammar.scopeName;
    }

    return null;
}

async function loadRawGrammarByScope(
    scopeName: string,
): Promise<IRawGrammar | null> {
    const cachedGrammar = rawGrammarCache.get(scopeName);
    if (cachedGrammar) {
        return cachedGrammar;
    }

    const definition = grammarDefinitionsByScope.get(scopeName);
    if (!definition) {
        return null;
    }

    const grammarModule = await definition.loadModule();
    for (const grammar of grammarModule.default) {
        const grammarScopeName = getRawGrammarScopeName(grammar);
        if (grammarScopeName) {
            rawGrammarCache.set(grammarScopeName, grammar as IRawGrammar);
        }
    }

    return rawGrammarCache.get(scopeName) ?? null;
}

function createRegistry() {
    return new Registry({
        loadGrammar: loadRawGrammarByScope,
        onigLib: loadOnigWasm().then(() => ({
            createOnigScanner: (sources: string[]) => new OnigScanner(sources),
            createOnigString: (source: string) => new OnigString(source),
        })),
    });
}

function collectScopes(grammar: NonNullable<Awaited<ReturnType<Registry["loadGrammar"]>>>, line: string) {
    return grammar.tokenizeLine(line, INITIAL).tokens.flatMap((token) => [
        ...token.scopes,
    ]);
}

function hasScopeContaining(
    grammar: NonNullable<Awaited<ReturnType<Registry["loadGrammar"]>>>,
    line: string,
    expectedText: string,
    expectedScope: string,
) {
    const token = grammar
        .tokenizeLine(line, INITIAL)
        .tokens.find(
            (candidate) =>
                candidate.startIndex <= line.indexOf(expectedText) &&
                line.indexOf(expectedText) < candidate.endIndex,
        );

    return token?.scopes.some((scope) => scope.includes(expectedScope)) ?? false;
}

describe("TextMate React language ids", () => {
    it("keeps TypeScript and TSX grammars separate", async () => {
        const registry = createRegistry();
        const typescriptGrammar = await registry.loadGrammar("source.ts");
        const tsxGrammar = await registry.loadGrammar("source.tsx");
        const tsLine = `const compare = left < right ? left : right;`;
        const tsxLine = `const view = <Button title={label}>{label}</Button>;`;

        expect(typescriptGrammar).not.toBeNull();
        expect(tsxGrammar).not.toBeNull();
        expect(
            collectScopes(typescriptGrammar!, tsLine).some((scope) =>
                scope.includes("entity.name.tag"),
            ),
        ).toBe(false);
        expect(
            hasScopeContaining(
                tsxGrammar!,
                tsxLine,
                "Button",
                "entity.name.tag",
            ),
        ).toBe(true);
        expect(
            hasScopeContaining(
                tsxGrammar!,
                tsxLine,
                "title",
                "entity.other.attribute-name",
            ),
        ).toBe(true);
    });

    it("keeps JavaScript and JSX grammars separate", async () => {
        const registry = createRegistry();
        const javascriptGrammar = await registry.loadGrammar("source.js");
        const jsxGrammar = await registry.loadGrammar("source.js.jsx");
        const jsLine = `const compare = left < right ? left : right;`;
        const jsxLine = `const view = <button aria-label={label}>{label}</button>;`;

        expect(javascriptGrammar).not.toBeNull();
        expect(jsxGrammar).not.toBeNull();
        expect(
            collectScopes(javascriptGrammar!, jsLine).some((scope) =>
                scope.includes("entity.name.tag"),
            ),
        ).toBe(false);
        expect(
            hasScopeContaining(
                jsxGrammar!,
                jsxLine,
                "button",
                "entity.name.tag",
            ),
        ).toBe(true);
        expect(
            hasScopeContaining(
                jsxGrammar!,
                jsxLine,
                "aria-label",
                "entity.other.attribute-name",
            ),
        ).toBe(true);
    });
});
