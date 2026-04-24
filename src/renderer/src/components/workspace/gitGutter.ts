import type { editor as MonacoEditor } from "monaco-editor";

import type { GitChangeEntry, GitDiffHunk, GitFileDiff } from "@shared/ipc";

export type GitGutterMarkerTone =
    | "add"
    | "delete-bottom"
    | "delete-top"
    | "modify";

export interface GitGutterMarker {
    readonly lineNumber: number;
    readonly tone: GitGutterMarkerTone;
}

export function hasRenderableGitGutterChange(
    change: Pick<GitChangeEntry, "isBinary"> | null | undefined,
): boolean {
    return Boolean(change && !change.isBinary);
}

export function computeGitGutterMarkers(
    diff: GitFileDiff | null,
    lineCount: number,
): readonly GitGutterMarker[] {
    if (!diff?.isText || lineCount < 1) {
        return [];
    }

    const markers: GitGutterMarker[] = [];

    for (const hunk of diff.hunks) {
        markers.push(...computeHunkMarkers(hunk, lineCount));
    }

    return dedupeMarkers(markers);
}

export function getGitGutterLineNumbersMinChars(lineCount: number): number {
    const digits = String(Math.max(1, lineCount)).length;

    return Math.max(4, digits + 2);
}

export function buildGitGutterDecorations(
    markers: readonly GitGutterMarker[],
): MonacoEditor.IModelDeltaDecoration[] {
    return markers.map((marker) => ({
        options: {
            isWholeLine: true,
            lineNumberClassName: [
                "git-gutter-line-number",
                `git-gutter-line-number--${marker.tone}`,
            ].join(" "),
        },
        range: {
            endColumn: 1,
            endLineNumber: marker.lineNumber,
            startColumn: 1,
            startLineNumber: marker.lineNumber,
        },
    }));
}

function computeHunkMarkers(
    hunk: GitDiffHunk,
    lineCount: number,
): readonly GitGutterMarker[] {
    const markers: GitGutterMarker[] = [];
    const { lines } = hunk;
    let index = 0;
    let nextNewLineNumber = hunk.newStart;

    while (index < lines.length) {
        const currentLine = lines[index];

        if (currentLine.type === "context") {
            nextNewLineNumber += 1;
            index += 1;
            continue;
        }

        if (currentLine.type === "add") {
            while (index < lines.length && lines[index]?.type === "add") {
                markers.push({
                    lineNumber: clampLineNumber(nextNewLineNumber, lineCount),
                    tone: "add",
                });
                nextNewLineNumber += 1;
                index += 1;
            }
            continue;
        }

        const removedStartIndex = index;
        while (index < lines.length && lines[index]?.type === "remove") {
            index += 1;
        }
        const removedCount = index - removedStartIndex;

        const addedStartIndex = index;
        const addedLineNumbers: number[] = [];
        while (index < lines.length && lines[index]?.type === "add") {
            addedLineNumbers.push(nextNewLineNumber);
            nextNewLineNumber += 1;
            index += 1;
        }
        const addedCount = index - addedStartIndex;

        if (addedCount > 0) {
            const modifiedCount = Math.min(removedCount, addedCount);

            for (let offset = 0; offset < addedCount; offset += 1) {
                markers.push({
                    lineNumber: clampLineNumber(
                        addedLineNumbers[offset] ?? nextNewLineNumber,
                        lineCount,
                    ),
                    tone: offset < modifiedCount ? "modify" : "add",
                });
            }

            continue;
        }

        const hasFollowingVisibleLine = index < lines.length;

        markers.push({
            lineNumber: clampLineNumber(
                hasFollowingVisibleLine ? nextNewLineNumber : lineCount,
                lineCount,
            ),
            tone: hasFollowingVisibleLine ? "delete-top" : "delete-bottom",
        });
    }

    return markers;
}

function dedupeMarkers(
    markers: readonly GitGutterMarker[],
): readonly GitGutterMarker[] {
    const seen = new Set<string>();
    return markers.filter((marker) => {
        const key = `${marker.tone}:${marker.lineNumber}`;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}

function clampLineNumber(lineNumber: number, lineCount: number): number {
    return Math.min(Math.max(lineNumber, 1), lineCount);
}
