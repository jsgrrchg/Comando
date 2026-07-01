import type { GitChangeEntry, GitDiffHunk, GitFileDiff } from "@shared/ipc";

export type GitGutterChangeType = "add" | "delete" | "modify";

export interface GitGutterMarker {
    readonly deletedAtLineEnd: boolean;
    readonly endLineNumber: number;
    readonly lineNumber: number;
    readonly type: GitGutterChangeType;
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

const MIN_EDITOR_LINE_NUMBER_CHARS = 4;
const EDITOR_LINE_NUMBER_LEFT_PADDING_CHARS = 1;

export function getEditorLineNumbersMinChars(lineCount: number): number {
    const digits = String(Math.max(1, lineCount)).length;

    return Math.max(
        MIN_EDITOR_LINE_NUMBER_CHARS,
        digits + EDITOR_LINE_NUMBER_LEFT_PADDING_CHARS,
    );
}

export function getGitGutterLineNumbersMinChars(lineCount: number): number {
    return getEditorLineNumbersMinChars(lineCount);
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
                const lineNumber = clampLineNumber(
                    nextNewLineNumber,
                    lineCount,
                );
                markers.push({
                    deletedAtLineEnd: false,
                    endLineNumber: lineNumber,
                    lineNumber,
                    type: "add",
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
                const lineNumber = clampLineNumber(
                    addedLineNumbers[offset] ?? nextNewLineNumber,
                    lineCount,
                );
                markers.push({
                    deletedAtLineEnd: false,
                    endLineNumber: lineNumber,
                    lineNumber,
                    type: offset < modifiedCount ? "modify" : "add",
                });
            }

            continue;
        }

        const hasFollowingVisibleLine = index < lines.length;
        const lineNumber = clampLineNumber(
            hasFollowingVisibleLine ? nextNewLineNumber : lineCount,
            lineCount,
        );
        markers.push({
            deletedAtLineEnd: !hasFollowingVisibleLine,
            endLineNumber: lineNumber,
            lineNumber,
            type: "delete",
        });
    }

    return markers;
}

function dedupeMarkers(
    markers: readonly GitGutterMarker[],
): readonly GitGutterMarker[] {
    const seen = new Set<string>();
    return markers.filter((marker) => {
        const key = [
            marker.type,
            marker.lineNumber,
            marker.endLineNumber,
            marker.deletedAtLineEnd ? "end" : "start",
        ].join(":");
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
