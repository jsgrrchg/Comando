declare module "monaco-editor/esm/vs/basic-languages/*" {
    import type * as monaco from "monaco-editor";

    export const conf: monaco.languages.LanguageConfiguration | undefined;
    export const language: monaco.languages.IMonarchLanguage;
}

declare module "monaco-editor/esm/vs/language/json/tokenization.js" {
    import type * as monaco from "monaco-editor";

    export function createTokenizationSupport(
        allowComments: boolean,
    ): monaco.languages.TokensProvider;
}
