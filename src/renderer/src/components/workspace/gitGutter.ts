import type { editor as MonacoEditor } from "monaco-editor";

import type { GitFileDiff } from "@shared/ipc";

import {
    computeGitGutterMarkers,
    type GitGutterChangeType,
    getGitGutterLineNumbersMinChars,
    hasRenderableGitGutterChange,
    type GitGutterMarker,
} from "@renderer/components/workspace/gitGutterModel";

export {
    computeGitGutterMarkers,
    getGitGutterLineNumbersMinChars,
    hasRenderableGitGutterChange,
};

export const GIT_GUTTER_LINE_DECORATIONS_WIDTH = 10;

const gitGutterDecorationClassByType: Record<GitGutterChangeType, string> = {
    add: "git-diff-added",
    delete: "git-diff-deleted",
    modify: "git-diff-modified",
};

export function buildGitGutterDecorations(
    markers: readonly GitGutterMarker[],
): MonacoEditor.IModelDeltaDecoration[] {
    return markers.map((marker) => {
        const isDelete = marker.type === "delete";
        const startLineNumber = marker.lineNumber;
        const endLineNumber = isDelete
            ? marker.lineNumber
            : marker.endLineNumber;
        const column = isDelete ? Number.MAX_VALUE : 1;

        return {
            options: {
                description: "git-gutter-decoration",
                isWholeLine: !isDelete,
                linesDecorationsClassName: [
                    "git-diff-glyph",
                    gitGutterDecorationClassByType[marker.type],
                    marker.deletedAtLineEnd ? "git-diff-deleted-end" : "",
                ]
                    .filter(Boolean)
                    .join(" "),
            },
            range: {
                endColumn: column,
                endLineNumber,
                startColumn: column,
                startLineNumber,
            },
        };
    });
}

export class GitGutterDecorator {
    private collection: MonacoEditor.IEditorDecorationsCollection | null = null;
    private readonly modelChangeDisposable: { readonly dispose: () => void };

    constructor(
        private readonly editor: MonacoEditor.IStandaloneCodeEditor,
    ) {
        this.modelChangeDisposable = editor.onDidChangeModel(() => {
            this.collection?.set([]);
        });
    }

    isForEditor(editor: MonacoEditor.IStandaloneCodeEditor): boolean {
        return this.editor === editor;
    }

    setDiff(diff: GitFileDiff | null): void {
        const model = this.editor.getModel();

        if (!model || !diff?.isText) {
            this.collection?.set([]);
            return;
        }

        const decorations = buildGitGutterDecorations(
            computeGitGutterMarkers(diff, model.getLineCount()),
        );

        if (!this.collection) {
            this.collection =
                this.editor.createDecorationsCollection(decorations);
            return;
        }

        this.collection.set(decorations);
    }

    dispose(): void {
        this.modelChangeDisposable.dispose();
        this.collection?.clear();
        this.collection = null;
    }
}
