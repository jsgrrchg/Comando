import type { editor as MonacoEditor } from "monaco-editor";

import type { GitFileDiff } from "@shared/ipc";

import {
    computeGitGutterMarkers,
    type GitGutterChangeType,
    getEditorLineNumbersMinChars,
    getGitGutterLineNumbersMinChars,
    hasRenderableGitGutterChange,
    type GitGutterMarker,
} from "@renderer/components/workspace/gitGutterModel";

export {
    computeGitGutterMarkers,
    getEditorLineNumbersMinChars,
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
    private decorations: AppliedGitGutterDecoration[] = [];
    private readonly modelChangeDisposable: { readonly dispose: () => void };
    private readonly modelWillChangeDisposable: { readonly dispose: () => void };

    constructor(
        private readonly editor: MonacoEditor.IStandaloneCodeEditor,
    ) {
        this.modelWillChangeDisposable = editor.onWillChangeModel(() => {
            this.clearDecorations();
        });
        this.modelChangeDisposable = editor.onDidChangeModel(() => {
            this.decorations = [];
        });
    }

    isForEditor(editor: MonacoEditor.IStandaloneCodeEditor): boolean {
        return this.editor === editor;
    }

    setDiff(diff: GitFileDiff | null): void {
        const model = this.editor.getModel();

        if (!model || !diff?.isText) {
            this.clearDecorations();
            return;
        }

        const markers = computeGitGutterMarkers(diff, model.getLineCount());

        this.decorations = reconcileGitGutterDecorations({
            editor: this.editor,
            existingDecorations: this.decorations,
            nextMarkers: markers,
        });
    }

    dispose(): void {
        this.modelWillChangeDisposable.dispose();
        this.modelChangeDisposable.dispose();
        this.clearDecorations();
    }

    private clearDecorations(): void {
        if (this.decorations.length > 0) {
            this.editor.deltaDecorations(
                this.decorations.map((decoration) => decoration.id),
                [],
            );
        }
        this.decorations = [];
    }
}

interface AppliedGitGutterDecoration {
    readonly id: string;
    readonly styleKey: string;
}

type NextGitGutterDecorationSlot =
    | {
          readonly decoration: AppliedGitGutterDecoration;
          readonly kind: "applied";
      }
    | {
          readonly creationIndex: number;
          readonly kind: "created";
      };

// Reconcile the live gutter decorations against the freshly computed markers
// while preserving the decoration IDs (and therefore the DOM nodes) of markers
// whose rendered position and style did not change.
//
// Matching is done purely by `(current start line, style)`. The start line is
// read back from Monaco via `getDecorationRange`, so decorations that Monaco
// already moved to follow text edits line up with the recomputed markers without
// being recreated. Columns are intentionally ignored: gutter markers are
// whole-line glyphs and their tracked range can legitimately drift in columns
// (e.g. typing at column 1 grows the empty range) without the marker changing
// visually, so a decoration whose line and style are unchanged is left in place
// rather than torn down and rebuilt.
function reconcileGitGutterDecorations({
    editor,
    existingDecorations,
    nextMarkers,
}: {
    readonly editor: MonacoEditor.IStandaloneCodeEditor;
    readonly existingDecorations: readonly AppliedGitGutterDecoration[];
    readonly nextMarkers: readonly GitGutterMarker[];
}): AppliedGitGutterDecoration[] {
    const model = editor.getModel();
    const idsToRemove: string[] = [];

    // Group existing decorations by their current `(line, style)` key. Buckets
    // tolerate the rare case of several decorations sharing the same key.
    const reusableByKey = new Map<string, AppliedGitGutterDecoration[]>();
    for (const decoration of existingDecorations) {
        const startLineNumber =
            model?.getDecorationRange(decoration.id)?.startLineNumber ?? null;
        if (startLineNumber === null) {
            idsToRemove.push(decoration.id);
            continue;
        }

        const key = getGitGutterDecorationKey(
            startLineNumber,
            decoration.styleKey,
        );
        const bucket = reusableByKey.get(key);
        if (bucket) {
            bucket.push(decoration);
        } else {
            reusableByKey.set(key, [decoration]);
        }
    }

    const nextDecorationSlots: NextGitGutterDecorationSlot[] = [];
    const pendingCreations: MonacoEditor.IModelDeltaDecoration[] = [];
    const pendingCreationStyleKeys: string[] = [];

    for (const marker of nextMarkers) {
        const nextDecoration = buildGitGutterDecorations([marker])[0];
        if (!nextDecoration) {
            continue;
        }

        const styleKey = getGitGutterMarkerStyleKey(marker);
        const key = getGitGutterDecorationKey(marker.lineNumber, styleKey);
        const reused = reusableByKey.get(key)?.shift();
        if (reused) {
            nextDecorationSlots.push({ decoration: reused, kind: "applied" });
            continue;
        }

        nextDecorationSlots.push({
            creationIndex: pendingCreations.length,
            kind: "created",
        });
        pendingCreations.push(nextDecoration);
        pendingCreationStyleKeys.push(styleKey);
    }

    // Existing decorations that no marker reused are now stale.
    for (const bucket of reusableByKey.values()) {
        for (const decoration of bucket) {
            idsToRemove.push(decoration.id);
        }
    }

    const createdIds =
        idsToRemove.length > 0 || pendingCreations.length > 0
            ? editor.deltaDecorations(idsToRemove, pendingCreations)
            : [];

    const nextDecorations: AppliedGitGutterDecoration[] = [];
    for (const slot of nextDecorationSlots) {
        if (slot.kind === "applied") {
            nextDecorations.push(slot.decoration);
            continue;
        }

        const id = createdIds[slot.creationIndex];
        const styleKey = pendingCreationStyleKeys[slot.creationIndex];
        if (!id || styleKey === undefined) {
            continue;
        }

        nextDecorations.push({ id, styleKey });
    }

    return nextDecorations;
}

function getGitGutterDecorationKey(
    startLineNumber: number,
    styleKey: string,
): string {
    return `${startLineNumber}:${styleKey}`;
}

function getGitGutterMarkerStyleKey(marker: GitGutterMarker): string {
    return [marker.type, marker.deletedAtLineEnd ? "end" : "start"].join(":");
}
