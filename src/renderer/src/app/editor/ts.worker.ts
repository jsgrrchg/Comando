// Custom Monaco TypeScript worker entry point.
//
// Monaco 0.55 ships a worker adapter (tsMode.js) that proxies a hard-coded set
// of LanguageService methods. `getEncodedSemanticClassifications` and
// `getEncodedSyntacticClassifications` exist on the underlying TypeScript
// language service but are not surfaced by the bundled adapter. This file
// replaces the stock ts.worker.js bootstrap with a subclass that forwards those
// two methods so the DocumentSemanticTokensProvider in the main thread can
// consume real classifications.
//
// The proxy layer in Monaco dispatches every foreign method through
// EditorWorker.$fmr (see editorWebWorker.js) which reflects on the worker
// instance by name, so adding methods to this subclass is enough — no AMD
// customWorkerPath / importScripts plumbing is needed.

// `../../common/initialize.js` is the same entry point the stock ts.worker.js
// uses; we import it by its published path to avoid relying on private module
// layout.
import { initialize } from "monaco-editor/esm/vs/common/initialize.js";
import { TypeScriptWorker } from "monaco-editor/esm/vs/language/typescript/tsWorker.js";

type LanguageService = {
    getEncodedSemanticClassifications?: (
        fileName: string,
        span: { readonly start: number; readonly length: number },
        format: string,
    ) => { readonly spans: readonly number[]; readonly endOfLineState: number };
    getEncodedSyntacticClassifications?: (
        fileName: string,
        span: { readonly start: number; readonly length: number },
    ) => { readonly spans: readonly number[]; readonly endOfLineState: number };
};

interface TypeScriptWorkerCtor {
    new (ctx: unknown, createData: unknown): {
        _languageService: LanguageService;
    };
}

const EmptyClassifications = Object.freeze({
    spans: [] as readonly number[],
    endOfLineState: 0,
});

// Subclass the stock TypeScriptWorker to expose semantic/syntactic
// classifications. Using the indexed base type keeps this file portable across
// minor monaco-editor releases that may re-shuffle internal fields.
const BaseTypeScriptWorker = TypeScriptWorker as unknown as TypeScriptWorkerCtor;

class ComandoTypeScriptWorker extends BaseTypeScriptWorker {
    public getEncodedSemanticClassifications(
        fileName: string,
        span: { readonly start: number; readonly length: number },
        format: string = "2020",
    ): Promise<{ readonly spans: readonly number[]; readonly endOfLineState: number }> {
        const ls = this._languageService;
        if (!ls || typeof ls.getEncodedSemanticClassifications !== "function") {
            return Promise.resolve(EmptyClassifications);
        }
        try {
            const result = ls.getEncodedSemanticClassifications(
                fileName,
                span,
                format,
            );
            return Promise.resolve(result ?? EmptyClassifications);
        } catch {
            return Promise.resolve(EmptyClassifications);
        }
    }

    public getEncodedSyntacticClassifications(
        fileName: string,
        span: { readonly start: number; readonly length: number },
    ): Promise<{ readonly spans: readonly number[]; readonly endOfLineState: number }> {
        const ls = this._languageService;
        if (!ls || typeof ls.getEncodedSyntacticClassifications !== "function") {
            return Promise.resolve(EmptyClassifications);
        }
        try {
            const result = ls.getEncodedSyntacticClassifications(fileName, span);
            return Promise.resolve(result ?? EmptyClassifications);
        } catch {
            return Promise.resolve(EmptyClassifications);
        }
    }
}

// Mirror the stock ts.worker.js bootstrap: wait for the first postMessage from
// workerManager.js (which delivers createData) and then install the request
// handler via `initialize`.
(self as unknown as { onmessage: (event: MessageEvent) => void }).onmessage =
    () => {
        initialize(
            (ctx: unknown, createData: unknown) =>
                new ComandoTypeScriptWorker(ctx, createData),
        );
    };
