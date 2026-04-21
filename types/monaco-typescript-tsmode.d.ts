declare module "monaco-editor/esm/vs/common/initialize.js" {
    export function initialize(
        callback: (ctx: unknown, createData: unknown) => unknown,
    ): void;
    export function isWorkerInitialized(): boolean;
}

declare module "monaco-editor/esm/vs/language/typescript/tsWorker.js" {
    // Only the exports we consume. The stock TypeScriptWorker is a runtime
    // class; we subclass it and rely on the `_languageService` field.
    export const TypeScriptWorker: new (ctx: unknown, createData: unknown) => {
        _languageService: unknown;
    };
    export function create(ctx: unknown, createData: unknown): unknown;
}

declare module "monaco-editor/esm/vs/language/typescript/tsMode.js" {
    import type * as monaco from "monaco-editor";

    export interface TypeScriptModeConfiguration {
        readonly codeActions?: boolean;
        readonly completionItems?: boolean;
        readonly definitions?: boolean;
        readonly diagnostics?: boolean;
        readonly documentHighlights?: boolean;
        readonly documentRangeFormattingEdits?: boolean;
        readonly documentSymbols?: boolean;
        readonly hovers?: boolean;
        readonly inlayHints?: boolean;
        readonly onTypeFormattingEdits?: boolean;
        readonly references?: boolean;
        readonly rename?: boolean;
        readonly signatureHelp?: boolean;
    }

    export interface TypeScriptLanguageServiceDefaults {
        readonly modeConfiguration: TypeScriptModeConfiguration;
        onDidChange(listener: () => void): monaco.IDisposable;
    }

    export type TypeScriptWorker = unknown;

    export type TypeScriptWorkerAccessor = (
        ...resources: monaco.Uri[]
    ) => Promise<TypeScriptWorker>;

    export class WorkerManager {
        public constructor(
            modeId: string,
            defaults: TypeScriptLanguageServiceDefaults,
        );

        public dispose(): void;
        public getLanguageServiceWorker(
            ...resources: monaco.Uri[]
        ): Promise<TypeScriptWorker>;
    }

    export class LibFiles {
        public constructor(worker: TypeScriptWorkerAccessor);
    }

    export const CodeActionAdaptor: {
        new (
            worker: TypeScriptWorkerAccessor,
        ): monaco.languages.CodeActionProvider;
    };
    export const DefinitionAdapter: {
        new (
            libFiles: LibFiles,
            worker: TypeScriptWorkerAccessor,
        ): monaco.languages.DefinitionProvider;
    };
    export const DiagnosticsAdapter: {
        new (
            libFiles: LibFiles,
            defaults: TypeScriptLanguageServiceDefaults,
            modeId: string,
            worker: TypeScriptWorkerAccessor,
        ): monaco.IDisposable;
    };
    export const DocumentHighlightAdapter: {
        new (
            worker: TypeScriptWorkerAccessor,
        ): monaco.languages.DocumentHighlightProvider;
    };
    export const FormatAdapter: {
        new (
            worker: TypeScriptWorkerAccessor,
        ): monaco.languages.DocumentRangeFormattingEditProvider;
    };
    export const FormatOnTypeAdapter: {
        new (
            worker: TypeScriptWorkerAccessor,
        ): monaco.languages.OnTypeFormattingEditProvider;
    };
    export const InlayHintsAdapter: {
        new (
            worker: TypeScriptWorkerAccessor,
        ): monaco.languages.InlayHintsProvider;
    };
    export const OutlineAdapter: {
        new (
            worker: TypeScriptWorkerAccessor,
        ): monaco.languages.DocumentSymbolProvider;
    };
    export const QuickInfoAdapter: {
        new (worker: TypeScriptWorkerAccessor): monaco.languages.HoverProvider;
    };
    export const ReferenceAdapter: {
        new (
            libFiles: LibFiles,
            worker: TypeScriptWorkerAccessor,
        ): monaco.languages.ReferenceProvider;
    };
    export const RenameAdapter: {
        new (
            libFiles: LibFiles,
            worker: TypeScriptWorkerAccessor,
        ): monaco.languages.RenameProvider;
    };
    export const SignatureHelpAdapter: {
        new (
            worker: TypeScriptWorkerAccessor,
        ): monaco.languages.SignatureHelpProvider;
    };
    export const SuggestAdapter: {
        new (
            worker: TypeScriptWorkerAccessor,
        ): monaco.languages.CompletionItemProvider;
    };
}
