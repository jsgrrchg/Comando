import type * as monaco from "monaco-editor";

// Monaco 0.55 proxies a fixed list of LanguageService methods in the bundled
// TypeScript worker adapter, and semantic/syntactic classifications are not on
// that list. Comando ships a replacement worker (`ts.worker.ts`) that subclasses
// the stock TypeScriptWorker and adds:
//   - getEncodedSemanticClassifications(fileName, span, format)
//   - getEncodedSyntacticClassifications(fileName, span)
// When MonacoEnvironment.getWorker returns our custom worker for
// typescript/javascript labels, the foreign-method-request dispatcher
// ($fmr in editorWebWorker.js) reflects on the worker instance at call time, so
// the additional methods become invokable from the main thread without any
// other setup.
//
// This helper exists to centralise that contract and to leave a hook where we
// can later wire an AMD-style customWorkerPath if Monaco's proxy layer ever
// stops reflecting method names dynamically.

type MonacoNamespace = typeof monaco;

type TypescriptDefaultsWithWorkerOptions = {
    setWorkerOptions?: (options: Record<string, unknown>) => void;
};

const CUSTOM_WORKER_FLAG = "__comandoTypeScriptCustomWorkerConfigured";

type ConfiguredFlagCarrier = typeof globalThis & {
    [CUSTOM_WORKER_FLAG]?: boolean;
};

export function setupTypeScriptCustomWorker(monacoApi: MonacoNamespace): void {
    const carrier = globalThis as ConfiguredFlagCarrier;
    if (carrier[CUSTOM_WORKER_FLAG]) {
        return;
    }

    // We intentionally do NOT set typescriptDefaults.setWorkerOptions({
    // customWorkerPath }) here: that mechanism relies on importScripts, which
    // requires a classic (non-module) worker script separate from the main
    // worker bundle. Vite's `?worker` helper emits ES module workers, and we
    // already install the custom worker directly via MonacoEnvironment.getWorker
    // — both paths achieve the same extension and doing both would double-load
    // the TypeScript services.
    const tsNs = monacoApi.languages.typescript as {
        typescriptDefaults?: TypescriptDefaultsWithWorkerOptions;
        javascriptDefaults?: TypescriptDefaultsWithWorkerOptions;
    };
    // Touch the defaults to fail fast if the API ever disappears, but keep the
    // worker wiring itself in MonacoEnvironment.getWorker.
    void tsNs.typescriptDefaults;
    void tsNs.javascriptDefaults;

    carrier[CUSTOM_WORKER_FLAG] = true;
}
