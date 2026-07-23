import type { editor as MonacoEditor } from "monaco-editor";

export type WorkspaceEditorModelVariant =
    | "review-modified"
    | "review-original";

type MonacoNamespace = typeof import("monaco-editor");

export interface WorkspaceFileModelLease {
    readonly didChangeContent: boolean;
    readonly model: MonacoEditor.ITextModel;
    readonly modelPath: string;
    readonly release: () => void;
}

export interface WorkspaceFileModelSyncResult {
    readonly didChangeContent: boolean;
    readonly model: MonacoEditor.ITextModel;
}

const retainedWorkspaceFileModels = new Map<
    string,
    {
        readonly model: MonacoEditor.ITextModel;
        retainCount: number;
    }
>();

function sanitizeModelSegment(value: string): string {
    return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

function splitPathExtension(absolutePath: string): {
    readonly extension: string;
    readonly stem: string;
} {
    const normalizedPath = absolutePath.replaceAll("\\", "/");
    const lowerCasePath = normalizedPath.toLowerCase();
    const compoundExtensions = [".d.ts", ".d.mts", ".d.cts"];

    for (const extension of compoundExtensions) {
        if (lowerCasePath.endsWith(extension)) {
            return {
                extension: absolutePath.slice(-extension.length),
                stem: absolutePath.slice(0, -extension.length),
            };
        }
    }

    const lastSeparatorIndex = normalizedPath.lastIndexOf("/");
    const lastDotIndex = normalizedPath.lastIndexOf(".");

    if (lastDotIndex <= lastSeparatorIndex + 1) {
        return {
            extension: "",
            stem: absolutePath,
        };
    }

    return {
        extension: absolutePath.slice(lastDotIndex),
        stem: absolutePath.slice(0, lastDotIndex),
    };
}

export function buildWorkspaceEditorModelPath(
    absolutePath: string,
    tabId: string,
    variant: WorkspaceEditorModelVariant,
    revisionToken?: string | null,
): string {
    const { extension, stem } = splitPathExtension(absolutePath);
    const modelSuffix = [
        "__workspace-tab__",
        sanitizeModelSegment(tabId),
        "__",
        sanitizeModelSegment(variant),
        revisionToken
            ? `__${sanitizeModelSegment(revisionToken)}`
            : "",
    ].join("");

    return extension
        ? `${stem}${modelSuffix}${extension}`
        : `${absolutePath}${modelSuffix}`;
}

export function buildWorkspaceFileEditorModelPath(absolutePath: string): string {
    return absolutePath;
}

export function getOrCreateWorkspaceFileModel(input: {
    readonly absolutePath: string;
    readonly language: string;
    readonly monaco: MonacoNamespace;
    readonly value: string;
}): MonacoEditor.ITextModel {
    return syncWorkspaceFileModel(input).model;
}

export function syncWorkspaceFileModel(input: {
    readonly absolutePath: string;
    readonly language: string;
    readonly monaco: MonacoNamespace;
    readonly value: string;
}): WorkspaceFileModelSyncResult {
    const uri = input.monaco.Uri.parse(
        buildWorkspaceFileEditorModelPath(input.absolutePath),
    );
    const existingModel = input.monaco.editor.getModel(uri);

    if (existingModel) {
        const didChangeContent = existingModel.getValue() !== input.value;
        if (existingModel.getValue() !== input.value) {
            existingModel.setValue(input.value);
        }
        input.monaco.editor.setModelLanguage(existingModel, input.language);
        return { didChangeContent, model: existingModel };
    }

    return {
        didChangeContent: false,
        model: input.monaco.editor.createModel(input.value, input.language, uri),
    };
}

export function acquireWorkspaceFileModel(input: {
    readonly absolutePath: string;
    readonly language: string;
    readonly monaco: MonacoNamespace;
    readonly value: string;
}): WorkspaceFileModelLease {
    const modelPath = buildWorkspaceFileEditorModelPath(input.absolutePath);
    const { didChangeContent, model } = syncWorkspaceFileModel(input);
    const retainedModel = retainedWorkspaceFileModels.get(modelPath);

    if (retainedModel?.model === model) {
        retainedModel.retainCount += 1;
    } else {
        retainedWorkspaceFileModels.set(modelPath, {
            model,
            retainCount: 1,
        });
    }

    let released = false;

    return {
        didChangeContent,
        model,
        modelPath,
        release: () => {
            if (released) {
                return;
            }
            released = true;

            const currentRetainedModel =
                retainedWorkspaceFileModels.get(modelPath);
            if (!currentRetainedModel || currentRetainedModel.model !== model) {
                return;
            }

            currentRetainedModel.retainCount -= 1;
            if (currentRetainedModel.retainCount > 0) {
                return;
            }

            retainedWorkspaceFileModels.delete(modelPath);
            if (!model.isDisposed()) {
                model.dispose();
            }
        },
    };
}
