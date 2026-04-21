import type * as monaco from "monaco-editor";
import {
    CodeActionAdaptor,
    DefinitionAdapter,
    DiagnosticsAdapter,
    DocumentHighlightAdapter,
    FormatAdapter,
    FormatOnTypeAdapter,
    InlayHintsAdapter,
    LibFiles,
    OutlineAdapter,
    QuickInfoAdapter,
    ReferenceAdapter,
    RenameAdapter,
    SignatureHelpAdapter,
    SuggestAdapter,
    WorkerManager,
    type TypeScriptLanguageServiceDefaults,
    type TypeScriptWorkerAccessor,
} from "monaco-editor/esm/vs/language/typescript/tsMode.js";

import { installMonacoSemanticTokensProviders } from "./monacoSemanticTokensProvider";

type MonacoNamespace = typeof import("monaco-editor");
type MonacoTypeScriptLanguageServices = {
    readonly javascriptDefaults: TypeScriptLanguageServiceDefaults;
    readonly typescriptDefaults: TypeScriptLanguageServiceDefaults;
};

const typeScriptReactLanguageServiceIds = [
    "typescriptreact",
    "javascriptreact",
] as const;

const languageServiceInstallCache = new Map<string, monaco.IDisposable>();

function disposeAll(disposables: monaco.IDisposable[]) {
    while (disposables.length > 0) {
        disposables.pop()?.dispose();
    }
}

function installLanguageServiceProviders(
    monacoNsps: MonacoNamespace,
    languageId: string,
    defaults: TypeScriptLanguageServiceDefaults,
): monaco.IDisposable {
    const providerDisposables: monaco.IDisposable[] = [];
    const workerManager = new WorkerManager(languageId, defaults);
    const worker: TypeScriptWorkerAccessor = (...resources) =>
        workerManager.getLanguageServiceWorker(...resources);
    const libFiles = new LibFiles(worker);

    function registerProviders() {
        const { modeConfiguration } = defaults;

        disposeAll(providerDisposables);

        if (modeConfiguration.completionItems) {
            providerDisposables.push(
                monacoNsps.languages.registerCompletionItemProvider(
                    languageId,
                    new SuggestAdapter(worker),
                ),
            );
        }
        if (modeConfiguration.signatureHelp) {
            providerDisposables.push(
                monacoNsps.languages.registerSignatureHelpProvider(
                    languageId,
                    new SignatureHelpAdapter(worker),
                ),
            );
        }
        if (modeConfiguration.hovers) {
            providerDisposables.push(
                monacoNsps.languages.registerHoverProvider(
                    languageId,
                    new QuickInfoAdapter(worker),
                ),
            );
        }
        if (modeConfiguration.documentHighlights) {
            providerDisposables.push(
                monacoNsps.languages.registerDocumentHighlightProvider(
                    languageId,
                    new DocumentHighlightAdapter(worker),
                ),
            );
        }
        if (modeConfiguration.definitions) {
            providerDisposables.push(
                monacoNsps.languages.registerDefinitionProvider(
                    languageId,
                    new DefinitionAdapter(libFiles, worker),
                ),
            );
        }
        if (modeConfiguration.references) {
            providerDisposables.push(
                monacoNsps.languages.registerReferenceProvider(
                    languageId,
                    new ReferenceAdapter(libFiles, worker),
                ),
            );
        }
        if (modeConfiguration.documentSymbols) {
            providerDisposables.push(
                monacoNsps.languages.registerDocumentSymbolProvider(
                    languageId,
                    new OutlineAdapter(worker),
                ),
            );
        }
        if (modeConfiguration.rename) {
            providerDisposables.push(
                monacoNsps.languages.registerRenameProvider(
                    languageId,
                    new RenameAdapter(libFiles, worker),
                ),
            );
        }
        if (modeConfiguration.documentRangeFormattingEdits) {
            providerDisposables.push(
                monacoNsps.languages.registerDocumentRangeFormattingEditProvider(
                    languageId,
                    new FormatAdapter(worker),
                ),
            );
        }
        if (modeConfiguration.onTypeFormattingEdits) {
            providerDisposables.push(
                monacoNsps.languages.registerOnTypeFormattingEditProvider(
                    languageId,
                    new FormatOnTypeAdapter(worker),
                ),
            );
        }
        if (modeConfiguration.codeActions) {
            providerDisposables.push(
                monacoNsps.languages.registerCodeActionProvider(
                    languageId,
                    new CodeActionAdaptor(worker),
                ),
            );
        }
        if (modeConfiguration.inlayHints) {
            providerDisposables.push(
                monacoNsps.languages.registerInlayHintsProvider(
                    languageId,
                    new InlayHintsAdapter(worker),
                ),
            );
        }
        if (modeConfiguration.diagnostics) {
            providerDisposables.push(
                new DiagnosticsAdapter(
                    libFiles,
                    defaults,
                    languageId,
                    worker,
                ),
            );
        }
    }

    registerProviders();
    const defaultsDisposable = defaults.onDidChange(registerProviders);

    return {
        dispose() {
            defaultsDisposable.dispose();
            disposeAll(providerDisposables);
            workerManager.dispose();
        },
    };
}

function installReactLanguageService(
    monacoNsps: MonacoNamespace,
    languageId: (typeof typeScriptReactLanguageServiceIds)[number],
) {
    if (languageServiceInstallCache.has(languageId)) {
        return;
    }

    const defaults =
        languageId === "typescriptreact"
            ? getTypeScriptLanguageServices(monacoNsps).typescriptDefaults
            : getTypeScriptLanguageServices(monacoNsps).javascriptDefaults;

    languageServiceInstallCache.set(
        languageId,
        installLanguageServiceProviders(monacoNsps, languageId, defaults),
    );
}

function getTypeScriptLanguageServices(
    monacoNsps: MonacoNamespace,
): MonacoTypeScriptLanguageServices {
    return monacoNsps.languages
        .typescript as unknown as MonacoTypeScriptLanguageServices;
}

export function installTypeScriptReactLanguageServices(
    monacoNsps: MonacoNamespace,
) {
    for (const languageId of typeScriptReactLanguageServiceIds) {
        installReactLanguageService(monacoNsps, languageId);
    }

    // Register semantic token providers for all TS/JS flavors. The install is
    // idempotent so it is safe to call it here even if monaco.ts also decides
    // to call it from another entry point in the future.
    installMonacoSemanticTokensProviders(monacoNsps);
}
